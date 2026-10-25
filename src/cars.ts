// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// Car profiles for the engine analyser (src/engine.ts): everything it needs to know about one car, as data. Nothing
// car-specific lives in the analyser's code; adding a car is adding an entry here (README, "Adding a car").

export interface CarProfile {
  id: string;
  /** shown to people */
  name: string;
  /** where the numbers come from, and what is not known */
  note: string;
  cylinders: number;
  /** 4 or 2 */
  strokes: number;
  /** the analyser listens for every multiple of half the firing order (for a flat-six 1.5, 3, 4.5, 6 …): the firing order's own
   *  multiples count 1, the ones between them this much (how strongly this car's microphone carries the half-orders) */
  halfOrderWeight: number;
  /** the cycle orders (every multiple of half an order that is neither of the above: 0.5, 1, 2, 2.5 … for a four-stroke): how
   *  much each adds to an rpm's score when it is heard. A four-stroke's sound repeats every two revolutions, so a real one sounds
   *  at all of them (the first real onboard heard had them as loud as the firing orders); they are a bonus to the rpm they belong
   *  to and never count against it, so a microphone without them reads (almost) as before. Optional, default 1. */
  cycleOrderWeight?: number;
  /** the lowest and highest rpm the tracker searches */
  minRpm: number;
  maxRpm: number;
  idleRpm: number;
  /** where the rev limiter cuts in */
  limiterRpm: number;
  /** shift lights: the first lamp lights at `from`, all are lit at `to` (the usual upshift point) */
  shiftLights: { from: number; to: number };
  gears: number;
  /** an upshift drops the rpm to this fraction of where it was (lowest and highest), a downshift raises it by the inverse */
  upshiftRatio: { min: number; max: number };
  /** the fastest the rpm moves within a gear, as a fraction of itself per second */
  maxSlew: number;
  /** optional: the gearbox ratios, first gear first. With them the gear is absolute; without them it is counted from the lowest gear heard. */
  ratios?: number[];
  /** optional: with the ratios and the tyre's rolling circumference, the speed */
  finalDrive?: number;
  /** metres */
  tyreCircumference?: number;
  /** optional, for speed without ratios (src/track.ts): on full power and not wheelspin-limited, the revs climb at
   *  a rate set by power, mass, drag and speed, so their rate gives the speed. Mass with driver and fuel (kg), peak power (kW),
   *  the power at an rpm as a share of the peak (points to interpolate), drag area (m²), rolling resistance (N) */
  massKg?: number;
  powerKw?: number;
  powerCurve?: [number, number][];
  cda?: number;
  rollingN?: number;
  /** the most it accelerates on full power, m/s² (the tyres' limit at low speed); unset where not measured */
  tractionMs2?: number;
  /** the drop in revs heard at each upshift from 1→2 on: after over before, and its spread (the log's, robust) (measured on
   *  HUD footage: it sits above the gearbox's true step); unset where not measured */
  upshiftHeard?: ([number, number] | undefined)[];
  /** its acceleration on full power by speed, [km/h, km/h per s], measured on HUD footage; unset where not measured */
  climbCurve?: [number, number][];
}

export const CARS: CarProfile[] = [
  {
    id: 'manthey-911-gt3r-992',
    name: 'Manthey #911 · Porsche 911 GT3 R (992)',
    note: '4.2-litre naturally aspirated flat-six, revs past 9,000 (about 9,400 at most), 6-speed sequential with paddle shifts. '
      + 'The gearbox is measured on real cars: the speed and gear on Porsche’s onboard overlay against the revs heard, 11 onboards of '
      + 'customer 992 GT3 Rs (the case study’s record, 4.20).',
    cylinders: 6, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 9600, idleRpm: 1500, limiterRpm: 9400,
    shiftLights: { from: 7800, to: 9000 },
    gears: 6,
    upshiftRatio: { min: 0.62, max: 0.9 },
    maxSlew: 0.6,
    // km/h per 1000 rpm, real 992 GT3 Rs (Car Collection, Lionspeed GP; 11 tuning onboards, each gear within 2 % across clips):
    // 12.06, 15.74, 19.48, 23.56, 27.30, 31.16 (ACC's 992: 3 to 4 % shorter in gears 1 to 4, the same in 5 and 6)
    ratios: [9.9502, 7.6239, 6.1602, 5.0934, 4.3956, 3.8511], finalDrive: 1, tyreCircumference: 2,
    // learned from the same 11 real onboards (815 upshifts,
    // 7636 moments on full power): the upshifts as heard, and the climb against the overlay's speed, which replace the guessed
    // power, mass and drag as the gear's anchor (the case study's record, 4.21)
    upshiftHeard: [[0.7902, 0.0198], [0.8121, 0.0121], [0.8352, 0.009], [0.864, 0.0062], [0.8817, 0.0056]],
    climbCurve: [[60, 15.8], [70, 19.36], [80, 21.33], [90, 22.3], [100, 21.71], [110, 17.21], [120, 17.67], [130, 16.89], [140, 14.92], [150, 13.36], [160, 13.23], [170, 12.74], [180, 11.25], [190, 10.2], [200, 9.79], [210, 6.89], [220, 6.57], [230, 6.12], [240, 5.48], [250, 4.27], [260, 3.34], [270, 9.07], [280, 11.9], [290, 11.9]],
    // public figures, and estimates where nothing is published: about 416 kW (565 PS) before Balance of Performance, 1,250 kg
    // minimum plus driver and fuel, a GT3 drag area; the power curve is a plausible shape for a high-revving flat-six
    massKg: 1360, powerKw: 405, cda: 1.1, rollingN: 200,
    powerCurve: [[3000, 0.32], [5000, 0.58], [6500, 0.78], [7800, 0.93], [8750, 1], [9400, 0.96]],
  },
  {
    id: 'mercedes-amg-gt3',
    name: 'Mercedes-AMG GT3 (Evo)',
    note: '6.2-litre naturally aspirated V8 (cross-plane), front-mid-engined, 6-speed sequential transaxle with paddle shifts, revs '
      + 'to about 7,300. Gear ratios, final drive and tyre size are not published: the gear is counted, the speed is worked out '
      + 'from the revs’ climb. Power and mass are estimates and move with each series’ Balance of Performance.',
    cylinders: 8, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 8000, idleRpm: 1200, limiterRpm: 7300,
    shiftLights: { from: 6200, to: 7000 },
    gears: 6,
    upshiftRatio: { min: 0.62, max: 0.92 },
    maxSlew: 0.6,
    // public figures and estimates: about 400 kW (550 PS) before Balance of Performance, 1,285 kg minimum plus driver and fuel,
    // a front-engined GT3's drag area; the power curve is a plausible shape for a big naturally aspirated V8 (a broad top end)
    massKg: 1400, powerKw: 400, cda: 1.15, rollingN: 200,
    powerCurve: [[3000, 0.45], [4500, 0.7], [5500, 0.88], [6500, 1], [7300, 0.96]],
  },
  {
    id: 'synthetic-flat6',
    name: 'Test car · the synthetic flat-six',
    note: 'The car the synthetic onboard (src/generator.ts) is made with: the same engine as the 911 GT3 R, with made-up but '
      + 'plausible gear ratios, final drive and tyres, so its gear is absolute and its speed is known.',
    cylinders: 6, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 9600, idleRpm: 1500, limiterRpm: 9400,
    shiftLights: { from: 7800, to: 9000 },
    gears: 6,
    upshiftRatio: { min: 0.62, max: 0.9 },
    maxSlew: 0.6,
    ratios: [3.8, 2.774, 2.164, 1.774, 1.517, 1.327],
    finalDrive: 3.0,
    tyreCircumference: 2.17,
    // the lap simulation's own car (src/generator.ts)
    massKg: 1300, powerKw: 390, cda: 1.15, rollingN: 180,
    powerCurve: [[0, 0.55], [4730, 0.55], [8600, 1], [10000, 1]],
  },
  {
    id: 'synthetic-v8',
    name: 'Test car · a synthetic V8 (a front-engined GT3 in the manner of the AMG)',
    note: 'For the classifier’s tests: a naturally aspirated cross-plane V8 that shifts at 7,100 rpm, with made-up but plausible ratios.',
    cylinders: 8, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 8200, idleRpm: 1200, limiterRpm: 7400,
    shiftLights: { from: 6200, to: 7100 },
    gears: 6,
    upshiftRatio: { min: 0.65, max: 0.92 },
    maxSlew: 0.6,
    ratios: [3.1, 2.3, 1.82, 1.5, 1.29, 1.14], finalDrive: 3.0, tyreCircumference: 2.17,
    massKg: 1320, powerKw: 410, cda: 1.15, rollingN: 180,
    powerCurve: [[0, 0.35], [4000, 0.7], [5500, 0.92], [6500, 1], [7400, 0.95]],
  },
  {
    id: 'synthetic-v10',
    name: 'Test car · a synthetic V10 (a mid-engined GT3 in the manner of the Huracán)',
    note: 'For the classifier’s tests: a naturally aspirated V10 that shifts at 8,400 rpm, with made-up but plausible ratios.',
    cylinders: 10, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 9400, idleRpm: 1200, limiterRpm: 8700,
    shiftLights: { from: 7400, to: 8400 },
    gears: 6,
    upshiftRatio: { min: 0.65, max: 0.92 },
    maxSlew: 0.6,
    ratios: [3.2, 2.4, 1.9, 1.6, 1.4, 1.24], finalDrive: 3.2, tyreCircumference: 2.17,
    massKg: 1300, powerKw: 405, cda: 1.15, rollingN: 180,
    powerCurve: [[0, 0.3], [5000, 0.7], [7000, 0.93], [8000, 1], [8700, 0.97]],
  },
];

// The cars of Assetto Corsa Competizione, as the simulator models them: its cars are the teacher for the real ones, because its
// HUD shows the gear, the speed and the rpm on every frame, so the game is a source of truth for the method. The engine is
// as published; the gearbox, shift point and rev limit are measured from the HUD of corgido's PS5 captures and YouTube streams.
// measured: each gear's speed per rpm (as overall ratios for a 2 m rolling circumference, final drive 1: only their product
// matters), the shift point (the median rpm at an upshift) and the rev limit (the highest rpm, 99.5th percentile), from the HUD
// of corgido's captures over every clip
// the most an ACC car accelerates on full power: about 5 m/s² at 80 to 120 km/h, measured on streamed footage's HUD
const ACC_TRACTION = 5;
const ACC_MEASURED = 'Measured from the HUD: the gearbox, the shift point and the rev limit; power and mass are estimates.';
CARS.push(
  {
    id: 'porsche-992-gt3r-acc',
    name: 'ACC · Porsche 911 GT3 R (992)',
    note: `4.2-litre naturally aspirated flat-six, 6-speed sequential. ${ACC_MEASURED} 4.8 hours, 18 clips, 2,469 upshifts.`,
    cylinders: 6, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 9600, idleRpm: 1500, limiterRpm: 9250,
    shiftLights: { from: 7800, to: 9040 },
    gears: 6, upshiftRatio: { min: 0.62, max: 0.92 }, maxSlew: 0.6,
    // km/h per 1000 rpm from the HUD: 11.56, 15.11, 18.88, 22.88, 27.01, 31.13
    ratios: [10.3806, 7.9418, 6.3559, 5.2448, 4.4428, 3.8548], finalDrive: 1, tyreCircumference: 2,
    massKg: 1360, powerKw: 405, cda: 1.1, rollingN: 200, tractionMs2: ACC_TRACTION,
    // learned from the HUD footage (3226 upshifts, 31302 moments on full power, 18 runs, corgido's hour at the Red Bull Ring among them: the case study's record, 4.25)
    upshiftHeard: [[0.8039, 0.0356], [0.82, 0.0172], [0.8337, 0.01], [0.8504, 0.0055], [0.8663, 0.0042]],
    climbCurve: [[50, 5.33], [60, 6.07], [70, 11.48], [80, 18.29], [90, 19.35], [100, 17.87], [110, 17.26], [120, 17.33], [130, 16.11], [140, 15], [150, 14.57], [160, 13.94], [170, 13.08], [180, 10.65], [190, 10.29], [200, 9.52], [210, 7.89], [220, 6.75], [230, 6.27], [240, 5.65], [250, 4.2], [260, 3.79], [270, 3.39], [280, 3.33]],
    powerCurve: [[3000, 0.32], [5000, 0.58], [6500, 0.78], [7800, 0.93], [8750, 1], [9400, 0.96]],
  },
  {
    id: 'porsche-911-cup-acc',
    name: 'ACC · Porsche 911 GT3 Cup',
    note: `A one-make Cup car: naturally aspirated flat-six, 6-speed sequential, no traction control. Which generation (991 II or 992) is not yet known. ${ACC_MEASURED} 0.4 hours, 2 clips, 264 upshifts.`,
    cylinders: 6, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 9200, idleRpm: 1500, limiterRpm: 8560,
    shiftLights: { from: 7600, to: 8390 },
    gears: 6, upshiftRatio: { min: 0.62, max: 0.92 }, maxSlew: 0.6,
    // km/h per 1000 rpm from the HUD: 11.29, 14.36, 18.52, 23.10, 27.98, 32.83
    ratios: [10.6289, 8.3565, 6.4795, 5.1948, 4.2888, 3.6552], finalDrive: 1, tyreCircumference: 2,
    massKg: 1360, powerKw: 375, cda: 0.85, rollingN: 200, tractionMs2: ACC_TRACTION,
    // learned from the HUD footage (905 upshifts, 6551 moments on full power, 3 runs)
    upshiftHeard: [[0.783, 0.0889], [0.7985, 0.0265], [0.8159, 0.0141], [0.8347, 0.0071], [0.8553, 0.0048]],
    climbCurve: [[50, 8.04], [60, 12.4], [70, 14.78], [80, 16.97], [90, 21], [100, 21.99], [110, 19.88], [120, 17.06], [130, 16.26], [140, 16.6], [150, 16.06], [160, 13.25], [170, 11.87], [180, 11.31], [190, 10.53], [200, 8.32], [210, 8.04], [220, 7.75], [230, 7.09], [240, 6.53]],
    powerCurve: [[3000, 0.35], [5000, 0.6], [6500, 0.8], [7800, 0.95], [8400, 1], [8800, 0.97]],
  },
  {
    id: 'bmw-m4-gt3-acc',
    name: 'ACC · BMW M4 GT3',
    note: `3.0-litre twin-turbocharged straight-six, 6-speed sequential; revs lower than the naturally aspirated cars. ${ACC_MEASURED} 1.1 hours, 3 clips, 526 upshifts (6th gear from 37 moments only).`,
    cylinders: 6, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 7900, idleRpm: 1200, limiterRpm: 6950,
    shiftLights: { from: 6300, to: 6850 },
    gears: 6, upshiftRatio: { min: 0.62, max: 0.92 }, maxSlew: 0.6,
    // km/h per 1000 rpm from the HUD: 14.54, 19.08, 24.73, 30.31, 36.48, 41.75
    ratios: [8.2531, 6.2893, 4.8524, 3.9591, 3.2895, 2.8743], finalDrive: 1, tyreCircumference: 2,
    massKg: 1400, powerKw: 430, cda: 1.15, rollingN: 200, tractionMs2: ACC_TRACTION,
    // learned from the HUD footage (2637 upshifts, 22093 moments on full power, 10 runs)
    upshiftHeard: [[0.7807, 0.0355], [0.7926, 0.0202], [0.8353, 0.0155], [0.8387, 0.0095], [0.8757, 0.0052]],
    climbCurve: [[50, 4.1], [60, 7.13], [70, 13.68], [80, 18.02], [90, 16.6], [100, 14.97], [110, 17.77], [120, 18.87], [130, 14], [140, 14.24], [150, 15.44], [160, 14.82], [170, 12.8], [180, 11.69], [190, 11.64], [200, 10.78], [210, 8.68], [220, 7.55], [230, 7.23], [240, 6.36], [250, 5.73], [260, 3.97]],
    powerCurve: [[2500, 0.6], [3500, 0.85], [4500, 0.97], [5500, 1], [6500, 0.98], [7400, 0.9]],
  },
  {
    id: 'bentley-continental-gt3-2018-acc',
    name: 'ACC · Bentley Continental GT3 (2018)',
    note: `4.0-litre twin-turbocharged V8, 6-speed sequential. From 3 YouTube streams (720p), 2,638 upshifts. ${ACC_MEASURED}`,
    cylinders: 8, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 7900, idleRpm: 1200, limiterRpm: 7370,
    shiftLights: { from: 6500, to: 7150 },
    gears: 6, upshiftRatio: { min: 0.62, max: 0.92 }, maxSlew: 0.6,
    // km/h per 1000 rpm from the HUD: 14.61, 19.28, 24.65, 29.35, 34.11, 38.72
    ratios: [8.2136, 6.2241, 4.8682, 4.0886, 3.5180, 3.0992], finalDrive: 1, tyreCircumference: 2,
    massKg: 1420, powerKw: 410, cda: 1.2, rollingN: 200, tractionMs2: ACC_TRACTION,
    // learned from the HUD footage (2368 upshifts, 18899 moments on full power, 3 runs)
    upshiftHeard: [[0.8281, 0.0569], [0.8087, 0.0281], [0.8515, 0.0161], [0.8671, 0.0081], [0.8826, 0.0048]],
    climbCurve: [[60, 4.79], [70, 16.34], [80, 20.74], [90, 21.78], [100, 16.16], [110, 14.89], [120, 15.94], [130, 15.96], [140, 14.3], [150, 13.69], [160, 14.24], [170, 13.67], [180, 11.94], [190, 10.5], [200, 9.79], [210, 8.68], [220, 7.4], [230, 6.87], [240, 6.29], [250, 5.25], [260, 3.1]],
    powerCurve: [[2500, 0.6], [3500, 0.85], [4500, 0.97], [5500, 1], [6500, 0.97], [7300, 0.9]],
  },
  {
    id: 'ford-mustang-gt3-acc',
    name: 'ACC · Ford Mustang GT3',
    note: `5.4-litre naturally aspirated V8, 6-speed sequential. From 1 YouTube stream (720p), 160 upshifts; 6th gear never seen, its ratio carried from the 4th-to-5th step. ${ACC_MEASURED}`,
    cylinders: 8, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 8700, idleRpm: 1200, limiterRpm: 8210,
    shiftLights: { from: 7500, to: 8160 },
    gears: 6, upshiftRatio: { min: 0.62, max: 0.92 }, maxSlew: 0.6,
    // km/h per 1000 rpm from the HUD: 14.49, 19.51, 24.10, 29.16, 34.14, 39.75
    ratios: [8.2816, 6.1507, 4.9793, 4.1152, 3.5149, 3.0189], finalDrive: 1, tyreCircumference: 2,
    massKg: 1400, powerKw: 400, cda: 1.15, rollingN: 200, tractionMs2: ACC_TRACTION,
    // learned from the HUD footage (148 upshifts, 1262 moments on full power, 1 runs)
    upshiftHeard: [[0.8164, 0.0477], [0.8373, 0.0153], [0.8415, 0.0084], [0.8613, 0.0042]],
    climbCurve: [[100, 22.89], [110, 22.94], [120, 18.53], [130, 16.2], [140, 17.38], [150, 17.63], [160, 16.27], [170, 12.89], [180, 12.85], [190, 12.27], [200, 9.7], [210, 7.95], [220, 8.28], [230, 7.99], [240, 6.76]],
    powerCurve: [[3000, 0.4], [4500, 0.65], [6000, 0.88], [7200, 1], [8200, 0.95]],
  },
  {
    id: 'aston-martin-vantage-gt4-acc',
    name: 'ACC · Aston Martin Vantage AMR GT4',
    note: `4.0-litre twin-turbocharged V8, a GT4: lower power, a wide-spaced gearbox. From 1 YouTube stream (720p), 1,081 upshifts. ${ACC_MEASURED}`,
    cylinders: 8, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 7500, idleRpm: 1200, limiterRpm: 6975,
    shiftLights: { from: 6300, to: 6910 },
    gears: 6, upshiftRatio: { min: 0.62, max: 0.94 }, maxSlew: 0.6,
    // km/h per 1000 rpm from the HUD: 8.93, 12.79, 18.69, 23.98, 31.05, 39.80
    ratios: [13.4378, 9.3823, 6.4205, 5.0042, 3.8647, 3.0151], finalDrive: 1, tyreCircumference: 2,
    massKg: 1530, powerKw: 350, cda: 1.0, rollingN: 200, tractionMs2: ACC_TRACTION,
    // learned from the HUD footage (1034 upshifts, 9896 moments on full power, 1 runs)
    upshiftHeard: [[0.697, 0.0959], [0.7157, 0.0409], [0.7978, 0.0179], [0.7853, 0.0079], [0.7851, 0.0033]],
    climbCurve: [[60, 14.08], [70, 17.59], [80, 17.05], [90, 14.65], [100, 15.98], [110, 17.04], [120, 14.73], [130, 11.7], [140, 11.58], [150, 11.99], [160, 10.92], [170, 9.2], [180, 8.71], [190, 8.38], [200, 7.4], [210, 6.45], [220, 5.51], [230, 4.91], [240, 4], [250, 3.8], [260, 3.53]],
    powerCurve: [[2500, 0.6], [3500, 0.85], [4500, 0.97], [5500, 1], [6500, 0.97], [7300, 0.9]],
  },
  {
    id: 'mercedes-amg-gt4-acc',
    name: 'ACC · Mercedes-AMG GT4',
    note: `4.0-litre twin-turbocharged V8, a GT4. From 1 YouTube stream (720p), 653 upshifts; its 5th-to-6th step is a small one (0.92). ${ACC_MEASURED}`,
    cylinders: 8, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 7500, idleRpm: 1200, limiterRpm: 6915,
    shiftLights: { from: 6200, to: 6780 },
    gears: 6, upshiftRatio: { min: 0.62, max: 0.95 }, maxSlew: 0.6,
    // km/h per 1000 rpm from the HUD: 13.83, 17.55, 23.21, 29.27, 34.65, 37.80
    ratios: [8.6768, 6.8376, 5.1702, 4.0998, 3.4632, 3.1746], finalDrive: 1, tyreCircumference: 2,
    massKg: 1520, powerKw: 350, cda: 1.0, rollingN: 200, tractionMs2: ACC_TRACTION,
    // learned from the HUD footage (648 upshifts, 6504 moments on full power, 1 runs)
    upshiftHeard: [[0.7579, 0.0974], [0.7641, 0.0147], [0.8057, 0.0138], [0.8467, 0.0061], [0.919, 0.003]],
    climbCurve: [[70, 12], [80, 9.72], [90, 9.34], [100, 10.09], [110, 10.31], [120, 10.45], [130, 10.87], [140, 11.08], [150, 10.24], [160, 8.5], [170, 8.57], [180, 8.6], [190, 7.96], [200, 6.55], [210, 6.07], [220, 5.91], [230, 5.57], [240, 2.83]],
    powerCurve: [[2500, 0.6], [3500, 0.85], [4500, 0.97], [5500, 1], [6500, 0.97], [7300, 0.9]],
  },
  {
    id: 'lamborghini-huracan-gt3-evo2-acc',
    name: 'ACC · Lamborghini Huracán GT3 EVO2',
    note: `5.2-litre naturally aspirated V10, 6-speed sequential. ${ACC_MEASURED} From 6 YouTube streams (720p), 554 upshifts.`,
    cylinders: 10, strokes: 4, halfOrderWeight: 0.5,
    minRpm: 900, maxRpm: 9400, idleRpm: 1200, limiterRpm: 8400,
    shiftLights: { from: 7400, to: 8150 },
    gears: 6, upshiftRatio: { min: 0.62, max: 0.92 }, maxSlew: 0.6,
    // km/h per 1000 rpm from the HUD: 12.87, 17.09, 21.37, 25.82, 30.17, 35.00
    ratios: [9.3240, 7.0217, 5.6153, 4.6476, 3.9775, 3.4286], finalDrive: 1, tyreCircumference: 2,
    massKg: 1360, powerKw: 405, cda: 1.15, rollingN: 200, tractionMs2: ACC_TRACTION,
    // learned from the HUD footage (563 upshifts, 4103 moments on full power, 10 runs)
    upshiftHeard: [[0.7752, 0.0211], [0.8223, 0.0184], [0.8432, 0.0091], [0.8631, 0.0046], [0.8661, 0.0021]],
    climbCurve: [[40, 3.03], [50, 4.49], [60, 6.43], [70, 7.9], [80, 16.37], [90, 20.47], [100, 18.63], [110, 16.95], [120, 18.26], [130, 17.25], [140, 14.94], [150, 14.36], [160, 14.25], [170, 13.5], [180, 11.58], [190, 10.64], [200, 9.72], [210, 8.59], [220, 7.44], [230, 6.86], [240, 6.15], [250, 5.34]],
    powerCurve: [[3000, 0.3], [5000, 0.7], [7000, 0.93], [8000, 1], [8700, 0.97]],
  },
);

// a car not known yet (the classifier listens with this): any four-stroke from idle to 10,500 rpm. Its comb listens at every
// half-order, so it reads the rpm of a six, a V8 or a V10 alike where the engine sounds at its cycle orders 
CARS.push({
  id: 'any-four-stroke',
  name: 'Any car · a four-stroke not yet known (for telling cars apart)',
  note: 'No gearbox, no physics: the rpm, the shifts and the voice print, for the classifier (src/fingerprint.ts).',
  cylinders: 6, strokes: 4, halfOrderWeight: 0.5,
  minRpm: 900, maxRpm: 10500, idleRpm: 1200, limiterRpm: 10200,
  shiftLights: { from: 6000, to: 8000 },
  gears: 7,
  upshiftRatio: { min: 0.6, max: 0.92 },
  maxSlew: 0.6,
});

export const DEFAULT_CAR = CARS[0].id;

export function carById(id: string | undefined): CarProfile {
  return CARS.find((c) => c.id === id) ?? CARS[0];
}

/** the firing order: how many times a cylinder fires per crankshaft revolution, summed over the cylinders */
export const firingOrder = (car: CarProfile): number => (car.cylinders * 2) / car.strokes;

/** the speed in km/h for an rpm in a gear, when the profile has what it takes (NaN otherwise) */
export function speedKmh(car: CarProfile, rpm: number, gear: number): number {
  const r = car.ratios?.[gear - 1];
  if (!r || !car.finalDrive || !car.tyreCircumference || !Number.isFinite(rpm)) return NaN;
  return (rpm / (r * car.finalDrive)) * car.tyreCircumference * 0.06;
}

/** the power at an rpm as a share of the peak, from the profile's curve (full power without one) */
export function powerShare(car: CarProfile, rpm: number): number {
  const c = car.powerCurve;
  if (!c || !c.length) return 1;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) if (rpm <= c[i][0]) { const f = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]); return c[i - 1][1] + f * (c[i][1] - c[i - 1][1]); }
  return c[c.length - 1][1];
}
