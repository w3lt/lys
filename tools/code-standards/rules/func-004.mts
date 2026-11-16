import type { TSESLint } from "@typescript-eslint/utils"
import type { FunctionNode } from "../function-measurement.mts"
import {
  citeStandardRule,
  createStandardRule,
  type StandardRuleCreate
} from "../standard-rule.mts"

/** Most positional parameters a function may declare. */
const positionalParameterLimit = 3

/** Heading of the rule this plugin rule checks. */
const heading = Object.freeze({
  ruleId: "FUNC-004",
  chapterFile: "FUNCTION.md",
  title: "Maximum positional parameters"
})

/** Report templates of the plugin rule. */
const messages = Object.freeze({
  tooManyParameters: `The function declares {{count}} positional parameters. ${citeStandardRule(heading)}`
})

/**
 * Counts the positional parameters of a function.
 *
 * @param node - Function implementation.
 * @returns Number of parameters, not counting a leading `this` declaration.
 */
function countPositionalParameters(node: FunctionNode): number {
  const [first] = node.params
  const hasReceiver = first?.type === "Identifier" && first.name === "this"
  return node.params.length - (hasReceiver ? 1 : 0)
}

/**
 * Creates the listeners that check every function implementation.
 *
 * @param context - Rule context of the linted file.
 * @returns Listeners for function declarations and expressions.
 */
const createListeners: StandardRuleCreate<keyof typeof messages> = (
  context
) => {
  const check = (node: FunctionNode): void => {
    const count = countPositionalParameters(node)
    if (count > positionalParameterLimit) {
      const data = Object.freeze({ count })
      context.report({ node, messageId: "tooManyParameters", data })
    }
  }
  return {
    ArrowFunctionExpression: check,
    FunctionDeclaration: check,
    FunctionExpression: check
  }
}

/**
 * Reports a function implementation with more than three positional
 * parameters.
 *
 * @remarks The report covers the whole function. A signature that a
 * framework or third-party contract imposes is exempt; the rule cannot see
 * who imposed a signature, so that exemption is declared with a disable
 * directive naming the imposing contract.
 */
export const positionalParameterRule: TSESLint.RuleModule<
  keyof typeof messages,
  []
> = createStandardRule(
  {
    heading,
    description: "Limit the positional parameters of a function.",
    messages
  },
  createListeners
)
