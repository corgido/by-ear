// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// A WAV file's sound as mono samples: PCM at 16, 24 or 32 bits, or 32-bit float, any number of channels (averaged). Anything
// else: let ffmpeg decode it and pipe the raw samples in (see the README).

export function readWav(buf: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), tag = (o: number) => String.fromCharCode(...buf.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null, o = 12;
  while (o + 8 <= buf.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the subformat's first two bytes
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
      fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before its format');
      const { format, channels: ch, bits } = fmt, bytes = bits / 8, n = Math.floor(Math.min(size, buf.length - body) / (bytes * ch));
      const out = new Float32Array(n);
      const read = (p: number): number => {
        if (format === 3 && bits === 32) return dv.getFloat32(p, true);
        if (format !== 1) throw new Error(`WAV format ${format} at ${bits} bits is not read here: decode it with ffmpeg`);
        if (bits === 16) return dv.getInt16(p, true) / 32768;
        if (bits === 24) { const v = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16); return (v & 0x800000 ? v - 0x1000000 : v) / 8388608; }
        if (bits === 32) return dv.getInt32(p, true) / 2147483648;
        throw new Error(`WAV at ${bits} bits is not read here: decode it with ffmpeg`);
      };
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += read(body + (i * ch + c) * bytes);
        out[i] = s / ch;
      }
      return { sampleRate: fmt.rate, samples: out };
    }
    o = body + size + (size & 1);
  }
  throw new Error('no sound in this WAV file');
}
