import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// Loaded by `test.setupFiles` in vite.config.ts before every desktop test
// file. The import registers the jest-dom matchers on Vitest's `expect`, and
// each rendered tree is unmounted after its test so no DOM, listener, or focus
// state leaks into the next test.
afterEach(() => {
  cleanup()
})
