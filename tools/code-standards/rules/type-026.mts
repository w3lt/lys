import type { TSESLint, TSESTree } from "@typescript-eslint/utils"
import { isInExternalAugmentation } from "../declaration-scope.mts"
import {
  citeStandardRule,
  createStandardRule,
  type StandardRuleCreate
} from "../standard-rule.mts"

/** Most fields an inline object type may contain. */
const fieldLimit = 2

/** Heading of the rule this plugin rule checks. */
const heading = Object.freeze({
  ruleId: "TYPE-026",
  chapterFile: "TYPE.md",
  title: "Inline object types are limited"
})

/** Report templates of the plugin rule. */
const messages = Object.freeze({
  tooManyFields: `The inline object type contains {{count}} fields. ${citeStandardRule(heading)}`
})

/** Declarations that give the object types inside them a name. */
const namedDeclarationTypes: ReadonlySet<string> = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration"
])

/**
 * Creates the listener that checks every object type literal.
 *
 * @param context - Rule context of the linted file.
 * @returns A listener for object type literals.
 */
const createListeners: StandardRuleCreate<keyof typeof messages> = (
  context
) => {
  const check = (node: TSESTree.TSTypeLiteral): void => {
    const ancestors = context.sourceCode.getAncestors(node)
    const isNamed = ancestors.some((ancestor) =>
      namedDeclarationTypes.has(ancestor.type)
    )
    if (isNamed || isInExternalAugmentation(ancestors)) {
      return
    }
    const count = node.members.filter(
      (member) => member.type === "TSPropertySignature"
    ).length
    if (count > fieldLimit) {
      const data = Object.freeze({ count })
      context.report({ node, messageId: "tooManyFields", data })
    }
  }
  return { TSTypeLiteral: check }
}

/**
 * Reports an inline object type with more than two property signatures.
 *
 * @remarks An object type anywhere inside a type alias or interface is part
 * of a named type and is not checked; neither is one that augments an
 * external declaration. Method signatures are not counted as fields. The
 * other conditions on inline object types need judgment and are not checked.
 * The report covers the object type.
 */
export const inlineObjectTypeRule: TSESLint.RuleModule<
  keyof typeof messages,
  []
> = createStandardRule(
  {
    heading,
    description: "Limit the fields of an inline object type.",
    messages
  },
  createListeners
)
