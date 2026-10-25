// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// A stint, from the sound: every lap's time, the neutralisations and stops, and changes in how the car is driven. For an
// endurance race, where an onboard runs for hours.
//
//   · laps: the first whole lap heard is the template; each next lap is the stretch of run, starting where the last ended, whose
//     speed (or revs, whichever the lap repeats on) matches the template best when stretched to its length. A lap that matches poorly was
//     disturbed (a Code 60 zone, traffic, a pit stop) and says so;
//   · held speed: the speed held within a few km/h between 40 and 100 km/h for ten seconds or more (a Code 60 zone, the pit
//     lane's limiter); without speed, the revs held as steady well below the shift point;
//   · quiet: no engine heard for ten seconds or more (a stop, or the broadcast's sound elsewhere);
//   · habit: the shift point, lap by lap; a step in it between one run of laps and the next, far larger than its scatter within
//     each, is a change in how the car is driven: a driver change, or an instruction (save fuel, look after the engine).

import type { LimiterHit, ShiftEvent } from './engine';
import type { Reconstruction } from './track';

export interface StintLap { n: number; start: number; time: number; fit: number; shiftRpm: number; top: number; limiter: number }
export interface StintEvent { kind: 'held' | 'quiet'; from: number; to: number; kmh: number | null }
export interface Stint { laps: StintLap[]; events: StintEvent[]; habit: { atLap: number; before: number; after: number; t: number } | null }

const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

// the correlation over the moments both know, and only where they know most of them (a few known moments in a stretch of
// unknowns, such as a Code 60 zone, can line up by chance)
function corr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { n++; sa += a[i]; sb += b[i]; }
  if (n < 10 || n < 0.5 * a.length) return -1;
  const ma = sa / n, mb = sb / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return ab / (Math.sqrt(aa * bb) || 1);
}

export function stint(rec: Reconstruction, shifts: ShiftEvent[], limiter: LimiterHit[], shiftPoint: number): Stint {
  const h = rec.heard, rate = h.rate, n = h.rpm.length;
  // the laps are matched on what the lap was found to repeat on: the speed, or the revs (speed from physics without the ratios
  // can wander from lap to lap where the revs repeat cleanly)
  const trace = rec.lap?.on === 'speed' ? rec.speed : h.rpm.map((x) => (x > 0 ? Math.log(x) : NaN));
  const laps: StintLap[] = [];
  if (rec.lap) {
    // the first lap's opening third is the key; every place the run matches it well is the start of a lap. Found independently,
    // so one disturbed lap (a Code 60 zone, a pit stop) makes that lap long, and leaves the others alone
    const T = Math.round(rec.lap.time * rate), K = Math.round(T / 3);
    // the key is taken from the lap most like the one after it (a stream opens with menus, practice and the grid, where the
    // first sure moment is no lap at all), else from where the laps were found to begin
    let b0 = Math.max(0, Math.round((rec.lap.start - h.t0) * rate)), bestLike = -2;
    for (let b = 0; b + 2 * T <= n; b += Math.max(1, Math.round(T / 6))) {
      const a = trace.subarray(b, b + T), c = trace.subarray(b + T, b + 2 * T);
      let known = 0;
      for (let i = 0; i < T; i++) if (Number.isFinite(a[i]) && Number.isFinite(c[i])) known++;
      if (known < 0.9 * T) continue;
      const like = corr(Array.from(a), c);
      if (like > bestLike) { bestLike = like; b0 = b; }
    }
    const key = Array.from(trace.subarray(b0, b0 + K));
    const fit = new Float64Array(n).fill(-2);
    for (let b = 0; b + K <= n; b++) fit[b] = corr(key, trace.subarray(b, b + K));
    // the strongest matches first, each at least 0.85 of a lap from every one already taken, down to 0.7. On the first real
    // race laps (the AMG GT3 at Daytona) the true starts matched at 0.71 to 0.96 and the best mid-lap resemblance at 0.64 to
    // 0.70; a mid-lap resemblance lies within half a lap of a true start, which is taken first and keeps it out
    const peaks: number[] = [];
    for (let b = 1; b + K < n; b++) if (fit[b] >= 0.7 && fit[b] >= fit[b - 1] && fit[b] > fit[b + 1]) peaks.push(b);
    peaks.sort((a, b) => fit[b] - fit[a]);
    const starts: number[] = [];
    for (const b of peaks) if (starts.every((s) => Math.abs(b - s) >= 0.85 * T)) starts.push(b);
    starts.sort((a, b) => a - b);
    // each start between samples: the top of a parabola through the match and its neighbours
    const fine = (b: number) => { const p = fit[b - 1], q = fit[b], r = fit[b + 1], den = p - 2 * q + r; return den < 0 ? b + Math.max(-0.5, Math.min(0.5, (0.5 * (p - r)) / den)) : b; };
    for (let k = 0; k + 1 < starts.length; k++) {
      const a0 = starts[k], a1 = starts[k + 1], t0 = h.t0 + fine(a0) / rate, t1 = h.t0 + fine(a1) / rate;
      const ups = shifts.filter((x) => x.dir > 0 && x.t >= t0 && x.t < t1).map((x) => x.before);
      let top = NaN;
      for (let i = a0; i < a1; i++) if (Number.isFinite(rec.speed[i]) && !(rec.speed[i] <= top)) top = rec.speed[i];
      // how well the whole lap matches the first, laid at its own length: a disturbed lap matches poorly
      const seg = new Float64Array(T);
      for (let i = 0; i < T; i++) {
        const x = a0 + (i * (a1 - a0)) / T, j = Math.floor(x), p = trace[j], q = j + 1 < n ? trace[j + 1] : NaN;
        // between two known moments, the line between them; beside an unknown one, the known one
        seg[i] = Number.isFinite(p) && Number.isFinite(q) ? p + (x - j) * (q - p) : Number.isFinite(p) ? p : q;
      }
      laps.push({ n: k + 1, start: t0, time: t1 - t0, fit: corr(trace.subarray(b0, b0 + T), seg), shiftRpm: ups.length >= 3 ? median(ups) : NaN, top, limiter: limiter.filter((x) => x.t >= t0 && x.t < t1).length });
    }
  }

  // held speed, and quiet. Held is found on the revs (they are read even when the reading is unsure: a held engine note is
  // exactly what the analyser's motion cue doubts), steady within 3 % for ten seconds, well below the shift point; its speed
  // where the speed is known
  const events: StintEvent[] = [];
  const minRun = 10 * rate;
  for (let i = 0; i < n;) {
    const r = h.rpm[i];
    if (!(r > 0 && r < 0.75 * shiftPoint)) { i++; continue; }
    let j = i;
    while (j + 1 < n && h.rpm[j + 1] > 0 && Math.abs(h.rpm[j + 1] / r - 1) < 0.03) j++;
    if (j - i >= minRun) {
      // its speed only where the speed was known for most of it (a held note is where the reading is least sure)
      const vs = Array.from(rec.speed.subarray(i, j + 1)), v = median(vs);
      const share = vs.filter(Number.isFinite).length / vs.length;
      events.push({ kind: 'held', from: h.t0 + i / rate, to: h.t0 + j / rate, kmh: share >= 0.5 && Number.isFinite(v) ? Math.round(v) : null });
    }
    i = j + 1;
  }
  for (let k = 0; k < n;) {
    if (h.conf[k] >= 0.1) { k++; continue; }
    let j = k;
    while (j + 1 < n && h.conf[j + 1] < 0.1) j++;
    const a0 = h.t0 + k / rate, a1 = h.t0 + j / rate;
    if (j - k >= minRun && !events.some((e) => e.kind === 'held' && e.from < a1 && e.to > a0)) events.push({ kind: 'quiet', from: a0, to: a1, kmh: null });
    k = j + 1;
  }
  events.sort((a, b) => a.from - b.from);

  // habit: the best place to split the laps' shift points in two, kept if the step is far larger than the scatter
  let habit: Stint['habit'] = null;
  const sp = laps.filter((l) => Number.isFinite(l.shiftRpm));
  if (sp.length >= 6) {
    let best = { z: 0, k: -1, a: 0, b: 0 };
    for (let k = 3; k <= sp.length - 3; k++) {
      const A = sp.slice(0, k).map((l) => l.shiftRpm), B = sp.slice(k).map((l) => l.shiftRpm);
      const ma = A.reduce((x, y) => x + y, 0) / A.length, mb = B.reduce((x, y) => x + y, 0) / B.length;
      const va = A.reduce((x, y) => x + (y - ma) ** 2, 0), vb = B.reduce((x, y) => x + (y - mb) ** 2, 0);
      const sd = Math.sqrt((va + vb) / Math.max(1, A.length + B.length - 2)) || 1;
      const z = Math.abs(ma - mb) / sd;
      if (z > best.z) best = { z, k, a: ma, b: mb };
    }
    if (best.z >= 4 && Math.abs(best.a - best.b) >= 100) habit = { atLap: sp[best.k].n, before: Math.round(best.a), after: Math.round(best.b), t: sp[best.k].start };
  }
  return { laps, events, habit };
}
