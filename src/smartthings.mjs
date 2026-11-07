/**
 * Thin SmartThings cloud client. Reads status, sends command batches.
 *
 * Nothing here decides *what* to send -- that is src/commands.mjs. This module
 * only talks to the network and turns the enormous status blob into the dozen
 * values the UI actually shows.
 */

import { device } from './catalog.mjs';

const BASE = 'https://api.smartthings.com/v1';

/**
 * Which appliance to talk to. It identifies one person's machine, so it lives in
 * .env rather than in the repo; data/device.json carries a null as a fallback for
 * anyone who would rather keep it there.
 */
const DEVICE_ID = process.env.SMARTTHINGS_DEVICE_ID || device.deviceId;

export class SmartThingsError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'SmartThingsError';
    this.status = status;
    this.body = body;
  }
}

function hintFor(status) {
  return {
    401: 'Token verlopen of ongeldig. Personal access tokens leven maar 24 uur.',
    403: 'Geen toegang. Scopes van het token, of het betaalde Developer Plan.',
    404: 'Apparaat niet gevonden.',
    409: 'De machine accepteert dit commando nu niet (verkeerde toestand?).',
    422: 'De machine wees de waarde af.',
    429: 'Te veel verzoeken, even wachten.',
  }[status];
}

async function call(path, { method = 'GET', body, token } = {}) {
  const key = token || process.env.SMARTTHINGS_TOKEN;
  if (!key) throw new SmartThingsError('Geen SMARTTHINGS_TOKEN ingesteld.', { status: 0 });
  if (!DEVICE_ID) {
    throw new SmartThingsError(
      'Geen SMARTTHINGS_DEVICE_ID ingesteld. Draai `npm run probe` om het id van je machine te vinden.',
      { status: 0 },
    );
  }

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new SmartThingsError(`Netwerkfout: ${err.message}`, { status: 0 });
  }

  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

  if (!res.ok) {
    const hint = hintFor(res.status);
    const detail = parsed?.error?.message || parsed?.message || '';
    throw new SmartThingsError(
      [`HTTP ${res.status}`, hint, detail].filter(Boolean).join(' - '),
      { status: res.status, body: parsed },
    );
  }
  return parsed;
}

export const getRawStatus = (opts) => call(`/devices/${DEVICE_ID}/status`, opts);

/** Send a batch. The machine executes them in order. */
export const sendCommands = (commands, opts) =>
  call(`/devices/${DEVICE_ID}/commands`, { ...opts, method: 'POST', body: { commands } });

const val = (main, cap, attr) => main?.[cap]?.[attr]?.value ?? null;

/** Reduce the status blob to what the UI needs. */
export function readStatus(raw) {
  const main = raw?.components?.main;
  if (!main) throw new SmartThingsError('Onverwacht status-antwoord van SmartThings.', { status: 0 });

  const qualified = val(main, 'samsungce.washerCycle', 'washerCycle');
  const course = val(main, 'custom.supportedOptions', 'course')
    ?? (typeof qualified === 'string' ? qualified.split('_').pop() : null);

  const operating = val(main, 'samsungce.washerOperatingState', 'operatingState');
  const machine = val(main, 'washerOperatingState', 'machineState');

  return {
    online: true,
    power: val(main, 'switch', 'switch'),
    // The hardware gate: nothing we send works unless this is on.
    remoteControl: String(val(main, 'remoteControlStatus', 'remoteControlEnabled')) === 'true',

    operatingState: operating,          // ready | running | paused
    machineState: machine,              // stop | run | pause
    running: operating === 'running' || machine === 'run',
    jobState: val(main, 'samsungce.washerOperatingState', 'washerJobState'),
    jobPhase: val(main, 'samsungce.washerOperatingState', 'washerJobPhase'),

    cycle: course,
    cycleQualified: qualified,
    cycleType: val(main, 'samsungce.washerCycle', 'cycleType'),

    waterTemperature: val(main, 'custom.washerWaterTemperature', 'washerWaterTemperature'),
    spinLevel: val(main, 'custom.washerSpinLevel', 'washerSpinLevel'),
    rinseCycle: val(main, 'custom.washerRinseCycles', 'washerRinseCycles'),
    dryingLevel: val(main, 'custom.dryerDryLevel', 'dryerDryLevel'),
    bubbleSoak: val(main, 'samsungce.washerBubbleSoak', 'status'),

    progress: val(main, 'samsungce.washerOperatingState', 'progress'),
    remainingTime: val(main, 'samsungce.washerOperatingState', 'remainingTime'),
    remainingTimeStr: val(main, 'samsungce.washerOperatingState', 'remainingTimeStr'),
    operationTime: val(main, 'samsungce.washerOperatingState', 'operationTime'),
    completionTime: val(main, 'washerOperatingState', 'completionTime'),
    phases: val(main, 'samsungce.washerOperatingState', 'scheduledPhases') ?? [],

    delayRemaining: val(main, 'samsungce.washerDelayEnd', 'remainingTime'),
    minimumReservableTime: val(main, 'samsungce.washerDelayEnd', 'minimumReservableTime'),
    kidsLock: val(main, 'samsungce.kidsLock', 'lockState'),

    fetchedAt: new Date().toISOString(),
  };
}

export async function getStatus(opts) {
  return readStatus(await getRawStatus(opts));
}
