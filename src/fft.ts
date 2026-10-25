// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// Radix-2 complex FFT with precomputed tables, plus a real-input helper that
// windows a frame and returns its magnitude spectrum. Pure: runs anywhere.

export class FFT {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  readonly window: Float64Array;
  /** sum of the window, for amplitude-correct magnitudes (a full-scale sine reads 1.0) */
  readonly windowSum: number;

  constructor(n: number) {
    if ((n & (n - 1)) !== 0) throw new Error(`FFT size ${n} is not a power of two`);
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.window = new Float64Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      s += this.window[i];
    }
    this.windowSum = s;
  }

  /** in-place complex FFT */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /**
   * Hann-windowed magnitude spectrum of `frame` (length n), bins 0..n/2, scaled so a full-scale sine reads about 1.0.
   * `out` is reused when given. When `imagFrame` is given, the two real frames are transformed at once (left in the real
   * part, right in the imaginary part) and both spectra are returned as complex pairs in `pair` (used for stereo).
   */
  magnitude(frame: ArrayLike<number>, out?: Float32Array): Float32Array {
    const n = this.n;
    const re = this.re, im = this.im, w = this.window;
    for (let i = 0; i < n; i++) { re[i] = frame[i] * w[i]; im[i] = 0; }
    this.transform(re, im);
    const half = n / 2;
    const mag = out ?? new Float32Array(half + 1);
    const scale = 2 / this.windowSum;
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]) * scale;
    return mag;
  }

  /**
   * Two real frames transformed together; returns the complex spectra of each (bins 0..n/2) in the given arrays.
   * Uses X[k] = (Z[k] + conj Z[n-k]) / 2, Y[k] = (Z[k] - conj Z[n-k]) / 2i.
   */
  pair(a: ArrayLike<number>, b: ArrayLike<number>, aRe: Float32Array, aIm: Float32Array, bRe: Float32Array, bIm: Float32Array): void {
    const n = this.n;
    const re = this.re, im = this.im, w = this.window;
    for (let i = 0; i < n; i++) { re[i] = a[i] * w[i]; im[i] = b[i] * w[i]; }
    this.transform(re, im);
    const half = n / 2;
    const scale = 2 / this.windowSum;
    for (let k = 0; k <= half; k++) {
      const j = (n - k) % n;
      const zr = re[k], zi = im[k], cr = re[j], ci = -im[j];
      aRe[k] = ((zr + cr) / 2) * scale;
      aIm[k] = ((zi + ci) / 2) * scale;
      // (Z - conj Z') / 2i  =>  ((zi - ci)/2, -(zr - cr)/2)
      bRe[k] = ((zi - ci) / 2) * scale;
      bIm[k] = (-(zr - cr) / 2) * scale;
    }
  }
}

/** frequency of bin k */
export const binHz = (k: number, n: number, sr: number): number => (k * sr) / n;
/** nearest bin to a frequency */
export const hzBin = (hz: number, n: number, sr: number): number => Math.round((hz * n) / sr);

export const dB = (x: number): number => 20 * Math.log10(Math.max(x, 1e-10));
export const powDb = (p: number): number => 10 * Math.log10(Math.max(p, 1e-20));
