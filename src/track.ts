// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// The track, from the sound: what the engine analyser's readings (src/engine.ts) say about the car's speed, where it is
// on the lap, which circuit it is on and what that circuit looks like (the case study explains the method).
// Pure functions over a run that has been heard (the report), the same code in a browser, on the command line and in the tests.
//
//   1. the gearbox: how fast the car goes per rpm in each gear. From the profile's ratios when it has them; otherwise from the
//      sound itself: the upshifts give each gear's ratio to the next (the speed is the same either side of a shift), and on full
//      power, at speed, the revs climb at a rate set by power, mass and drag (power = mass × acceleration × speed, less drag),
//      so the rate the revs climb in the top gears gives the speed, and with it the whole gearbox;
//   2. speed and distance, the lap (the speed trace's repeat), and the lap as a profile of speed against distance;
//   3. the corners: where the car brakes and how slowly it goes through; a corner's radius from its apex speed and the grip;
//   4. which circuit: the lap's speed profile against every circuit in the library (supplied by the user: --tracks), at every
//      starting point, with the lap length and time as further evidence;
//   5. a sketch of the circuit drawn blind: each corner turns by its length over its radius, and the directions (the sound
//      cannot tell left from right) are chosen so that the lap closes on itself. Measured against the library's own racing
//      lines it is no better than chance (a likeness of 0.55 on average, where two unrelated circuits score 0.53): the speed
//      shows only the corners the car slows for, and not which way they turn. It is kept as a measuring stick for a better
//      attempt, not shown as a finding; the circuit is drawn from the library once it has been named.

import { powerShare, speedKmh, type CarProfile } from './cars';
import type { EngineFrame, ShiftEvent } from './engine';
import { FFT } from './fft';

/** a circuit in the library: its racing line, a GT3 speed profile on it, its corners and a benchmark lap */
export interface TrackDef {
  key: string;
  name: string;
  /** metres */
  length: number;
  /** a GT3 benchmark lap (s), when known */
  lap: number | null;
  /** the racing line and the speed profile every `step` metres: x, y in metres, v in km/h */
  step: number;
  x: number[];
  y: number[];
  v: number[];
  /** the heavy braking zones, measured: brake, apex and throttle points (m from the line) and speeds (km/h) */
  corners: { brake: number; apex: number; throttle: number | null; entry: number; apexKmh: number }[];
  sectors?: number[] | null;
}

/** a run resampled to a fixed rate */
export interface Heard {
  rate: number;
  t0: number;
  rpm: Float32Array;
  conf: Float32Array;
  /** NaN where unknown */
  gear: Float32Array;
  throttle: Uint8Array;
}

export interface Gearbox {
  /** km/h per rpm, by gear (index 0 unused); NaN where unknown */
  k: number[];
  /** ratios: the profile's; physics: each gear from the revs' climb; segments: no gears at all, the speed carried from stretch
   *  to stretch through the shifts (see segmentSpeed); none: no speed */
  source: 'ratios' | 'physics' | 'segments' | 'none';
  /** each upshift's ratio (after / before), 1→2 first */
  steps: number[];
  /** how many moments on full power the physics scale rests on, and their spread (the 10th to 90th percentile, as a share) */
  samples: number;
  spread: number;
}

export interface HeardCorner {
  /** metres into the lap: where braking (or the lift) began, the apex */
  brake: number;
  apex: number;
  /** km/h */
  entry: number;
  apexKmh: number;
  kind: 'brake' | 'lift';
  /** metres, from the apex speed and the grip */
  radius: number;
}

export interface TrackMatch {
  key: string;
  name: string;
  /** 0..1 */
  score: number;
  /** the profile's correlation with the library's, and the lap length and time against the library's (ratios) */
  corr: number;
  lengthRatio: number;
  lapRatio: number;
  /** metres along the library's line where the heard lap's start falls */
  offset: number;
}

export interface Reconstruction {
  heard: Heard;
  /** the analyser's own gear count, before it was decided again (the same as heard.gear when it was not) */
  counted: Float32Array;
  gearbox: Gearbox;
  /** km/h and metres at the heard rate (NaN where unknown) */
  speed: Float32Array;
  dist: Float64Array;
  /** `on`: what repeats, the speed or the revs (whichever repeats more clearly) */
  lap: { time: number; length: number; conf: number; start: number; on: 'speed' | 'revs' } | null;
  /** the lap's speed against distance, every `step` m from the lap's start (an average over the laps heard) */
  profile: { step: number; v: Float32Array } | null;
  corners: HeardCorner[];
  matches: TrackMatch[];
  /** where on a circuit the run was, found without waiting for a lap (null with under two and a half minutes of speed); when it
   *  is clear, the speed above has been rescaled by it */
  place: Place | null;
  /** the circuit drawn blind, every profile step, and how well it closes (the gap at the end, as a share of the lap) */
  sketch: { x: Float32Array; y: Float32Array; closure: number; scale: number } | null;
}

const G = 9.81;
/** the grip a GT3 car corners with (g): the library's speed profiles calibrate between 1.4 and 1.8 */
export const GRIP = 1.5;

// ---------------------------------------------------------------------------------------------------- the run
/** the engine frames at `rate` Hz: the mean rpm (and the decided gear and throttle) of the frames in each step */
export function resample(frames: EngineFrame[], rate = 10): Heard {
  const t0 = frames.length ? frames[0].t : 0, t1 = frames.length ? frames[frames.length - 1].t : 0;
  const n = Math.max(0, Math.floor((t1 - t0) * rate) + 1);
  const rpm = new Float32Array(n).fill(NaN), conf = new Float32Array(n), gear = new Float32Array(n).fill(NaN), thr = new Uint8Array(n);
  const sum = new Float64Array(n), cnt = new Float64Array(n);
  for (const f of frames) {
    const i = Math.min(n - 1, Math.round((f.t - t0) * rate));
    if (Number.isFinite(f.rpm)) { sum[i] += Math.log(f.rpm); cnt[i]++; }
    conf[i] = Math.max(conf[i], f.conf);
    gear[i] = f.gear;
    thr[i] = f.throttle;
  }
  for (let i = 0; i < n; i++) if (cnt[i]) rpm[i] = Math.exp(sum[i] / cnt[i]);
  // a step no frame landed in takes its neighbour's
  for (let i = 1; i < n; i++) if (!cnt[i] && cnt[i - 1]) { rpm[i] = rpm[i - 1]; gear[i] = gear[i - 1]; thr[i] = thr[i - 1]; conf[i] = conf[i - 1]; }
  return { rate, t0, rpm, conf, gear, throttle: thr };
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

// ---------------------------------------------------------------------------------------------------- 1. the gearbox
/** the speed (m/s) at which the revs would climb at `dlnr` per second on full power at `rpm`: the root of
 *  P·share(rpm) / (m·v) − (½ρ·CdA·v² + roll) / m − v·dlnr = 0, which falls with v, so bisection finds it */
/** `tractionMs2` can be set to try another full-power acceleration cap on every car */
export const CLIMB: { tractionMs2?: number } = {};

export function speedFromClimb(car: CarProfile, rpm: number, dlnr: number): number {
  if (!car.massKg || !car.powerKw || !(dlnr > 0)) return NaN;
  const m = car.massKg, P = car.powerKw * 1000 * powerShare(car, rpm), c = 0.5 * 1.2 * (car.cda ?? 1.1), roll = car.rollingN ?? 200;
  // below about 150 km/h the tyres, not the engine, cap the acceleration (car.tractionMs2): without the cap the slow climb
  // there read as a speed far too high (+83 % at 40 to 80 km/h on streamed ACC footage), and the gear one too high
  const cap = CLIMB.tractionMs2 ?? car.tractionMs2 ?? Infinity;
  const f = (v: number) => Math.min(P / (m * v), cap) - (c * v * v + roll) / m - v * dlnr;
  let lo = 3, hi = 120;
  if (f(lo) < 0 || f(hi) > 0) return NaN;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export function gearbox(h: Heard, shifts: ShiftEvent[], car: CarProfile): Gearbox {
  const Gn = car.gears, k = new Array<number>(Gn + 1).fill(NaN);
  // each upshift's ratio, by the gear it went into
  const byGear: number[][] = Array.from({ length: Gn + 1 }, () => []);
  for (const s of shifts) if (s.dir > 0 && Number.isFinite(s.gear) && s.gear >= 2 && s.gear <= Gn && s.before > 0) byGear[s.gear].push(s.after / s.before);
  const known = byGear.flatMap((x) => x);
  const steps: number[] = [];
  for (let g = 2; g <= Gn; g++) steps.push(byGear[g].length ? median(byGear[g]) : median(known));
  if (car.ratios && car.finalDrive && car.tyreCircumference) {
    for (let g = 1; g <= Gn; g++) k[g] = speedKmh(car, 1, g);
    const r = car.ratios;
    return { k, source: 'ratios', steps: r.slice(1).map((x, i) => x / r[i]), samples: 0, spread: 0 };
  }
  if (!known.length || !car.massKg || !car.powerKw) return { k, source: 'none', steps, samples: 0, spread: 0 };
  // each gear relative to the top one: k(g) = k(g+1) × step(g → g+1)
  const rel = new Array<number>(Gn + 1).fill(NaN);
  rel[Gn] = 1;
  for (let g = Gn - 1; g >= 1; g--) rel[g] = rel[g + 1] * (Number.isFinite(steps[g - 1]) ? steps[g - 1] : median(known));
  // the scale, from moments on full power at speed, clear of shifts: the revs' climb over half a second gives the speed
  const n = h.rpm.length, half = Math.round(0.25 * h.rate), shiftT = shifts.map((s) => s.t);
  const est: number[] = [], perGear: number[][] = Array.from({ length: Gn + 1 }, () => []);
  for (let i = half; i < n - half; i++) {
    const g = h.gear[i];
    if (!(g >= 1 && g <= Gn) || h.conf[i] < 0.5) continue;
    let ok = true;
    for (let j = i - half; j <= i + half && ok; j++) if (h.throttle[j] !== 0 || h.gear[j] !== g || !(h.rpm[j] > 0)) ok = false;
    if (!ok) continue;
    const t = h.t0 + i / h.rate;
    if (shiftT.some((x) => Math.abs(x - t) < 0.4)) continue;
    const dlnr = (Math.log(h.rpm[i + half]) - Math.log(h.rpm[i - half])) / ((2 * half) / h.rate);
    const v = speedFromClimb(car, h.rpm[i], dlnr);
    // power-limited, not wheelspin-limited: at speed, and not accelerating harder than the tyres could
    if (!(v > 28) || v * dlnr > 7) continue;
    est.push((v * 3.6) / (h.rpm[i] * rel[g]));
    perGear[g].push((v * 3.6) / h.rpm[i]);
  }
  // fifteen seconds or so on full power at speed before the scale is trusted
  if (est.length < 150) return { k, source: 'none', steps, samples: est.length, spread: NaN };
  const top = median(est);
  // a gear with enough moments on full power at speed is measured on its own (the upshifts' ratios come out a little low, and
  // the chain adds them up); the low gears, wheelspin-limited and seldom at speed, are chained from the gear above
  for (let g = Math.ceil(Gn / 2); g <= Gn; g++) k[g] = perGear[g].length >= 40 ? median(perGear[g]) : NaN;
  if (!Number.isFinite(k[Gn])) k[Gn] = top;
  for (let g = Gn - 1; g >= 1; g--) if (!Number.isFinite(k[g])) k[g] = k[g + 1] * (Number.isFinite(steps[g - 1]) ? steps[g - 1] : median(known));
  return { k, source: 'physics', steps, samples: est.length, spread: (quantile(est, 0.9) - quantile(est, 0.1)) / top };
}

/** The gear between each pair of shifts, decided again: the speed is the same either side of a shift, so the gear before and
 *  after must carry the rpm before and after it to one speed. A Viterbi over the stretches between shifts weighs that, the
 *  direction of each shift, the speed the revs' climb implies (on full power) and, lightly, the analyser's own count. A gear
 *  miscounted at a missed downshift then heals at once instead of over the next upshifts. Returns the gears per heard step. */
/** the gear at every moment from the gearbox alone, for a car whose gearbox is known: in each gear the revs imply a speed, and
 *  the car's speed cannot jump, so the gears are the sequence that keeps it continuous. A shift the analyser missed (a third of
 *  them on the first ACC batch, mostly downshifts under braking) still shows, as a jump of a gear's step in the speed; and the
 *  steps differ (1→2 0.77, 5→6 0.87 on the 911), which tells which gear is which. A Viterbi over the moments the revs are known:
 *  free between -60 and +40 km/h a second (braking at 1.7 g, accelerating at 1.1 g), dear beyond; a change of gear costs a
 *  little, two at once a little more; a speed no GT car reaches, a lot */
/** the weights of the heard shifts in gearByContinuity (exported, to be tuned) */
export const SHIFT_EVIDENCE = { sigma: 0.08, floor: 0.006, cap: 6, bonus: 4, stay: 3, against: 6, skip: 4, unheard: 0, climbSigma: 0.25, climbCap: 9, gapPerShift: 0.5 };
export function gearByContinuity(h: Heard, gb: Gearbox, car: CarProfile, shifts: ShiftEvent[] = [], tpl: ([number, number] | undefined)[] | null | undefined = car.upshiftHeard,
  curve: [number, number][] | null | undefined = car.climbCurve, opts: { overrun?: { acc: number; sigma: number } } = {}): Float32Array {
  const Gn = car.gears, n = h.rpm.length, out = new Float32Array(n).fill(NaN);
  if (!gb.k.slice(1, Gn + 1).every((x) => x > 0)) return Float32Array.from(h.gear);
  // the gear is decided on moments about 0.3 s apart, whatever the rate it is heard at: its costs (the climb's pull, the
  // speed's continuity) are summed per moment against a fixed cost per shift, so at three times the rate the same sound
  // read a gear right 28 % of the time instead of 52 % (the case study's record, 4.5)
  const at: number[] = [], every = Math.max(1, Math.round(0.3 * h.rate));
  for (let i = 0; i < n; i++) if (h.rpm[i] > 0 && h.conf[i] >= 0.2 && (!at.length || i - at[at.length - 1] >= every)) at.push(i);
  if (at.length < 2) return Float32Array.from(h.gear);
  const v = (i: number, g: number) => gb.k[g] * h.rpm[i];
  // continuity alone only orders the gears (a lower gear makes every speed, and so every jump, smaller): the absolute anchor is
  // the revs' climb on full power, which gives the speed roughly (the power and mass are estimates: 6 % off on the realistic laps;
  // neighbouring gears are 15 to 25 % apart)
  // Where the car's own climb is known (its acceleration on full power at each speed, measured on HUD footage), the revs' rate
  // is held against it directly in each gear: the rate a gear's speed would climb at, a(v)/v. Measured, it picks the gear on its
  // own at 74 % of the moments on full power (leave-one-run-out); the physics' speed is 12 % off at the median moment
  const half = Math.max(1, Math.round(0.3 * h.rate)), climb = new Float64Array(n).fill(NaN), rate = new Float64Array(n).fill(NaN);
  for (let i = half; i < n - half; i++) {
    if (h.throttle[i - half] || h.throttle[i] || h.throttle[i + half] || !(h.rpm[i - half] > 0 && h.rpm[i + half] > 0)) continue;
    const dl = (Math.log(h.rpm[i + half]) - Math.log(h.rpm[i - half])) / ((2 * half) / h.rate);
    if (dl <= 0.01) continue;
    rate[i] = Math.log(dl);
    const vc = speedFromClimb(car, h.rpm[i], dl);
    if (vc > 15 && vc * dl <= 9) climb[i] = Math.log(vc * 3.6);
  }
  const accel = (x: number) => {
    const c = curve!;
    if (x <= c[0][0]) return c[0][1];
    for (let k = 1; k < c.length; k++) if (x <= c[k][0]) return c[k - 1][1] + ((x - c[k - 1][0]) / (c[k][0] - c[k - 1][0])) * (c[k][1] - c[k - 1][1]);
    return c[c.length - 1][1];
  };
  const anchor = curve?.length
    ? (i: number, g: number) => (Number.isFinite(rate[i]) ? Math.min(SH.climbCap, ((rate[i] - Math.log(Math.max(0.1, accel(v(i, g))) / v(i, g))) / SH.climbSigma) ** 2) : 0)
    : (i: number, g: number) => (Number.isFinite(climb[i]) ? Math.min(9, ((Math.log(v(i, g)) - climb[i]) / 0.2) ** 2) : 0);
  const own = (i: number, g: number) => (v(i, g) > 330 ? 1e3 : 0) + (h.rpm[i] > car.limiterRpm * 1.03 ? 1e3 : 0) + anchor(i, g);
  // a shift the analyser heard between two moments says which way the gear went, and an upshift's drop in revs (after over
  // before) says from which gear: the car's template for each pair (measured on HUD footage: the heard drop sits above the
  // gearbox's true step, most in the low gears, and is sharper the higher the gear, 0.04 in log at 1→2, 0.004 at 5→6), else
  // the true step, trusted less. The analyser also hears shifts that were
  // not (a third of those it hears on a stream), so staying put costs only a little
  const SH = SHIFT_EVIDENCE, sh = shifts.filter((x) => x.dir > 0 ? x.before > 0 && x.after > 0 : true).map((x) => ({ ...x, i: (x.t - h.t0) * h.rate }));
  const step = (f: number) => tpl?.[f - 1]?.[0] ?? gb.k[f] / gb.k[f + 1], sig = (f: number) => (tpl?.[f - 1] ? Math.max(SH.floor, tpl[f - 1]![1]) : SH.sigma);
  const evidence = (j: number, i: number, f: number, g: number) => {
    let c = 0;
    for (const x of sh) {
      if (!(x.i > j && x.i <= i)) continue;
      if (x.dir > 0) {
        if (g === f + 1) c += Math.min(SH.cap, ((Math.log(x.after / x.before) - Math.log(step(f))) / sig(f)) ** 2) - SH.bonus;
        else c += g === f ? SH.stay : g < f ? SH.against : SH.skip;
      } else c += g === f - 1 || g === f - 2 ? -SH.bonus : g === f ? SH.stay : g > f ? SH.against : 0;
      break;
    }
    return c;
  };
  const M = at.length, cost = new Float64Array(Gn + 1), from = Array.from({ length: M }, () => new Int8Array(Gn + 1));
  for (let g = 1; g <= Gn; g++) cost[g] = own(at[0], g);
  for (let m = 1; m < M; m++) {
    const i = at[m], j = at[m - 1], dt = Math.max(0.1, (i - j) / h.rate), next = new Float64Array(Gn + 1).fill(Infinity);
    const heard = sh.some((x) => x.i > j && x.i <= i);
    for (let g = 1; g <= Gn; g++) {
      const vg = v(i, g), og = own(i, g);
      for (let f = 1; f <= Gn; f++) {
        const acc = (vg - v(j, f)) / dt, ex = acc > 40 ? acc - 40 : acc < -60 ? -60 - acc : 0;
        // opts.overrun (the live dash's, src/dash.ts): on overrun a car is slowing (median -14 km/h a second on the real
        // 992's overlays), so a speed that holds there means downshifts went unheard
        const ov = opts.overrun && h.throttle[i] === 2 && h.throttle[j] === 2 && acc > opts.overrun.acc ? ((acc - opts.overrun.acc) / opts.overrun.sigma) ** 2 : 0;
        const c = cost[f] + (ex / 15) ** 2 + ov + (g === f ? 0 : 2 + 2 * Math.max(0, Math.abs(g - f) - 1 - Math.floor(dt / SH.gapPerShift))) + og + (heard ? evidence(j, i, f, g) : g === f ? 0 : SH.unheard);
        if (c < next[g]) { next[g] = c; from[m][g] = f; }
      }
    }
    cost.set(next);
  }
  let g = 1;
  for (let x = 2; x <= Gn; x++) if (cost[x] < cost[g]) g = x;
  for (let m = M - 1; m >= 0; m--) {
    const a = m ? at[m - 1] + 1 : 0, b = m + 1 < M ? at[m] + 1 : n;
    for (let i = a; i < b; i++) out[i] = g;
    if (m) g = from[m][g];
  }
  return out;
}

export function regear(h: Heard, shifts: ShiftEvent[], gb: Gearbox, car: CarProfile): Float32Array {
  const Gn = car.gears, n = h.rpm.length, out = Float32Array.from(h.gear);
  if (!gb.k.slice(1).every(Number.isFinite) || !shifts.length) return out;
  const lk = gb.k.map((x) => Math.log(x));
  const idx = (t: number) => Math.max(0, Math.min(n - 1, Math.round((t - h.t0) * h.rate)));
  const cuts = [0, ...shifts.map((x) => idx(x.t)), n];
  const half = Math.round(0.25 * h.rate), clear = Math.round(0.25 * h.rate);
  interface Seg { a: number; b: number; r0: number; r1: number; lk: number; counted: number }
  const segs: Seg[] = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const a = cuts[c], b = cuts[c + 1];
    const near = (lo: number, hi: number) => { const xs: number[] = []; for (let i = Math.max(a, lo); i < Math.min(b, hi); i++) if (h.rpm[i] > 0 && h.conf[i] >= 0.2) xs.push(Math.log(h.rpm[i])); return xs.length ? median(xs) : NaN; };
    const r0 = near(a + clear, a + clear + 4), r1 = near(b - clear - 4, b - clear);
    // the speed the climb implies, where the stretch is on full power at speed
    const ks: number[] = [];
    for (let i = a + clear + half; i < b - clear - half; i++) {
      if (h.throttle[i - half] || h.throttle[i + half] || h.throttle[i] || !(h.rpm[i - half] > 0 && h.rpm[i + half] > 0)) continue;
      const dl = (Math.log(h.rpm[i + half]) - Math.log(h.rpm[i - half])) / ((2 * half) / h.rate), v = speedFromClimb(car, h.rpm[i], dl);
      if (v > 28 && v * dl <= 7) ks.push(Math.log((v * 3.6) / h.rpm[i]));
    }
    const counted: number[] = [];
    for (let i = a; i < b; i++) if (h.gear[i] >= 1) counted.push(h.gear[i]);
    segs.push({ a, b, r0, r1, lk: ks.length >= 3 ? median(ks) : NaN, counted: counted.length ? median(counted) : NaN });
  }
  const S = segs.length, cost = Array.from({ length: S }, () => new Float64Array(Gn + 1).fill(Infinity)), from = Array.from({ length: S }, () => new Int8Array(Gn + 1));
  // the analyser's count drifts at a missed shift (it is relative), so it counts for little; the climb's speed is absolute
  const own = (sg: Seg, g: number) => (Number.isFinite(sg.lk) ? ((lk[g] - sg.lk) / 0.07) ** 2 : 0) + (sg.counted === g ? 0 : 0.3);
  for (let g = 1; g <= Gn; g++) cost[0][g] = own(segs[0], g);
  for (let s2 = 1; s2 < S; s2++) {
    const p = segs[s2 - 1], q = segs[s2], dir = shifts[s2 - 1].dir;
    for (let g = 1; g <= Gn; g++) {
      for (let f = 1; f <= Gn; f++) {
        if (!Number.isFinite(cost[s2 - 1][f])) continue;
        // the speed on either side of the shift, and the direction it went
        // (the rpm either side as the analyser extrapolated it to the moment of the shift: the revs move fast in a low gear)
        const sh = shifts[s2 - 1], b0 = sh.before > 0 ? Math.log(sh.before) : p.r1, a0 = sh.after > 0 ? Math.log(sh.after) : q.r0;
        const cont = Number.isFinite(b0) && Number.isFinite(a0) ? ((b0 + lk[f] - (a0 + lk[g])) / 0.03) ** 2 : 0;
        // a shift is one gear; two at once is a downshift heard as one (they come every third of a second under braking)
        const way = Math.sign(g - f) !== dir ? (g === f ? 6 : 25) : Math.abs(g - f) === 1 ? 0 : 3 * (Math.abs(g - f) - 1);
        const c = cost[s2 - 1][f] + cont + way + own(q, g);
        if (c < cost[s2][g]) { cost[s2][g] = c; from[s2][g] = f; }
      }
    }
  }
  let g = 1;
  for (let x = 2; x <= Gn; x++) if (cost[S - 1][x] < cost[S - 1][g]) g = x;
  for (let s2 = S - 1; s2 >= 0; s2--) {
    for (let i = segs[s2].a; i < segs[s2].b; i++) out[i] = g;
    if (s2 > 0) g = from[s2][g];
  }
  return out;
}

/** The speed without gears: one unknown speed per rpm for each stretch between shifts, tied to its neighbours (the speed is the
 *  same either side of a shift: the factor changes by the rpm before over the rpm after) and anchored, where the stretch climbs
 *  on full power at speed, by the speed the climb implies. One least-squares solve over all the stretches; no gear numbers are
 *  needed, so it works on a run whose gears were never counted (a session stored at 10 Hz, say). Returns the speed (km/h). */
export function segmentSpeed(h: Heard, shifts: ShiftEvent[], car: CarProfile): Float32Array | null {
  const n = h.rpm.length, out = new Float32Array(n).fill(NaN);
  if (!car.massKg || !car.powerKw || shifts.length < 4) return null;
  const idx = (t: number) => Math.max(0, Math.min(n - 1, Math.round((t - h.t0) * h.rate)));
  const cuts = [0, ...shifts.map((x) => idx(x.t)), n], S = cuts.length - 1, half = Math.round(0.3 * h.rate);
  // the normal equations of a chain (tridiagonal): anchors on the diagonal, each shift a link between neighbours
  const diag = new Float64Array(S), off = new Float64Array(S), rhs = new Float64Array(S);
  let anchors = 0;
  for (let s = 0; s < S; s++) {
    const a = cuts[s] + 3, b = cuts[s + 1] - 3, obs: number[] = [];
    for (let i = a + half; i < b - half; i++) {
      if (h.throttle[i] !== 0 || !(h.rpm[i - half] > 0 && h.rpm[i + half] > 0)) continue;
      const dl = (Math.log(h.rpm[i + half]) - Math.log(h.rpm[i - half])) / ((2 * half) / h.rate), v = speedFromClimb(car, h.rpm[i], dl);
      if (v > 28 && v * dl <= 7) obs.push(Math.log((v * 3.6) / h.rpm[i]));
    }
    if (obs.length) { const w = obs.length / 0.15 ** 2; diag[s] += w; rhs[s] += w * median(obs); anchors++; }
  }
  if (anchors < 3) return null;
  shifts.forEach((x, k) => {
    if (!(x.before > 0 && x.after > 0)) return;
    const w = 1 / 0.04 ** 2, d = Math.log(x.before / x.after);
    // K[k+1] - K[k] = d
    diag[k] += w; diag[k + 1] += w; off[k] -= w; rhs[k] -= w * d; rhs[k + 1] += w * d;
  });
  for (let s = 0; s < S; s++) diag[s] += 1e-6;
  // Thomas algorithm
  const c = new Float64Array(S), d = new Float64Array(S), K = new Float64Array(S);
  c[0] = off[0] / diag[0]; d[0] = rhs[0] / diag[0];
  for (let s = 1; s < S; s++) { const m = diag[s] - off[s - 1] * c[s - 1]; c[s] = off[s] / m; d[s] = (rhs[s] - off[s - 1] * d[s - 1]) / m; }
  K[S - 1] = d[S - 1];
  for (let s = S - 2; s >= 0; s--) K[s] = d[s] - c[s] * K[s + 1];
  for (let s = 0; s < S; s++) for (let i = cuts[s]; i < cuts[s + 1]; i++) if (h.rpm[i] > 0 && h.conf[i] >= 0.2) out[i] = h.rpm[i] * Math.exp(K[s]);
  for (const x of shifts) { const c0 = idx(x.t); for (let i = Math.max(0, c0 - 1); i <= Math.min(n - 1, c0 + 1); i++) out[i] = NaN; }
  return out;
}

// ---------------------------------------------------------------------------------------------------- 2. speed, distance, the lap
export function speedOf(h: Heard, gb: Gearbox, shifts: ShiftEvent[] = []): Float32Array {
  const n = h.rpm.length, v = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const g = h.gear[i], kk = g >= 1 ? gb.k[g] : NaN;
    if (h.conf[i] >= 0.2 && Number.isFinite(kk) && h.rpm[i] > 0) v[i] = h.rpm[i] * kk;
  }
  // through a shift the rpm and the gear count do not change at the same moment: leave an eighth of a second either side out
  for (const s of shifts) {
    const c = Math.round((s.t - h.t0) * h.rate), w = Math.max(1, Math.round(0.12 * h.rate));
    for (let i = Math.max(0, c - w); i <= Math.min(n - 1, c + w); i++) v[i] = NaN;
  }
  // gaps of up to three seconds (a shift, another car passing, a moment unsure) are bridged in a straight line
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(v[i])) continue;
    if (last >= 0 && i - last > 1 && i - last <= 3 * h.rate) for (let j = last + 1; j < i; j++) v[j] = v[last] + ((v[i] - v[last]) * (j - last)) / (i - last);
    last = i;
  }
  return v;
}

/** the period of a trace (s) by autocorrelation, between lo and hi seconds (the shortest of any near-equal repeats), and how
 *  strongly it repeats; null with too little of it (about 1.6 periods are needed) */
/** the lap vote (see reconstruct): the least repeat a stretch may vote with, and the votes a lap needs */
export const VOTE = { floor: 0.3, need: 4 };

export function period(x0: Float32Array, rate: number, lo = 30, hi = 900, floor = 0.4): { time: number; conf: number } | null {
  const M = x0.length;
  let mean = 0, c = 0;
  for (const v of x0) if (Number.isFinite(v)) { mean += v; c++; }
  if (c < M * 0.5) return null;
  mean /= c;
  const minLag = Math.round(lo * rate), maxLag = Math.min(Math.round(hi * rate), Math.floor(M / 1.6));
  if (maxLag <= minLag + 2) return null;
  let size = 1;
  while (size < 2 * M) size <<= 1;
  const fft = new FFT(size), re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < M; i++) re[i] = Number.isFinite(x0[i]) ? x0[i] - mean : 0;
  const x = re.slice(0, M);
  fft.transform(re, im);
  for (let k = 0; k < size; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
  fft.transform(re, im);
  const cum = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) cum[i + 1] = cum[i] + x[i] * x[i];
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < M; lag++) {
    const ea = cum[M - lag], eb = cum[M] - cum[lag];
    r[lag] = ea > 0 && eb > 0 ? re[lag] / size / Math.sqrt(ea * eb) : 0;
  }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > best) best = r[lag];
  if (best < floor) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag] >= 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      const a = r[lag - 1], b = r[lag], cc = r[lag + 1], den = a - 2 * b + cc;
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / den)) : 0;
      return { time: (lag + off) / rate, conf: b };
    }
  }
  return null;
}

/** the lap's speed against distance: each whole lap heard, cut into `step` m pieces from its start, the median of the laps */
export function lapProfile(speed: Float32Array, dist: Float64Array, rate: number, lapTime: number, start: number, step: number): { v: Float32Array; length: number } {
  // the lap's length: the distance covered in each lap's time (the median, so a slow lap does not shorten it)
  const per = Math.round(lapTime * rate), lens: number[] = [];
  for (let a = start; a + per < speed.length; a += per) lens.push(dist[a + per] - dist[a]);
  const length = median(lens.filter((x) => x > 0));
  // then the laps cut by distance, every lap's length of road from the start (a lap slowed by a Code 60 zone or a stop is long
  // in time, not in distance, so the laps after it stay in step)
  const laps: { a: number; b: number }[] = [];
  for (let a = start, k = 1; a < speed.length; k++) {
    let b = a;
    while (b < speed.length && dist[b] - dist[start] < k * length) b++;
    if (b >= speed.length) break;
    laps.push({ a, b });
    a = b;
  }
  const N = Math.max(8, Math.round(length / step));
  // each lap's own profile, then the median across laps at every point (one disturbed lap, a Code 60 zone or a stop, does not
  // move a median of several)
  const perLap = laps.map((l) => {
    const sum = new Float64Array(N), cnt = new Float64Array(N), L = dist[l.b] - dist[l.a];
    for (let i = l.a; i < l.b; i++) {
      if (!Number.isFinite(speed[i])) continue;
      const q = Math.min(N - 1, Math.floor(((dist[i] - dist[l.a]) / L) * N));
      sum[q] += speed[i]; cnt[q]++;
    }
    return Array.from(sum, (x, q) => (cnt[q] ? x / cnt[q] : NaN));
  });
  // each lap slid into step with the first (up to a tenth of a lap either way): the distance through a stretch with no speed (a
  // Code 60 zone held below what the engine note gives away, a stop) is bridged at the speeds either side, which puts every lap
  // after it out of step, and a median of laps out of step smooths a hairpin away (Spa's La Source read 113 km/h, not 62)
  const ref = perLap[0], W = Math.round(N / 10);
  for (let k = 1; k < perLap.length; k++) {
    const p = perLap[k];
    let best = -Infinity, at = 0;
    for (let sh = -W; sh <= W; sh++) {
      let sxy = 0, sx = 0, sy = 0, sxx = 0, syy = 0, m = 0;
      for (let q = 0; q < N; q++) {
        const x = ref[q], y = p[(q + sh + N) % N];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        m++; sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
      }
      const c = m > N / 2 ? (sxy - (sx * sy) / m) / Math.sqrt(Math.max(1e-9, (sxx - (sx * sx) / m) * (syy - (sy * sy) / m))) : -Infinity;
      if (c > best) { best = c; at = sh; }
    }
    if (at) perLap[k] = Array.from({ length: N }, (_, q) => p[(q + at + N) % N]);
  }
  const v = new Float32Array(N);
  for (let q = 0; q < N; q++) {
    const xs = perLap.map((p) => p[q]).filter(Number.isFinite).sort((a, b) => a - b);
    v[q] = xs.length ? (xs.length % 2 ? xs[xs.length >> 1] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : NaN;
  }
  // pieces passed too quickly to be sampled take their neighbours' mean
  for (let q = 0; q < N; q++) if (!Number.isFinite(v[q])) {
    let a = q, b = q;
    while (!Number.isFinite(v[(a - 1 + N) % N]) && a > q - N) a--;
    while (!Number.isFinite(v[(b + 1) % N]) && b < q + N) b++;
    const va = v[(a - 1 + N) % N], vb = v[(b + 1) % N];
    v[q] = Number.isFinite(va) && Number.isFinite(vb) ? (va + vb) / 2 : Number.isFinite(va) ? va : vb;
  }
  return { v, length };
}

// ---------------------------------------------------------------------------------------------------- 3. corners
/** the corners of a lap's speed profile (km/h every `step` m, closed): every local minimum the car slowed into by at least
 *  `minDrop` km/h from the fastest point since the previous one */
export function cornersOf(v: ArrayLike<number>, step: number, minDrop = 6): HeardCorner[] {
  const N = v.length, at = (i: number) => v[((i % N) + N) % N];
  const out: HeardCorner[] = [];
  // start from the fastest point, so no corner straddles the lap's start
  let s0 = 0;
  for (let i = 0; i < N; i++) if (v[i] > v[s0]) s0 = i;
  let peak = s0, i = s0 + 1;
  const end = s0 + N;
  while (i < end) {
    // descend to the bottom of this dip
    if (at(i) < at(i - 1)) {
      let lo = i;
      while (lo + 1 < end && at(lo + 1) <= at(lo)) lo++;
      // a plateau or a tiny rise inside the dip does not end it: look ahead a little
      let j = lo + 1, deeper = -1;
      while (j < end && j < lo + Math.round(60 / step) && at(j) < at(lo) + 2) { if (at(j) < at(lo)) deeper = j; j++; }
      if (deeper > 0) { i = deeper; continue; }
      const entry = at(peak), apex = at(lo);
      if (entry - apex >= minDrop) {
        const r = ((apex / 3.6) ** 2) / (GRIP * G);
        out.push({ brake: ((peak % N) + N) % N * step, apex: (lo % N) * step, entry, apexKmh: apex, kind: entry - apex >= 30 ? 'brake' : 'lift', radius: r });
      }
      // climb out to the next peak
      let p = lo;
      while (p + 1 < end && at(p + 1) >= at(p)) p++;
      peak = p;
      i = p + 1;
    } else {
      if (at(i) >= at(peak)) peak = i;
      i++;
    }
  }
  return out.sort((a, b) => a.apex - b.apex);
}

/** a closed profile's moving average over 2w + 1 points */
export function smoothClosed(v: Float32Array, w: number): Float32Array {
  const N = v.length, out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let d = -w; d <= w; d++) s += v[(((i + d) % N) + N) % N];
    out[i] = s / (2 * w + 1);
  }
  return out;
}

/** corners for the lap simulation (src/generator.ts) from a library speed profile: each apex, the distance since the one
 *  before, its speed; a fast corner taken with a lift. The simulation's lap starts at the last apex. */
export function cornersFromProfile(t: TrackDef): { corners: { len: number; v: number; kind?: 'lift' }[]; start: number } {
  const cs = cornersOf(t.v, t.step, 8);
  const L = t.length, out: { len: number; v: number; kind?: 'lift' }[] = [];
  const last = cs[cs.length - 1].apex;
  cs.forEach((c, i) => out.push({ len: i === 0 ? c.apex + (L - last) : c.apex - cs[i - 1].apex, v: c.apexKmh, ...(c.kind === 'lift' ? { kind: 'lift' as const } : {}) }));
  return { corners: out, start: last };
}

// ---------------------------------------------------------------------------------------------------- 4. which circuit
/** a closed profile resampled to n points */
function resampleClosed(v: ArrayLike<number>, n: number): Float64Array {
  const N = v.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * N) / n, a = Math.floor(x), f = x - a;
    out[i] = v[a % N] * (1 - f) + v[(a + 1) % N] * f;
  }
  return out;
}

/** the best circular correlation of two equal-length profiles, and the shift (in points of b) that gives it */
function bestShift(a: Float64Array, b: Float64Array): { corr: number; shift: number } {
  const n = a.length;
  const z = (x: Float64Array) => {
    let m = 0;
    for (const y of x) m += y;
    m /= n;
    let s = 0;
    const o = new Float64Array(n);
    for (let i = 0; i < n; i++) { o[i] = x[i] - m; s += o[i] * o[i]; }
    const d = Math.sqrt(s) || 1;
    for (let i = 0; i < n; i++) o[i] /= d;
    return o;
  };
  const A = z(a), B = z(b);
  let best = -2, shift = 0;
  for (let s = 0; s < n; s++) {
    let c = 0;
    for (let i = 0; i < n; i++) c += A[i] * B[(i + s) % n];
    if (c > best) { best = c; shift = s; }
  }
  return { corr: best, shift };
}

export function identify(profile: Float32Array, length: number, lapTime: number, library: TrackDef[]): TrackMatch[] {
  const n = 400, a = resampleClosed(profile, n), out: TrackMatch[] = [];
  for (const t of library) {
    const b = resampleClosed(t.v, n), { corr, shift } = bestShift(a, b);
    const lengthRatio = Number.isFinite(length) ? length / t.length : NaN;
    const lapRatio = t.lap && Number.isFinite(lapTime) ? lapTime / t.lap : NaN;
    // a heard lap can be slower than a benchmark (traffic, a different car, Balance of Performance) more readily than faster
    const lenF = Number.isFinite(lengthRatio) ? Math.exp(-0.5 * (Math.log(lengthRatio) / 0.08) ** 2) : 1;
    const lapF = Number.isFinite(lapRatio) ? Math.exp(-0.5 * (Math.log(lapRatio) / (lapRatio > 1 ? 0.15 : 0.06)) ** 2) : 1;
    out.push({ key: t.key, name: t.name, score: Math.max(0, corr) * Math.sqrt(lenF * lapF), corr, lengthRatio, lapRatio, offset: (shift / n) * t.length });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** where on a circuit a run was, without waiting for a lap: the run's speed against time, laid along each library circuit's
 *  GT3 speed profile from every starting point and at every distance scale from 0.70 to 1.15 (the speed worked out from the
 *  revs' climb can be off by the car's power, mass and drag; the scale that fits is that error), the best by correlation.
 *  Ten minutes of the #911's first race lap at the 24h race matched the 24h layout at 0.72, every other circuit at 0.35 or less. */
export interface Place {
  key: string;
  name: string;
  /** the correlation of the heard speed with the circuit's profile, laid as found */
  corr: number;
  /** what the heard distances had to be multiplied by to fit (1 is a perfect speed) */
  scale: number;
  /** metres along the circuit's line at the run's first sample (`t0`, s) */
  offset: number;
  t0: number;
  runnerUp: { name: string; corr: number } | null;
  /** whether the speed was rescaled by `scale` (only when the circuit is clear) */
  applied?: boolean;
}

export function locate(speed: Float32Array, rate: number, t0: number, library: TrackDef[], minSeconds = 150): Place | null {
  // 2 Hz, from the first known speed, gaps bridged in a straight line
  const step = Math.max(1, Math.round(rate / 2)), xs: number[] = [];
  let first = -1;
  for (let i = 0; i < speed.length; i += step) {
    if (first < 0 && !Number.isFinite(speed[i])) continue;
    if (first < 0) first = i;
    xs.push(speed[i]);
  }
  if (first < 0 || xs.length < minSeconds * 2) return null;
  // the latest twelve minutes are plenty, and keep the search quick
  if (xs.length > 1440) { first += (xs.length - 1440) * step; xs.splice(0, xs.length - 1440); }
  let last = NaN;
  for (let i = 0; i < xs.length; i++) { if (Number.isFinite(xs[i])) last = xs[i]; else xs[i] = last; }
  const n = xs.length, D = new Float64Array(n);
  for (let i = 1; i < n; i++) D[i] = D[i - 1] + (xs[i] + xs[i - 1]) / 2 / 3.6 / 2;
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  let sd = 0;
  for (const x of xs) sd += (x - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const z = xs.map((x) => (x - mean) / sd);
  const w = new Float64Array(n);
  const fit = (t: TrackDef, a: number, offStep: number, from = 0, to = t.length) => {
    const N = t.v.length;
    let best = { corr: -2, scale: a, offset: 0 };
    for (let off = from; off < to; off += offStep) {
      const o = ((off % t.length) + t.length) % t.length;
      let m = 0;
      for (let i = 0; i < n; i++) { w[i] = t.v[Math.floor((o + a * D[i]) / t.step) % N]; m += w[i]; }
      m /= n;
      let ss = 0, c = 0;
      for (let i = 0; i < n; i++) { const d = w[i] - m; ss += d * d; c += d * z[i]; }
      const corr = c / (Math.sqrt(ss / n) || 1) / n;
      if (corr > best.corr) best = { corr, scale: a, offset: o };
    }
    return best;
  };
  // coarse: scales 0.03 apart, starts 40 m apart; then the three best circuits finely around their best
  let found = library.map((t) => {
    let best = { corr: -2, scale: 1, offset: 0 };
    for (let a = 0.7; a <= 1.1501; a += 0.03) { const f = fit(t, a, 40); if (f.corr > best.corr) best = f; }
    return { t, ...best };
  });
  found.sort((x, y) => y.corr - x.corr);
  found = found.map((f, i) => {
    if (i > 2) return f;
    let best = { corr: f.corr, scale: f.scale, offset: f.offset };
    for (let a = f.scale - 0.03; a <= f.scale + 0.0301; a += 0.01) { const g = fit(f.t, a, 10, f.offset - 200, f.offset + 200); if (g.corr > best.corr) best = g; }
    return { t: f.t, ...best };
  });
  found.sort((x, y) => y.corr - x.corr);
  const b = found[0];
  return { key: b.t.key, name: b.t.name, corr: b.corr, scale: Math.round(b.scale * 100) / 100, offset: b.offset, t0: t0 + first / rate,
    runnerUp: found[1] ? { name: found[1].t.name, corr: found[1].corr } : null };
}

// ---------------------------------------------------------------------------------------------------- 5. the circuit, drawn blind
/** each profile point's turning (radians per point) if the car is cornering at the grip there: within a corner (speed within
 *  15 % of its apex speed, on either side of the apex), a²/v² per metre; elsewhere straight */
function turning(v: Float32Array, step: number, corners: HeardCorner[]): { k: Float64Array; owner: Int32Array } {
  const N = v.length, k = new Float64Array(N), owner = new Int32Array(N).fill(-1);
  corners.forEach((c, ci) => {
    const a = Math.round(c.apex / step), lim = c.apexKmh * 1.06;
    for (const dir of [-1, 1]) {
      for (let d = dir === 1 ? 0 : 1; d < N / 2; d++) {
        const i = (((a + dir * d) % N) + N) % N;
        if (v[i] > lim) break;
        const ms = v[i] / 3.6;
        k[i] = ((GRIP * G) / (ms * ms)) * step;
        owner[i] = ci;
      }
    }
  });
  return { k, owner };
}

function trace(k: Float64Array, owner: Int32Array, signs: Int8Array, alpha: number, step: number): { x: Float32Array; y: Float32Array; gap: number; wind: number } {
  const N = k.length, x = new Float32Array(N + 1), y = new Float32Array(N + 1);
  let h = 0, wind = 0;
  for (let i = 0; i < N; i++) {
    if (owner[i] >= 0) h += signs[owner[i]] * alpha * k[i];
    x[i + 1] = x[i] + Math.cos(h) * step;
    y[i + 1] = y[i] + Math.sin(h) * step;
    // how far the heading strays from turning steadily once round (a circuit winds round about once, not in loops)
    const off = Math.abs(h - (Math.sign(alpha) * 2 * Math.PI * (i + 1)) / N) - Math.PI;
    if (off > 0) wind += off * off;
  }
  return { x, y, gap: Math.hypot(x[N], y[N]) / (N * step), wind: wind / N };
}

/** the directions (left or right) and the one grip scale that close the lap best: the total turning must be one full turn, so
 *  each choice of directions fixes the scale; of those within reason, the one whose end lands nearest its start */
export function sketch(v: Float32Array, step: number, corners: HeardCorner[], seed = 1): Reconstruction['sketch'] {
  const C = corners.length;
  if (C < 3) return null;
  const { k, owner } = turning(v, step, corners);
  const theta = new Float64Array(C);
  for (let i = 0; i < k.length; i++) if (owner[i] >= 0) theta[owner[i]] += k[i];
  const cost = (s: Int8Array): { c: number; alpha: number } => {
    let tot = 0;
    for (let c = 0; c < C; c++) tot += s[c] * theta[c];
    if (Math.abs(tot) < 1e-6) return { c: 1e6, alpha: NaN };
    // a scale out of reason is not refused but paid for, so a search from a poor start still has a way downhill
    const raw = (2 * Math.PI) / Math.abs(tot), alpha = Math.max(0.4, Math.min(2.5, raw));
    const { gap, wind } = trace(k, owner, s, alpha * Math.sign(tot), step);
    return { c: gap + 0.3 * wind + 0.05 * Math.log(alpha) ** 2 + 5 * Math.log(raw / alpha) ** 2, alpha: alpha * Math.sign(tot) };
  };
  let best = new Int8Array(C).fill(1), bestC = cost(best);
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  if (C <= 14) {
    for (let m = 0; m < 1 << (C - 1); m++) {
      const s = new Int8Array(C);
      for (let c = 0; c < C; c++) s[c] = c === 0 ? 1 : (m >> (c - 1)) & 1 ? -1 : 1;
      const cc = cost(s);
      if (cc.c < bestC.c) { best = s; bestC = cc; }
    }
  } else {
    // too many to try them all: from random starts, flip one corner at a time while it helps
    for (let start = 0; start < 60; start++) {
      const s = new Int8Array(C);
      for (let c = 0; c < C; c++) s[c] = rnd() < 0.5 ? -1 : 1;
      let cc = cost(s), better = true;
      while (better) {
        better = false;
        for (let c = 0; c < C; c++) {
          s[c] = -s[c] as -1 | 1;
          const t = cost(s);
          if (t.c < cc.c) { cc = t; better = true; } else s[c] = -s[c] as -1 | 1;
        }
      }
      if (cc.c < bestC.c) { best = Int8Array.from(s); bestC = cc; }
    }
  }
  if (!(bestC.c < 1e5)) return null;
  const { x, y, gap } = trace(k, owner, best, bestC.alpha, step);
  return { x: x.subarray(0, k.length), y: y.subarray(0, k.length), closure: gap, scale: Math.abs(bestC.alpha) };
}

/** how alike two closed shapes are (0..1), whatever their size, rotation, mirror image, start and direction: each resampled
 *  by length to the same number of points, the best Procrustes fit over every start, both directions and the mirror, and the
 *  remaining misfit against the shape's own size */
export function likeness(ax: ArrayLike<number>, ay: ArrayLike<number>, bx: ArrayLike<number>, by: ArrayLike<number>, n = 200): number {
  const byLength = (x: ArrayLike<number>, y: ArrayLike<number>) => {
    const N = x.length, cum = [0];
    for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(x[i % N] - x[i - 1], y[i % N] - y[i - 1]));
    const L = cum[N], ox = new Float64Array(n), oy = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = (i / n) * L;
      while (j < N - 1 && cum[j + 1] < d) j++;
      const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
      ox[i] = x[j] + f * (x[(j + 1) % N] - x[j]); oy[i] = y[j] + f * (y[(j + 1) % N] - y[j]);
    }
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += ox[i]; my += oy[i]; }
    mx /= n; my /= n;
    let s = 0;
    for (let i = 0; i < n; i++) { ox[i] -= mx; oy[i] -= my; s += ox[i] ** 2 + oy[i] ** 2; }
    s = Math.sqrt(s / n) || 1;
    for (let i = 0; i < n; i++) { ox[i] /= s; oy[i] /= s; }
    return { x: ox, y: oy };
  };
  const A = byLength(ax, ay), B = byLength(bx, by);
  let best = Infinity;
  for (const mirror of [1, -1]) for (const rev of [false, true]) for (let sh = 0; sh < n; sh++) {
    // Procrustes: the rotation that best lays B (shifted, reversed, mirrored) onto A, as complex numbers: angle of Σ a·conj(b)
    let re = 0, im = 0, bb = 0;
    for (let i = 0; i < n; i++) {
      const j = rev ? (sh - i + n * 2) % n : (sh + i) % n;
      const bxv = B.x[j], byv = mirror * B.y[j];
      re += A.x[i] * bxv + A.y[i] * byv; im += A.y[i] * bxv - A.x[i] * byv;
      bb += bxv * bxv + byv * byv;
    }
    // with unit RMS sizes, the least squared misfit is 2 − 2·|Σ a·conj(b)| / n
    const mis = 2 - (2 * Math.hypot(re, im)) / n;
    if (mis < best) best = mis;
    void bb;
  }
  return Math.max(0, 1 - Math.sqrt(Math.max(0, best)));
}

// ---------------------------------------------------------------------------------------------------- all of it
/** each gear calibrated on its own by the circuit. One scale for all of them sets the average right, but without the ratios the
 *  gears are not equally wrong (on a realistic Monza the low gears read fast, the top one about right, and one scale took the top
 *  speed 5 % low). Laid along the circuit as placed, every moment has the measured GT3 lap's speed at that spot: each gear's own
 *  factor is the median of that speed over the heard one, on its moments at speed (a different car and driver, so only the
 *  median of many, and never more than 15 % either way) */
function gearsFromCircuit(h: Heard, speed: Float32Array, gb: Gearbox, place: Place, lib: TrackDef): void {
  const n = speed.length, i0 = Math.max(0, Math.round((place.t0 - h.t0) * h.rate)), N = lib.v.length;
  const by: number[][] = Array.from({ length: gb.k.length }, () => []);
  let d = 0, lastV = NaN;
  for (let i = i0 + 1; i < n; i++) {
    const v = speed[i];
    if (Number.isFinite(v)) lastV = v;
    d += Number.isFinite(lastV) ? lastV / 3.6 / h.rate : 0;
    const g = h.gear[i];
    if (!Number.isFinite(v) || v < 60 || !(g >= 1 && g < gb.k.length) || h.conf[i] < 0.5) continue;
    const pos = (((place.offset + d) % lib.length) + lib.length) % lib.length;
    by[g].push(lib.v[Math.floor(pos / lib.step) % N] / v);
  }
  const f = by.map((x) => (x.length >= 100 ? Math.min(1.15, Math.max(0.85, median(x))) : 1));
  for (let g = 1; g < gb.k.length; g++) gb.k[g] *= f[g];
  for (let i = 0; i < n; i++) { const g = h.gear[i]; if (g >= 1 && g < f.length && Number.isFinite(speed[i])) speed[i] *= f[g]; }
}

/** the lap from the run's own repetition: the speed's or the revs', whichever repeats more clearly; null when no lap shows
 *  (see the vote below). `known`: the gearbox is known, so the speed is worth trying as well as the revs */
export function findLap(speed: Float32Array, logRpm: Float32Array, rate: number, known: boolean): { time: number; conf: number; on: 'speed' | 'revs' } | null {
  type Found = NonNullable<ReturnType<typeof period>> & { on: 'speed' | 'revs' };
  let found: Found | null = null;
  const heardRepeats: Found[] = [];
  for (const on of known ? (['speed', 'revs'] as const) : (['revs'] as const)) {
    const trace0 = on === 'speed' ? speed : logRpm, M = trace0.length;
    const w0 = period(trace0, rate, 30, 900, VOTE.floor);
    if (w0 && w0.conf >= 0.4 && (!found || w0.conf > found.conf)) found = { ...w0, on };
    if (w0) heardRepeats.push({ ...w0, on });
    if (M > 600 * rate) for (let a = 0; a + 0.4 * M <= M + 1; a += Math.round(0.2 * M)) {
      const w = period(trace0.subarray(a, Math.min(M, a + Math.round(0.4 * M))), rate, 30, 900, VOTE.floor);
      if (w) heardRepeats.push({ ...w, on });
      if (w && w.conf >= 0.4 && (!found || w.conf > found.conf)) found = { ...w, on };
    }
  }
  // a real race's laps vary (traffic, cautions, a gear read wrong), so its stretches repeat at 0.3 to 0.7, not the 0.98 of a
  // synthetic lap; but they repeat on the same lap time, or on two or three of them (a stretch that locks on two laps), where
  // a part of a lap that resembles another part (the revs' 30 s or so) does not. So each stretch of the speed and of the revs
  // votes for a lap of P if it repeats on P, 2P or 3P (within 2 %); the lap is the P of 60 s or more with the most votes, if it
  // has four (the shortest P that has them). Against the HUD's laps: 11 of 12 streamed ACC recordings and 10 of 11 PS5 captures found, none wrong (the old rule, three stretches
  // at 0.6 agreeing, found none of the streamed ones)
  let agreed: Found | null = null;
  for (const c of heardRepeats) {
    if (c.time < 60) continue;
    const sup = heardRepeats.filter((w) => [1, 2, 3].some((k) => Math.abs(w.time / (k * c.time) - 1) < 0.02));
    if (sup.length < VOTE.need) continue;
    // the shortest such lap: two laps (or three) always gather the votes of the lap itself, so the most votes can fall on them
    if (!agreed || c.time < agreed.time * 0.98) {
      const ones = sup.filter((w) => Math.abs(w.time / c.time - 1) < 0.02);
      agreed = { time: ones.reduce((x, w) => x + w.time, 0) / ones.length, conf: Math.min(...sup.map((w) => w.conf)), on: c.on };
    }
  }
  // a stretch that repeats at 0.8 or more is a lap on its own, unless it repeats on two or three of the voted laps
  if (found && found.conf >= 0.8 && !(agreed && [2, 3].some((k) => Math.abs(found!.time / (k * agreed!.time) - 1) < 0.02))) return found;
  return agreed;
}

export function reconstruct(frames: EngineFrame[], shifts: ShiftEvent[], car: CarProfile, library: TrackDef[] = [], step = 10): Reconstruction {
  const heard = resample(frames, 10), gb = gearbox(heard, shifts, car);
  // without the profile's ratios, the gear count is the analyser's own and can slip at a missed shift: decide it again
  const counted = Float32Array.from(heard.gear);
  if (gb.source === 'physics') heard.gear = regear(heard, shifts, gb, car);
  else if (gb.source === 'ratios') heard.gear = gearByContinuity(heard, gb, car, shifts);
  let speed = speedOf(heard, gb, shifts);
  if (gb.source === 'none') {
    // no gearbox to be had (no ratios, too few gears counted): the speed carried through the shifts, if physics can anchor it
    const seg = segmentSpeed(heard, shifts, car);
    if (seg) { speed = seg; gb.source = 'segments'; }
  }
  // where it is, before any lap: and when the circuit is clear (well ahead of the next), the speed worked out from physics
  // takes the scale that fits it, so the circuit calibrates the car's power, mass and drag
  const place = gb.source !== 'none' && library.length ? locate(speed, heard.rate, heard.t0, library) : null;
  const calibrate = !!place && (gb.source === 'physics' || gb.source === 'segments') && place.corr >= 0.55 && place.corr - (place.runnerUp?.corr ?? 0) >= 0.15 && Math.abs(place.scale - 1) > 0.015;
  if (place) place.applied = calibrate;
  if (calibrate && place) {
    for (let i = 0; i < speed.length; i++) speed[i] *= place.scale;
    for (let g = 1; g < gb.k.length; g++) gb.k[g] *= place.scale;
    const lib = library.find((t) => t.key === place.key);
    if (gb.source === 'physics' && lib) gearsFromCircuit(heard, speed, gb, place, lib);
  }
  const n = speed.length, dist = new Float64Array(n);
  // distance runs on through any gap at the speeds either side of it
  let lastV = NaN;
  for (let i = 1; i < n; i++) {
    if (Number.isFinite(speed[i])) lastV = speed[i];
    let next = NaN;
    if (!Number.isFinite(speed[i])) for (let j = i + 1; j < n && j < i + 600; j++) if (Number.isFinite(speed[j])) { next = speed[j]; break; }
    const vi = Number.isFinite(speed[i]) ? speed[i] : Number.isFinite(lastV) && Number.isFinite(next) ? (lastV + next) / 2 : Number.isFinite(lastV) ? lastV : next;
    dist[i] = dist[i - 1] + (Number.isFinite(vi) ? vi / 3.6 / heard.rate : 0);
  }
  // the lap: the repeat of the speed trace or of the revs, whichever repeats more clearly. Speed worked out from physics without
  // the ratios wanders from lap to lap (a V8 at Monza: 0.65), where the revs repeat cleanly (0.87)
  const known = gb.source !== 'none';
  const logRpm = heard.rpm.map((x) => (x > 0 ? Math.log(x) : NaN));
  // a lap repeats almost exactly (0.98 on the synthetic laps); part of a lap that resembles another part repeats far less
  // (never above 0.71 on Monza, Spa and Zandvoort), and is not a lap. Real laps vary more, so the bar is 0.8.
  // the whole run, and stretches of it (two fifths, a fifth apart): a long run with a disturbed lap in it (a Code 60 zone, a
  // pit stop, a driver who shifts differently) repeats less as a whole than its clean stretches do
  const per = findLap(speed, logRpm, heard.rate, known);
  let lap: Reconstruction['lap'] = null, profile: Reconstruction['profile'] = null, corners: HeardCorner[] = [], matches: TrackMatch[] = [], sk: Reconstruction['sketch'] = null;
  if (per && known) {
    // start the laps once the speed has been known, and the engine sure, for three seconds running (before that, while the
    // tracker locks, the speed is bridged across gaps and the profile would carry a guess)
    let start = 0, run = 0;
    for (let i = 0; i < n; i++) {
      run = Number.isFinite(speed[i]) && heard.conf[i] > 0.5 ? run + 1 : 0;
      if (run >= 3 * heard.rate) { start = i - run + 1; break; }
    }
    const p = lapProfile(speed, dist, heard.rate, per.time, start, step);
    lap = { time: per.time, length: p.length, conf: per.conf, start: heard.t0 + start / heard.rate, on: per.on };
    profile = { step: p.length / p.v.length, v: p.v };
    // found on the smoothed profile (so a shift's ripple is not a corner), read on the raw one (an apex is brief)
    corners = cornersOf(smoothClosed(p.v, Math.max(1, Math.round(30 / profile.step))), profile.step, 10);
    const N = p.v.length, w = Math.max(1, Math.round(60 / profile.step));
    for (const c of corners) {
      const a = Math.round(c.apex / profile.step);
      let lo = a;
      for (let d = -w; d <= w; d++) { const i = (((a + d) % N) + N) % N; if (p.v[i] < p.v[((lo % N) + N) % N]) lo = a + d; }
      const i = ((lo % N) + N) % N;
      c.apex = i * profile.step; c.apexKmh = p.v[i]; c.radius = ((p.v[i] / 3.6) ** 2) / (GRIP * G);
    }
    if (library.length) matches = identify(p.v, p.length, per.time, library);
    sk = sketch(p.v, profile.step, corners);
  } else if (per) {
    lap = { time: per.time, length: NaN, conf: per.conf, start: heard.t0, on: per.on };
  }
  return { heard, counted, gearbox: gb, speed, dist, lap, profile, corners, matches, place, sketch: sk };
}
