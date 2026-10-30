import {
  mcpServerListSchema,
  mcpServerNotFoundProblemSchema,
  type McpServerList
} from "@lys/protocol"
import type { McpServerSettings } from "@lys/share"
import { writeFile } from "node:fs/promises"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import { readMcpSettings } from "../../../../../src/infrastructure/settings/mcpSettingsFile"
import type { McpServerConnectionContext } from "../../../../../src/modules/mcp/mcpServerConnection"
import { openMcpServer } from "../../../../../src/modules/mcp/mcpServerOpening"
import type { McpServerEvent } from "../../../../../src/modules/mcp/mcpServerEvent"
import McpServerRegistry from "../../../../../src/modules/mcp/mcpServerRegistry"
import registerMcpRoutes from "../../../../../src/modules/mcp/routes"
import { createTestFastify } from "../../../support/fastifyTestApp"
import {
  buildFakeStdioServerSettings,
  buildHttpServerSettings,
  findClosedMcpUrl
} from "../../../support/mcpTestServers"
import { createSettingsFilePath } from "../../../support/settingsFile"

/** Path of the server list. */
const SERVERS_URL = "/api/v1/mcp/servers"

/** Path of the settings sync. */
const SYNC_URL = "/api/v1/mcp/servers/sync"

/** Longest one test opening may take; far above a local fake server's start. */
const OPENING_TIMEOUT_MILLISECONDS = 10_000

/** Bound of every wait for the servers to reach a state. */
const STATE_WAIT = Object.freeze({ timeout: 10_000, interval: 10 })

/** Longest one case may run; a case may start a server process. */
const CASE_TIMEOUT_MILLISECONDS = 30_000

/** Origin of a web page open in the person's browser. */
const WEB_PAGE_ORIGIN = "https://attacker.example"

/** Value of an environment variable that must never leave the backend. */
const SECRET_ENVIRONMENT_VALUE = "secret-environment-value-7f3a"

/** Value of a header that must never leave the backend. */
const SECRET_HEADER_VALUE = "Bearer secret-header-value-91c2"

/** Settings of the stdio server most cases apply. */
const FILES_SERVER = buildFakeStdioServerSettings("files")

/** A list holding only the files server, being opened. */
const FILES_CONNECTING: McpServerList = {
  settings: "applied",
  servers: [
    { name: "files", transport: "stdio", state: { status: "connecting" } }
  ]
}

/** A list holding only the files server, connected. */
const FILES_CONNECTED: McpServerList = {
  settings: "applied",
  servers: [
    {
      name: "files",
      transport: "stdio",
      state: {
        status: "connected",
        toolCount: 1,
        skippedTools: [],
        isToolListCut: false
      }
    }
  ]
}

/**
 * Builds the path that reconnects one server.
 *
 * @param serverName - Name in the path.
 * @returns The path.
 */
function buildReconnectUrl(serverName: string): string {
  return `${SERVERS_URL}/${serverName}/reconnect`
}

/**
 * Writes the `mcp` group to a settings file, replacing the file.
 *
 * @param path - Settings file path.
 * @param servers - Servers in settings order.
 */
async function writeMcpSettings(
  path: string,
  servers: readonly McpServerSettings[]
): Promise<void> {
  await writeFile(path, JSON.stringify({ mcp: { servers } }))
}

/**
 * Registers the MCP routes, behind the backend's HTTP transport, over a
 * registry that reads a settings file and opens servers as production does,
 * closed when the case finishes.
 *
 * @param settingsFilePath - Settings file the registry reads; it may not
 * exist yet.
 * @returns The application, the registry, its settings reader and opener,
 * both spied on, and the events it reported.
 */
async function createMcpRouteApp(settingsFilePath: string) {
  const events: McpServerEvent[] = []
  const readSettings = vi.fn(() => readMcpSettings(settingsFilePath))
  const openServer = vi.fn(
    (settings: McpServerSettings, context: McpServerConnectionContext) =>
      openMcpServer(settings, context, OPENING_TIMEOUT_MILLISECONDS)
  )
  const registry = new McpServerRegistry({
    readSettings,
    openServer,
    workingDirectory: process.cwd(),
    reportEvent: (event) => events.push(event)
  })
  onTestFinished(async () => {
    await registry.close()
  })
  const { app } = createTestFastify()
  await updateFastifyWithHttpTransport(app)
  app.decorate("mcpServerRegistry", registry)
  await registerMcpRoutes(app)
  return { app, registry, readSettings, openServer, events }
}

/**
 * Waits until the registry lists exactly these servers, observing the list
 * again on each try without acting.
 *
 * @param registry - Registry behind the routes.
 * @param expected - Expected list.
 */
async function waitForServerList(
  registry: McpServerRegistry,
  expected: McpServerList
): Promise<void> {
  await vi.waitFor(() => {
    expect(registry.listServers()).toEqual(expected)
  }, STATE_WAIT)
}

describe("registerMcpRoutes", { timeout: CASE_TIMEOUT_MILLISECONDS }, () => {
  describe("server list", () => {
    it("lists no server, and neither reads nor applies the settings file, before the settings are applied", async () => {
      const settingsFilePath = await createSettingsFilePath()
      await writeMcpSettings(settingsFilePath, [FILES_SERVER])
      const { app, registry, readSettings, openServer } =
        await createMcpRouteApp(settingsFilePath)

      const response = await app.inject({ method: "GET", url: SERVERS_URL })
      // Settings reads run in call order, so once this sync answers, any
      // read the list request started has been applied too.
      await app.inject({ method: "POST", url: SYNC_URL, payload: {} })
      await waitForServerList(registry, FILES_CONNECTED)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ settings: "applied", servers: [] })
      expect(mcpServerListSchema.safeParse(response.json()).success).toBe(true)
      expect(readSettings).toHaveBeenCalledOnce()
      expect(openServer).toHaveBeenCalledOnce()
    })

    it("lists the applied servers and their states without any of their settings", async () => {
      const settingsFilePath = await createSettingsFilePath()
      const remoteUrl = await findClosedMcpUrl()
      await writeMcpSettings(settingsFilePath, [
        buildFakeStdioServerSettings("files", {}, [
          { name: "LYS_TEST_TOKEN", value: SECRET_ENVIRONMENT_VALUE }
        ]),
        buildHttpServerSettings("remote", remoteUrl, [
          { name: "Authorization", value: SECRET_HEADER_VALUE }
        ])
      ])
      const { app, registry } = await createMcpRouteApp(settingsFilePath)
      await app.inject({ method: "POST", url: SYNC_URL, payload: {} })
      const expected: McpServerList = {
        settings: "applied",
        servers: [
          ...FILES_CONNECTED.servers,
          {
            name: "remote",
            transport: "http",
            state: { status: "failed", reason: "unreachable" }
          }
        ]
      }
      await waitForServerList(registry, expected)

      const response = await app.inject({ method: "GET", url: SERVERS_URL })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(expected)
      expect(mcpServerListSchema.safeParse(response.json()).success).toBe(true)
      for (const setting of [
        SECRET_ENVIRONMENT_VALUE,
        "LYS_TEST_TOKEN",
        SECRET_HEADER_VALUE,
        "Authorization",
        remoteUrl,
        process.execPath,
        "fakeMcpStdioServer"
      ])
        expect(response.body).not.toContain(setting)
    })

    it("registers the server list path for GET only", async () => {
      const { app } = await createMcpRouteApp(await createSettingsFilePath())

      const response = await app.inject({
        method: "POST",
        url: SERVERS_URL,
        payload: {}
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe("sync", () => {
    it("reads the settings file again on each sync and answers with the servers it opens as connecting", async () => {
      const settingsFilePath = await createSettingsFilePath()
      await writeMcpSettings(settingsFilePath, [FILES_SERVER])
      const { app, openServer } = await createMcpRouteApp(settingsFilePath)

      const first = await app.inject({
        method: "POST",
        url: SYNC_URL,
        payload: {}
      })
      await writeMcpSettings(settingsFilePath, [])
      const second = await app.inject({
        method: "POST",
        url: SYNC_URL,
        payload: {}
      })

      expect(first.statusCode).toBe(200)
      expect(first.json()).toEqual(FILES_CONNECTING)
      expect(mcpServerListSchema.safeParse(first.json()).success).toBe(true)
      expect(second.statusCode).toBe(200)
      expect(second.json()).toEqual({ settings: "applied", servers: [] })
      expect(openServer).toHaveBeenCalledOnce()
    })

    it("answers invalid and keeps the applied servers when the group fails its rules", async () => {
      const settingsFilePath = await createSettingsFilePath()
      await writeMcpSettings(settingsFilePath, [FILES_SERVER])
      const { app, registry, events } =
        await createMcpRouteApp(settingsFilePath)
      await app.inject({ method: "POST", url: SYNC_URL, payload: {} })
      await waitForServerList(registry, FILES_CONNECTED)
      await writeFile(
        settingsFilePath,
        JSON.stringify({
          mcp: {
            servers: [{ name: "Not Valid", transport: "stdio", command: "x" }]
          }
        })
      )

      const response = await app.inject({
        method: "POST",
        url: SYNC_URL,
        payload: {}
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        ...FILES_CONNECTED,
        settings: "invalid"
      })
      expect(response.body).not.toContain("Not Valid")
      expect(events).toContainEqual({
        kind: "settings-invalid",
        problems: [expect.stringMatching(/^servers\.0\.name: /u)]
      })
    })

    it("answers applied with no server when the settings file does not exist", async () => {
      const { app, openServer } = await createMcpRouteApp(
        await createSettingsFilePath()
      )

      const response = await app.inject({
        method: "POST",
        url: SYNC_URL,
        payload: {}
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ settings: "applied", servers: [] })
      expect(openServer).not.toHaveBeenCalled()
    })

    // Each is a request a web page can send to another origin without a
    // CORS preflight, so none may start a server.
    it.each([
      ["a GET", { method: "GET", headers: {} }, 404],
      ["a POST without a body", { method: "POST", headers: {} }, 400],
      [
        "a POST of plain text",
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          payload: "{}"
        },
        400
      ],
      [
        "a POST of a form",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "sync=1"
        },
        415
      ],
      [
        "a POST of a JSON object that is not empty",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ force: true })
        },
        400
      ]
    ] as const)(
      "refuses %s to the sync before reading the settings",
      async (_label, request, statusCode) => {
        const settingsFilePath = await createSettingsFilePath()
        await writeMcpSettings(settingsFilePath, [FILES_SERVER])
        const { app, registry, openServer } =
          await createMcpRouteApp(settingsFilePath)

        const response = await app.inject({
          ...request,
          url: SYNC_URL,
          headers: { ...request.headers, origin: WEB_PAGE_ORIGIN }
        })

        expect(response.statusCode).toBe(statusCode)
        expect(registry.listServers()).toEqual({
          settings: "applied",
          servers: []
        })
        expect(openServer).not.toHaveBeenCalled()
      }
    )

    it("grants a web page's preflight for the sync no access", async () => {
      const { app } = await createMcpRouteApp(await createSettingsFilePath())

      const response = await app.inject({
        method: "OPTIONS",
        url: SYNC_URL,
        headers: {
          origin: WEB_PAGE_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type"
        }
      })

      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
    })
  })

  describe("reconnect", () => {
    it("opens an applied server again and answers with it connecting", async () => {
      const settingsFilePath = await createSettingsFilePath()
      await writeMcpSettings(settingsFilePath, [FILES_SERVER])
      const { app, registry, openServer } =
        await createMcpRouteApp(settingsFilePath)
      await app.inject({ method: "POST", url: SYNC_URL, payload: {} })
      await waitForServerList(registry, FILES_CONNECTED)

      const response = await app.inject({
        method: "POST",
        url: buildReconnectUrl("files"),
        payload: {}
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(FILES_CONNECTING)
      expect(mcpServerListSchema.safeParse(response.json()).success).toBe(true)
      await waitForServerList(registry, FILES_CONNECTED)
      expect(openServer).toHaveBeenCalledTimes(2)
    })

    it("answers the server-not-found problem for a name no applied server has", async () => {
      const { app, openServer } = await createMcpRouteApp(
        await createSettingsFilePath()
      )

      const response = await app.inject({
        method: "POST",
        url: buildReconnectUrl("ghost"),
        payload: {}
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/u
      )
      expect(response.json()).toEqual({
        type: "urn:lys:problem:mcp:server-not-found",
        title: "MCP server not found",
        status: 404,
        detail: "No MCP server named ghost is applied.",
        instance: buildReconnectUrl("ghost")
      })
      expect(
        mcpServerNotFoundProblemSchema.safeParse(response.json()).success
      ).toBe(true)
      expect(openServer).not.toHaveBeenCalled()
    })

    it.each(["Files", "file_server", "-files", "files-", "two--hyphens"])(
      "refuses the malformed server name %s before any lookup",
      async (serverName) => {
        const { app } = await createMcpRouteApp(await createSettingsFilePath())

        const response = await app.inject({
          method: "POST",
          url: buildReconnectUrl(serverName),
          payload: {}
        })

        expect(response.statusCode).toBe(400)
        expect(response.body).not.toContain("server-not-found")
      }
    )

    it.each([
      ["a POST without a body", { headers: {} }, 400],
      [
        "a POST of plain text",
        { headers: { "content-type": "text/plain" }, payload: "{}" },
        400
      ],
      [
        "a POST of a form",
        {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "reconnect=1"
        },
        415
      ],
      [
        "a POST of a JSON object that is not empty",
        {
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ force: true })
        },
        400
      ]
    ] as const)(
      "refuses %s to the reconnect before opening anything",
      async (_label, request, statusCode) => {
        const settingsFilePath = await createSettingsFilePath()
        await writeMcpSettings(settingsFilePath, [FILES_SERVER])
        const { app, registry, openServer } =
          await createMcpRouteApp(settingsFilePath)
        await app.inject({ method: "POST", url: SYNC_URL, payload: {} })
        await waitForServerList(registry, FILES_CONNECTED)

        const response = await app.inject({
          ...request,
          method: "POST",
          url: buildReconnectUrl("files"),
          headers: { ...request.headers, origin: WEB_PAGE_ORIGIN }
        })

        expect(response.statusCode).toBe(statusCode)
        expect(registry.listServers()).toEqual(FILES_CONNECTED)
        expect(openServer).toHaveBeenCalledOnce()
      }
    )
  })
})
