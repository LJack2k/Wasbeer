/**
 * Wasbeer server. Serves the UI and a small REST API over the SmartThings client.
 * Node built-ins only.
 *
 * Safety rules enforced here, not in the browser:
 *   - never apply anything while the machine is running unless explicitly forced
 *   - never start a programme unless the request asked for it
 *   - refuse to send anything when Smart Control is off, with a clear reason
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allCycles, describeCycle, defaultsFor, validateFavourite, device, OPTION_LABELS } from './catalog.mjs';
import { buildApply, control, describeBatch, CYCLE_SELECTORS } from './commands.mjs';
import { getStatus, sendCommands, SmartThingsError, validateToken, getLastAuthFailure } from './smartthings.mjs';
import * as tokenStore from './token.mjs';
import * as favourites from './favourites.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8099;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1e6) throw new Error('Body te groot');
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Ongeldige JSON in request body'); }
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

/**
 * Guard every write to the machine.
 * Returns null when it is safe to proceed, or a {code, body} to send back.
 */
async function guard({ force }) {
  let status;
  try {
    status = await getStatus();
  } catch (err) {
    // Cannot read state -> refuse to write blind.
    return { code: 502, body: { error: `Kan de status niet lezen: ${err.message}`, status: null } };
  }
  if (!status.remoteControl) {
    return {
      code: 409,
      body: {
        error: 'Smart Control staat uit. Druk op de knop op de machine zelf; zonder dat negeert hij alles.',
        reason: 'remote-control-off',
        status,
      },
    };
  }
  if (status.running && !force) {
    return {
      code: 409,
      body: {
        error: `De machine draait nog (${status.remainingTime ?? '?'} min te gaan). Stuur force: true om toch te wijzigen.`,
        reason: 'running',
        status,
      },
    };
  }
  return null;
}

const routes = {
  /** Everything the UI needs to render, in one request. */
  'GET /api/bootstrap': async (req, res) => json(res, 200, {
    device: {
      label: device.label,
      model: 'WD80T654ABH/S2',
    },
    cycles: allCycles(),
    optionLabels: OPTION_LABELS,
    favourites: favourites.list(),
    selectors: CYCLE_SELECTORS,
  }),

  /** What the UI may know about the token. Never the token itself. */
  'GET /api/token': async (req, res) => json(res, 200, {
    ...tokenStore.meta(),
    lastAuthFailure: getLastAuthFailure(),
    lifetimeHours: tokenStore.LIFETIME_HOURS,
    createUrl: 'https://account.smartthings.com/tokens',
  }),

  /** Validate against the live API first, then persist. A bad paste is refused. */
  'PUT /api/token': async (req, res) => {
    const { token } = await readBody(req);
    const check = await validateToken(token);
    if (!check.ok) {
      return json(res, 400, { error: check.error ?? 'Token werkt niet.', status: check.status });
    }
    try {
      const meta = tokenStore.save(token);
      json(res, 200, { ok: true, ...meta, devices: check.devices, warning: check.warning });
    } catch (err) {
      json(res, 500, { error: `Opslaan mislukt: ${err.message}` });
    }
  },

  'GET /api/status': async (req, res) => {
    try { json(res, 200, await getStatus()); }
    catch (err) { json(res, err instanceof SmartThingsError ? 502 : 500, { error: err.message }); }
  },

  'GET /api/favourites': async (req, res) => json(res, 200, favourites.list()),

  'PUT /api/favourites': async (req, res) => {
    const result = favourites.put(await readBody(req));
    json(res, result.ok ? 200 : 400, result);
  },

  'POST /api/favourites/reorder': async (req, res) => {
    const { ids } = await readBody(req);
    if (!Array.isArray(ids)) return json(res, 400, { error: 'ids moet een array zijn' });
    json(res, 200, favourites.reorder(ids));
  },

  /** What would this favourite send? Never touches the network. */
  'POST /api/preview': async (req, res) => {
    const body = await readBody(req);
    const { ok, errors, warnings, normalised } = validateFavourite(body);
    if (!ok) return json(res, 400, { ok, errors, warnings });
    const { commands, skipped } = buildApply(normalised, {
      selector: body.selector, start: Boolean(body.start),
    });
    json(res, 200, { ok, warnings, normalised, commands, skipped, preview: describeBatch(commands) });
  },

  'POST /api/apply': async (req, res) => {
    const body = await readBody(req);
    const { ok, errors, warnings, normalised } = validateFavourite(body);
    if (!ok) return json(res, 400, { error: 'Ongeldig programma', errors, warnings });

    const blocked = await guard({ force: Boolean(body.force) });
    if (blocked) return json(res, blocked.code, blocked.body);

    const { commands, skipped } = buildApply(normalised, {
      selector: body.selector, start: Boolean(body.start),
    });
    try {
      const result = await sendCommands(commands);
      json(res, 200, {
        ok: true, sent: describeBatch(commands), skipped, warnings, result,
        status: await getStatus().catch(() => null),
      });
    } catch (err) {
      json(res, 502, { error: err.message, attempted: describeBatch(commands), body: err.body });
    }
  },

  'POST /api/control': async (req, res) => {
    const { action, force } = await readBody(req);
    if (!Object.hasOwn(control, action)) {
      return json(res, 400, { error: `Onbekende actie "${action}". Keuze: ${Object.keys(control).join(', ')}` });
    }
    // Pausing/cancelling a running machine is the whole point, so only guard Smart Control.
    const blocked = await guard({ force: true });
    if (blocked && !(force && blocked.body.reason === 'running')) {
      return json(res, blocked.code, blocked.body);
    }
    const commands = control[action]();
    try {
      await sendCommands(commands);
      json(res, 200, { ok: true, sent: describeBatch(commands), status: await getStatus().catch(() => null) });
    } catch (err) {
      json(res, 502, { error: err.message, attempted: describeBatch(commands) });
    }
  },

  'GET /api/cycle': async (req, res, url) => {
    const code = url.searchParams.get('code');
    try { json(res, 200, { cycle: describeCycle(code), defaults: defaultsFor(code) }); }
    catch (err) { json(res, 404, { error: err.message }); }
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

  // DELETE /api/favourites/:id
  const del = url.pathname.match(/^\/api\/favourites\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    return json(res, favourites.remove(decodeURIComponent(del[1])) ? 200 : 404,
      { ok: favourites.get(decodeURIComponent(del[1])) === null });
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return json(res, 404, { error: `Geen route voor ${req.method} ${url.pathname}` });

  try {
    await handler(req, res, url);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const token = process.env.SMARTTHINGS_TOKEN;
  console.log(`Wasbeer op http://localhost:${PORT}`);
  console.log(token ? '  token: aanwezig' : '  token: ONTBREEKT -- status en bedienen werken niet');
});
