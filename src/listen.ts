// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// The listener as one object: sound in (mono samples, any length at a time), telemetry out. Live, each tenth of a second the
// dash as a screen would show it (src/dash.ts); at the end, the whole run decided with hindsight (src/report.ts), which is right
// more often: on the real 992 GT3 R onboards held back from tuning, the gear 75.7 % against the live dash's 62.6 %.
import { carById, type CarProfile } from './cars';
import { Dash } from './dash';
import { EngineAnalyser, type EngineFrame, type LimiterHit, type ShiftEvent } from './engine';
import { buildReport, type Report } from './report';
import type { TrackDef } from './track';

/** one row of telemetry: the revs, the gear, the speed (km/h, from the gear and the car's gearing), the throttle state, how
 *  sure it is that this is the engine (0 to 1), and whether the revs were on the limiter */
export interface Row { t: number; rpm: number; gear: number; kmh: number; throttle: 'on' | 'lift' | 'overrun'; sure: number; limiter: boolean }

const THROTTLE = ['on', 'lift', 'overrun'] as const;
const REPORT_EVERY = 6, KEEP = 45 * 60;

export interface ListenerOptions {
  /** circuits to name the track from (none by default: the run is still read, the circuit just isn't named) */
  tracks?: TrackDef[];
  /** the live rows' spacing (s) */
  every?: number;
}

export class Listener {
  readonly car: CarProfile;
  private an: EngineAnalyser;
  private dash: Dash;
  private frames: EngineFrame[] = [];
  private shifts: ShiftEvent[] = [];
  private limiter: LimiterHit[] = [];
  private live: Report | null = null;
  private lastReport = -Infinity;
  private next = 0;

  constructor(readonly sampleRate: number, car: string | CarProfile, private opts: ListenerOptions = {}) {
    this.car = typeof car === 'string' ? carById(car) : car;
    this.an = new EngineAnalyser(sampleRate, this.car);
    this.dash = new Dash(this.car);
  }

  /** more sound; returns the live rows it completed (the dash as shown, every `every` seconds) */
  push(samples: Float32Array): Row[] {
    const out: Row[] = [], every = this.opts.every ?? 0.1;
    for (let i = 0; i < samples.length; i += 1024) {
      this.an.push(samples.subarray(i, Math.min(samples.length, i + 1024)));
      const o = this.an.read();
      this.frames.push(...o.frames); this.shifts.push(...o.shifts); this.limiter.push(...o.limiter);
      this.dash.shifts(o.shifts);
      for (const f of o.frames) {
        const d = this.dash.feed(f, this.live);
        if (f.t >= this.next) {
          this.next = f.t + every;
          const k = this.live?.gearbox.kmhPer1000[d.gear - 1];
          out.push({ t: f.t, rpm: f.rpm, gear: d.gear, kmh: Number.isFinite(k) ? (f.rpm / 1000) * (k as number) : NaN,
            throttle: THROTTLE[f.throttle] ?? 'on', sure: f.conf, limiter: f.limiter });
        }
      }
      // the live dash takes its gearing (and, for a car without a measured climb, its count's correction) from a report made
      // every few seconds over the last 45 minutes
      const t = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
      if (this.frames.length >= 50 && t - this.lastReport >= REPORT_EVERY) {
        this.lastReport = t;
        const from = this.frames.findIndex((x) => x.t >= t - KEEP);
        this.live = buildReport({ frames: this.frames.slice(Math.max(0, from)), shifts: this.shifts.filter((x) => x.t >= t - KEEP),
          limiter: this.limiter.filter((x) => x.t >= t - KEEP), car: this.car, library: this.opts.tracks ?? [], source: { title: '' } }).report;
      }
    }
    return out;
  }

  /** the whole run decided with hindsight: the report, and the run every tenth of a second */
  finish(title = ''): { report: Report; rows: Row[] } {
    const { report, rec } = buildReport({ frames: this.frames, shifts: this.shifts, limiter: this.limiter, car: this.car,
      library: this.opts.tracks ?? [], source: { title }, signature: this.an.signature() });
    const h = rec.heard, lim = new Set(this.limiter.map((x) => Math.round((x.t - h.t0) * h.rate)));
    const rows: Row[] = [];
    for (let i = 0; i < h.rpm.length; i++) rows.push({ t: h.t0 + i / h.rate, rpm: h.rpm[i], gear: h.gear[i] >= 1 ? h.gear[i] : NaN,
      kmh: rec.speed[i], throttle: THROTTLE[h.throttle[i]] ?? 'on', sure: h.conf[i], limiter: lim.has(i) });
    return { report, rows };
  }
}

export const CSV_HEADER = 't,rpm,gear,kmh,throttle,sure,limiter';

/** a row as CSV (blank where unknown) */
export function csvRow(r: Row): string {
  const n = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '');
  return [n(r.t, 2), n(r.rpm), n(r.gear), n(r.kmh), r.throttle, n(r.sure, 2), r.limiter ? 1 : 0].join(',');
}
