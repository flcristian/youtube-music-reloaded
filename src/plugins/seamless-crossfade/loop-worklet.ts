/**
 * Audio worklet for "loop out": passes the song through while remembering
 * the last few seconds; on request, from an exact sample on, it repeats the
 * last stretch (a bar) over and over, sample-accurately, so the beat goes
 * on in time while the song itself has moved on or stopped.
 */
export const LOOP_PROCESSOR = 'seamless-crossfade-loop';

const source = `
const SEAM = 96; // samples faded at each loop seam (~2 ms)
class LoopOut extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.floor(sampleRate * 8);
    this.ring = [new Float32Array(this.size), new Float32Array(this.size)];
    this.written = 0;
    this.loop = null;
    this.held = false;
    this.port.onmessage = ({ data }) => {
      if (data.loop) {
        const length = Math.min(this.size - 256, Math.round(data.length * sampleRate));
        this.loop = { at: this.written + Math.round(data.after * sampleRate), length, buffer: null, position: 0 };
      }
      if (data.stop) this.loop = null;
      if ('held' in data) this.held = data.held;
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      const frame = this.written;
      const at = frame % this.size;
      for (let c = 0; c < 2; c++) {
        const channel = input[c] || input[0];
        this.ring[c][at] = channel ? channel[i] : 0;
      }
      this.written++;
      const loop = this.loop;
      if (!loop || frame < loop.at) {
        for (let c = 0; c < output.length; c++) output[c][i] = this.ring[Math.min(c, 1)][at];
        continue;
      }
      if (!loop.buffer) {
        loop.buffer = [new Float32Array(loop.length), new Float32Array(loop.length)];
        for (let k = 0; k < loop.length; k++) {
          const from = (loop.at - loop.length + k + this.size) % this.size;
          loop.buffer[0][k] = this.ring[0][from];
          loop.buffer[1][k] = this.ring[1][from];
        }
      }
      if (this.held) {
        for (let c = 0; c < output.length; c++) output[c][i] = 0;
        continue;
      }
      const k = loop.position % loop.length;
      loop.position++;
      const edge = Math.min(k, loop.length - 1 - k);
      const seam = edge < SEAM ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / SEAM) : 1;
      for (let c = 0; c < output.length; c++) output[c][i] = loop.buffer[Math.min(c, 1)][k] * seam;
    }
    return true;
  }
}
registerProcessor('${LOOP_PROCESSOR}', LoopOut);
`;

/** Loads the worklet into `context` (once per context). */
export const loadLoopWorklet = (context: AudioContext) => {
  const url = URL.createObjectURL(
    new Blob([source], { type: 'text/javascript' }),
  );
  return context.audioWorklet
    .addModule(url)
    .finally(() => URL.revokeObjectURL(url));
};
