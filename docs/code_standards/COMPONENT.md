# Component

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines the mandatory construction rules for repository-owned user-interface components and semantic component equivalents.

## Definition

A component is a named repository-owned unit that a user-interface renderer recognizes or invokes as a stable view-tree node. It owns one view, interaction, primitive adaptation, composition, or renderer-boundary responsibility.

Classification is semantic rather than syntactic. Screens, views, feature controls, presentational projections, UI primitives, compound subcomponents, context providers, loading and error boundaries, lazy adapters, and renderer-invoked mappings are Component constructs. General modules, packages, services, controllers, hooks, ordinary functions, and render-formatting helpers are not components merely because they contribute to a user interface.

## Construct overlay

A component remains subject to every standard governing its underlying constructs:

| Component form or member                                                 | Additional authoritative standards                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Function, template, or renderer callback component                       | [Function](./FUNCTION.md)                               |
| Class component, custom element, or stateful semantic class equivalent   | [Class](./CLASS.md) and [Function](./FUNCTION.md)       |
| Props, state, events, variants, results, and passive component contracts | [Type](./TYPE.md) and [Object](./OBJECT.md)             |
| Substitutable domain or application capabilities                         | [Interface](./INTERFACE.md)                             |
| Externally imposed object-shaped renderer declarations                   | [Object](./OBJECT.md), especially `OBJECT-061`          |
| Variables and constants used by a component                              | [Variable](./VARIABLE.md) and [Constant](./CONSTANT.md) |
| Repository-owned JavaScript and TypeScript declarations                  | [JSDoc Standard](../JSDOC.md)                           |

Renderer-managed state or lifecycle attached to a function or template component does not by itself make that declaration a repository-owned Class construct. A declaration using a class or semantic class-equivalent behavior owner remains subject to the Class chapter.

## Construction process

Before creating or modifying a component:

1. Confirm that the construct is a renderer-recognized view-tree node.
2. State its single view-tree responsibility.
3. Select its primary category using this chapter's precedence.
4. Identify the current parent, consumer, or framework requirement that justifies it.
5. Define one complete component contract, including every observable state and behavior.
6. Assign every mutable UI value to exactly one authority.
7. Separate parent-owned controls, application-owned ambient state, and component-owned transient state.
8. Design its rendered regions at one composition level and define their view identities.
9. Define every interaction, asynchronous completion, effect, resource, and failure owner.
10. Define semantic output, keyboard behavior, focus behavior, and announcements for every valid state.
11. Isolate external renderer and component contracts behind the required boundary.
12. Define compatibility consequences, verification ownership, validation environments, and complete API documentation before publishing the component.

## Component categories

Every component has exactly one primary category. When several descriptions apply, the first matching category in this precedence order wins:

1. **Framework boundary:** isolates one externally imposed renderer or component contract.
2. **UI primitive adapter:** provides one cohesive family of reusable repository controls over native or approved external primitives.
3. **Composition/view:** connects one application use case, application-owned state, and its peer rendered regions.
4. **Interactive feature:** owns one transient user interaction while receiving domain inputs and actions through props.
5. **Presentational:** projects declared inputs into semantic output without application-global dependencies or owned external effects.

| Category             |  May read application store or application context |     May invoke application capabilities |                                                        May own transient UI state |   May own external renderer integration |
| -------------------- | -------------------------------------------------: | --------------------------------------: | --------------------------------------------------------------------------------: | --------------------------------------: |
| Framework boundary   | Only when the boundary contract itself requires it | Only to translate the isolated boundary |                                                Yes, when required by the boundary |                                     Yes |
| UI primitive adapter |                                                 No |                                      No |                                                       Yes, for primitive behavior |          Yes, for the adapted primitive |
| Composition/view     |                                                Yes |                                     Yes |                                                   Only composition-local UI state | No, except through a boundary component |
| Interactive feature  |                                                 No |             Through domain-facing props |                                                                               Yes |                                      No |
| Presentational       |                                                 No |                                      No | No, except renderer-private presentation state with no parent or domain authority |                                      No |

Context-provider, lazy, server, client, error-boundary, loading-boundary, and compound-component forms describe renderer mechanisms or roles. They do not create additional primary categories.

## Example scope

The normative rules are language-independent. TypeScript and React examples demonstrate the repository's current component environment without limiting the rules to that language or renderer.

Rule-specific examples isolate the rule under discussion. A `Compliant` or `Prohibited` label applies to that rule; omitted surrounding declarations remain subject to every applicable standard. The complete examples at the end demonstrate the combined construction rules.

## Mandatory rules

## Boundary, construction, and categories

### COMP-001 — Components are renderer-recognized view-tree units

A Component construct MUST be a named repository-owned unit that a user-interface renderer recognizes or invokes as a stable view-tree node.

The unit MUST own exactly one view, interaction, primitive adaptation, composition, or renderer-boundary responsibility. Being located in a UI file, returning renderer nodes, or being called while rendering is insufficient by itself.

### COMP-002 — Component rules overlay underlying construct rules

Every component and every declaration inside it MUST satisfy all applicable standards listed in this chapter's construct overlay.

A renderer-invoked function or template component is a view projection in addition to being a Function construct. Callable naming, including any Component-specific naming exception, remains owned exclusively by `FUNC-003`. `COMP-017` defines only the Component-specific semantic requirements for the resulting name. Renderer-managed local state or lifecycle does not by itself make that declaration a repository-owned Class construct.

A class component or semantic class equivalent MUST satisfy the complete Class standard. Component rules MUST NOT be used to weaken a Function, Type, Interface, Class, Object, Variable, Constant, or documentation requirement.

### COMP-003 — Render helpers are not components

A function that formats content, calculates render data, constructs a fragment for one caller, or returns renderer nodes without being invoked by the renderer as a stable view-tree node is a Function construct rather than a Component construct.

Such a helper MUST satisfy the callable naming contract owned by `FUNC-003` and MUST NOT be named or documented as a component. A helper MUST NOT replace a child-component boundary required by `COMP-014` or `COMP-065`.

### COMP-004 — Indirect component forms are explicit

A lazy component, registry entry, component-valued mapping, renderer callback, route element adapter, or other indirectly invoked component MUST be explicitly typed and named as a Component construct.

The indirection MUST preserve:

- Stable component type and view identity.
- The complete component contract.
- The component's primary category.
- Its loading, failure, lifecycle, and verification ownership.

A plain function or arbitrary value MUST NOT be treated as a component merely because a renderer could invoke it.

### COMP-005 — External ownership does not transfer repository responsibility

Generated, vendored, and unchanged third-party component implementations are not repository-owned constructs.

Every repository-authored wrapper, adapter, configuration component, provider, boundary, mapping, or integration around them remains fully in scope. External ownership MUST NOT be used to waive component semantics, accessibility, state, lifecycle, compatibility, or verification requirements.

### COMP-006 — Every component has one primary category

Every component MUST select exactly one primary category using this chapter's precedence and permissions table.

The category MUST describe the component's current responsibility and dependencies. A secondary renderer role such as provider, lazy boundary, error boundary, or compound subcomponent MUST NOT be selected as another category.

A component whose required behavior exceeds its category's permissions MUST move the behavior to the appropriate parent, child, application capability, primitive adapter, or framework boundary.

### COMP-007 — A framework boundary isolates one renderer contract

A framework-boundary component MUST exist because one external renderer, framework, or behavioral component contract requires translation or isolation.

It MAY own externally required props, callbacks, context, refs, portals, lifecycle, or imperative integration. It MUST translate them into repository contracts and MUST NOT accumulate unrelated application policy.

### COMP-008 — A UI primitive adapter owns one cohesive control family

A UI primitive adapter MUST provide one cohesive family of reusable repository controls over native elements or one approved external primitive family.

It MAY own primitive interaction state, host attributes, refs, keyboard behavior, and accessibility correction. It MUST NOT read application stores, invoke application services, or embed feature-specific policy.

### COMP-009 — A composition/view connects one application use case

A composition/view component MUST assemble the peer regions, application-owned state, and domain-facing capabilities required by one application use case.

It MAY select narrow application state and invoke application capabilities. It MUST delegate independent feature interactions and presentational projections rather than implementing their lower-level mechanics.

### COMP-010 — An interactive feature owns one transient interaction

An interactive-feature component MUST own one cohesive transient user interaction, such as editing, selecting, composing, or confirming.

It MUST receive domain inputs and parent-owned actions through props. It MUST NOT read an application store, call a service locator, or depend on application-global context.

### COMP-011 — A presentational component is a pure projection

A presentational component MUST project its declared props and children into semantic view output.

It MUST NOT access application stores, application services, ambient application context, external resources, or domain side effects. Renderer-private presentation state is permitted only when no parent, application, or domain authority exists and losing it on unmount is correct.

### COMP-012 — Renderer roles and environment forms are not categories

Names such as `View`, `Page`, `Panel`, `Provider`, `Boundary`, `Lazy`, `Server`, and `Client` may describe a role or execution mechanism but do not determine a component category.

The component MUST still select its primary category from `COMP-006`. A mechanism label MUST NOT conceal broader permissions, multiple responsibilities, or an external integration.

### COMP-013 — Every component requires current evidence

A component MAY be introduced only when a current renderer entry point, parent composition, consumer, route, framework contract, or approved extension point requires its independent contract.

An unused component, speculative variation, placeholder screen, future extension point, empty scaffold, or component created only for naming symmetry is prohibited.

### COMP-014 — Extraction establishes an independent contract

A rendered region MAY become a component only when it has an independently nameable responsibility and complete component contract.

Extraction is required when the region has its own interaction, state authority, semantic boundary, lifecycle, failure boundary, reusable primitive contract, or independently testable projection.

A component that merely forwards the same props and children or wraps one child without adding a contract is prohibited. Extraction MUST NOT create pass-through components, meaningless fragments, or wrappers used only to reduce line counts.

### COMP-015 — One component owns one view-tree responsibility

A component MUST be describable in one sentence naming the single view, interaction, primitive adaptation, composition, or framework-boundary responsibility it owns.

Every prop, state value, rendered region, event, effect, resource, and dependency MUST be necessary for that sentence.

The component MUST be split when independent parts have different domain purposes, actors, state authorities, lifecycles, failure boundaries, semantic roles, or reasons to change. This is the component-level application of SRP.

### COMP-016 — Component declarations are named, stable, and module-scoped

Every repository-owned component MUST have one explicit name and one authoritative declaration at module scope.

Component types MUST NOT be declared or created:

- Inside another component.
- Inside a render operation.
- Inside a loop, branch, event handler, effect, or callback.
- Per component instance.

An externally imposed anonymous form MAY exist only inside an isolated framework boundary and MUST delegate to a named repository component when it owns repository behavior.

### COMP-017 — Names identify a domain noun or UI role

A component name MUST be a singular domain noun or noun phrase identifying the view or control it renders.

Allowed role suffixes include `View`, `Page`, `Panel`, `Dialog`, `List`, `Item`, `Field`, `Button`, `Provider`, and `Boundary` only when the declaration performs that exact role.

Names such as `Component`, `Wrapper`, `Container`, `Content`, `Thing`, `Widget`, `Generic`, `Base`, `Common`, and `Shared` are prohibited when a precise domain role exists. A component MUST NOT encode its implementation library, renderer mechanism, or styling technique in its public name unless it is an integration boundary for that mechanism.

### COMP-018 — Every named component requires API documentation

Every named repository-owned component MUST have an API documentation comment immediately before its declaration.

JavaScript and TypeScript MUST use JSDoc and follow [`docs/JSDOC.md`](../JSDOC.md). Other languages MUST use their standard API documentation format.

The documentation MUST state the component's responsibility and primary category and describe every applicable:

- Props, children, and slots.
- Events and completion behavior.
- Context or ambient application dependency.
- State authority and reset behavior.
- Rendered result and intentional absence.
- Semantic and accessibility contract.
- Ref or imperative surface.
- Lifecycle, failure, and lazy-boundary behavior.

Wrapping or adapting another component does not create an exception. Documentation MUST NOT repeat type syntax, narrate implementation, or claim behavior the component does not provide.

## Complete component contracts

### COMP-019 — One authoritative contract defines the component

A repository-owned component MUST have one complete authoritative contract associated with its one declaration.

Props types, component documentation, state types, and renderer signatures MAY express different parts of that contract, but they MUST agree and MUST NOT define competing variants, defaults, state authorities, or behaviors.

Declaration merging, partial component contracts, members attached later, runtime mutation, and consumer-specific reinterpretation are prohibited.

### COMP-020 — The contract inventories every observable concern

Before implementation, the component contract MUST identify every applicable:

- Primary responsibility and category.
- Props and their defaults or absence meanings.
- Children and slots.
- Ambient inputs, context, providers, and application state.
- Rendered result and every valid rendered state.
- Events, payloads, timing, count, order, completion, and cancellation.
- Mutable UI values and their authorities.
- Effects, resources, subscriptions, and cleanup.
- Semantic output and accessibility behavior.
- Public ref or imperative operations.
- Expected failures and unexpected-failure boundary.

An omitted concern MUST mean that the component does not own or expose it. Hidden observable behavior is prohibited.

### COMP-021 — Component data contracts use Types

Props, state, variants, events, results, slot data, and other passive component contracts MUST use a Type, record, struct, enum, or equivalent value construct under `TYPE-011`.

A TypeScript `interface` MUST NOT define props or another component data shape. An Interface construct is permitted only for a substitutable behavioral capability under the Interface standard.

### COMP-022 — The rendered-result contract is explicit and narrow

A component MUST declare the narrowest rendered-result type that contains every valid result.

Public or cross-module component declarations MUST use an explicit result type. A nullable or absent result is allowed only when absence is a valid state documented by the component contract.

A component MUST NOT return unrelated result categories, raw mechanism objects, or an untyped value.

### COMP-023 — Observable semantics are distinct from implementation structure

The component contract MUST state observable meaning and behavior without exposing private implementation structure.

Semantic regions, meaningful content order, focus behavior, public host behavior, slot placement, and accessible relationships are observable. Private helper functions, local state representation, renderer lifecycle declarations, semantically neutral wrappers, generated identifiers, and internal child components remain implementation details unless deliberately documented as contract.

### COMP-024 — A component is ready on its first render

A component MUST produce a valid contract state on its first supported render.

It MUST NOT require:

- An undocumented provider or setup call.
- A prior render or effect to establish mandatory state.
- A particular sibling mount order.
- A hard-coded identifier that assumes only one instance.
- A consumer mutation after mounting.

Required context or providers MUST be part of the explicit contract and fail explicitly when absent. Asynchronous data has a complete initial state rather than an invalid placeholder.

### COMP-025 — Every rendered state preserves one component contract

Initial, pending, empty, successful, failed, disabled, busy, and other valid states MUST preserve the same component identity and authoritative contract.

States MAY render different content, but they MUST NOT silently change:

- State authority.
- Parent-owned controls.
- Event meaning.
- Semantic role without a documented state transition.
- Public ref target.
- Required providers.
- Failure ownership.

Distinct contracts require distinct components or one explicit closed component variant.

### COMP-026 — Props expose every direct-parent control

A component MUST expose through props every concern that its direct parent is supposed to supply, select, change, observe, or respond to.

The component MUST NOT hide a parent-owned concern in:

- An application store.
- Global or module state.
- Undeclared context.
- DOM inspection or mutation.
- A public imperative API.

Props MUST NOT expose speculative controls or internal implementation details that the parent does not own.

### COMP-027 — Ambient application state has one authority

Only a composition/view or exact framework boundary MAY read application-owned ambient state.

The application MUST be the authoritative owner of every selected value. An ambient value MUST NOT compete with a prop, local state value, or external widget state for the same concern.

If a direct parent needs to override, select, observe, or respond to that concern, the authority MUST move into the parent's contract or the component MUST be split at the ownership boundary.

### COMP-028 — Public imperative APIs require current evidence

A component MAY expose an imperative ref or handle only when a current consumer requires an operation inherent to the UI element and the operation cannot be represented correctly through props, state, or events.

Allowed operations are narrow UI operations such as focusing, selecting text, scrolling a private viewport, or measuring an owned host when those operations are part of the component contract.

The handle MUST NOT expose internal state, child instances, vendor instances, general setters, domain commands, or lifecycle controls. Private refs used only within the component remain permitted under `COMP-043`.

### COMP-029 — Feature events are semantic; primitive events may be native

An interactive feature, composition/view, or presentational component MUST expose events in domain or parent-action vocabulary rather than raw DOM, renderer, store, transport, or vendor mechanisms.

A UI primitive adapter MAY intentionally expose the exact applicable native event contract when preserving native behavior is its repository contract.

Raw event objects MUST NOT cross a feature boundary merely because the renderer supplies them.

## Props, children, callbacks, context, refs, and forwarding

### COMP-030 — Props use one named immutable contract

A component that accepts props MUST define exactly one named `<ComponentName>Props` type.

Every property and every value reachable from the props contract MUST be immutable and MUST follow the Type and Object ownership rules. The props contract MUST use repository terminology and MUST NOT be assembled from unrelated consumer-specific fragments.

A component that accepts no props MUST have no empty props type or empty props object merely for symmetry.

### COMP-031 — Every prop is necessary and cohesive

Every prop MUST be required by the component's one responsibility and used by its implementation or deliberately forwarded as part of that responsibility.

A prop MUST NOT be added for a hypothetical consumer, styling convenience, testing control, debugging, or future extension. Props with different domain owners, lifecycles, or purposes require a different component boundary.

### COMP-032 — Prop names expose domain meaning and lifecycle

A prop name MUST identify its domain meaning without requiring inspection of the implementation.

Names MUST include units, ownership, lifecycle, or state when the type alone does not express them. Boolean props MUST be positive predicates. Collection props MUST use plural domain nouns or exact collection roles.

Names such as `data`, `value`, `item`, `config`, `options`, `props`, `callback`, `handler`, and `state` are prohibited when a precise domain term exists.

### COMP-033 — Feature props expose semantics, not styling mechanisms

Feature, composition/view, and presentational component props MUST express domain content, state, actions, and semantic variants.

They MUST NOT expose arbitrary CSS class names, style objects, host-attribute bags, internal element selection, layout coordinates, or vendor styling props.

A UI primitive adapter MAY expose `className`, `style`, or a controlled native host-attribute contract only when caller-owned host layout or primitive styling is an explicit repository contract. Such props MUST NOT permit the caller to invalidate semantics, accessibility, state, or behavior.

### COMP-034 — Optionality and defaults are exact

A prop MUST be required unless omission is a valid, documented state.

For every optional prop, the contract MUST define:

- The exact meaning of omission.
- The applied default, if any.
- Which layer owns that default.
- Whether explicit `null` or `undefined` differs from omission.

A default MUST NOT hide missing required state, invalid input, missing context, unavailable capability, or external failure.

### COMP-035 — Boolean props represent independent binary facts

A Boolean prop is allowed only when the domain concern has exactly two valid states, neither state carries different data, and the value does not select between separate component responsibilities or algorithms.

Multiple related Boolean props that can contradict one another are prohibited. Use one closed variant or state type.

`isOpen` and `isDisabled` may represent independent facts. `isLoading`, `hasError`, and `isEmpty` MUST NOT coexist when they describe alternatives of one request state.

### COMP-036 — Callback names use one canonical vocabulary

A callback prop MUST use exactly one of these naming forms:

| Meaning                                        | Required form                                  |
| ---------------------------------------------- | ---------------------------------------------- |
| Proposal to replace parent-controlled property | `on<Property>Change`                           |
| Request for a parent-owned domain action       | `on<Action><Domain>`                           |
| Notification that an owned action completed    | `on<Action><Domain>Complete`                   |
| Exact native primitive event                   | Native `on<Event>` name, only under `COMP-029` |

Names such as `onDone`, `onAction`, `callback`, `handler`, `fn`, and `setValue` are prohibited.

The name MUST identify the action and target. A controlled-change callback proposes a value; it MUST NOT imply that the parent accepted it.

### COMP-037 — Callback availability and completion are exact

A callback MUST be required when the component exposes a parent-owned interaction that would otherwise have no owner.

A callback MAY be optional only when:

1. Omission disables or removes the parent-owned interaction; or
2. The component already owns and completes the interaction, and the callback is an optional notification.

The omitted behavior MUST be documented. An enabled ownerless action, silent no-op, or false completion is prohibited.

The callback contract MUST define payload, invocation count, order, timing, completion point, cancellation, and failure when applicable.

### COMP-038 — Children and slots have exact contracts

Children and named slots MUST define their:

- Cardinality.
- Order.
- Required or optional status.
- Fallback behavior.
- Semantic role.
- Mounting and retention behavior when state changes.

The contract MUST use the narrowest renderer node or component type that accepts every valid child. An unrestricted node type MUST NOT replace a more precise slot contract.

### COMP-039 — Child content remains opaque

A component MUST treat supplied children and slots as opaque content except for operations explicitly declared by their contract.

It MUST NOT inspect a child's concrete component type, private props, DOM shape, or implementation identity. Cloning, reordering, repeating, filtering, or replacing children is prohibited unless the slot contract explicitly owns that transformation.

### COMP-040 — Application context has narrow consumers

Only a composition/view component MAY consume application context directly, except when a framework boundary must translate an externally imposed context contract.

A private compound-component context MAY be consumed by the exact subcomponents in its one compound family.

Context MUST NOT be introduced to avoid props, conceal parent-owned control, or give feature and presentational components ambient application dependencies.

### COMP-041 — Context contracts are exact and fail when absent

A context value MUST use a named, immutable, narrow contract containing only the values and capabilities every consumer uses.

Its provider MUST have the narrowest complete scope. A required consumer MUST fail explicitly when rendered without its provider rather than receiving a false default.

Context MUST NOT act as a service locator, broad application-state bag, mutable registry, or hidden lifecycle owner.

### COMP-042 — Ambient state selection is narrow

A component reading an approved store or application context MUST select only the exact values and actions it uses.

A whole-store selector, full state-object subscription, broad context consumption, or object recreated merely to bundle unrelated selections is prohibited.

Selection equality and subscription behavior MUST preserve correct updates without retaining stale data or causing unrelated rerenders.

### COMP-043 — A ref has one purpose

Each ref MUST identify one host, component handle, resource, or renderer relationship for one documented purpose.

A ref MUST NOT become:

- A second state authority.
- Hidden parent-child communication.
- A general mutable container.
- A way to inspect child internals.
- A substitute for an event or component contract.

The ref target and lifecycle MUST remain stable for every state in which the ref is documented as available.

### COMP-044 — Prop and attribute forwarding is controlled

A component MUST explicitly map props and host attributes by default.

A UI primitive adapter or framework boundary MAY use at most one trusted rest-forwarding spread when:

- The complete forwarded set is explicitly typed.
- Every forwarded member has identical meaning on the target.
- Repository props and protected semantic attributes have explicit precedence.
- No feature prop, vendor detail, or invalid host attribute can leak.
- The spread satisfies the Object spread rules.

A feature, composition/view, or presentational component MUST NOT blindly forward its props to a host element or child component.

### COMP-045 — Injected component types are real extension points

A component type MAY be accepted as a prop or registry value only when a current consumer requires a genuine open extension point.

The injected component contract MUST be named, stable, exact, and independently testable. Every implementation MUST preserve the same props, rendered states, events, semantics, keyboard and focus behavior, failures, refs, and lifecycle.

A contract MUST NOT accept both an already rendered node and a component type for the same role. Component injection MUST NOT be introduced for hypothetical customization or used to bypass normal children and slot composition.

## State authority and transitions

### COMP-046 — Every mutable UI value has one authority

Every mutable UI value in one component instance MUST have exactly one authoritative owner:

1. The direct parent.
2. The application.
3. The component.
4. An external system isolated by a framework boundary.

The contract MUST identify that authority. Two owners MUST NOT store or independently change the same semantic value.

### COMP-047 — One state-ownership model is preferred

A component SHOULD expose exactly one ownership model for each mutable concern.

When current consumers require both parent-controlled and component-owned forms, the repository contract MUST use one closed `stateOwner` discriminated union that makes the selected authority explicit.

An external primitive adapter MAY preserve a platform-standard controlled and initial-value pair such as `value` and `defaultValue` only when exact native compatibility is its contract.

Independent optional controlled and initial props whose combination selects ownership are prohibited.

### COMP-048 — Parent-controlled state is never mirrored

For a parent-controlled value, the component MUST:

- Render the current prop directly.
- Emit a proposed replacement through `on<Property>Change`.
- Continue rendering the supplied prop until the parent supplies another value.
- Remain correct when the parent rejects or delays the proposal.

The component MUST NOT copy the prop into local state, assume the proposal was accepted, or synchronize a local mirror through an effect.

Optimistic state is allowed only when the contract names it as a separate component-owned value with explicit reconciliation under `COMP-101`.

### COMP-049 — Component-owned state uses initial props exactly once

A component-owned mutable value MAY accept an optional `initial<Property>` prop.

The initial prop:

- Is read only when the component instance is created.
- Does not become a current-value prop.
- Does not synchronize later changes.
- Does not create parent authority.

The component MAY emit an optional notification after its own transition under `COMP-037`.

Repository-designed component APIs MUST use `initial<Property>` rather than `default<Property>`. An external primitive name may remain inside its adapter under `COMP-149`.

### COMP-050 — State authority does not switch during an instance lifetime

One component instance MUST NOT switch a mutable concern between parent, application, component, and external ownership.

A prop changing between present and absent, `undefined` and defined, or controlled and local variants MUST NOT change authority.

Changing authority requires a distinct closed contract variant and a new view identity or a different component.

### COMP-051 — State lives at the narrowest complete owner

A mutable UI value MUST be owned by the narrowest component or application owner that:

- Requires the complete value.
- Coordinates every consumer that must agree.
- Can perform every valid transition atomically.
- Owns its reset and lifetime.

State MUST NOT be lifted merely for visibility or stored locally when multiple peers require one synchronized authority.

### COMP-052 — Local state is limited to transient UI state

A component MAY own local state only when the value:

- Belongs exclusively to its one interaction or presentation responsibility.
- Does not need persistence, cross-view sharing, or application coordination.
- Has no external domain authority.
- May be lost when the component's view identity ends.

Persisted data, application entities, shared request state, resource state, and parent-owned workflow state MUST NOT be hidden in local component state.

### COMP-053 — Derived values are calculated, not synchronized

A value fully derivable from current props, context, authoritative state, or render inputs MUST be calculated from those sources.

It MUST NOT be stored as independent component state or synchronized through an effect.

Memoization MAY avoid a proven expensive pure calculation, but the memoized result remains derived and MUST NOT become another authority.

### COMP-054 — Coupled state uses one closed model

Mutable values that must change together or cannot vary independently MUST use one closed state model.

Independent Boolean flags, nullable values, or separate state cells that can represent contradictory combinations are prohibited.

```ts
// Prohibited
const [isLoading, setIsLoading] = useState(false)
const [loadError, setLoadError] = useState<LoadError | undefined>()

// Compliant
type ConversationLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: LoadError }
```

### COMP-055 — State transitions are atomic and named

Every component-owned state change MUST represent one named semantic transition.

The transition MUST:

- Validate its precondition.
- Calculate one complete replacement state.
- Preserve the state invariant.
- Commit coupled values atomically.
- Define repeated, rejected, and invalid transition behavior.

Raw state setters MUST NOT be passed through the component tree or exposed as a public component contract.

### COMP-056 — Initial state is valid and deterministic

Component-owned state MUST begin as one valid state of its declared model.

Initialization MUST be deterministic and limited to already available inputs. It MUST NOT perform I/O, acquire a resource, read time or randomness, inspect the DOM, or use an invalid placeholder solely until an effect runs.

Pending, unknown, and unavailable are valid only when the state type and rendered contract intentionally model them.

### COMP-057 — Prop changes do not silently reset local state

Ordinary prop changes MUST preserve component-owned state.

A component MUST NOT synchronize, repair, or reset local state merely because a prop changed. Intentional reset MUST use exactly one of:

- Parent-controlled state.
- A documented semantic transition.
- A new view identity.

Reset nonces, toggle flags, timestamp keys, and effects that copy a prop into local state are prohibited.

### COMP-058 — State remains immutable and encapsulated

Every component state value and transition result MUST satisfy the Type and Object immutability rules.

The component MUST NOT mutate state in place, expose its mutable representation, retain a writable alias supplied by a caller, or publish a renderer's raw state setter.

## Render construction

### COMP-059 — Rendering is replay-safe projection

Rendering a component with the same declared inputs and authoritative state MUST produce equivalent view structure, semantics, and identity without relying on how many times rendering has occurred.

The renderer MAY start, repeat, abandon, or replay a render. Correctness MUST NOT depend on a render committing exactly once.

### COMP-060 — Rendering reads only declared inputs

Render logic MAY read only:

- Props and children.
- The component's authoritative state.
- Approved context or narrowly selected application state.
- Stable constants and pure calculations.
- Renderer-provided values declared by the component contract.

It MUST NOT read mutable globals, current time, randomness, DOM or native-view state, external storage, network state, or an undeclared singleton.

### COMP-061 — Rendering has no observable side effects

Rendering MUST NOT:

- Mutate props, state, context, stores, modules, DOM, or native views.
- Perform I/O.
- Acquire or release resources.
- Register listeners, timers, subscriptions, or callbacks.
- Start asynchronous work.
- Emit events, analytics, logs, or notifications.
- Invoke a parent callback.

External synchronization belongs to an owned event, effect, resource boundary, or application operation.

### COMP-062 — Renderer declarations are stable and unconditional

Renderer-managed state, context, memoization, effect, resource, and lifecycle declarations MUST occur in the same order and at the same component scope on every render.

They MUST NOT be declared conditionally, inside loops, nested functions, event handlers, callbacks, or dynamically selected branches.

A conditional behavior belongs inside the declaration's operation or in a conditionally rendered child component.

### COMP-063 — Render work is bounded and deterministic

Render-time calculations MUST be synchronous, deterministic, and bounded for the accepted input limits.

Parsing unbounded input, sorting an unbounded collection, deep cloning, broad serialization, resource access, and other potentially expensive or fallible work MUST occur at the boundary that owns it before rendering.

A large finite projection MUST define its windowing, pagination, or other bounded presentation contract when rendering every item cannot meet the supported responsiveness requirement.

### COMP-064 — Template expressions remain simple

A template or renderer expression SHOULD perform only direct projection, property access, a simple predicate, or invocation of a focused pure calculation.

Nested conditional expressions, multistep calculations, assignments, side effects, policy decisions, and complex inline callbacks are prohibited.

Named values, predicates, handlers, child components, or closed exhaustive render operations MUST carry nontrivial behavior.

### COMP-065 — Peer rendered regions use one composition level

Peer semantic regions in a rendered tree MUST use the same composition granularity.

In a composition/view, when one peer region is delegated because it has an independent responsibility, every comparable independent peer region MUST also be a component or declared slot.

The parent MAY still render:

- Layout hosts and landmarks it owns.
- Connective presentation between regions.
- Shared parent-owned boundaries.

It MUST NOT render one peer as a component while directly implementing another peer's internal interaction or structural mechanics. It MUST NOT reach into child internals, replace a required child boundary with a render helper, or add meaningless wrapper components.

A leaf component MAY combine native elements and approved primitives to implement its one responsibility.

This is distinct from `FUNC-025`: that rule aligns sibling statements and operations; this rule aligns peer rendered regions.

```tsx
// Prohibited: chat content is delegated while composer mechanics are inline.
function ChatView(props: ChatViewProps): ReactElement {
  return (
    <main>
      <ChatContent messages={props.messages} />
      <form onSubmit={props.onSendMessage}>
        <textarea value={props.draft} />
        <button type="submit">Send</button>
      </form>
    </main>
  )
}

// Compliant: peer regions are composed at the same level.
function ChatView(props: ChatViewProps): ReactElement {
  return (
    <main>
      <ChatContent messages={props.messages} />
      <MessageComposer
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        onSendMessage={props.onSendMessage}
      />
    </main>
  )
}
```

### COMP-066 — Every real rendered state is exhaustive

The component MUST explicitly render every variant of each closed state or component contract.

A catch-all or default branch MUST NOT hide a newly added state. States that intentionally share output MAY delegate to the same focused projection only after exhaustive selection remains visible.

### COMP-067 — Pending, empty, and failed are distinct

Pending, empty-success, and failed states have different meanings and MUST use different state variants and rendered output.

An empty collection or absent optional domain result is not loading. A failure is not empty success. Pending MUST NOT reuse stale success output unless the contract explicitly defines retained-data refresh behavior.

### COMP-068 — Null or empty output is an intentional successful state

A component MAY render no node only when absence is a valid, documented successful result of its current contract.

Null, an empty fragment, an empty string, or an invisible host MUST NOT conceal:

- Loading.
- Failure.
- Missing required context.
- Unsupported input.
- An unimplemented interaction.
- An unavailable dependency.

### COMP-069 — Render predicates are exact

A render branch MUST test the exact state or domain condition it represents.

Truthiness MUST NOT select a state when zero, an empty string, an empty collection, `false`, or another falsy value is valid.

Closed state variants MUST branch through their discriminant. Property-presence guessing and contradictory Boolean combinations are prohibited.

### COMP-070 — Expected failures are rendered; unexpected failures propagate

A component MUST model every expected component-owned failure as an explicit state with complete recovery or exit behavior.

Unexpected render, lifecycle, programming, and invariant failures MUST remain observable and propagate to the declared framework error boundary.

A broad catch that renders empty or generic success, a local catch that hides a programming defect, and an error boundary around unrelated sibling regions are prohibited.

### COMP-071 — Rendered nodes are not application state

Renderer nodes, elements, templates, virtual trees, and component instances MUST NOT be stored in component state, application stores, persistence, or domain data.

Store the passive data or closed variant required to project the node. Component types MAY appear only in a justified extension contract under `COMP-045`.

### COMP-072 — Host, fragment, and portal structure is intentional

A component MUST choose a host element, fragment, or portal according to its semantic and lifecycle contract.

When the component owns host attributes, a ref target, a landmark, layout containment, or native behavior, it MUST render the exact host that provides that contract.

A fragment MUST NOT remove required semantics or make the public ref target ambiguous. A wrapper MUST NOT be added solely to satisfy syntax or styling convenience.

### COMP-073 — Function limits govern render implementations

Every component function, render method, handler, callback, and helper remains subject to `FUNC-013` and the complete Function standard.

This chapter defines no arbitrary maximum for rendered node count or tree depth. Large render output still MUST preserve one responsibility, bounded work, simple expressions, one composition level, and applicable Function limits.

### COMP-074 — Conditional components are lazily loaded when deferral is real

Every child component absent in at least one valid parent state MUST be evaluated for lazy loading.

It MUST be lazily imported and rendered when all of these conditions hold:

- The import produces a real separate code or resource boundary.
- The child is absent from at least one valid parent state.
- Deferral removes meaningful initial code or dependencies.
- The parent owns a complete eager fallback and failure boundary.
- Activation latency is acceptable or the child is deliberately preloaded.
- The lazy boundary does not create a serial loading waterfall.

The child SHOULD remain eager when it:

- Appears in the initial presentation.
- Is itself required to render a fallback.
- Is small, frequent, or already loaded eagerly elsewhere.
- Would add user-visible latency without meaningful initial reduction.

The lazy component declaration MUST be stable outside rendering. A component MUST NOT call a conditional dynamic import during render.

A conditionally absent child MUST unmount rather than remain mounted and visually hidden unless preserving its state, focus, exit animation, or resource is an explicit component contract.

## Composition, identity, and keys

### COMP-075 — Parents compose; children implement

A parent component owns which child responsibilities appear, their order, placement, shared boundaries, and parent-owned inputs.

A child owns its internal semantic structure, interaction mechanics, local state, effects, and private descendants.

A parent MUST NOT manipulate or depend on child internals. A child MUST NOT select its siblings, mutate parent layout, or reach outside its owned subtree except through an explicit portal contract.

### COMP-076 — Component dependencies are directional and acyclic

The component dependency graph MUST be directional and acyclic.

A component MUST NOT directly or indirectly import or render itself unless the domain is genuinely recursive.

A recursive component requires:

- A recursive Type contract.
- Explicit depth and total-node limits.
- Defined cycle handling.
- Stable semantic identity.
- A termination path for every branch.

Mutually recursive component construction and runtime registration cycles are prohibited.

### COMP-077 — Parents own external placement; children own internal layout

The parent owns the external placement, ordering, and available layout area of a child.

The child owns layout among its internal elements.

A child MUST NOT encode assumptions about its position among siblings, parent selectors, external margins, grid coordinates, or surrounding DOM structure unless those assumptions form an explicit primitive layout contract.

### COMP-078 — Composition does not use inheritance or mutation

Repository component reuse MUST use children, slots, props, focused primitives, or justified injected component contracts.

A repository-owned component MUST NOT extend another repository-owned component, mutate another component type, copy and modify a component instance, use prototype inheritance, or attach subcomponents through post-declaration mutation.

Class-based component inheritance remains prohibited by `CLASS-029`.

### COMP-079 — Compound component families are exact

A compound component MAY be used only when several named subcomponents form one cohesive semantic control whose placement must remain declarative.

The family MUST have:

- One named root owner.
- Root-prefixed subcomponent names.
- One private narrow context.
- Explicit failure when a subcomponent is outside its root.
- Exact child, ordering, state, keyboard, focus, and accessibility contracts.
- Tests of the complete family.

Static mutation such as attaching subcomponents after declaration is prohibited. The authoritative family exports stable named declarations.

### COMP-080 — Closed choices are exhaustive; open choices use one registry

A finite repository-owned component choice MUST use a closed discriminated type and exhaustive selection.

A current open extension axis MAY use one stable, exact registry of component implementations under `COMP-045`.

The registry MUST NOT contain fallback-by-name behavior, unknown values, mutable registration during rendering, or provider-specific branching in consumers.

### COMP-081 — Component types remain stable

A component type MUST retain the same declaration identity across renders and instances.

A component MUST NOT be created by a factory during render, wrapped dynamically per render, defined inline, or selected through a newly created anonymous wrapper.

Configuration belongs in props or a stable adapter declaration, not in a per-render component type.

### COMP-082 — View identity is explicit

Renderer view identity MUST be determined intentionally through component type, sibling position, and an applicable semantic key.

View identity is distinct from:

- Domain entity identity.
- Runtime object reference identity.
- Component contract identity.

The owner MUST understand whether a change preserves an existing component instance or creates a new one.

### COMP-083 — State preservation and reset are intentional

The owner of a rendered component MUST intentionally preserve or reset its view identity when state and lifecycle make the distinction observable.

A reset key MUST use stable semantic identity. The following are prohibited:

- Random values.
- Timestamps.
- Render counters.
- Serialized props.
- Object references.
- Reset nonces.
- Keys used only to force a rerender.

Changing a key is a lifecycle reset, not a state-update mechanism.

### COMP-084 — Conditional absence ends the child lifecycle

When a child is absent from the rendered tree, its component-owned state, effects, refs, and resources MUST be treated as ended.

If the product requires preservation while the content is not visible, the owner MUST declare and implement a separate retained, hidden, suspended, or application-owned state contract. Accidental preservation by CSS hiding or renderer behavior is prohibited.

### COMP-085 — The iteration owner assigns keys

The component that performs an iteration MUST assign the key to the top-level node or child component produced for each entry.

The child MUST NOT assign a key to its own root in an attempt to establish its list identity. Key selection requires knowledge of sibling membership and therefore belongs to the iteration owner.

### COMP-086 — Keys use stable semantic identity

A list key MUST identify the same logical entry across insertion, removal, filtering, sorting, and rerendering.

Use a stable domain identifier or another immutable identity field owned by the collection contract.

The following are prohibited:

- Array position.
- Randomness or time.
- Mutable display content.
- Serialized objects.
- Runtime object references.
- Values that are unique only in the current render.

Using an array index makes identity equal to position. Inserting an entry before an existing item then reuses that existing component instance and its internal state for different props, producing unexpected state. A stable semantic key follows the same logical item instead.

### COMP-087 — Index keys require a permanently static collection

An array index MAY be used as a key only when every condition is permanently true:

- Length is fixed.
- Order is fixed.
- Entries are never inserted, removed, filtered, replaced, or reordered.
- Entries have no semantic identity.
- Entries own no local state, ref, effect, animation, or resource.
- No stable semantic identifier can exist.

If any condition can change during the collection's supported lifetime, an index key is prohibited.

### COMP-088 — The list owner owns collection projection

The iterating component MUST own and document:

- Input ordering.
- Filtering.
- Duplicate behavior.
- Empty behavior.
- Stable key selection.
- Positional semantics such as first, last, selected, or current.

A child item MUST NOT infer collection-wide position or membership through DOM traversal or ambient mutable state.

### COMP-089 — Components do not coordinate through DOM traversal

Repository components MUST NOT use parent, sibling, descendant, selector, or document traversal to discover or coordinate other repository components.

Composition, props, context, refs with one exact purpose, or a recognized composite-widget model MUST express the relationship.

DOM queries are permitted only in an external imperative boundary under `COMP-157` or for exact platform behavior that cannot be represented through supported renderer APIs.

### COMP-090 — Portals retain logical ownership

A portal remains logically owned by the component that declares it.

The owner MUST define:

- Portal host creation and availability.
- Context and event propagation.
- Focus entry, containment, exit, and restoration.
- Semantic relationships across the portal.
- Layering and stacking behavior.
- Cleanup and removal.
- Error and lazy boundaries.

Physical placement outside the parent DOM subtree MUST NOT be treated as a transfer of state, lifecycle, event, or accessibility ownership.

## Events, asynchronous work, effects, and lifecycle

### COMP-091 — User intent is handled in the event phase

An operation caused by a user action MUST begin from the corresponding event handler or domain action callback.

The component MUST NOT set state solely so an effect can notice the state and perform the action. Effects synchronize external relationships; they do not replace event handling.

### COMP-092 — One handler owns one semantic event

Each event handler MUST coordinate one complete named semantic event.

It MAY validate the event, perform one state transition, delegate the required domain action, and settle the owned completion. It MUST NOT coordinate unrelated actions or act as a generic dispatcher.

Handlers remain Function constructs. Every named handler MUST satisfy the callable naming contract owned by `FUNC-003`.

### COMP-093 — Handlers delegate domain operations

A component event handler MUST express user intent in domain vocabulary and delegate domain or application work through props or approved narrow capabilities.

It MUST NOT directly implement filesystem, database, network, persistence, serialization, vendor SDK, or transport mechanics.

A primitive adapter MAY translate the exact native event before emitting the repository event.

### COMP-094 — Every enabled interaction is complete

Every interaction presented as enabled MUST have one complete owner and real outcome.

Placeholder handlers, empty callbacks, no-op buttons, console-only actions, unobserved promises, unconditional success, and TODO behavior are prohibited.

If an action is unavailable, the control MUST be absent or behaviorally disabled with the correct semantic explanation.

### COMP-095 — Re-entry policy is explicit

An event or asynchronous operation that can be invoked before prior completion MUST choose exactly one re-entry policy:

- Reject the new invocation.
- Join the current invocation.
- Replace or cancel the current invocation.
- Queue invocations in a documented order.
- Permit overlapping invocations with independent identity.

The component MUST enforce the policy consistently for pointer, keyboard, imperative, and repeated programmatic activation.

### COMP-096 — Native event cancellation is deliberate

A handler MAY prevent a native default or stop propagation only when the component owns a complete documented replacement behavior or isolates one exact event boundary.

It MUST NOT cancel events defensively, to hide duplicate handlers, or to compensate for incorrect composition.

The replacement MUST preserve applicable keyboard, pointer, form, focus, and accessibility behavior.

### COMP-097 — Every asynchronous completion has one owner

Every promise, task, request, stream, subscription, callback completion, and lazy activation started by a component MUST have one lifecycle owner.

The owner MUST await, return, observe, cancel, replace, or register the work with another named lifecycle owner.

Using `void` or discarding a handle is allowed only when another explicit owner proves that completion and terminal failure are observed.

### COMP-098 — The async owner owns its complete operation state

The owner of an asynchronous operation MUST own or explicitly expose its:

- Pending state.
- Successful completion.
- Expected failure.
- Cancellation.
- Retry.
- Re-entry policy.

A component MUST NOT duplicate request state already owned by an application store or capability. Application-owned work is selected as application state; component-owned work uses one component state model.

### COMP-099 — Stale completion cannot update current state

Late, superseded, cancelled, or out-of-order asynchronous completion MUST NOT change current visual state, component state, semantic state, focus, or announcements.

The owner MUST use cancellation, operation identity, request identity, versioning, or another explicit proof that the completion still belongs to the current operation.

Mounted-status flags alone are insufficient when two operations can overlap within one mount.

### COMP-100 — Unmount settles component-owned work

When a component's view identity ends, every component-owned task, timer, subscription, observer, resource, and pending callback MUST be cancelled, released, or otherwise settled.

Unmount MUST NOT cancel application-owned work merely because one observing component disappeared. The ownership contract determines whether work ends or continues.

### COMP-101 — Optimistic UI has an explicit reconciliation contract

An optimistic component transition MUST define:

- The authoritative committed value.
- The optimistic component-owned projection.
- The current operation identity.
- Acceptance and reconciliation.
- Rejection and rollback.
- Conflict with newer parent or application state.
- Cancellation and unmount behavior.

Optimistic state MUST NOT overwrite newer authoritative state or report completion before the owning operation completes.

### COMP-102 — Effects synchronize external relationships only

An effect or equivalent lifecycle declaration MAY be used only to synchronize the committed component state with an external system or renderer relationship.

An effect MUST NOT:

- Calculate derived state.
- Copy props into state.
- Notify a parent of rendered state.
- Run a user action.
- Repair invalid initialization.
- Sequence ordinary render logic.
- Hide mandatory setup.

If no external relationship exists, the effect is prohibited.

### COMP-103 — One effect owns one external relationship

Each effect MUST synchronize exactly one external relationship, such as one subscription, observer, timer, document integration, resource handle, or imperative widget.

Unrelated relationships require separate effects or a dedicated boundary owner. Multiple acquisitions MAY remain together only when they are inseparable parts of one lifecycle contract and share one cleanup.

### COMP-104 — Effect dependencies are exact

Every value read by an effect from its enclosing scope MUST be represented by the effect's dependency or lifecycle contract unless the renderer guarantees that value is stable.

Dependencies MUST NOT be omitted, suppressed, or broadened to an entire object merely to change execution frequency.

Unstable objects or callbacks that cause unintended resynchronization MUST be corrected at their ownership boundary rather than hidden from dependency analysis.

### COMP-105 — Cleanup mirrors every acquisition

For every listener, subscription, observer, timer, resource, registration, portal host, or imperative widget acquired by an effect, cleanup MUST release that exact acquisition.

Cleanup MUST:

- Run on dependency change and unmount.
- Handle partial acquisition failure.
- Be safe after repeated setup and cleanup.
- Use the exact callback, handle, target, and options required by the external API.
- Leave no retained reference or pending completion.

### COMP-106 — Setup and cleanup are replay-safe

Effect setup and cleanup MUST remain correct when the renderer performs setup, cleanup, and setup again without an intervening user-visible lifecycle.

Setup MUST NOT rely on previous cleanup being skipped. Cleanup MUST NOT assume setup reached its final step.

Duplicate listeners, resources, events, requests, or announcements caused by replay are prohibited.

### COMP-107 — Use the weakest sufficient lifecycle phase

A component MUST use the least blocking lifecycle phase capable of synchronizing its external relationship correctly.

Work that can occur after presentation MUST NOT block rendering or layout.

A pre-presentation or layout phase is allowed only when the component must measure or mutate an owned host before the user can observe an incorrect frame, and the work is synchronous and bounded.

### COMP-108 — Timing policies are exact

Debounce, throttle, delay, coalescing, batching, and scheduled execution MUST be named policies with exact:

- Duration and unit.
- Leading or trailing behavior.
- Replacement or queue behavior.
- Flush behavior.
- Cancellation behavior.
- Unmount behavior.
- Completion and failure ownership.

Timing MUST NOT be introduced as a workaround for races, render loops, or uncertain lifecycle order.

### COMP-109 — Lazy boundaries own loading, failure, and retry

The parent declaring a lazy component boundary MUST own:

- An eagerly available fallback.
- An observable failure state.
- A real retry operation when recovery is possible.
- Optional preload policy.
- Stable lazy component identity.

The fallback and failure UI MUST NOT depend on the same deferred module. The boundary MUST NOT render blank output while loading or create a serial loading waterfall.

### COMP-110 — Failure remains observable

A component MUST NOT convert a failure into:

- Empty output.
- False success.
- Permanent pending state.
- A no-op retry.
- Console-only reporting.
- An ignored rejection.

Expected failures use explicit component or application state. Unexpected failures propagate to the declared framework error boundary. Every retry MUST perform a real new attempt or a documented recovery transition.

## Semantics, accessibility, keyboard, and focus

This ruleset uses applicable [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/) requirements as the minimum for HTML output and the complete [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/practices/read-me-first/) pattern when a custom widget is necessary.

### COMP-111 — Accessibility is part of the component contract

A component MUST provide equivalent meaning, state, and operation through every supported input method and accessibility API.

This applies to every valid state, including pending, empty, failed, disabled, expanded, selected, and completed states.

A component is incomplete when its visual behavior works but its semantic, keyboard, or focus behavior does not. An accessibility-disabling prop is prohibited when the interaction remains available visually.

For HTML output, the component MUST satisfy every applicable WCAG 2.2 Level AA criterion for the output and behavior it owns.

### COMP-112 — Native semantic controls are mandatory when available

A component MUST use the native platform element whose meaning and behavior match the operation.

For HTML:

- Navigation to an address uses an `<a href>`.
- An ordinary in-place command that neither submits nor resets a form uses `<button type="button">`.
- A form submission uses `<button type="submit">`.
- A deliberate native form reset uses `<button type="reset">`.
- Form entry and selection use the appropriate native input, select, checkbox, radio, or textarea.
- Lists, tables, headings, and landmarks use their semantic elements.

Every HTML `<button>` MUST declare an explicit `type` matching the operation it owns. A component MUST NOT rely on the context-dependent default button type or use `type="button"`, `type="submit"`, or `type="reset"` for a different operation.

A generic element made interactive through click handlers, focusability, keyboard handlers, or ARIA is prohibited when a native control can perform the operation.

Native semantics MUST NOT be contradicted or redundantly reimplemented with ARIA.

### COMP-113 — A custom widget implements one complete recognized pattern

A custom widget is allowed only when:

1. No native control or approved repository primitive can express the required behavior; or
2. A documented platform-support defect prevents using it.

The widget MUST select one recognized accessibility pattern and completely implement its:

- Role and semantic structure.
- Accessible name.
- Required states and properties.
- Owned child relationships.
- Keyboard interaction.
- Focus management.
- Pointer interaction.
- Disabled behavior.

Adding a role without implementing its behavior is prohibited. Combining incomplete parts of different widget patterns is prohibited.

### COMP-114 — Interactive controls do not contain unrelated controls

A simple interactive control MUST NOT contain another focusable or interactive control.

Interactive descendants are permitted only when a recognized composite-widget pattern explicitly defines the parent as owning those interactive items.

A clickable card containing independent links, buttons, or inputs MUST expose separate sibling interactions rather than making the entire card another enclosing control.

### COMP-115 — Programmatic semantics and functional state remain synchronized

Every observable state MUST expose the correct programmatic:

- Name.
- Role.
- Value.
- State.
- Description.
- Relationship.

The semantic state MUST change in the same committed transition as the visible and functional state.

Code MUST NOT expose `selected`, `expanded`, `pressed`, `checked`, `disabled`, `invalid`, `required`, `current`, or `busy` when the component does not behave that way. A visible state MUST NOT change while its corresponding programmatic state remains stale.

### COMP-116 — Every control has one exact accessible name

Every interactive element, focusable element, and role that requires a name MUST have a non-empty programmatic name describing its action or purpose.

When visible label text exists:

- The accessible name MUST contain that exact text.
- The visible text MUST occur at the beginning of the accessible name.
- Different wording MUST NOT replace the visible label.

Controls operating on different targets MUST have distinguishable names.

An icon-only control MUST be named after its action and target, not the appearance of its icon.

A placeholder, tooltip, `title`, filename, or surrounding visual position MUST NOT be the only name.

Invisible names MUST be localized together with visible copy.

### COMP-117 — Descriptions supplement names and relationships are valid

A name identifies the control. Instructions, constraints, consequences, and error details belong in a separate description relationship.

Every programmatic relationship MUST:

- Reference an existing target.
- Reference a unique identifier.
- Remain valid for the complete lifetime of the relationship.
- Be removed when the relationship no longer applies.

Reusable components MUST NOT emit a fixed identifier that can collide with another instance. Identifiers MUST be stable for the rendered instance.

Repository code MUST NOT generate a relationship identifier from:

- Randomness or current time.
- A mutable counter advanced during rendering.
- A collection index or position.
- Any source whose value changes when an unrelated component or collection entry renders, mounts, unmounts, inserts, removes, or reorders.

A renderer-provided identifier MAY be used when the renderer guarantees that it is unique per component instance, stable for that instance, and hydration-safe across pre-rendering and activation. Repository code MUST NOT reconstruct or modify that identifier from mutable rendering or collection order.

### COMP-118 — Non-text content has one exact semantic treatment

Meaningful imagery MUST expose a concise text alternative with the same purpose.

For functional icons, the alternative identifies the action or destination rather than describing the glyph.

Decorative or fully redundant imagery MUST:

- Be excluded from the accessibility tree.
- Be non-focusable.
- Contribute no duplicate name.

An icon communicating status, validation, direction, or state MUST have equivalent text or programmatic state. Color or icon shape alone is insufficient.

### COMP-119 — Semantic and visual structure preserve the same order

Headings, lists, tables, groups, regions, and landmarks MUST be selected according to meaning rather than appearance.

Only the component owning a semantic region may emit its landmark. Multiple landmarks of the same kind MUST have distinguishable names when users need to choose between them.

Source order, accessibility order, reading order, and sequential focus order MUST preserve the same meaningful sequence. Visual CSS reordering MUST NOT create a contradictory sequence.

### COMP-120 — Every pointer operation has keyboard parity

Every pointer, touch, or hover-operated function MUST have a keyboard-accessible equivalent producing the same semantic transition.

A genuinely path-dependent operation, such as freehand drawing, MAY require pointer movement only when an equivalent non-path-dependent operation is also available.

Hover-revealed information MUST also be reachable through keyboard focus.

Keyboard and pointer activation MUST NOT invoke the operation twice.

### COMP-121 — Keyboard behavior follows the platform pattern

Native controls MUST retain their native keyboard behavior.

A custom widget MUST implement the complete keyboard model of its selected pattern. For example:

- A custom button activates with both `Enter` and `Space`.
- A link activates and navigates according to native link behavior.
- A composite widget implements its defined arrow, Home, End, and type-ahead behavior.

A component MUST NOT cancel a native key action unless it consumes that key for its documented interaction.

A single-character shortcut is allowed only when it is remappable, disableable, or active exclusively while the owning component has focus.

### COMP-122 — Composite widgets use one focus-management model

A composite widget MUST choose exactly one of:

- Roving focus.
- Active-descendant focus.
- Another complete platform-defined model.

For roving focus, exactly one current item has `tabIndex={0}` and all other managed items have `tabIndex={-1}`.

For active-descendant focus:

- The owning container retains actual focus.
- The active descendant reference resolves to an allowed owned or controlled item.
- The active item has a visible indication.
- The active item remains perceivable.

`Tab` and `Shift+Tab` move between components. Pattern-defined keys move within the composite. `Tab` MUST be able to leave it.

### COMP-123 — Focus order and reachability are deliberate

Sequential focus order MUST follow the logical source order.

Positive tab indices are prohibited.

A negative tab index is allowed only for:

- A deliberate programmatic focus destination.
- An inactive item managed by a recognized composite-widget pattern.

An ordinary operable control MUST NOT be removed from keyboard reach with a negative tab index.

Hidden, inactive, or inert content MUST contain no reachable tab stop.

### COMP-124 — Keyboard focus is always visibly identifiable

A focused component MUST display either:

- The unmodified platform focus indicator; or
- The approved repository focus style.

Removing an outline without supplying an equivalent visible focus style in the same component or style rule is prohibited.

The focus indicator MUST remain visible against every supported component state and MUST NOT be fully hidden by sticky, fixed, clipped, or overlapping content. See the current WCAG requirements for [focus visibility and obscuring](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible).

### COMP-125 — Focus moves only for an explicit semantic transition

Rendering, rerendering, receiving props, completing ordinary background work, or displaying a status MUST NOT steal focus.

Programmatic focus is allowed only for a documented transition such as:

- Opening a focus-owning dialog.
- Entering a newly navigated view.
- Discovering a rejected form submission.
- Replacing or deleting the currently focused item.
- Moving into content explicitly requested by the user.

If the focused node is removed, its owner MUST synchronously move focus to a deterministic logical successor. Focus MUST NOT silently fall back to the document root.

### COMP-126 — Nonmodal components do not trap focus

A nonmodal component MUST always permit forward and reverse keyboard navigation out of itself.

Focus containment is allowed only for an active modal component following `COMP-134`.

A custom or undocumented keyboard escape sequence is prohibited.

### COMP-127 — Disabled and read-only states are different contracts

A native disabled mechanism MUST be used when it matches the required behavior.

A disabled component MUST NOT activate, edit, submit, navigate, invoke shortcuts, or emit a success callback through pointer, keyboard, touch, or guarded programmatic execution.

Visual styling and `pointer-events: none` are insufficient.

Semantic disabled state on a custom widget is allowed only when the component also suppresses every activation path.

Ordinary disabled controls leave sequential focus order. A recognized composite pattern MAY retain disabled items for discoverability, but the policy MUST be consistent throughout that widget.

Read-only MUST NOT be represented as disabled, and disabled MUST NOT be represented as read-only.

### COMP-128 — Form labels, groups, and constraints precede entry

Every form control MUST have a persistent user-perceivable label and a programmatically associated name.

Related controls MUST expose:

- One group relationship.
- One group label.
- One individual name for each selectable option.

Required state, accepted format, range, units, and other input constraints MUST be available before input, both visibly and programmatically.

Placeholder text, punctuation, color, position, or an icon alone MUST NOT communicate a label or constraint. See the official [form-label guidance](https://www.w3.org/WAI/tutorials/forms/labels/).

### COMP-129 — Validation errors are textual, associated, and corrective

An automatically detected validation error MUST:

- Identify the affected control.
- Describe the error in text.
- Expose invalid state.
- Associate the current message with the control.
- Provide a known correction when doing so does not undermine security or purpose.
- Preserve the user's entered value.

An untouched required field MUST NOT be marked invalid merely because it is empty. It becomes invalid after its validation boundary, such as blur or attempted submission, according to the documented form contract.

Color, border styling, or an error icon alone is prohibited.

### COMP-130 — Rejected submissions provide deterministic error discovery

A rejected submission MUST NOT merely block submission or recolor fields.

When exactly one control is invalid, focus MUST move to that control and its associated error MUST be available immediately.

When multiple controls are invalid, focus MUST move to a programmatically focusable error summary containing links or equivalent navigation to every invalid control.

Entered data MUST remain intact.

### COMP-131 — Non-focus-taking results use explicit status semantics

An update that communicates an action result, loading state, progress, completion, cancellation, or error without moving focus MUST expose an appropriate status message.

Routine loading, saving, completion, and result-count messages use polite status semantics.

Assertive alert semantics are reserved for urgent, time-sensitive information requiring immediate awareness. They MUST NOT be used for routine progress or validation.

A status or alert MUST NOT steal focus. If acknowledgement or a decision is required, the component must use an appropriate dialog interaction. See the WCAG guidance for [status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages).

### COMP-132 — Live announcements are bounded and deterministic

Live-region semantics MUST exist before the content update that needs announcing.

A component MUST update one established, narrowly scoped region. It MUST NOT make an application, form, list, or results container live merely because part of it changes.

One semantic event produces one concise announcement. Multi-node mutations forming one message MUST be announced atomically.

Repeated meaningful occurrences MUST remain distinguishable even when their text is identical.

Superseded or stale asynchronous work MUST NOT update visual state, accessible state, or announcements.

### COMP-133 — Busy and progress states represent real work

A region unavailable during loading MUST expose busy state before its contents change and clear it only after the final usable state is committed.

Busy state does not replace visible loading content or an accessible status.

Determinate progress MUST expose a name, minimum, maximum, and current value synchronized with the visual indicator.

Indeterminate progress MUST omit the current value. A fabricated zero percent is prohibited.

Progress announcements MUST be limited to meaningful milestones rather than every animation frame or percentage change. Completion MUST explicitly expose readiness or completion.

### COMP-134 — Modal dialogs own a complete focus lifecycle

Opening a modal dialog MUST:

- Move focus inside it.
- Make background interaction inert.
- Constrain sequential focus to the dialog.
- Expose a dialog name.

A dismissible dialog MUST have a visible keyboard-operable close control and close with `Escape`.

Initial focus MUST be intentional:

- Long structured content begins at a focusable heading or introductory node.
- Irreversible workflows begin at the least destructive action.
- Short informational dialogs may begin at the primary action.

Closing restores focus to the invoker. If the invoker no longer exists, focus moves to the nearest logical workflow target. Nested dialogs restore focus to their immediate parent-dialog invoker.

Modal semantics MUST NOT be emitted unless these behaviors exist. This follows the complete [WAI-ARIA modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

### COMP-135 — Nonmodal and hover/focus overlays preserve context

Receiving focus or pointer hover MUST NOT open a modal, submit data, navigate, or otherwise change context.

Additional content appearing on hover or focus MUST be:

- Dismissible without moving focus.
- Hoverable when pointer-triggered.
- Persistent until dismissed, the trigger loses hover and focus, or the information becomes invalid.

If an activated nonmodal overlay moves focus into itself, closing it MUST restore focus to its trigger or a documented logical successor.

### COMP-136 — Hidden and inert state is consistent

Content hidden from users MUST also be absent from sequential focus and the accessibility tree.

A component MUST NOT:

- Apply accessibility-hidden semantics to a focusable node.
- Hide an ancestor while leaving reachable descendants.
- Rely on a descendant to undo an accessibility-hidden ancestor.
- Leave active controls inside inert content.

Visually hidden content MAY remain in the accessibility tree only when it intentionally provides equivalent text, instructions, or status.

Visibly rendered meaningful or functional content MUST NOT be accessibility-hidden unless an equivalent meaning and operation remain available.

### COMP-137 — State is never conveyed through one sensory cue

Selected, expanded, pressed, checked, disabled, invalid, current, busy, warning, and error states MUST have:

- A programmatic representation.
- A visible representation not dependent on color alone.

Color, position, shape, icon, sound, or motion alone MUST NOT communicate a required state. Text or another independent cue must accompany it.

### COMP-138 — Nonessential motion is suppressible

Interaction-triggered nonessential motion MUST honor the platform's reduced-motion preference.

When reduced motion is requested, the component MUST remove or replace movement rather than merely shorten it.

Motion is essential only when removing it would make otherwise unavailable information or functionality impossible to understand.

A component MUST NOT intentionally flash content more than three times per second.

### COMP-139 — Time limits and disappearance are explicit

A component MUST NOT create a time limit for an action unless the current domain requirement requires it.

Actionable, warning, or error content MUST remain until the user dismisses it or resolves its cause.

A passive status MAY disappear automatically only when:

- No action is required.
- It is not the sole evidence of the outcome.
- Equivalent outcome information remains available.
- Its duration is represented by a named policy value.
- Its timeout pauses while it or its related control has hover or focus.

Externally imposed expiration MUST be announced in advance and offer extension when the underlying system permits it.

### COMP-140 — Pointer targets and gestures remain operable

An authored web pointer target MUST be at least `24 × 24` CSS pixels.

A smaller target is allowed only when it is:

- Inline in text.
- Entirely controlled and unmodified by the user agent.
- Essential to the information.
- Accompanied by an equivalent conforming target.
- Spaced so that its WCAG-defined 24-pixel target circles do not intersect.

Hit regions MUST NOT overlap ambiguously.

A multipoint, path-based, or dragging interaction MUST provide a single-pointer, non-path, or non-dragging alternative unless the gesture itself is essential.

Activation SHOULD complete on release so the user can cancel by moving away before release.

### TypeScript/React example

```tsx
type DeleteConversationButtonProps = {
  readonly conversationTitle: string
  readonly isDeleting: boolean
  readonly onDeleteConversation: () => void
}

/**
 * Deletes one named conversation through an accessible native button.
 *
 * @category presentational
 */
function DeleteConversationButton({
  conversationTitle,
  isDeleting,
  onDeleteConversation
}: DeleteConversationButtonProps) {
  return (
    <button type="button" disabled={isDeleting} onClick={onDeleteConversation}>
      <TrashIcon aria-hidden="true" />
      <span className="sr-only">Delete {conversationTitle}</span>
    </button>
  )
}
```

The native button supplies the base semantics and keyboard behavior. The accessible name states both the action and target, the decorative icon contributes no duplicate name, and disabled behavior is functional rather than only visual.

## Framework and external-component boundaries

The central rule is: a third-party component may be used directly only when one repository component completely contains that dependency and its contract already satisfies our standards. Otherwise, a repository-owned adapter is mandatory.

### COMP-141 — Every external UI dependency has one integration mode

Each external construct used while rendering MUST be classified as exactly one of:

1. **Renderer or platform primitive:** defines the component model or native host elements, such as React APIs or HTML elements.
2. **Passive visual asset:** renders presentation but owns no interaction, focus, state, resource, provider, or lifecycle, such as an icon.
3. **Behavioral UI dependency:** owns interaction, state, focus, keyboard behavior, portals, resources, or lifecycle.
4. **Framework-required form:** an externally mandated entry point, subclass, object shape, directive, registration, or lifecycle declaration.
5. **Non-UI mechanism:** a storage, network, filesystem, analytics, vendor SDK, or similar dependency.

Renderer primitives follow ordinary component rules. Passive assets may be used locally under `COMP-118`.

Behavioral dependencies follow `COMP-142` and `COMP-143`. Framework-required forms remain isolated under `COMP-144`.

A component MUST NOT access a non-UI mechanism directly. It receives a domain-facing capability or delegates through the application boundary under the Function and Interface standards.

### COMP-142 — Direct third-party component use has strict eligibility

A behavioral third-party component MAY be used directly only when every condition is true:

- Exactly one repository component declaration owns every use of it.
- No vendor type, prop, event, error, state, ref, provider, or child convention escapes that owner.
- Its semantics, state authority, accessibility, keyboard behavior, focus behavior, lifecycle, and supported environments already satisfy every applicable repository rule.
- No repository default, terminology, validation, styling policy, compatibility policy, or failure translation is required.
- Its observable behavior is covered by the owning component's tests.
- Replacing or removing it would change only that one owner.

A second repository consumer, any required translation, or any escaping vendor contract makes an adapter mandatory.

Renderer/platform primitives and passive visual assets are not subject to the single-owner restriction.

### COMP-143 — A behavioral external contract is otherwise isolated behind one adapter

When `COMP-142` is not completely satisfied, one repository-owned framework-boundary or UI-primitive-adapter component MUST own the integration.

An adapter is mandatory when any of these exists:

- Multiple repository consumers.
- Vendor-specific props, values, events, errors, refs, or children.
- Repository naming or state-authority differences.
- Repository defaults or styling.
- Accessibility or keyboard correction.
- Provider, portal, lifecycle, or environment setup.
- Compatibility handling or support workarounds.
- Raw content or imperative rendering.
- A third-party type would otherwise enter a repository contract.

One adapter owns one external component family or mechanism. If the adapter cannot make the resulting behavior compliant, the dependency MUST NOT be adopted.

### COMP-144 — Externally imposed exceptions are exact and minimal

A framework-required function name, callback signature, object shape, class, inheritance relationship, directive, or lifecycle operation is permitted only when the external contract requires that exact form.

The exception MUST:

- Remain inside the framework boundary.
- Contain only externally required declarations.
- Delegate repository behavior to compliant constructs.
- Add no repository-designed operation under the external naming scheme.
- Expose no external implementation detail to application or domain code.
- Preserve the complete external contract.

The existing external-contract rules in `FUNC-*`, `OBJECT-061`, `IFACE-030`, and `CLASS-030` remain authoritative. An external requirement does not exempt adapter-internal logic.

### COMP-145 — An adapter establishes a real repository boundary

An adapter MUST add at least one of:

- An independent repository-owned contract.
- Explicit terminology or data translation.
- State-authority translation.
- Semantic or accessibility correction.
- Repository defaults.
- A cohesive primitive styling contract.
- Lifecycle or environment isolation.
- Compatibility isolation.

Aliases, renamed re-exports, and components that only forward the same unrestricted contract are prohibited.

```tsx
// Prohibited
const Button = VendorButton

// Prohibited
function Button(props: VendorButtonProps) {
  return <VendorButton {...props} />
}
```

Isolation through an explicit repository-owned contract counts as a real boundary even when the final rendered appearance is unchanged.

### COMP-146 — Adapter public contracts are repository-owned

An adapter MUST expose one named props type using repository terminology and repository types.

A public adapter contract MUST NOT expose:

- A complete vendor `Props` type.
- `ComponentProps<typeof VendorComponent>` or an equivalent inferred vendor surface.
- An unrestricted vendor options object.
- Vendor enums, events, errors, instances, contexts, or state objects.
- Vendor DOM structure or internal selectors.
- Store, transport, filesystem, network, or SDK types.

A primitive adapter MAY intentionally expose an applicable native host attribute or ref contract. Renderer node/result types MAY be used where the Component contract requires them.

Vendor-specific properties still MUST be deliberately selected and translated. A dependency update MUST NOT silently add new repository props.

### COMP-147 — Adapter mapping is explicit and complete

The adapter MUST explicitly map every applicable:

- Repository prop to an external input.
- External output to a repository callback or result.
- State and state transition.
- Child or slot.
- Default.
- Failure.
- Semantic state.
- Accessible relationship.
- Ref or imperative operation.

Repository props MUST NOT be blindly spread into an external component.

One trusted rest-forwarding spread is allowed only when `COMP-044` and the Object spread rules prove that the entire forwarded set has identical meaning and controlled precedence.

The adapter MUST NOT silently ignore an accepted prop or external output.

### COMP-148 — Observable external defaults are selected explicitly

The adapter MUST explicitly supply every external default that can affect:

- Initial or preserved state.
- Controlled or local ownership.
- Semantic output.
- Keyboard or pointer behavior.
- Focus.
- Disabled behavior.
- Child mounting or retention.
- Portal behavior.
- Ordering or orientation.
- Animation.
- Error handling.
- Event timing.
- Lifecycle or cleanup.

The adapter MUST NOT depend on a vendor's current default for observable behavior.

A dependency upgrade changing its own default MUST therefore not silently change repository behavior.

### COMP-149 — State authority is translated without duplication

An adapter MUST preserve the repository component's one declared state authority.

When a vendor uses `defaultValue`, `defaultChecked`, or equivalent terminology, the adapter MAY map the repository's `initial<Property>` prop to that external mechanism internally. The vendor name MUST NOT leak into the repository contract.

A controlled repository prop MUST map to a genuinely controlled external operation. The adapter MUST NOT claim controlled behavior when the external component can ignore a rejected proposal or retain conflicting internal state.

Vendor and repository ownership models MUST NOT coexist for the same mutable value.

### COMP-150 — Vendor events, values, and failures stop at the adapter

The adapter MUST translate external events and results immediately into repository vocabulary and types.

It MUST NOT expose:

- Raw vendor event objects.
- Vendor enums or sentinel values.
- Vendor-specific callback ordering.
- Vendor errors.
- Untyped or dynamically produced values.

Unknown or external values MUST be validated before becoming trusted repository values.

A primitive adapter MAY forward an exact native event only under `COMP-029`.

The adapter MUST preserve the real completion contract. It MUST NOT emit success merely because an external operation started, and it MUST NOT swallow or relabel an external failure as success.

### COMP-151 — External child topology and polymorphism do not leak

Consumers MUST NOT need to understand a vendor's private provider, root, trigger, portal, positioner, indicator, or wrapper topology.

A repository compound primitive MAY expose its own complete compound contract under `COMP-079`, but vendor subcomponents MUST NOT be re-exported as that contract.

Generic public host substitution through `as`, `asChild`, `component`, `renderRoot`, or equivalent props is prohibited when it can change semantics, focus, refs, keyboard behavior, or prop validity.

A real injected-component extension point follows `COMP-045`. It MUST NOT be disguised as arbitrary host polymorphism.

An adapter MAY use an external slot-merging mechanism internally only for one known child contract with explicit prop precedence and ref behavior.

### COMP-152 — Refs project one repository-owned target

A forwarded ref MUST refer to the same logical target in every valid rendered state.

A repository public ref MUST NOT expose a vendor component instance or vendor imperative handle.

A primitive adapter MAY project the exact native host ref when that host is its documented control. Otherwise, the adapter MUST map external operations into the narrow repository handle permitted by `COMP-028`.

Ref composition MUST preserve:

- Assignment and clearing.
- Mount and unmount behavior.
- Callback-ref cleanup.
- The external component's required ref.
- The caller's documented ref.

A wrapper MUST NOT silently retarget its ref from one semantic element to another.

### COMP-153 — External providers and lifecycle have one owner

An external provider, registry, portal host, retained instance, subscription, or lifecycle setup MUST have one declared repository owner.

That owner MUST:

- Place the provider at the narrowest complete scope.
- Supply configuration explicitly.
- Prevent feature and presentational components from consuming vendor context directly.
- Own acquisition, update, cleanup, and disposal.
- Keep external state from competing with repository state.
- Expose missing setup through an explicit failure rather than undefined behavior.

A provider MUST NOT be recreated during rendering or independently by every consumer.

Portals remain subject to `COMP-090`; lifecycle and cleanup remain subject to `COMP-099` through `COMP-109`.

### COMP-154 — Only documented external surfaces may be used

An adapter MUST use only the external dependency's supported public contract.

It MUST NOT depend on:

- Undocumented DOM nesting.
- Generated class names.
- Private data attributes.
- Internal component state.
- Package-internal import paths.
- Runtime version-string branches.
- Reflection into vendor objects.
- Monkey-patching or prototype mutation.
- DOM queries used to repair vendor behavior.

A documented external state attribute MAY be consumed only inside its adapter and MUST NOT become a consumer styling or behavior contract.

If required behavior is unavailable through a supported public API, the dependency MUST be replaced or an explicit repository exception must be approved.

### COMP-155 — External accessibility claims are verified, not assumed

Using an “accessible” library, semantic prop, role, or native-looking component does not transfer responsibility to the dependency.

The repository adapter MUST ensure that the integrated result satisfies `COMP-111` through `COMP-140`, including:

- Actual native or custom-widget behavior.
- Names and state synchronization.
- Keyboard interaction.
- Focus entry, movement, containment, and restoration.
- Disabled behavior.
- Announcements.
- Hidden and inert state.
- Pointer behavior.

Styling or composition MUST NOT remove behavior supplied by the external primitive.

If the external component cannot preserve the required semantic and interaction contract, the adapter MUST reject or replace it rather than concealing the defect.

### COMP-156 — Raw markup and renderer escape hatches are isolated

Normal component content MUST use the renderer's escaped text and attribute path.

A raw-markup API, unsafe HTML injection, or equivalent renderer escape hatch is allowed only in a named framework-boundary adapter that accepts:

- A repository-owned trusted-markup type produced by one approved sanitizer; or
- A repository-owned compile-time constant reviewed as markup.

A plain `string`, cast, assertion, raw external response, user input, persisted content, or vendor payload MUST NOT manufacture trusted markup.

The trusted-markup creator owns the exact sanitization policy. Active scripts, inline event handlers, and executable URLs are prohibited in repository-rendered markup.

A rich-content library that requires raw markup follows this rule even when the library performs the final rendering.

### COMP-157 — One renderer owns each emitted subtree

A declarative renderer and an external imperative widget MUST NOT both mutate the same subtree.

When an external widget requires imperative rendering:

- The adapter renders one dedicated host.
- The host contains no repository-rendered children.
- The external widget exclusively owns the host's descendants.
- The adapter maps inputs through the widget's public update operation.
- The adapter owns complete disposal.
- Repository code does not patch or query the generated descendants.

Direct DOM or native-view mutation outside such a boundary is prohibited.

### COMP-158 — Framework execution environments are explicit and minimal

When a framework distinguishes server, client, build-time, native-main-thread, worker, or equivalent component environments, every affected component MUST have one explicit execution contract.

A framework directive or annotation MUST be placed at the smallest component boundary that requires it.

A parent MUST NOT be moved into a more capable environment merely because one child requires that environment.

Environment-only APIs and dependencies MUST remain inside the corresponding boundary. A universal component MUST render correctly without reading an environment-only global.

### COMP-159 — Values crossing render environments are passive contracts

A value crossing a server/client, process, thread, worker, or equivalent renderer boundary MUST be represented by a named, validated, passive data type accepted by that framework boundary.

The crossing value MUST NOT contain:

- A component instance.
- A store.
- A mutable shared object.
- A DOM or native-view reference.
- A resource or SDK client.
- An arbitrary callback.
- A class instance whose behavior or prototype is required.
- An unvalidated serialized value.

A framework-defined encoded action or reference MAY cross only as an external adapter value. It MUST NOT become a general repository callback or domain capability.

### COMP-160 — Initial rendering and activation are deterministic

For the same contract inputs, pre-rendered output and the first activated client output MUST have equivalent structure, semantics, accessible state, and view identity.

Initial rendering MUST NOT depend on browser globals, current time, randomness, locale discovery, viewport measurement, or client-only persisted state.

Client-only information MUST enter through an explicit post-activation state or dedicated client boundary with a valid initial presentation.

Hydration or renderer-mismatch warnings MUST NOT be suppressed to conceal nondeterministic output. Suppression is allowed only inside a boundary for externally mutated host content that cannot participate in hydration, and that boundary MUST own replacement and validation.

### COMP-161 — Framework error boundaries own one exact failure region

A framework error boundary MUST declare the exact rendered subtree whose unexpected render or lifecycle failures it owns.

It MUST:

- Catch only the failure phases supported by its renderer contract.
- Render a complete, accessible failed state.
- Keep the failure observable under `COMP-110`.
- Provide a real retry only when reconstruction can succeed.
- Reset through one explicit recovery transition.
- Preserve or relocate focus intentionally.
- Avoid swallowing failures from unrelated sibling regions.

It MUST NOT claim to catch event-handler, asynchronous, process, or external-service failures when the renderer boundary does not actually observe those failures.

### TypeScript/React example

```tsx
type NotificationsSwitchProps = {
  readonly isNotificationsEnabled: boolean
  readonly onIsNotificationsEnabledChange: (
    isNotificationsEnabled: boolean
  ) => void
}

/**
 * Adapts the external switch contract to notification settings.
 *
 * @remarks Primary category: framework boundary.
 * @param props - Controlled notification state and its parent-owned proposal.
 * @returns A labeled notification switch.
 */
function NotificationsSwitch({
  isNotificationsEnabled,
  onIsNotificationsEnabledChange
}: NotificationsSwitchProps): ReactElement {
  const labelId = useId()

  return (
    <div>
      <span id={labelId}>Notifications</span>
      <VendorSwitch
        aria-labelledby={labelId}
        checked={isNotificationsEnabled}
        onCheckedChange={onIsNotificationsEnabledChange}
      />
    </div>
  )
}
```

The external `checked` contract is translated into repository terminology, the vendor props type does not escape, ownership remains controlled, and the adapter owns the accessible relationship.

## Compatibility and documentation

### COMP-162 — The complete observable component contract is a compatibility contract

Every item declared by `COMP-020` is part of the component's compatibility surface.

This includes:

- Component name and category.
- Props, defaults, optionality, and absence meaning.
- Controlled or local state authority.
- Children, slots, injected components, and fallback behavior.
- Context, provider, store, and ambient prerequisites.
- Valid rendered states and content presence.
- Event payload, count, order, timing, completion, and cancellation.
- State preservation, reset behavior, view identity, and lifecycle.
- Pending, failure, retry, and lazy-loading behavior.
- Accessible names, roles, states, relationships, and announcements.
- Keyboard and focus behavior.
- Public host attributes, refs, and imperative operations.
- Portal behavior and documented styling or integration hooks.

Changing any of these is a compatibility change. Type compatibility alone does not prove component compatibility.

### COMP-163 — Backward compatibility is judged against unchanged consumers

A change is backward-compatible only when every previously valid consumer can remain unchanged and still receive the same documented meaning and behavior.

Adding an optional prop is compatible only when omitting it preserves the previous behavior exactly.

The following remain compatibility changes even when code still compiles:

- Changing a default.
- Changing state authority.
- Changing callback timing or invocation count.
- Changing a rendered empty, loading, or failed state.
- Changing semantic role or accessible name.
- Changing keyboard behavior or focus movement.
- Changing whether state is preserved or reset.
- Changing the public host element or ref target.
- Changing lazy activation or fallback behavior.

An internal incompatible change MUST update every caller, composition site, test, and documentation reference atomically.

A published incompatible change requires explicit approval and a supported migration path.

A correction of undocumented noncompliant behavior does not require preserving the defect, but affected consumers and compatibility tests MUST still be identified and reviewed.

### COMP-164 — Compatibility shims remain outside the authoritative component

When old and current contracts must coexist temporarily, one named compatibility adapter MUST translate the old contract into the current contract.

The adapter MUST define:

- The exact old contract it accepts.
- The current component it targets.
- The mapping for every old input and output.
- How unsupported old behavior fails.
- How conflicting inputs are rejected.
- Its replacement and migration instructions.
- Its removal condition.
- Tests for every supported migration path.

The authoritative component MUST NOT accumulate:

- Legacy prop aliases.
- `legacy`, `compatibility`, or version mode flags.
- Silent precedence between old and new props.
- Multiple callback vocabularies.
- Multiple state-authority models.
- Branches selected by consumer version.

The shim MUST be removed when its documented migration condition is satisfied.

### COMP-165 — Private rendering structure does not become public accidentally

The following remain private unless deliberately documented as contract:

- Internal child component types.
- Semantically neutral wrapper nodes.
- Local state representation.
- Lifecycle declaration, hook, or effect arrangement.
- Memoization.
- Renderer-generated identifiers.
- Undocumented class names and data attributes.
- External-library implementation details.

Consumers and tests MUST NOT depend on private structure.

The following are observable and therefore remain contractual:

- Semantic structure and relationships.
- Meaningful content order.
- Reading and focus order.
- The public host element when its behavior or ref is exposed.
- Slot placement and cardinality.
- Accessible names, descriptions, and state.
- Documented styling hooks.
- Documented automation or integration selectors.
- Nodes required by a platform behavior.

An implementation detail becomes public only through an explicit documented decision, not because a consumer discovered it.

### COMP-166 — Supplemental documentation cannot own hidden behavior

The component declaration, `COMP-018`, `COMP-019`, and `docs/JSDOC.md` remain authoritative for component documentation.

A guide, story, screenshot, design file, test, or usage page MAY demonstrate the contract but MUST NOT be the only place defining:

- Required providers or context.
- Props or defaults.
- State authority.
- Supported states.
- Event behavior.
- Accessibility behavior.
- Failure or lazy boundary behavior.
- Composition restrictions.

Supplemental documentation MUST reference the authoritative component and change atomically with it.

A manually duplicated props, event, or state table is prohibited when it can drift from the authoritative declaration. Generated documentation derived from the authoritative contract is allowed.

### COMP-167 — Canonical examples are verified consumers

A canonical component example MUST:

- Use only the public component contract.
- Include every required provider, boundary, and slot.
- Demonstrate a complete valid state.
- Use compliant props, callbacks, semantics, and state authority.
- Be type-checked, executable, or derived from an executable test or example source.
- Change atomically with the contract it demonstrates.

An abbreviated illustrative fragment MUST be labeled as incomplete and MUST NOT imply that omitted setup or behavior is optional.

A screenshot or design artifact may illustrate appearance but MUST NOT serve as proof that the component contract is executable.

## Verification and objective limits

### COMP-168 — Every observable component behavior has a verification owner

Every component-owned observable behavior MUST have one explicit verification owner.

That owner MUST provide an automated component test, unchanged shared contract suite, or other automated evidence whenever a capable and reliable environment can observe the claim.

A claim that the component-test environment cannot reliably observe MUST follow the environment-selection path in `COMP-176`: use a capable and reliable automated integration environment when one exists, and use recorded manual validation only when no supported automated environment can reliably observe the claim.

Semantic DOM output and behavior that a supported component-test environment can reliably observe MUST remain automated even when actual platform or assistive-technology behavior also requires integration or recorded manual evidence.

A parent test MAY own a private child's coverage only when it:

- Renders the real child.
- Exercises the child's complete contract.
- Observes the result through the supported rendered surface.

A happy-path parent render does not replace complete child coverage.

“Renders without crashing,” empty tests, and snapshots added only to execute lines are prohibited.

### COMP-169 — Tests use the supported rendered surface

A component MUST be rendered through its supported renderer or platform host.

Tests MUST interact through public user-facing or parent-facing behavior and observe:

- Rendered content.
- Programmatic semantics.
- Focus.
- Public callbacks.
- Declared effects or capabilities.
- Documented imperative operations.

Tests MUST NOT:

- Call a function component as an ordinary function.
- Invoke an internal handler directly.
- Inspect local state, hooks, or lifecycle declarations.
- Assert that a private child component was called.
- Depend on undocumented DOM nesting.
- Depend on generated class names or renderer internals.

Elements MUST be located through semantic role and name, associated label, visible text, value, or another documented state when such a locator exists.

A test-only identifier is allowed only for a necessary non-semantic observation with no contract-level locator. It MUST NOT compensate for missing semantics.

### COMP-170 — Tests cover every applicable behavioral equivalence class

Tests MUST cover every applicable row:

| Behavior              | Required coverage when present                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Inputs                | Every closed variant, valid omission, documented default, runtime boundary, child or slot form, and optional callback omission                 |
| Render states         | Initial, pending, empty, successful, failed, disabled, read-only, busy, and every closed state-model variant                                   |
| Controlled state      | Proposal accepted, proposal rejected, parent prop update, and preservation without parent acceptance                                           |
| Local state           | Initial value read once, local transition, ordinary prop update without reset, and every explicit reset mechanism                              |
| Interaction           | Every enabled action, supported input method, callback payload, count, order, timing, completion, and disabled suppression                     |
| Async work            | Pending, success, expected failure, retry, cancellation, re-entry, stale completion, out-of-order completion, optimistic rollback, and unmount |
| Lifecycle and effects | Setup, relevant input change, cleanup, remount or replay, and partial acquisition failure                                                      |
| Composition           | Valid provider/context, missing provider failure, app-state transitions, slots, and unexpected failure propagation                             |
| Identity              | Insert, remove, reorder, replace, preserve, and reset whenever identity affects state or lifecycle                                             |
| Lazy boundaries       | Inactive state, eager fallback, resolution, failure, retry, preload when present, and repeated activation                                      |
| Accessibility         | Name, role, state, relationships, keyboard model, focus, announcements, hidden/inert behavior, and modal lifecycle                             |
| Imperative API        | Every documented operation, invalid lifecycle call, result, and focus effect                                                                   |
| Responsive behavior   | Every supported viewport, text scale, theme, motion preference, and direction that can change promised behavior                                |

Tests do not need a Cartesian product of independent values. They MUST cover every independent equivalence class and every combination whose values or transitions are coupled.

### COMP-171 — The component category determines the minimum test boundary

Each category has a required test boundary:

- **Framework boundary:** uses the real external renderer or component and verifies translation, lifecycle, fallback, failure, semantics, and refs.
- **UI primitive adapter:** verifies native or approved-primitive parity, forwarding, states, keyboard behavior, accessibility, disabled behavior, and refs.
- **Composition/view:** renders the real component tree and verifies every application use-case state while substituting only declared non-UI capabilities.
- **Interactive feature:** exercises the complete state-transition model through supported user interaction.
- **Presentational component:** verifies every meaningful projection variant and semantic output without application-global setup.

A lower-level isolated test MAY supplement the category test but MUST NOT replace it.

### COMP-172 — Async and lifecycle tests control completion deterministically

When completion order affects behavior, tests MUST use controllable:

- Promises.
- Clocks.
- Schedulers.
- Subscriptions.
- Streams.
- Resource or capability fakes.

Fixed sleeps, arbitrary timing delays, and dependence on machine speed are prohibited.

Tests MUST prove that:

- Stale completion cannot change current output or announcements.
- Out-of-order completion follows the declared policy.
- Unmount settles component-owned work.
- Cleanup releases every acquired external relationship.
- Replay does not duplicate effects or resources.
- Retry creates a real new attempt.
- Cancellation cannot later appear as success.

### COMP-173 — Accessibility verification tests behavior

Accessibility verification MUST test actual component behavior rather than only the presence of an ARIA attribute.

Every custom widget MUST test:

- Its complete keyboard pattern.
- Focus entry, internal movement, and exit.
- Visible and programmatic state synchronization.
- Pointer and keyboard parity.
- Disabled behavior.

A modal dialog MUST test initial focus, containment, `Escape`, background inertness, closing, and focus restoration.

A live status MUST test its pre-existing region, exact state transition, announcement content, and absence of focus stealing.

An automated accessibility scanner MAY supplement these tests but MUST NOT replace semantic, keyboard, focus, or announcement assertions.

### COMP-174 — Test doubles preserve component boundaries

Repository child components MUST NOT be module-mocked merely to assert that they received particular props.

A child MAY be substituted only when it is:

- An explicit injected-component extension point; or
- An external framework boundary.

The substitute MUST satisfy the same complete component contract.

Domain effects MUST be substituted through declared capabilities or interfaces. An interface MUST NOT be introduced only to make mocking convenient.

Context and stores MUST use a fresh isolated owner or be reset deterministically.

Every test MUST unmount its rendered tree and leave no listener, timer, task, portal, focus state, retained resource, or mutable singleton state for another test.

Production props, branches, setters, exports, handles, or globals added only for testing are prohibited.

### COMP-175 — Snapshots are supplemental evidence

A DOM, renderer-tree, or image snapshot MUST NOT be the only assertion for component behavior, accessibility, or compatibility.

A snapshot is allowed only when the exact representation or visual output is an intentional contract. It MUST be:

- Small and narrowly scoped.
- Deterministic.
- Named after the contract it protects.
- Accompanied by explicit semantic or interaction assertions when applicable.
- Reviewed as a compatibility change when updated.

Broad snapshots of incidental markup, generated identifiers, private wrappers, or entire application trees are prohibited.

### COMP-176 — Validation uses an environment capable of observing the claim

A verification result proves only behavior that its environment implements faithfully.

A simulated renderer alone cannot prove:

- Layout or clipping.
- Focus-indicator visibility.
- Target size.
- Scrolling.
- Native text selection.
- Media-query behavior.
- Animation or reduced motion.
- Portal stacking.
- Browser or native-host integration.
- Actual assistive-technology announcements.

When a capable and reliable automated browser, native host, visual, integration, or assistive-technology environment can observe one of these claims, the verification owner MUST use that environment.

Recorded manual validation is allowed only when no supported automated environment can reliably observe the claim. The record MUST identify the exact environment, steps, expected result, observed result, and reason reliable automation is unavailable.

A simulated renderer's limitation does not waive automated component tests for semantic DOM output, keyboard-event handling, focus state, callbacks, and other behavior that it can reliably observe. Those automated tests remain required in addition to any integration or recorded manual evidence needed for actual platform or assistive-technology behavior.

Lazy import syntax alone does not prove that production output contains a separate chunk. Bundle output MUST verify code splitting when that is the claim.

### COMP-177 — Interchangeable components share one contract suite

When multiple current production components, platform adapters, or injected implementations satisfy one component contract, one unchanged behavioral contract suite MUST run against every implementation.

The suite MUST verify the complete shared contract, including:

- Props and valid states.
- Event behavior.
- State authority.
- Semantic output.
- Keyboard and focus behavior.
- Failure behavior.
- Refs and cleanup.

Implementation-specific tests MAY supplement the shared suite but MUST NOT replace it.

When an active Interface already owns the interchangeable behavior, `IFACE-032` remains authoritative.

### COMP-178 — Component-specific objective limits are mandatory

Every component MUST satisfy these auditable limits:

| Measurement                                                          | Required value |
| -------------------------------------------------------------------- | -------------: |
| Primary component category                                           |              1 |
| Primary view-tree responsibility                                     |              1 |
| Authoritative component declaration                                  |              1 |
| Props contract when the component accepts props                      |              1 |
| Props contract when the component accepts no props                   |              0 |
| Active authority per mutable UI value and instance                   |              1 |
| Semantic events represented by one handler                           |              1 |
| External relationships synchronized by one effect                    |              1 |
| Recognized interaction patterns per custom widget                    |              1 |
| Focus-management models per composite widget                         |              1 |
| Trusted rest-forwarding spreads per component                        |            0–1 |
| Integration owners per external behavioral component contract        |              1 |
| Parent-owned controls hidden outside the props contract              |              0 |
| Vendor-specific types in a feature or presentational public contract |              0 |
| Component types declared or created during rendering                 |              0 |
| Unowned asynchronous completions                                     |              0 |
| Unstable identity or reset-key sources                               |              0 |
| Positive tab indices                                                 |              0 |
| Reachable focus targets in hidden or inert content                   |              0 |
| Test-only production API members or branches                         |              0 |

This chapter deliberately defines no arbitrary maximum for:

- Props or callbacks.
- Children or slots.
- State variants.
- Renderer lifecycle declarations or effects.
- Rendered nodes or tree depth.
- Component file length.

Cohesion, complete contracts, and applicable underlying standards determine when decomposition is required.

Applicable limits remain owned by:

- `FUNC-013` for functions, handlers, callbacks, decisions, and nesting.
- `CLASS-006` for class fields, collaborators, operations, members, and executable lines.
- `OBJECT-055` for runtime object construction.
- `TYPE-013` through `TYPE-015` for generics.
- `TYPE-026` for inline object types.

Code MUST NOT create pass-through components, artificial prop groups, meaningless fragments, or empty wrappers to evade an applicable limit.

## Complete examples, SOLID mapping, and checklist

This section introduces no new requirements. It demonstrates and summarizes the approved rules.

The examples assume that referenced domain types, such as `ConversationId` and `ConversationTitle`, are compliant named types.

## Complete TypeScript/React example: controlled presentation

```tsx
import type { ReactElement } from "react"

/** Properties accepted by {@link ConversationSearchField}. */
type ConversationSearchFieldProps = {
  /** Current query owned by the parent. */
  readonly searchQuery: string

  /** Whether searching is currently unavailable. */
  readonly isSearchDisabled: boolean

  /** Receives a proposed replacement for the parent-owned query. */
  readonly onSearchQueryChange: (searchQuery: string) => void
}

/**
 * Presents a controlled field for filtering conversations.
 *
 * @remarks Primary category: presentational. The parent owns the query and
 * decides whether to accept each proposed change. The component owns no
 * mutable state, effect, resource, or ambient application dependency.
 * @param props - Parent-owned query, availability, and change proposal.
 * @returns The labeled conversation search field.
 */
function ConversationSearchField({
  searchQuery,
  isSearchDisabled,
  onSearchQueryChange
}: ConversationSearchFieldProps): ReactElement {
  return (
    <label>
      <span>Search conversations</span>
      <input
        type="search"
        value={searchQuery}
        disabled={isSearchDisabled}
        onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
      />
    </label>
  )
}
```

This example demonstrates:

- One presentational responsibility.
- One named immutable props type.
- Parent-controlled state without mirroring.
- A semantic `on<Property>Change` proposal.
- Translation of the native event inside the component.
- Native input semantics and disabled behavior.
- A persistent visible and programmatically associated label.
- No effect, local state, ref, context, or unnecessary abstraction.

## Complete TypeScript/React example: list projection and identity

```tsx
import type { ReactElement } from "react"

/** Display-ready summary of one conversation. */
type ConversationListItem = {
  /** Stable domain identity used as the rendered list key. */
  readonly conversationId: ConversationId

  /** Non-empty conversation title displayed as the control name. */
  readonly title: ConversationTitle
}

/** Properties accepted by {@link ConversationList}. */
type ConversationListProps = {
  /** Immutable conversations in their intended display order. */
  readonly conversations: readonly ConversationListItem[]

  /** Requests that the parent open the identified conversation. */
  readonly onOpenConversation: (conversationId: ConversationId) => void
}

/**
 * Presents available conversations and emits selection intent.
 *
 * @remarks Primary category: presentational. An empty collection is an
 * intentional successful state. Loading and failure remain responsibilities
 * of the parent because this contract accepts only resolved conversations.
 * @param props - Ordered conversations and the parent-owned open action.
 * @returns The conversation list or its intentional empty state.
 */
function ConversationList({
  conversations,
  onOpenConversation
}: ConversationListProps): ReactElement {
  if (conversations.length === 0) {
    return (
      <section>
        <h2>Conversations</h2>
        <p>No conversations are available.</p>
      </section>
    )
  }

  return (
    <section>
      <h2>Conversations</h2>
      <ul>
        {conversations.map((conversation) => (
          <li key={conversation.conversationId}>
            <button
              type="button"
              onClick={() => onOpenConversation(conversation.conversationId)}
            >
              {conversation.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

This example demonstrates:

- Pure projection of resolved input.
- One intentional empty-success state.
- Semantic section, heading, list, and native buttons.
- Visible text as the accessible control name.
- Stable semantic keys assigned by the iteration owner.
- Parent-owned application action.
- No array-index keys, derived state, effects, ambient stores, or hidden behavior.

## SOLID mapping

SOLID applies only through the approved concrete rules.

### Single Responsibility Principle

A component has one category and one view-tree responsibility:

- `COMP-006`
- `COMP-015`
- `COMP-031`
- `COMP-046`
- `COMP-054`
- `COMP-065`
- `COMP-092`
- `COMP-103`
- `COMP-143`

SRP does not require extracting every rendered element. Extraction requires an independent component contract under `COMP-014`.

### Open/Closed Principle

A component is open only along a currently required extension axis:

- `COMP-045`
- `COMP-078`
- `COMP-080`
- `COMP-143`
- `COMP-145`
- `COMP-177`

Closed alternatives remain exhaustive. Component injection, registries, polymorphism, and adapters MUST NOT be introduced for hypothetical consumers.

### Liskov Substitution Principle

Every interchangeable component preserves the complete observable contract:

- `COMP-025`
- `COMP-029`
- `COMP-045`
- `COMP-079`
- `COMP-162`
- `COMP-177`

Matching a props type is insufficient when rendered states, callbacks, semantics, keyboard behavior, focus, failures, refs, or cleanup differ.

### Interface Segregation Principle

A parent or consumer receives only the component surface it needs:

- `COMP-026`
- `COMP-031`
- `COMP-038`
- `COMP-041`
- `COMP-042`
- `COMP-045`
- `COMP-146`

Broad props bags, service-locator contexts, whole-store selectors, and unrestricted vendor contracts violate ISP.

### Dependency Inversion Principle

Application and domain policy do not depend on rendering or vendor mechanisms:

- `COMP-009`
- `COMP-027`
- `COMP-029`
- `COMP-093`
- `COMP-141`
- `COMP-143`
- `COMP-146`
- `COMP-150`

Composition components may connect application capabilities, but feature and presentational components receive domain-facing values and actions.

## Construction and review checklist

### Boundary and responsibility

- [ ] Is this renderer-recognized unit actually a Component construct?
- [ ] Does it have exactly one primary category?
- [ ] Can its responsibility be stated in one sentence?
- [ ] Does extraction establish an independent contract?
- [ ] Is the component named as a domain noun or UI role?
- [ ] Does every named component have complete API documentation?

### Contract and inputs

- [ ] Is there one authoritative component contract?
- [ ] Does the contract declare props, children, context, events, states, effects, semantics, refs, and failures that apply?
- [ ] Does the props type use repository data types rather than an Interface?
- [ ] Is every prop necessary, cohesive, and exactly named?
- [ ] Are defaults and absence meanings explicit?
- [ ] Does every parent-owned control appear in props?
- [ ] Are callbacks named by proposal, action, or completion semantics?
- [ ] Are children, slots, context, refs, and forwarding narrowly defined?

### State

- [ ] Does every mutable UI value have exactly one authority?
- [ ] Is the component controlled or locally owned without switching?
- [ ] Does local initialization use `initial<Property>` and occur once?
- [ ] Is derived state calculated instead of synchronized?
- [ ] Do coupled values use one closed state model?
- [ ] Are transitions atomic, named, and valid?
- [ ] Are reset and preservation behaviors intentional?

### Rendering

- [ ] Is rendering deterministic, replay-safe, and free of side effects?
- [ ] Does render read only declared inputs?
- [ ] Are renderer lifecycle declarations stable and unconditional?
- [ ] Are template expressions simple?
- [ ] Do peer rendered regions use one composition level?
- [ ] Are pending, empty, failed, disabled, and successful states distinct?
- [ ] Is null output an intentional documented state?
- [ ] Is conditional code lazily loaded only when the approved criteria apply?

### Composition and identity

- [ ] Does the parent own placement while the child owns its internals?
- [ ] Is the dependency graph directional and acyclic?
- [ ] Are component types stable and declared outside render?
- [ ] Is view identity intentionally preserved or reset?
- [ ] Does the iteration owner assign stable semantic keys?
- [ ] Are index keys limited to the complete `COMP-087` exception?
- [ ] Are portals, recursion, and compound components complete and bounded?

### Events, async work, and lifecycle

- [ ] Does each handler own one complete semantic event?
- [ ] Does user intent run in the event phase rather than through an effect?
- [ ] Is every enabled interaction complete?
- [ ] Is the re-entry policy explicit?
- [ ] Does every asynchronous completion have an owner?
- [ ] Can stale or out-of-order work affect current state?
- [ ] Does unmount settle component-owned work?
- [ ] Does each effect synchronize one external relationship?
- [ ] Are dependencies exact and cleanup complete?
- [ ] Are failures observable and retries real?

### Semantics and accessibility

- [ ] Is a native semantic control used when available?
- [ ] Does every custom widget implement one complete recognized pattern?
- [ ] Are names, roles, values, states, and relationships synchronized?
- [ ] Are visible labels included in accessible names?
- [ ] Are icons and images meaningful or explicitly decorative?
- [ ] Does every pointer interaction have keyboard parity?
- [ ] Are focus order, visibility, movement, and restoration intentional?
- [ ] Are disabled and read-only states behaviorally distinct?
- [ ] Are labels, constraints, errors, statuses, and progress exposed correctly?
- [ ] Do modal and nonmodal overlays implement their complete focus lifecycle?
- [ ] Are hidden and inert states free of reachable controls?
- [ ] Are motion, timing, target size, and sensory cues compliant?

### Framework and external boundaries

- [ ] Is every external UI dependency classified?
- [ ] Does direct use satisfy every condition in `COMP-142`?
- [ ] Is an adapter required under `COMP-143`?
- [ ] Does the adapter expose an independent repository contract?
- [ ] Are vendor props, events, errors, state, refs, and topology contained?
- [ ] Are mappings and observable defaults explicit?
- [ ] Does one owner control providers, portals, lifecycle, and imperative rendering?
- [ ] Does the integration use only supported external APIs?
- [ ] Are raw markup and renderer escape hatches isolated?
- [ ] Are execution environments and crossing values explicit?
- [ ] Is initial rendering deterministic?

### Compatibility and verification

- [ ] Has every observable contract change been classified for compatibility?
- [ ] Can previously valid consumers remain unchanged?
- [ ] Are compatibility shims external to the authoritative component?
- [ ] Are public and private rendered structures distinguished?
- [ ] Are canonical examples verified consumers?
- [ ] Does every observable behavior have a verification owner?
- [ ] Do tests use the supported rendered surface?
- [ ] Are all applicable behavioral equivalence classes covered?
- [ ] Are async order and lifecycle controlled deterministically?
- [ ] Are accessibility behaviors tested rather than inferred from attributes?
- [ ] Do test doubles preserve real component boundaries?
- [ ] Are snapshots only supplemental?
- [ ] Can the selected validation environment observe every claimed result?
- [ ] Do interchangeable implementations run one shared contract suite?
- [ ] Does the component satisfy every objective limit in `COMP-178`?

### Underlying constructs

- [ ] Does every Function construct satisfy the Function standard?
- [ ] Does every props, state, event, and result Type satisfy the Type standard?
- [ ] Does every behavioral capability satisfy the Interface standard?
- [ ] Does every actual class component satisfy the Class standard?
- [ ] Does every runtime object satisfy the Object standard?
- [ ] Do all variables, constants, and JSDoc satisfy their active standards?
