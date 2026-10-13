import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { clearMocks } from "@tauri-apps/api/mocks"
import { afterEach, beforeEach } from "vitest"
import { startBackendFake } from "./support/backendFake"

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
