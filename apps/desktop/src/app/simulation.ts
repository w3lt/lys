import { REPLIES } from "./content"

export interface SimulationController {
  cancel(): void
}

export interface TextSimulationOptions {
  text: string
  chunkSize: number
  intervalMs: number
  onChunk(text: string): void
  onComplete(): void
}

export interface ProgressSimulationOptions {
  intervalMs: number
  step: number
  onProgress(progress: number): void
  onComplete(): void
}

export function createTextSimulation({
  text,
  chunkSize,
  intervalMs,
  onChunk,
  onComplete
}: TextSimulationOptions): SimulationController {
  let index = 0
  let cancelled = false
  const timer = window.setInterval(() => {
    if (cancelled) return

    const nextIndex = Math.min(text.length, index + chunkSize)
    onChunk(text.slice(index, nextIndex))
    if (cancelled) return

    index = nextIndex

    if (index === text.length) {
      window.clearInterval(timer)
      onComplete()
    }
  }, intervalMs)

  return {
    cancel() {
      cancelled = true
      window.clearInterval(timer)
    }
  }
}

export function createProgressSimulation({
  intervalMs,
  step,
  onProgress,
  onComplete
}: ProgressSimulationOptions): SimulationController {
  let progress = 0
  let cancelled = false
  const timer = window.setInterval(() => {
    if (cancelled) return

    progress = Math.min(100, progress + step)
    onProgress(progress)
    if (cancelled) return

    if (progress === 100) {
      window.clearInterval(timer)
      onComplete()
    }
  }, intervalMs)

  return {
    cancel() {
      cancelled = true
      window.clearInterval(timer)
    }
  }
}

export function replyForPrompt(prompt: string): string {
  const value = prompt.toLowerCase()

  if (/what are you|who are you|yourself/.test(value)) return REPLIES.identity
  if (/\bstop\b|cancel|abort|interrupt/.test(value)) return REPLIES.stop
  if (/stream|sse|pipeline|lm studio|architect/.test(value))
    return REPLIES.pipeline
  if (/context|trim|window|token/.test(value)) return REPLIES.context

  return REPLIES.generic
}
