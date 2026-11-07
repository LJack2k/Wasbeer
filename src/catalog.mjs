/**
 * The cycle catalog: what each programme on this machine will and won't accept.
 *
 * Everything here is driven by data/supported-cycles.json, which came off the
 * machine itself. The per-cycle option lists are narrower than the device-wide
 * ones and are the authority -- cycle 29 offers 70C, which the device-wide list
 * does not mention at all.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

export const device = read('data/device.json');
export const cycles = read('data/supported-cycles.json');

let names = { cycles: [] };
try { names = read('data/cycle-names.json'); } catch { /* optional */ }

/** The five adjustable options, in the order the UI should present them. */
export const OPTIONS = ['waterTemperature', 'spinLevel', 'rinseCycle', 'dryingLevel', 'bubbleSoak'];

export const OPTION_LABELS = {
  waterTemperature: 'Temperatuur',
  spinLevel: 'Centrifuge',
  rinseCycle: 'Spoelgangen',
  dryingLevel: 'Drogen',
  bubbleSoak: 'Bubble Soak',
};

const nameFor = (code) => {
  const e = names.cycles?.find((c) => c.code === code);
  return { name: e?.name ?? null, guess: e?.guess ?? null, confirmed: Boolean(e?.confirmed) };
};

const byCode = new Map(cycles.map((c) => [c.cycle, c]));

export function getCycle(code) {
  const c = byCode.get(code);
  if (!c) throw new Error(`Unknown cycle "${code}". Known: ${[...byCode.keys()].join(', ')}`);
  return c;
}

/** Display label: the confirmed name, else the guess in parentheses, else the bare code. */
export function labelFor(code) {
  const { name, guess } = nameFor(code);
  if (name) return name;
  if (guess) return `${guess}?`;
  return `Programma ${code}`;
}

/**
 * An option is adjustable only when the cycle offers more than one value.
 * An empty or single-entry list means the machine fixes it -- sending a command
 * for it is at best a no-op and at worst an error, so we never do.
 */
export function isAdjustable(cycleCode, option) {
  return getCycle(cycleCode).supportedOptions[option].options.length > 1;
}

/** Everything the UI needs to render one cycle. */
export function describeCycle(code) {
  const c = getCycle(code);
  const { name, guess, confirmed } = nameFor(code);
  return {
    code,
    label: labelFor(code),
    name,
    guess,
    confirmed,
    cycleType: c.cycleType,
    cycleTypes: c.supportedCycleTypes,
    canDry: c.supportedCycleTypes.includes('dryingOnly') || c.supportedOptions.dryingLevel.options.length > 0,
    dryingRequired: c.supportedOptions.dryingLevel.options.length > 0
      && !c.supportedOptions.dryingLevel.options.includes('none'),
    options: Object.fromEntries(
      OPTIONS.map((o) => {
        const spec = c.supportedOptions[o];
        return [o, {
          label: OPTION_LABELS[o],
          default: spec.default,
          values: spec.options,
          adjustable: spec.options.length > 1,
          fixedAt: spec.options.length > 1 ? null : spec.default,
        }];
      }),
    ),
  };
}

export const allCycles = () => device.dialOrder.map(describeCycle);

/** A favourite with every option filled in from the cycle's own defaults. */
export function defaultsFor(code) {
  const c = getCycle(code);
  return {
    cycle: code,
    cycleType: c.cycleType,
    ...Object.fromEntries(OPTIONS.map((o) => [o, c.supportedOptions[o].default])),
  };
}

/**
 * Check a favourite against the machine's rules.
 * Returns { ok, errors[], warnings[], normalised }.
 * Never throws on bad user input -- the caller decides what to do.
 */
export function validateFavourite(fav) {
  const errors = [];
  const warnings = [];

  if (!fav || typeof fav !== 'object') return { ok: false, errors: ['not an object'], warnings, normalised: null };
  if (!byCode.has(fav.cycle)) {
    return { ok: false, errors: [`unknown cycle "${fav.cycle}"`], warnings, normalised: null };
  }

  const c = getCycle(fav.cycle);
  const normalised = { cycle: fav.cycle, cycleType: fav.cycleType ?? c.cycleType };

  if (!c.supportedCycleTypes.includes(normalised.cycleType)) {
    errors.push(
      `cycleType "${normalised.cycleType}" not allowed for ${fav.cycle}; allowed: ${c.supportedCycleTypes.join(', ')}`,
    );
  }

  for (const o of OPTIONS) {
    const spec = c.supportedOptions[o];
    const given = fav[o];

    if (given === undefined || given === null) {
      normalised[o] = spec.default;
      continue;
    }
    const value = String(given);

    if (spec.options.length === 0) {
      if (value !== spec.default) {
        warnings.push(`${o}: ${fav.cycle} fixes this at "${spec.default}"; ignoring "${value}"`);
      }
      normalised[o] = spec.default;
      continue;
    }
    if (!spec.options.includes(value)) {
      errors.push(`${o}: "${value}" not allowed for ${fav.cycle}; allowed: ${spec.options.join(', ')}`);
      normalised[o] = spec.default;
      continue;
    }
    normalised[o] = value;
  }

  // A drying-only cycle with drying switched off would do nothing at all.
  if (normalised.cycleType === 'dryingOnly' && normalised.dryingLevel === 'none'
      && c.supportedOptions.dryingLevel.options.length > 1) {
    errors.push('cycleType is dryingOnly but dryingLevel is "none" -- that is a no-op');
  }

  return { ok: errors.length === 0, errors, warnings, normalised };
}
