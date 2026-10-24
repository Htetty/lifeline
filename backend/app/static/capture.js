// Loaded from the page's origin so the microphone works under script-src 'self'.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.size = 0;
  }

  process(inputs, outputs) {
    const samples = inputs[0]?.[0];
    if (samples) {
      this.parts.push(samples.slice());
      this.size += samples.length;
    }
    if (this.size >= sampleRate * 0.04) {
      const frame = new Float32Array(this.size);
      let offset = 0;
      for (const part of this.parts) {
        frame.set(part, offset);
        offset += part.length;
      }
      this.port.postMessage(frame.buffer, [frame.buffer]);
      this.parts = [];
      this.size = 0;
    }
    // Keep capture connected without playing the caller's microphone back.
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    return true;
  }
}

registerProcessor("capture", Capture);
