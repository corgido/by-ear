// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// The report: what was heard from one stretch of one car's onboard sound, as plain data (JSON), the same from the command
// line and from a browser. It holds only what the analysis derived, never the sound or the picture: the broadcast is
// someone else's and stays theirs. Every number says how it was come by: measured from the sound, estimated with stated
// assumptions, or not known.

import type { CarProfile } from './cars';
import type { EngineFrame, LimiterHit, ShiftEvent } from './engine';
import { reconstruct, type Reconstruction, type TrackDef } from './track';
import { stint, type Stint } from './stint';

/** the largest and the smallest of a list, by a loop: spreading a long run's values into Math.max (a two-hour recording
 *  holds hundreds of thousands) overflows the call stack */
const maxOf = (xs: ArrayLike<number>): number => { let m = -Infinity; for (let i = 0; i < xs.length; i++) if (xs[i] > m) m = xs[i]; return m; };
const minOf = (xs: ArrayLike<number>): number => { let m = Infinity; for (let i = 0; i < xs.length; i++) if (xs[i] < m) m = xs[i]; return m; };

/** how far the best circuit must stand above the next to be named */
export const NAME_MARGIN = 0.25;

export interface ReportSource {
  /** what was listened to: a title, where it is (a link), and the stretch of it (seconds into the source, as shown there) */
  title: string;
  url?: string;
  from?: number;
  to?: number;
  /** anything the reader should know about how this run was read */
  note?: string;
}

export type Basis = 'measured' | 'estimated' | 'unknown';

export interface Finding { label: string; value: string; basis: Basis; note: string }

export interface Report {
  format: 'onboard/report';
  version: 1;
  made: string;
  build?: string;
  source: ReportSource;
  car: { id: string; name: string };
  heard: {
    seconds: number;
    /** the share of the time the engine was read with confidence above 0.5 */
    sure: number;
    rpm: { p10: number; median: number; p90: number; max: number };
    shifts: { up: number; down: number };
    limiterHits: number;
    /** shares of the sure time: on power, lifting, on overrun */
    throttle: { on: number; lift: number; overrun: number };
    /** share of the sure time in each gear (index 0 is first gear) */
    gears: number[];
  };
  /** each gear's km/h per 1000 rpm; and, lately, what to add to the analyser's own gear count to get the gear decided here (the
   *  live dash reads the analyser's count as it comes, and corrects it by this) */
  gearbox: { source: 'ratios' | 'physics' | 'segments' | 'none'; kmhPer1000: number[]; steps: number[]; samples: number; offset: number;
    /** the offset's share of the votes, and the runner-up offset (optional: reports saved before 24 October 2026 lack them) */
    offsetShare?: number; offsetAlt?: number };
  /** the lap: its time, length, how strongly the run repeats, and when (stream time, s) the first lap began */
  lap: { time: number; length: number | null; conf: number; start: number } | null;
  speed: { top: number | null; slowest: number | null };
  corners: { apex: number; apexKmh: number; entry: number; brake: number; kind: 'brake' | 'lift'; radius: number }[];
  track: { key: string; name: string; score: number; runnerUp: { name: string; score: number } | null; offset: number;
    /** the library's measured braking zones (a GT3 benchmark lap in the simulator), each with the heard corner nearest it */
    benchmark: { apex: number; apexKmh: number; heardKmh: number | null }[] } | null;
  /** where on a circuit the run was, found without waiting for a lap: the circuit, how well the heard speed fits its profile
   *  (and the next best), the scale the speed took from it, and the car's place along its line (m) every 5 s of the run */
  place: { key: string; name: string; corr: number; scale: number; applied: boolean; runnerUp: { name: string; corr: number } | null; at: [number, number][] } | null;
  /** the run lap by lap (times, how well each matches the first, shift point, top speed), the neutralisations and quiet
   *  stretches, and a change in how the car is driven; null with under two whole laps and nothing held */
  stint: Stint | null;
  /** the lap's speed every `step` m, from the lap's start */
  profile: { step: number; kmh: number[] } | null;
  /** the run at 4 Hz: time from the start (s), rpm, gear, throttle (0 on, 1 lift, 2 overrun), speed (km/h), confidence */
  trace: { rate: number; t0: number; rpm: number[]; gear: number[]; throttle: number[]; kmh: number[]; conf: number[] };
  shifts: { t: number; dir: 1 | -1; before: number; after: number }[];
  /** which orders the microphone carries (dB above the floor, per half-order), on power and off */
  signature: { orders: number[]; on: number[]; off: number[] } | null;
  findings: Finding[];
}

const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : NaN);
const r0 = (x: number) => (Number.isFinite(x) ? Math.round(x) : NaN);
const q = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]; };
export const lapClock = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}` : '–');
const pct = (x: number) => `${Math.round(x * 100)} %`;

export interface ReportInput {
  frames: EngineFrame[];
  shifts: ShiftEvent[];
  limiter: LimiterHit[];
  car: CarProfile;
  library: TrackDef[];
  source: ReportSource;
  signature?: { orders: number[]; on: number[]; off: number[] } | null;
  build?: string;
}

/** the gear decided here less the analyser's count, over the last half minute (the most common difference) */
/** what to add to the analyser's count, voted over the last 30 s: the winner, its share of the votes (how much the count and the
 *  gear decided here agree), and the runner-up (NaN when there is none) */
function gearOffset(rec: Reconstruction): { offset: number; share: number; alt: number } {
  const a = rec.heard.gear, b = rec.counted, votes = new Map<number, number>();
  let all = 0;
  for (let i = Math.max(0, a.length - 300); i < a.length; i++) if (a[i] >= 1 && b[i] >= 1) { votes.set(a[i] - b[i], (votes.get(a[i] - b[i]) ?? 0) + 1); all++; }
  const ranked = [...votes].sort((x, y) => y[1] - x[1]);
  return { offset: ranked[0]?.[0] ?? 0, share: all ? ranked[0][1] / all : 0, alt: ranked[1]?.[0] ?? NaN };
}

export function buildReport(inp: ReportInput): { report: Report; rec: Reconstruction } {
  const { frames, shifts, car } = inp;
  const rec = reconstruct(frames, shifts, car, inp.library);
  const sure = frames.filter((f) => f.conf > 0.5);
  const rpms = sure.map((f) => f.rpm);
  const thr = [0, 0, 0], gears = new Array(car.gears).fill(0);
  for (const f of sure) thr[f.throttle]++;
  const hg = rec.heard.gear;
  let gn = 0;
  for (let i = 0; i < hg.length; i++) if (hg[i] >= 1 && rec.heard.conf[i] > 0.5) { gears[hg[i] - 1]++; gn++; }
  const seconds = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  const speeds = Array.from(rec.speed).filter(Number.isFinite);
  // the trace at 4 Hz, from the 10 Hz reconstruction
  const step = Math.max(1, Math.round(rec.heard.rate / 4)), trace: Report['trace'] = { rate: rec.heard.rate / step, t0: rec.heard.t0, rpm: [], gear: [], throttle: [], kmh: [], conf: [] };
  for (let i = 0; i < rec.heard.rpm.length; i += step) {
    trace.rpm.push(r0(rec.heard.rpm[i])); trace.gear.push(hg[i] >= 1 ? hg[i] : 0); trace.throttle.push(rec.heard.throttle[i]);
    trace.kmh.push(r0(rec.speed[i])); trace.conf.push(Math.round(rec.heard.conf[i] * 100) / 100);
  }
  // a circuit is named only when it stands clear of the next. Every library circuit, heard with its speed 4 % off, wins by 0.33
  // or more (the synthetic V8 without ratios at Monza, by 0.27); left out of the library, each one's nearest stand-in wins by
  // 0.23 at most, and Daytona (not in it) came out as Watkins Glen by 0.11. A close call is a circuit not in the library
  const m = rec.matches[0], lib = m ? inp.library.find((t) => t.key === m.key) : undefined;
  const clear = !!m && m.score > 0.4 && m.score - (rec.matches[1]?.score ?? 0) >= NAME_MARGIN;
  const track: Report['track'] = m && clear && lib ? {
    key: m.key, name: m.name, score: r1(m.score * 100) / 100, offset: r0(m.offset),
    runnerUp: rec.matches[1] ? { name: rec.matches[1].name, score: r1(rec.matches[1].score * 100) / 100 } : null,
    benchmark: lib.corners.map((c) => {
      const at = (c.apex - m.offset + lib.length) % lib.length;
      const near = rec.corners.reduce<{ d: number; v: number | null }>((b, x) => {
        const d = Math.min(Math.abs(x.apex - at), lib.length - Math.abs(x.apex - at));
        return d < b.d ? { d, v: x.apexKmh } : b;
      }, { d: 150, v: null });
      return { apex: r0(c.apex), apexKmh: r0(c.apexKmh), heardKmh: near.v === null ? null : r0(near.v) };
    }),
  } : null;

  const gb = rec.gearbox, lap = rec.lap, pl = rec.place;
  let place: Report['place'] = null;
  if (pl && pl.corr >= 0.45 && pl.corr - (pl.runnerUp?.corr ?? 0) >= 0.15) {
    const lib = inp.library.find((t) => t.key === pl.key)!, at: [number, number][] = [];
    const i0 = Math.max(0, Math.round((pl.t0 - rec.heard.t0) * rec.heard.rate)), k = pl.applied ? 1 : pl.scale;
    for (let i = i0; i < rec.dist.length; i += Math.round(5 * rec.heard.rate)) at.push([Math.round((rec.heard.t0 + i / rec.heard.rate) * 10) / 10, r0((pl.offset + k * (rec.dist[i] - rec.dist[i0])) % lib.length)]);
    place = { key: pl.key, name: pl.name, corr: Math.round(pl.corr * 100) / 100, scale: pl.scale, applied: !!pl.applied, runnerUp: pl.runnerUp ? { name: pl.runnerUp.name, corr: Math.round(pl.runnerUp.corr * 100) / 100 } : null, at };
  }
  const findings: Finding[] = [];
  const add = (label: string, value: string, basis: Basis, note: string) => findings.push({ label, value, basis, note });
  add('Engine speed', rpms.length ? `${r0(q(rpms, 0.1))}–${r0(q(rpms, 0.9))} rpm, ${r0(maxOf(rpms))} at most` : '–', rpms.length ? 'measured' : 'unknown',
    'From the engine’s orders in the sound, read every 21 ms; within 2 % on 97 % of moments on synthetic laps, not yet checked against a real logger.');
  add('Shifts', `${shifts.filter((s) => s.dir > 0).length} up, ${shifts.filter((s) => s.dir < 0).length} down`, 'measured',
    'Where the revs jump by a gear’s ratio; timed to about 15 ms on synthetic laps.');
  add('Throttle', sure.length ? `on ${pct(thr[0] / sure.length)}, lifting ${pct(thr[1] / sure.length)}, overrun ${pct(thr[2] / sure.length)}` : '–', sure.length ? 'measured' : 'unknown',
    'On, lifting or off: from the revs’ slope and the engine’s loudness. Part throttle is not told apart from full.');
  add('Gear', gb.source === 'ratios' ? 'absolute, from the profile’s ratios' : gb.source === 'physics' ? 'absolute, from speed carried through each shift' : gb.source === 'segments' ? 'not numbered' : 'counted from the lowest gear heard',
    gb.source === 'ratios' ? 'measured' : gb.source === 'segments' ? 'unknown' : 'estimated',
    gb.source === 'physics' ? 'Without the team’s ratios: each gear placed by the speed its revs’ climb implies and kept consistent through every shift.' : gb.source === 'segments' ? 'The run carried no gear count; the speed was carried from one stretch to the next through each shift instead.' : 'From the shifts counted.');
  add('Speed', speeds.length ? `${r0(maxOf(speeds))} km/h at most${rec.corners.length ? `, ${r0(minOf(rec.corners.map((c) => c.apexKmh)))} km/h at the slowest corner` : ''}` : '–',
    gb.source === 'ratios' ? 'measured' : gb.source === 'none' ? 'unknown' : 'estimated',
    gb.source === 'physics' || gb.source === 'segments'
      ? `From how fast the revs climb on full power, with ${car.powerKw} kW, ${car.massKg} kg and a drag area of ${car.cda} m² (published or assumed figures: 10 % too much power reads about 4 % fast).${pl?.applied ? ` Then scaled by ${pl.scale.toFixed(2)}: the distance that fits ${pl.name}.` : ''}`
      : gb.source === 'ratios' ? 'From rpm, gear and the profile’s ratios.' : 'Needs ratios, or the car’s power, mass and drag.');
  add('Lap', lap ? `${lapClock(lap.time)}${lap.length ? `, ${(lap.length / 1000).toFixed(2)} km` : ''}` : 'not yet: about 1.6 laps of listening are needed', lap ? 'measured' : 'unknown',
    'The run’s repeat. Its start is where listening began, not the line, which the sound cannot know.');
  if (track) add('Circuit', `${track.name} (${Math.round(track.score * 100)} %, then ${track.runnerUp?.name ?? '–'} ${Math.round((track.runnerUp?.score ?? 0) * 100)} %)`, 'estimated',
    'The lap’s speed against distance, matched against 25 circuits’ racing lines and their GT3 speed profiles, with the lap’s length and time.');
  else if (place) add('Circuit', `${place.name} (fit ${place.corr.toFixed(2)}, then ${place.runnerUp?.name ?? '–'} ${place.runnerUp?.corr.toFixed(2) ?? ''})`, 'estimated',
    'Before a whole lap: the speed heard against time, laid along each of 25 circuits’ GT3 speed profiles from every starting point and distance scale; the best fit, and where the car was on it.');
  else if (m && rec.matches[1] && m.score > 0.3) add('Circuit', `not named: nearest ${m.name} ${Math.round(m.score * 100)} %, then ${rec.matches[1].name} ${Math.round(rec.matches[1].score * 100)} %`, 'unknown',
    'Too close to call: likely a circuit not among the 25 in the library (a named circuit stands clear of the next by a quarter or more).');
  else add('Circuit', 'not named', 'unknown', 'Needs the speed, and two and a half minutes of it.');
  add('Steering, brake pressure, tyres, fuel', 'not in the sound', 'unknown', 'Left from right, how hard the brake is pressed and anything the engine does not voice cannot be heard.');

  const report: Report = {
    format: 'onboard/report', version: 1, made: new Date().toISOString(), build: inp.build, source: inp.source,
    car: { id: car.id, name: car.name },
    heard: {
      seconds: r1(seconds), sure: r1((sure.length / Math.max(1, frames.length)) * 100) / 100,
      rpm: { p10: r0(q(rpms, 0.1)), median: r0(q(rpms, 0.5)), p90: r0(q(rpms, 0.9)), max: rpms.length ? r0(maxOf(rpms)) : NaN },
      shifts: { up: shifts.filter((s) => s.dir > 0).length, down: shifts.filter((s) => s.dir < 0).length },
      limiterHits: inp.limiter.length,
      throttle: { on: r1((thr[0] / Math.max(1, sure.length)) * 100) / 100, lift: r1((thr[1] / Math.max(1, sure.length)) * 100) / 100, overrun: r1((thr[2] / Math.max(1, sure.length)) * 100) / 100 },
      gears: gears.map((g) => r1((g / Math.max(1, gn)) * 100) / 100),
    },
    gearbox: { source: gb.source, kmhPer1000: gb.k.slice(1).map((x) => r1(x * 1000)), steps: gb.steps.map((x) => Math.round(x * 1000) / 1000), samples: gb.samples, ...((o) => ({ offset: o.offset, offsetShare: r1(o.share * 100) / 100, offsetAlt: o.alt }))(gearOffset(rec)) },
    lap: lap ? { time: Math.round(lap.time * 100) / 100, length: Number.isFinite(lap.length) ? r0(lap.length) : null, conf: Math.round(lap.conf * 100) / 100, start: Math.round(lap.start * 100) / 100 } : null,
    speed: { top: speeds.length ? r0(maxOf(speeds)) : null, slowest: rec.corners.length ? r0(minOf(rec.corners.map((c) => c.apexKmh))) : null },
    corners: rec.corners.map((c) => ({ apex: r0(c.apex), apexKmh: r0(c.apexKmh), entry: r0(c.entry), brake: r0(c.brake), kind: c.kind, radius: r0(c.radius) })),
    track,
    place,
    stint: (() => { const st = stint(rec, shifts, inp.limiter, car.shiftLights.to); return st.laps.length >= 2 || st.events.length ? st : null; })(),
    profile: rec.profile ? { step: r1(rec.profile.step), kmh: Array.from(rec.profile.v, r0) } : null,
    trace,
    shifts: shifts.map((s) => ({ t: Math.round(s.t * 100) / 100, dir: s.dir, before: r0(s.before), after: r0(s.after) })),
    signature: inp.signature ? { orders: inp.signature.orders, on: inp.signature.on.map(r1), off: inp.signature.off.map(r1) } : null,
    findings,
  };
  return { report, rec };
}
