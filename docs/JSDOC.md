# JSDoc Standard

This document defines the JSDoc standard for repository-owned JavaScript and TypeScript throughout the repository, including application, package, script, tooling, and configuration code. It applies to new code and to existing code whenever that code is modified.

JSDoc explains contracts that types and names cannot express on their own: purpose, constraints, units, defaults, ownership, lifecycle, side effects, asynchronous completion, cancellation, and errors. It must not narrate implementation details or restate TypeScript syntax.

Code reviewers treat stale or missing required documentation as a code defect. Rust, generated files, vendored sources, and third-party declarations are outside JSDoc scope.

## Required coverage

Document all of the following:

- Exported functions, classes, types, behavioral interfaces, enums, constants, renderer-recognized components, and hooks.
- Named module-level declarations, including internal plugins, factories, services, route registrars, and helpers.
- Classes and their constructors, fields, accessors, methods, and lifecycle or disposal methods.
- Required method and accessor signatures in TypeScript behavioral interfaces and equivalent JavaScript contract declarations.
- Properties in object-shaped types, React props, configuration types, and externally required module augmentations.
- Named local helpers when their contract, side effects, lifecycle, error behavior, or cancellation behavior is not fully apparent from their name and type.
- Allowed overloads and externally required declaration merging or module augmentation isolated at an adapter boundary.

Component documentation MUST identify the primary category selected under `COMP-006` and cover every applicable component contract concern required by `COMP-018`. The [Component standard](./code_standards/COMPONENT.md) owns that semantic contract; this document owns JSDoc syntax, tags, and declaration coverage.

## Exceptions

JSDoc is not required for:

- Imports and unchanged re-exports.
- Anonymous inline callbacks.
- Short-lived local or module-bootstrap values whose name and type fully explain their role.
- Generated or vendored code.
- Individual test cases, fixture values, and self-explanatory test helpers. Document reusable test utilities when they expose a non-obvious contract.

If a declaration is required above, document it even when it is not exported; if it is excepted, prefer a normal inline comment only when an implementation detail still needs explanation.

## Writing style

Use `/** ... */` immediately before the declaration. Write a concise present-tense summary with complete sentence punctuation, use consistent domain terminology, and focus on the declaration's contract rather than implementation details.

State constraints, units, defaults, ownership, lifecycle, side effects, asynchronous completion, cancellation, and errors when they are relevant to users of the declaration. Do not duplicate TypeScript syntax or narrate implementation steps.

## Tag rules

- `@param`: Use for every callable parameter. Explain meaning, constraints, ownership, units, or defaults instead of repeating the type.
- `@returns`: Use for every non-void result. For promises, state what resolves and when. For streams or iterators, describe completion and cancellation behavior.
- `@throws`: Use for intentionally raised errors and meaningful failures deliberately allowed to propagate. Do not claim an exhaustive list of opaque third-party errors.
- `@remarks`: Use for lifecycle, ordering, interoperability, security, or performance details that do not fit the summary.
- `@example`: Use only when correct usage is not apparent from the signature and surrounding API.
- `@deprecated`: Name the supported replacement or migration path.

For an accessor:

- A getter has no `@param` tag and MUST use `@returns` to describe the observed value.
- A setter has one `@param` tag for the assigned value and no `@returns` tag.
- Accessor documentation describes property semantics and invariant effects, not the backing field.

Do not use `@type`, `@private`, or `@async` when TypeScript syntax already expresses the same information.

## Examples

```ts
/** Runtime network locations used by the backend and its LM Studio client. */
export type BackendConfig = {
  /** Interface on which the Fastify server accepts connections. */
  backendHost: string
}
```

```ts
/**
 * Formats conversations as deterministic Markdown.
 *
 * @remarks Primary category: behavioral provider. Owns no mutable state or
 * resources and preserves deterministic, input-preserving formatting.
 * Concurrency model: reentrant.
 */
class MarkdownConversationFormatter implements ConversationFormatter {
  /**
   * Implements {@link ConversationFormatter.formatConversation} as Markdown.
   *
   * @param conversation - The interface-defined immutable conversation.
   * @returns The interface-defined result using Markdown syntax.
   */
  public formatConversation(conversation: Conversation): FormattedConversation {
    return formatConversationAsMarkdown(conversation)
  }
}
```

```ts
/**
 * Registers the health endpoint on a Fastify application.
 *
 * @param app - Application instance that receives the route.
 * @returns A promise that resolves after route registration completes.
 */
export default async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true }))
}
```

In this example, `SettingsPaneTitle` is an illustrative domain type constructed only after non-empty validation.

```tsx
/** Properties accepted by {@link SettingsPane}. */
type SettingsPaneProps = {
  /** Heading displayed above the pane content. */
  readonly title: SettingsPaneTitle
}

/**
 * Presents a titled group of application settings.
 *
 * @remarks Primary category: presentational. The parent owns `title`; the
 * component renders it as the visible heading at the start of the section.
 * @param props - Parent-owned title for the settings group.
 * @returns The rendered settings pane.
 */
function SettingsPane(props: SettingsPaneProps) {
  return (
    <section>
      <h2>{props.title}</h2>
    </section>
  )
}
```

```ts
// Bad: repeats the name and types without adding a contract.
/**
 * Loads a model.
 *
 * @param modelKey - The model key.
 * @returns The model.
 */
```

Examples may use abbreviated bodies and illustrative type names. Source documentation must match the real signature and behavior.

## Contributor and reviewer checklist

- [ ] Every declaration in the coverage matrix has JSDoc.
- [ ] Summaries describe purpose and observable behavior.
- [ ] Every callable parameter and non-void result has the required tag.
- [ ] Getter and setter tags match the accessor-specific rules.
- [ ] Units, defaults, ownership, lifecycle, cancellation, side effects, and meaningful error behavior are stated when relevant.
- [ ] Documentation does not duplicate TypeScript types or narrate implementation steps.
- [ ] Terms are consistent across related declarations.
- [ ] JSDoc was updated whenever behavior or contracts changed.
