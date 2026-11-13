import type { TSESLint, TSESTree } from "@typescript-eslint/utils"
import { isInExternalAugmentation } from "../declaration-scope.mts"
import {
  citeStandardRule,
  createStandardRule,
  type StandardRuleCreate
} from "../standard-rule.mts"

/** Heading of the rule this plugin rule checks. */
const heading = Object.freeze({
  ruleId: "IFACE-002",
  chapterFile: "INTERFACE.md",
  title: "Interfaces contain operations only"
})

/** Report templates of the plugin rule. */
const messages = Object.freeze({
  nonOperationMember: `The interface declares a {{kind}}, which is not an operation. ${citeStandardRule(heading)}`
})

/** Wording of each interface member kind that is not an operation. */
const nonOperationMemberKinds: ReadonlyMap<string, string> = new Map([
  ["TSCallSignatureDeclaration", "call signature"],
  ["TSConstructSignatureDeclaration", "construct signature"],
  ["TSIndexSignature", "index signature"],
  ["TSPropertySignature", "property"]
])

/**
 * Creates the listener that checks the members of every interface.
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
    for (const member of node.body.body) {
      const kind = nonOperationMemberKinds.get(member.type)
      if (kind !== undefined) {
        const data = Object.freeze({ kind })
        context.report({ node: member, messageId: "nonOperationMember", data })
      }
    }
  }
  return { TSInterfaceDeclaration: check }
}

/**
 * Reports an interface member that is a property, including a function-valued
 * one, or an index, call, or construct signature.
 *
 * @remarks Interfaces that augment an external declaration are not checked.
 * The report covers the member.
 */
export const interfaceMemberRule: TSESLint.RuleModule<
  keyof typeof messages,
  []
> = createStandardRule(
  {
    heading,
    description: "Allow only method and accessor signatures in an interface.",
    messages
  },
  createListeners
)
