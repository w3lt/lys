import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  apiHeathCheckRoute,
  chatApi,
  deleteConversationApi,
  getConversationApi,
  listConversationsApi,
  llmListModelsApi,
  llmLoadModelApi,
  llmTestModelApi,
  llmUnloadModelApi,
  updateConversationTitleApi
} from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import * as z from "zod"
import { buildApp } from "../../src/app"
import type { BackendConfig } from "../../src/config"
import ChatService from "../../src/di/services/chatService"
import SqliteConversationStore from "../../src/di/services/conversationService"
import LlmService from "../../src/di/services/llmService"
import { TEST_BACKEND_CONFIG } from "./support/backendConfig"
import { fakeLmStudio } from "./support/lmStudioSdkFake"

vi.mock("@lmstudio/sdk", () => import("./support/lmStudioSdkFake"))

/** Method and path of every route the backend publishes, from the shared protocol. */
const PUBLISHED_ROUTES = Object.freeze([
  { method: "GET", url: apiHeathCheckRoute },
  ...[
    llmListModelsApi,
    llmLoadModelApi,
    llmUnloadModelApi,
    llmTestModelApi,
    chatApi,
    listConversationsApi,
    getConversationApi,
    updateConversationTitleApi,
    deleteConversationApi
  ].map(({ method, path }) => ({ method, url: path }))
])

/**
 * Creates a configuration that satisfies `backendConfigSchema`, with the
 * conversation database in a temporary directory owned by the current test.
 *
 * @returns The test configuration with a valid backend port and an absolute
 * database path; the directory is removed when the test finishes.
 * @remarks The schema requires an absolute database path, so the in-memory
 * location of `TEST_BACKEND_CONFIG` is not accepted. No LM Studio connection
 * is made because the SDK is replaced by the fake.
 */
function createOwnedBackendConfig(): BackendConfig {
  const directory = mkdtempSync(join(tmpdir(), "lys-app-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    ...TEST_BACKEND_CONFIG,
    backendPort: 12_345,
    databaseFilePath: join(directory, "lys_db.sqlite")
  }
}

/**
 * Builds the application and closes it when the current test finishes.
 *
 * @param config - Configuration passed to `buildApp`.
 * @returns The application once `buildApp` resolves.
 * @throws Whatever `buildApp` rejects with; nothing is left to close then.
 */
async function buildOwnedApp(config: BackendConfig): Promise<FastifyInstance> {
  const app = await buildApp({ config })
  onTestFinished(async () => {
    await app.close()
  })
  return app
}

/**
 * Lists the published routes an application does not serve.
 *
 * @param app - Application whose route table is inspected.
 * @returns The missing routes; empty when every published route is registered.
 */
function findMissingPublishedRoutes(app: FastifyInstance) {
  return PUBLISHED_ROUTES.filter((route) => !app.hasRoute(route))
}

describe("buildApp", () => {
  beforeEach(() => {
    fakeLmStudio.reset()
  })

  it("builds a ready application with its services and published routes when LM Studio is running", async () => {
    const app = await buildOwnedApp(createOwnedBackendConfig())

    await app.ready()

    expect(app.chatService).toBeInstanceOf(ChatService)
    expect(app.llmService).toBeInstanceOf(LlmService)
    expect(app.conversationService).toBeInstanceOf(SqliteConversationStore)
    expect(findMissingPublishedRoutes(app)).toEqual([])
  })

  // Expected to fail until #47 is fixed: buildApp currently rejects with
  // "The LLM runtime is unavailable." when the LM Studio readiness query fails.
  // The intended contract is that the application still builds without it.
  it("builds a ready application with its published routes when LM Studio is not running", async () => {
    fakeLmStudio.operations.getLMStudioVersion = async () => {
      throw new Error("connect ECONNREFUSED")
    }

    const app = await buildOwnedApp(createOwnedBackendConfig())
    await app.ready()

    expect(findMissingPublishedRoutes(app)).toEqual([])
  })

  it("rejects a configuration that fails backendConfigSchema before acquiring any service", async () => {
    // Every interface is refused: the backend does not authenticate
    // non-browser callers, so it must listen on loopback only.
    const config = { ...createOwnedBackendConfig(), backendHost: "0.0.0.0" }

    const build = buildApp({ config })

    await expect(build).rejects.toBeInstanceOf(z.ZodError)
    await expect(build).rejects.toMatchObject({
      issues: [{ path: ["backendHost"] }]
    })
    expect(fakeLmStudio.clients).toEqual([])
    expect(existsSync(config.databaseFilePath)).toBe(false)
  })
})
