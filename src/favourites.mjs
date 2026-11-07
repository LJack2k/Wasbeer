/**
 * Favourites store: a JSON file on disk. No database, no dependencies.
 *
 * Every write goes through validateFavourite, so an invalid programme can never
 * be saved -- the editor cannot produce one, and neither can a hand-edited file.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFavourite, labelFor } from './catalog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data/favourites.json');
const SEED = join(ROOT, 'data/favourites.example.json');

function load() {
  if (!existsSync(FILE)) {
    if (existsSync(SEED)) copyFileSync(SEED, FILE);
    else writeFileSync(FILE, '[]');
  }
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(`data/favourites.json is geen geldige JSON: ${err.message}`);
  }
}

/** Write via a temp file so a crash mid-write cannot shred the list. */
function save(list) {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, FILE);
  return list;
}

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'favoriet';

function uniqueId(base, list, except) {
  let id = base;
  let n = 2;
  while (list.some((f) => f.id === id && f.id !== except)) id = `${base}-${n++}`;
  return id;
}

export function list() {
  return load().map((f) => {
    const { ok, errors, normalised } = validateFavourite(f);
    return {
      ...f,
      ...(normalised ?? {}),
      cycleLabel: f.cycle ? labelFor(f.cycle) : null,
      valid: ok,
      errors,
    };
  });
}

export const get = (id) => list().find((f) => f.id === id) ?? null;

/**
 * Create or update. Returns { ok, favourite, errors }.
 * `id` present and known -> update; otherwise create.
 */
export function put(input) {
  const all = load();
  const { ok, errors, warnings, normalised } = validateFavourite(input);
  if (!ok) return { ok: false, errors, warnings, favourite: null };

  const label = String(input.label ?? '').trim() || labelFor(input.cycle);
  const existingIndex = input.id ? all.findIndex((f) => f.id === input.id) : -1;

  const record = {
    id: existingIndex >= 0 ? input.id : uniqueId(slug(label), all),
    label,
    icon: typeof input.icon === 'string' && input.icon.trim() ? input.icon.trim().slice(0, 8) : undefined,
    note: String(input.note ?? '').trim() || undefined,
    ...normalised,
    updatedAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) all[existingIndex] = record;
  else all.push(record);

  save(all);
  return { ok: true, errors: [], warnings, favourite: record };
}

export function remove(id) {
  const all = load();
  const next = all.filter((f) => f.id !== id);
  if (next.length === all.length) return false;
  save(next);
  return true;
}

/** Drag-to-reorder support: ids in the order they should appear. */
export function reorder(ids) {
  const all = load();
  const byId = new Map(all.map((f) => [f.id, f]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  for (const f of all) if (!ids.includes(f.id)) ordered.push(f);
  save(ordered);
  return ordered;
}
