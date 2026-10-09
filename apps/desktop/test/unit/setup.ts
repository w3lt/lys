import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { clearMocks } from "@tauri-apps/api/mocks"
import { afterEach } from "vitest"

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
