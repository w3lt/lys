import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"
import tailwindcss from "@tailwindcss/vite"

/** Optional Tauri-provided hostname used for the desktop dev server and HMR. */
const host = process.env.TAURI_DEV_HOST

/**
 * Vite and Vitest configuration for the Tauri desktop application.
 *
 * @remarks The React and Tailwind plugins transform the renderer bundle. Tauri
 * development uses fixed HTTP port 1420 and fails instead of selecting another
 * port. When `TAURI_DEV_HOST` is non-empty, custom websocket HMR configuration
 * uses that host with protocol `ws` and port 1421; when absent or empty, the
 * HMR override is undefined and Vite's default HMR behavior remains while the
 * server host override becomes `false`. The `@` alias resolves to the renderer
 * source directory, while Vitest runs in jsdom with the shared test setup and
 * CSS handling. The `src-tauri` directory is excluded from Vite watch work.
 */
export default defineConfig(async () => ({
  // Renderer transforms required by the desktop bundle.
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. Keep Vite from obscuring Rust errors in the terminal.
  clearScreen: false,
  // 2. Tauri expects HTTP port 1420; fail if that port is not available.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421
        }
      : undefined,
    watch: {
      // 3. Do not watch Rust sources that Tauri owns.
      ignored: ["**/src-tauri/**"]
    }
  },

  resolve: {
    // Keep renderer imports independent of the importing file's depth.
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },

  test: {
    // Vitest settings shared by desktop unit and component tests.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true
  }
}))
