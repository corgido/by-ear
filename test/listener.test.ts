// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// The listener (src/engine.ts) against the synthetic onboard laps, whose answers are known (src/generator.ts), and
// against music, which must read as not an engine. Each scenario prints one line of what it measured.
import { describe, expect, it } from 'vitest';
import { OnboardSynth, truthAt, type OnboardOptions } from '../src/generator';
import { SIGNALS } from './signals';
import { EngineAnalyser, type EngineFrame, type EngineOutput, type ShiftEvent } from '../src/engine';
import { CARS, carById, type CarProfile } from '../src/cars';
import { carMismatch, carSuggest } from '../src/mismatch';
import { Dash } from '../src/dash';

const SR = 48000;

interface Score {
  rpm: number; rpmAway: number; shiftsFound: number; shiftsFalse: number; shiftsTrue: number; shiftDt: number;
  gear: number; gearAway: number; gearFromBottom: number; throttle: number; lapErr: number; lapCount: number;
  limiterFound: number; limiterTrue: number; meanConf: number; third: number; last: EngineOutput;
}

/** a synthetic run through the analyser, streamed in 1024-sample blocks, scored against its truth */
function score(opts: OnboardOptions, carId: string | CarProfile): Score {
  const syn = new OnboardSynth(SR, opts);
  const an = new EngineAnalyser(SR, typeof carId === 'string' ? carById(carId) : carId);
  const L = new Float32Array(1024), R = new Float32Array(1024);
  const frames: EngineFrame[] = [], shifts: ShiftEvent[] = [];
  const hits: number[] = [];
  let last!: EngineOutput;
  for (let n = syn.fill(L, R); n > 0; n = syn.fill(L, R)) {
    an.push(L.subarray(0, n), R.subarray(0, n));
    last = an.read();
    frames.push(...last.frames); shifts.push(...last.shifts); hits.push(...last.limiter.map((h) => h.t));
  }
  const tr = syn.truth;
  // every frame after the first second (the tracker's lock), up to the end
  const ev = frames.filter((f) => f.t > 1 && f.t < tr.seconds - 0.5);
  const nearShift = (t: number) => tr.shifts.some((s) => Math.abs(s.t - t) < 0.15);
  const minGear = tr.gear.reduce((a, b) => Math.min(a, b), 99);
  let rpm = 0, rpmAway = 0, away = 0, gear = 0, gearAway = 0, bottom = 0, thr = 0, conf = 0, third = 0;
  for (const f of ev) {
    const tt = truthAt(tr, f.t), ok = Math.abs(f.rpm / tt.rpm - 1) < 0.02, a = !nearShift(f.t);
    third += +(Math.abs((3 * f.rpm) / tt.rpm - 1) < 0.02);
    rpm += +ok; gear += +(f.gear === tt.gear); bottom += +(f.gear === tt.gear - minGear + 1); conf += f.conf;
    if (a) { away++; rpmAway += +ok; gearAway += +(f.gear === tt.gear); thr += +(f.throttle === tt.throttle); }
  }
  // shifts: each true one matched to a found one of the same direction within 100 ms; the found ones left over are false
  const used = new Set<number>(), dts: number[] = [];
  const truth = tr.shifts.filter((s) => s.t > 1);
  for (const s of truth) {
    let bj = -1, bd = 0.1;
    shifts.forEach((d, j) => { if (!used.has(j) && d.dir === s.dir && Math.abs(d.t - s.t) <= bd) { bd = Math.abs(d.t - s.t); bj = j; } });
    if (bj >= 0) { used.add(bj); dts.push(bd); }
  }
  const lapTrue = tr.lapTimes.reduce((a, b) => a + b, 0) / tr.lapTimes.length;
  const n = ev.length;
  return {
    rpm: rpm / n, rpmAway: rpmAway / away, shiftsFound: used.size, shiftsFalse: shifts.filter((d) => d.t > 1).length - used.size, shiftsTrue: truth.length,
    shiftDt: dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length),
    gear: gear / n, gearAway: gearAway / away, gearFromBottom: bottom / n, throttle: thr / away,
    lapErr: Math.abs(last.scalars.lapTime / lapTrue - 1), lapCount: last.scalars.lapCount,
    limiterFound: tr.limiter.filter((l) => hits.some((h) => h >= l.t0 - 0.3 && h <= l.t1)).length, limiterTrue: tr.limiter.length,
    meanConf: conf / n, third: third / n, last,
  };
}

const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
const line = (name: string, s: Score) => console.log(`${name}: rpm within 2% on ${pc(s.rpm)} of frames (${pc(s.rpmAway)} away from shifts); shifts ${s.shiftsFound}/${s.shiftsTrue} found within 100 ms (mean ${(s.shiftDt * 1000).toFixed(0)} ms), ${s.shiftsFalse} false; gear ${pc(s.gear)} (${pc(s.gearAway)} away from shifts; counted from the bottom ${pc(s.gearFromBottom)}); throttle ${pc(s.throttle)}; lap period off by ${pc(s.lapErr)}; limiter ${s.limiterFound}/${s.limiterTrue}; mean confidence ${s.meanConf.toFixed(2)}`);

describe('the listener reads the synthetic laps', () => {
  it('three long laps (about 8 minutes each, a Nordschleife-like circuit), with the profile’s gear ratios', { timeout: 300000 }, () => {
    const s = score({ track: 'nordschleife', laps: 3, vary: 1, seed: 7 }, 'synthetic-flat6');
    line('long laps, ratios known', s);
    expect(s.rpm, 'rpm within 2 % on 90 % of frames').toBeGreaterThanOrEqual(0.9);
    expect(s.shiftsFound / s.shiftsTrue, 'shifts found within 100 ms').toBeGreaterThanOrEqual(0.95);
    expect(s.shiftsFalse / s.shiftsTrue, 'few false shifts').toBeLessThanOrEqual(0.05);
    expect(s.gear, 'gear right on 90 % of frames').toBeGreaterThanOrEqual(0.9);
    expect(s.lapErr, 'lap period within 1 %').toBeLessThan(0.01);
    expect(s.lapCount, 'laps counted').toBeGreaterThanOrEqual(2);
    expect(s.limiterFound, 'every limiter hit').toBe(s.limiterTrue);
    expect(s.throttle, 'throttle state').toBeGreaterThanOrEqual(0.9);
  });

  it('three short laps with heavy traffic (two or three cars passing a minute)', { timeout: 300000 }, () => {
    const s = score({ track: 'short', laps: 3, vary: 1, seed: 911 }, 'synthetic-flat6');
    line('short laps, heavy traffic', s);
    expect(s.rpm).toBeGreaterThanOrEqual(0.9);
    expect(s.shiftsFound / s.shiftsTrue).toBeGreaterThanOrEqual(0.9);
    expect(s.shiftsFalse / s.shiftsTrue).toBeLessThanOrEqual(0.1);
    // a car passing while ours is on overrun can take the tracker for a moment and hide a downshift: the gear heals within a few upshifts
    expect(s.gear).toBeGreaterThanOrEqual(0.85);
    expect(s.lapErr).toBeLessThan(0.01);
  });

  // The first real onboard heard (the case study's record, 4.2) sounded at every half-order, not only the flat-six's multiples of
  // 1.5, and an earlier comb locked onto a third of the rpm there, sure of itself. These laps carry those cycle orders loudly.
  it('a microphone that hears every half-order (as real onboards do) does not pull the rpm to a third', { timeout: 300000 }, () => {
    const s = score({ track: 'short', laps: 3, vary: 1, seed: 911, cycle: 1.5 }, 'synthetic-flat6');
    line('short laps, heavy traffic, loud cycle orders', s);
    expect(s.rpm).toBeGreaterThanOrEqual(0.9);
    expect(s.third, 'frames at a third of the rpm').toBeLessThan(0.01);
    expect(s.shiftsFound / s.shiftsTrue).toBeGreaterThanOrEqual(0.9);
    expect(s.shiftsFalse / s.shiftsTrue).toBeLessThanOrEqual(0.1);
    expect(s.gear).toBeGreaterThanOrEqual(0.85);
    expect(s.throttle).toBeGreaterThanOrEqual(0.85);
  });

  // the #911's profile has had real ratios since 24 October 2026 (the case study's record, 4.20): this is it without them, as a car whose
  // ratios are not known
  it('without gear ratios (the #911 without its ratios) the gear is counted from the lowest gear heard', { timeout: 300000 }, () => {
    const bare: CarProfile = { ...carById('manthey-911-gt3r-992'), id: 'manthey-no-ratios', ratios: undefined, finalDrive: undefined, tyreCircumference: undefined, upshiftHeard: undefined, climbCurve: undefined };
    const s = score({ track: 'short', laps: 3, vary: 1, seed: 5, traffic: false }, bare);
    line('short laps, no traffic, no ratios', s);
    expect(s.rpm).toBeGreaterThanOrEqual(0.9);
    expect(s.gearFromBottom, 'gear from the bottom').toBeGreaterThanOrEqual(0.9);
    expect(Number.isNaN(s.last.scalars.carSpeed), 'no speed without ratios').toBe(true);
    expect(s.last.steps.filter(Number.isFinite).length, 'ratio steps learned from the upshifts').toBeGreaterThanOrEqual(3);
  });
});

/** an engine sweeping from r0 to r1 rpm: the firing orders (multiples of 3), the bank orders (1.5, 4.5 …) at `bank` and the cycle
 *  orders (0.5, 1, 2 …) at `cycle`, with a little noise */
function sweep(r0: number, r1: number, secs: number, bank: number, cycle: number): Float32Array {
  const n = secs * SR, x = new Float32Array(n);
  let ph = 0, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const rpm = r0 + (r1 - r0) * (i / n);
    ph += (2 * Math.PI * (rpm / 60) * 0.5) / SR;
    let s = 0;
    for (let k = 1; k <= 60 && (k * 0.5 * rpm) / 60 < 5000; k++) {
      const w = k % 6 === 0 ? 1 : k % 3 === 0 ? bank : cycle;
      if (w) s += (w / Math.sqrt(k * 0.5)) * Math.sin(k * ph);
    }
    x[i] = 0.1 * s + 0.003 * rnd();
  }
  return x;
}

// The review of 21 October: with weak half-orders, 3,000 to 4,600 rpm (the pit lane, Code 60, overrun) read double on every frame,
// sure of itself. The short window cannot tell half-orders 25 Hz apart; low rpms are now read from a longer one.
describe('low rpm (pit lane, Code 60) reads the rpm, not double it', () => {
  for (const [bank, cycle] of [[0.15, 0], [0.5, 0], [0.15, 0.3]]) {
    it(`half-orders at ${bank}, cycle orders at ${cycle}`, { timeout: 60000 }, () => {
      const x = sweep(3000, 4600, 12, bank, cycle), an = new EngineAnalyser(SR, carById('manthey-911-gt3r-992'));
      const frames: EngineFrame[] = [];
      for (let i = 0; i < x.length; i += 1024) { an.push(x.subarray(i, i + 1024)); frames.push(...an.read().frames); }
      const ev = frames.filter((f) => f.t > 1.5), truth = (t: number) => 3000 + 1600 * (t / 12);
      const ok = ev.filter((f) => Math.abs(f.rpm / truth(f.t) - 1) < 0.02).length / ev.length;
      const double = ev.filter((f) => Math.abs(f.rpm / truth(f.t) - 2) < 0.06).length / ev.length;
      console.log(`low rpm sweep, half-orders ${bank}, cycle ${cycle}: right ${(ok * 100).toFixed(1)}%, double ${(double * 100).toFixed(1)}%`);
      expect(ok).toBeGreaterThanOrEqual(0.9);
      expect(double).toBeLessThan(0.02);
    });
  }
});

// The first real AMG GT3 onboard (Daytona, 2026): flat out in top gear on the banking, the revs creep up by about 0.4 % a second
// for ten seconds and more, and the motion cue (a held note is not an engine) took the confidence to nothing every lap.
describe('flat out in top gear, the revs creeping, is still an engine', () => {
  it('a climb through a gear, then 15 s creeping at 0.3 % a second', { timeout: 60000 }, () => {
    const a = sweep(5800, 7000, 3, 0.5, 0.3), b = sweep(7000, 7350, 15, 0.5, 0.3), x = new Float32Array(a.length + b.length);
    x.set(a); x.set(b, a.length);
    const an = new EngineAnalyser(SR, carById('manthey-911-gt3r-992')), frames: EngineFrame[] = [];
    for (let i = 0; i < x.length; i += 1024) { an.push(x.subarray(i, i + 1024)); frames.push(...an.read().frames); }
    const ev = frames.filter((f) => f.t > 5), truth = (t: number) => 7000 + 350 * ((t - 3) / 15);
    const ok = ev.filter((f) => Math.abs(f.rpm / truth(f.t) - 1) < 0.02).length / ev.length;
    const sure = ev.filter((f) => f.conf > 0.5).length / ev.length;
    console.log(`creeping in top gear: rpm right ${(ok * 100).toFixed(1)}%, sure ${(sure * 100).toFixed(1)}%`);
    expect(ok).toBeGreaterThanOrEqual(0.95);
    expect(sure).toBeGreaterThanOrEqual(0.9);
  });
});

// A real 911 GT3 R's onboard on the Nordschleife (2026-10-24): flat out on the Döttinger Höhe the car is at its top speed and
// the revs stop creeping altogether (8,630 to 8,750 rpm for 20 s), and the confidence fell from 0.98 to nothing.
describe('flat out at top speed, the revs flat, is still an engine', () => {
  it('a climb through a gear, then 25 s flat at 8,700 rpm', { timeout: 60000 }, () => {
    const a = sweep(7400, 8700, 3, 0.5, 0.3), b = sweep(8700, 8700, 25, 0.5, 0.3), x = new Float32Array(a.length + b.length);
    x.set(a); x.set(b, a.length);
    const an = new EngineAnalyser(SR, carById('manthey-911-gt3r-992')), frames: EngineFrame[] = [];
    for (let i = 0; i < x.length; i += 1024) { an.push(x.subarray(i, i + 1024)); frames.push(...an.read().frames); }
    const ev = frames.filter((f) => f.t > 5);
    const ok = ev.filter((f) => Math.abs(f.rpm / 8700 - 1) < 0.02).length / ev.length;
    const sure = ev.filter((f) => f.conf > 0.5).length / ev.length;
    console.log(`flat at top speed: rpm right ${(ok * 100).toFixed(1)}%, sure ${(sure * 100).toFixed(1)}%`);
    expect(ok).toBeGreaterThanOrEqual(0.95);
    expect(sure).toBeGreaterThanOrEqual(0.9);
  });
});

// The wrong car chosen (synthetic Monza, 2026-10-24): what the analyser reported, heard as each car
describe('a wrong car is noticed from its shifts and its limiter', () => {
  const ups = (rpm: number) => Array.from({ length: 12 }, (_, i) => rpm + (i % 3) * 40);
  it('its own car passes', () => {
    expect(carMismatch(ups(7111), 0, carById('synthetic-v8'))).toBeNull();
    expect(carMismatch(ups(8428), 0, carById('synthetic-v10'))).toBeNull();
    expect(carMismatch(ups(8970), 0, carById('manthey-911-gt3r-992'))).toBeNull();
  });
  it('a V8 heard as the flat-six reads high, as the V10 low; a V10 heard as the flat-six low', () => {
    expect(carMismatch(ups(9480), 0, carById('manthey-911-gt3r-992'))?.dir).toBe('higher');
    expect(carMismatch(ups(5690), 0, carById('synthetic-v10'))?.dir).toBe('lower');
    expect(carMismatch(ups(7022), 0.01, carById('manthey-911-gt3r-992'))?.dir).toBe('lower');
  });
  it('a flat-six heard as the V8 piles up over the limiter', () => {
    expect(carMismatch(ups(7300), 0.42, carById('synthetic-v8'))?.dir).toBe('higher');
  });
  it('too few shifts say nothing', () => expect(carMismatch([9480, 9500], 0, carById('manthey-911-gt3r-992'))).toBeNull());
  it('a V8 heard as the flat-six is offered a V8 first; a V10 heard as one has a V10 among the layouts offered', () => {
    const v8 = carSuggest(ups(9480), carById('manthey-911-gt3r-992'), CARS);
    expect(v8.length).toBeGreaterThan(0);
    expect(v8[0].cylinders).toBe(8);
    // a V10 heard as a six: a six that shifts near 7,000 fits as well (the shift point can't tell them apart), so the V10 is
    // among the layouts offered, not necessarily first
    const v10 = carSuggest(ups(7022), carById('manthey-911-gt3r-992'), CARS);
    expect([...new Set(v10.map((c) => c.cylinders))].slice(0, 3)).toContain(10);
  });
});

describe('the dash decides the gear on the last 90 s where the car’s climb was measured, counts it elsewhere', () => {
  it('the real 992 and the game’s are decided; the synthetic six (clean sound, no measured climb) is counted', () => {
    expect(new Dash(carById('manthey-911-gt3r-992')).mode).toBe('window');
    expect(new Dash(carById('porsche-992-gt3r-acc')).mode).toBe('window');
    expect(new Dash(carById('synthetic-flat6')).mode).toBe('count');
  });
  it('a car without ratios is always counted', () => {
    const c = carById('manthey-911-gt3r-992');
    expect(new Dash({ ...c, ratios: undefined, finalDrive: undefined, tyreCircumference: undefined }).mode).toBe('count');
  });
});

describe('music reads as not an engine', () => {
  for (const id of ['cadence', 'layers', 'groove', 'form', 'pluck', 'swell']) {
    it(id, { timeout: 60000 }, () => {
      const { L, R } = SIGNALS.find((s) => s.id === id)!.render(SR);
      const an = new EngineAnalyser(SR, CARS[0]);
      const conf: number[] = [];
      for (let rep = 0; rep < 2; rep++) for (let i = 0; i < L.length; i += 1024) { an.push(L.subarray(i, i + 1024), R.subarray(i, i + 1024)); for (const f of an.read().frames) conf.push(f.conf); }
      const mean = conf.reduce((a, b) => a + b, 0) / conf.length, sure = conf.filter((c) => c > 0.5).length / conf.length;
      expect(mean, 'mean confidence').toBeLessThan(0.2);
      expect(sure, 'share of frames read with confidence above 0.5').toBeLessThan(0.05);
    });
  }
});

describe('car profiles', () => {
  it('every profile is complete and consistent', () => {
    const ids = new Set<string>();
    for (const c of CARS) {
      expect(ids.has(c.id), c.id).toBe(false); ids.add(c.id);
      expect(c.cylinders).toBeGreaterThan(0);
      expect([2, 4]).toContain(c.strokes);
      expect(c.minRpm).toBeLessThan(c.idleRpm);
      expect(c.limiterRpm).toBeLessThanOrEqual(c.maxRpm);
      expect(c.shiftLights.from).toBeLessThan(c.shiftLights.to);
      expect(c.upshiftRatio.min).toBeLessThan(c.upshiftRatio.max);
      if (c.ratios) {
        expect(c.ratios.length, `${c.id} has a ratio per gear`).toBe(c.gears);
        c.ratios.slice(1).forEach((r, i) => expect(r / c.ratios![i]).toBeGreaterThanOrEqual(c.upshiftRatio.min));
      }
    }
  });
});
