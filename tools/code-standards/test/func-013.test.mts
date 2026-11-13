import { complexityLimitRule } from "../rules/func-013.mts"
import {
  expectedCountReport,
  expectedReport,
  ruleTester
} from "./rule-tester.mts"

/**
 * Builds consecutive statements, each on a line of its own.
 *
 * @param count - Number of statements.
 * @returns Lines of the form `step(<index>)`.
 */
function statementLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `step(${index})`).join(
    "\n"
  )
}

/**
 * Builds a function declaration whose body holds only statements.
 *
 * @param count - Executable lines in the body.
 * @returns Source of the function `run`.
 */
function functionWithLines(count: number): string {
  return `function run() {\n${statementLines(count)}\n}`
}

/**
 * Builds a function with a multi-line signature, blank, comment, and
 * delimiter-only lines, and two executable lines besides its statements.
 *
 * @param statements - Statement lines before the non-executable lines.
 * @returns Source of the function `run`.
 */
function functionWithNonExecutableLines(statements: number): string {
  return `function run(
    first,
    second
  ) {
    ${statementLines(statements)}

    // A comment line.
    /* A block comment line. */
    configure({
      retries: 1
    })
  }`
}

/**
 * Builds a function with type-only lines, JSX closing tags, and six
 * executable lines besides its statements.
 *
 * @param statements - Statement lines before the typed value and the view.
 * @returns Source of the function `render`.
 */
function functionWithTypesAndJsx(statements: number): string {
  return `function render() {
    ${statementLines(statements)}
    const value: {
      first: string
      second: string
    } = read()
    const view = (
      <Panel
        title="x"
      >
        <Body />
      </Panel>
    )
  }`
}

ruleTester.run("func-013", complexityLimitRule, {
  valid: [
    {
      name: "allows 40 executable lines, the limit",
      code: functionWithLines(40)
    },
    {
      name: "does not count blank, comment, delimiter-only, or signature lines",
      code: functionWithNonExecutableLines(38)
    },
    {
      name: "does not count type-only lines or JSX closing tags",
      code: functionWithTypesAndJsx(34)
    },
    {
      name: "counts a nested function's lines for that function only",
      code: `function outer() {
        ${statementLines(30)}
        const inner = () => {
          ${statementLines(20)}
        }
      }`
    },
    {
      name: "allows eight decision points and skips ??, ?., and switch cases",
      code: `function decide(a, b, items) {
        if (a) {}
        if (b) {}
        if (a && b) {}
        const choice = a ? b : null
        for (const item of items) {}
        while (a || b) {}
        const fallback = a ?? b?.c
        switch (a) {
          case 1: return one()
          case 2: return two()
          default: return other()
        }
      }`
    },
    {
      name: "allows three nested blocks and keeps else if at the same depth",
      code: `function nest(a, b, c, d) {
        if (a) {
        } else if (b) {
          if (c) {
            while (d) {}
          }
        }
      }`
    },
    {
      name: "allows a condition with two Boolean operators",
      code: "function check(a, b, c) { if ((a && b) || c) {} }"
    },
    {
      name: "allows an inline callback with five lines and no block",
      code: `items.forEach((item) => {
        first(item)
        second(item)
        third(item)
        fourth(item)
        fifth(item)
      })`
    },
    {
      name: "allows the chapter's compliant inline callback",
      code: `const visibleMessages = messages.filter(
        (message) => message.status !== "hidden"
      )`
    },
    {
      name: "does not check a describe callback's own code",
      code: `describe.each(cases)("group", (row) => {
        if (row.flag) {
          setup()
        }
        ${statementLines(45)}
      })`
    },
    {
      name: "holds a test case callback to the function limits only",
      code: `it("works", () => {
        ${statementLines(10)}
        if (flag) {
          step()
        }
      })`
    }
  ],
  invalid: [
    {
      name: "reports 41 executable lines, one over the limit",
      code: functionWithLines(41),
      errors: [expectedCountReport("tooManyLines", 41)]
    },
    {
      name: "counts 41 lines when non-executable lines are not counted",
      code: functionWithNonExecutableLines(39),
      errors: [expectedCountReport("tooManyLines", 41)]
    },
    {
      name: "counts 41 lines when type-only lines and closing tags are not counted",
      code: functionWithTypesAndJsx(35),
      errors: [expectedCountReport("tooManyLines", 41)]
    },
    {
      name: "reports nine decision points",
      code: `function decide(a) {
        ${Array.from({ length: 9 }, () => "if (a) {}").join("\n")}
      }`,
      errors: [expectedCountReport("tooManyDecisionPoints", 9)]
    },
    {
      name: "reports four nested blocks",
      code: `function nest(a, b, items) {
        if (a) {
          for (const item of items) {
            while (b) {
              try { step(item) } catch {}
            }
          }
        }
      }`,
      errors: [expectedCountReport("tooDeeplyNested", 4)]
    },
    {
      name: "reports a condition with three Boolean operators",
      code: "function check(a, b, c, d) { if ((a && b && c) || d) {} }",
      errors: [expectedCountReport("tooManyBooleanOperators", 3)]
    },
    {
      name: "reports an inline callback with six lines",
      code: `items.forEach((item) => {
        first(item)
        second(item)
        third(item)
        fourth(item)
        fifth(item)
        sixth(item)
      })`,
      errors: [expectedCountReport("longInlineCallback", 6)]
    },
    {
      name: "reports the chapter's noncompliant inline callback",
      code: `messages.map((message) => {
        if (message.role === "assistant") {
          if (message.status === "streaming") {
            return normalizeStreamingMessage(message)
          }

          return normalizeCompletedMessage(message)
        }

        return normalizeUserMessage(message)
      })`,
      errors: [expectedReport("inlineCallbackControlFlow")]
    },
    {
      name: "reports a JSX attribute callback with a block",
      code: `const view = <button onClick={() => { if (enabled) { go() } }} />`,
      errors: [expectedReport("inlineCallbackControlFlow")]
    },
    {
      name: "reports a test case callback over the function line limit",
      code: `test("works", () => {\n${statementLines(41)}\n})`,
      errors: [expectedCountReport("tooManyLines", 41)]
    }
  ]
})
