import type { TSESLint, TSESTree } from "@typescript-eslint/utils"
import { isInExternalAugmentation } from "../declaration-scope.mts"
import { overloadableName, repeatedSignatures } from "../interface-members.mts"
import {
  citeStandardRule,
  createStandardRule,
  type StandardRuleCreate
} from "../standard-rule.mts"

/** Most positional parameters an interface method may declare. */
const positionalParameterLimit = 3

/** Heading of the rule this plugin rule checks. */
const heading = Object.freeze({
  ruleId: "IFACE-010",
  chapterFile: "INTERFACE.md",
  title: "Interface operations follow their construct standards"
})

/** Citation ending every report. */
const citation = citeStandardRule(heading)

/** Report templates of the plugin rule. */
const messages = Object.freeze({
  tooManyParameters: `The interface method declares {{count}} positional parameters. ${citation}`,
  overload: `The interface method {{name}} is overloaded. ${citation}`
})

/** Identifier of one report template. */
type MessageId = keyof typeof messages

/**
 * Counts the positional parameters of a method signature.
 *
 * @param node - Method signature.
 * @returns Number of parameters, not counting a leading `this` declaration.
 */
function countPositionalParameters(node: TSESTree.TSMethodSignature): number {
  const [first] = node.params
  const hasReceiver = first?.type === "Identifier" && first.name === "this"
  return node.params.length - (hasReceiver ? 1 : 0)
}

/**
 * Reports every method signature with too many parameters and every repeated
 * method name in one interface.
 *
 * @param context - Rule context of the linted file.
 * @param node - Interface declaration.
 */
function checkInterface(
  context: Readonly<TSESLint.RuleContext<MessageId, []>>,
  node: TSESTree.TSInterfaceDeclaration
): void {
  const methods = node.body.body.filter(
    (member) => member.type === "TSMethodSignature"
  )
  for (const method of methods) {
    const count = countPositionalParameters(method)
    if (count > positionalParameterLimit) {
      const data = Object.freeze({ count })
      context.report({ node: method, messageId: "tooManyParameters", data })
    }
  }
  const { sourceCode } = context
  for (const method of repeatedSignatures(methods, sourceCode)) {
    const data = Object.freeze({ name: overloadableName(method, sourceCode) })
    context.report({ node: method, messageId: "overload", data })
  }
}

/**
 * Creates the listener that checks the methods of every interface.
 *
 * @param context - Rule context of the linted file.
 * @returns A listener for interface declarations.
 */
const createListeners: StandardRuleCreate<MessageId> = (context) => {
  const check = (node: TSESTree.TSInterfaceDeclaration): void => {
    if (!isInExternalAugmentation(context.sourceCode.getAncestors(node))) {
      checkInterface(context, node)
    }
  }
  return { TSInterfaceDeclaration: check }
}

/**
 * Reports an interface method signature with more than three positional
 * parameters, and every signature after the first of an overloaded method.
 *
 * @remarks The other operation requirements need judgment and are not
 * checked. Interfaces that augment an external declaration are not checked.
 * The report covers the method signature.
 */
export const interfaceOperationRule: TSESLint.RuleModule<MessageId, []> =
  createStandardRule(
    {
      heading,
      description:
        "Limit interface method parameters and disallow interface overloads.",
      messages
    },
    createListeners
  )
