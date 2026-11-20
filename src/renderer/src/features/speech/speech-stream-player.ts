import workletUrl from "./speech-tempo.worklet.ts?worker&url";
import { SPEECH_TEMPO_PROCESSOR, type SpeechTempoCommand, type SpeechTempoReport } from "./speech-tempo-protocol";

const ANALYSER_SIZE = 512;
const streamContexts = new Map<number, Promise<AudioContext>>();

function streamContext(sampleRate: number): Promise<AudioContext> {
  const known = streamContexts.get(sampleRate);
  if (known) return known;
  const context = new AudioContext({ sampleRate });
  const ready = context.audioWorklet.addModule(workletUrl).then(() => context);
  ready.catch(() => streamContexts.delete(sampleRate));
  streamContexts.set(sampleRate, ready);
  return ready;
}

export function pcm16Samples(pcm: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(pcm.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32_768;
  return samples;
}

function resample(samples: Float32Array<ArrayBuffer>, from: number, to: number): Float32Array<ArrayBuffer> {
  if (from === to) return samples;
  const output = new Float32Array(Math.round((samples.length * to) / from));
  const step = from / to;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * step;
    const before = Math.floor(position);
    const weight = position - before;
    output[index] = (samples[before] ?? 0) * (1 - weight) + (samples[before + 1] ?? samples[before] ?? 0) * weight;
  }
  return output;
}

export class SpeechStreamPlayer {
  readonly output: AnalyserNode;
  readonly #sampleRate: number;
  readonly #node: AudioWorkletNode;
  readonly #finished: Promise<void>;
  #finish: () => void = () => undefined;
  #appendedSamples = 0;
  #playedSeconds = 0;
  #stopped = false;

  static async start(sampleRate: number, tempo: number): Promise<SpeechStreamPlayer> {
    const context = await streamContext(sampleRate);
    if (context.state === "suspended") await context.resume();
    return new SpeechStreamPlayer(context, tempo);
  }

  private constructor(context: AudioContext, tempo: number) {
    this.#sampleRate = context.sampleRate;
    this.#node = new AudioWorkletNode(context, SPEECH_TEMPO_PROCESSOR, {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    this.output = context.createAnalyser();
    this.output.fftSize = ANALYSER_SIZE;
    this.#node.connect(this.output);
    this.output.connect(context.destination);
    this.#finished = new Promise((resolve) => {
      this.#finish = resolve;
    });
    this.#node.port.onmessage = (event: MessageEvent<SpeechTempoReport>) => {
      this.#playedSeconds = event.data.consumedSeconds;
      if (event.data.drained) this.stop();
    };
    this.setTempo(tempo);
  }

  get playedSeconds(): number {
    return this.#playedSeconds;
  }

  get bufferedSeconds(): number {
    return Math.max(0, this.#appendedSamples / this.#sampleRate - this.#playedSeconds);
  }

  get finished(): Promise<void> {
    return this.#finished;
  }

  append(pcm: Uint8Array, sampleRate: number): void {
    if (this.#stopped || pcm.byteLength === 0) return;
    const samples = resample(pcm16Samples(pcm), sampleRate, this.#sampleRate);
    this.#appendedSamples += samples.length;
    this.#send({ type: "push", samples }, [samples.buffer]);
  }

  end(): void {
    this.#send({ type: "end" });
  }

  setTempo(tempo: number): void {
    this.#send({ type: "tempo", tempo });
  }

  pause(): void {
    this.#send({ type: "pause" });
  }

  resume(): void {
    this.#send({ type: "resume" });
  }

  stop(): void {
    if (this.#stopped) return;
    this.#send({ type: "stop" });
    this.#stopped = true;
    this.#node.port.onmessage = null;
    this.#node.disconnect();
    this.output.disconnect();
    this.#finish();
  }

  #send(command: SpeechTempoCommand, transfer: Transferable[] = []): void {
    if (!this.#stopped) this.#node.port.postMessage(command, transfer);
  }
}
