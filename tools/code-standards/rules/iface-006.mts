import type { TSESLint, TSESTree } from "@typescript-eslint/utils"
import { isInExternalAugmentation } from "../declaration-scope.mts"
import { repeatedSignatures } from "../interface-members.mts"
import {
  citeStandardRule,
  createStandardRule,
  type StandardRuleCreate
} from "../standard-rule.mts"

/** Most operations an interface may expose. */
const operationLimit = 5

/** Heading of the rule this plugin rule checks. */
const heading = Object.freeze({
  ruleId: "IFACE-006",
  chapterFile: "INTERFACE.md",
  title: "An interface exposes one to five operations"
})

/** Citation ending every report. */
const citation = citeStandardRule(heading)

/** Report templates of the plugin rule. */
const messages = Object.freeze({
  tooManyOperations: `The interface declares {{count}} operations of its own. ${citation}`,
  noOperations: `The interface declares and inherits no operation. ${citation}`
})

/**
 * Creates the listener that counts the operations of every interface.
 *
 * @param context - Rule context of the linted file.
 * @returns A listener for interface declarations.
 */
const createListeners: StandardRuleCreate<keyof typeof messages> = (
  context
) => {
  const check = (node: TSESTree.TSInterfaceDeclaration): void => {
    if (isInExternalAugmentation(context.sourceCode.getAncestors(node))) {
      return
    }
    const methods = node.body.body.filter(
      (member) => member.type === "TSMethodSignature"
    )
    const overloads = repeatedSignatures(methods, context.sourceCode)
    const count = methods.length - overloads.length
    if (count > operationLimit) {
      const data = Object.freeze({ count })
      context.report({ node, messageId: "tooManyOperations", data })
    } else if (count === 0 && node.extends.length === 0) {
      context.report({ node, messageId: "noOperations" })
    }
  }
  return { TSInterfaceDeclaration: check }
}

/**
 * Reports an interface that declares more than five operations of its own,
 * or that declares no operation and extends nothing.
 *
 * @remarks A method counts once however many overload signatures it
 * declares, and each getter and setter counts once. Inherited operations, and
 * overloads an external parent contract imposes, need type information and
 * are not counted, so an interface that extends another is reported only when
 * its own operations exceed the limit. Interfaces that augment an external
 * declaration are not checked. The report covers the interface.
 */
export const interfaceOperationCountRule: TSESLint.RuleModule<
  keyof typeof messages,
  []
> = createStandardRule(
  {
    heading,
    description: "Limit an interface to one to five operations.",
    messages
  },
  createListeners
)
