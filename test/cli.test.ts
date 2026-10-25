// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// The front doors: a WAV file read back as it was written, the Listener on a synthetic lap (whose answers are known), and the
// command line end to end with raw samples piped in, as ffmpeg would send them.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { OnboardSynth, truthAt } from '../src/generator';
import { Listener, CSV_HEADER } from '../src/listen';
import { readWav } from '../src/wav';

const SR = 48000;

/** a short synthetic lap, mixed to mono, with its truth */
function lap() {
  const syn = new OnboardSynth(SR, { track: 'short', laps: 1, vary: 1, seed: 7 });
  const L = new Float32Array(1024), R = new Float32Array(1024), parts: Float32Array[] = [];
  for (let n = syn.fill(L, R); n > 0; n = syn.fill(L, R)) {
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = 0.5 * (L[i] + R[i]);
    parts.push(m);
  }
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return { samples: all, truth: syn.truth };
}

describe('a WAV file', () => {
  it('reads back as written: 16-bit stereo, averaged to mono', () => {
    const n = 4800, buf = Buffer.alloc(44 + n * 4);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) { const v = Math.round(16000 * Math.sin(i / 10)); buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4); }
    const w = readWav(buf);
    expect(w.sampleRate).toBe(SR);
    expect(w.samples.length).toBe(n);
    expect(w.samples[100]).toBeCloseTo(Math.round(16000 * Math.sin(10)) / 32768, 4);
  });
});

describe('the Listener on a synthetic lap', () => {
  it('gives live rows as it hears, and the run decided at the end, with the revs and gear right', { timeout: 300000 }, () => {
    const { samples, truth } = lap();
    const L = new Listener(SR, 'synthetic-flat6');
    const live = [];
    for (let i = 0; i < samples.length; i += SR) live.push(...L.push(samples.subarray(i, Math.min(samples.length, i + SR))));
    const { report, rows } = L.finish('synthetic');
    const sure = rows.filter((r) => r.t > 2 && r.t < truth.seconds - 1 && r.sure > 0.5);
    const rpmOk = sure.filter((r) => Math.abs(r.rpm / truthAt(truth, r.t).rpm - 1) < 0.03).length / sure.length;
    const gearOk = sure.filter((r) => r.gear === truthAt(truth, r.t).gear).length / sure.length;
    console.log(`synthetic lap: ${live.length} live rows, ${rows.length} decided; revs within 3 % on ${(rpmOk * 100).toFixed(1)} %, gear ${(gearOk * 100).toFixed(1)} %`);
    expect(live.length).toBeGreaterThan(truth.seconds * 8);
    expect(rpmOk).toBeGreaterThan(0.85);
    expect(gearOk).toBeGreaterThan(0.6);
    expect(report.car.id).toBe('synthetic-flat6');
  });
});

describe('the command line', () => {
  it('takes raw 32-bit float piped in and writes the run as CSV', { timeout: 300000 }, () => {
    const { samples } = lap();
    const raw = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    const out = execFileSync('node', ['dist/cli.js', '--car', 'synthetic-flat6'], { input: raw, maxBuffer: 64 << 20 }).toString().trim().split('\n');
    expect(out[0]).toBe(CSV_HEADER);
    expect(out.length).toBeGreaterThan(100);
    const gears = out.slice(1).map((l) => l.split(',')[2]).filter(Boolean);
    expect(gears.length).toBeGreaterThan(out.length / 2);
  });
  it('lists the car profiles', () => {
    expect(execFileSync('node', ['dist/cli.js', '--cars']).toString()).toContain('manthey-911-gt3r-992');
  });
});
