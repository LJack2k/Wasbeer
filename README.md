# Wasbeer

A favourites-first control panel for a **Samsung WD80T654ABH/S2** washer-dryer,
because the SmartThings app dropped the favourites feature and is a pain to use.

Target: small Node server + mobile-first web UI, hosted on GIGA-CARL, opened on a
phone from the laundry room. One tap = one saved programme.

## Status

API access **works** — a personal access token was accepted on 2026-11-07, so this
account is not behind the new Developer Plan paywall (at least for reads). Command
names are now fetched from the SmartThings capability definitions rather than
guessed. Nothing has been *sent* to the machine yet.

Next: a live test of cycle selection, which has to wait for the machine to be idle.

## What the machine actually exposes

Snapshot taken 2026-11-07 from the SmartThings Advanced Web App, stored in `data/`:

| File | Contents |
|---|---|
| `data/device.json` | IDs, scopes, device-wide option lists, disabled capabilities, usable commands |
| `data/supported-cycles.json` | All 24 cycles with their per-cycle option constraints |
| `data/cycle-names.json` | Code → human name mapping (**needs filling in by hand**) |

`npm run validate` cross-checks the first two. Current result: 24 cycles,
12 allInOne / 9 washingOnly / 3 dryingOnly, internally consistent.

### The good news

`samsungce.washerCycle.supportedCycles` is a complete, machine-readable
specification of every programme — and critically it gives **per-cycle** option
constraints, not just device-wide ones. Example: cycle `26` caps spin at 400 rpm,
cycle `36` locks it to 1400, cycle `29` locks everything. So the favourites editor
can offer exactly the choices the machine will accept for the chosen cycle, which
is more than the SmartThings app bothers to do.

Five adjustable options per cycle: `waterTemperature`, `spinLevel`, `rinseCycle`,
`dryingLevel`, `bubbleSoak`. Plus `cycleType` (`allInOne` / `washingOnly` /
`dryingOnly`) where the cycle supports more than one.

A favourite is therefore: cycle code + cycleType + those five values.

### Samsung's own presets are switched off

`samsungce.washerCyclePreset` reports `maxNumberOfPresets: 10` and `presets: null`
— and it is listed in `custom.disabledCapabilities`. The capability exists in the
firmware but is disabled on this model. That is the feature that went missing, and
it confirms we have to keep favourites on our side rather than push them into the
machine.

### Also disabled (do not build against these)

`custom.washerSoilLevel`, `samsungce.washerWaterLevel`, `samsungce.washerWaterValve`,
`samsungce.washerWashingTime`, `custom.washerAutoDetergent`,
`custom.washerAutoSoftener`, `samsungce.quickControl`, `samsungce.energyPlanner`,
`samsungce.audioVolumeLevel`.

So: no soil level, no water level, no custom wash time, no auto-dosing. The five
options above are the whole surface.

### Cycle names are not in the API

The API only returns codes (`25`, `2F`, `1C`). Names live in reference table
`Table_02`, which Samsung resolves inside their own app and does not expose over
the cloud API. `data/device.json`'s `dialOrder` is the order SmartThings itself
lists the courses in, so it should line up 1:1 with the list in the app — making
this a one-time manual mapping. `data/cycle-names.json` holds inferred guesses to
be corrected.

### Command names come from the API, not from guesswork

`npm run capabilities` fetches the capability definitions and writes
`data/capability-commands.json`. `src/commands.mjs` checks every command it can
emit against that file **at import time**, so a wrong name throws immediately
instead of failing silently against the machine.

Three names were guessed wrong on the first pass and are now corrected:

| Guessed | Actual |
|---|---|
| `setWasherCycleType(type)` | `setCycleType(cycleType, washerCycle?)` |
| `washerBubbleSoak.setStatus(v)` | separate `on()` / `off()`, no arguments |
| `washerOperatingState.stop()` | `cancel()` — and `resume()` also exists |

### Samsung's preset API exists even though the capability is disabled

`samsungce.washerCyclePreset` publishes real commands:

```
setWasherCyclePreset(presets: object)
delete(presetIds: array)
```

with `maxNumberOfPresets: 10` on this machine. The capability is listed in
`disabledCapabilities` and `presets` reads `null`, so it probably rejects writes
— but it is worth one test. If it accepts them, favourites could live *in the
machine* and show up in Samsung's own app too, rather than only in ours.

### Two useful quirks

- `washerCycle` reads back as `Table_02_Course_25` (qualified), while
  `custom.supportedOptions.course` reads back as plain `25`. There are two command
  paths — `samsungce.washerCycle.setWasherCycle` and
  `custom.supportedOptions.setCourse` — which take different argument formats.
  Which one actually works needs testing.
- Cycle `29` offers `waterTemperature: "70"`, a value absent from the device-wide
  `supportedWasherWaterTemperature` list. Per-cycle lists win; honour those.

## Constraints

1. **Smart Control must be on.** The machine only accepts remote commands when
   Smart Control is enabled from its own panel. `remoteControlStatus.remoteControlEnabled`
   was `"true"` at snapshot time, so this is readable and the UI can say
   "go press the button" instead of silently failing.
2. **Samsung paywalled the API.** Free cloud-API access for individual developers
   ended **3 November 2026**; the replacement is a "Developer Plan" at ~$4.99/mo.
   Separately, Personal Access Tokens have been capped at a **24-hour lifetime**
   since January 2025, so a PAT is only good for exploration — anything permanent
   needs OAuth with refresh tokens.

   The device's `allowed` list includes `x:devices` (execute), so the account has
   the right to send commands. Whether the *API* will serve them is the open
   question.

## The app

```
npm run dev     # http://localhost:8099, restarts on edit
npm start       # same without the watcher
```

Node built-ins only — no dependencies, no build step. `src/server.mjs` serves
`public/` and a small REST API; the browser does no reasoning of its own.

**Safety rules live in the server, not the browser**, so a stale tab cannot do
anything surprising:

- nothing is sent while the machine is running unless the request sets `force`
- nothing starts a programme unless the request asked for it
- every write first reads status, and refuses with a readable reason if Smart
  Control is off

### The whole page is the status display

`public/ambient.js` paints a full-page canvas behind everything, driven by what
the machine is doing. The page fills with water during the wash, drains during
the spin, and the colour follows the wash temperature. Cards float over it as
frosted glass.

Motion rules, deliberately conservative — this sits on a second monitor all day:

- nothing rotates, nothing parallaxes, nothing moves faster than ~40 px/s
- the spin phase gets **more of the same motion**, never different motion
- capped at 30 fps, and fully paused via `visibilitychange` when the tab is hidden
- `prefers-reduced-motion` renders one static frame and stops the loop
- phase changes ease over ~2 s rather than snapping

### Themes

Four, all dark — set with `data-theme` on `<html>`, persisted in `localStorage`,
switched from the header. Each re-skins both the CSS variables and the canvas
palette; some also change type, corner radius and surface shape.

| | |
|---|---|
| `water` | Deep teal-navy, slow caustics, rising bubbles. The default. |
| `console` | Near-black, instrument grid, amber progress, monospace readouts. |
| `toy` | Saturated purple-magenta, big soft bubbles, 22px radius. |
| `division` | Tactical HUD: amber on warm black, angular plates, dust and scanlines. |

The tactical theme does the most structural work. Radius drops to zero and
surfaces are cut with `clip-path` so the top-left and bottom-right corners are
notched, leaving the other two square for amber corner brackets. Numerals and
telemetry lines go monospace, labels go uppercase, and the progress ring flips to
cyan so it reads against the amber. On the canvas it swaps bubbles for drifting
dust, adds a 56px instrument grid, a fixed 3px raster, and one amber sweep that
takes 16 seconds to cross the screen — slow enough to read as atmosphere rather
than movement.

It is an original design in that idiom. No game assets, insignia or logos are
used or reproduced.

### Layouts

Below 940px it is a single phone column. Above, it splits: the status panel
sticks to the left while favourites fill the right — the second-monitor case.

### Debug bar

A strip at the bottom of the page, collapsed to 34px until you click it. Shown on
localhost automatically, and anywhere else by adding `?debug` to the URL. Its open
or closed state is remembered.

Four rows:

| Row | What it does |
|---|---|
| **Fase** | Live, Klaar/stil, Vullen, Wassen, Spoelen, Centrifuge, Drogen, Pauze, Net klaar, Smart Control uit, Offline |
| **Temp** | Koud / 30 / 40 / 60 / 70 — drives the water colour and the page tint |
| **Thema** | All four themes, one click each |
| **Voortgang** | 0–100% slider, moves the ring and recomputes the remaining time |

Anything other than **Live** puts the page into a simulated state: polling stops,
the strip turns amber and names the phase. **Live** resumes real polling.

Nothing here touches the machine — it only feeds the renderer a fake status
object. *Net klaar* fires the real finish celebration, and *Smart Control uit*
shows the real warning banner, so both can be checked without waiting for the
conditions to occur.

### The drum tells you what is happening

The status card draws a live porthole instead of a progress bar. It is wired to
real attributes, not decoration:

- the **drum rotates** at the speed of the current phase — a slow tumble while
  washing, a fast blur during the spin, still when idle
- the **water level** rises for wash and rinse and drains for spin and drying
- the **water colour** follows the selected temperature, cold blue through to
  hot red
- **bubbles** rise only while there is actually water in there
- the **ring** around the porthole is cycle progress

Favourite cards are tinted by wash temperature on the same scale, so the grid
reads at a glance: blue is a cold wash, red is 70°. Each favourite gets an icon,
guessed from the cycle (wool gets a sheep, drum clean gets a sponge) and
changeable from a picker.

Everything animated is behind `prefers-reduced-motion`.

### Layout

The UI shows the machine state, phase breakdown and remaining time at the top,
then the favourites as a tap-grid. Tapping one opens a sheet showing exactly what
will change, including a collapsible list of the literal commands that will be
sent, and offers *Instellen* (set options only) or *Start*.

The editor is the part the SmartThings app doesn't match: pick a programme and
every option re-filters to that cycle's own limits. Choose Wol and the spin
selector offers only Spoelstop / Geen / 400 tpm, because that is all cycle 26
accepts; Bubble Soak shows as "Uit (vast)" because the machine fixes it.

## Setup

1. Get a Personal Access Token at <https://account.smartthings.com/tokens>, with
   devices list/read/execute and locations read.
2. `cp .env.example .env` and paste it into `SMARTTHINGS_TOKEN`.
3. `npm run probe` — it lists the devices on your account. Copy your washer's id
   into `SMARTTHINGS_DEVICE_ID` in the same file.
4. `npm run dev`

Neither value is in the repo. The token is obvious; the device id is left out
because it identifies one specific appliance, so `data/device.json` carries
`null` in its place and `.env` supplies the real one. `probe-output/` is
gitignored too — those dumps contain serial numbers and location ids.

Remember PATs expire after 24 hours, so step 1 is a recurring chore until this
moves to OAuth.

## Scripts

```
npm run dev          # the app, with --watch, on http://localhost:8099
npm start            # the app, no watcher
npm run validate     # check the catalog is consistent (no network)
npm run dry-run      # show what each favourite would send (no network)
npm run probe        # list devices, dump status, extract option lists
npm run capabilities # refetch the capability command schema
```

`probe` reports whether a failure looks like token expiry (401) or the paid-plan
gate (402/403).
