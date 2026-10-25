// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// Test signals whose answers are known: tones, noise, plucks, swells, rhythms and chord progressions. The listener must read
// none of them as an engine (test/listener.test.ts). Each says what it is and renders itself, seeded, at any sample rate; the
// readings and checks are kept from the music analyser they were first written for, which read them for what they are.

export interface Readings { [key: string]: number }

export interface Verdict { pass: boolean; reading: string }

export interface TestSignal {
  id: string;
  label: string;
  group: 'timbre' | 'envelope' | 'stereo' | 'rhythm' | 'harmony' | 'form' | 'onboard';
  seconds: number;
  /** what the readings should show, in words */
  expect: string;
  render(sr: number): { L: Float32Array; R: Float32Array };
  check(r: Readings): Verdict;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const TAU = Math.PI * 2;
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const fmt = (x: number, d = 0, unit = ''): string => (Number.isFinite(x) ? `${x.toFixed(d)}${unit}` : '—');

function mono(sr: number, seconds: number, f: (t: number, i: number) => number): { L: Float32Array; R: Float32Array } {
  const n = Math.round(sr * seconds);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = f(i / sr, i);
  return { L, R: L.slice() };
}

/** a harmonic tone: partials 1..n with amplitude 1/k, at frequency f */
function harmonic(t: number, f: number, n = 8, roll = 1): number {
  let s = 0;
  for (let k = 1; k <= n; k++) if (k * f < 18000) s += Math.sin(TAU * k * f * t) / Math.pow(k, roll);
  return s;
}

/** fade in and out over 10 ms so loops do not click */
function edges(x: Float32Array, sr: number): Float32Array {
  const m = Math.round(sr * 0.01);
  for (let i = 0; i < m && i < x.length; i++) { const g = i / m; x[i] *= g; x[x.length - 1 - i] *= g; }
  return x;
}

function pinkNoise(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

const CHORDS_C = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]]; // C, Am, F, G

export const SIGNALS: TestSignal[] = [
  {
    id: 'sine', label: 'Pure tone · A4 440 Hz', group: 'timbre', seconds: 8,
    expect: 'tonal: flatness near 0, harmonicity near 1, no roughness, centroid ≈ 440 Hz',
    render: (sr) => mono(sr, 8, (t) => 0.5 * Math.sin(TAU * 440 * t)),
    check: (r) => ({ pass: r.flatness < 0.05 && r.harmonicity > 0.8 && r.roughness < 0.02 && Math.abs(r.centroid - 440) < 60, reading: `flatness ${fmt(r.flatness, 3)} · harmonicity ${fmt(r.harmonicity, 2)} · centroid ${fmt(r.centroid, 0, ' Hz')}` }),
  },
  {
    id: 'noise', label: 'White noise', group: 'timbre', seconds: 8,
    expect: 'noisy: flatness high (above 0.3), harmonicity low, centroid high',
    render: (sr) => { const r = rng(7); return mono(sr, 8, () => (r() * 2 - 1) * 0.35); },
    check: (r) => ({ pass: r.flatness > 0.3 && !(r.harmonicity > 0.3) && r.centroid > 4000, reading: `flatness ${fmt(r.flatness, 2)} · harmonicity ${fmt(r.harmonicity, 2)} · centroid ${fmt(r.centroid, 0, ' Hz')}` }),
  },
  {
    id: 'pink', label: 'Pink noise', group: 'timbre', seconds: 8,
    expect: 'noisy but darker than white: flatness well above a tone, harmonicity low',
    render: (sr) => { const L = pinkNoise(sr * 8, 11); return { L, R: L.slice() }; },
    check: (r) => ({ pass: r.flatness > 0.1 && !(r.harmonicity > 0.4), reading: `flatness ${fmt(r.flatness, 2)} · centroid ${fmt(r.centroid, 0, ' Hz')}` }),
  },
  {
    id: 'harmonic', label: 'Harmonic tone · 220 Hz, 10 partials', group: 'timbre', seconds: 8,
    expect: 'harmonic: harmonicity high, one voice at 220 Hz, inharmonicity near 0 cents',
    render: (sr) => mono(sr, 8, (t) => 0.25 * harmonic(t, 220, 10)),
    check: (r) => ({ pass: r.harmonicity > 0.8 && Math.abs(r.f0 - 220) < 6 && r.voices <= 2, reading: `harmonicity ${fmt(r.harmonicity, 2)} · f0 ${fmt(r.f0, 1, ' Hz')} · voices ${fmt(r.voices)}` }),
  },
  {
    id: 'bell', label: 'Inharmonic bell · partials 1, 2.32, 4.25, 6.63', group: 'timbre', seconds: 8,
    expect: 'metallic: harmonicity clearly below the harmonic tone',
    render: (sr) => mono(sr, 8, (t) => {
      const ph = t % 2; const e = Math.exp(-ph * 1.2);
      return 0.3 * e * (Math.sin(TAU * 330 * t) + 0.8 * Math.sin(TAU * 330 * 2.32 * t) + 0.6 * Math.sin(TAU * 330 * 4.25 * t) + 0.45 * Math.sin(TAU * 330 * 6.63 * t));
    }),
    check: (r) => ({ pass: r.harmonicity < 0.6, reading: `harmonicity ${fmt(r.harmonicity, 2)} · inharmonicity ${fmt(r.inharm, 0, ' ¢')}` }),
  },
  {
    id: 'sweep', label: 'Sweep · 100 Hz to 8 kHz', group: 'timbre', seconds: 10,
    expect: 'centroid climbs steadily with the sweep',
    render: (sr) => { let ph = 0; return mono(sr, 10, (t) => { const f = 100 * Math.pow(80, (t % 10) / 10); ph += (TAU * f) / sr; return 0.4 * Math.sin(ph); }); },
    check: (r) => ({ pass: r.centroid > 90 && r.flatness < 0.1, reading: `centroid ${fmt(r.centroid, 0, ' Hz')}` }),
  },
  {
    id: 'm2', label: 'Close pair · A4 + B♭4 (minor second)', group: 'timbre', seconds: 8,
    expect: 'rough: roughness well above the fifth (beating at 26 Hz)',
    render: (sr) => mono(sr, 8, (t) => 0.3 * (Math.sin(TAU * 440 * t) + Math.sin(TAU * 466.16 * t))),
    check: (r) => ({ pass: r.roughness > 0.03, reading: `roughness ${fmt(r.roughness, 3)}` }),
  },
  {
    id: 'p5', label: 'Open pair · A4 + E5 (fifth)', group: 'timbre', seconds: 8,
    expect: 'smooth: roughness near 0',
    render: (sr) => mono(sr, 8, (t) => 0.3 * (Math.sin(TAU * 440 * t) + Math.sin(TAU * 659.26 * t))),
    check: (r) => ({ pass: r.roughness < 0.01, reading: `roughness ${fmt(r.roughness, 3)}` }),
  },
  {
    id: 'pluck', label: 'Plucks · sharp attack, 0.35 s decay', group: 'envelope', seconds: 8,
    expect: 'attack under 10 ms, decay about 300–400 ms, sustain near 0',
    render: (sr) => {
      const notes = [57, 60, 64, 67];
      return mono(sr, 8, (t) => {
        const k = Math.floor(t / 0.8), ph = t - k * 0.8;
        const f = midiHz(notes[k % 4]);
        const a = Math.min(1, ph / 0.002);
        return 0.4 * a * Math.exp(-ph / 0.15) * harmonic(ph, f, 6, 1.4);
      });
    },
    check: (r) => ({ pass: r.att < 12 && r.dec > 200 && r.dec < 500 && r.sus < 0.2, reading: `att ${fmt(r.att, 0, ' ms')} · dec ${fmt(r.dec, 0, ' ms')} · sus ${fmt(r.sus, 2)}` }),
  },
  {
    id: 'swell', label: 'Swells · 0.6 s attack, held, 0.4 s release', group: 'envelope', seconds: 12,
    expect: 'slow attack (several hundred ms), high sustain, release about 0.3–0.5 s',
    render: (sr) => mono(sr, 12, (t) => {
      const k = Math.floor(t / 3), ph = t - k * 3;
      const f = midiHz([55, 60, 62, 59][k % 4]);
      const env = ph < 0.6 ? ph / 0.6 : ph < 2.2 ? 1 : ph < 2.6 ? 1 - (ph - 2.2) / 0.4 : 0;
      return 0.35 * env * harmonic(t, f, 6, 1.2);
    }),
    check: (r) => ({ pass: r.att > 250 && r.sus > 0.6, reading: `att ${fmt(r.att, 0, ' ms')} · sus ${fmt(r.sus, 2)} · rel ${fmt(r.rel, 0, ' ms')}` }),
  },
  {
    id: 'tremolo', label: 'Tremolo · 6 Hz, deep', group: 'envelope', seconds: 10,
    expect: 'modulation at about 6 Hz, classed as tremolo',
    render: (sr) => mono(sr, 10, (t) => 0.35 * (1 - 0.4 * (1 + Math.sin(TAU * 6 * t))) * harmonic(t, 330, 4)),
    check: (r) => ({ pass: Math.abs(r.modRate - 6) < 0.6 && r.modClass === 3, reading: `rate ${fmt(r.modRate, 2, ' Hz')} · depth ${fmt(r.modDepth * 100, 0, '%')} · class ${r.modClass}` }),
  },
  {
    id: 'breath', label: 'Breathing · 0.25 Hz swell', group: 'envelope', seconds: 16,
    expect: 'slow modulation below 1 Hz, classed as breathing',
    render: (sr) => mono(sr, 16, (t) => 0.3 * (0.55 - 0.45 * Math.cos(TAU * 0.25 * t)) * harmonic(t, 196, 6)),
    check: (r) => ({ pass: r.modRate < 1 && r.modClass === 1, reading: `rate ${fmt(r.modRate, 2, ' Hz')} · class ${r.modClass}` }),
  },
  {
    id: 'left', label: 'Left only', group: 'stereo', seconds: 6,
    expect: 'balance hard left (−1), correlation 0',
    render: (sr) => { const n = sr * 6; const L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = 0.3 * harmonic(i / sr, 262, 5); return { L, R: new Float32Array(n) }; },
    check: (r) => ({ pass: r.balance < -0.9, reading: `balance ${fmt(r.balance, 2)} · width ${fmt(r.width, 2)}` }),
  },
  {
    id: 'mono', label: 'Centred mono', group: 'stereo', seconds: 6,
    expect: 'balance 0, width 0, correlation +1',
    render: (sr) => mono(sr, 6, (t) => 0.3 * harmonic(t, 262, 5)),
    check: (r) => ({ pass: Math.abs(r.balance) < 0.05 && r.width < 0.02 && r.corr > 0.98, reading: `balance ${fmt(r.balance, 2)} · width ${fmt(r.width, 2)} · corr ${fmt(r.corr, 2)}` }),
  },
  {
    id: 'wide', label: 'Wide · unrelated noise each side', group: 'stereo', seconds: 6,
    expect: 'width about 0.5, correlation near 0',
    render: (sr) => { const n = sr * 6, a = rng(3), b = rng(5); const L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { L[i] = (a() * 2 - 1) * 0.3; R[i] = (b() * 2 - 1) * 0.3; } return { L, R }; },
    check: (r) => ({ pass: Math.abs(r.width - 0.5) < 0.1 && Math.abs(r.corr) < 0.15, reading: `width ${fmt(r.width, 2)} · corr ${fmt(r.corr, 2)}` }),
  },
  {
    id: 'antiphase', label: 'Antiphase · left = −right', group: 'stereo', seconds: 6,
    expect: 'correlation −1, width 1 (would vanish in mono)',
    render: (sr) => { const n = sr * 6; const L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = 0.3 * harmonic(i / sr, 220, 5); return { L, R: L.map((x) => -x) }; },
    check: (r) => ({ pass: r.corr < -0.95 && r.width > 0.95, reading: `corr ${fmt(r.corr, 2)} · width ${fmt(r.width, 2)}` }),
  },
  {
    id: 'click120', label: 'Click train · 120 BPM', group: 'rhythm', seconds: 16,
    expect: 'tempo 120 BPM, two onsets a second, every click on a beat (off-beat weight low)',
    render: (sr) => { const n = sr * 16; const L = new Float32Array(n); const step = Math.round(sr * 0.5); for (let s = 0; s < n; s += step) for (let i = 0; i < 240 && s + i < n; i++) L[s + i] = 0.8 * Math.exp(-i / 40) * (i % 2 ? -1 : 1); return { L, R: L.slice() }; },
    check: (r) => ({ pass: Math.abs(r.tempo - 120) < 2.5 && Math.abs(r.density - 2) < 0.4 && r.offbeat < 0.25, reading: `tempo ${fmt(r.tempo, 1, ' BPM')} · density ${fmt(r.density, 1, '/s')} · off-beat ${fmt(r.offbeat * 100, 0, '%')}` }),
  },
  {
    id: 'click90', label: 'Click train · 90 BPM', group: 'rhythm', seconds: 16,
    expect: 'tempo 90 BPM',
    render: (sr) => { const n = sr * 16; const L = new Float32Array(n); const step = Math.round((sr * 60) / 90); for (let s = 0; s < n; s += step) for (let i = 0; i < 240 && s + i < n; i++) L[s + i] = 0.8 * Math.exp(-i / 40) * (i % 2 ? -1 : 1); return { L, R: L.slice() }; },
    check: (r) => ({ pass: Math.abs(r.tempo - 90) < 2.5, reading: `tempo ${fmt(r.tempo, 1, ' BPM')}` }),
  },
  {
    id: 'groove', label: 'Groove · kick and snare on the beat, eighth hats, a pushed kick', group: 'rhythm', seconds: 16,
    expect: 'tempo 110 BPM; kick and snare on the beats, so the grid sits on them; off-beat weight above a click train (the hats and the pushed kick)',
    render: (sr) => {
      const n = sr * 16, L = new Float32Array(n), R = new Float32Array(n);
      const r = rng(9);
      const six = (60 / 110 / 4) * sr;
      const hit = (at: number, f: (i: number) => number, len: number, pan: number) => {
        const s = Math.round(at);
        for (let i = 0; i < len && s + i < n; i++) { const v = f(i); L[s + i] += v * (1 - pan) ; R[s + i] += v * (1 + pan); }
      };
      for (let k = 0; k * six < n; k++) {
        const pos = k % 16;
        if (pos === 0 || pos === 8 || pos === 10) hit(k * six, (i) => 0.7 * Math.sin(TAU * 55 * (i / sr) * (1 + 2 * Math.exp(-i / 800))) * Math.exp(-i / 4000), 9000, 0);
        if (pos % 2 === 0) hit(k * six, () => (r() * 2 - 1) * 0.12, 1200, 0.4);
        if (pos === 4 || pos === 12) hit(k * six, (i) => ((r() * 2 - 1) * 0.4 + 0.3 * Math.sin(TAU * 190 * i / sr)) * Math.exp(-i / 2500), 7000, -0.2);
      }
      return { L, R };
    },
    check: (r) => ({ pass: Math.abs(r.tempo - 110) < 3 && r.offbeat > 0.2 && r.offbeat < 0.8, reading: `tempo ${fmt(r.tempo, 1, ' BPM')} · off-beat ${fmt(r.offbeat * 100, 0, '%')} · syncopation ${fmt(r.syncopation, 2)}` }),
  },
  {
    id: 'cadence', label: 'Chords · C, Am, F, G every 2 s', group: 'harmony', seconds: 16,
    expect: 'chords read C, Am, F, G in turn; key C major; harmony changes every 2 s',
    render: (sr) => {
      const n = sr * 16, L = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr, k = Math.floor(t / 2), ph = t - k * 2;
        const ch = CHORDS_C[k % 4];
        const env = Math.min(1, ph / 0.02) * (0.6 + 0.4 * Math.exp(-ph * 2));
        let s = 0.5 * harmonic(t, midiHz(ch[0] - 24), 4, 1.5);
        for (const m of ch) s += harmonic(t, midiHz(m), 5, 1.6);
        L[i] = 0.12 * env * s;
      }
      return { L, R: L.slice() };
    },
    check: (r) => ({ pass: r.keyIdx === 0 && Math.abs(r.harmRhythm - 2) < 0.4, reading: `chord ${['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][r.chordRoot] ?? '—'}${r.chordType === 1 ? 'm' : ''} · key ${r.keyIdx} · changes every ${fmt(r.harmRhythm, 2, ' s')}` }),
  },
  {
    id: 'layers', label: 'Three layers · bass, pad, busy upper line', group: 'harmony', seconds: 16,
    expect: 'about three voices: a slow bass, a held bed, a busy upper line',
    render: (sr) => {
      const n = sr * 16, L = new Float32Array(n), R = new Float32Array(n);
      const mel = [76, 79, 81, 79, 76, 74, 72, 74];
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const bass = 0.35 * harmonic(t, midiHz(36 + (Math.floor(t / 4) % 2 ? 5 : 0)), 5, 1.3);
        const pad = 0.12 * (harmonic(t, midiHz(55), 6, 1.5) + harmonic(t, midiHz(60), 6, 1.5));
        const k = Math.floor(t / 0.25), ph = t - k * 0.25;
        const lead = 0.22 * Math.exp(-ph * 6) * Math.min(1, ph / 0.004) * harmonic(t, midiHz(mel[k % 8]), 6, 1.2);
        L[i] = bass + pad * 1.2 + lead * 0.6;
        R[i] = bass + pad * 0.8 + lead * 1.4;
      }
      return { L, R };
    },
    check: (r) => ({ pass: r.voices >= 2 && r.voices <= 4, reading: `voices ${fmt(r.voices)} · span ${fmt(r.regSpread, 1, ' oct')}` }),
  },
  {
    id: 'form', label: 'Form · A (chords) · B (noise and clicks) · A again', group: 'form', seconds: 30,
    expect: 'two turns (at 10 s and 20 s); the return to A is recognised as earlier material',
    render: (sr) => {
      const n = sr * 30, L = new Float32Array(n);
      const r = rng(21);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        if (t < 10 || t >= 20) {
          const k = Math.floor(t / 2.5), ph = t - k * 2.5;
          const ch = CHORDS_C[k % 4];
          let s = 0;
          for (const m of ch) s += harmonic(t, midiHz(m), 5, 1.6);
          L[i] = 0.12 * Math.min(1, ph / 0.02) * s;
        } else {
          const ph = t % 0.25;
          L[i] = (r() * 2 - 1) * (0.08 + 0.4 * Math.exp(-ph * 40));
        }
      }
      return { L: edges(L, sr), R: L.slice() };
    },
    check: (r) => ({ pass: r.sections >= 2, reading: `sections ${fmt(r.sections)} · recurrence ${fmt(r.recurSim, 2)}${Number.isFinite(r.recurAt) ? ` (from ${fmt(r.recurAt, 0, ' s')})` : ''}` }),
  },
];

export const signalById = (id: string): TestSignal | undefined => SIGNALS.find((s) => s.id === id);
