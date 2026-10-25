// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// Is this the car being listened to? The analyser turns the engine's firing into revs through the car's cylinder count, so
// heard as the wrong car an engine reads at a fixed multiple of its revs (a V8 heard as a flat-six reads 4/3 high, as a V10 4/5
// low) and the gear and speed follow it wrong. Synthetic Monza (2026-10-24): heard as its own car, the median upshift sat in the
// car's shift lights and no frame was over the limiter; heard as the wrong car, the median upshift sat 5 to 25 % outside the
// lights, or 40 % of frames were over the limiter (a flat-six heard as a V8: the revs it can't reach pile up at the top).

import type { CarProfile } from './cars';

export interface Mismatch { dir: 'higher' | 'lower'; rpm: number }

/** ups: the rpm before each upshift heard lately; over: the share of sure frames above the car's limiter */
export function carMismatch(ups: number[], over: number, car: CarProfile): Mismatch | null {
  if (over > 0.15) return { dir: 'higher', rpm: car.limiterRpm };
  if (ups.length < 6) return null;
  const s = [...ups].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
  if (med > car.shiftLights.to * 1.04) return { dir: 'higher', rpm: med };
  if (med < car.shiftLights.from * 0.93) return { dir: 'lower', rpm: med };
  return null;
}

/** which cars the heard upshifts would fit, if the chosen car is wrong. The analyser locks the chosen car's firing (car.cylinders
 *  / 2 a revolution, or twice that) onto the engine's own (c / 2, or twice): a V8 heard as a flat-six reads 4/3 of its revs, a
 *  V10 heard as one 5/6 (its fifth order taken for the six's sixth). So each library car is tried at each such ratio, simplest
 *  first, and kept when the upshifts then sit in its shift lights. Nearest first; the test cars and the generic profile are
 *  left out. */
export function carSuggest(ups: number[], car: CarProfile, cars: CarProfile[]): CarProfile[] {
  if (ups.length < 6) return [];
  const s = [...ups].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
  const fits: [number, CarProfile][] = [];
  for (const c of cars) {
    if (c.id === car.id || c.id.startsWith('synthetic') || c.id === 'any-four-stroke') continue;
    const lo = c.shiftLights.from * 0.93, hi = c.shiftLights.to * 1.04;
    // heard = true × (c·m) / (car·n): the engine's m-th multiple of its firing taken for the chosen car's n-th
    let best = Infinity;
    for (const [m, n, cost] of [[1, 1, 0], [1, 2, 0.05], [2, 1, 0.05], [2, 3, 0.1], [3, 2, 0.1]]) {
      const rpm = (med * car.cylinders * n) / (c.cylinders * m);
      if (rpm >= lo && rpm <= hi) best = Math.min(best, cost + Math.abs(rpm - (c.shiftLights.from + c.shiftLights.to) / 2) / c.shiftLights.to);
    }
    if (Number.isFinite(best)) fits.push([best, c]);
  }
  return fits.sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}
