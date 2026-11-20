const SEARCH_FRACTION = 0.5;
const MINIMUM_TEMPO = 0.25;
const MAXIMUM_TEMPO = 4;

export function clampTempo(tempo: number): number {
  return Number.isFinite(tempo) ? Math.min(MAXIMUM_TEMPO, Math.max(MINIMUM_TEMPO, tempo)) : 1;
}

function windowLength(sampleRate: number): number {
  let length = 256;
  while (length < sampleRate / 24) length *= 2;
  return length;
}

function hannWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let index = 0; index < length; index += 1) window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / length);
  return window;
}

function transform(real: Float64Array, imaginary: Float64Array, inverse: boolean): void {
  const size = real.length;
  for (let index = 1, swap = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [real[index], real[swap]] = [real[swap] ?? 0, real[index] ?? 0];
      [imaginary[index], imaginary[swap]] = [imaginary[swap] ?? 0, imaginary[index] ?? 0];
    }
  }
  for (let span = 2; span <= size; span *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / span;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += span) {
      let turnReal = 1;
      let turnImaginary = 0;
      for (let offset = 0; offset < span / 2; offset += 1) {
        const even = start + offset;
        const odd = even + span / 2;
        const oddReal = (real[odd] ?? 0) * turnReal - (imaginary[odd] ?? 0) * turnImaginary;
        const oddImaginary = (real[odd] ?? 0) * turnImaginary + (imaginary[odd] ?? 0) * turnReal;
        real[odd] = (real[even] ?? 0) - oddReal;
        imaginary[odd] = (imaginary[even] ?? 0) - oddImaginary;
        real[even] = (real[even] ?? 0) + oddReal;
        imaginary[even] = (imaginary[even] ?? 0) + oddImaginary;
        const nextTurnReal = turnReal * stepReal - turnImaginary * stepImaginary;
        turnImaginary = turnReal * stepImaginary + turnImaginary * stepReal;
        turnReal = nextTurnReal;
      }
    }
  }
}

class Correlator {
  readonly #size: number;
  readonly #templateReal: Float64Array;
  readonly #templateImaginary: Float64Array;
  readonly #real: Float64Array;
  readonly #imaginary: Float64Array;

  constructor(span: number) {
    let size = 1;
    while (size < span) size *= 2;
    this.#size = size;
    this.#templateReal = new Float64Array(size);
    this.#templateImaginary = new Float64Array(size);
    this.#real = new Float64Array(size);
    this.#imaginary = new Float64Array(size);
  }

  bestLag(template: Float32Array, region: Float32Array, lags: number): number {
    const templateReal = this.#templateReal;
    const templateImaginary = this.#templateImaginary;
    const real = this.#real;
    const imaginary = this.#imaginary;
    templateReal.fill(0);
    templateImaginary.fill(0);
    real.fill(0);
    imaginary.fill(0);
    templateReal.set(template);
    real.set(region);
    transform(templateReal, templateImaginary, false);
    transform(real, imaginary, false);
    for (let index = 0; index < this.#size; index += 1) {
      const a = real[index] ?? 0;
      const b = imaginary[index] ?? 0;
      const c = templateReal[index] ?? 0;
      const d = -(templateImaginary[index] ?? 0);
      real[index] = a * c - b * d;
      imaginary[index] = a * d + b * c;
    }
    transform(real, imaginary, true);
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let lag = 0; lag <= lags; lag += 1) {
      const score = real[lag] ?? 0;
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }
    return best;
  }
}

export class TempoStretcher {
  readonly #frame: number;
  readonly #hop: number;
  readonly #search: number;
  readonly #window: Float32Array;
  readonly #correlator: Correlator;
  readonly #template: Float32Array;
  readonly #region: Float32Array;
  #input = new Float32Array(0);
  #inputLength = 0;
  #inputOffset = 0;
  #ended = false;
  #tempo = 1;
  #analysis = 0;
  #previous = -1;
  #overlap: Float32Array;
  #ready = new Float32Array(0);
  #readyLength = 0;
  #readyStart = 0;
  #consumed = 0;
  #flushed = false;

  constructor(sampleRate: number) {
    this.#frame = windowLength(sampleRate);
    this.#hop = this.#frame / 2;
    this.#search = Math.round(this.#hop * SEARCH_FRACTION);
    this.#window = hannWindow(this.#frame);
    this.#correlator = new Correlator(this.#frame + 2 * this.#search);
    this.#template = new Float32Array(this.#hop);
    this.#region = new Float32Array(this.#hop + 2 * this.#search);
    this.#overlap = new Float32Array(this.#hop);
  }

  get tempo(): number {
    return this.#tempo;
  }

  get consumedSamples(): number {
    return this.#consumed;
  }

  get finished(): boolean {
    return this.#flushed && this.#readyLength === this.#readyStart;
  }

  setTempo(tempo: number): void {
    this.#tempo = clampTempo(tempo);
  }

  push(samples: Float32Array): void {
    if (this.#ended || samples.length === 0) return;
    this.#reserve(samples.length);
    this.#input.set(samples, this.#inputLength - this.#inputOffset);
    this.#inputLength += samples.length;
  }

  end(): void {
    this.#ended = true;
  }

  read(output: Float32Array): number {
    let written = 0;
    while (written < output.length) {
      if (this.#readyStart === this.#readyLength && !this.#produce()) break;
      const count = Math.min(output.length - written, this.#readyLength - this.#readyStart);
      output.set(this.#ready.subarray(this.#readyStart, this.#readyStart + count), written);
      this.#readyStart += count;
      written += count;
      this.#consumed = Math.min(this.#inputLength, this.#consumed + count * this.#tempo);
    }
    return written;
  }

  #sample(position: number): number {
    if (position < this.#inputOffset || position >= this.#inputLength) return 0;
    return this.#input[position - this.#inputOffset] ?? 0;
  }

  #reserve(extra: number): void {
    const keep = Math.max(0, Math.min(this.#previous, Math.floor(this.#analysis)) - this.#search);
    if (keep > this.#inputOffset) {
      this.#input.copyWithin(0, keep - this.#inputOffset, this.#inputLength - this.#inputOffset);
      this.#inputOffset = keep;
    }
    const needed = this.#inputLength - this.#inputOffset + extra;
    if (needed <= this.#input.length) return;
    const grown = new Float32Array(Math.max(needed, this.#input.length * 2, 4096));
    grown.set(this.#input.subarray(0, this.#inputLength - this.#inputOffset));
    this.#input = grown;
  }

  #produce(): boolean {
    if (this.#flushed) return false;
    const frame = this.#frame;
    const hop = this.#hop;
    const first = this.#previous < 0;
    if (!first && this.#tempo === 1) this.#analysis = this.#previous + hop;
    const nominal = Math.round(this.#analysis);
    const available = this.#inputLength;
    if (!this.#ended && nominal + frame + this.#search > available) return false;
    if (this.#ended && nominal >= available) return this.#flush();
    const start = first || nominal === this.#previous + hop ? nominal : this.#aligned(nominal);
    if (this.#ready.length < hop) this.#ready = new Float32Array(hop);
    for (let index = 0; index < hop; index += 1)
      this.#ready[index] = first
        ? this.#sample(start + index)
        : (this.#overlap[index] ?? 0) + this.#sample(start + index) * (this.#window[index] ?? 0);
    for (let index = 0; index < hop; index += 1)
      this.#overlap[index] = this.#sample(start + hop + index) * (this.#window[hop + index] ?? 0);
    this.#readyStart = 0;
    this.#readyLength = this.#ended ? Math.min(hop, Math.max(0, available - start)) : hop;
    this.#previous = start;
    this.#analysis += hop * this.#tempo;
    if (this.#readyLength < hop) this.#flushed = true;
    return this.#readyLength > 0 || this.#produce();
  }

  #aligned(nominal: number): number {
    const hop = this.#hop;
    const search = this.#search;
    const natural = this.#previous + hop;
    for (let index = 0; index < hop; index += 1) this.#template[index] = this.#sample(natural + index);
    const low = Math.max(this.#inputOffset, nominal - search);
    const region = this.#region;
    for (let index = 0; index < region.length; index += 1) region[index] = this.#sample(low + index);
    const lags = Math.min(2 * search, Math.max(0, this.#inputLength - hop - low));
    return low + this.#correlator.bestLag(this.#template, region, lags);
  }

  #flush(): boolean {
    this.#flushed = true;
    if (this.#previous < 0) return false;
    const tail = Math.min(this.#hop, Math.max(0, this.#inputLength - this.#previous - this.#hop));
    this.#ready = this.#overlap.slice(0, tail);
    this.#readyStart = 0;
    this.#readyLength = tail;
    return tail > 0;
  }
}
