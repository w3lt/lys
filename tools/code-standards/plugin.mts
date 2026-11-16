import { complexityLimitRule } from "./rules/func-013.mts"
import { guardClauseRule } from "./rules/func-014.mts"
import { positionalParameterRule } from "./rules/func-004.mts"
import { interfaceMemberRule } from "./rules/iface-002.mts"
import { interfaceOperationCountRule } from "./rules/iface-006.mts"
import { optionalOperationRule } from "./rules/iface-008.mts"
import { interfaceOperationRule } from "./rules/iface-010.mts"
import { inlineObjectTypeRule } from "./rules/type-026.mts"

/** Namespace of the plugin's rules in an ESLint configuration. */
export const codeStandardsPluginName = "lys"

/** Plugin rules by name; each name is the lowercase identifier it checks. */
const rules = Object.freeze({
  "func-004": positionalParameterRule,
  "func-013": complexityLimitRule,
  "func-014": guardClauseRule,
  "iface-002": interfaceMemberRule,
  "iface-006": interfaceOperationCountRule,
  "iface-008": optionalOperationRule,
  "iface-010": interfaceOperationRule,
  "type-026": inlineObjectTypeRule
})

/** Identification ESLint shows for the plugin. */
const meta = Object.freeze({ name: "eslint-plugin-lys-code-standards" })

/**
 * ESLint plugin that checks the code-standard rules a tool can decide
 * exactly in TypeScript and JavaScript.
 *
 * @remarks The handbook's rule check inventory lists which part of each rule
 * every plugin rule checks.
 */
export const codeStandardsPlugin = Object.freeze({ meta, rules })

/**
 * Severity of every plugin rule in the repository configuration.
 *
 * @remarks Warnings show every report while code is written without failing
 * a whole-file lint of code that predates a rule. The changed-code check
 * fails on reports that overlap changed lines.
 */
export const codeStandardsRuleLevels = Object.freeze(
  Object.fromEntries(
    Object.keys(rules).map((name) => [
      `${codeStandardsPluginName}/${name}`,
      "warn"
    ])
  )
)
