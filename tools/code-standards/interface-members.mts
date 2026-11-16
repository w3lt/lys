import type { TSESLint, TSESTree } from "@typescript-eslint/utils"

/**
 * Reads the name under which an interface method signature can be overloaded.
 *
 * @param node - Method signature.
 * @param sourceCode - Source code of the linted file.
 * @returns The method's name, a computed key's source text in brackets, or
 * `null` for a getter or setter, which is never an overload.
 */
export function overloadableName(
  node: TSESTree.TSMethodSignature,
  sourceCode: Readonly<TSESLint.SourceCode>
): string | null {
  if (node.kind !== "method") {
    return null
  }
  if (node.computed) {
    return `[${sourceCode.getText(node.key)}]`
  }
  return node.key.type === "Identifier" ? node.key.name : String(node.key.value)
}

/**
 * Lists the method signatures that repeat an earlier method's name.
 *
 * @param methods - Method signatures of one interface, in source order.
 * @param sourceCode - Source code of the linted file.
 * @returns Every signature after the first of each overloaded method.
 */
export function repeatedSignatures(
  methods: readonly TSESTree.TSMethodSignature[],
  sourceCode: Readonly<TSESLint.SourceCode>
): TSESTree.TSMethodSignature[] {
  const names = methods.map((method) => overloadableName(method, sourceCode))
  return methods.filter((_, index) => {
    const name = names[index] ?? null
    return name !== null && names.slice(0, index).includes(name)
  })
}
