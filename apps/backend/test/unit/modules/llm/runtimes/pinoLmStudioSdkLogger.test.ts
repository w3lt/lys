import { describe, expect, it } from "vitest"
import { createBackendLogger } from "../../../../../src/log"
import PinoLmStudioSdkLogger from "../../../../../src/modules/llm/runtimes/pinoLmStudioSdkLogger"
import { CapturedLogDestination } from "../../../support/fastifyTestApp"

/** Prefix of the SDK's system client, colored as the SDK colors it in a terminal. */
const COLORED_SDK_PREFIX =
  "\u001b[97m[LMStudioClient][System][ClientPort]\u001b[39m"

/**
 * Creates an SDK logger over the backend's logger format, with every level
 * written, and the destination of its lines.
 *
 * @returns The SDK logger and the lines it wrote.
 */
function createCapturedSdkLogger() {
  const log = new CapturedLogDestination()
  const logger = createBackendLogger(log).child({}, { level: "trace" })
  return { sdkLogger: new PinoLmStudioSdkLogger(logger), log }
}

describe("PinoLmStudioSdkLogger", () => {
  it("logs each SDK message as one line at the level the SDK gave it", () => {
    const { sdkLogger, log } = createCapturedSdkLogger()

    sdkLogger.info("[LMStudioClient]", "Register with LM Studio")
    sdkLogger.warn("[LMStudioClient]", "WebSocket connection refused.")
    sdkLogger.error("[LMStudioClient]", "Error in the onMessage callback:")
    sdkLogger.debug("[LMStudioClient]", "Ignoring wsAddress parameter")

    expect(log.records).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "[LMStudioClient] Register with LM Studio"
      }),
      expect.objectContaining({
        level: "warn",
        msg: "[LMStudioClient] WebSocket connection refused."
      }),
      expect.objectContaining({
        level: "error",
        msg: "[LMStudioClient] Error in the onMessage callback:"
      }),
      expect.objectContaining({
        level: "debug",
        msg: "[LMStudioClient] Ignoring wsAddress parameter"
      })
    ])
  })

  it("writes the text the console would print, an error with its stack, without terminal color codes", () => {
    const { sdkLogger, log } = createCapturedSdkLogger()
    const failure = new Error("connect ECONNREFUSED 127.0.0.1:1234")

    sdkLogger.warn(COLORED_SDK_PREFIX, "WebSocket error:", failure)

    expect(log.records).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: `[LMStudioClient][System][ClientPort] WebSocket error: ${failure.stack}`
      })
    ])
  })
})
