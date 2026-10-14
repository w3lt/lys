import { backendToolUnavailableReasonSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import type {
  TurnToolLookup,
  BuiltInToolProvider
} from "../../../src/modules/tool/builtIn/builtInTool"

/** One ready provider and the lookup status it is set up to give. */
export type BuiltInToolProviderHarness = Readonly<{
  /** Provider under test. */
  provider: BuiltInToolProvider
  /** Status every lookup of this setup gives. */
  expectedStatus: TurnToolLookup["status"]
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
    it("resolves with a frozen lookup of the expected status", async () => {
      const harness = await createHarness()

      const lookup = await harness.provider.findTurnTool()

      expect(lookup.status).toBe(harness.expectedStatus)
      expect(Object.isFrozen(lookup)).toBe(true)
    })

    it("gives a tool that parses calls, or a reason from the closed set", async () => {
      const harness = await createHarness()

      const lookup = await harness.provider.findTurnTool()

      if (lookup.status === "ready") {
        expect(typeof lookup.tool.parseToolCall).toBe("function")
      } else {
        expect(
          backendToolUnavailableReasonSchema.safeParse(lookup.reason).success
        ).toBe(true)
      }
    })

    it("looks up again on every call, with the same status for the same setup", async () => {
      const harness = await createHarness()

      const lookups = await Promise.all([
        harness.provider.findTurnTool(),
        harness.provider.findTurnTool()
      ])

      expect(lookups.map((lookup) => lookup.status)).toEqual([
        harness.expectedStatus,
        harness.expectedStatus
      ])
    })
  })
}
