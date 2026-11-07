#!/usr/bin/env node
/**
 * Wasbeer probe: finds out what the SmartThings cloud API will actually tell us
 * about the washer-dryer, and whether this account still has API access at all.
 *
 * Usage:  node scripts/probe.mjs            (reads SMARTTHINGS_TOKEN from env/.env)
 *         node scripts/probe.mjs <token>
 *
 * Writes a full dump to probe-output/ and prints a readable summary.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'probe-output');
const BASE = 'https://api.smartthings.com/v1';

const token = process.argv[2] || process.env.SMARTTHINGS_TOKEN;
if (!token) {
  console.error('No token. Put SMARTTHINGS_TOKEN in .env, or pass it as an argument.');
  console.error('Get one at https://account.smartthings.com/tokens');
  process.exit(1);
}

const calls = [];

async function api(path) {
  const url = BASE + path;
  let res, body, text;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  } catch (err) {
    calls.push({ path, networkError: String(err) });
    throw new Error(`Network failure on ${path}: ${err.message}`);
  }
  text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  calls.push({ path, status: res.status, ok: res.ok });

  if (!res.ok) {
    const hint = {
      401: 'Token invalid or expired. PATs made after Jan 2025 last only 24 hours.',
      402: 'Payment required -> this is the new paid Developer Plan gate.',
      403: 'Forbidden. Either missing scopes on the token, or the paid-plan gate.',
      429: 'Rate limited.',
    }[res.status];
    const err = new Error(`HTTP ${res.status} on ${path}${hint ? ' -- ' + hint : ''}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function describeStatus(main) {
  const lines = [];
  const supported = [];
  for (const [cap, attrs] of Object.entries(main).sort(([a], [b]) => a.localeCompare(b))) {
    const entries = Object.entries(attrs);
    if (!entries.length) continue;
    lines.push(`  ${cap}`);
    for (const [attr, info] of entries) {
      let v = info?.value;
      if (v === null || v === undefined) continue;
      const isList = Array.isArray(v);
      let rendered = isList
        ? `[${v.length}] ${JSON.stringify(v)}`
        : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      // The full dump has everything; the console only needs a readable gist.
      if (rendered.length > 160) rendered = `${rendered.slice(0, 160)}... (truncated, see dump)`;
      const unit = info?.unit ? ` ${info.unit}` : '';
      lines.push(`      ${attr.padEnd(32)} = ${rendered}${unit}`);
      if (isList && /^supported/i.test(attr)) supported.push({ capability: cap, attribute: attr, values: v });
    }
  }
  return { lines, supported };
}

(async () => {
  console.log('Probing SmartThings API...\n');

  const dump = { probedAt: new Date().toISOString(), devices: [], calls: null };

  // --- 1. Does the token work at all? ---
  let devices;
  try {
    const list = await api('/devices');
    devices = list.items ?? [];
    console.log(`OK - token works. ${devices.length} device(s) on the account.\n`);
  } catch (err) {
    console.error(`FAILED: ${err.message}\n`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
    mkdirSync(OUT_DIR, { recursive: true });
    const f = join(OUT_DIR, `probe-FAILED-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ error: err.message, status: err.status, body: err.body, calls }, null, 2));
    console.error(`\nDetails written to ${f}`);
    process.exit(2);
  }

  // --- 2. Inventory ---
  console.log('Devices:');
  for (const d of devices) {
    const m = d.manufacturerName || d.ocf?.manufacturerName || '?';
    const model = d.ocf?.modelNumber || d.deviceTypeName || '?';
    console.log(`  - ${(d.label || d.name || '(unnamed)').padEnd(28)} ${String(m).padEnd(16)} ${model}`);
    console.log(`    id=${d.deviceId}`);
  }
  console.log();

  // --- 3. Full status for everything (small account, cheap, and we want the whole picture) ---
  for (const d of devices) {
    const entry = { device: d, status: null, statusError: null };
    try {
      entry.status = await api(`/devices/${d.deviceId}/status`);
    } catch (err) {
      entry.statusError = { message: err.message, status: err.status, body: err.body };
    }
    dump.devices.push(entry);
  }

  // --- 4. Focus on anything that looks like the washer ---
  const washers = dump.devices.filter((e) => {
    const caps = (e.device.components ?? []).flatMap((c) => c.capabilities ?? []).map((c) => c.id);
    return caps.some((c) => /washer|dryer/i.test(c));
  });

  if (!washers.length) {
    console.log('No washer/dryer capabilities found on any device. Check the dump file.');
  }

  for (const w of washers) {
    const label = w.device.label || w.device.name;
    console.log('='.repeat(72));
    console.log(`WASHER: ${label}   (${w.device.ocf?.modelNumber || '?'})`);
    console.log('='.repeat(72));

    const comps = w.device.components ?? [];
    console.log(`\nComponents: ${comps.map((c) => c.id).join(', ')}`);
    for (const c of comps) {
      console.log(`\n  [${c.id}] capabilities:`);
      for (const cap of c.capabilities ?? []) console.log(`      ${cap.id} (v${cap.version})`);
    }

    const main = w.status?.components?.main;
    if (main) {
      console.log('\n--- main component status ---');
      const { lines, supported } = describeStatus(main);
      console.log(lines.join('\n'));

      if (supported.length) {
        console.log('\n--- OPTION LISTS (these are what favourites will be built from) ---');
        for (const s of supported) {
          const flat = s.values.every((v) => typeof v !== 'object');
          console.log(`  ${s.capability}.${s.attribute}  (${s.values.length})`);
          console.log(`      ${flat ? JSON.stringify(s.values) : '[objects -- see dump file]'}`);
        }
      }
    } else if (w.statusError) {
      console.log(`\nStatus failed: ${w.statusError.message}`);
    }
    console.log();
  }

  dump.calls = calls;
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`Full dump: ${file}`);
})();
