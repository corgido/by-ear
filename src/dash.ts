// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// The gear a live dash shows, decided as the sound comes, kept apart from any page so what a viewer saw can be replayed and
// scored against a HUD.
//
// Three ways, scored on the six tuning onboards of the real 992 (overlay gear) and corgido's hour in ACC's 992 (the case study's record, 4.28):
// - count: the analyser counts shifts as they come; the report (rebuilt every 6 s) says what to add to the count. Right 38 % of
//   the time on the onboards and 24 % in the hour: a third of the shifts it hears are not shifts (mostly on a lift or overrun,
//   or the revs settling after a downshift's blip), and each one moves the gear at once. On a clean synthetic lap, 82 %.
// - belief: the report's decision run forward as a probability for each gear: 59 % and 58 %.
// - window: the report's own decision (gearByContinuity, src/track.ts) made again every half second on the last 90 s,
//   its gear at the newest moment carried to now by the believable shifts heard since: 66 % and 61 % (the report, with the
//   whole run both ways, 78 % and 87 %). On overrun it also expects the car to be slowing, so held revs there mean downshifts
//   went unheard. Shown for cars whose climb was measured from footage (the measured climb is what anchors it); the count,
//   which is right on clean sound, for the rest.
import { speedKmh, type CarProfile } from './cars';
import type { EngineFrame, ShiftEvent } from './engine';
import { SHIFT_EVIDENCE as SH, gearByContinuity, gearbox, resample, speedFromClimb } from './track';
import type { Report } from './report';

export interface DashGear { gear: number; alt: number; sure: boolean; /** the belief in the gear shown (NaN for the count) */ p: number }

const EVERY = 0.3, HOLD = 10;
/** the window's settings (exported, to be tried): its length and how often it is decided again (s), whether a
 *  new gear at its newest moment waits for a second decision (hyst), and whether shifts heard since are counted on (carry) */
export const WIN = { len: 90, every: 0.5, hyst: 0, carry: 1, ovAcc: 0, ovSigma: 10 };
/** how much a new report's decision outweighs the rest (as a likelihood: REPORT_PULL against 1 - REPORT_PULL) */
export let REPORT_PULL = 0.8;
export function setReportPull(x: number): void { REPORT_PULL = x; }

export class Dash {
  private conf = 0;
  private lastT = NaN;
  // belief
  private k: number[] | null;
  private b: Float64Array | null = null;
  private last: { t: number; rpm: number } | null = null;
  private ring: { t: number; rpm: number; thr: number; conf: number }[] = [];
  private pending: ShiftEvent[] = [];
  private lastShiftT = -Infinity;
  private shown = NaN;
  private heardT = -Infinity;
  private report: Report | null = null;
  /** every shift heard (as judged), to carry a report's decision from the end of its trace to now */
  private heardShifts: ShiftEvent[] = [];

  // window
  private win: EngineFrame[] = [];
  private winNext = -Infinity;
  private winGear = NaN;
  private winPrev = NaN;
  private winShown = NaN;
  private winShownT = -Infinity;

  constructor(private car: CarProfile, readonly mode: 'count' | 'belief' | 'window' = DASH_MODE, fromDefault = mode === DASH_MODE) {
    // km/h per rpm in each gear (index 1..G), from the car's ratios: without them only the count can be shown
    const G = car.gears, k = [NaN];
    for (let g = 1; g <= G; g++) k.push(speedKmh(car, 1000, g) / 1000);
    this.k = k.slice(1).every((x) => x > 0) ? k : null;
    if (this.mode !== 'count' && !this.k) this.mode = 'count';
    if (this.mode === 'window' && !car.climbCurve?.length && fromDefault) this.mode = 'count';
  }

  /** shifts as the analyser judges them (a quarter of a second after each) */
  shifts(sh: ShiftEvent[]): void { this.pending.push(...sh); this.heardShifts.push(...sh); if (this.heardShifts.length > 200) this.heardShifts.splice(0, this.heardShifts.length - 200); }

  /** the gear shown for this frame, given the newest report (null before the first). Fed every frame, in order */
  feed(f: EngineFrame, report: Report | null): DashGear {
    // the confidence is eased as a screen at 60 Hz would ease it (0.1 a frame), by the frames' own clock
    const dt = Number.isFinite(this.lastT) ? Math.max(0, f.t - this.lastT) : 0;
    this.lastT = f.t;
    this.conf += (f.conf - this.conf) * (1 - Math.pow(0.9, dt * 60));
    const sure = this.conf > 0.35;
    return this.mode === 'belief' ? this.believe(f, sure, report) : this.mode === 'window' ? this.window(f, sure) : this.count(f, report, sure);
  }

  /** the report's own decision (gearByContinuity) on the last WIN.len s, made again every WIN.every s: its gear at the newest
   *  moment, carried to now by the believable shifts heard since. The report's gear is as right at the newest moment it has
   *  heard as anywhere (75 % against 78 % on the tuning onboards); what lost the count its accuracy was the 6 s between reports */
  private window(f: EngineFrame, sure: boolean): DashGear {
    const car = this.car;
    this.win.push(f);
    while (this.win.length && this.win[0].t < f.t - WIN.len) this.win.shift();
    if (f.t >= this.winNext && this.win.length > 50) {
      this.winNext = f.t + WIN.every;
      const h = resample(this.win, 10), t0 = this.win[0].t;
      const sh = this.heardShifts.filter((x) => x.t >= t0);
      const g = gearByContinuity(h, gearbox(h, sh, car), car, sh, car.upshiftHeard, car.climbCurve, WIN.ovSigma ? { overrun: { acc: WIN.ovAcc, sigma: WIN.ovSigma } } : {});
      let k = g.length - 1;
      while (k >= 0 && !(g[k] >= 1)) k--;
      if (k >= 0) {
        // the decision's newest moment is its least settled: a new gear there is taken when two decisions running agree on
        // it, or when a believable shift heard since the gear last shown says the same
        const ng = g[k], nt = h.t0 + k / h.rate;
        if (!Number.isFinite(this.winShown) || ng === this.winPrev || !WIN.hyst) { this.winShown = ng; this.winShownT = nt; }
        this.winPrev = ng; this.winGear = ng;
      }
    }
    if (!Number.isFinite(this.winGear)) return { gear: NaN, alt: NaN, sure, p: NaN };
    const n = WIN.carry ? this.heardShifts.filter((x) => x.t > this.winShownT && this.believable(x)).reduce((a, x) => a + x.dir, 0) : 0;
    return { gear: Math.max(1, Math.min(car.gears, this.winShown + n)), alt: NaN, sure, p: NaN };
  }

  /** a heard upshift is believed only on power, from near the shift point, and not as the revs settle after a downshift's
   *  blip: on the tuning onboards 660 of 673 true upshifts were on power, and a third of all heard upshifts were false, most of
   *  them on a lift or overrun, from lower revs, or within a second of a downshift (the case study's record, 4.28) */
  private believable(x: ShiftEvent): boolean {
    if (x.dir < 0) return true;
    const w = this.win.filter((f) => f.t >= x.t - 0.4 && f.t < x.t - 0.05);
    const on = w.length > 0 && w.filter((f) => f.throttle === 0).length >= 0.7 * w.length;
    const down = this.heardShifts.some((y) => y.dir < 0 && y.t < x.t && x.t - y.t < 0.8);
    return on && x.before >= 0.93 * this.car.shiftLights.to && !down;
  }

  private count(f: EngineFrame, report: Report | null, sure: boolean): DashGear {
    const car = this.car, gb = report?.gearbox;
    const off = gb?.offset ?? 0;
    const g = sure && f.gear >= 1 ? Math.max(1, Math.min(car.gears, f.gear + off)) : NaN;
    const alt = gb && Number.isFinite(gb.offsetAlt) && (gb.offsetShare ?? 1) < 0.8 && Number.isFinite(g)
      ? Math.max(1, Math.min(car.gears, f.gear + (gb.offsetAlt as number))) : NaN;
    return { gear: g, alt, sure, p: NaN };
  }

  private believe(f: EngineFrame, sure: boolean, report: Report | null): DashGear {
    const G = this.car.gears;
    if (report && report !== this.report) { this.report = report; this.observe(report); }
    this.ring.push({ t: f.t, rpm: f.rpm, thr: f.throttle, conf: f.conf });
    while (this.ring.length && this.ring[0].t < f.t - 1) this.ring.shift();
    const ok = f.rpm > 0 && f.conf >= 0.2;
    if (ok && (!this.last || f.t - this.last.t >= EVERY)) this.step(f.t, f.rpm);
    if (!this.b) return { gear: NaN, alt: NaN, sure, p: NaN };
    // shown: the most likely gear, changed when another is more likely than not (or at once after a shift that says so)
    let best = 1, second = 0;
    for (let g = 2; g <= G; g++) if (this.b[g] > this.b[best]) best = g;
    for (let g = 1; g <= G; g++) if (g !== best && (!second || this.b[g] > this.b[second])) second = g;
    if (!Number.isFinite(this.shown) || this.b[best] > 0.5 || f.t - this.lastShiftT < 1) this.shown = best;
    const held = f.t - this.heardT <= HOLD;
    const p = this.b[this.shown];
    return { gear: held ? this.shown : NaN, alt: second && this.b[second] > 0.25 ? second : NaN, sure: sure && p > 0.5, p };
  }

  /** a new report: the gear it decided at the end of its trace, carried to now by the shifts heard since, pulls the belief
   *  (it has seen the whole run, with the speed's continuity both ways, so it is the better judge of where the count stands) */
  private observe(r: Report): void {
    if (!this.b) return;
    const tr = r.trace, G = this.car.gears;
    let k = tr.gear.length - 1;
    while (k >= 0 && !(tr.gear[k] >= 1)) k--;
    if (k < 0) return;
    const t0 = tr.t0 + k / tr.rate;
    const n = this.heardShifts.filter((x) => x.t > t0).reduce((a, x) => a + x.dir, 0);
    const g0 = Math.max(1, Math.min(G, tr.gear[k] + n));
    let z = 0;
    for (let g = 1; g <= G; g++) { this.b[g] *= g === g0 ? REPORT_PULL : 1 - REPORT_PULL; z += this.b[g]; }
    for (let g = 1; g <= G; g++) this.b[g] /= z;
  }

  /** one moment of the forward pass: from the belief at the last moment to this one */
  private step(t: number, rpm: number): void {
    const G = this.car.gears, k = this.k!, car = this.car;
    const v = (r: number, g: number) => k[g] * r;
    // the climb: the revs' rate on full power over the last 0.6 s, against the car's acceleration at each gear's speed
    let climb = NaN, vc = NaN;
    const w = this.ring.filter((x) => x.t >= t - 0.6 && x.rpm > 0 && x.conf >= 0.2);
    if (w.length >= 6 && w.every((x) => x.thr === 0) && t - this.lastShiftT > 0.8 && w[w.length - 1].t - w[0].t > 0.4) {
      const dl = (Math.log(w[w.length - 1].rpm) - Math.log(w[0].rpm)) / (w[w.length - 1].t - w[0].t);
      if (dl > 0.01) {
        climb = Math.log(dl);
        // without the car's measured climb, the speed physics gives that climb (power, mass and drag; the report's way too)
        const x = speedFromClimb(car, w[w.length >> 1].rpm, dl);
        if (x > 15 && x * dl <= 9) vc = Math.log(x * 3.6);
      }
    }
    const accel = (x: number) => {
      const c = car.climbCurve!;
      if (x <= c[0][0]) return c[0][1];
      for (let i = 1; i < c.length; i++) if (x <= c[i][0]) return c[i - 1][1] + ((x - c[i - 1][0]) / (c[i][0] - c[i - 1][0])) * (c[i][1] - c[i - 1][1]);
      return c[c.length - 1][1];
    };
    const own = (g: number) => (v(rpm, g) > 330 ? 1e3 : 0) + (rpm > car.limiterRpm * 1.03 ? 1e3 : 0) +
      (car.climbCurve?.length ? (Number.isFinite(climb) ? Math.min(SH.climbCap, ((climb - Math.log(Math.max(0.1, accel(v(rpm, g))) / v(rpm, g))) / SH.climbSigma) ** 2) : 0)
        : Number.isFinite(vc) ? Math.min(9, ((Math.log(v(rpm, g)) - vc) / 0.2) ** 2) : 0);
    // the first upshift heard since the last moment, if any (as the report counts one per stretch)
    const sh = this.pending.find((x) => x.dir < 0 || (x.before > 0 && x.after > 0));
    this.pending = [];
    if (sh) this.lastShiftT = Math.max(this.lastShiftT, sh.t);
    const tpl = car.upshiftHeard;
    const stepOf = (f: number) => tpl?.[f - 1]?.[0] ?? k[f] / k[f + 1], sig = (f: number) => (tpl?.[f - 1] ? Math.max(SH.floor, tpl[f - 1]![1]) : SH.sigma);
    const evidence = (f: number, g: number) => {
      if (!sh) return 0;
      if (sh.dir > 0) {
        if (g === f + 1) return Math.min(SH.cap, ((Math.log(sh.after / sh.before) - Math.log(stepOf(f))) / sig(f)) ** 2) - SH.bonus;
        return g === f ? SH.stay : g < f ? SH.against : SH.skip;
      }
      return g === f - 1 || g === f - 2 ? -SH.bonus : g === f ? SH.stay : g > f ? SH.against : 0;
    };
    const cost = new Float64Array(G + 1).fill(Infinity);
    if (!this.b || !this.last || t - this.last.t > HOLD) {
      // a first moment, or after a long silence: the gear from this moment alone
      for (let g = 1; g <= G; g++) cost[g] = own(g);
    } else {
      const dt = Math.max(0.1, t - this.last.t), r0 = this.last.rpm;
      // sum over where it came from, as probabilities (a cost is a chi-square: p ∝ exp(-cost / 2))
      for (let g = 1; g <= G; g++) {
        let s = 0;
        const vg = v(rpm, g), og = own(g);
        for (let f = 1; f <= G; f++) {
          if (!(this.b[f] > 1e-12)) continue;
          const acc = (vg - v(r0, f)) / dt, ex = acc > 40 ? acc - 40 : acc < -60 ? -60 - acc : 0;
          const c = (ex / 15) ** 2 + (g === f ? 0 : 2 + 2 * Math.max(0, Math.abs(g - f) - 1 - Math.floor(dt / SH.gapPerShift))) + og + (sh ? evidence(f, g) : g === f ? 0 : SH.unheard);
          s += this.b[f] * Math.exp(-c / 2);
        }
        cost[g] = s > 0 ? -2 * Math.log(s) : Infinity;
      }
    }
    const lo = Math.min(...cost.slice(1));
    const b = new Float64Array(G + 1);
    let z = 0;
    for (let g = 1; g <= G; g++) { b[g] = Number.isFinite(cost[g]) ? Math.exp(-(cost[g] - lo) / 2) : 0; z += b[g]; }
    // a little doubt always: an unheard shift is possible at any moment
    for (let g = 1; g <= G; g++) b[g] = 0.995 * (b[g] / z) + 0.005 / G;
    this.b = b;
    this.last = { t, rpm };
    this.heardT = t;
  }
}

/** which way is shown (the scores decided; see the top of this file) */
export const DASH_MODE: 'count' | 'belief' | 'window' = 'window';
