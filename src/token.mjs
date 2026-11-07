/**
 * Token store.
 *
 * SmartThings personal access tokens expire 24 hours after they are created, so
 * a hosted panel needs a way to take a new one without an SSH session. This
 * writes `.env` in place and updates `process.env`, so a new token takes effect
 * immediately -- no restart.
 *
 * The token is never read back out over HTTP. The API only ever reports whether
 * one is present and how old it is.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = join(ROOT, '.env');

const KEY = 'SMARTTHINGS_TOKEN';
const SAVED = 'SMARTTHINGS_TOKEN_SAVED_AT';

/** PATs are valid for 24h from creation. We only know when it was saved. */
export const LIFETIME_HOURS = 24;

function readEnvFile() {
  if (!existsSync(ENV)) return '';
  try { return readFileSync(ENV, 'utf8'); } catch { return ''; }
}

function envValue(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** Replace a key in place, or append it if absent. Comments are preserved. */
function setEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

export function savedAt() {
  const fromEnv = process.env[SAVED] || envValue(readEnvFile(), SAVED);
  if (!fromEnv) return null;
  const t = Date.parse(fromEnv);
  return Number.isNaN(t) ? null : t;
}

/** What the UI is allowed to know. Never the token itself. */
export function meta() {
  const token = process.env[KEY] || '';
  const at = savedAt();
  const ageHours = at === null ? null : (Date.now() - at) / 3_600_000;
  return {
    present: Boolean(token),
    // a hint, not a guarantee -- we know when it was saved, not created
    hint: token ? `…${token.slice(-4)}` : null,
    savedAt: at === null ? null : new Date(at).toISOString(),
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    hoursLeft: ageHours === null ? null : Math.max(0, Math.round((LIFETIME_HOURS - ageHours) * 10) / 10),
    likelyExpired: ageHours !== null && ageHours >= LIFETIME_HOURS,
  };
}

/**
 * Persist a token. Writes via a temp file so a crash mid-write cannot leave a
 * half-written .env, and updates process.env so it applies without a restart.
 */
export function save(token) {
  const clean = String(token ?? '').trim();
  if (!clean) throw new Error('Leeg token.');
  if (/\s/.test(clean)) throw new Error('Token bevat spaties — waarschijnlijk niet goed geplakt.');

  let text = readEnvFile();
  text = setEnvValue(text, KEY, clean);
  text = setEnvValue(text, SAVED, new Date().toISOString());

  const tmp = `${ENV}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, ENV);

  process.env[KEY] = clean;
  process.env[SAVED] = new Date().toISOString();
  return meta();
}
