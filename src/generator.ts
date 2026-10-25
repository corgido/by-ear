// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// A race car's onboard sound with a known answer, for src/engine.ts. A small lap simulation drives a point-mass car
// round a list of corners: full power until the braking envelope of the next corner (or a lift for a fast kink), upshifts at
// the shift point (one exit held to the limiter), sequential downshifts with throttle blips under braking. That gives the true
// rpm, gear, throttle state, shifts, limiter hits and lap times, at 1 kHz. A synthesiser then makes the sound from it: the
// flat-six's orders (multiples of 1.5) shaped by exhaust resonances and the throttle, combustion rasp, overrun crackle, gear
// whine, wind and tyre noise that grow with speed, kerb buzz at some apexes, other cars passing (a V8, with Doppler), and a
// microphone that clips softly. The car is the 'synthetic-flat6' profile (src/cars.ts).

import { carById, firingOrder, powerShare, type CarProfile } from './cars';

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}



/** a corner: the straight before it (m), its apex speed (km/h); 'lift' is taken by lifting off, not braking; 'hold' means the
 *  driver holds the gear to the limiter on the way out */
export interface Corner { len: number; v: number; kind?: 'lift' | 'hold' }

export interface OnboardShift { t: number; dir: 1 | -1; before: number; after: number }

export interface OnboardTruth {
  /** the traces' rate (Hz) */
  rate: number;
  rpm: Float32Array;
  gear: Int8Array;
  /** 0 on, 1 lift, 2 overrun */
  throttle: Uint8Array;
  speed: Float32Array;
  shifts: OnboardShift[];
  /** limiter episodes, s */
  limiter: { t0: number; t1: number }[];
  /** when each lap began (the first at 0) and its length, s */
  lapStarts: number[];
  lapTimes: number[];
  /** when another car is alongside (the middle of each pass), s */
  passes: number[];
  seconds: number;
}

export interface OnboardOptions {
  track?: 'short' | 'nordschleife';
  laps?: number;
  seed?: number;
  /** lap-to-lap variation of corner speeds and shift points (0 = every lap the same) */
  vary?: number;
  /** add other cars passing (default true) */
  traffic?: boolean;
  /** drive a lap first and start from the second, so the run begins at speed and loops without a jump */
  warmup?: boolean;
  /** the car (a profile with gear ratios, final drive and tyre size: 'synthetic-flat6' by default) */
  car?: string;
  /** neutralisations: stretches of time (s, from the start) in which the driver holds 60 km/h (a Code 60 zone) */
  code60?: [number, number][];
  /** stints: from a lap on (counted from 0), the driver shifts up at this rpm (a driver change, or an instruction) */
  stints?: { fromLap: number; shiftRpm: number }[];
  /** a circuit of its own, as corners (overrides `track`): see cornersFromProfile in src/track.ts */
  corners?: Corner[];
  /** a real lap's speed every `step` metres (km/h, a library circuit's measured GT3 profile; overrides `corners`): the car
   *  brakes and corners exactly where that lap did and never faster, and accelerates on its own engine. Corners as points
   *  (above) are taken at their apex speed for a metre and left at once, which makes a lap 5 to 6 % faster than a real one */
  profile?: { v: number[]; step: number };
  /** the level of the cycle orders (every multiple of 0.5 that is not one of 1.5), against the firing orders near them (0 = none).
   *  A four-stroke repeats every two revolutions, so a real one sounds at all of them: cylinder-to-cylinder differences, the cams,
   *  the valvetrain. The first real onboard heard (the case study's record, 4.2) had enough of them to pull the tracker to a third of the rpm. */
  cycle?: number;
}

/** a short circuit, about a minute a lap */
const SHORT_TRACK: Corner[] = [
  { len: 380, v: 78 }, { len: 330, v: 135, kind: 'hold' }, { len: 520, v: 215, kind: 'lift' }, { len: 260, v: 98 },
  { len: 640, v: 165 }, { len: 300, v: 118 }, { len: 210, v: 205, kind: 'lift' }, { len: 520, v: 88 },
];

/** a long circuit in the Nordschleife's manner: about 20 km, seventy-odd corners, a long straight before the end (seeded) */
function longTrack(seed: number): Corner[] {
  const r = rng(seed);
  const out: Corner[] = [];
  for (let i = 0; i < 70; i++) {
    const kink = r() < 0.2;
    const len = r() < 0.15 ? 440 + r() * 560 : 110 + r() * 260;
    out.push({ len, v: kink ? 190 + r() * 45 : 75 + r() * 125, kind: kink ? 'lift' : i === 30 ? 'hold' : undefined });
  }
  out.push({ len: 2100, v: 120 });
  return out;
}

const KMH = 1 / 3.6;


/** the lap simulation: the true traces at 1 kHz */
export function simulateOnboard(opts: OnboardOptions = {}, car: CarProfile = carById(opts.car ?? 'synthetic-flat6')): OnboardTruth {
  if (opts.warmup) return fromSecondLap(simulateOnboard({ ...opts, warmup: false, laps: (opts.laps ?? 1) + 1 }, car));
  const laps = opts.laps ?? 1;
  const r = rng(opts.seed ?? 911);
  const vary = opts.vary ?? 0;
  const prof = opts.profile;
  const base = opts.corners ?? (opts.track === 'nordschleife' ? longTrack(17) : SHORT_TRACK);
  const ratios = car.ratios!, fd = car.finalDrive!, circ = car.tyreCircumference!;
  const G = ratios.length;
  const rpmOf = (v: number, g: number) => (v / circ) * 60 * ratios[g - 1] * fd;
  const vOf = (rpm: number, g: number) => (rpm / 60 / (ratios[g - 1] * fd)) * circ;
  const gauss = () => { let s = 0; for (let k = 0; k < 6; k++) s += r(); return (s - 3) / Math.SQRT1_2 / 1.0; };

  // the whole run as one road, a metre at a time: corner speed limits, then the braking envelope (backwards)
  const lapLen = prof ? Math.round(prof.v.length * prof.step) : Math.round(base.reduce((a, c) => a + c.len, 0));
  const total = lapLen * (laps + 1);
  const vcap = new Float32Array(total).fill(1e9);
  const liftCorner = new Uint8Array(total); // a corner taken by lifting
  const kindAt = new Int8Array(total); // the corner ahead: 0 brake, 1 lift
  const holdAt = new Uint8Array(total); // set on the stretch after a 'hold' corner
  let s = 0;
  if (prof) {
    // the measured lap, every metre, a little faster or slower lap by lap
    const N = prof.v.length;
    for (let lap = 0; lap <= laps; lap++) {
      const f = 1 + vary * 0.004 * gauss();
      for (let k = 0; k < lapLen && lap * lapLen + k < total; k++) {
        const x = k / prof.step, j = Math.floor(x) % N, w = x - Math.floor(x);
        vcap[lap * lapLen + k] = (prof.v[j] * (1 - w) + prof.v[(j + 1) % N] * w) * f * KMH;
      }
    }
  }
  for (let lap = 0; lap <= laps && !prof; lap++) {
    for (const c of base) {
      s += Math.round(c.len);
      const v = c.v * (1 + vary * 0.012 * gauss()) * KMH;
      if (s < total) vcap[s] = v;
      if (c.kind === 'hold') for (let k = s; k < Math.min(total, s + 500); k++) holdAt[k] = 1;
      if (c.kind === 'lift') liftCorner[Math.min(total - 1, s)] = 1;
    }
  }
  const vb = new Float32Array(total);
  vb[total - 1] = vcap[total - 1] < 1e8 ? vcap[total - 1] : 90;
  let decel = 14, lift = 0;
  for (let i = total - 2; i >= 0; i--) {
    if (vcap[i + 1] < 1e8) { lift = liftCorner[i + 1]; decel = lift ? 3.2 : 14; }
    kindAt[i] = lift;
    vb[i] = Math.min(vcap[i], Math.sqrt(vb[i + 1] * vb[i + 1] + 2 * decel));
  }

  // the drive, a millisecond at a time
  const dt = 0.001, rate = 1000;
  const cap = Math.ceil((lapLen * laps) / 25 / dt);
  const rpmT = new Float32Array(cap), gearT = new Int8Array(cap), thrT = new Uint8Array(cap), spdT = new Float32Array(cap);
  const shifts: OnboardShift[] = [], limiter: { t0: number; t1: number }[] = [], lapStarts = [0];
  let v = 125 * KMH, g = 1, pos = 0, i = 0;
  // the driver's rpms, from the car's shift point: upshift at it, come down a gear when the lower gear is under 90 % of it,
  // and never lug below 40 % of it
  const SP = car.shiftLights.to;
  while (g < G && rpmOf(v, g) > 0.89 * SP) g++;
  let shift: { from: number; to: number; t0: number; dur: number; before: number } | null = null;
  let lastShift = -1, atLimit = 0, held = false, limT0 = -1, shiftAt = SP;
  const mass = car.massKg ?? 1300, power = (car.powerKw ?? 390) * 1000, cda = car.cda ?? 1.15, trac = 11.5, roll = car.rollingN ?? 180;
  while (pos < lapLen * laps && i < cap) {
    const t = i * dt;
    const m = Math.min(total - 1, Math.floor(pos));
    if (holdAt[m] === 0) held = false;
    const rpmNow = rpmOf(v, g);
    // the driver's power: full, except while an upshift cuts it
    const cut = shift && shift.to > shift.from && (t - shift.t0) < shift.dur * 0.7;
    const drag = (0.5 * 1.2 * cda * v * v + roll) / mass;
    const a = cut ? -drag : Math.min(trac, (power * powerShare(car, rpmNow)) / (mass * Math.max(v, 5))) - drag;
    let vn = v + a * dt;
    // the limiter caps the engine, and so the car, in this gear
    const vLim = vOf(car.limiterRpm, g);
    if (!shift && vn >= vLim) { vn = vLim; atLimit += dt; if (limT0 < 0) limT0 = t; } else if (limT0 >= 0 && (shift || vn < vLim * 0.995)) { limiter.push({ t0: limT0, t1: t }); limT0 = -1; atLimit = 0; }
    let thr = 0;
    const env = vb[Math.min(total - 1, Math.floor(pos + vn * dt))];
    if (vn > env) {
      vn = Math.max(env, v - 16 * dt);
      if (prof) {
        // under the measured lap: holding its speed through an arc is part throttle (read as on), easing off is a lift,
        // slowing harder is the brakes
        const ap = (vcap[Math.min(total - 1, m + 1)] ** 2 - vcap[m] ** 2) / 2;
        thr = ap > -0.6 ? 0 : ap > -4 ? 1 : 2;
      } else thr = kindAt[m] ? 1 : 2;
    }
    // a Code 60 zone: down to 60 km/h at a steady 6 m/s², then held there
    if (opts.code60?.some(([a, b]) => t >= a && t < b) && vn > 60 * KMH) {
      if (v > 60 * KMH + 0.3) { vn = Math.max(60 * KMH, v - 6 * dt); thr = 2; } else vn = 60 * KMH;
    }
    v = vn;
    pos += v * dt;
    // gears
    if (shift && t - shift.t0 >= shift.dur) {
      g = shift.to;
      shifts.push({ t: shift.t0 + shift.dur / 2, dir: shift.to > shift.from ? 1 : -1, before: shift.before, after: rpmOf(v, g) });
      shift = null;
      const stint = opts.stints?.filter((x) => x.fromLap <= lapStarts.length - 1).pop();
      shiftAt = (stint?.shiftRpm ?? SP) + vary * 60 * gauss();
    }
    if (!shift) {
      const hold = holdAt[m] && !held;
      if (thr === 0 && g < G && ((!hold && rpmOf(v, g) >= shiftAt) || (hold && atLimit >= 0.4))) {
        if (hold) held = true;
        shift = { from: g, to: g + 1, t0: t, dur: 0.07 + 0.04 * r(), before: rpmOf(v, g) };
      } else if (thr === 2 && g > 1 && rpmOf(v, g - 1) <= 0.9 * SP && t - lastShift > 0.32) {
        shift = { from: g, to: g - 1, t0: t, dur: 0.14 + 0.04 * r(), before: rpmOf(v, g) };
      } else if (g > 1 && rpmOf(v, g) < 0.4 * SP && t - lastShift > 0.3) {
        shift = { from: g, to: g - 1, t0: t, dur: 0.15, before: rpmOf(v, g) };
      }
      if (shift) lastShift = t;
    }
    // the true rpm: through a shift it moves from one gear's to the other's (a downshift with a blip over the top)
    let rpm = rpmOf(v, g);
    if (shift) {
      const tau = Math.min(1, (t - shift.t0) / shift.dur), sm = tau * tau * (3 - 2 * tau);
      rpm = rpmOf(v, shift.from) * (1 - sm) + rpmOf(v, shift.to) * sm;
      if (shift.to < shift.from) rpm *= 1 + 0.045 * Math.sin(Math.PI * tau);
    } else if (limT0 >= 0) {
      const saw = (t * 13) % 1;
      rpm = car.limiterRpm * (1 - 0.022 * (saw < 0.3 ? saw / 0.3 : (1 - saw) / 0.7));
    }
    rpmT[i] = rpm; gearT[i] = g; thrT[i] = thr; spdT[i] = v / KMH;
    i++;
    if (pos >= lapLen * lapStarts.length) lapStarts.push(i * dt);
  }
  if (limT0 >= 0) limiter.push({ t0: limT0, t1: i * dt });
  const seconds = i * dt;
  const starts = lapStarts.filter((x) => x < seconds - 1e-6);
  const lapTimes = starts.map((x, k) => (k + 1 < lapStarts.length ? lapStarts[k + 1] : seconds) - x);
  // other cars: two or three a lap, at random moments
  const passes: number[] = [];
  if (opts.traffic !== false) for (const st of starts) { const n = 2 + Math.floor(r() * 2); for (let k = 0; k < n; k++) passes.push(st + (0.1 + 0.8 * r()) * lapTimes[0]); }
  return { rate, rpm: rpmT.subarray(0, i), gear: gearT.subarray(0, i), throttle: thrT.subarray(0, i), speed: spdT.subarray(0, i), shifts, limiter, lapStarts: starts, lapTimes, passes: passes.sort((a, b) => a - b), seconds };
}

/** a run without its first lap: every time moves back by the first lap's length */
function fromSecondLap(tr: OnboardTruth): OnboardTruth {
  const t0 = tr.lapStarts[1], i0 = Math.round(t0 * tr.rate);
  const shiftT = <T extends { t: number }>(xs: T[]) => xs.filter((x) => x.t >= t0).map((x) => ({ ...x, t: x.t - t0 }));
  return {
    rate: tr.rate, rpm: tr.rpm.subarray(i0), gear: tr.gear.subarray(i0), throttle: tr.throttle.subarray(i0), speed: tr.speed.subarray(i0),
    shifts: shiftT(tr.shifts), limiter: tr.limiter.filter((l) => l.t0 >= t0).map((l) => ({ t0: l.t0 - t0, t1: l.t1 - t0 })),
    lapStarts: tr.lapStarts.slice(1).map((x) => x - t0), lapTimes: tr.lapTimes.slice(1),
    passes: tr.passes.filter((p) => p >= t0).map((p) => p - t0), seconds: tr.seconds - t0,
  };
}

/** the truth at a moment (linear between the 1 kHz points) */
export function truthAt(tr: OnboardTruth, t: number): { rpm: number; gear: number; throttle: number; speed: number } {
  const x = Math.max(0, Math.min(tr.rpm.length - 1.001, t * tr.rate));
  const i = Math.floor(x), f = x - i;
  return { rpm: tr.rpm[i] * (1 - f) + tr.rpm[i + 1] * f, gear: tr.gear[Math.round(x)], throttle: tr.throttle[Math.round(x)], speed: tr.speed[i] };
}

/** exhaust and intake resonances: how loud an order is at a frequency */
const formant = (f: number): number => 0.3 + 1.6 / (1 + ((f - 190) / 70) ** 2) + 1.1 / (1 + ((f - 680) / 160) ** 2) + 0.7 / (1 + ((f - 1900) / 450) ** 2);

/** the onboard sound, made a block at a time (a 24-minute run never has to sit in memory) */
export class OnboardSynth {
  readonly truth: OnboardTruth;
  readonly length: number;
  private n = 0;
  private r: () => number;
  private phi = 0; private psi = 0; private kerbPh = 0;
  private thr = 1;
  private amp = new Float32Array(17);
  private camp = new Float32Array(49);
  private chi = 0;
  private readonly cycle: number;
  private wobble = new Float32Array(17);
  private wl = 0; private wr = 0; private ty1 = 0; private ty2 = 0; private pop = 0;
  /** per millisecond: the cut gate (upshifts and the limiter), whether a kerb is under the car (its start, s), which pass is near */
  private gate: Float32Array;
  private kerb: Float32Array;
  private pass: Int16Array;
  /** the car's half firing order (1.5 for a six, 2 for a V8, 2.5 for a V10), how many half-orders that is, and its shift point */
  private unit: number;
  private hk: number;
  private sp: number;
  constructor(readonly sr: number, opts: OnboardOptions = {}) {
    const car = carById(opts.car ?? 'synthetic-flat6');
    const tr = (this.truth = simulateOnboard(opts, car));
    this.unit = firingOrder(car) / 2;
    this.hk = Math.round(this.unit * 2);
    this.sp = car.shiftLights.to;
    this.cycle = opts.cycle ?? 0;
    this.length = Math.floor(tr.seconds * sr);
    this.r = rng((opts.seed ?? 911) * 7 + 3);
    const n = tr.rpm.length, ms = (t: number) => Math.max(0, Math.min(n - 1, Math.round(t * tr.rate)));
    this.gate = new Float32Array(n).fill(1);
    for (const s of tr.shifts) if (s.dir > 0) for (let i = ms(s.t - 0.05); i <= ms(s.t + 0.02); i++) this.gate[i] = 0.3;
    for (const l of tr.limiter) for (let i = ms(l.t0); i <= ms(l.t1); i++) if (((i / tr.rate) * 13) % 1 < 0.3) this.gate[i] = 0.25;
    // kerbs: at about a third of the apexes (where braking turns to power), about half a second each
    this.kerb = new Float32Array(n).fill(-1);
    for (let i = 1; i < n; i++) {
      if (tr.throttle[i - 1] === 2 && tr.throttle[i] === 0 && this.r() < 0.4) {
        const t0 = i / tr.rate - 0.1;
        for (let k = ms(t0); k <= ms(t0 + 0.45); k++) this.kerb[k] = t0;
      }
    }
    this.pass = new Int16Array(n).fill(-1);
    tr.passes.forEach((p, j) => { for (let k = ms(p - 2.5); k <= ms(p + 2.5); k++) this.pass[k] = j; });
    this.wobble.fill(1);
  }

  /** fill the next block; returns how many samples were written (0 at the end) */
  fill(L: Float32Array, R: Float32Array): number {
    const { sr, truth: tr, r } = this;
    const n = Math.min(L.length, this.length - this.n);
    const TAU2 = Math.PI * 2;
    for (let j = 0; j < n; j++, this.n++) {
      const t = this.n / sr;
      const x = t * tr.rate, i = Math.min(tr.rpm.length - 2, Math.floor(x)), f = x - i;
      const rpm = tr.rpm[i] * (1 - f) + tr.rpm[i + 1] * f;
      const th = tr.throttle[i], v = tr.speed[i], gate = this.gate[i];
      // every 64 samples: the throttle's smoothing and each order's level
      if ((this.n & 63) === 0) {
        this.thr += ((th === 0 ? 1 : 0) - this.thr) * (1 - Math.exp(-64 / sr / 0.03));
        const f0 = (this.unit * rpm) / 60, lvl = Math.pow(Math.max(rpm, 1000) / this.sp, 0.7);
        for (let m = 1; m <= 16; m++) {
          this.wobble[m] = Math.max(0.5, Math.min(1.6, this.wobble[m] * Math.exp(0.02 * (r() * 2 - 1))));
          const on = (m % 2 === 0 ? 1 : 0.55) * Math.pow(m, -0.55);
          const off = 0.22 * (m % 2 === 0 ? 1 : 0.7) * Math.pow(m, -1.1);
          this.amp[m] = m * f0 < sr * 0.45 ? lvl * (this.thr * on + (1 - this.thr) * off) * formant(m * f0) * this.wobble[m] : 0;
        }
        // the cycle orders (k / 2 for k not a multiple of the half firing order's), as loud as the firing orders' trend near
        // them, times `cycle`
        if (this.cycle > 0) for (let k = 1; k <= 48; k++) {
          if (k % this.hk === 0) continue;
          const m = k / this.hk, fk = (k * rpm) / 120;
          this.camp[k] = fk < sr * 0.45 ? this.cycle * lvl * (this.thr * 0.7 + 0.2) * Math.pow(Math.max(m, 0.5), -0.55) * formant(fk) * this.wobble[Math.min(16, Math.max(1, Math.round(m)))] : 0;
        }
      }
      // the engine: every multiple of half its firing order (1.5 … 24 for a flat-six), by the recursion
      // sin(mφ) = 2cos φ sin((m−1)φ) − sin((m−2)φ)
      this.phi += (TAU2 * this.unit * rpm) / 60 / sr;
      if (this.phi > TAU2) this.phi -= TAU2;
      const c = Math.cos(this.phi);
      let s0 = 0, s1 = Math.sin(this.phi), eng = this.amp[1] * s1;
      for (let m = 2; m <= 16; m++) { const s2 = 2 * c * s1 - s0; eng += this.amp[m] * s2; s0 = s1; s1 = s2; }
      // the cycle orders, from the half-order phase (one turn every two revolutions)
      if (this.cycle > 0) {
        this.chi += (TAU2 * 0.5 * rpm) / 60 / sr;
        if (this.chi > TAU2) this.chi -= TAU2;
        const cc = Math.cos(this.chi);
        let u0 = 0, u1 = Math.sin(this.chi), cyc = this.camp[1] * u1;
        for (let k = 2; k <= 48; k++) { const u2 = 2 * cc * u1 - u0; if (k % this.hk) cyc += this.camp[k] * u2; u0 = u1; u1 = u2; }
        eng += cyc;
      }
      // combustion rasp: noise pulsed at the firing rate
      const fire = 0.5 + 0.5 * Math.cos(2 * this.phi);
      eng = gate * (eng + (r() * 2 - 1) * 0.12 * (0.3 + this.thr) * fire * fire);
      // overrun crackle
      if (th === 2 && r() < 9 / sr) this.pop = 0.5 + 0.5 * r();
      if (this.pop > 0.002) { eng += this.pop * (r() * 2 - 1); this.pop *= Math.exp(-1 / (0.006 * sr)); }
      // gear whine (straight-cut gears, at a mesh order that is not one of the engine's)
      eng += 0.02 * (v / 250) * Math.sin(this.phi * (28.3 / this.unit));
      // wind (low, and different each side) and tyres, both growing with speed
      const wv = (v / 260) ** 2;
      this.wl += (r() * 2 - 1 - this.wl) * 0.06; this.wr += (r() * 2 - 1 - this.wr) * 0.06;
      const tw = r() * 2 - 1;
      this.ty1 += (tw - this.ty1) * 0.12; this.ty2 += (this.ty1 - this.ty2) * 0.12;
      const tyre = (tw - this.ty2) * 0.06 * (v / 250);
      let extra = 0;
      // a kerb: a buzz at the speed over 0.3 m serrations, and a thump
      const k0 = this.kerb[i];
      if (k0 >= 0) {
        this.kerbPh = (this.kerbPh + (v * KMH) / 0.3 / sr) % 1;
        extra += 0.55 * (this.kerbPh < 0.12 ? 1 - this.kerbPh / 0.12 : 0) - 0.066;
        extra += 0.4 * Math.exp(-(t - k0) * 25) * Math.sin(TAU2 * 45 * (t - k0));
      }
      // another car passing: a V8 (orders 2, 4, 6, 8 …) rising through its gear, Doppler-shifted
      const pj = this.pass[i];
      if (pj >= 0) {
        const p = tr.passes[pj], d = t - p;
        const near = 1 / (1 + (d / 0.6) ** 2);
        const prpm = 6400 + (900 * (d + 2.5)) / 5 + 500 * Math.sin(p);
        const dop = 1 + 0.045 * Math.tanh(-d / 0.5);
        this.psi += (TAU2 * 2 * prpm * dop) / 60 / sr;
        if (this.psi > TAU2) this.psi -= TAU2;
        const cp = Math.cos(this.psi);
        let q0 = 0, q1 = Math.sin(this.psi), o = 0.5 * q1;
        for (let m = 2; m <= 8; m++) { const q2 = 2 * cp * q1 - q0; o += q2 * (m % 2 === 0 ? 1 : 0.5) / Math.sqrt(m); q0 = q1; q1 = q2; }
        extra += 0.12 * near * o;
      }
      const base = 0.33 * eng + 0.33 * extra + tyre;
      L[j] = Math.tanh(1.4 * (base + 0.5 * wv * this.wl)) / 1.4;
      R[j] = Math.tanh(1.4 * (base + 0.5 * wv * this.wr)) / 1.4;
    }
    return n;
  }
}

/** the whole run at once (for short runs) */
export function renderOnboard(sr: number, opts: OnboardOptions = {}): { L: Float32Array; R: Float32Array; truth: OnboardTruth } {
  const syn = new OnboardSynth(sr, opts);
  const L = new Float32Array(syn.length), R = new Float32Array(syn.length);
  syn.fill(L, R);
  return { L, R, truth: syn.truth };
}
