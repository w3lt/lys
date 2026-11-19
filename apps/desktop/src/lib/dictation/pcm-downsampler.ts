/**
 * Converts microphone audio to the audio a dictation sends: signed 16-bit
 * little-endian PCM at the dictation's sample rate, in frames of a fixed
 * number of samples.
 *
 * @remarks The module runs in the audio worklet, so it imports nothing. Each
 * output sample is the input under a windowed-sinc low-pass filter centered
 * on the output's moment, which removes what the lower rate cannot carry
 * before the rate drops. An input already at the output rate passes through
 * unchanged.
 */

/** Bytes one output sample takes: the frames hold 16-bit integers. */
const BYTES_PER_SAMPLE = Int16Array.BYTES_PER_ELEMENT

/** Largest magnitude of a 16-bit sample that is the same on both sides. */
const SAMPLE_SCALE = 32_767

/** Zero crossings of the filter kept on each side of an output sample. */
const FILTER_ZERO_CROSSINGS = 8

/**
 * Share of the output's half rate the filter passes when the rate drops,
 * which leaves room for the filter to fall off before that half rate.
 */
const FILTER_ROLLOFF = 0.9

/** Input samples the buffer holds before it first grows. */
const INITIAL_INPUT_CAPACITY = 1_024

/** The filter one conversion uses. */
type ResamplingFilter = Readonly<{
  /** Input samples from one output sample to the next. */
  step: number
  /** The filter's cutoff, as a share of the input's half rate. */
  cutoff: number
  /** Input samples the filter reaches on each side of an output sample. */
  reach: number
}>

/** Options of a {@link PcmDownsampler}. */
export type PcmDownsamplerOptions = Readonly<{
  /** Sample rate of the input, in hertz. */
  inputRate: number
  /** Sample rate of the output, in hertz. */
  outputRate: number
  /** Samples one output frame holds. */
  frameSamples: number
  /**
   * Called with each full frame, in order.
   *
   * @param frame - The frame's bytes, which the callee owns.
   */
  onFrame: (frame: Uint8Array<ArrayBuffer>) => void
}>

/**
 * Builds the filter for a conversion.
 *
 * @param inputRate - Sample rate of the input, in hertz.
 * @param outputRate - Sample rate of the output, in hertz.
 * @returns The filter: a cutoff below the output's half rate when the rate
 * drops, and at the input's half rate otherwise.
 */
function buildResamplingFilter(
  inputRate: number,
  outputRate: number
): ResamplingFilter {
  const cutoff =
    inputRate > outputRate ? (FILTER_ROLLOFF * outputRate) / inputRate : 1
  return {
    step: inputRate / outputRate,
    cutoff,
    reach: Math.ceil(FILTER_ZERO_CROSSINGS / cutoff)
  }
}

/**
 * Calculates the filter's weight for one input sample.
 *
 * @param offset - Distance of the input sample from the output's moment, in
 * input samples.
 * @param filter - The conversion's filter.
 * @returns The weight: a sinc at the cutoff under a Hann window, and zero at
 * and beyond the filter's reach.
 */
function calculateFilterWeight(
  offset: number,
  filter: ResamplingFilter
): number {
  const distance = Math.abs(offset)
  if (distance >= filter.reach) return 0
  const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / filter.reach)
  const phase = Math.PI * filter.cutoff * offset
  const sinc = phase === 0 ? 1 : Math.sin(phase) / phase
  return filter.cutoff * sinc * window
}

/**
 * Calculates one output sample.
 *
 * @param input - Buffered input, which holds every sample up to the filter's
 * reach after `position`.
 * @param position - The output's moment, in input samples from the buffer's
 * start.
 * @param filter - The conversion's filter.
 * @returns The filtered sample: the weighted sum of the buffered input
 * within the filter's reach, divided by the sum of those weights. Input
 * before the buffer's start is left out, not counted as silence, so the
 * first samples of a recording keep their level.
 */
function calculateFilteredSample(
  input: Float32Array,
  position: number,
  filter: ResamplingFilter
): number {
  const center = Math.floor(position)
  const first = Math.max(0, center - filter.reach + 1)
  const last = center + filter.reach
  let sum = 0
  let weightSum = 0
  for (let index = first; index <= last; index += 1) {
    const weight = calculateFilterWeight(index - position, filter)
    sum += input[index] * weight
    weightSum += weight
  }
  return weightSum === 0 ? 0 : sum / weightSum
}

/**
 * Converts a stream of mono float samples to frames of 16-bit PCM at a lower
 * or equal sample rate.
 *
 * @remarks Lifecycle: one instance per recording; it holds the input the
 * filter still needs and the frame being filled, and there is nothing to
 * release. Samples that do not fill a frame stay in the instance.
 * Concurrency model: confined to the thread that calls
 * {@link PcmDownsampler.addSamples}, which is the audio rendering thread.
 * After the buffer's first growth, a call allocates only the frames it
 * completes.
 */
export class PcmDownsampler {
  /** The conversion's filter. */
  readonly #filter: ResamplingFilter
  /** Receives each full frame. */
  readonly #onFrame: (frame: Uint8Array<ArrayBuffer>) => void
  /** Buffered input; only its first {@link PcmDownsampler.#inputLength} samples count. */
  #input: Float32Array<ArrayBuffer> = new Float32Array(INITIAL_INPUT_CAPACITY)
  /** Samples of buffered input. */
  #inputLength = 0
  /** Moment of the next output sample, in input samples from the buffer's start. */
  #position = 0
  /** The frame being filled. */
  readonly #frame: DataView<ArrayBuffer>
  /** Samples written to the frame being filled. */
  #frameLength = 0

  /**
   * Creates a converter.
   *
   * @param options - The two sample rates, the frame size, and the frames'
   * receiver.
   */
  public constructor(options: PcmDownsamplerOptions) {
    this.#filter = buildResamplingFilter(options.inputRate, options.outputRate)
    this.#onFrame = options.onFrame
    this.#frame = new DataView(
      new ArrayBuffer(options.frameSamples * BYTES_PER_SAMPLE)
    )
  }

  /**
   * Adds input samples, and sends every frame they complete.
   *
   * @param samples - Mono samples in [-1, 1], which follow the samples of
   * the call before; the array is not kept.
   */
  public addSamples(samples: Float32Array): void {
    this.#addInput(samples)
    const { step, reach } = this.#filter
    while (Math.floor(this.#position) + reach < this.#inputLength) {
      this.#addOutputSample(
        calculateFilteredSample(this.#input, this.#position, this.#filter)
      )
      this.#position += step
    }
    this.#removeReadInput()
  }

  /**
   * Appends samples to the buffered input, growing the buffer when it is
   * full.
   *
   * @param samples - Samples to append.
   */
  #addInput(samples: Float32Array): void {
    const length = this.#inputLength + samples.length
    if (length > this.#input.length) {
      const grown = new Float32Array(length * 2)
      grown.set(this.#input.subarray(0, this.#inputLength))
      this.#input = grown
    }
    this.#input.set(samples, this.#inputLength)
    this.#inputLength = length
  }

  /**
   * Removes the buffered input no later output sample reads, and moves the
   * rest to the buffer's start.
   */
  #removeReadInput(): void {
    const firstNeeded = Math.max(
      0,
      Math.floor(this.#position) - this.#filter.reach + 1
    )
    const removed = Math.min(firstNeeded, this.#inputLength)
    this.#input.copyWithin(0, removed, this.#inputLength)
    this.#inputLength -= removed
    this.#position -= removed
  }

  /**
   * Writes one sample to the frame being filled, and sends the frame once it
   * is full.
   *
   * @param sample - The sample; a value outside [-1, 1] is clamped.
   */
  #addOutputSample(sample: number): void {
    const clamped = Math.max(-1, Math.min(1, sample))
    this.#frame.setInt16(
      this.#frameLength * BYTES_PER_SAMPLE,
      Math.round(clamped * SAMPLE_SCALE),
      true
    )
    this.#frameLength += 1
    if (this.#frameLength * BYTES_PER_SAMPLE < this.#frame.byteLength) return
    this.#frameLength = 0
    this.#onFrame(new Uint8Array(this.#frame.buffer.slice(0)))
  }
}
