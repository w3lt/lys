# Hook

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines the construction rules for repository-owned renderer hooks.

## Definition and scope

A **hook** is a reusable callable that participates in a user-interface renderer's supported reactive execution context. It reads renderer-provided inputs or composes renderer-managed state, effects, subscriptions, references, or other hooks for one coherent purpose.

A **host** is the renderer-managed owner in whose execution context a hook runs. Calling a hook delegates logic within that context; the call does not introduce a separate view-tree node. In a positional renderer, each hook call has an identity within its host's declaration sequence.

An **invocation** computes the hook's current result. An **effect setup**, **cleanup**, **subscription notification**, and **returned action** are distinct invocations of separate callables, potentially at later phases. Declaring one is different from executing it.

A **local hook instance** denotes the renderer-managed state associated with one call in one host. A **shared owner** is a provider, store, service, or application resource that may serve several such instances. Reusing a hook declaration does not establish shared ownership.

The chapter includes repository-written hooks and repository-maintained integration with library-created hooks. It does not classify ordinary formatters, services, Git hooks, server request callbacks, plugin callbacks, or functions merely named `useSomething` as renderer hooks. Those constructs retain their actual item standards.

The normative rules are language-independent. React-specific notes describe the repository's current renderer and identify its documented invocation restrictions. Other supported renderers use their actual execution and lifetime contracts; React spelling or positional semantics are not imposed on them automatically.

## Existing rule ownership

Hook extraction delegates implementation without transferring the host's responsibilities. The following owners remain canonical; this chapter adds the contract at the reusable hook boundary.

| Concern                                                                                       | Authoritative rule or document                                                                            |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Callable category, naming, inputs, outputs, errors, and dependencies                          | `FUNC-001` through `FUNC-012` in [Function](./FUNCTION.md)                                                |
| Callable size, asynchronous completion, cleanup, callback extraction, and meaningful wrappers | `FUNC-013`, `FUNC-017` through `FUNC-021`, `FUNC-025`, `FUNC-026` in [Function](./FUNCTION.md)            |
| Renderer state versus an independent behavior owner                                           | Definition in [Class](./CLASS.md); `TYPE-011` in [Type](./TYPE.md); `OBJECT-005` in [Object](./OBJECT.md) |
| Passive records carrying callbacks versus reusable object capabilities                        | `TYPE-011` in [Type](./TYPE.md); `IFACE-001` in [Interface](./INTERFACE.md)                               |
| Consumer/provider justification and composition ownership                                     | `IFACE-003`, `IFACE-004`, `IFACE-024` in [Interface](./INTERFACE.md)                                      |
| Component category, ambient dependencies, and public contract                                 | `COMP-006` through `COMP-011`, `COMP-027`, `COMP-040` through `COMP-042` in [Component](./COMPONENT.md)   |
| State authority, initialization, transitions, and encapsulation                               | `COMP-046` through `COMP-058` in [Component](./COMPONENT.md)                                              |
| Render purity, call order, and bounded work                                                   | `COMP-059` through `COMP-063` in [Component](./COMPONENT.md)                                              |
| Re-entry, asynchronous ownership, and stale completion                                        | `COMP-095`, `COMP-097` through `COMP-101` in [Component](./COMPONENT.md)                                  |
| Effect purpose, dependencies, cleanup, replay, phase, and timing                              | `COMP-102` through `COMP-108` in [Component](./COMPONENT.md)                                              |
| Verification ownership, supported surfaces, and capable environments                          | `FUNC-024` in [Function](./FUNCTION.md); `COMP-168` through `COMP-176` in [Component](./COMPONENT.md)     |
| Cohesion, placement, exports, loading, and supported environments                             | [Module and File](./MODULE.md)                                                                            |
| Supported dependency contracts and versions                                                   | [Package and Dependency](./PACKAGE.md)                                                                    |
| Declaration documentation                                                                     | [JSDoc Standard](../JSDOC.md)                                                                             |

A Hook is not an alternative to a required Class, Interface, Component, or ordinary Function. The applicable constructs remain subject to their own limits. No special file size, callback size, global hooks directory, or one-hook-per-file policy is introduced here.

## Construction process

Before creating or changing a hook:

1. Identify the current caller, renderer context, and single reactive responsibility.
2. Establish why a hook boundary helps that responsibility under `FUNC-021` and the Module standard.
3. Classify invocation-time behavior separately from deferred callbacks.
4. Identify the host, providers, external capabilities, and actual state or resource owners.
5. Define each input's reactivity, initialization, sampling, and replacement semantics.
6. Define the current result, callable results, absence, failure, completion, and any promised identity.
7. Trace the supported declaration order and invocation phase through every composed hook.
8. Map effects and asynchronous work to their canonical Component and Function rules.
9. Check that each caller remains eligible to acquire every dependency reached through the hook.
10. Verify applicable instance, rerender, replacement, cleanup, and failure behavior through a supported renderer.

## Mandatory rules

### Boundary and classification

### HOOK-001 — The declaration has a renderer-aware responsibility

A Hook construct MUST require a supported reactive renderer context for its documented operation, directly or through another hook.

Returning data used by a view, retaining an ordinary closure, or using a hook-like filename does not satisfy this requirement. A callable that can perform its complete operation without renderer facilities MUST remain an ordinary Function unless a concrete renderer contract requires the declaration form.

### HOOK-002 — Extraction names a complete reactive concern

A hook boundary MUST expose one current reactive concern that its callers can understand independently of its internal declaration sequence.

The justification under `FUNC-021` MAY be a coherent repeated operation, required context access, external-system integration, or isolation of a substantial reactive responsibility. The number of primitive hook calls is not the justification. A wrapper such as a required-provider accessor can add a real contract even when it contains one renderer read.

### HOOK-003 — Hook naming remains a Function-owned exception

A hook's name MUST use the exact Hook exception in `FUNC-003` for its supported renderer. The exception MUST NOT spread to ordinary helpers, factories, effect callbacks, action callbacks, or imperative methods exposed beside a hook.

Names MUST identify the reactive concern or result. Generic lifecycle names such as `useMount`, `useOnce`, and `useEffectOnce` MUST NOT disguise the actual relationship, its reactive inputs, or its replay behavior.

### HOOK-004 — Classify the hook and its callbacks separately

A hook MUST apply `FUNC-002` to what occurs during its renderer invocation. Reading an approved current value can be a query; coordinating supported declarations and focused collaborators can be an orchestrator. A hook does not qualify for the Component-only declarative view projection category.

Returned actions, effect setup, cleanup, selectors, and notification callbacks MUST be assessed as separate Function constructs. A later command does not turn an otherwise pure render-time declaration into permission to execute that command during rendering.

### HOOK-005 — Hook extraction preserves construct boundaries

The renderer ownership distinction in the Class definition MUST be applied to both a hook declaration and any object or closure it creates.

A hook MAY expose a passive current-result record containing callback values under `TYPE-011` and `IFACE-001`. Calling a retained controller or service a hook result MUST NOT bypass the Class or Interface rules. A hook that bridges to such an owner retains that owner's construction, injection, and disposal contract.

### Invocation and composition

### HOOK-006 — Invocation requires a supported host and phase

Each hook call MUST occur in a host and phase supported by the renderer, including calls made through another custom hook. An ordinary event handler, asynchronous continuation, test body, class method, or effect callback MUST NOT invoke a hook unless the renderer explicitly provides that execution context there.

React custom hooks run during function-component or custom-hook execution. They are not callable as ordinary services. See React's [Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks).

### HOOK-007 — Composition preserves declaration order contracts

Every composed hook MUST preserve `COMP-062` across all of its caller's valid paths. An optional input or disabled operation MUST NOT conditionally skip a positional hook call.

The supported choices are a stable declaration with conditional behavior inside its operation, or a separate renderer-owned child whose lifetime represents that condition. A documented exception for a particular renderer API does not confer the same exception on a custom hook wrapping it.

React's `use` API permits conditional and iterative calls while retaining component/hook context restrictions and prohibiting `try`/`catch` wrapping. This API-specific permission does not apply to `useSettingsContext()` or another custom hook merely because it delegates to `use`. See the [`use` reference](https://react.dev/reference/react/use).

### HOOK-008 — Hook implementations are statically composed

A renderer requiring static hook composition MUST NOT receive hook implementations through runtime-selected props, mutable registries, higher-order wrapping, or branches that change the hook graph.

Vary data or ordinary capabilities consumed by a statically declared hook. When a different hook graph is required, select an eligible component boundary. React documents this restriction in [React calls Components and Hooks](https://react.dev/reference/rules/react-calls-components-and-hooks).

### HOOK-009 — Library-created hooks retain separate surfaces

Integration with a library-created callable hook MUST distinguish its renderer invocation surface from any documented ordinary factory, reader, action, or disposal surface.

A store factory is classified by the operation that creates the store. Calling the resulting bound hook follows renderer restrictions; calling its documented imperative reader follows that reader's Function and ownership contracts. Possessing an imperative surface does not permit imperative hook invocation.

A created binding MUST have an explicit owner and stable placement for its supported lifetime. Library creation APIs are not permission to recreate the hook graph during every render or pass hooks dynamically where the renderer forbids it.

### HOOK-010 — Dependencies remain visible at the caller boundary

A hook's required context, store, service, and environment MUST be included when assessing the caller against `COMP-006` through `COMP-011` and `COMP-040` through `COMP-042`.

An extracted hook MUST NOT let a presentational or feature component indirectly acquire an ambient dependency that the component could not acquire directly. The permitted composition owner supplies the required values or narrow capabilities according to the existing component contract.

### Inputs and results

### HOOK-011 — Inputs declare their temporal meaning

Each input whose interpretation changes behavior over time MUST be identified as reactive, initialization-only, sampled at an action or other specified event, or an explicitly stable dependency.

The contract MUST state what replacement does: recompute a result, resynchronize a relationship, begin a distinct operation, reset through an explicit identity, or leave existing state unchanged. One options object does not make all its fields share the same temporal meaning.

### HOOK-012 — Extraction preserves controlled and initial inputs

A hook accepting current controlled values or initial values MUST preserve the owner's state model under `COMP-047` through `COMP-050` and `COMP-057`.

Its boundary MUST make the difference observable in names and documentation. Extracting state management MUST NOT turn a parent's current value into a one-time seed or turn an initial seed into an ongoing reset signal.

### HOOK-013 — Function-valued inputs have explicit semantics

A callback or reader parameter MUST identify whether it is a reactive collaborator, a notification target, a current-state reader, or an operation to invoke at a defined event.

Where behavior depends on freshness, the contract MUST distinguish a value captured from the relevant render from a value read when the callback executes. A callback's identity and its current behavior are separate questions; neither may silently substitute for the other.

### HOOK-014 — Provider access exposes its precondition

A hook reading a provider MUST identify the required provider scope and the observable outcome when that provider is absent.

Required context MUST NOT silently become an unrelated singleton, newly created store, no-op action, or fabricated successful result. An optional-provider hook MAY return documented absence when callers genuinely support that case. The hook does not own the provider merely because it reads it.

### HOOK-015 — The result is the caller's cohesive contract

A hook's current result MUST contain only the information and callable values needed for its single reactive concern, using the result-shape rules of Function, Type, and Object.

It MUST NOT expose its internal declaration order, an unrelated store surface, or private resource bookkeeping as a convenience bundle. Primitive values, a cohesive tuple, a passive result record, or no value can each be appropriate; a record is not mandatory.

### HOOK-016 — Current results expose freshness and observation

A result that can lag behind its authority MUST define the relevant observation boundary: renderer updates, external notifications, a polling cadence, or a completed operation.

Where callers can observe the distinction, the contract MUST distinguish initial, unavailable, stale, pending, failed, and current information using the existing Type rules. Units and timing limits remain part of the Function and Component contracts. A sampled uptime value MUST NOT be described as a continuously current clock.

### HOOK-017 — Activation-only hooks expose their relationship

A hook returning no value MUST still define the external relationship it establishes, the inputs controlling it, and the actual lifetime owner.

Its contract MUST allow a caller to distinguish subscribing or synchronizing from completing a business operation. The absence of a returned value MUST NOT hide persistence, analytics, or application commands behind an unspecified lifecycle callback.

### HOOK-018 — Returned actions describe the completed outcome

Each returned action MUST define its eligible invocation phase, arguments, observed state, and completion or failure outcome under the Function standard.

The result contract MUST distinguish proposing a state change, scheduling owned work, and completing that work. Where actions can overlap, the declared re-entry policy under `COMP-095` belongs in this contract. A hook MUST NOT advertise a durable save when its callback only proposes a local edit.

### HOOK-019 — Identity guarantees identify their lifetime

When a consumer depends on result or callback identity, the hook contract MUST specify which identity is supported, across which updates, and when replacement is permitted.

An unchanged domain value, an unchanged result object, and an unchanged action function are different guarantees. Memoizing one callback does not promise stability for the whole result. Correctness MUST NOT depend on a discardable optimization cache preserving an identity beyond the renderer's guarantee; React explains this limitation in the [`useMemo` reference](https://react.dev/reference/react/useMemo).

### State and lifetime

### HOOK-020 — Local instances do not imply shared state

A hook owning renderer-managed local state MUST associate that state with its actual host and call identity. Distinct local hook instances MUST remain independent unless they intentionally observe or delegate to a documented shared owner. Repeated invocations of the same instance preserve its state until an authorized reset or the end of its lifetime.

Sharing a declaration, module, or parameter value does not establish that owner. React's [custom-hook guide](https://react.dev/learn/reusing-logic-with-custom-hooks) distinguishes reusable stateful logic from shared state.

### HOOK-021 — Observation does not transfer resource ownership

A hook observing shared state MUST identify what belongs to the observer and what belongs to the shared owner.

Cleanup is assessed against that distinction under `COMP-100` and `COMP-105`. Releasing one subscription MUST NOT end application-owned work unless the shared owner's documented acquisition/release protocol makes it responsible for that transition. A hook observing a model transition does not acquire ownership of the model's timer or request.

### HOOK-022 — Reset is tied to an explicit owner transition

A hook with resettable local state MUST define the input, action, or host identity change that represents a new logical instance under `COMP-057` and the component identity rules.

The contract MUST cover relevant pending work and retained callbacks when that transition occurs. An arbitrary rerender, changed object allocation, or updated initial value MUST NOT silently become the reset authority.

### HOOK-023 — Returned state preserves the owner's authority

The encapsulation requirements of `COMP-058` MUST hold across the hook's result boundary. A consumer must be able to distinguish an observed value from a request to its authority to change that value.

A hook MUST NOT circumvent the host's contract by publishing a raw renderer setter, writable store alias, or unrestricted mutation function under a different name. A domain-specific action remains subject to its actual owner's permissions and transition rules.

### Effects, work, and external relationships

### HOOK-024 — Render restrictions apply through every helper

Every operation executed while computing a hook result MUST be assessed under `COMP-059` through `COMP-063`, including initializers, selectors, ordinary helpers, and composed hooks.

A lazy initializer or memoization callback is still part of render-time execution. Moving a clock read, storage access, resource acquisition, or side effect into a custom hook does not give it a different execution phase. Supported renderer observation APIs retain their declared contracts.

### HOOK-025 — Effect extraction preserves the actual relationship

A hook wrapping effects MUST expose enough semantic inputs to identify the external relationship governed by `COMP-102` through `COMP-108`.

It MUST NOT replace that relationship with an arbitrary callback plus a caller-maintained dependency list, or promise a universal mount/update/once schedule disconnected from the renderer's lifecycle. A focused hook accepts the inputs of its relationship and owns their interpretation. Extraction does not require a separate custom hook for every effect.

### HOOK-026 — Setup returns the renderer's supported protocol

A hook registering setup or cleanup MUST satisfy the renderer's actual return and invocation protocol. Deferred asynchronous work requires the separate completion owner defined by `FUNC-017`; registration itself cannot silently return an unsupported task instead of the expected cleanup value.

For React, effect setup returns a cleanup function or no value, rather than an `async` function's Promise. See the [`useEffect` reference](https://react.dev/reference/react/useEffect). Any cleanup or later release that cannot complete synchronously needs an explicit owner for its remaining work.

### HOOK-027 — Replacement identifies the obsolete relationship

A hook that resynchronizes after an input or host change MUST distinguish the old subscription, resource, or operation from its replacement.

Its lifecycle contract MUST let `COMP-099`, `COMP-104`, and `COMP-105` be verified against the correct instance. Reading a mutable current handle during old cleanup MUST NOT accidentally dispose the replacement. The same distinction applies when an acquisition completes after its original setup has ended.

### HOOK-028 — Async work retains authority to publish separately

For work exposed or initiated by a hook, the asynchronous ownership contract MUST identify both who can request cancellation and which operation or instance can still publish a result.

This distinction applies the stale-completion requirements of `COMP-097` through `COMP-100` at the hook boundary. It covers delayed success, rejection, notifications, and resources acquired after invalidation. A cancellation request alone is not evidence that a later completion belongs to the current caller.

### HOOK-029 — Replay is part of the public lifecycle contract

A hook's supported lifecycle MUST include the renderer's restart, abandoned-render, and setup/cleanup behavior where applicable. Its API MUST NOT require callers to assume exactly one render, setup, notification, or mount during the logical concern.

`COMP-106` remains the canonical setup/cleanup rule. A per-instance flag or module singleton that suppresses required re-establishment is not a valid way to fulfill a once-named hook contract. React describes its development replay in the [`useEffect` reference](https://react.dev/reference/react/useEffect).

### HOOK-030 — Notifications retain their phase restrictions

A hook using a renderer's non-reactive notification facility MUST preserve its permitted call sites, enclosing ownership, and freshness semantics. Such a facility MUST NOT be exposed as an unrestricted ordinary action or used to suppress a reactive relationship's true dependencies.

React Effect Events are callable from effects or other Effect Events and must not be passed to other components or hooks. They do not promise stable function identity. See [`useEffectEvent`](https://react.dev/reference/react/useEffectEvent). Ordinary event callbacks keep their own Function contracts.

### HOOK-031 — External stores use a coherent observation protocol

A hook observing externally mutable state MUST use a supported renderer/library integration that preserves agreement between reading the current value and subscribing to changes.

A manual read-then-effect subscription MUST NOT be substituted when it can miss an intervening change or expose incompatible snapshots during rendering. In React, the relevant primitive is [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore), directly or through a library that implements the protocol. This does not require wrapping every store hook.

### HOOK-032 — Snapshot and selector contracts preserve observable changes

A store hook MUST honor the observation protocol's snapshot and comparison requirements. Selectors and equality policies MUST preserve every distinction the consumer uses while avoiding fabricated changes from unchanged source data.

For React external-store snapshots, unchanged state requires an unchanged returned value; changed mutable source data requires a corresponding immutable snapshot. See [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore). Consumer-specific selection remains narrow under the Component contract; a broad subscription is not justified by placing it inside a hook.

### HOOK-033 — Server and client observation agree when supported

A hook advertised for server rendering or hydration MUST define its available providers, initial observations, and transition to live client state under the existing environment and rendering rules.

For React external stores, the server snapshot must agree with the initial hydration snapshot. See [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore). A hook with a client-only contract need not invent server behavior; that restriction must be explicit and respected by its consumers and module imports.

### HOOK-034 — References have a declared non-reactive purpose

A hook using or returning a mutable renderer reference MUST identify whether it denotes a committed host, owned bookkeeping, or another supported non-reactive value, and who can update it.

A change that affects visible output MUST reach the renderer through the authoritative state or observation contract. A ref MUST NOT become a hidden alternate state channel, a dependency-suppression mechanism, or permission to use a host before its supported phase.

### HOOK-035 — Host bindings preserve attachment and replacement

A hook returning a host ref, attachment callback, or binding MUST define the supported target and the behavior when that target becomes available, changes, or detaches.

The binding MUST preserve renderer-required notifications and the ownership of any caller-provided binding it composes. A stored target MUST NOT be assumed to be permanently mounted. Disposal and listener removal are checked against the target actually acquired under `COMP-105`.

### HOOK-036 — Imperative resources retain an independent owner contract

A hook bridging to a controller, native handle, or service MUST distinguish observing, borrowing, acquiring, and owning that resource.

It MUST define how the bridge handles unavailable resources and owner replacement. The actual Class, Interface, and Function lifecycle requirements remain in force; a hook result does not extend an owner's lifetime or authorize use after release. A resource intended to outlive the host requires an owner whose contract supports that lifetime.

### Publication and verification

### HOOK-037 — Placement follows the concern's real consumers

A hook's module placement and export surface MUST follow `MODULE-003` through `MODULE-013` for its actual concern and consumers.

Using renderer primitives alone does not justify a shared package, application-wide hooks directory, or public export. Ordinary calculations extracted from a hook retain their own module and Function classification. A helper need not acquire a hook name or runtime dependency merely because its first consumer is a hook.

### HOOK-038 — Changes preserve the temporal public contract

Compatibility review of a public hook MUST include required providers, reactive versus initial inputs, observation timing, action completion, identity guarantees, resource ownership, and supported environments.

A structurally unchanged result type does not prove compatibility when those guarantees change. Moving work from a shared owner to each observing instance, changing a proposal into persistence, or changing when an input takes effect requires corresponding consumer review under the existing compatibility workflow.

### HOOK-039 — Documentation covers invocation and later behavior

The API documentation required by `FUNC-023` and the JSDoc standard MUST distinguish current-result computation from any later actions or lifecycle work the hook exposes.

Document the relevant host/provider preconditions, input timing, state and resource owners, result freshness, failure paths, cleanup, and promised identity where they are not evident from the signature. Do not describe an asynchronous action as having completed when the hook merely returns its callback.

### HOOK-040 — Tests invoke hooks through a supported renderer

Hook behavior requiring renderer context MUST be verified through a real supported host, whether a focused harness or the consuming component. Direct invocation as an ordinary function cannot establish the hook's lifecycle contract.

`FUNC-024` and `COMP-168` through `COMP-176` determine required coverage and environments. A public reusable hook can have focused contract tests; a private extraction can be covered through its consumer. Tests MUST NOT depend on private declaration order or expose a hook publicly solely to inspect it.

### HOOK-041 — Verification distinguishes local and shared lifetimes

Where the hook's contract includes state or resources, verification MUST exercise the applicable boundaries between first observation, rerender, input replacement, reset, and host removal.

Multiple-instance checks MUST demonstrate the declared isolation or sharing. When observers borrow application-owned work, removing an observer MUST be verified without silently transferring or ending that work. These cases refine the behavioral classes required by `COMP-170`; they do not require irrelevant lifecycle tests for a pure provider accessor.

### HOOK-042 — Deferred work is verified at ownership boundaries

Where a hook exposes deferred work, the deterministic tests required by `COMP-172` MUST include applicable late success, rejection, overlapping operations, cancellation, cleanup, and replacement cases.

The assertion is the observable result or resource outcome for the correct owner. A mock reporting that an abort function was called does not establish that stale completion cannot publish. Missing providers and unavailable host capabilities need coverage when they belong to the hook's contract.

### HOOK-043 — Tooling validates the supported hook form

Repository-owned hooks and their callers MUST remain recognizable to the configured renderer-specific static checks. Adding a custom effect-like registration API requires verifying that its callbacks and dependencies remain analyzable by the supported tooling.

Lint success does not establish lifetime, race, host, or browser behavior. Type, lint, renderer, and real-host checks MUST be selected according to what each can observe under `COMP-176`; required checks MUST NOT be disabled to accommodate a hook abstraction.

### HOOK-044 — Extraction preserves the consumer's integration coverage

Moving behavior into a hook MUST preserve the verification of its complete consumer-visible outcome, including component interactions and any applicable accessibility behavior.

Focused hook tests MAY replace duplicated internal checks when they prove the same contract, but they do not replace required component or real-host evidence. A successful hook harness does not prove focus movement, clipboard permission behavior, native integration, or the final rendered semantics.

## Boundary examples

These examples illustrate classification and contract review; they do not assert that the existing implementations satisfy every rule in this chapter.

| Repository pattern                               | Hook boundary                                              | Ownership consequence                                                              |
| ------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `useSettingsContext` reads the settings provider | Query with a required-provider precondition                | Provider owns settings; returned actions retain their proposal/completion contract |
| `useBackendUptimeMs` observes sampled uptime     | Reactive orchestration with a documented sampling interval | Its observation timer is local; the backend runtime is not                         |
| `useTheme` returns a value and an action         | Current snapshot and later action are separate contracts   | Stable action identity, if promised, does not imply stable result-object identity  |
| `useLysStore` is a library-created bound hook    | Hook invocation plus separate imperative store operations  | Observer removal does not own the store's model-transition work                    |
| `createChatViewStore` creates a bound store      | Ordinary factory providing a renderer integration surface  | Factory-selected instance owns its operation tokens and abort resources            |
| `backendStatusLabel` formats display text        | Ordinary Function                                          | Rendering use alone does not create a Hook construct                               |
| A server `onClose` callback                      | Ordinary lifecycle callback                                | Server lifecycle rules apply; renderer hook call order does not                    |

The source patterns are in [settings context](../../apps/desktop/src/components/SettingsViewComponents/SettingsContext.ts), [uptime helpers](../../apps/desktop/src/lib/hooks/backendRuntime.ts), [theme](../../apps/desktop/src/app/theme.ts), [application store](../../apps/desktop/src/lib/store/index.ts), [chat store](../../apps/desktop/src/lib/store/chat-view/index.ts), and [server lifecycle composition](../../apps/backend/src/di/fastify.ts).

## Review criteria and SOLID application

Review the concrete concern, caller, result, and owner. The hook's line count or number of primitive hooks does not establish cohesion; the underlying Function limits still apply.

| Principle | Observable review question                                                                                                        | Governing rules                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| SRP       | Does one hook expose one reactive concern and preserve separate invocation phases?                                                | `HOOK-002`, `HOOK-004`, `FUNC-001`, `FUNC-025`   |
| OCP       | Is a current variation represented by ordinary data or an eligible capability without dynamically replacing hook implementations? | `HOOK-008`, `HOOK-010`, `IFACE-003`              |
| LSP       | Do callers receive the documented timing, identity, failure, and ownership guarantees?                                            | `HOOK-011`, `HOOK-018`, `HOOK-019`, `HOOK-038`   |
| ISP       | Does each consumer receive only its required result and ordinary capabilities?                                                    | `HOOK-015`, `HOOK-032`, `IFACE-003`, `IFACE-004` |
| DIP       | Does the permitted composition owner select dependencies without hiding application access in a lower-level component?            | `HOOK-010`, `HOOK-036`, `IFACE-024`              |

These are applications of existing boundaries. No interface, strategy, adapter, or hook factory is justified solely by the principle's name.

## Review checklist

- [ ] The declaration actually requires renderer context and has one current reactive purpose.
- [ ] Function categories, naming, limits, and callback contracts remain applicable.
- [ ] Call sites and composition satisfy the supported renderer protocol.
- [ ] Inputs distinguish reactive, initial, stable, and event-sampled meanings.
- [ ] Providers, ambient dependencies, and caller eligibility are explicit.
- [ ] Results describe freshness, absence, failure, actions, and any identity guarantees.
- [ ] Local state, shared work, references, resources, and reset each have the correct owner.
- [ ] Effects and asynchronous work preserve the canonical dependency, cleanup, and stale-result rules.
- [ ] Store observation, host attachment, and supported environments have complete contracts.
- [ ] Documentation and tests cover the applicable temporal and lifetime boundaries.
- [ ] Consumer integration coverage remains sufficient for the claimed behavior.
