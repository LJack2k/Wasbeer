#!/usr/bin/env node
/**
 * Shows exactly what each favourite would send to the machine, without sending
 * anything. Also runs a few deliberately-wrong favourites through the validator
 * to prove the machine's own constraints are being enforced.
 *
 *   node scripts/dry-run.mjs [path-to-favourites.json]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFavourite, labelFor, describeCycle } from '../src/catalog.mjs';
import { buildApply, describeBatch, isVerified } from '../src/commands.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? join(ROOT, 'data/favourites.example.json');
const favourites = JSON.parse(readFileSync(file, 'utf8'));

console.log(`Dry run: ${file}\n`);

let bad = 0;
for (const fav of favourites) {
  const { ok, errors, warnings, normalised } = validateFavourite(fav);
  const title = `${fav.label ?? fav.id}  [cycle ${fav.cycle} - ${labelFor(fav.cycle)}]`;
  console.log(title);
  console.log('-'.repeat(title.length));
  if (fav.note) console.log(`  ${fav.note}`);

  if (!ok) {
    bad++;
    for (const e of errors) console.log(`  ERROR   ${e}`);
    console.log();
    continue;
  }
  for (const w of warnings) console.log(`  warn    ${w}`);

  const { commands, skipped } = buildApply(normalised, { start: false });
  const unverified = commands.filter((c) => !isVerified(c)).length;
  console.log(`  would send ${commands.length} command(s)${unverified ? `, ${unverified} with UNVERIFIED names (?)` : ''}:`);
  for (const line of describeBatch(commands)) console.log(`      ${line}`);
  if (skipped.length) {
    console.log('  not sent (machine fixes these):');
    for (const s of skipped) console.log(`      ${s.option} -- ${s.reason}`);
  }
  console.log();
}

// --- validator checks: these SHOULD be rejected ---
console.log('='.repeat(60));
console.log('Validator checks (all of these must be rejected)');
console.log('='.repeat(60));

const shouldFail = [
  { what: 'spin above what Wol allows', fav: { cycle: '26', spinLevel: '1400' } },
  { what: 'temperature above what cycle 1D allows', fav: { cycle: '1D', waterTemperature: '90' } },
  { what: 'drying on a wash-only cycle', fav: { cycle: '33', cycleType: 'allInOne' } },
  { what: 'nonexistent cycle', fav: { cycle: 'ZZ' } },
  { what: 'drying-only cycle with drying off', fav: { cycle: '38', cycleType: 'dryingOnly', dryingLevel: 'none' } },
];

let missed = 0;
for (const { what, fav } of shouldFail) {
  const { ok, errors } = validateFavourite(fav);
  if (ok) { missed++; console.log(`  NOT CAUGHT  ${what}`); }
  else console.log(`  rejected    ${what}\n                -> ${errors[0]}`);
}

// --- and one that should pass despite looking odd ---
const odd = validateFavourite({ cycle: '29', waterTemperature: '70' });
console.log(`\n  cycle 29 at 70C (absent from the device-wide list): ${odd.ok ? 'accepted' : 'REJECTED - wrong'}`);
if (!odd.ok) missed++;

console.log(`\n${favourites.length} favourites, ${bad} invalid. Validator missed ${missed} case(s).`);
process.exit(bad > 0 || missed > 0 ? 1 : 0);
