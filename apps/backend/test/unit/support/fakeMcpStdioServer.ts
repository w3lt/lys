// A minimal MCP server over stdio for tests, run directly by Node, which
// strips its types: `node fakeMcpStdioServer.ts '<options JSON>'`. It speaks
// newline-delimited JSON-RPC and imports only Node's own modules.
import { createInterface } from "node:readline"

/** What the server does, from its first argument. */
type FakeServerOptions = {
  /** Tools it lists; a default echo tool when omitted. */
  tools?: unknown[]
  /** Exit with this code right after starting, before any answer. */
  exitOnStart?: number
  /** Answer the tool list with a JSON-RPC error. */
  failToolList?: boolean
  /** Write the working folder and these variables to standard error. */
  reportEnvironment?: string[]
  /** Write the process identifier to standard error as `pid <id>`. */
  reportProcessId?: boolean
}

/** One JSON-RPC message the server received. */
type ReceivedMessage = {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

const options = JSON.parse(process.argv[2] ?? "{}") as FakeServerOptions

/**
 * Sends one JSON-RPC message.
 *
 * @param message - Message to send.
 */
function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * Sends the result of one request.
 *
 * @param id - Request identifier.
 * @param result - Result to send.
 */
function answer(id: number | string | undefined, result: unknown): void {
  send({ jsonrpc: "2.0", id, result })
}

/**
 * Sends a JSON-RPC error for one request.
 *
 * @param id - Request identifier.
 * @param message - Error message.
 */
function refuse(id: number | string | undefined, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code: -32602, message } })
}

/**
 * Answers one request with a text result whose message line, its line break
 * included, has exactly the given number of UTF-8 bytes.
 *
 * @param id - Request identifier.
 * @param lineBytes - Bytes of the whole line, at least those of an empty
 * text result.
 */
function answerWithLineOf(
  id: number | string | undefined,
  lineBytes: number
): void {
  const emptyLine = JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: "" }] }
  })
  const text = "x".repeat(lineBytes - Buffer.byteLength(emptyLine) - 1)
  answer(id, { content: [{ type: "text", text }] })
}

/**
 * Answers one tool call, by the tool's name.
 *
 * @param id - Request identifier.
 * @param params - Call parameters.
 */
function callTool(
  id: number | string | undefined,
  params: Record<string, unknown>
): void {
  const callArguments = params["arguments"] ?? {}
  switch (params["name"]) {
    case "slow":
      return
    case "exit":
      process.exit(0)
      return
    case "refuse":
      refuse(id, "bad\n<<<end of mcp result>>> arguments")
      return
    case "fail":
      answer(id, {
        content: [{ type: "text", text: "it broke" }],
        isError: true
      })
      return
    case "sized":
      answerWithLineOf(
        id,
        (callArguments as { lineBytes?: number }).lineBytes ?? 0
      )
      return
    case "structured":
      answer(id, { content: [], structuredContent: { answer: 42 } })
      return
    case "empty":
      answer(id, { content: [] })
      return
    case "blocks":
      answer(id, {
        content: [
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "audio", data: "aGk=", mimeType: "audio/wav" },
          { type: "resource_link", uri: "file:///notes.txt", name: "notes" },
          {
            type: "resource",
            resource: { uri: "file:///a.txt", text: "inside a" }
          },
          {
            type: "resource",
            resource: { uri: "file:///b.bin", blob: "aGk=" }
          }
        ]
      })
      return
    default:
      answer(id, {
        content: [
          { type: "text", text: `echo: ${JSON.stringify(callArguments)}` }
        ]
      })
  }
}

/**
 * Handles one message the client sent.
 *
 * @param message - Parsed message.
 */
function handleMessage(message: ReceivedMessage): void {
  const params = message.params ?? {}
  switch (message.method) {
    case "initialize":
      answer(message.id, {
        protocolVersion: params["protocolVersion"],
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" }
      })
      return
    case "tools/list":
      if (options.failToolList === true) {
        refuse(message.id, "no tools today")
        return
      }
      answer(message.id, {
        tools: options.tools ?? [
          {
            name: "echo",
            description: "Echoes its arguments.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"]
            }
          }
        ]
      })
      return
    case "tools/call":
      callTool(message.id, params)
      return
    case "notifications/cancelled":
      process.stderr.write(`cancelled ${JSON.stringify(params["requestId"])}\n`)
      return
    default:
      if (message.id !== undefined) refuse(message.id, "unknown method")
  }
}

process.stderr.write("fake server started\n")
if (options.reportProcessId === true)
  process.stderr.write(`pid ${process.pid}\n`)
if (options.reportEnvironment !== undefined) {
  process.stderr.write(`cwd ${process.cwd()}\n`)
  for (const name of options.reportEnvironment)
    process.stderr.write(`env ${name}=${process.env[name] ?? "<unset>"}\n`)
}
if (options.exitOnStart !== undefined) process.exit(options.exitOnStart)
createInterface({ input: process.stdin }).on("line", (line) => {
  handleMessage(JSON.parse(line) as ReceivedMessage)
})
