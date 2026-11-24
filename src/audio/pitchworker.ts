import { detectPitch } from "../lib/pitch";

self.addEventListener("message", (e: MessageEvent<{ pcm: Float32Array; sampleRate: number }>) => {
  const frames = detectPitch(e.data.pcm, e.data.sampleRate);
  // oxlint-disable-next-line require-post-message-target-origin
  self.postMessage(frames);
});
