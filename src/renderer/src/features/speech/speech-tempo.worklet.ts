import { TempoStretcher } from "./speech-tempo";
import { SPEECH_TEMPO_PROCESSOR, type SpeechTempoCommand, type SpeechTempoReport } from "./speech-tempo-protocol";

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const REPORT_INTERVAL_FRAMES = 2_048;

class SpeechTempoProcessor extends AudioWorkletProcessor {
  readonly #stretcher = new TempoStretcher(sampleRate);
  #paused = false;
  #stopped = false;
  #drained = false;
  #reportedAt = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<SpeechTempoCommand>) => this.#command(event.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channel = outputs[0]?.[0];
    if (!channel || this.#stopped) return !this.#stopped;
    if (!this.#paused) {
      const written = this.#stretcher.read(channel);
      channel.fill(0, written);
    }
    if (currentFrame - this.#reportedAt >= REPORT_INTERVAL_FRAMES) this.#report();
    if (!this.#drained && this.#stretcher.finished) {
      this.#drained = true;
      this.#report();
    }
    return true;
  }

  #command(command: SpeechTempoCommand): void {
    if (command.type === "push") this.#stretcher.push(command.samples);
    else if (command.type === "end") this.#stretcher.end();
    else if (command.type === "tempo") this.#stretcher.setTempo(command.tempo);
    else if (command.type === "pause") this.#paused = true;
    else if (command.type === "resume") this.#paused = false;
    else this.#stopped = true;
  }

  #report(): void {
    this.#reportedAt = currentFrame;
    const report: SpeechTempoReport = {
      consumedSeconds: this.#stretcher.consumedSamples / sampleRate,
      drained: this.#drained,
    };
    this.port.postMessage(report);
  }
}

registerProcessor(SPEECH_TEMPO_PROCESSOR, SpeechTempoProcessor);
