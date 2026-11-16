import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { clearMocks } from "@tauri-apps/api/mocks"
import { afterEach, beforeEach } from "vitest"
import { startBackendFake } from "./support/backendFake"

/**
 * Streams the blob's bytes, as the platform's `Blob.stream()` does. jsdom's
 * Blob has no `stream()`, and Shiki's WebAssembly loader calls it to unpack
 * its engine, so without it every Markdown pass that runs Shiki fails.
 * @param this - The blob whose bytes the stream yields.
 * @returns A stream that yields the blob's bytes in one chunk and then
 * closes, or errors when the bytes cannot be read.
 */
function streamBlobBytes(this: Blob): ReturnType<Blob["stream"]> {
  const bytes = this.arrayBuffer()
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array(await bytes))
      controller.close()
    }
  })
}

if (!Object.hasOwn(Blob.prototype, "stream")) {
  Blob.prototype.stream = streamBlobBytes
}

// Vitest globals are off, so Testing Library cannot register its own cleanup.
// Unmount every rendered tree and remove the Tauri IPC double after each case,
// so neither a rendered component nor a native command handler reaches the
// next case. The document outlives a case within a file, so the stored
// preferences and root classes a component wrote are cleared as well.
afterEach(() => {
  cleanup()
  clearMocks()
  window.localStorage.clear()
  document.documentElement.removeAttribute("class")
})

// No case may reach a real backend through the platform fetch, whatever the
// developer has running. Every case starts with a backend that declares no
// route, so a request the case did not arrange fails it; a case that expects
// requests starts its own backend fake, which replaces this one.
beforeEach(() => {
  startBackendFake({})
})
