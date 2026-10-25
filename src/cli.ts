#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// by-ear: a race car's telemetry from its sound, on the command line.
//
//   by-ear onboard.wav --car manthey-911-gt3r-992 > run.csv                         a WAV file
//   ffmpeg -i onboard.mp4 -f f32le -ac 1 -ar 48000 - | by-ear --car <id> > run.csv  anything ffmpeg reads, piped in
//   ... | by-ear --car <id> --live                                                 rows as the sound comes (the live dash)
//   by-ear onboard.wav --car <id> --json > report.json                             the report instead of the rows
//   by-ear --cars                                                                  the car profiles
//
// Piped sound is raw 32-bit float, mono, little-endian, at --rate (48000 by default).
import { readFileSync } from 'node:fs';
import { CARS } from './cars';
import { CSV_HEADER, Listener, csvRow } from './listen';
import type { TrackDef } from './track';
import { readWav } from './wav';

// a reader that stops early (`by-ear --cars | head`) closes the pipe: that is the end of the output, not an error
process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(`--${k}`);
const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--car', '--rate', '--tracks', '--title', '--every'].includes(argv[i - 1])));

const USAGE = `by-ear: a race car's telemetry from its sound

  by-ear onboard.wav --car <id> > run.csv                                       a WAV file
  ffmpeg -i onboard.mp4 -f f32le -ac 1 -ar 48000 - | by-ear --car <id> > run.csv  anything ffmpeg reads, piped in
  ... | by-ear --car <id> --live                                               rows as the sound comes (the live dash)
  by-ear onboard.wav --car <id> --json > report.json                           the report instead of the rows
  by-ear --cars                                                                the car profiles

  --rate <hz>       piped sound's sample rate (48000); it is raw 32-bit float, mono, little-endian
  --tracks <file>   circuits to name the track from (none by default)
  --every <s>       the live rows' spacing (0.1)
  --title <text>    the report's title`;

function usage(code: number): never {
  process.stderr.write(USAGE + '\n');
  process.exit(code);
}

async function main(): Promise<void> {
  if (has('help') || has('h')) usage(0);
  if (has('cars')) {
    for (const c of CARS) process.stdout.write(`${c.id.padEnd(36)} ${c.name}${c.ratios ? '' : '  (no gear ratios: the gear is counted)'}\n`);
    return;
  }
  const car = opt('car');
  if (!car || !CARS.some((c) => c.id === car)) {
    process.stderr.write(car ? `no car "${car}": by-ear --cars lists them\n` : 'which car? --car <id> (by-ear --cars lists them)\n');
    process.exit(2);
  }
  const tracksFile = opt('tracks');
  const tracks: TrackDef[] | undefined = tracksFile ? ((j) => (Array.isArray(j) ? j : j.tracks))(JSON.parse(readFileSync(tracksFile, 'utf8'))) : undefined;
  const live = has('live'), json = has('json'), every = Number(opt('every') ?? 0.1);
  const out = (s: string) => process.stdout.write(s + '\n');

  let L: Listener;
  if (file && file !== '-') {
    const { sampleRate, samples } = readWav(readFileSync(file));
    L = new Listener(sampleRate, car, { tracks, every });
    if (live) { out(CSV_HEADER); for (const r of L.push(samples)) out(csvRow(r)); return; }
    L.push(samples);
  } else {
    const rate = Number(opt('rate') ?? 48000);
    L = new Listener(rate, car, { tracks, every });
    if (live) out(CSV_HEADER);
    let rest: Buffer = Buffer.alloc(0);
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
      const b: Buffer = rest.length ? Buffer.concat([rest, chunk]) : chunk, n = Math.floor(b.length / 4);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = b.readFloatLE(i * 4);
      rest = b.subarray(n * 4);
      const rows = L.push(samples);
      if (live) for (const r of rows) out(csvRow(r));
    }
    if (live) return;
  }
  const { report, rows } = L.finish(opt('title') ?? file ?? '');
  if (json) { out(JSON.stringify(report, null, 1)); return; }
  out(CSV_HEADER);
  for (const r of rows) out(csvRow(r));
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : e}\n`); process.exit(1); });
