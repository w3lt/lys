import { backendToolUnavailableReasonSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import type {
  BuiltInToolPreparation,
  BuiltInToolProvider
} from "../../../src/modules/tool/builtIn/builtInTool"

/** One ready provider and the preparation status it is set up to give. */
export type BuiltInToolProviderHarness = Readonly<{
  /** Provider under test. */
  provider: BuiltInToolProvider
  /** Status every preparation of this setup gives. */
  expectedStatus: BuiltInToolPreparation["status"]
}>

/**
 * Creates one ready provider for the current test, which releases everything
 * it acquired when the test finishes.
 */
export type BuiltInToolProviderHarnessFactory =
  () => Promise<BuiltInToolProviderHarness>

/**
 * Registers the cases every {@link BuiltInToolProvider} implementation
 * passes.
 *
 * @param label - Names the setup, such as "with a saved key".
 * @param createHarness - Creates a fresh provider for each case.
 */
export function registerBuiltInToolProviderContractSuite(
  label: string,
  createHarness: BuiltInToolProviderHarnessFactory
): void {
  describe(`BuiltInToolProvider contract ${label}`, () => {
    it("resolves with a frozen preparation of the expected status", async () => {
      const harness = await createHarness()

      const preparation = await harness.provider.prepareTool()

      expect(preparation.status).toBe(harness.expectedStatus)
      expect(Object.isFrozen(preparation)).toBe(true)
    })

    it("gives a tool that parses calls, or a reason from the closed set", async () => {
      const harness = await createHarness()

      const preparation = await harness.provider.prepareTool()

      if (preparation.status === "ready") {
        expect(typeof preparation.tool.parseToolCall).toBe("function")
      } else {
        expect(
          backendToolUnavailableReasonSchema.safeParse(preparation.reason)
            .success
        ).toBe(true)
      }
    })

    it("prepares again on every call, with the same status for the same setup", async () => {
      const harness = await createHarness()

      const preparations = await Promise.all([
        harness.provider.prepareTool(),
        harness.provider.prepareTool()
      ])

      expect(preparations.map((preparation) => preparation.status)).toEqual([
        harness.expectedStatus,
        harness.expectedStatus
      ])
    })
  })
}
