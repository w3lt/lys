// A launcher for tests, like `npx` or a shell wrapper, run directly by Node:
// `node fakeMcpLauncher.ts`. It starts the fake stdio MCP server as its own
// child with the same standard streams and environment, so the server is a
// grandchild of the backend and reads its options from
// `LYS_FAKE_MCP_OPTIONS`. The launcher reads no input of its own, does not
// pass `SIGTERM` on, and exits with the server's code once the server exits.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const serverPath = fileURLToPath(
  new URL("./fakeMcpStdioServer.ts", import.meta.url)
)
process.on("SIGTERM", () => undefined)
process.stderr.write(`launcher pid ${process.pid}\n`)
const server = spawn(process.execPath, ["--no-warnings", serverPath], {
  stdio: "inherit"
})
server.on("exit", (code) => process.exit(code ?? 1))
