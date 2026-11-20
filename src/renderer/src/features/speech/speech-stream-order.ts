import type { SpeechAudio } from "@openbot/contracts/ipc";

interface OrderedPart {
  waiting: SpeechAudio[];
  done: boolean;
}

export class SpeechStreamOrder {
  readonly #parts: OrderedPart[] = [];
  readonly #deliver: (audio: SpeechAudio, part: number) => void;
  #current = 0;

  constructor(deliver: (audio: SpeechAudio, part: number) => void) {
    this.#deliver = deliver;
  }

  add(): number {
    this.#parts.push({ waiting: [], done: false });
    return this.#parts.length - 1;
  }

  receive(part: number, audio: SpeechAudio): void {
    if (part === this.#current) this.#deliver(audio, part);
    else this.#parts[part]?.waiting.push(audio);
  }

  complete(part: number): void {
    const entry = this.#parts[part];
    if (entry) entry.done = true;
    while (this.#parts[this.#current]?.done) {
      this.#current += 1;
      const next = this.#parts[this.#current];
      if (!next) return;
      for (const audio of next.waiting.splice(0)) this.#deliver(audio, this.#current);
    }
  }
}
