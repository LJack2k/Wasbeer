#!/usr/bin/env node
/**
 * Sanity-checks data/supported-cycles.json against data/device.json.
 * Catches transcription slips in the hand-entered snapshot.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cycles = JSON.parse(readFileSync(join(ROOT, 'data/supported-cycles.json'), 'utf8'));
const device = JSON.parse(readFileSync(join(ROOT, 'data/device.json'), 'utf8'));

const problems = [];
const note = [];

// 1. Every dial entry has a cycle definition, and nothing extra.
const defined = cycles.map((c) => c.cycle);
const dial = device.dialOrder;
for (const d of dial) if (!defined.includes(d)) problems.push(`dialOrder has ${d} but no cycle definition`);
for (const d of defined) if (!dial.includes(d)) problems.push(`cycle ${d} defined but not in dialOrder`);
if (JSON.stringify(defined) !== JSON.stringify(dial)) problems.push('cycle order differs from dialOrder');
if (new Set(defined).size !== defined.length) problems.push('duplicate cycle codes');

// 2. Each cycle's default must be inside its own options list (or the list must be empty = fixed value).
const OPTS = ['bubbleSoak', 'dryingLevel', 'spinLevel', 'rinseCycle', 'waterTemperature'];
for (const c of cycles) {
  for (const o of OPTS) {
    const spec = c.supportedOptions[o];
    if (!spec) { problems.push(`${c.cycle}: missing option ${o}`); continue; }
    if (typeof spec.default !== 'string') problems.push(`${c.cycle}.${o}: default is not a string`);
    if (!Array.isArray(spec.options)) problems.push(`${c.cycle}.${o}: options is not an array`);
    if (spec.options.length && !spec.options.includes(spec.default))
      problems.push(`${c.cycle}.${o}: default "${spec.default}" not in options ${JSON.stringify(spec.options)}`);
    if (!/^[0-9A-F]{4}$/.test(spec.raw)) problems.push(`${c.cycle}.${o}: raw "${spec.raw}" is not 4 hex digits`);
  }
  if (!c.supportedCycleTypes.includes(c.cycleType))
    problems.push(`${c.cycle}: cycleType "${c.cycleType}" not in supportedCycleTypes`);
}

// 3. Per-cycle values should be a subset of the device-wide lists (flag, don't fail).
const G = device.globalOptionLists;
const globalFor = {
  spinLevel: G['custom.washerSpinLevel.supportedWasherSpinLevel'],
  rinseCycle: G['custom.washerRinseCycles.supportedWasherRinseCycles'],
  waterTemperature: G['custom.washerWaterTemperature.supportedWasherWaterTemperature'],
  dryingLevel: G['custom.dryerDryLevel.supportedDryerDryLevel'],
};
for (const c of cycles) {
  for (const [o, list] of Object.entries(globalFor)) {
    for (const v of c.supportedOptions[o].options) {
      if (!list.includes(v)) note.push(`${c.cycle}.${o}: "${v}" is not in the device-wide list`);
    }
  }
}

// 4. Which capabilities are actually usable.
// Every command the builder can emit must exist in the fetched schema.
// src/commands.mjs throws at import if one does not, so importing it IS the check.
const disabled = new Set(device.disabledCapabilities);
let schemaCaps = 0;
try {
  const { SCHEMA } = await import('../src/commands.mjs');
  schemaCaps = Object.keys(SCHEMA).length;
  const emitted = new Set(['samsungce.washerCycle', 'custom.supportedOptions', 'custom.washerWaterTemperature',
    'custom.washerSpinLevel', 'custom.washerRinseCycles', 'custom.dryerDryLevel',
    'samsungce.washerBubbleSoak', 'samsungce.washerOperatingState', 'samsungce.washerDelayEnd', 'switch']);
  for (const c of emitted) if (disabled.has(c)) problems.push(`builder emits commands on disabled capability ${c}`);
  console.log(`command schema: ${schemaCaps} capabilities fetched, all builder commands resolve`);
} catch (err) {
  problems.push(`command schema: ${err.message}`);
}

// --- report ---
console.log(`cycles: ${cycles.length}  (allInOne ${cycles.filter(c=>c.cycleType==='allInOne').length}, washingOnly ${cycles.filter(c=>c.cycleType==='washingOnly').length}, dryingOnly ${cycles.filter(c=>c.cycleType==='dryingOnly').length})`);
console.log(`dial order matches: ${JSON.stringify(defined) === JSON.stringify(dial)}`);

const fixed = cycles.filter((c) => OPTS.every((o) => c.supportedOptions[o].options.length <= 1));
console.log(`cycles with nothing adjustable: ${fixed.map((c) => c.cycle).join(', ') || 'none'}`);

if (note.length) {
  console.log('\nNotes (per-cycle values outside the device-wide lists):');
  for (const n of note) console.log(`  - ${n}`);
}

if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(`  ! ${p}`);
  process.exit(1);
}
console.log('\nCatalog is internally consistent.');
