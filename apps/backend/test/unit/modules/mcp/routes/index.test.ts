import {
  checkEmailAccountApiResponseSchema,
  mcpServerListSchema,
  mcpServerNotFoundProblemSchema,
  mcpServerOffProblemSchema,
  type McpServerList
} from "@lys/protocol"
import type { McpServerSettings } from "@lys/share"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import { readEmailAccount } from "../../../../../src/infrastructure/settings/emailAccountFile"
import { readMcpSettings } from "../../../../../src/infrastructure/settings/mcpSettingsFile"
import EmailAccountChecker, {
  type EmailAccountCheckEvent
} from "../../../../../src/modules/mcp/builtIn/email/emailAccountCheck"
import {
  createEmailMcpServer,
  type EmailServerCommand
} from "../../../../../src/modules/mcp/builtIn/email/emailServer"
import type { McpServerConnectionContext } from "../../../../../src/modules/mcp/mcpServerConnection"
import { openMcpServer } from "../../../../../src/modules/mcp/mcpServerOpening"
import type { McpServerEvent } from "../../../../../src/modules/mcp/mcpServerEvent"
import McpServerRegistry, {
  type BuiltInMcpServer
} from "../../../../../src/modules/mcp/mcpServerRegistry"
import registerMcpRoutes from "../../../../../src/modules/mcp/routes"
import {
  buildEmailAccount,
  buildFakeEmailServerCommand,
  readRecordedEmailProcessId,
  readRecordedEmailVariable,
  SYNTHETIC_EMAIL_PASSWORD
} from "../../../support/emailTestServer"
import { createTestFastify } from "../../../support/fastifyTestApp"
import {
  buildFakeStdioServerSettings,
  buildHttpServerSettings,
  findClosedMcpUrl
} from "../../../support/mcpTestServers"
import { createSettingsFilePath } from "../../../support/settingsFile"
import { createOwnedMcpServerProcessGroups } from "../../../support/mcpServerProcessGroups"
import { createUnstartedChildProcess } from "../../../support/unstartedChildProcess"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Readonly<{ spawn: typeof spawn }>>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

/** Path of the server list. */
const SERVERS_URL = "/api/v1/mcp/servers"

/** Path of the settings sync. */
const SYNC_URL = "/api/v1/mcp/servers/sync"

/** Path of the email account check. */
const ACCOUNT_CHECK_URL = "/api/v1/mcp/email/account-check"

/** Longest one account check may run. */
const CHECK_TIMEOUT_MILLISECONDS = 10_000

/** An account check that reports both sign-ins accepted. */
const ACCEPTED_CHECK = Object.freeze({
  account: buildEmailAccount("accepted@example.com"),
  password: SYNTHETIC_EMAIL_PASSWORD
})

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
    {
      name: "files",
      transport: "stdio",
      isBuiltIn: false,
      state: { status: "connecting" }
    }
  ]
}

/** A list holding only the files server, connected. */
const FILES_CONNECTED: McpServerList = {
  settings: "applied",
  servers: [
    {
      name: "files",
      transport: "stdio",
      isBuiltIn: false,
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
 * Saves a settings file that switches the built-in email server on,
 * replacing the file.
 *
 * @param path - Settings file path.
 * @param servers - Added servers in settings order.
 * @param account - The saved account, or null for none.
 */
async function saveEmailSettings(
  path: string,
  servers: readonly McpServerSettings[],
  account: unknown
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      mcp: { servers, builtIn: { email: { enabled: true } } },
      email: { account },
      secrets: { emailPassword: SYNTHETIC_EMAIL_PASSWORD }
    })
  )
}

/**
 * Creates an empty folder for one case, removed after it.
 *
 * @returns Absolute path of the folder.
 */
async function createCaseFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "lys-mcp-routes-"))
  onTestFinished(async () => {
    await rm(folder, { recursive: true, force: true })
  })
  return folder
}

/** What a case may replace in the route application's services. */
type McpRouteAppOptions = Readonly<{
  /** How the email server is run; the fake email server when omitted. */
  emailServerCommand?: EmailServerCommand
  /**
   * Folder stdio servers and account checks start in; the test run's
   * folder when omitted.
   */
  workingDirectory?: string
  /**
   * Whether the registry applies the built-in email server over the
   * settings file and the email server command; false when omitted.
   */
  withBuiltInEmailServer?: boolean
}>

/**
 * Registers the MCP routes, behind the backend's HTTP transport, over a
 * registry that reads a settings file and opens servers as production does,
 * closed when the case finishes.
 *
 * @param settingsFilePath - Settings file the registry reads; it may not
 * exist yet.
 * @param options - What replaces the defaults.
 * @returns The application, the registry, its settings reader and opener,
 * both spied on, the events it reported, and the events the email account
 * checker reported.
 */
async function createMcpRouteApp(
  settingsFilePath: string,
  options: McpRouteAppOptions = {}
) {
  const events: McpServerEvent[] = []
  const checkEvents: EmailAccountCheckEvent[] = []
  const emailServerCommand =
    options.emailServerCommand ?? buildFakeEmailServerCommand()
  const workingDirectory = options.workingDirectory ?? process.cwd()
  const readSettings = vi.fn(() => readMcpSettings(settingsFilePath))
  const openServer = vi.fn(
    (settings: McpServerSettings, context: McpServerConnectionContext) =>
      openMcpServer(settings, context, OPENING_TIMEOUT_MILLISECONDS)
  )
  const { processGroups } = createOwnedMcpServerProcessGroups()
  const builtInServers: BuiltInMcpServer[] = options.withBuiltInEmailServer
    ? [
        createEmailMcpServer(emailServerCommand, () =>
          readEmailAccount(settingsFilePath)
        )
      ]
    : []
  const registry = new McpServerRegistry({
    readSettings,
    builtInServers,
    openServer,
    workingDirectory,
    processGroups,
    reportEvent: (event) => events.push(event)
  })
  const checker = new EmailAccountChecker({
    serverCommand: emailServerCommand,
    workingDirectory,
    timeoutMilliseconds: CHECK_TIMEOUT_MILLISECONDS,
    reportEvent: (event) => checkEvents.push(event)
  })
  onTestFinished(async () => {
    await checker.close()
    await registry.close()
  })
  const { app } = createTestFastify()
  await updateFastifyWithHttpTransport(app)
  app.decorate("mcpServerRegistry", registry)
  app.decorate("emailAccountChecker", checker)
  await registerMcpRoutes(app)
  return { app, registry, readSettings, openServer, events, checkEvents }
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
            isBuiltIn: false,
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

    it("lists the built-in email server first, as a server Lys ships, connected with the saved account", async () => {
      const folder = await createCaseFolder()
      const settingsFilePath = await createSettingsFilePath()
      await saveEmailSettings(
        settingsFilePath,
        [FILES_SERVER],
        buildEmailAccount("accepted@example.com")
      )
      const { app, registry } = await createMcpRouteApp(settingsFilePath, {
        emailServerCommand: buildFakeEmailServerCommand({
          recordsVariable: true
        }),
        workingDirectory: folder,
        withBuiltInEmailServer: true
      })

      const response = await app.inject({
        method: "POST",
        url: SYNC_URL,
        payload: {}
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        settings: "applied",
        servers: [
          {
            name: "email",
            transport: "stdio",
            isBuiltIn: true,
            state: { status: "connecting" }
          },
          ...FILES_CONNECTING.servers
        ]
      })
      await waitForServerList(registry, {
        settings: "applied",
        servers: [
          {
            name: "email",
            transport: "stdio",
            isBuiltIn: true,
            state: {
              status: "connected",
              toolCount: 1,
              skippedTools: [],
              isToolListCut: false
            }
          },
          ...FILES_CONNECTED.servers
        ]
      })
      expect(await readRecordedEmailVariable(folder)).toMatchObject({
        address: "accepted@example.com",
        password: SYNTHETIC_EMAIL_PASSWORD
      })
    })

    it("lists the switched-on built-in email server as failed while no account is saved, without starting it", async () => {
      const settingsFilePath = await createSettingsFilePath()
      await saveEmailSettings(settingsFilePath, [], null)
      const { app, openServer } = await createMcpRouteApp(settingsFilePath, {
        withBuiltInEmailServer: true
      })

      const response = await app.inject({
        method: "POST",
        url: SYNC_URL,
        payload: {}
      })

      expect(response.json()).toEqual({
        settings: "applied",
        servers: [
          {
            name: "email",
            transport: "stdio",
            isBuiltIn: true,
            state: { status: "failed", reason: "account-missing" }
          }
        ]
      })
      expect(openServer).not.toHaveBeenCalled()
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

    it("answers the server-off problem for a switched-off server, and opens nothing", async () => {
      const settingsFilePath = await createSettingsFilePath()
      await writeMcpSettings(settingsFilePath, [
        { ...FILES_SERVER, enabled: false }
      ])
      const { app, openServer } = await createMcpRouteApp(settingsFilePath)
      await app.inject({ method: "POST", url: SYNC_URL, payload: {} })

      const response = await app.inject({
        method: "POST",
        url: buildReconnectUrl("files"),
        payload: {}
      })

      expect(response.statusCode).toBe(409)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/u
      )
      expect(mcpServerOffProblemSchema.safeParse(response.json()).success).toBe(
        true
      )
      expect(response.json()).toMatchObject({
        type: "urn:lys:problem:mcp:server-off",
        status: 409,
        instance: buildReconnectUrl("files")
      })
      expect(openServer).not.toHaveBeenCalled()
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

  describe("email account check", () => {
    it("answers both sign-ins' outcomes for an account and its password, and echoes neither", async () => {
      const { app, checkEvents } = await createMcpRouteApp(
        await createSettingsFilePath()
      )

      const response = await app.inject({
        method: "POST",
        url: ACCOUNT_CHECK_URL,
        payload: {
          account: buildEmailAccount("imap-wrong-password@example.com"),
          password: SYNTHETIC_EMAIL_PASSWORD
        }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        status: "checked",
        imap: { status: "failed", reason: "wrong-password" },
        smtp: { status: "accepted" }
      })
      expect(
        checkEmailAccountApiResponseSchema.safeParse(response.json()).success
      ).toBe(true)
      expect(response.body).not.toContain("7f3a")
      expect(response.body).not.toContain("example.com")
      expect(checkEvents).toEqual([
        {
          kind: "checked",
          imap: { status: "failed", reason: "wrong-password" },
          smtp: { status: "accepted" },
          errorLines: []
        }
      ])
    })

    it("answers unavailable when the email server is not installed", async () => {
      const folder = await createCaseFolder()
      const { app } = await createMcpRouteApp(await createSettingsFilePath(), {
        emailServerCommand: { command: join(folder, "email"), arguments: [] }
      })

      const response = await app.inject({
        method: "POST",
        url: ACCOUNT_CHECK_URL,
        payload: ACCEPTED_CHECK
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        status: "unavailable",
        reason: "server-missing"
      })
    })

    it("answers unavailable, not an HTTP error, when Node throws as it starts the email server", async () => {
      const folder = await createCaseFolder()
      const file = join(folder, "file")
      await writeFile(file, "")
      const { app, checkEvents } = await createMcpRouteApp(
        await createSettingsFilePath(),
        { emailServerCommand: { command: join(file, "email"), arguments: [] } }
      )

      const response = await app.inject({
        method: "POST",
        url: ACCOUNT_CHECK_URL,
        payload: ACCEPTED_CHECK
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        status: "unavailable",
        reason: "server-failed"
      })
      expect(checkEvents).toEqual([
        {
          kind: "server-failed",
          failure: { kind: "start-failed", error: expect.any(Error) }
        }
      ])
    })

    it("answers unavailable, not an HTTP error, when Node finds no file descriptor for the email server's pipes", async () => {
      const { app, checkEvents } = await createMcpRouteApp(
        await createSettingsFilePath()
      )
      vi.mocked(spawn).mockImplementationOnce((command, args) =>
        createUnstartedChildProcess(command, args, "EMFILE")
      )
      onTestFinished(() => {
        vi.mocked(spawn).mockReset()
      })

      const response = await app.inject({
        method: "POST",
        url: ACCOUNT_CHECK_URL,
        payload: ACCEPTED_CHECK
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        status: "unavailable",
        reason: "server-failed"
      })
      expect(checkEvents).toEqual([
        {
          kind: "server-failed",
          failure: { kind: "start-failed", error: expect.any(Error) }
        }
      ])
    })

    it("answers busy at once to a check sent while another runs, and the running check answers its outcome", async () => {
      const folder = await createCaseFolder()
      const { app, checkEvents } = await createMcpRouteApp(
        await createSettingsFilePath(),
        {
          emailServerCommand: buildFakeEmailServerCommand({
            recordsProcessId: true,
            holdMilliseconds: 1000
          }),
          workingDirectory: folder
        }
      )
      const running = app.inject({
        method: "POST",
        url: ACCOUNT_CHECK_URL,
        payload: {
          account: buildEmailAccount("lock@example.com"),
          password: SYNTHETIC_EMAIL_PASSWORD
        }
      })
      await vi.waitFor(async () => {
        await readRecordedEmailProcessId(folder)
      }, STATE_WAIT)

      const refused = await app.inject({
        method: "POST",
        url: ACCOUNT_CHECK_URL,
        payload: ACCEPTED_CHECK
      })

      expect(refused.statusCode).toBe(200)
      expect(refused.json()).toEqual({ status: "unavailable", reason: "busy" })
      expect(
        checkEmailAccountApiResponseSchema.safeParse(refused.json()).success
      ).toBe(true)
      expect(refused.body).not.toContain("7f3a")
      const response = await running
      expect(response.json()).toEqual({
        status: "checked",
        imap: { status: "accepted" },
        smtp: { status: "accepted" }
      })
      expect(checkEvents).toEqual([
        { kind: "busy" },
        {
          kind: "checked",
          imap: { status: "accepted" },
          smtp: { status: "accepted" },
          errorLines: []
        }
      ])
    })

    it.each([
      [
        "a password with a control character",
        {
          account: ACCEPTED_CHECK.account,
          password: "synthetic\u0000password-7f3a"
        }
      ],
      [
        "an account with a plain connection to a remote host",
        {
          account: {
            ...ACCEPTED_CHECK.account,
            smtp: { ...ACCEPTED_CHECK.account.smtp, security: "plain" }
          },
          password: SYNTHETIC_EMAIL_PASSWORD
        }
      ],
      ["no password", { account: ACCEPTED_CHECK.account }],
      ["an unknown field", { ...ACCEPTED_CHECK, remember: true }]
    ])(
      "answers HTTP 400 for %s, without the value, and runs no check",
      async (_label, payload) => {
        const { app, checkEvents } = await createMcpRouteApp(
          await createSettingsFilePath()
        )

        const response = await app.inject({
          method: "POST",
          url: ACCOUNT_CHECK_URL,
          payload
        })

        expect(response.statusCode).toBe(400)
        expect(response.body).not.toContain("7f3a")
        expect(checkEvents).toEqual([])
      }
    )

    // Each is a request a web page can send to another origin without a
    // CORS preflight, so none may run a check.
    it.each([
      [
        "a POST of plain text",
        { "content-type": "text/plain" },
        JSON.stringify(ACCEPTED_CHECK),
        400
      ],
      [
        "a POST of a form",
        { "content-type": "application/x-www-form-urlencoded" },
        "account=accepted%40example.com",
        415
      ]
    ])(
      "refuses %s with HTTP %i, and runs no check",
      async (_label, headers, payload, statusCode) => {
        const { app, checkEvents } = await createMcpRouteApp(
          await createSettingsFilePath()
        )

        const response = await app.inject({
          method: "POST",
          url: ACCOUNT_CHECK_URL,
          headers,
          payload
        })

        expect(response.statusCode).toBe(statusCode)
        expect(checkEvents).toEqual([])
      }
    )

    it("grants a web page's preflight for the account check no access", async () => {
      const { app } = await createMcpRouteApp(await createSettingsFilePath())

      const response = await app.inject({
        method: "OPTIONS",
        url: ACCOUNT_CHECK_URL,
        headers: {
          origin: WEB_PAGE_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type"
        }
      })

      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
    })

    it("registers the account check path for POST only", async () => {
      const { app } = await createMcpRouteApp(await createSettingsFilePath())

      const response = await app.inject({
        method: "GET",
        url: ACCOUNT_CHECK_URL
      })

      expect(response.statusCode).toBe(404)
    })
  })
})
