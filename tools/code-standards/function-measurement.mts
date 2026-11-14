import type { TSESLint, TSESTree } from "@typescript-eslint/utils"

/** Function implementation whose own body a measurement covers. */
export type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression

/** Condition of a branch or loop with the Boolean operators it contains. */
export type ConditionMeasurement = {
  /** Test expression of the branch or loop. */
  readonly condition: TSESTree.Expression

  /** Number of `&&` and `||` operators in the test, outside nested functions. */
  readonly booleanOperators: number
}

/**
 * Size and complexity of the code a function owns.
 *
 * @remarks A function owns its body except the nested functions in it, which
 * are measured on their own. Every count takes the narrowest reading that any
 * reader of the counting rules could hold, so a count above a limit exceeds it
 * under every reading.
 */
export type FunctionMeasurement = {
  /**
   * Lines of the body on which a token other than a delimiter starts.
   * Delimiters are brackets, braces, parentheses, commas, semicolons, JSX
   * closing tags and fragments, and the `>` or `/>` ending a JSX opening tag.
   * Tokens of type annotations, type declarations, and type assertions'
   * types do not count.
   */
  readonly executableLines: number

  /**
   * `if` statements, conditional expressions, loops, catch clauses, and `&&`
   * or `||` operators. `switch` cases, `??`, optional chaining, logical
   * assignment, and default values do not count.
   */
  readonly decisionPoints: number

  /**
   * Deepest chain of enclosing `if`, loop, `switch`, and `try` statements. An
   * `else if` continues its chain at the same depth.
   */
  readonly nesting: number

  /** Every branch or loop condition in the function's own code. */
  readonly conditions: readonly ConditionMeasurement[]
}

/** One node in a function's own code, with its control-flow nesting depth. */
type OwnNode = {
  /** The node. */
  readonly node: TSESTree.Node

  /** Control-flow statements enclosing the node, the node itself included. */
  readonly nesting: number
}

/** Node types whose code belongs to a function of its own. */
const functionNodeTypes: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression"
])

/** Node types whose tokens are types or delimiters, never executable code. */
const nonExecutableNodeTypes: ReadonlySet<string> = new Set([
  "JSXClosingElement",
  "JSXClosingFragment",
  "JSXOpeningFragment",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSTypeAnnotation",
  "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation"
])

/** Expression types whose `typeAnnotation` child is a type, not a value. */
const typeAssertionNodeTypes: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion"
])

/** Punctuator values that only delimit code. */
const delimiterValues: ReadonlySet<string> = new Set([
  "(",
  ")",
  ",",
  ";",
  "[",
  "]",
  "{",
  "}"
])

/** Node types that are decision points whatever their operands. */
const decisionNodeTypes: ReadonlySet<string> = new Set([
  "CatchClause",
  "ConditionalExpression",
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "IfStatement",
  "WhileStatement"
])

/** Statement types that open a nested control-flow block. */
const nestingNodeTypes: ReadonlySet<string> = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "IfStatement",
  "SwitchStatement",
  "TryStatement",
  "WhileStatement"
])

/**
 * Tells whether a value read through the parser's visitor keys is a node.
 *
 * @remarks Visitor keys name only node-valued properties, so an object with a
 * `type` property there is a node; `null` marks an absent optional child.
 * @param value - Property value read through a visitor key.
 * @returns Whether the value is a node.
 */
function isNode(value: unknown): value is TSESTree.Node {
  return typeof value === "object" && value !== null && "type" in value
}

/**
 * Lists the child nodes of a node in source order.
 *
 * @param node - Parent node.
 * @param visitorKeys - The parser's child property names for each node type.
 * @returns Every child node, skipping absent optional children.
 */
function childNodesOf(
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode.VisitorKeys
): TSESTree.Node[] {
  const keys = visitorKeys[node.type] ?? []
  return keys.flatMap((key) => [Reflect.get(node, key)].flat().filter(isNode))
}

/**
 * Tells whether a node is a function, whose code another measurement owns.
 *
 * @param node - Node to classify.
 * @returns Whether the node is a function declaration or expression.
 */
function isFunctionLike(node: TSESTree.Node): boolean {
  return functionNodeTypes.has(node.type)
}

/**
 * Tells whether all tokens of a node are types or delimiters.
 *
 * @param node - Node to classify.
 * @returns Whether the node is a type, a type declaration, a type assertion's
 * type, or a JSX closing tag or fragment.
 */
function isNonExecutable(node: TSESTree.Node): boolean {
  if (nonExecutableNodeTypes.has(node.type)) {
    return true
  }
  const parent = node.parent
  return (
    parent !== undefined &&
    typeAssertionNodeTypes.has(parent.type) &&
    Reflect.get(parent, "typeAnnotation") === node
  )
}

/**
 * Tells whether a statement opens a nested control-flow block.
 *
 * @param node - Node to classify.
 * @returns Whether the node is a control-flow statement other than an
 * `else if`, which continues its chain at the same depth.
 */
function opensNesting(node: TSESTree.Node): boolean {
  const parent = node.parent
  const isElseIf =
    node.type === "IfStatement" &&
    parent?.type === "IfStatement" &&
    parent.alternate === node
  return nestingNodeTypes.has(node.type) && !isElseIf
}

/**
 * Walks the code a function owns below a node.
 *
 * @remarks Nested functions and non-executable nodes are yielded, so that
 * their tokens can be excluded, but not entered.
 * @param parent - Node whose descendants are walked.
 * @param nesting - Nesting depth of the parent.
 * @param visitorKeys - The parser's child property names for each node type.
 * @returns Every descendant in the function's own code, in source order.
 */
function* walkOwnNodes(
  parent: TSESTree.Node,
  nesting: number,
  visitorKeys: TSESLint.SourceCode.VisitorKeys
): Generator<OwnNode> {
  for (const node of childNodesOf(parent, visitorKeys)) {
    const own = { node, nesting: nesting + (opensNesting(node) ? 1 : 0) }
    yield own
    if (!isFunctionLike(node) && !isNonExecutable(node)) {
      yield* walkOwnNodes(node, own.nesting, visitorKeys)
    }
  }
}

/**
 * Lists a node and the code it owns.
 *
 * @param root - Function body, or an expression inside one.
 * @param sourceCode - Source code of the linted file.
 * @returns The root at depth zero, followed by its own descendants.
 */
function ownNodesOf(
  root: TSESTree.Node,
  sourceCode: Readonly<TSESLint.SourceCode>
): OwnNode[] {
  const rootNode = { node: root, nesting: 0 }
  return [rootNode, ...walkOwnNodes(root, 0, sourceCode.visitorKeys)]
}

/**
 * Lists the tokens of a node that are never executable.
 *
 * @param node - Node in a function's own code.
 * @param sourceCode - Source code of the linted file.
 * @returns All tokens of a nested function or non-executable node, the
 * closing `>` or `/>` of a JSX opening tag, or no token.
 */
function nonExecutableTokensOf(
  node: TSESTree.Node,
  sourceCode: Readonly<TSESLint.SourceCode>
): TSESTree.Token[] {
  if (isFunctionLike(node) || isNonExecutable(node)) {
    return sourceCode.getTokens(node)
  }
  if (node.type !== "JSXOpeningElement") {
    return []
  }
  return sourceCode.getLastTokens(node, { count: node.selfClosing ? 2 : 1 })
}

/**
 * Tells whether a token can make its line executable.
 *
 * @param token - Token in a function body.
 * @returns Whether the token is neither a delimiter nor whitespace-only JSX
 * text.
 */
function isExecutableToken(token: TSESTree.Token): boolean {
  if (token.type === "Punctuator") {
    return !delimiterValues.has(token.value)
  }
  return token.type !== "JSXText" || token.value.trim() !== ""
}

/**
 * Counts the lines of a function body on which an executable token starts.
 *
 * @param body - Function body.
 * @param ownNodes - The body's own nodes.
 * @param sourceCode - Source code of the linted file.
 * @returns Number of executable lines.
 */
function countExecutableLines(
  body: TSESTree.Node,
  ownNodes: readonly OwnNode[],
  sourceCode: Readonly<TSESLint.SourceCode>
): number {
  const excludedStarts = new Set(
    ownNodes
      .flatMap((own) => nonExecutableTokensOf(own.node, sourceCode))
      .map((token) => token.range[0])
  )
  const executableTokens = sourceCode
    .getTokens(body)
    .filter((token) => !excludedStarts.has(token.range[0]))
    .filter(isExecutableToken)
  return new Set(executableTokens.map((token) => token.loc.start.line)).size
}

/**
 * Tells whether a node is a Boolean short-circuit operator.
 *
 * @param node - Node to classify.
 * @returns Whether the node is an `&&` or `||` expression.
 */
function isBooleanOperator(node: TSESTree.Node): boolean {
  return (
    node.type === "LogicalExpression" &&
    (node.operator === "&&" || node.operator === "||")
  )
}

/**
 * Tells whether a node is a decision point.
 *
 * @param node - Node in a function's own code.
 * @returns Whether the node branches or loops.
 */
function isDecisionPoint(node: TSESTree.Node): boolean {
  return decisionNodeTypes.has(node.type) || isBooleanOperator(node)
}

/**
 * Reads the condition of a branch or loop.
 *
 * @param node - Node in a function's own code.
 * @returns The test of an `if`, loop, or conditional expression, or `null`.
 */
function conditionOf(node: TSESTree.Node): TSESTree.Expression | null {
  switch (node.type) {
    case "ConditionalExpression":
    case "DoWhileStatement":
    case "ForStatement":
    case "IfStatement":
    case "WhileStatement":
      return node.test
    default:
      return null
  }
}

/**
 * Measures the Boolean operators in a condition.
 *
 * @param condition - Test of a branch or loop.
 * @param sourceCode - Source code of the linted file.
 * @returns The condition with its operator count.
 */
function measureCondition(
  condition: TSESTree.Expression,
  sourceCode: Readonly<TSESLint.SourceCode>
): ConditionMeasurement {
  const operators = ownNodesOf(condition, sourceCode).filter((own) =>
    isBooleanOperator(own.node)
  )
  return Object.freeze({ condition, booleanOperators: operators.length })
}

/**
 * Measures the code a function owns.
 *
 * @param node - Function implementation.
 * @param sourceCode - Source code of the linted file.
 * @returns The function's executable lines, decision points, deepest nesting,
 * and conditions.
 */
export function measureFunction(
  node: FunctionNode,
  sourceCode: Readonly<TSESLint.SourceCode>
): FunctionMeasurement {
  const ownNodes = ownNodesOf(node.body, sourceCode)
  const conditions = ownNodes
    .map((own) => conditionOf(own.node))
    .filter((condition) => condition !== null)
    .map((condition) => measureCondition(condition, sourceCode))
  return Object.freeze({
    executableLines: countExecutableLines(node.body, ownNodes, sourceCode),
    decisionPoints: ownNodes.filter((own) => isDecisionPoint(own.node)).length,
    nesting: ownNodes.reduce(
      (deepest, own) => Math.max(deepest, own.nesting),
      0
    ),
    conditions: Object.freeze(conditions)
  })
}
