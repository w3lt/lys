import { after, describe, it } from "node:test"
import { RuleTester } from "@typescript-eslint/rule-tester"

// RuleTester registers one test per case through these hooks, and cleans up
// through the after hook; without them it cannot run under node:test.
RuleTester.afterAll = after
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

/**
 * File names the parser assumes for test cases: `.tsx`, so that cases can
 * use TypeScript and JSX together.
 */
const defaultFilenames = Object.freeze({
  ts: "component.tsx",
  tsx: "component.tsx"
})

/**
 * Rule tester that parses TypeScript and JSX with the typescript-eslint
 * parser, as the repository configuration does, and reports each case as a
 * `node:test` test.
 */
export const ruleTester = new RuleTester({ defaultFilenames })

/** Report that a test case expects a plugin rule to make. */
export type ExpectedReport<TMessageId extends string> = {
  /** Report template the rule uses. */
  readonly messageId: TMessageId

  /** Measured value the template interpolates, when it has one. */
  readonly data?: Readonly<Record<"count", number>>
}

/**
 * Builds an expected report without interpolated values.
 *
 * @param messageId - Report template the rule uses.
 * @returns The report a test case expects.
 */
export function expectedReport<TMessageId extends string>(
  messageId: TMessageId
): ExpectedReport<TMessageId> {
  return Object.freeze({ messageId })
}

/**
 * Builds an expected report of a measured value.
 *
 * @param messageId - Report template the rule uses.
 * @param count - Measured value the template interpolates.
 * @returns The report a test case expects.
 */
export function expectedCountReport<TMessageId extends string>(
  messageId: TMessageId,
  count: number
): ExpectedReport<TMessageId> {
  const data = Object.freeze({ count })
  return Object.freeze({ messageId, data })
}
