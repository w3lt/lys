import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import * as z from "zod"
import { buildApp } from "../../src/app"
import type { BackendConfig } from "../../src/config"
import SqliteConversationHistoryEditor from "../../src/di/services/conversationService/historyEditor"
import SqliteConversationHistoryReader from "../../src/di/services/conversationService/historyReader"
import SqliteConversationTurns from "../../src/di/services/conversationService/turns"
import { TEST_BACKEND_CONFIG } from "./support/backendConfig"
import {
  fakeLmStudio,
  type FakeLmStudioOperations
} from "./support/lmStudioSdkFake"

vi.mock("@lmstudio/sdk", () => import("./support/lmStudioSdkFake"))

/**
 * Creates a configuration that satisfies `backendConfigSchema`, with the
 * conversation database in a temporary directory owned by the current test.
 *
 * @returns The test configuration; the directory exists, so a store opened on
 * its database path would create the file. The directory is removed when the
 * test finishes.
 */
function createOwnedBackendConfig(): BackendConfig {
  const directory = mkdtempSync(join(tmpdir(), "lys-app-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    ...TEST_BACKEND_CONFIG,
    databaseFilePath: join(directory, "lys_db.sqlite")
  }
}

describe("buildApp", () => {
  beforeEach(() => {
    fakeLmStudio.reset()
  })

  it("rejects a configuration that fails backendConfigSchema before acquiring any service", async () => {
    // Every interface is refused: the backend does not authenticate
    // non-browser callers, so it must listen on loopback only.
    const config = { ...createOwnedBackendConfig(), backendHost: "0.0.0.0" }
    const constructClient = vi.fn<FakeLmStudioOperations["constructClient"]>()
    fakeLmStudio.operations = { ...fakeLmStudio.operations, constructClient }

    const build = buildApp({ config })

    await expect(build).rejects.toBeInstanceOf(z.ZodError)
    await expect(build).rejects.toMatchObject({
      issues: [{ path: ["backendHost"] }]
    })
    expect(constructClient).not.toHaveBeenCalled()
    expect(existsSync(config.databaseFilePath)).toBe(false)
  })

  it("decorates each conversation adapter and serves history from the configured database", async () => {
    const app = await buildApp({ config: createOwnedBackendConfig() })
    onTestFinished(async () => await app.close())
    await app.ready()

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations"
    })

    expect(app.conversationTurns).toBeInstanceOf(SqliteConversationTurns)
    expect(app.conversationHistoryReader).toBeInstanceOf(
      SqliteConversationHistoryReader
    )
    expect(app.conversationHistoryEditor).toBeInstanceOf(
      SqliteConversationHistoryEditor
    )
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ storedCount: 0 })
  })
})
