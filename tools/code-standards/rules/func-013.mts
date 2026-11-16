import type { TSESLint, TSESTree } from "@typescript-eslint/utils"
import {
  measureFunction,
  type FunctionMeasurement,
  type FunctionNode
} from "../function-measurement.mts"
import {
  citeStandardRule,
  createStandardRule,
  type StandardRuleCreate
} from "../standard-rule.mts"

/** Most executable lines a function may own. */
const functionLineLimit = 40

/** Most decision points a function may own. */
const decisionPointLimit = 8

/** Deepest nesting of control-flow blocks a function may own. */
const nestingLimit = 3

/** Most Boolean operators one condition may contain. */
const conditionOperatorLimit = 2

/** Most executable lines an inline callback may own. */
const inlineCallbackLineLimit = 5

/** Heading of the rule that sets the limits. */
const heading = Object.freeze({
  ruleId: "FUNC-013",
  chapterFile: "FUNCTION.md",
  title: "Complexity limits"
})

/** Heading of the rule that repeats the inline-callback conditions. */
const callbackHeading = Object.freeze({
  ruleId: "FUNC-019",
  chapterFile: "FUNCTION.md",
  title: "Inline callbacks must remain local"
})

/** Citation ending every report of a function limit. */
const limitCitation = citeStandardRule(heading)

/** Citation ending every report of an inline-callback limit. */
const callbackCitation = `${limitCitation}; ${citeStandardRule(callbackHeading)}`

/** Report templates of the plugin rule. */
const messages = Object.freeze({
  tooManyLines: `The function has {{count}} executable lines of its own. ${limitCitation}`,
  tooManyDecisionPoints: `The function has {{count}} decision points of its own. ${limitCitation}`,
  tooDeeplyNested: `The function nests control-flow blocks {{count}} deep. ${limitCitation}`,
  tooManyBooleanOperators: `The condition contains {{count}} Boolean operators. ${limitCitation}`,
  longInlineCallback: `The inline callback has {{count}} executable lines of its own. ${callbackCitation}`,
  inlineCallbackControlFlow: `The inline callback contains a control-flow block. ${callbackCitation}`
})

/** Identifier of one report template. */
type MessageId = keyof typeof messages

/** Rule context of the linted file. */
type Context = Readonly<TSESLint.RuleContext<MessageId, []>>

/** One measured value that exceeds its limit. */
type LimitFinding = {
  /** Report template naming the measured value. */
  readonly messageId: MessageId

  /** The measured value. */
  readonly count: number
}

/**
 * Role of a function passed to a test runner's registration call: `group`
 * for a `describe` callback, `case` for a test case or hook, otherwise `none`.
 */
type TestRegistrationRole = "case" | "group" | "none"

/** Registration calls whose callback groups test cases. */
const groupRegistrationNames: ReadonlySet<string> = new Set(["describe"])

/** Registration calls whose callback is a test case or hook. */
const caseRegistrationNames: ReadonlySet<string> = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "it",
  "test"
])

/**
 * Finds the identifier a callee chain starts from, such as `describe` in
 * `describe.each(table)`.
 *
 * @param node - Callee, or a part of one.
 * @returns The identifier name, or `null` when the chain starts elsewhere.
 */
function rootIdentifierName(node: TSESTree.Node): string | null {
  switch (node.type) {
    case "CallExpression":
      return rootIdentifierName(node.callee)
    case "MemberExpression":
      return rootIdentifierName(node.object)
    case "TaggedTemplateExpression":
      return rootIdentifierName(node.tag)
    case "Identifier":
      return node.name
    default:
      return null
  }
}

/**
 * Tells whether a function is passed directly as an argument.
 *
 * @param node - Function implementation.
 * @param parent - The function's parent node.
 * @returns Whether the parent is a call or `new` expression taking the
 * function as an argument.
 */
function isArgumentOf(node: FunctionNode, parent: TSESTree.Node): boolean {
  if (parent.type !== "CallExpression" && parent.type !== "NewExpression") {
    return false
  }
  const callArguments: readonly TSESTree.Node[] = parent.arguments
  return callArguments.includes(node)
}

/**
 * Classifies a function passed to a test runner's registration call.
 *
 * @param node - Function implementation.
 * @returns The role the function's registration call gives it.
 */
function testRegistrationRole(node: FunctionNode): TestRegistrationRole {
  const parent = node.parent
  if (parent.type !== "CallExpression" || !isArgumentOf(node, parent)) {
    return "none"
  }
  const name = rootIdentifierName(parent.callee) ?? ""
  if (groupRegistrationNames.has(name)) {
    return "group"
  }
  return caseRegistrationNames.has(name) ? "case" : "none"
}

/**
 * Tells whether a function is an inline callback.
 *
 * @param node - Function implementation.
 * @returns Whether the function is a call argument or a JSX attribute value.
 */
function isInlineCallback(node: FunctionNode): boolean {
  const parent = node.parent
  if (isArgumentOf(node, parent)) {
    return true
  }
  return (
    parent.type === "JSXExpressionContainer" &&
    parent.parent.type === "JSXAttribute"
  )
}

/**
 * Reports one measured value that exceeds its limit.
 *
 * @param context - Rule context of the linted file.
 * @param node - Construct the value was measured on.
 * @param finding - Report template and measured value.
 */
function reportFinding(
  context: Context,
  node: TSESTree.Node,
  finding: LimitFinding
): void {
  const data = Object.freeze({ count: finding.count })
  context.report({ node, messageId: finding.messageId, data })
}

/**
 * Reports every function limit a measurement exceeds.
 *
 * @param context - Rule context of the linted file.
 * @param node - Measured function.
 * @param measurement - The function's own size and complexity.
 */
function reportFunctionLimits(
  context: Context,
  node: FunctionNode,
  measurement: FunctionMeasurement
): void {
  const { executableLines, decisionPoints, nesting } = measurement
  if (executableLines > functionLineLimit) {
    reportFinding(context, node, {
      messageId: "tooManyLines",
      count: executableLines
    })
  }
  if (decisionPoints > decisionPointLimit) {
    reportFinding(context, node, {
      messageId: "tooManyDecisionPoints",
      count: decisionPoints
    })
  }
  if (nesting > nestingLimit) {
    reportFinding(context, node, {
      messageId: "tooDeeplyNested",
      count: nesting
    })
  }
  for (const { condition, booleanOperators } of measurement.conditions) {
    if (booleanOperators > conditionOperatorLimit) {
      reportFinding(context, condition, {
        messageId: "tooManyBooleanOperators",
        count: booleanOperators
      })
    }
  }
}

/**
 * Reports every inline-callback limit a measurement exceeds.
 *
 * @param context - Rule context of the linted file.
 * @param node - Measured inline callback.
 * @param measurement - The callback's own size and complexity.
 */
function reportInlineCallbackLimits(
  context: Context,
  node: FunctionNode,
  measurement: FunctionMeasurement
): void {
  const { executableLines, nesting } = measurement
  if (executableLines > inlineCallbackLineLimit) {
    reportFinding(context, node, {
      messageId: "longInlineCallback",
      count: executableLines
    })
  }
  if (nesting > 0) {
    reportFinding(context, node, {
      messageId: "inlineCallbackControlFlow",
      count: nesting
    })
  }
}

/**
 * Checks one function against the limits that apply to it.
 *
 * @remarks Whether a test runner's `describe` callback is held to these
 * limits, and whether a test case or hook callback is an inline callback, is
 * not settled. A `describe` callback is therefore not checked, and a test case
 * or hook callback is checked against the function limits only.
 * @param context - Rule context of the linted file.
 * @param node - Function implementation.
 */
function checkFunction(context: Context, node: FunctionNode): void {
  const role = testRegistrationRole(node)
  if (role === "group") {
    return
  }
  const measurement = measureFunction(node, context.sourceCode)
  reportFunctionLimits(context, node, measurement)
  if (role === "none" && isInlineCallback(node)) {
    reportInlineCallbackLimits(context, node, measurement)
  }
}

/**
 * Creates the listeners that check every function implementation.
 *
 * @param context - Rule context of the linted file.
 * @returns Listeners for function declarations and expressions.
 */
const createListeners: StandardRuleCreate<MessageId> = (context) => {
  const check = (node: FunctionNode): void => checkFunction(context, node)
  return {
    ArrowFunctionExpression: check,
    FunctionDeclaration: check,
    FunctionExpression: check
  }
}

/**
 * Reports a function whose own code exceeds a size or complexity limit, and
 * an inline callback whose own code exceeds the inline-callback limits.
 *
 * @remarks Function-level findings cover the whole function; a condition
 * finding covers the condition. Counts follow `FunctionMeasurement`.
 */
export const complexityLimitRule: TSESLint.RuleModule<MessageId, []> =
  createStandardRule(
    {
      heading,
      description: "Limit the size and complexity of a function's own code.",
      messages
    },
    createListeners
  )
