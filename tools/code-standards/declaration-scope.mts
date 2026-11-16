import type { TSESTree } from "@typescript-eslint/utils"

/**
 * Tells whether a node lies inside an augmentation of an external declaration.
 *
 * @remarks Declarations inside `declare module`, `declare global`, or another
 * ambient namespace add to declarations that a dependency or the runtime
 * owns, so their shape follows that external contract.
 * @param ancestors - The node's ancestors, as ESLint lists them.
 * @returns Whether an enclosing module declaration is ambient or global.
 */
export function isInExternalAugmentation(
  ancestors: readonly TSESTree.Node[]
): boolean {
  return ancestors.some(
    (ancestor) =>
      ancestor.type === "TSModuleDeclaration" &&
      (ancestor.declare || ancestor.kind === "global")
  )
}
