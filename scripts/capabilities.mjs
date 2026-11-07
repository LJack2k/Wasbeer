#!/usr/bin/env node
/**
 * Fetches the capability DEFINITIONS for everything this washer exposes, so the
 * command names and argument schemas come from SmartThings rather than from me
 * guessing. Writes data/capability-commands.json, which is the authority the
 * command builder is checked against.
 *
 *   node --env-file-if-exists=.env scripts/capabilities.mjs
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://api.smartthings.com/v1';
const token = process.argv[2] || process.env.SMARTTHINGS_TOKEN;
if (!token) { console.error('No SMARTTHINGS_TOKEN.'); process.exit(1); }

const device = JSON.parse(readFileSync(join(ROOT, 'data/device.json'), 'utf8'));

// Every capability on the device, both components.
const CAPS = [
  'switch', 'refresh', 'remoteControlStatus', 'washerOperatingState', 'execute',
  'custom.supportedOptions', 'custom.washerWaterTemperature', 'custom.washerSpinLevel',
  'custom.washerRinseCycles', 'custom.dryerDryLevel', 'custom.washerSoilLevel',
  'custom.jobBeginningStatus', 'custom.energyType', 'custom.disabledCapabilities',
  'samsungce.washerCycle', 'samsungce.washerCyclePreset', 'samsungce.washerOperatingState',
  'samsungce.washerBubbleSoak', 'samsungce.washerDelayEnd', 'samsungce.kidsLock',
  'samsungce.switch', 'samsungce.washerWashingTime', 'samsungce.washerWaterLevel',
  'samsungce.detergentState', 'samsungce.softenerState', 'samsungce.deviceIdentification',
  'hca.washerMode',
];

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

const out = {};
const failed = [];

for (const cap of CAPS) {
  const { ok, status, body } = await get(`/capabilities/${encodeURIComponent(cap)}/1`);
  if (!ok) { failed.push({ cap, status }); continue; }

  const commands = {};
  for (const [name, def] of Object.entries(body.commands ?? {})) {
    commands[name] = (def.arguments ?? []).map((a) => ({
      name: a.name,
      type: a.schema?.type,
      enum: a.schema?.enum ?? null,
      optional: a.optional ?? false,
    }));
  }
  out[cap] = { commands, attributes: Object.keys(body.attributes ?? {}) };
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data/capability-commands.json'), JSON.stringify(out, null, 2));

// --- report: what commands exist, and how they compare to what we assumed ---
const disabled = new Set(device.disabledCapabilities);

console.log('COMMANDS BY CAPABILITY (* = capability disabled on this device)\n');
for (const [cap, def] of Object.entries(out)) {
  const names = Object.keys(def.commands);
  if (!names.length) continue;
  console.log(`${disabled.has(cap) ? '*' : ' '} ${cap}`);
  for (const [name, args] of Object.entries(def.commands)) {
    const sig = args.map((a) => {
      const t = a.enum ? a.enum.join('|') : a.type;
      return `${a.name}: ${t}${a.optional ? '?' : ''}`;
    }).join(', ');
    console.log(`      ${name}(${sig})`);
  }
}

if (failed.length) {
  console.log(`\nCould not fetch ${failed.length}: ${failed.map((f) => `${f.cap} (${f.status})`).join(', ')}`);
}

// --- check our assumptions ---
console.log('\n' + '='.repeat(60));
console.log('CHECKING WHAT THE COMMAND BUILDER ASSUMES');
console.log('='.repeat(60));

const assumed = [
  ['samsungce.washerCycle', 'setWasherCycle'],
  ['samsungce.washerCycle', 'setWasherCycleType'],
  ['custom.supportedOptions', 'setCourse'],
  ['custom.washerWaterTemperature', 'setWasherWaterTemperature'],
  ['custom.washerSpinLevel', 'setWasherSpinLevel'],
  ['custom.washerRinseCycles', 'setWasherRinseCycles'],
  ['custom.dryerDryLevel', 'setDryerDryLevel'],
  ['samsungce.washerBubbleSoak', 'setStatus'],
  ['samsungce.washerOperatingState', 'start'],
  ['samsungce.washerOperatingState', 'pause'],
  ['samsungce.washerOperatingState', 'stop'],
  ['samsungce.washerDelayEnd', 'setDelayTime'],
  ['washerOperatingState', 'setMachineState'],
  ['switch', 'on'],
];

let wrong = 0;
for (const [cap, name] of assumed) {
  const def = out[cap];
  if (!def) { console.log(`  ?  ${cap}.${name}  -- capability not fetched`); continue; }
  if (def.commands[name]) {
    console.log(`  OK ${cap}.${name}`);
  } else {
    wrong++;
    console.log(`  NO ${cap}.${name}  -- actual: ${Object.keys(def.commands).join(', ') || '(none)'}`);
  }
}
console.log(`\n${wrong} assumed command name(s) are wrong.`);
console.log('Written: data/capability-commands.json');
