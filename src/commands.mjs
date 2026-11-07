/**
 * Turns a favourite into the batch of SmartThings commands that reproduces it.
 *
 * Every command name here is checked at load time against
 * data/capability-commands.json, which is fetched from the SmartThings
 * capability definitions by scripts/capabilities.mjs. If a name drifts, this
 * module throws on import rather than failing silently against the machine.
 *
 * Two deliberate rules:
 *
 *  1. The cycle goes first. Setting a cycle resets its options to that cycle's
 *     defaults, so any option command sent before it would be overwritten.
 *  2. We only send commands for options the cycle actually lets you change.
 *     Cycle 29 fixes temperature at 70C; sending a temperature command is
 *     pointless and may be rejected. Fixed options are skipped.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { device, getCycle, OPTIONS } from './catalog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The authority on what commands exist. Fetched from SmartThings. */
export const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'data/capability-commands.json'), 'utf8'));

const COMPONENT = 'main';

function cmd(capability, command, args = []) {
  const def = SCHEMA[capability];
  if (!def) throw new Error(`No schema for capability "${capability}" -- re-run scripts/capabilities.mjs`);
  if (!def.commands[command]) {
    throw new Error(
      `"${capability}" has no command "${command}". It has: ${Object.keys(def.commands).join(', ') || '(none)'}`,
    );
  }
  return { component: COMPONENT, capability, command, arguments: args };
}

export const isVerified = (c) => Boolean(SCHEMA[c.capability]?.commands?.[c.command]);

/**
 * Two ways to select a cycle exist on this device and we do not yet know which
 * one the machine honours:
 *
 *   'washerCycle' -> samsungce.washerCycle.setWasherCycle("Table_02_Course_25")
 *   'course'      -> custom.supportedOptions.setCourse("25")
 *
 * The schema types both arguments as a bare string, so it does not settle the
 * format. Status reads back in the qualified form, which is why 'washerCycle'
 * is the default. The live test decides.
 */
export const CYCLE_SELECTORS = ['washerCycle', 'course'];

export function cycleCommand(code, selector = 'washerCycle') {
  if (selector === 'course') return cmd('custom.supportedOptions', 'setCourse', [code]);
  if (selector === 'washerCycle') {
    return cmd('samsungce.washerCycle', 'setWasherCycle', [`${device.referenceTable}_Course_${code}`]);
  }
  throw new Error(`Unknown cycle selector "${selector}". Use one of: ${CYCLE_SELECTORS.join(', ')}`);
}

/**
 * How each option is set. bubbleSoak is the odd one: it has no setter taking a
 * value, just separate on() and off() commands with no arguments.
 */
const OPTION_COMMANDS = {
  waterTemperature: (v) => cmd('custom.washerWaterTemperature', 'setWasherWaterTemperature', [v]),
  spinLevel: (v) => cmd('custom.washerSpinLevel', 'setWasherSpinLevel', [v]),
  rinseCycle: (v) => cmd('custom.washerRinseCycles', 'setWasherRinseCycles', [v]),
  dryingLevel: (v) => cmd('custom.dryerDryLevel', 'setDryerDryLevel', [v]),
  bubbleSoak: (v) => cmd('samsungce.washerBubbleSoak', v === 'on' ? 'on' : 'off'),
};

/**
 * Build the command list for a validated favourite.
 *
 * @param {object} fav     a NORMALISED favourite (run validateFavourite first)
 * @param {object} [opts]
 * @param {string} [opts.selector='washerCycle']
 * @param {boolean} [opts.start=false]  append the start command
 * @returns {{commands: object[], skipped: object[]}}
 */
export function buildApply(fav, opts = {}) {
  const { selector = 'washerCycle', start = false } = opts;
  const cycle = getCycle(fav.cycle);

  const commands = [cycleCommand(fav.cycle, selector)];
  const skipped = [];

  // setCycleType(cycleType, washerCycle?) -- only worth sending when there is a choice.
  if (cycle.supportedCycleTypes.length > 1) {
    commands.push(cmd('samsungce.washerCycle', 'setCycleType', [fav.cycleType]));
  } else {
    skipped.push({ option: 'cycleType', reason: `${fav.cycle} only supports ${cycle.supportedCycleTypes[0]}` });
  }

  for (const option of OPTIONS) {
    const spec = cycle.supportedOptions[option];
    if (spec.options.length <= 1) {
      skipped.push({ option, value: fav[option], reason: `fixed at "${spec.default}" for ${fav.cycle}` });
      continue;
    }
    commands.push(OPTION_COMMANDS[option](fav[option]));
  }

  if (start) commands.push(cmd('samsungce.washerOperatingState', 'start'));

  return { commands, skipped };
}

/** Run control, kept separate from applying a programme. */
export const control = {
  start: () => [cmd('samsungce.washerOperatingState', 'start')],
  pause: () => [cmd('samsungce.washerOperatingState', 'pause')],
  resume: () => [cmd('samsungce.washerOperatingState', 'resume')],
  cancel: () => [cmd('samsungce.washerOperatingState', 'cancel')],
  powerOn: () => [cmd('switch', 'on')],
  powerOff: () => [cmd('switch', 'off')],
  /** Delay END, not delay start: the machine finishes at that point. */
  delayEnd: (minutes) => [cmd('samsungce.washerDelayEnd', 'setDelayTime', [Number(minutes)])],
};

/** Human-readable preview of a batch, for the dry run and the UI's confirm step. */
export function describeBatch(commands) {
  return commands.map((c) => {
    const args = c.arguments?.length ? `(${c.arguments.map((a) => JSON.stringify(a)).join(', ')})` : '()';
    return `${c.capability}.${c.command}${args}`;
  });
}
