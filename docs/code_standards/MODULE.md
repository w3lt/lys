# Module and File

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines the construction rules for repository-owned modules and source files.

## Definition and scope

A **source file** is a repository-maintained unit of source text consumed by a compiler, interpreter, renderer, build tool, or other declared loader.

A **language module** is a unit with language-defined names, visibility, dependencies, and, where applicable, evaluation behavior. A language module may occupy one file, several files, or a declaration within a file.

A **logical module** is a cohesive repository boundary that owns one responsibility and exposes a deliberate surface to consumers. It may contain several language modules and supporting files. A directory is not automatically a logical module, and a package is not automatically one logical module.

A **public surface** is the set of declarations, import paths, entry points, assets, and observable loading behavior supported for a stated consumer group. Public is relative to the boundary: a declaration can be accessible inside one application without being a supported package export.

A **facade** exposes a selected surface from underlying modules without implementing their independent policies. A barrel is a facade implemented primarily through re-exports. An `index` filename does not by itself make a module a facade.

An **executable entry point** is deliberately launched by a runtime, framework, test runner, or tool. A **composition root** is the part of that startup flow that selects and wires concrete collaborators. A reusable module may export a composition operation without executing it during import.

This chapter governs module ownership, source organization, visibility, imports, re-exports, dependency direction, loading, and changes to those boundaries. It applies to application and library modules, scripts, test modules, declarations, framework entry files, and repository-maintained tooling.

Package distribution and dependency selection are governed by [Package and Dependency](./PACKAGE.md). API interaction contracts are governed by [API](./API.md). Resource ownership and release are governed by [Resource](./RESOURCE.md). Schema contracts and migrations are governed by [Schema and Migration](./SCHEMA.md). A module containing those constructs still follows applicable active standards and [Contributing to Lys](../../CONTRIBUTING.md).

## Existing rule ownership

This chapter adds module-level requirements. It does not redefine the following rules:

| Concern                                                                        | Authoritative rule or document                                                                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Callable dependencies, effects, completion, cleanup, and meaningful extraction | `FUNC-011`, `FUNC-012`, `FUNC-017`, `FUNC-018`, `FUNC-020`, `FUNC-021` in [Function](./FUNCTION.md)                     |
| Callable and class size or complexity                                          | `FUNC-013` in [Function](./FUNCTION.md); `CLASS-006` in [Class](./CLASS.md)                                             |
| Capability eligibility, ownership, injection, and extension                    | `IFACE-003`, `IFACE-004`, `IFACE-024`, `IFACE-025` in [Interface](./INTERFACE.md)                                       |
| Complete class and interface declarations                                      | `CLASS-007` in [Class](./CLASS.md); `IFACE-029` in [Interface](./INTERFACE.md)                                          |
| Stateful instances, construction, and application-scoped lifetimes             | `CLASS-001`, `CLASS-008`, `CLASS-010`, `CLASS-011`, `CLASS-032` in [Class](./CLASS.md)                                  |
| Binding scope, shared values, and constant initialization                      | `VAR-003` in [Variable](./VARIABLE.md); `CONST-002`, `CONST-005`, `CONST-007`, `CONST-008` in [Constant](./CONSTANT.md) |
| Data contracts and mechanism-independent domain types                          | `TYPE-008`, `TYPE-009`, `TYPE-024`, `TYPE-026` in [Type](./TYPE.md)                                                     |
| Object ownership and stateless providers                                       | `OBJECT-005`, `OBJECT-013` through `OBJECT-017`, `OBJECT-047` through `OBJECT-054` in [Object](./OBJECT.md)             |
| Component extraction, identity, dependencies, and execution environments       | `COMP-014`, `COMP-016`, `COMP-076`, `COMP-158`, `COMP-178` in [Component](./COMPONENT.md)                               |
| Declaration comments, tags, and unchanged re-exports                           | [JSDoc Standard](../JSDOC.md)                                                                                           |

Rules referenced here retain their existing triggers and permitted cases. A module wrapper does not waive them or make them apply to an otherwise unrelated construct.

## Construction process

Before creating or changing a module or file:

1. Identify its language-module and logical-module boundaries.
2. State its responsibility, owner, current consumers, and supported execution environments.
3. Locate the authoritative contracts and existing supported import paths.
4. Identify private declarations, exports, re-exports, and externally required entry points.
5. Trace runtime, type-only, dynamic, generated, and asset dependencies relevant to the change.
6. Check dependency direction and cycles at both language-module and logical-module boundaries.
7. Separate import evaluation from explicit startup and instance lifetimes.
8. Select the smallest cohesive file placement and surface that meets the current requirement.
9. Identify changes to resolution, loading, compatibility, and consumer assumptions.
10. Validate the affected boundaries and their actual consumers.

No prescribed directory tree, filename suffix, framework, or number of layers follows from this process.

## Mandatory rules

### Boundary and cohesion

### MODULE-001 — A module has one named responsibility

A logical module MUST own one domain concept, application operation, boundary adaptation, cohesive presentation concern, composition responsibility, or development operation.

Its responsibility MUST be expressible without listing unrelated features. Every contained source file and exposed declaration MUST support that responsibility.

Sharing a language, framework, author, primitive type, or current caller does not establish module cohesion.

### MODULE-002 — Boundaries are established by use, not directory names

For a changed logical module, the owner, allowed consumer group, and supported entry paths MUST be identifiable from language visibility, existing export configuration, declarations, and authoritative documentation.

A directory or `index` file MUST NOT be treated as proof of a public boundary. Where the implementation and documented boundary disagree, the change MUST resolve the affected disagreement without silently widening access.

A new boundary needs additional documentation only when names and existing declarations cannot express these facts. A separate README or manifest is not required for every file.

### MODULE-003 — Extraction requires a current boundary

A new logical module MUST be justified by at least one current condition:

- An independently consumed domain or application contract.
- A distinct external mechanism or execution environment that needs isolation.
- An independent ownership, lifecycle, trust, or initialization boundary.
- A coherent responsibility whose dependencies or reasons to change differ from its current owner.
- A language, framework, runtime, or tool entry-point requirement.

File length, anticipated reuse, naming symmetry, or a desire to add another layer is insufficient by itself. A supporting private file MAY be extracted to make one existing responsibility understandable without inventing a new public module.

### MODULE-004 — Each source file has a coherent owner

Every source file MUST belong to one logical module or one explicit composition boundary between modules.

Declarations may share a file when they implement the same responsibility or are private support for it. Multiple functions, related value types, a class with its implementation blocks, or a cohesive component family do not require separate files merely because they are separate declarations.

A file MUST be split when it implements independently consumed responsibilities with different domain owners, external mechanisms, execution environments, or lifecycle authorities. A composition file MAY reference those responsibilities to connect them, but MUST NOT implement their separate policies.

### MODULE-005 — Shared code retains a domain owner

Code MAY move to a shared module only when its consumers require the same semantics and compatibility contract.

The shared module MUST have an identifiable owner and a name that expresses the shared concept. `utils`, `helpers`, `common`, `shared`, `types`, or `services` alone does not establish that owner.

An existing organizational directory may retain such a name when its contained modules have precise responsibilities. Moving unrelated declarations into a common directory MUST NOT be used to conceal cycles or forbidden dependencies.

### MODULE-006 — Physical separation preserves semantic declarations

Splitting a file MUST preserve complete authoritative declarations under `CLASS-007`, `IFACE-029`, and `COMP-016` where applicable.

A split MUST NOT scatter one construct across partial declarations, attach behavior from another module, or separate tightly coupled private implementation fragments merely to reduce line counts.

Language-defined nested modules and implementation blocks MAY remain together when their ownership and visibility are explicit. Namespace containment is distinct from a dependency between independently owned modules.

### MODULE-007 — Production ownership does not move into verification code

A production module MUST NOT import a test case, fixture, test setup file, benchmark harness, or development-only executable to obtain production behavior or a production contract.

When production and verification need the same real behavior, its authority MUST remain in production code. Reusable test support may depend on that supported contract and remains owned by the verification boundary.

A language- or tool-supported test-only section MAY remain in the source file of the production module it verifies. The file retains its production owner, while the nested section has a verification-only scope. The supported language or build contract MUST exclude that section's test execution and test-only runtime dependencies from production. This placement MUST NOT add public production exports and does not waive applicable construct or verification requirements.

### Public surface and re-exports

### MODULE-008 — Every export has an identified consumer

An exported declaration or public path MUST serve a current consumer permitted by the module's declared production, tooling, or verification role, an approved public contract, an externally required entry point, or an existing compatibility obligation.

Tooling and verification modules MAY export support used by their current consumers, including build configuration and maintenance scripts. A private production helper MUST NOT become public solely to let a test invoke it.

Visibility MUST be the narrowest supported by the language and required consumer group. Where file-level export syntax also enables private cross-file use, the logical boundary still governs who may import it.

### MODULE-009 — Consumers enter through the supported surface

A consumer outside a logical module MUST use an entry path supported for that consumer group.

Code MUST NOT bypass the boundary through a private source path, relative traversal into another package, a build-output path, a copied declaration, or a resolver alias that exposes internals.

Members of the same logical module MAY import private implementation files directly. A single-file module may expose its declaration file as its supported surface; a barrel is not mandatory.

### MODULE-010 — A facade selects a contract

A facade MUST expose a deliberate set of declarations belonging to one supported boundary. It MUST NOT collect everything reachable merely to shorten consumer imports.

A facade MAY preserve existing compatibility paths or provide separate supported subpaths for different consumers. Each such surface MUST have an explicit purpose and obey the same ownership and dependency rules as a direct import.

An implementation file named `index` may implement a cohesive operation. Its filename does not require conversion into a re-export-only file.

### MODULE-011 — Re-exports name the supported declarations

Repository-maintained public facades MUST explicitly select the names they re-export. Adding an internal export MUST NOT silently expand an enclosing public surface.

Wildcard forwarding of all present and future exports is prohibited for a repository-owned public facade. A private aggregation module MAY use wildcard forwarding only when its entire source surface is intentionally shared by the same internal consumers and it introduces no ambiguity or cycle.

Generated output remains outside direct source-maintenance scope. A maintained generator or adapter MUST still ensure that the resulting supported surface is deliberate.

### MODULE-012 — A forwarded declaration retains its authority

A re-export MUST preserve the original declaration's type, runtime identity, behavior, ownership, and documentation authority.

Forwarding MUST NOT clone the value, construct another instance, widen or narrow its type through an assertion, or wrap it with hidden behavior. A changed contract requires a separately named adapter governed by its applicable construct standards.

Renaming on export is permitted when the alias has one documented boundary meaning or preserves compatibility. Multiple aliases for the same audience require a concrete compatibility need.

### MODULE-013 — Public signatures are usable by their consumers

Every type, capability, generic constraint, and value needed to use an exported declaration MUST be accessible to its intended consumers through the supported surface or the language's supported inference and opacity mechanisms.

Public signatures MUST NOT force consumers to import private files or vendor internals. An intentionally opaque value MAY keep its representation private when consumers can obtain and use it entirely through its supported operations.

`TYPE-024` owns domain/mechanism separation; making a mechanism type importable does not make it an appropriate domain contract.

### MODULE-014 — Export names remain unambiguous

One supported entry point MUST NOT expose competing declarations under the same name or rely on re-export order to select a winner.

An exported alias MUST preserve domain terminology and make the distinction between genuinely different concepts apparent. Consumer-side renaming MUST NOT conceal a collision that belongs to the public contract.

Named exports SHOULD be used when consumers select among several independently named declarations. A default export MAY express one principal declaration or satisfy an existing language, framework, or repository contract; its implementation still follows its construct's naming rules.

### MODULE-015 — Internal access does not imply external support

Language-visible declarations used only between implementation files MUST NOT be advertised as supported external APIs or automatically forwarded through a public facade.

Where visibility cannot be enforced by the language, the boundary MUST remain identifiable through supported entry paths and documented internal ownership. Underscore names or an `internal` directory alone are not an access-control mechanism.

### Dependencies and resolution

### MODULE-016 — Dependency analysis includes indirect edges

For dependency analysis, an edge exists when one module requires another through an import, re-export, include, type reference, dynamic load, generated registration, or equivalent supported loading mechanism.

The analysis MUST distinguish:

- Runtime loading and evaluation edges.
- Compile-time or type-only edges.
- Logical-module ownership edges across a supported boundary.
- Asset or declaration dependencies relevant to the target environment.

A namespace declaration that contains a child module is not by itself a reverse consumer dependency. Language-defined type recursion or lexical parent-name lookup is not by itself an import-evaluation cycle.

### MODULE-017 — Runtime module loading is acyclic

Repository-owned runtime module dependencies MUST form an acyclic graph after aliases, re-exports, and dynamic loads are resolved.

Code MUST NOT rely on partial initialization, import order, lazy access, loader caching, or a dynamic import to make a runtime cycle appear safe.

Recursive domain behavior MAY remain inside one cohesive module with the applicable termination and ownership contracts. `COMP-076` owns permitted recursive rendering; it does not authorize a cycle between runtime modules.

### MODULE-018 — Type-only dependencies preserve ownership direction

Erasing a dependency from runtime output MUST NOT authorize an otherwise forbidden logical-module dependency.

Type-only cycles between independently owned logical modules MUST be resolved by correcting contract ownership, extracting a justified shared value contract, or combining a falsely divided responsibility.

Mutually recursive types within one logical module MAY reference one another when the language permits it and no runtime cycle is introduced. They remain governed by the Type chapter.

### MODULE-019 — Internal files do not import their own facade

An implementation file MUST NOT import its own enclosing facade when that facade directly or indirectly re-exports the implementation file.

Internal collaborators MUST be imported from their authoritative private modules. Public facades are for their intended external consumers and MUST NOT become a path back through the module's own public surface.

### MODULE-020 — Imports preserve the architecture's direction

Every cross-module dependency MUST follow the existing domain, application, adapter, and composition boundaries relevant to the operation.

A lower-level implementation MUST NOT import an application entry point or its consumer to discover behavior it should receive through an explicit contract. Application policy MUST NOT acquire a mechanism dependency merely by importing it through a neutral-looking facade.

Capability ownership and composition remain governed by `IFACE-004` and `IFACE-024`; domain type boundaries remain governed by `TYPE-024`. These rules do not require a new layer where no such boundary is needed.

### MODULE-021 — Contract placement breaks coupling at its source

When a dependency problem arises from contract placement, the contract MUST be located with its semantic owner rather than whichever file is easiest to import.

Behavioral contract placement follows `IFACE-004`. Shared value contracts MUST belong to the domain or boundary whose meaning they describe, with one authority under the Type chapter.

A contract module MUST NOT import concrete providers or executable startup merely to define its public declarations. A type moved to a neutral directory still violates ownership if it embeds a consumer's private implementation types.

### MODULE-022 — Module boundaries do not justify speculative abstraction

Breaking a dependency edge MUST NOT introduce an unused interface, pass-through service, global registry, event bus, callback chain, or generic container without its own current contract.

Apply `IFACE-003` when a behavioral abstraction is needed and `FUNC-021` when introducing a wrapper. A direct import of a cohesive pure operation or value contract is permitted when it follows the architecture's direction.

### MODULE-023 — Type-only imports express actual runtime need

When the language provides a distinct type-only import or equivalent construct, a dependency used exclusively for static typing MUST use that form where it preserves the required language semantics.

A runtime value, validator, decorator, registration, or reflection requirement MUST remain a runtime dependency. Code MUST NOT rely on an ordinary import being erased to hide side effects or make an unsafe environment dependency appear absent.

Type-only syntax does not waive `MODULE-018` or turn untrusted runtime input into a validated value.

### MODULE-024 — Import syntax exposes the capability used

An import SHOULD identify the declarations actually used. Namespace imports MAY represent a language-required module namespace or a cohesive external API when that makes the dependency clearer.

A namespace MUST NOT be passed as an unrestricted service locator or used to discover arbitrary capabilities at runtime. Importing through a broad namespace does not widen the callable dependency permissions in `FUNC-012`.

Side-effect-only imports are governed by the loading rules below rather than treated as unnamed capability imports.

### MODULE-025 — Resolution is consistent across supported consumers

An import path MUST resolve to the intended authoritative module in every supported compiler, runtime, bundler, test runner, and tooling environment that consumes the file.

Aliases, source extensions, conditional entry points, and directory entry resolution MUST use established repository configuration. A path that works only because one test runner has a private fallback is insufficient for production consumers.

New path conventions MUST NOT be introduced locally without updating and validating every affected resolver. The rule does not require identical source and emitted paths; it requires consistent meaning after the supported transformations.

### MODULE-026 — Path identity is deterministic

Repository-owned paths MUST use the exact filesystem spelling and case, including on systems with case-insensitive resolution.

Different path spellings, source/build aliases, or duplicated entry copies MUST NOT load distinct runtime instances where consumers rely on one declaration, token, class, registry, or other identity-bearing value.

Multiple supported entry paths MAY forward the same authoritative declaration when resolution preserves its identity and compatibility contract.

### MODULE-027 — Dynamic loading has a bounded target contract

A dynamic module load MUST have an identified selection owner, allowed target set, expected export contract, and loading-failure owner.

Untrusted text MUST NOT become an arbitrary executable import path. A closed selection uses explicitly supported targets; an approved plugin discovery mechanism requires its own trust and validation boundary.

Dynamic loading MUST NOT bypass visibility, dependency direction, supported environments, or cycle requirements. Its async behavior remains governed by `FUNC-017` and the relevant owner.

### Evaluation, entry points, and environments

### MODULE-028 — Reusable module evaluation does not start application work

Evaluating a reusable module MUST be limited to declarations and deterministic construction that does not start an application operation or acquire a resource.

Top-level statements, invoked factories, static initializers, and the module's transitive imports MUST NOT conceal startup work. Moving an effect out of a shared constant into a bare statement does not avoid this rule or `CONST-007`.

Permitted loader declarations are defined by `MODULE-029`; deliberate executable startup is defined by `MODULE-030`. Function, object, class, and constant rules still govern the declarations constructed during evaluation.

### MODULE-029 — Loader-required evaluation is narrowly isolated

A language, framework, renderer, or tool may require directives, style or asset imports, static metadata, module augmentation, or test-suite registration during loading.

Such evaluation is allowed only when all of these conditions hold:

- It is required by an identified loader contract or by the declared asset behavior of that module's public UI surface.
- Its owner, execution environment, and activation point are identifiable.
- It remains confined to the relevant boundary and introduces no unrelated application work.
- Runtime resources and application services are not acquired merely to make declarations available.

For example, importing a component's declared stylesheet or registering test cases with the test runner may be loading behavior. Opening a database, contacting a provider, launching a timer, or installing application listeners still requires explicit startup.

If an external requirement conflicts with an active construct rule, this provision does not waive that rule; the exception process in Contributing to Lys applies.

### MODULE-030 — Executable startup has one explicit trigger

An executable entry point MUST have a recognized runtime, framework, or tool invocation that explains why application work begins.

It MUST delegate startup to named operations and keep the launching mechanism separate from independently reusable behavior. A language that invokes a `main` operation and a runtime that deliberately evaluates an entry file are both supported forms.

The entry contract MUST identify how startup succeeds, how failure is reported, and which owner handles shutdown. Detailed completion and resource guarantees remain owned by `FUNC-017`, `FUNC-018`, and the Class chapter.

### MODULE-031 — Importing helpers does not execute an entry point

A module used as an executable entry point MUST NOT also require ordinary consumers to evaluate startup merely to import a helper, type, constant, or factory.

Reusable declarations MUST live behind an import-safe surface, or the language's explicit invocation guard MUST make importing that surface safe in every supported mode.

A source file may serve both roles only when that separation is supported and verified. Application consumers MUST NOT depend on test-runner or command-line entry semantics.

### MODULE-032 — A module cache is not a lifecycle owner

Import caching, hot reload, test isolation, worker creation, and multiple runtime instances MUST NOT be used as the lifecycle contract for application state or resources.

State ownership follows the Class chapter and framework-owned state follows the Component chapter. A module MAY publish immutable values or compliant stateless providers; an application-scoped singleton remains an ordinary instance owned by composition under `CLASS-032`.

Code requiring exactly one application instance MUST establish that scope through its explicit owner rather than assume that a module will be evaluated exactly once everywhere.

### MODULE-033 — Initialization order follows explicit dependencies

Required application initialization order MUST be represented in the startup call graph or an identified framework lifecycle contract.

A reusable module MUST NOT require consumers to import an unrelated module first, mutate a global before loading it, or arrange sibling imports in a particular textual order to make its exports valid.

Repeated startup, partial startup failure, and shutdown behavior remain part of the owning operation's contract. Rearranging import statements is not a repair for missing lifecycle wiring.

### MODULE-034 — Environment compatibility includes transitive imports

A module MUST be loadable in every environment it claims to support, including the transitive runtime dependencies reached through its public surface.

A shared contract or platform-neutral module MUST NOT pull in a host-only runtime, browser-only global, production secret source, or application startup through a re-export or hidden dependency.

Code that requires such a mechanism MUST remain behind the appropriate platform or adapter boundary. A conditional branch around later use does not make an incompatible eager import safe. Component-specific requirements remain owned by `COMP-158`.

### MODULE-035 — Platform selection preserves the supported contract

Platform-specific source variants or conditional entries MUST expose the same promised surface and behavior for interchangeable consumers.

Selection MUST occur through an existing supported resolver, adapter, or composition boundary. A missing platform operation MUST NOT be implemented as a no-op, fabricated success, or an unexpectedly absent export.

When platforms intentionally provide different capabilities, that difference MUST be explicit in their supported entry contracts instead of disguised as interchangeability.

### MODULE-036 — Module discovery is not configuration discovery

Selecting or importing a reusable module MUST NOT silently read deployment, user, machine, or request configuration to decide which application behavior it represents.

Environment-dependent provider selection belongs at the composition boundary under `IFACE-024`. Configuration values remain distinct from constants under `CONST-008`.

An explicitly invoked configuration adapter or tool configuration entry point MAY read its required sources under its own documented contract. Naming ordinary policy code `config` does not create that boundary.

### MODULE-037 — Assets have declared owners and loading behavior

A module's styles, templates, prompts, static data, and other required assets MUST have an identifiable owner and a loading mechanism supported in the consuming environment.

Moving a source file MUST account for asset-relative paths, emitted asset locations, and loader behavior. Runtime filesystem discovery MUST NOT replace a declared dependency merely because development executes from a convenient working directory.

Loading that performs I/O MUST occur through the explicit operation or entry point that owns it. Declarative loader-managed asset imports remain subject to `MODULE-029`.

### File organization

### MODULE-038 — Paths express purpose in repository terminology

New filenames and directories MUST follow the established convention for their language and local area, and identify the concept, operation, adapter, view, or entry role they contain.

Framework-mandated names and existing `index`, `mod`, or entry filenames are permitted when the enclosing path supplies the missing meaning.

Names such as `misc`, `new`, `old`, `final`, or numbered file parts MUST NOT substitute for responsibility. A rename MUST NOT introduce a new casing or separator convention for unrelated files.

### MODULE-039 — File order makes dependencies and responsibilities visible

A source file MUST keep required language directives and loader metadata in their required positions, followed by clearly identifiable dependency declarations and cohesive implementation groups using local conventions.

Unrelated imports or initialization statements MUST NOT be interleaved with function bodies or declaration groups to hide dependencies or startup order. A language-required local import or deliberate lazy load is permitted at the operation that owns it.

Closely related declarations SHOULD remain adjacent. Mechanical alphabetical sorting MUST NOT separate a construct from its required implementation blocks or alter meaningful loader order.

### MODULE-040 — Supporting files remain close to their owner

Private types, calculations, styles, fixtures, and adapters SHOULD remain with their narrowest coherent owner until another current consumer or boundary justifies moving them.

Colocation may use an adjacent file, a cohesive subdirectory, or the repository's established parallel test layout. It does not require a single directory structure across languages.

Extraction MUST NOT require callers to reconstruct a private implementation sequence across several files or increase the public surface merely to pass intermediate state between fragments.

### MODULE-041 — Generated and maintained sources have distinct authority

A generated file MUST NOT become an independently edited second authority for repository-maintained behavior. Changes to generated output MUST be made through its maintained source, generator, or supported generation input.

Maintained adapters, generator code, and custom declarations remain subject to active standards even when generated output is exempt. Generated files and their authoritative inputs MUST be distinguishable through existing tooling or documentation.

A tool-produced file maintained manually thereafter is repository-owned source; its origin alone does not exempt later edits.

### MODULE-042 — Empty and obsolete modules are removed

A change that makes a module, export, facade, import, asset reference, or compatibility path obsolete MUST remove it when no current consumer or compatibility obligation remains.

Empty placeholder modules, abandoned implementation copies, commented-out exports, and unused speculative barrels are prohibited. A language- or tool-required marker file MAY remain when its presence serves that explicit contract.

Removing an apparently unused entry point requires checking runtime discovery and external contracts as well as static imports.

### Compatibility and documentation

### MODULE-043 — The module contract includes loading and identity

Compatibility assessment for a changed public surface MUST include:

- Supported import paths and exported names.
- Types, callable contracts, and required capabilities.
- Runtime identity where observable.
- Load-time behavior and required initialization order.
- Supported execution environments and resolution modes.
- Required assets and their observable loading behavior.

A change is not internal merely because its function signatures remain unchanged. Existing migration and approval requirements are owned by Contributing to Lys.

### MODULE-044 — File moves preserve supported consumers

A move or rename MUST update every affected internal import, re-export, discovery entry, asset reference, declaration reference, test, and authoritative example.

A supported external path MUST remain available unless its removal is part of an explicitly required and approved incompatible change. A forwarding module MAY preserve the path when it preserves the declaration and loading contract under `MODULE-012`.

Changing only a filename's case still requires validation on the repository's supported filesystems and tools.

### MODULE-045 — Compatibility forwarding remains narrow

A compatibility facade MUST name the supported replacement, preserve the old promised behavior, and have an explicit removal condition or documented permanent compatibility purpose.

It MUST NOT host new policy, fork the implementation, or give new internal consumers another competing entry path. A migration requiring translation belongs in an explicit adapter with its own tests and contract.

### MODULE-046 — Module documentation explains boundary facts

Documentation MUST state boundary facts that consumers cannot obtain from names, types, visibility, and established configuration, including applicable environment restrictions, required invocation, loading effects, supported subpaths, and compatibility forwarding.

Those facts MUST have one authoritative home adjacent to the boundary or in its canonical architecture documentation. Re-exports SHOULD link to that authority when additional context is needed rather than duplicate declaration contracts.

JSDoc coverage and tags remain owned by the JSDoc Standard. Imports and unchanged re-exports do not gain a documentation-comment requirement from this chapter.

### MODULE-047 — Examples use supported entry points

Canonical examples and usage documentation MUST consume the module through an entry point supported for the audience they address.

They MUST NOT teach private deep imports, undocumented initialization order, stale renamed paths, or a development-only resolver workaround as normal usage.

An example of internal implementation or a prohibited dependency MUST be explicitly labeled so it cannot be mistaken for supported consumer guidance.

### Verification

### MODULE-048 — Verification covers the changed dependency boundary

When imports, exports, file placement, or module ownership change, validation MUST examine the resulting dependencies for direction, cycles, private access, and unintended public expansion.

The check MUST cover the affected entry points and enough reachable edges to detect a cycle introduced by the change. Examining only a changed import statement is insufficient.

Use existing resolver-aware tools when available. A targeted manual graph trace MAY supplement them, but a text search that cannot resolve aliases, re-exports, or dynamic targets MUST NOT be reported as proof that the complete graph is acyclic.

### MODULE-049 — Validation exercises real consumer resolution

A changed supported entry point MUST be validated through its actual consumer path in each affected supported environment.

Run the relevant type, build, or import checks for value exports, type exports, asset loading, and resolution. A test that imports the implementation directly does not prove that its public facade resolves or exposes the intended declaration.

When identity matters across supported paths, validation MUST establish that those paths expose the same authoritative runtime value. No new identity assertion is required for passive values whose contract has no identity semantics.

### MODULE-050 — Loading and startup checks observe different contracts

When a change affects evaluation, entry-point execution, platform selection, or initialization, validation MUST distinguish safe module loading from successful explicit startup.

Relevant checks MUST cover the introduced loading effects and the owning startup operation's applicable failure and cleanup paths. When import caching could conceal evaluation, use a fresh supported process or isolated loader context.

Verification MUST observe behavior without depending on another test importing the right file first. Tests MUST NOT gain private production exports, reset hidden production globals, or install broad module mocks merely to make the boundary appear safe.

## Boundary examples

These examples describe structure, not prescribed filenames or new framework APIs. Each diagram is illustrative and does not claim that the current repository already uses that exact layout. Arrows mean “depends on.”

### Contract ownership and composition

```text
Permitted dependency direction:

  executable entry -> composition
  composition -> application operation
  composition -> concrete storage adapter
  application operation -> domain-owned reader contract
  concrete storage adapter -> domain-owned reader contract
  domain-owned reader contract -> domain value types

Prohibited dependency direction:

  domain-owned reader contract -> concrete storage adapter
  application operation -> executable entry
```

The capability exists only when justified by `IFACE-003`; its placement follows `IFACE-004`. The composition owner may know both the policy and provider without making either depend on startup.

### Public facade and internal collaboration

```text
Illustrative logical module: conversation presentation

  conversation-presentation/
    index.ts                 selected supported re-exports
    formatConversation.ts    supported formatter implementation
    formatMessage.ts         private supporting formatter
    conversation-format.ts   authoritative input/output value contracts

  external consumer -> index.ts -> formatConversation.ts
  formatConversation.ts -> formatMessage.ts
  formatConversation.ts -> conversation-format.ts

  Prohibited: formatMessage.ts -> index.ts -> formatConversation.ts
              -> formatMessage.ts
```

The private helper does not import its own facade. A one-file formatter could expose its file directly without this structure. Re-exporting the helper “just in case” would widen the surface without a consumer contract.

### Type recursion and namespace containment

```text
Permitted within one logical value module:

  Expression refers to Branch
  Branch refers to Expression
  neither type reference evaluates another runtime module

Not a runtime cycle by itself:

  a Rust parent declares a child module
  that child names a value type declared in its parent namespace

Ownership violation across logical modules:

  application policy imports a provider's private type
  provider imports the application's policy contract
```

The final case is not repaired merely by marking one import type-only. Fix contract placement while retaining any genuinely recursive domain type and its invariants.

### Import safety and deliberate startup

```text
Importing a reusable application module:
  makes named construction and startup operations available
  does not open storage, start a server, or contact a provider

Launching the executable entry:
  invokes the composition operation
  acquires and initializes through the declared lifecycle owners
  reports successful readiness or startup failure
  delegates shutdown to the declared lifecycle owners

Loading a test entry:
  declares cases through the test runner's registration contract
  acquires test resources only in owned setup or test operations
```

An application factory can be importable while the runtime entry remains executable. Loader-managed stylesheet imports have a different declared effect from opening an application resource.

### File decomposition without fragmentation

```text
Keep together when cohesive:
  one class and its required implementation blocks
  one operation and its small private calculations
  one component family and its owned prop contracts
  one production module and its gated in-file tests under MODULE-007

Separate at an actual boundary:
  domain policy and a vendor-specific transport implementation
  browser presentation and host-only filesystem operations
  reusable application construction and executable startup
  reusable production behavior and an independently loaded test-runner entry
```

Splitting a file does not create permission to scatter a complete class or interface declaration. Keeping a cohesive file does not waive callable or class limits.

## Objective review criteria and SOLID mapping

This section summarizes the rules without adding another source of requirements.

| Property                                             | Decision rule                     |
| ---------------------------------------------------- | --------------------------------- |
| Cohesive responsibility and file owner               | `MODULE-001`, `MODULE-004`        |
| A current reason for extraction and every export     | `MODULE-003`, `MODULE-008`        |
| Deliberate supported paths and facade names          | `MODULE-009` through `MODULE-015` |
| No runtime cycles or reversed logical ownership      | `MODULE-016` through `MODULE-022` |
| Consistent resolution and runtime identity           | `MODULE-025`, `MODULE-026`        |
| Import evaluation separated from application startup | `MODULE-028` through `MODULE-033` |
| Transitive environment compatibility                 | `MODULE-034`, `MODULE-035`        |
| Preserved consumer paths and boundary behavior       | `MODULE-043` through `MODULE-047` |
| Validation at the changed boundary                   | `MODULE-048` through `MODULE-050` |

This chapter sets no arbitrary maximum number of source lines, imports, exports, or declarations per file. `MODULE-004` gives concrete separation triggers, while `FUNC-013`, `CLASS-006`, and other applicable construct standards retain their objective limits. A long cohesive file is not automatically defective; a short file with unrelated responsibilities is not automatically compliant.

- **SRP:** module purpose, ownership, and separation are assessed through `MODULE-001`, `MODULE-003`, and `MODULE-004`.
- **OCP:** module surfaces preserve an already justified extension axis; its eligibility and extension conditions remain owned by `IFACE-003` and `IFACE-025`.
- **LSP:** supported alternate entries and platform variants preserve consumer contracts under `MODULE-012`, `MODULE-035`, and `MODULE-043`.
- **ISP:** consumers enter a deliberate narrow surface under `MODULE-008` through `MODULE-015`; callable and capability breadth remain owned by their active standards.
- **DIP:** imports expose the actual ownership direction under `MODULE-020` and `MODULE-021`, with capability ownership remaining in `IFACE-004` and `IFACE-024`.

## Construction and review checklist

- [ ] The logical boundary, source-file owners, responsibility, and current consumers are identifiable.
- [ ] Every extracted module and export has a current contract or explicit entry-point requirement.
- [ ] Supporting declarations remain cohesive and complete under their owning standards.
- [ ] External consumers use supported paths; private helpers remain private to their audience.
- [ ] Facades deliberately select exports without changing authority, identity, or behavior.
- [ ] Runtime and type-only dependencies follow ownership direction, including indirect paths.
- [ ] No implementation imports its own re-exporting facade or depends on executable startup.
- [ ] Every affected resolver agrees on the intended source and runtime identity.
- [ ] Dynamic targets have explicit selection, trust, contract, and failure owners.
- [ ] Module loading, loader-required declarations, and application startup have distinct contracts.
- [ ] State and resources have explicit owners independent of module caching.
- [ ] Supported environments include transitive imports and declared assets.
- [ ] File moves preserve discovery, consumer paths, asset loading, and compatibility.
- [ ] Documentation describes non-obvious boundary facts without duplicating declaration contracts.
- [ ] Validation exercises the affected public paths, graph, loading behavior, and startup behavior.
- [ ] Any exception follows Contributing to Lys and has explicit reviewer approval.
