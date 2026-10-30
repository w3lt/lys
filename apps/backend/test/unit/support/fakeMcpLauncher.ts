// A launcher for tests, like `npx` or a shell wrapper, run directly by Node:
// `node fakeMcpLauncher.ts '<options JSON>'`. It starts the fake stdio MCP
// server as its own child with the same standard streams, so the server is
// a grandchild of the backend, does not pass `SIGTERM` on, and exits with
// the server's code once the server exits.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const serverPath = fileURLToPath(
  new URL("./fakeMcpStdioServer.ts", import.meta.url)
)
process.on("SIGTERM", () => undefined)
process.stderr.write(`launcher pid ${process.pid}\n`)
const server = spawn(
  process.execPath,
  ["--no-warnings", serverPath, process.argv[2] ?? "{}"],
  { stdio: "inherit" }
)
server.on("exit", (code) => process.exit(code ?? 1))
