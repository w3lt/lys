import type { TSESLint, TSESTree } from "@typescript-eslint/utils"
import {
  citeStandardRule,
  createStandardRule,
  type StandardRuleCreate
} from "../standard-rule.mts"

/** Heading of the rule this plugin rule checks. */
const heading = Object.freeze({
  ruleId: "FUNC-014",
  chapterFile: "FUNCTION.md",
  title: "Guard clauses before the primary path"
})

/** Report templates of the plugin rule. */
const messages = Object.freeze({
  elseAfterExit: `An else block follows a branch that always exits. ${citeStandardRule(heading)}`
})

/** Statement types that always leave the enclosing branch. */
const exitStatementTypes: ReadonlySet<string> = new Set([
  "BreakStatement",
  "ContinueStatement",
  "ReturnStatement",
  "ThrowStatement"
])

/**
 * Tells whether every path through a statement returns, throws, continues,
 * or breaks.
 *
 * @remarks Only exits visible in the syntax count: a block with an exiting
 * statement, or an `if` whose two branches both exit. A `switch`, `try`, or
 * call that never returns is treated as not exiting.
 * @param statement - Branch to inspect.
 * @returns Whether the statement always exits.
 */
function alwaysExits(statement: TSESTree.Statement): boolean {
  if (exitStatementTypes.has(statement.type)) {
    return true
  }
  if (statement.type === "BlockStatement") {
    return statement.body.some(alwaysExits)
  }
  return (
    statement.type === "IfStatement" &&
    statement.alternate !== null &&
    alwaysExits(statement.consequent) &&
    alwaysExits(statement.alternate)
  )
}

/**
 * Creates the listener that checks every `if` statement with an `else` block.
 *
 * @param context - Rule context of the linted file.
 * @returns A listener for `if` statements.
 */
const createListeners: StandardRuleCreate<keyof typeof messages> = (
  context
) => {
  const check = (node: TSESTree.IfStatement): void => {
    const alternate = node.alternate
    const isElseBlock = alternate !== null && alternate.type !== "IfStatement"
    if (isElseBlock && alwaysExits(node.consequent)) {
      context.report({ node, messageId: "elseAfterExit" })
    }
  }
  return { IfStatement: check }
}

/**
 * Reports an `if` statement whose `else` block follows a branch that always
 * exits.
 *
 * @remarks An `else if` is not an `else` block and is not reported; its own
 * `if` statement is checked instead. The report covers the `if` statement.
 */
export const guardClauseRule: TSESLint.RuleModule<keyof typeof messages, []> =
  createStandardRule(
    {
      heading,
      description: "Disallow an else block after a branch that always exits.",
      messages
    },
    createListeners
  )
