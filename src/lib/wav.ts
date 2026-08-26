/** `AudioBuffer` のうち WAV 化に要る部分だけ。テストから素の実装を渡せるようにしてある。 */
export type PcmSource = {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
};

/** 16bit PCM の WAV バイト列を作る。ヘッダ44バイト + インターリーブしたサンプル。 */
export function encodeWavBytes(buf: PcmSource): ArrayBuffer {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const sr = buf.sampleRate;
  const bytes = n * ch * 2;
  const data = new ArrayBuffer(44 + bytes);
  const v = new DataView(data);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };

  str(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, bytes, true);

  const cd: Float32Array[] = [];
  for (let c = 0; c < ch; c++) cd.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, cd[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return data;
}

export function encodeWav(buf: PcmSource): Blob {
  return new Blob([encodeWavBytes(buf)], { type: "audio/wav" });
}
