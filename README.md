# by-ear

A race car's telemetry from its sound. Give it an onboard recording, or pipe in live audio, and it reads the revs, the gear
changes, the gear, the speed, the throttle state, the limiter and the laps. No telemetry feed, no video, no setup beyond
naming the car.

How it was built, and how every number below was checked, is the case study:
[Telemetry by ear](https://corgido.github.io/telemetry-by-ear/) and its [record](https://corgido.github.io/telemetry-by-ear/record.html).

## Use

Node 18 or later. It isn't on npm: install it from here.

```sh
git clone https://github.com/corgido/by-ear && cd by-ear
npm install          # builds it too
npm link             # optional: puts `by-ear` on your PATH (or run `node dist/cli.js` in its place)

by-ear --cars                                            # the car profiles it knows
by-ear onboard.wav --car manthey-911-gt3r-992 > run.csv

# anything ffmpeg can read, piped in as raw samples (32-bit float, mono, 48 kHz)
ffmpeg -i onboard.mp4 -f f32le -ac 1 -ar 48000 - | by-ear --car manthey-911-gt3r-992 > run.csv

# live: rows as the sound comes in (a capture card, a stream, a microphone)
ffmpeg -i <live source> -f f32le -ac 1 -ar 48000 - | by-ear --car manthey-911-gt3r-992 --live

# the report (gearbox, shift points, laps, braking zones, how sure) instead of the rows
by-ear onboard.wav --car manthey-911-gt3r-992 --json > report.json
```

The CSV, ten rows a second:

| column | |
|---|---|
| `t` | seconds into the sound |
| `rpm` | engine speed |
| `gear` | the gear |
| `kmh` | speed, from the revs through that gear's ratio |
| `throttle` | `on`, `lift` or `overrun` |
| `sure` | 0 to 1: how sure it is that this is the engine at this rpm |
| `limiter` | 1 where the revs hit the limiter |

From a file, the gear is decided over the whole run with hindsight. With `--live` it is decided as the sound comes, as a
dash would show it, which is right less often (below).

### As a library

From a clone (`npm install /path/to/by-ear` in your project, or a git dependency):

```ts
import { Listener } from 'by-ear';

const listener = new Listener(48000, 'manthey-911-gt3r-992');
for (const chunk of audio) {            // Float32Array, mono
  for (const row of listener.push(chunk)) console.log(row.t, row.gear, row.kmh);   // live
}
const { report, rows } = listener.finish();                                         // the whole run
```

The parts (`EngineAnalyser`, `buildReport`, `Dash`, the car profiles, a synthetic onboard with known answers) are exported
too.

## How well it works

Every figure here is scored against something that knew the truth, with the test data chosen before the result was known.
The details, and every failure along the way, are in the record.

| | gear right | speed |
|---|---|---|
| Real Porsche 911 GT3 R (992) onboards held back from tuning (4 clips, the teams' own data overlays as truth) | 75.7 % decided over the run; 62.6 % live | within 1 to 4 % |
| The same clips, always guessing the commonest gear | 24.2 % | |
| An hour of Assetto Corsa Competizione in the 992 (the game's display as truth) | 86.8 % decided; 61 % live | |
| A synthetic onboard (the simulation's own truth) | about 93 % | revs within 3 % on 98 % of moments |

Laps came out within half a second of the overlay's on the three held-back onboards with a whole lap.

**Where it is weak.**
- **Braking.** On overrun, about one downshift in five goes unheard, so the gear reads high until the throttle comes back.
- **The wrong car reads wrong.** The revs come out at a fixed multiple, and the gear and speed with them. It notices from
  the shift points and the limiter (`carMismatch`, `carSuggest`), but name the right car.
- **A car without published gear ratios** gets a counted gear, which can slip at a missed shift until the car reaches top
  or first gear again.
- **Broadcast sound** (commentary, music, mixing) costs accuracy against a clean onboard.
- **Circuits.** It names the circuit only from a library you give it (`--tracks circuits.json`, the `TrackDef` format). None
  is included.

## Adding a car

A profile in `src/cars.ts`: cylinders and firing order, the rev range and limiter, the shift lights, the gear ratios, final
drive and tyre size. A profile learned from footage also carries the upshifts as heard (`upshiftHeard`) and the car's
climb on full power (`climbCurve`), which are what lift the real 992 from about a quarter to three quarters right. The
record (4.20, 4.21) shows how they were learned from a team's overlay.

## Where it came from

This code was extracted from the project it was built in; the case study tells how each part came to be. Where a comment cites "the case study's
record, 4.21" and so on, that is the numbered entry on the [record page](https://corgido.github.io/telemetry-by-ear/record.html),
where the measurement behind it is written up.

## Names

Car, team and game names (Porsche, Manthey, Assetto Corsa Competizione and others) are used only to say which car a profile
describes. This project is not affiliated with or endorsed by any of them.

## Licence

MIT. See `LICENSE`.
