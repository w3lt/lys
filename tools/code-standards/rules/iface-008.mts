import type { TSESLint, TSESTree } from "@typescript-eslint/utils"
import { isInExternalAugmentation } from "../declaration-scope.mts"
import {
  citeStandardRule,
  createStandardRule,
  type StandardRuleCreate
} from "../standard-rule.mts"

/** Heading of the rule this plugin rule checks. */
const heading = Object.freeze({
  ruleId: "IFACE-008",
  chapterFile: "INTERFACE.md",
  title: "Optional and unsupported operations are prohibited"
})

/** Report templates of the plugin rule. */
const messages = Object.freeze({
  optionalOperation: `The interface declares an optional operation. ${citeStandardRule(heading)}`
})

/**
 * Creates the listener that checks every interface method signature.
 *
 * @param context - Rule context of the linted file.
 * @returns A listener for method signatures.
 */
const createListeners: StandardRuleCreate<keyof typeof messages> = (
  context
) => {
  const check = (node: TSESTree.TSMethodSignature): void => {
    const ancestors = context.sourceCode.getAncestors(node)
    const isInterfaceMember = node.parent.type === "TSInterfaceBody"
    if (
      isInterfaceMember &&
      node.optional &&
      !isInExternalAugmentation(ancestors)
    ) {
      context.report({ node, messageId: "optionalOperation" })
    }
  }
  return { TSMethodSignature: check }
}

/**
 * Reports an optional method signature in an interface.
 *
 * @remarks How providers represent unsupported behavior needs judgment and is
 * not checked. Interfaces that augment an external declaration are not
 * checked. The report covers the method signature.
 */
export const optionalOperationRule: TSESLint.RuleModule<
  keyof typeof messages,
  []
> = createStandardRule(
  {
    heading,
    description: "Disallow optional operations in an interface.",
    messages
  },
  createListeners
)
