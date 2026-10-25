// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// The engine analyser: a race car's telemetry read from its engine sound alone. Pure and streaming: push mono (or stereo)
// blocks in, read frames, events and scalars out. The same code runs in a browser, on the command line (src/cli.ts) and in the
// tests. Everything car-specific comes from a CarProfile (src/cars.ts).
//
// How it reads rpm:
//   1. the sound is filtered and decimated to about 12 kHz, cut into 85 ms windows every 21 ms, and each window's spectrum is
//      "whitened": its level in dB above a smooth floor, so a peak counts by how much it stands out, not by how loud the mix is;
//   2. for every candidate rpm on a log grid (0.5 % steps across the car's range) a comb averages that whitened spectrum at every
//      multiple of half the firing order (for a flat-six: 1.5, 3, 4.5, 6 …, the firing order's own multiples weighted most) up
//      to a fixed top frequency, and subtracts it at the points half-way between them. Every candidate is judged over the same
//      band, so half the true rpm has twice the teeth and half of them on nothing, and double the rpm finds the true half-orders
//      sitting on its in-between points: octave and order errors score lower than the truth, as long as the microphone hears
//      some half-orders (onboard it always does);
//   3. a Viterbi tracker joins the frames into one path: within a gear the rpm may only slew (bounded by the car's maxSlew, with
//      a small cost for moving), an upshift may drop it by the car's ratio step in one go, a downshift raise it by the inverse,
//      each at a fixed cost, and any other jump (an octave, a lock onto another car) costs far more. The path is decided with a
//      fixed lag (a quarter of a second by default), so a shift is judged with what follows it in view.
// Everything else is read off that path: the rate, shifts (a drop or rise of a ratio step within a fifth of a second), the gear
// (shifts counted, placed absolutely by the profile's ratios when it has them, otherwise from the lowest gear heard), throttle
// (the orders' level against what this rpm sounds like on power, and their brightness), limiter hits, and the lap (the rpm
// trace's period, by autocorrelation over the last minutes).

import { FFT } from './fft';
import { firingOrder, speedKmh, type CarProfile } from './cars';

export interface EngineOptions {
  /** the rate the analysis runs at, after decimation (Hz) */
  rate: number;
  /** the analysis window (samples at `rate`) and its zero-padded FFT size */
  window: number;
  fft: number;
  /** frames every `hop` samples at `rate` */
  hop: number;
  /** a second, longer window for low rpm: there the half-orders are too close together for the short one to tell apart (at
   *  3,000 rpm they are 25 Hz apart), and double the rpm reads as well as the truth. Below `longFull` rpm the comb reads only the
   *  long window's spectrum, above `longFrom` only the short one's, and in between a blend */
  windowLong: number;
  fftLong: number;
  longFull: number;
  longFrom: number;
  /** the highest frequency the comb reads (Hz) */
  fmax: number;
  /** the rpm grid's step, as a fraction */
  step: number;
  /** the decision lag (s): how far ahead the tracker looks before it commits */
  lag: number;
  /** the tracker's costs, in dB·frames of evidence: a shift-like jump, any other jump, and moving at full slew */
  shiftCost: number;
  jumpCost: number;
  slewCost: number;
  /** how much a comb's in-between points count against it (0..1) */
  antiWeight: number;
  /** the shortest and longest lap the lap finder looks for (s), and how often it looks */
  lapMin: number;
  lapMax: number;
  lapEvery: number;
}

export const ENGINE_DEFAULTS: EngineOptions = {
  rate: 12000, window: 1024, fft: 2048, hop: 256, windowLong: 2048, fftLong: 4096, longFull: 3700, longFrom: 5200,
  fmax: 3000, step: 0.005, lag: 0.25,
  shiftCost: 6, jumpCost: 30, slewCost: 1.5, antiWeight: 0.8,
  lapMin: 30, lapMax: 900, lapEvery: 5,
};

export const THROTTLE = ['on', 'lift', 'overrun'] as const;

/** the voice print's orders: every half-order up to the 15th */
export const SIGNATURE_ORDERS = 30;

export interface EngineFrame {
  /** the moment the frame describes (s, stream time) */
  t: number;
  rpm: number;
  /** 0..1: how sure the reading is that this is an engine at this rpm */
  conf: number;
  /** rpm per second */
  rate: number;
  /** NaN until a shift has been heard */
  gear: number;
  /** 0 on, 1 lift, 2 overrun */
  throttle: number;
  /** the engine orders' level, dBFS */
  level: number;
  limiter: boolean;
}

export interface ShiftEvent { t: number; dir: 1 | -1; before: number; after: number; /** the gear after it (NaN when unknown) */ gear: number }
export interface LimiterHit { t: number; rpm: number }

export interface EngineOutput {
  /** the newest frame's time */
  t: number;
  frames: EngineFrame[];
  shifts: ShiftEvent[];
  limiter: LimiterHit[];
  /** the upshift ratios (after / before) per transition, 1→2 first: the profile's, or learned (NaN where none is known yet) */
  steps: number[];
  scalars: Record<string, number>;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** a low-pass FIR (windowed sinc, Blackman) for decimating by d */
function lowpass(d: number): Float32Array {
  const taps = 12 * d - 1, fc = 0.42 / d, h = new Float32Array(taps), m = (taps - 1) / 2;
  let s = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w; s += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= s;
  return h;
}

/** for each p, the max of src over [p, p + w) and where it is (src padded with -Infinity beyond its ends) */
function windowMax(src: Float64Array, w: number, val: Float64Array, idx: Int32Array, dq: Int32Array): void {
  const n = src.length;
  let head = 0, tail = 0;
  // sweep from the right so window [p, p+w) is ready when p is reached
  for (let p = n - 1; p >= 0; p--) {
    while (tail > head && src[dq[tail - 1]] <= src[p]) tail--;
    dq[tail++] = p;
    while (dq[head] >= p + w) head++;
    val[p] = src[dq[head]]; idx[p] = dq[head];
  }
}

/** one window's view of the sound: its spectrum in dB, that spectrum whitened (dB above a smooth floor), and the whitened
 *  spectrum read off at the comb's log-frequency points */
class Spectrum {
  readonly binHz: number;
  readonly nb: number;
  readonly db: Float32Array;
  readonly wsp: Float32Array;
  readonly logBin: Float32Array;
  readonly plog: Float32Array;
  private fft: FFT;
  private re: Float64Array;
  private im: Float64Array;
  private win: Float64Array;
  private tmpA: Float32Array;
  private tmpB: Float32Array;

  constructor(readonly n: number, size: number, fs: number, fu0: number, lg: number, Q: number) {
    this.fft = new FFT(size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    this.binHz = fs / size;
    this.nb = size / 2 + 1;
    this.db = new Float32Array(this.nb);
    this.wsp = new Float32Array(this.nb);
    this.tmpA = new Float32Array(this.nb);
    this.tmpB = new Float32Array(this.nb);
    this.logBin = new Float32Array(Q);
    for (let q = 0; q < Q; q++) this.logBin[q] = (fu0 * Math.exp(q * lg)) / this.binHz;
    this.plog = new Float32Array(Q);
  }

  /** the newest n samples of a ring (`bw` is where the next sample will go) */
  read(ring: Float32Array, bw: number): void {
    const n = this.n, R = ring.length, re = this.re, im = this.im, start = (bw - n + R) % R;
    for (let i = 0; i < n; i++) { re[i] = ring[(start + i) % R] * this.win[i]; im[i] = 0; }
    re.fill(0, n); im.fill(0, n);
    this.fft.transform(re, im);
    const nb = this.nb, db = this.db, scale = 4 / (n * n);
    for (let k = 0; k < nb; k++) db[k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) * scale + 1e-14);
    this.whiten();
    const lb = this.logBin, pl = this.plog, Q = pl.length, nb1 = nb - 2, P = this.wsp;
    for (let q = 0; q < Q; q++) {
      const x = lb[q], i = x | 0, f = x - i;
      pl[q] = i < nb1 ? P[i] * (1 - f) + P[i + 1] * f : 0;
    }
  }

  /** the spectrum in dB above a smooth floor (two passes of a moving average, the second with the peaks clipped off) */
  private whiten(): void {
    const db = this.db, nb = this.nb, out = this.wsp;
    const W = Math.max(3, Math.round(70 / this.binHz));
    const avg = (src: Float32Array, dst: Float32Array) => {
      let s = 0, c = 0;
      for (let k = 0; k < Math.min(nb, W + 1); k++) { s += src[k]; c++; }
      for (let k = 0; k < nb; k++) {
        dst[k] = s / c;
        const add = k + W + 1, drop = k - W;
        if (add < nb) { s += src[add]; c++; }
        if (drop >= 0) { s -= src[drop]; c--; }
      }
    };
    const a = this.tmpA, b = this.tmpB;
    avg(db, a);
    for (let k = 0; k < nb; k++) b[k] = Math.min(db[k], a[k]);
    avg(b, a);
    for (let k = 0; k < nb; k++) { const v = db[k] - a[k] - 2; out[k] = v < 0 ? 0 : v > 30 ? 30 : v; }
  }
}

export class EngineAnalyser {
  readonly sr: number;
  readonly car: CarProfile;
  readonly opts: EngineOptions;
  /** seconds from a sample going in to the frame describing it coming out (the render feeds ahead by this much) */
  readonly latency: number;
  private dec: number;
  private fs: number;
  private h: Float32Array;
  private tail: Float32Array; // the last taps-1 input samples
  private work = new Float32Array(0);
  private firstOut: number; // where in the next block the next decimated sample falls
  private buf: Float32Array; // decimated samples (a ring of the longer window)
  private bw = 0;
  private decCount = 0;
  private sinceHop = 0;
  /** the short window, and the long one for low rpm (see EngineOptions.windowLong) */
  private S: Spectrum;
  private SL: Spectrum;
  /** per rpm on the grid, how much the long window's spectrum counts (0..1) */
  private longW: Float32Array;
  private acc: Float32Array[];
  // the rpm grid and its comb
  readonly gridRpm: Float32Array;
  private N: number;
  /** the comb on a log-frequency axis with the grid's own step: tooth m of every rpm is the same shift along it, so each tooth
   *  (and each in-between point) is one offset and weight, summed over all rpms at once */
  private teethOff: Int32Array;
  private teethFrac: Float32Array;
  private teethW: Float32Array;
  private combNorm: Float32Array;
  /** the cycle orders' teeth: which are which, their own average, and how much they add (see comb) */
  private teethCycle: Uint8Array;
  private cycNorm: Float32Array;
  private bankNorm: Float32Array;
  /** three times the rpm, in grid steps */
  private third: number;
  private cycleWeight: number;
  /** half the firing order, and the cycle's own order (0.5 for a four-stroke) */
  private unit: number;
  private base: number;
  // the tracker
  private delta: Float64Array;
  private next: Float64Array;
  private slew: number;
  private upLo: number;
  private upHi: number;
  private wv: Float64Array;
  private wi: Int32Array;
  private dq: Int32Array;
  private padded: Float64Array;
  private L: number;
  private bp: Int16Array[];
  private obsRing: Float32Array[];
  private specRing: Float32Array[];
  private specRingL: Float32Array[];
  private dbRing: Float32Array[];
  private frameNo = 0;
  // what has been committed (decided frames), newest last
  private outT: number[] = [];
  private outRpm: number[] = [];
  private confS = 0;
  /** the share of recent time the rpm was travelling (see commit) */
  private motion = 0.5;
  private lastJumpT = -1e9;
  /** when the rpm last travelled (more than 1.5 % a second between jumps): a flat engine at the top holds its motion so long */
  private lastMoveT = -1e9;
  private rateS = 0;
  // shifts and gears
  private lastShiftT = -1e9;
  private rel = 0;
  private relHist: { t: number; rel: number }[] = [];
  private shiftLog: { t: number; dir: number; relBefore: number; ratio: number }[] = [];
  private offset = NaN;
  private allShifts = 0;
  // throttle
  private refLevel = new Float32Array(40).fill(-200);
  private refBright = new Float32Array(40).fill(-200);
  private thrHist: number[] = [];
  private lastDownT = -1e9;
  // limiter
  private limRun = 0;
  private limOn = false;
  private limHits = 0;
  // lap
  private lapTrace: number[] = [];
  private lapAcc = 0;
  private lapN = 0;
  private lapDropped = 0;
  private lapT0 = NaN;
  private lapNext = 0;
  private lap = { time: NaN, conf: 0 };
  // since the last read
  private pend: EngineOutput;
  private scal: Record<string, number> = {};

  constructor(sr: number, car: CarProfile, opts: Partial<EngineOptions> = {}) {
    this.sr = sr;
    this.car = car;
    const o = (this.opts = { ...ENGINE_DEFAULTS, ...opts });
    this.dec = Math.max(1, Math.round(sr / o.rate));
    this.fs = sr / this.dec;
    this.h = this.dec > 1 ? lowpass(this.dec) : Float32Array.of(1);
    this.tail = new Float32Array(this.h.length - 1);
    this.firstOut = this.dec - 1;
    this.buf = new Float32Array(Math.max(o.window, o.windowLong));

    // the grid and, for each rpm on it, where its comb's teeth and in-between points fall (in bins)
    const lo = Math.log(car.minRpm), hi = Math.log(car.maxRpm);
    this.N = Math.ceil((hi - lo) / Math.log(1 + o.step)) + 1;
    this.gridRpm = new Float32Array(this.N);
    for (let j = 0; j < this.N; j++) this.gridRpm[j] = Math.exp(lo + j * Math.log(1 + o.step));
    this.unit = firingOrder(car) / 2;
    // the cycle's own order: a four-stroke repeats every two revolutions (0.5), a two-stroke every one
    this.base = 2 / car.strokes;
    const top = Math.min(o.fmax, this.fs * 0.45), lg = Math.log(1 + o.step);
    const fu0 = (car.minRpm / 60) * this.base;
    const Q = Math.max(2, Math.floor(Math.log(top / fu0) / lg) + 1);
    this.S = new Spectrum(o.window, o.fft, this.fs, fu0, lg, Q);
    this.SL = new Spectrum(o.windowLong, o.fftLong, this.fs, fu0, lg, Q);
    this.longW = new Float32Array(this.N);
    for (let j = 0; j < this.N; j++) this.longW[j] = clamp01((o.longFrom - this.gridRpm[j]) / Math.max(1, o.longFrom - o.longFull));
    this.acc = Array.from({ length: 8 }, () => new Float32Array(this.N));
    const wOf = (m: number) => (m % 2 === 0 ? 1 : car.halfOrderWeight);
    const cw = car.cycleOrderWeight ?? 1;
    const off: number[] = [], frac: number[] = [], wts: number[] = [], cyc: number[] = [];
    this.combNorm = new Float32Array(this.N);
    this.cycNorm = new Float32Array(this.N);
    this.cycleWeight = cw;
    this.bankNorm = new Float32Array(this.N);
    const tooth = (order: number, w: number, kind: 0 | 1 | 2) => {
      if (order * (fu0 / this.base) >= top) return;
      const at = Math.log(order / this.base) / lg, k = Math.floor(at);
      off.push(k); frac.push(at - k); wts.push(w); cyc.push(kind);
      // the teeth an rpm has inside the band are what it is averaged over; the cycle orders are averaged on their own, and so
      // (as well) are the half-orders between the firing order's multiples
      if (w > 0) for (let j = 0; j < this.N && j + k + 1 < Q; j++) {
        if (kind === 2) this.cycNorm[j] += w; else this.combNorm[j] += w;
        if (kind === 1) this.bankNorm[j] += w;
      }
    };
    const isUnit = (order: number) => Math.abs(order / this.unit - Math.round(order / this.unit)) < 1e-6;
    for (let m = 1; m * this.unit * (fu0 / this.base) < top; m++) {
      tooth(m * this.unit, wOf(m), m % 2 === 0 ? 0 : 1);
      // the point half-way to the next tooth counts against the rpm, unless it is itself a cycle order (for an engine whose
      // half firing order is a whole order, a V8's 2 or a four's 1, half-way is an odd order, where a real engine sounds)
      const mid = (m + 0.5) * this.unit, onGrid = cw > 0 && Math.abs(mid / this.base - Math.round(mid / this.base)) < 1e-6;
      if (!onGrid) tooth(mid, -o.antiWeight * 0.5 * (wOf(m) + wOf(m + 1)), 0);
    }
    if (cw > 0) for (let k = 1; k * this.base * (fu0 / this.base) < top; k++) {
      const order = k * this.base;
      if (!isUnit(order) && !isUnit(order + 0.5 * this.unit)) tooth(order, 1, 2);
    }
    for (let j = 0; j < this.N; j++) {
      this.combNorm[j] = this.combNorm[j] > 0 ? 1 / this.combNorm[j] : 0;
      this.cycNorm[j] = this.cycNorm[j] > 0 ? 1 / this.cycNorm[j] : 0;
      this.bankNorm[j] = this.bankNorm[j] > 0 ? 1 / this.bankNorm[j] : 0;
    }
    this.teethOff = Int32Array.from(off);
    this.teethFrac = Float32Array.from(frac);
    this.teethW = Float32Array.from(wts);
    this.teethCycle = Uint8Array.from(cyc);
    this.third = Math.round(Math.log(3) / Math.log(1 + o.step));

    // the tracker: slew per frame, and the upshift band in grid steps
    const hopS = o.hop / this.fs, lstep = Math.log(1 + o.step);
    this.slew = Math.max(1, Math.ceil((car.maxSlew * hopS) / lstep));
    this.upLo = Math.max(this.slew + 1, Math.floor(Math.log(1 / car.upshiftRatio.max) / lstep));
    this.upHi = Math.ceil(Math.log(1 / car.upshiftRatio.min) / lstep);
    this.delta = new Float64Array(this.N);
    this.next = new Float64Array(this.N);
    this.padded = new Float64Array(this.N + 2 * this.upHi + 2);
    this.wv = new Float64Array(this.padded.length);
    this.wi = new Int32Array(this.padded.length);
    this.dq = new Int32Array(this.padded.length);
    this.L = Math.max(1, Math.round(o.lag / hopS));
    this.bp = Array.from({ length: this.L + 1 }, () => new Int16Array(this.N));
    this.obsRing = Array.from({ length: this.L + 1 }, () => new Float32Array(this.N));
    this.specRing = Array.from({ length: this.L + 1 }, () => new Float32Array(this.S.nb));
    this.specRingL = Array.from({ length: this.L + 1 }, () => new Float32Array(this.SL.nb));
    this.dbRing = Array.from({ length: this.L + 1 }, () => new Float32Array(this.S.nb));
    const gd = (this.h.length - 1) / 2;
    this.latency = (this.L * o.hop + o.window / 2) * this.dec / sr + gd / sr;
    this.pend = this.empty();
  }

  private empty(): EngineOutput { return { t: 0, frames: [], shifts: [], limiter: [], steps: [], scalars: {} }; }

  /** the time (s) a frame's window is centred on */
  private frameTime(k: number): number {
    const centre = (k * this.opts.hop + this.opts.window / 2) * this.dec + this.dec - 1;
    return (centre - (this.h.length - 1) / 2) / this.sr;
  }

  /** push samples (mono, or a left and right that are averaged) */
  push(a: Float32Array, b?: Float32Array): void {
    const h = this.h, H = h.length, n = a.length, d = this.dec;
    // the filter's history and the new samples, end to end
    if (this.work.length < H - 1 + n) this.work = new Float32Array(H - 1 + n);
    const x = this.work;
    x.set(this.tail, 0);
    if (b) for (let i = 0; i < n; i++) x[H - 1 + i] = 0.5 * (a[i] + b[i]);
    else x.set(a, H - 1);
    // one decimated sample every d inputs, the low-pass over the H inputs ending there
    let i = this.firstOut;
    for (; i < n; i += d) {
      let y = 0;
      for (let k = 0, p = H - 1 + i; k < H; k++, p--) y += h[k] * x[p];
      this.buf[this.bw] = y;
      this.bw = (this.bw + 1) % this.buf.length;
      this.decCount++;
      if (++this.sinceHop >= this.opts.hop && this.decCount >= this.opts.window) { this.sinceHop = 0; this.frame(); }
    }
    this.firstOut = i - n;
    this.tail.set(x.subarray(n, n + H - 1));
  }

  /** everything since the last read */
  read(): EngineOutput {
    const out = this.pend;
    out.scalars = { ...this.scal };
    out.steps = this.steps();
    this.pend = this.empty();
    this.pend.t = out.t;
    return out;
  }

  // ---------------------------------------------------------------------------------------------------- one frame
  private frame(): void {
    const slot = this.frameNo % (this.L + 1);
    this.S.read(this.buf, this.bw);
    this.SL.read(this.buf, this.bw);
    this.specRing[slot].set(this.S.wsp);
    this.specRingL[slot].set(this.SL.wsp);
    this.dbRing[slot].set(this.S.db);
    const obs = this.obsRing[slot];
    this.comb(obs);
    this.track(obs, slot);
    this.frameNo++;
    if (this.frameNo > this.L) this.commit();
  }

  /** the comb's three sums over one spectrum, for every rpm at once: at its own orders, its in-between points, its cycle orders */
  private combSums(pl: Float32Array, pos: Float32Array, anti: Float32Array, cy: Float32Array, bank: Float32Array): void {
    const Q = pl.length, N = this.N;
    pos.fill(0); anti.fill(0); cy.fill(0); bank.fill(0);
    const off = this.teethOff, fr = this.teethFrac, tw = this.teethW, tc = this.teethCycle;
    for (let t = 0; t < off.length; t++) {
      const k = off[t], f = fr[t], a = tw[t] * (1 - f), b = tw[t] * f, dst = tc[t] === 2 ? cy : tw[t] > 0 ? pos : anti;
      const end = Math.min(N, Q - k - 1);
      for (let j = 0; j < end; j++) dst[j] += a * pl[j + k] + b * pl[j + k + 1];
      if (tc[t] === 1) for (let j = 0; j < end; j++) bank[j] += a * pl[j + k] + b * pl[j + k + 1];
    }
  }

  /** each rpm's comb score: the mean whitened level at its orders, less its in-between points (dB), and a bonus for its cycle
   *  orders (the multiples of half an order between them) when they are heard. The bonus is capped by the level at its own
   *  orders (before the in-between points are taken off: loud cycle orders smear into those, and must not cost the rpm they
   *  belong to), and given only to an rpm that stands out at all: cycle orders alone cannot make an rpm (three quarters of the
   *  rpm has cycle orders on the true firing orders, and it is a ratio step away), they can only choose between rpms whose own
   *  orders are all there (the true rpm, and a third of it, whose orders are every one of the true half-orders). Low rpms are
   *  read from the long window's spectrum, high ones from the short window's, with a blend between. */
  private comb(obs: Float32Array): void {
    const N = this.N, [pos, anti, cy, bank, posL, antiL, cyL, bankL] = this.acc, lw = this.longW;
    this.combSums(this.S.plog, pos, anti, cy, bank);
    this.combSums(this.SL.plog, posL, antiL, cyL, bankL);
    const cw = this.cycleWeight;
    for (let j = 0; j < N; j++) {
      const w = lw[j], v = 1 - w;
      const p = (v * pos[j] + w * posL[j]) * this.combNorm[j], s = p + (v * anti[j] + w * antiL[j]) * this.combNorm[j];
      const c = (v * cy[j] + w * cyL[j]) * this.cycNorm[j], h = (v * bank[j] + w * bankL[j]) * this.bankNorm[j];
      // the bonus also wants the rpm's own half-orders heard: an engine that sounds at its cycle orders sounds at those too, and
      // an rpm whose cycle orders land on the true firing orders (half again the rpm, three quarters of it) has none of its own
      obs[j] = s + (cw > 0 && p > 1 && h > 1 ? cw * Math.min(c, 6 * p, 6 * h) : 0);
    }
    // the sub-harmonic: a third of the rpm has every true half-order on its own orders, so where three times an rpm is also in
    // range and explains the sound, the rpm pays that rpm's score. On track three times the true rpm is past the limiter, so
    // only the sub-harmonics pay. (At idle three times the rpm is in range: there the reading can rise to it; see the docs.)
    // Both this and the bonus rest on the car sounding at its cycle orders: a profile without them (cycleOrderWeight 0) has neither.
    const d3 = this.third;
    if (cw > 0) for (let j = 0; j + d3 < N; j++) if (obs[j + d3] > 0) obs[j] -= obs[j + d3];
  }

  /** one Viterbi step: the best way into each rpm, by slewing, by a shift, or by a jump */
  private track(obs: Float32Array, slot: number): void {
    const N = this.N, d = this.delta, nx = this.next, bp = this.bp[slot], S = this.slew, o = this.opts;
    if (this.frameNo === 0) { for (let j = 0; j < N; j++) { d[j] = obs[j]; bp[j] = j; } return; }
    // any jump: from the best anywhere
    let best = -Infinity, bi = 0;
    for (let i = 0; i < N; i++) if (d[i] > best) { best = d[i]; bi = i; }
    // shifts: an upshift lands j from i in [j+upLo, j+upHi]; a downshift from i in [j-upHi, j-upLo]
    const pad = this.upHi + 1, P = this.padded, wv = this.wv, wi = this.wi, w = this.upHi - this.upLo + 1;
    P.fill(-Infinity);
    P.set(d, pad);
    windowMax(P, w, wv, wi, this.dq);
    for (let j = 0; j < N; j++) {
      let v = best - o.jumpCost, from = bi;
      // slew
      for (let i = Math.max(0, j - S); i <= Math.min(N - 1, j + S); i++) {
        const x = (i - j) / S, c = d[i] - o.slewCost * x * x;
        if (c > v) { v = c; from = i; }
      }
      const up = pad + j + this.upLo, dn = pad + j - this.upHi;
      if (wv[up] - o.shiftCost > v) { v = wv[up] - o.shiftCost; from = wi[up] - pad; }
      if (dn >= 0 && wv[dn] - o.shiftCost > v) { v = wv[dn] - o.shiftCost; from = wi[dn] - pad; }
      nx[j] = v + obs[j];
      bp[j] = from;
    }
    let mx = -Infinity;
    for (let j = 0; j < N; j++) if (nx[j] > mx) mx = nx[j];
    for (let j = 0; j < N; j++) d[j] = nx[j] - mx;
  }

  // ---------------------------------------------------------------------------------------------------- deciding a frame
  /** the frame `lag` ago is decided: trace the best path back to it, then read everything off it */
  private commit(): void {
    const L = this.L, N = this.N, d = this.delta;
    let s = 0, best = -Infinity;
    for (let j = 0; j < N; j++) if (d[j] > best) { best = d[j]; s = j; }
    // path[L] is now, path[0] the frame being decided
    const path = new Int32Array(L + 1);
    path[L] = s;
    for (let k = L; k > 0; k--) {
      const slot = (this.frameNo - 1 - (L - k)) % (L + 1);
      path[k - 1] = this.bp[slot][path[k]];
    }
    const k0 = this.frameNo - 1 - L;
    const slot0 = k0 % (L + 1);
    const t = this.frameTime(k0);
    const look = Array.from(path, (j, k) => this.refine(j, (k0 + k) % (L + 1)));
    const rpm = look[0];
    const obs = this.obsRing[slot0];
    const db = this.dbRing[slot0];

    // confidence: how far the comb stands out at this rpm, and how much of the spectrum's peaks it explains
    const sal = clamp01((obs[path[0]] - 1.5) / 5);
    // the share of the peaks explained, from the window the comb read this rpm with
    const wl = clamp01((this.opts.longFrom - rpm) / Math.max(1, this.opts.longFrom - this.opts.longFull));
    const share = (1 - wl) * this.explained(this.S, this.specRing[slot0], rpm) + (wl > 0 ? wl * this.explained(this.SL, this.specRingL[slot0], rpm) : 0);
    const raw = sal * clamp01((share - 0.3) / 0.4);
    const hopS = this.opts.hop / this.fs;
    this.confS += (raw - this.confS) * (1 - Math.exp(-hopS / 0.3));

    // rate, over the last 80 ms of decided frames
    const prevRpm = this.outRpm.length ? this.outRpm[this.outRpm.length - 1] : rpm;
    const back = Math.min(this.outRpm.length, Math.max(1, Math.round(0.08 / hopS)));
    const rate = back ? (rpm - this.outRpm[this.outRpm.length - back]) / (back * hopS) : 0;
    this.rateS += (rate - this.rateS) * 0.5;
    this.outT.push(t); this.outRpm.push(rpm);
    if (this.outT.length > 400) { this.outT.shift(); this.outRpm.shift(); }

    // motion: on track the rpm is nearly always travelling, up through a gear or down under braking. A held note (or a chord
    // over its bass) reads as an engine to the comb but stands still, then jumps by steps that are not gear ratios. So the
    // confidence also asks what share of the last few seconds the rpm's trend between jumps moved by more than 1.5 % a second.
    // Flat out in top gear (a banking, a long straight) the revs only creep up, by a few tenths of a per cent a second: an engine
    // already heard moving that keeps creeping up holds the motion it had. A held note stands still, and never earned it.
    // At the top of a long straight (the Döttinger Höhe, a real 911 GT3 R's onboard) the car reaches its top speed and the revs
    // stop creeping altogether: an engine that earned its motion and sits high in its range, flat, holds it too, for up to 75 s
    // after it last travelled (the Nordschleife's longest flat-out run is under a minute).
    const from = Math.max(t - 1, this.lastJumpT + 0.1);
    if (t - from >= 0.4) {
      const sl = this.slope(from, t);
      const moving = Math.abs(sl) > 0.015 ? 1 : 0;
      if (moving) this.lastMoveT = t;
      const top = rpm >= 0.8 * this.car.shiftLights.to && sl > -0.003 && t - this.lastMoveT < 75;
      if (moving || !((sl > 0.0015 || top) && this.motion > 0.6)) this.motion += (moving - this.motion) * (1 - Math.exp(-hopS / 3));
    }
    const conf = this.confS * clamp01((this.motion - 0.15) / 0.45);

    // shifts: the decided path crosses the middle of a ratio-sized step that the look-ahead confirms
    this.findShift(t, rpm, prevRpm, conf, hopS);

    // throttle: the orders' level against this rpm's level on power, and their brightness
    const { level, bright } = this.orderLevels(db, rpm);
    let thr = this.throttle(t, rpm, level, bright);
    // the rpm's own slope within the gear says more than the level does (broadcast sound is compressed, which flattens the level):
    // on track, revs climbing in a gear is the car accelerating, on power; revs falling is the car slowing, off it
    const from3 = Math.max(t - 0.3, this.lastJumpT + 0.1);
    if (t - from3 >= 0.15) {
      const sl = this.slope(from3, t);
      if (sl > 0.02) thr = 0;
      else if (sl < -0.04 && thr === 0) thr = sl < -0.08 || t - this.lastDownT < 1.2 ? 2 : 1;
    }
    this.thrHist.push(thr);
    if (this.thrHist.length > 7) this.thrHist.shift();
    const votes = [0, 0, 0];
    for (const x of this.thrHist) votes[x]++;
    thr = votes[0] >= votes[1] && votes[0] >= votes[2] ? 0 : votes[1] >= votes[2] ? 1 : 2;
    if (t - this.lastShiftT < 0.15 && this.lastShiftDir > 0) thr = 0;

    // the limiter: held within 2 % of it for four frames (an upshift near the limiter passes through in fewer)
    const atLim = rpm >= this.car.limiterRpm * 0.98 && conf > 0.25;
    this.limRun = atLim ? this.limRun + 1 : 0;
    if (rpm < this.car.limiterRpm * 0.95) this.limOn = false;
    if (this.limRun >= 4 && !this.limOn) { this.limOn = true; this.limHits++; this.pend.limiter.push({ t, rpm }); }

    this.listen(slot0, rpm, conf, thr);
    const gear = this.gear(t);
    this.lapStep(t, rpm, conf, hopS);

    const frame: EngineFrame = { t, rpm, conf, rate: this.rateS, gear, throttle: thr, level, limiter: this.limOn };
    this.pend.frames.push(frame);
    this.pend.t = t;
    const lights = this.car.shiftLights;
    const lapT = this.lap.time;
    const since = Number.isFinite(this.lapT0) ? t - this.lapT0 : NaN;
    Object.assign(this.scal, {
      rpm, rpmConf: conf, rpmRate: this.rateS, gear, throttle: thr, limiter: this.limOn ? 1 : 0,
      shiftLight: clamp01((rpm - lights.from) / (lights.to - lights.from)),
      carSpeed: speedKmh(this.car, rpm, gear), engineLevel: level,
      shiftCount: this.allShifts, limiterHits: this.limHits,
      lapTime: lapT, lapConf: this.lap.conf,
      lapCount: Number.isFinite(lapT) ? Math.floor(since / lapT) : NaN,
      lapPhase: Number.isFinite(lapT) ? (since % lapT) / lapT : NaN,
    });
  }

  /** an rpm off the grid: the score's peak around state j, by a parabola */
  private refine(j: number, slot: number): number {
    const o = this.obsRing[slot], N = this.N;
    if (j <= 0 || j >= N - 1) return this.gridRpm[j];
    const a = o[j - 1], b = o[j], c = o[j + 1], den = a - 2 * b + c;
    const x = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    return this.gridRpm[j] * Math.pow(1 + this.opts.step, x);
  }

  /** the share of the spectrum's clear peaks (energy above the floor) that sit on this rpm's orders, beyond what chance would put
   *  there: every multiple of the cycle's order counts (a real engine sounds at all of them), and a peak lands within tolerance
   *  of one by chance in proportion to how close together they are, so a third of the rpm (three times the teeth) gains nothing */
  private explained(sp: Spectrum, P: Float32Array, rpm: number): number {
    const f1 = (this.base * rpm) / 60, top = Math.min(this.opts.fmax, this.fs * 0.45);
    let all = 0, on = 0, chance = 0;
    const bin = sp.binHz;
    for (let k = Math.ceil(30 / bin); k < sp.nb - 2 && k * bin < top; k++) {
      const v = P[k];
      if (v < 6 || v < P[k - 1] || v < P[k + 1] || v < P[k - 2] || v < P[k + 2]) continue;
      const e = Math.pow(10, v / 10) - 1, f = k * bin, tol = Math.max(1.6 * bin, 0.015 * f);
      all += e;
      chance += e * Math.min(1, (2 * tol) / f1);
      const m = Math.round(f / f1);
      if (m >= 1 && Math.abs(f - m * f1) <= tol) on += e;
    }
    return all - chance > 1e-9 ? Math.max(0, (on - chance) / (all - chance)) : 0;
  }

  /** the orders' summed level (dBFS) and brightness (the orders above 6 against those up to 6, dB) */
  private orderLevels(db: Float32Array, rpm: number): { level: number; bright: number } {
    let low = 0, high = 0;
    const f1 = rpm / 60, top = Math.min(this.opts.fmax, this.fs * 0.45);
    for (let m = 1; m * this.unit * f1 < top; m++) {
      const order = m * this.unit, f = order * f1;
      const x = f / this.S.binHz, i = Math.floor(x);
      let p = -200;
      for (let k = Math.max(0, i - 1); k <= Math.min(this.S.nb - 1, i + 2); k++) p = Math.max(p, db[k]);
      const lin = Math.pow(10, p / 10);
      if (order <= 6) low += lin; else high += lin;
    }
    return { level: 10 * Math.log10(low + high + 1e-14), bright: 10 * Math.log10((high + 1e-14) / (low + 1e-14)) };
  }

  /** on, lift or overrun: the level against this rpm's own level on power (a slowly falling peak), then brightness */
  private throttle(t: number, rpm: number, level: number, bright: number): number {
    const b = Math.max(0, Math.min(this.refLevel.length - 1, Math.floor(rpm / 250)));
    const hopS = this.opts.hop / this.fs;
    for (let k = 0; k < this.refLevel.length; k++) { this.refLevel[k] -= 0.15 * hopS; this.refBright[k] -= 0.15 * hopS; }
    // the reference: the loudest on power within 1000 rpm (an rpm the car mostly passes through off the throttle, just after
    // its downshifts, has no level of its own on power)
    let ref = -200, refB = -200;
    for (let k = Math.max(0, b - 4); k <= Math.min(this.refLevel.length - 1, b + 4); k++) { ref = Math.max(ref, this.refLevel[k]); refB = Math.max(refB, this.refBright[k]); }
    if (refB < -150) refB = bright;
    if (level > this.refLevel[b]) this.refLevel[b] = level;
    if (bright > this.refBright[b]) this.refBright[b] = bright;
    if (ref < -150) return 0;
    const drop = ref - level, dark = refB - bright;
    const off = drop > 7 || (drop > 4 && dark > 4);
    if (!off) return 0;
    // off the throttle: overrun under braking (rpm falling fast, or a downshift just heard), otherwise a lift
    const braking = this.rateS < -0.08 * rpm || t - this.lastDownT < 1.2;
    return braking ? 2 : 1;
  }

  private lastShiftDir = 0;
  /** a jump in progress: the decided path moving faster than any gear allows, frame after frame */
  private jump: { dir: 1 | -1; t0: number; sum: number; steps: { t0: number; t1: number; a: number; b: number }[]; quiet: number; counted: boolean } | null = null;

  /** A shift is where the tracker jumped: the decided rpm moved further between two frames than the car can slew within a gear.
   *  Consecutive jump frames are one shift. The gear count moves as soon as the jump is shift-sized (so the frames carry the new
   *  gear at once); a quarter of a second later the shift is judged: the rpm trends on either side, extrapolated to the moment the
   *  rpm crossed the middle of the step, must differ by one of the car's ratio steps, or the count goes back. */
  private findShift(t: number, rpm: number, prev: number, conf: number, hopS: number): void {
    if (this.outRpm.length < 2) return;
    const step = Math.log(rpm / prev);
    const lim = this.car.maxSlew * hopS * 1.5 + 0.004;
    let j = this.jump;
    if (Math.abs(step) > lim) this.lastJumpT = t;
    if (Math.abs(step) > lim && conf > 0.15) {
      const dir: 1 | -1 = step < 0 ? 1 : -1;
      if (j && j.dir !== dir) { this.endJump(hopS); j = null; }
      if (!j) j = this.jump = { dir, t0: t - hopS, sum: 0, steps: [], quiet: 0, counted: false };
      j.sum += step; j.quiet = 0;
      j.steps.push({ t0: t - hopS, t1: t, a: Math.log(prev), b: Math.log(rpm) });
      if (!j.counted && Math.abs(j.sum) >= 0.6 * Math.log(1 / this.car.upshiftRatio.max)) { j.counted = true; this.rel += dir; }
    } else if (j && ++j.quiet * hopS >= 0.12) this.endJump(hopS);
  }

  /** the slope of log rpm over decided frames in [a, b] (per second) */
  private slope(a: number, b: number): number {
    let n = 0, st = 0, sy = 0, stt = 0, sty = 0;
    for (let k = this.outT.length - 1; k >= 0 && this.outT[k] >= a; k--) {
      const x = this.outT[k];
      if (x > b) continue;
      const y = Math.log(this.outRpm[k]);
      n++; st += x; sy += y; stt += x * x; sty += x * y;
    }
    const den = n * stt - st * st;
    return n < 3 || Math.abs(den) < 1e-12 ? 0 : (n * sty - st * sy) / den;
  }

  /** the rpm trend (log) over decided frames in [a, b], evaluated at t (NaN with too few frames) */
  private trend(a: number, b: number, t: number): number {
    let n = 0, st = 0, sy = 0, stt = 0, sty = 0;
    for (let k = this.outT.length - 1; k >= 0; k--) {
      const x = this.outT[k];
      if (x < a) break;
      if (x > b) continue;
      const y = Math.log(this.outRpm[k]);
      n++; st += x; sy += y; stt += x * x; sty += x * y;
    }
    if (n === 0) return NaN;
    const den = n * stt - st * st;
    if (n < 3 || Math.abs(den) < 1e-12) return sy / n;
    const slope = (n * sty - st * sy) / den;
    return sy / n + slope * (t - st / n);
  }

  private endJump(hopS: number): void {
    const j = this.jump;
    this.jump = null;
    if (!j || !j.steps.length) return;
    const car = this.car, last = j.steps[j.steps.length - 1].t1;
    // when the rpm crossed the middle of the step (in log), within the jump frame that holds it
    const mid = j.steps[0].a + j.sum / 2;
    let at = j.steps[0].t1;
    for (const s of j.steps) if ((s.a - mid) * (s.b - mid) <= 0 && s.a !== s.b) { at = s.t0 + ((mid - s.a) / (s.b - s.a)) * (s.t1 - s.t0); break; }
    // the trends either side, from frames clear of the shift (a frame's window spans 85 ms, so those next to it are a mixture)
    const pre = this.trend(Math.min(at, j.t0) - 0.26, Math.min(at, j.t0) - 0.09, at), post = this.trend(Math.max(at, last) + 0.09, Math.max(at, last) + 0.26, at);
    const before = Math.exp(Number.isFinite(pre) ? pre : j.steps[0].a), after = Math.exp(Number.isFinite(post) ? post : j.steps[j.steps.length - 1].b);
    const q = j.dir > 0 ? after / before : before / after;
    // the car keeps slewing through the shift, so the band widens by what it can slew in the jump's time
    const slack = Math.exp(car.maxSlew * (last - j.t0 + hopS));
    // and a race car shifts up near the top of its range and comes down into the upper half of it; a jump that is not a ratio
    // step, or happens where no driver would shift, is not a shift, and makes it less likely this is an engine at all
    const ratioOk = q <= car.upshiftRatio.max * slack && q >= car.upshiftRatio.min / slack;
    const where = j.dir > 0 ? before >= 0.55 * car.shiftLights.to : after >= 0.45 * car.shiftLights.to && after <= car.limiterRpm * 1.05;
    if (!ratioOk || !where) { if (j.counted) this.rel -= j.dir; this.motion *= 0.6; return; }
    if (!j.counted) this.rel += j.dir;
    this.addShift(at, j.dir, before, after);
  }

  private addShift(t: number, dir: 1 | -1, before: number, after: number): void {
    this.lastShiftT = t;
    this.lastShiftDir = dir;
    if (dir < 0) this.lastDownT = t;
    const relBefore = this.rel - dir;
    this.relHist.push({ t, rel: this.rel });
    if (this.relHist.length > 600) this.relHist.shift();
    // the ratio as an upshift's (after / before, below 1) between the lower gear and the higher
    this.shiftLog.push({ t, dir, relBefore, ratio: dir > 0 ? after / before : before / after });
    if (this.shiftLog.length > 400) this.shiftLog.shift();
    this.allShifts++;
    this.fitOffset(t);
    this.pend.shifts.push({ t, dir, before, after, gear: this.gearOf(this.rel) });
  }

  private gearOf(rel: number): number {
    return Number.isFinite(this.offset) ? Math.max(1, Math.min(this.car.gears, rel + this.offset)) : NaN;
  }

  /** the gear now. A count can only slip at a missed shift, and a slip that would put the car outside its gearbox is one for
   *  certain: then the count is anchored again at the box's end (a missed downshift shows as a seventh gear on the next
   *  straight in sixth, and is put right there), so an error never outlives the next time the car reaches top gear or first */
  private gear(t: number): number {
    void t;
    if (Number.isFinite(this.offset)) {
      const g = this.rel + this.offset;
      if (g > this.car.gears) this.offset -= g - this.car.gears;
      else if (g < 1) this.offset += 1 - g;
    }
    return this.gearOf(this.rel);
  }

  /** where the counted gears sit: by the profile's ratios when it has them, else the lowest gear heard lately is first */
  private fitOffset(t: number): void {
    const G = this.car.gears;
    const steps = this.profileSteps();
    if (!steps) {
      // no ratios: the lowest gear heard over the last lap (or four minutes) is first
      const span = Number.isFinite(this.lap.time) ? Math.max(120, this.lap.time * 1.05) : 240;
      let lo = this.rel;
      for (let i = this.relHist.length - 1; i >= 0 && this.relHist[i].t >= t - span; i--) lo = Math.min(lo, this.relHist[i].rel);
      this.offset = 1 - lo;
      return;
    }
    // ratios: place the last six upshifts on the gearbox where their ratios fit best (upshifts only: a downshift's ratio is
    // bent by the blip and by hard braking through it).
    const ups = this.shiftLog.filter((s) => s.dir > 0).slice(-6);
    if (!ups.length) return;
    // any placement that puts the current gear in the box (an upshift placed off the box's ends costs as much as a 10 % misfit)
    const oMin = 1 - this.rel, oMax = G - this.rel;
    let bestO = Number.isFinite(this.offset) ? Math.max(oMin, Math.min(oMax, this.offset)) : oMin, bestC = Infinity;
    for (let o = oMin; o <= oMax; o++) {
      let c = 0;
      // the newest counts most (each one back counts half as much), so a miscount heals in two or three upshifts
      ups.forEach((s, k) => {
        const lower = s.relBefore + o, w = Math.pow(0.5, ups.length - 1 - k);
        c += w * (lower >= 1 && lower < G ? (Math.log(s.ratio) - Math.log(steps[lower - 1])) ** 2 : 0.01);
      });
      if (c < bestC - 1e-9) { bestC = c; bestO = o; }
    }
    this.offset = bestO;
  }

  private profileSteps(): number[] | null {
    const r = this.car.ratios;
    if (!r || r.length < 2) return null;
    return r.slice(1).map((x, i) => x / r[i]);
  }

  /** the upshift ratio for each transition: the profile's, or the median of those heard (clustered by the gear count) */
  // ---------------------------------------------------------------------------------------------------- the voice print
  /** which orders this microphone carries: the whitened level (dB above the floor) at every half-order up to the 15th, averaged
   *  over sure moments, on power and off it. It is what tells one car (or one microphone, or a simulator's sound) from another */
  private print = { on: new Float64Array(SIGNATURE_ORDERS), off: new Float64Array(SIGNATURE_ORDERS), nOn: 0, nOff: 0 };

  private listen(slot: number, rpm: number, conf: number, thr: number): void {
    if (conf < 0.6 || !(rpm > 0)) return;
    const P = this.specRing[slot], sp = this.S, dst = thr === 0 ? this.print.on : this.print.off;
    for (let k = 1; k <= SIGNATURE_ORDERS; k++) {
      const f = ((k * 0.5) * rpm) / 60, x = f / sp.binHz, i = Math.round(x);
      if (i < 1 || i >= sp.nb - 1) continue;
      dst[k - 1] += Math.max(P[i - 1], P[i], P[i + 1]);
    }
    if (thr === 0) this.print.nOn++; else this.print.nOff++;
  }

  /** the voice print so far: per half-order (0.5, 1, 1.5 … 15), the mean level on power and off it (dB above the floor) */
  signature(): { orders: number[]; on: number[]; off: number[]; moments: { on: number; off: number } } {
    const p = this.print, orders = Array.from({ length: SIGNATURE_ORDERS }, (_, i) => (i + 1) * 0.5);
    return {
      orders,
      on: Array.from(p.on, (x) => (p.nOn ? x / p.nOn : NaN)),
      off: Array.from(p.off, (x) => (p.nOff ? x / p.nOff : NaN)),
      moments: { on: p.nOn, off: p.nOff },
    };
  }

  steps(): number[] {
    const p = this.profileSteps();
    if (p) return p;
    const out: number[] = [];
    for (let g = 1; g < this.car.gears; g++) {
      const xs = this.shiftLog.filter((s) => s.dir > 0 && s.relBefore + this.offset === g).map((s) => s.ratio).sort((a, b) => a - b);
      out.push(xs.length ? xs[xs.length >> 1] : NaN);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------- the lap
  /** the rpm trace at 10 Hz; every few seconds, its period by autocorrelation */
  private lapStep(t: number, rpm: number, conf: number, hopS: number): void {
    if (conf > 0.3 && !Number.isFinite(this.lapT0)) this.lapT0 = t;
    if (!Number.isFinite(this.lapT0)) return;
    this.lapAcc += conf > 0.2 ? Math.log(rpm) : NaN;
    this.lapN++;
    // one value per 0.1 s of the stream (the mean of the frames in it)
    if (t < this.lapT0 + (this.lapTrace.length + this.lapDropped + 1) * 0.1) return;
    this.lapTrace.push(this.lapAcc / this.lapN);
    this.lapAcc = 0; this.lapN = 0;
    const cap = Math.round(this.opts.lapMax * 10 * 3.2);
    if (this.lapTrace.length > cap) { this.lapDropped += this.lapTrace.length - cap; this.lapTrace.splice(0, this.lapTrace.length - cap); }
    if (t >= this.lapNext) { this.lapNext = t + this.opts.lapEvery; this.findLap(); }
  }

  /** the lap: the strongest repeat of the rpm trace between lapMin and lapMax (the shortest of near-equals, so not two laps) */
  findLap(): void {
    const x0 = this.lapTrace, M = x0.length, rate = 10;
    const minLag = Math.round(this.opts.lapMin * rate), maxLag = Math.min(Math.round(this.opts.lapMax * rate), Math.floor(M / 1.6));
    if (maxLag <= minLag + 2) return;
    let mean = 0, c = 0;
    for (const v of x0) if (Number.isFinite(v)) { mean += v; c++; }
    if (c < M * 0.5) return;
    mean /= c;
    const x = new Float64Array(M);
    for (let i = 0; i < M; i++) x[i] = Number.isFinite(x0[i]) ? x0[i] - mean : 0;
    let size = 1;
    while (size < 2 * M) size <<= 1;
    const fft = new FFT(size), re = new Float64Array(size), im = new Float64Array(size);
    re.set(x);
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
    if (best < 0.4) return;
    let pick = -1;
    for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] >= 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { pick = lag; break; }
    if (pick < 0) return;
    const a = r[pick - 1], b = r[pick], cc = r[pick + 1], den = a - 2 * b + cc;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / den)) : 0;
    this.lap = { time: (pick + off) / rate, conf: b };
  }
}
