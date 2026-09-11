# Configuration

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines how supported configuration inputs become validated choices, how those choices reach their consumers, and what loading, saving, and applying a change actually guarantee.

## Definition and scope

**Configuration** consists of supported inputs that select application, tool, deployment, user, session, or operation behavior. A **setting** is a named choice within that contract. A fixed domain invariant remains a constant; user data does not become configuration merely because it is stored beside settings.

A **source** supplies raw input, such as an explicit argument, environment namespace, settings document, platform preference store, or authorized remote response. A **candidate** is proposed configuration being resolved and checked. An **effective configuration snapshot** is the complete validated selection for a particular scope and evaluation point. A **persisted value** is a stored choice; an **applied value** is a choice actually governing its consumer. These may differ while an edit is pending, persistence fails, or a restart or resource replacement is required.

**Precedence** decides between eligible contributions. **Authority** decides which source or actor may supply or change a setting at all. A **default** supplies a value under a declared absence condition; recovery from an invalid or unavailable source is a separate failure policy. A **revision or generation** identifies an update when ordering, concurrency, or application acknowledgement needs that identity; a universal revision field is not required for a fixed lexical value.

The rules apply to repository-owned configuration declarations, source adapters, resolution, validation, projections, settings commands and interfaces, persistence, and supported reconfiguration. They also apply to build and tool configuration at the phase where it selects behavior. Configuration exposed through an API, event, hook, class, or resource boundary remains subject to that construct's standard.

This chapter does not require environment variables, a settings file, a configuration service, a schema library, a secret manager, a feature-flag platform, a universal settings registry, or hot reload. A setting that only takes effect at startup may remain startup-only. Passive configuration remains a Type/value construct; a repository-defined owner of mutable state, dependencies, watchers, or lifecycle remains subject to the Class rules.

Schema contracts and migrations also follow [Schema and Migration](./SCHEMA.md). Tests and fixtures also follow [Test and Fixture](./TEST.md). Comment construction also follows [Comment](./COMMENT.md). Configuration documentation retains the requirements in this chapter.

## Existing rule ownership

Each active standard retains its exact triggers and permitted cases. Configuration rules connect the source, selected value, storage, and consumer without replacing those owners.

| Concern                                                                                       | Authoritative rule or document                                                                                                     |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Default ownership, pure initialization, configuration versus constants, and meaningful limits | `CONST-005`, `CONST-007` through `CONST-011` in [Constant](./CONSTANT.md)                                                          |
| Callable naming, trust, validation, defaults, authority, effects, and dependencies            | `FUNC-003`, `FUNC-007` through `FUNC-012` in [Function](./FUNCTION.md)                                                             |
| Value domains, absence, passive representations, authority, and compatibility                 | `TYPE-002` through `TYPE-012`, `TYPE-017`, `TYPE-019`, `TYPE-020` through `TYPE-023` in [Type](./TYPE.md)                          |
| Immutable publication, source merging, exact patches, serialization, and version boundaries   | `OBJECT-007` through `OBJECT-024`, `OBJECT-039` through `OBJECT-046` in [Object](./OBJECT.md)                                      |
| Stateful ownership, dependency scope, construction, readiness, and concurrent mutation        | `CLASS-001`, `CLASS-008` through `CLASS-016`, `CLASS-023` through `CLASS-025` in [Class](./CLASS.md)                               |
| Capability contracts, cancellation, readiness, provider selection, and lifecycle composition  | `IFACE-008`, `IFACE-014` through `IFACE-024` in [Interface](./INTERFACE.md)                                                        |
| Import behavior, tool loading, startup, and configuration adapters                            | `MODULE-028` through `MODULE-036` in [Module and File](./MODULE.md)                                                                |
| Declared build inputs, target artifacts, secret exclusion, and cache correctness              | `PKG-028`, `PKG-033`, `PKG-034`, `PKG-037`, `PKG-040` in [Package and Dependency](./PACKAGE.md)                                    |
| Settings UI state, reactive observations, actions, and owner lifetimes                        | [Component](./COMPONENT.md) and [Hook](./HOOK.md)                                                                                  |
| External input, authorization, partial effects, and compatibility                             | [API](./API.md)                                                                                                                    |
| Failure meaning, recovery, partial or uncertain outcomes, and disclosure                      | [Error](./ERROR.md)                                                                                                                |
| Update notifications, event meaning, ordering, and subscription lifetime                      | [Event and Message](./EVENT.md)                                                                                                    |
| Task ownership, cancellation, stale completion, and bounded background work                   | [Async Task and Stream](./ASYNC.md)                                                                                                |
| Prepared resources, replacement, persistence, capacity, and release                           | `RESOURCE-009`, `RESOURCE-010`, `RESOURCE-025`, `RESOURCE-030`, `RESOURCE-036` through `RESOURCE-039` in [Resource](./RESOURCE.md) |
| Documentation and change workflow                                                             | [JSDoc Standard](../JSDOC.md) and [Contributing to Lys](../../CONTRIBUTING.md)                                                     |

The words resolve, merge, configure, reload, and activate describe concepts; they do not add repository-designed function verbs to `FUNC-003`. Externally imposed signatures retain their existing exception. Source resolution and patch application retain the named, property-by-property construction required by `OBJECT-021` through `OBJECT-024`; a configuration label does not permit a generic deep merge.

Platform conventions do not waive active rules. In particular, configuration loading does not permit hidden import effects under `CONST-007` or `MODULE-028`, a permissive parser does not replace a validated trust boundary, and reconfiguration does not permit fallible lazy initialization under `CLASS-012`. Any necessary exception follows [Contributing to Lys](../../CONTRIBUTING.md).

## Construction process

Before adding or changing configuration:

1. Identify the supported behavior, actual consumer, owning scope, and reason it varies.
2. Define the authoritative keys, value domains, absence meanings, defaults, and application phase.
3. Enumerate permitted sources, their authority, selection order, and failure behavior.
4. Trace decoding, normalization, per-property resolution, and complete candidate validation.
5. Identify where the validated snapshot enters composition and when consumers sample it.
6. Separate accepted edits, saved choices, applied behavior, and any restart or rebuild requirement.
7. For supported updates, trace ordering, partial application, resource replacement, and shutdown.
8. For persistence, define creation, write acknowledgement, concurrency, and version compatibility.
9. Trace sensitive values through projections, artifacts, diagnostics, caches, and retention.
10. Verify the supported boundaries with observable configuration and consumer outcomes.

## Mandatory rules

### Setting contracts and source ownership

### CONFIG-001 — A setting controls an identified supported behavior

A new setting MUST have an actual consumer, an owning responsibility, and a concrete reason its value varies. Its supported values MUST correspond to behavior the application implements at the declared application phase.

A declaration, stored field, control, or documented key MUST NOT imply that a consumer honors a value when that consumer still uses a fixed choice. Speculative toggles and extension points MUST NOT be added for hypothetical future behavior. A fixed invariant remains governed by the Constant standard rather than becoming an unnecessary override.

### CONFIG-002 — Each setting has one authoritative contract

The setting owner MUST define its meaning, key, type, units, accepted range or alternatives, absence behavior, default when allowed, scope, and application phase. These facts MUST remain consistent across source adapters, native and renderer representations, consuming requests, and user-facing controls that expose the setting.

Language projections or generated declarations MAY represent the same contract without creating competing authorities. The implementation MUST have a traceable means of keeping those representations consistent. An independently copied default or a generic typed return annotation is not evidence that an external value satisfies the contract.

### CONFIG-003 — External setting names have deliberate compatibility

External keys, environment names, command options, and aliases MUST have defined spelling, case behavior, namespace, and meaning. Names that normalize to one setting MUST have an explicit conflict policy when more than one is supplied.

An alias or deprecated key MUST identify the canonical setting and retain a documented acceptance and removal policy. Renaming a source property MUST NOT silently create a different setting, change precedence, or reinterpret a previously valid value. Internal names MAY differ where a deliberate adapter preserves the external contract.

### CONFIG-004 — Evaluation scope and application time are explicit

A setting MUST identify the scope in which it is selected and the point at which its consumer observes it. Relevant phases include build, tool loading, process startup, owner construction, session creation, operation admission, and a supported live update.

Changing a source after its sampling point MUST NOT be represented as changing an already constructed artifact, instance, or admitted operation unless the consumer supports that transition. Shared process settings and per-user or per-operation overrides MUST remain distinguishable. A change that requires restart, reconstruction, or rebuild MUST expose that requirement at the boundary accepting it.

### CONFIG-005 — Configuration data does not hide a service owner

Passive settings and validated snapshots MUST use the representations required by the Type and Object standards. A configuration record MUST NOT conceal mutable state ownership, resource acquisition, dependency discovery, or unrelated operational methods.

A controller that owns live updates or persistence MUST retain the explicit state and lifecycle owner required by the Class rules. Consumers MUST NOT use a broad configuration object as a service locator. Choosing a configuration representation does not create a reason for a universal registry, data-only class, or speculative provider interface.

### CONFIG-006 — Sources are selected through a supported boundary

The configuration boundary MUST identify the sources it reads, their owned keys or namespace, and how callers supply or locate them. Incidental working-directory contents, inherited process state, or similarly named files MUST NOT become undocumented inputs.

An adapter for a shared source, such as the process environment, MUST first select its owned namespace. Unknown properties in the resulting serialized configuration retain `OBJECT-042`; unrelated host variables are not automatically unknown configuration keys. Supporting one source MUST NOT imply that other file formats, paths, remote services, or override mechanisms are supported.

### CONFIG-007 — Source precedence cannot grant authority

Eligibility to contribute a setting MUST be established before applying precedence. A later command option, stored preference, remote response, or request field MUST NOT override a protected setting solely because it is later in the resolution order.

The owner MUST define which actors and sources may change policy, credentials, endpoints, filesystem locations, or other authority-bearing values. Derived effective settings MUST preserve those restrictions across scopes and adapters. Possession of a configuration document or access to an editing control is not proof of permission to apply every represented value.

### CONFIG-008 — Resolution defines precedence per property

Multi-source configuration MUST apply `OBJECT-021` through a named, explicit per-property policy. That policy MUST establish which eligible contribution wins, how absence and conflicts are handled, and how the resulting complete contract is validated.

Nested objects, arrays, and collections MUST have deliberate replacement or composition semantics. The order in which a parser, directory iterator, object spread, or generic recursive merge happens to process data MUST NOT define the repository's configuration contract. Different precedence for different settings is allowed when the owning contract explains it.

### CONFIG-009 — Defaults apply only at their declared absence boundary

Configuration defaults MUST retain the single owner and exact trigger required by `CONST-008`, `CONST-009`, and `FUNC-008`. Resolution MUST distinguish missing input from supplied values such as `false`, zero, an empty string, an empty collection, or an explicit null according to the setting's domain.

A missing optional contribution MAY select its declared default. Malformed input, an unreadable required source, corrupt persisted data, unsupported versions, or unavailable dependencies MUST NOT be silently converted to absence so that defaults conceal the failure. Downstream consumers MUST NOT independently choose another default for the same setting.

### CONFIG-010 — Source failure and overridden input have explicit treatment

The source contract MUST distinguish absence, read failure, decoding failure, invalid values, and a valid contribution that loses precedence. It MUST define which sources are consulted and which contributions require validation, including how invalid input from an overridden source is reported or rejected.

Skipping an ineligible or explicitly unconsulted source need not read it. Ignoring a lower-priority contribution MUST NOT silently recover from a failure that the required-source contract promises to expose. An optional recovery policy MUST describe the resulting state without weakening the existing Error and Constant rules.

### Decoding and complete validation

### CONFIG-011 — Raw source syntax is decoded explicitly

Each source adapter MUST decode its actual representation into the setting's domain before treating the contribution as typed configuration. Text booleans, numeric text, lists, escaped strings, and null-like tokens MUST have documented accepted forms where supported.

Truthiness, unchecked casts, permissive prefix parsing, or an unrelated parser's coercion MUST NOT decide whether a supplied value is valid. Trimming, case folding, and other normalization MUST be intentional and MUST NOT alter opaque identifiers or secret values without their contract's permission.

### CONFIG-012 — Numeric settings retain exact units and boundaries

A numeric setting MUST define the unit, inclusive or exclusive limits, finite-value requirements, and integer or precision constraints needed by its consumer. Conversion from source units MUST preserve the accepted domain and reject overflow, unsupported precision, and invalid sentinels where they would change behavior.

Zero, negative values, unlimited values, and disabled states MUST have explicit meanings when accepted. A UI constraint, deserializer's machine type, or transport schema MUST NOT be treated as sufficient when the configuration contract has a narrower range or additional relationships.

### CONFIG-013 — Ambiguous definitions have a deterministic policy

A source format or adapter that can supply duplicate keys, repeated options, aliases, or names that collide after normalization MUST define whether those definitions are rejected or resolved through a supported ordering rule. That policy MUST remain consistent through every parser used on the boundary.

An adapter MUST NOT claim to reject duplicates after an earlier parser has already discarded the evidence. If the format's accepted ordering is significant, the contract MUST preserve that ordering explicitly. Parser-specific accidental winners MUST NOT decide protected or otherwise ambiguous settings.

### CONFIG-014 — The complete candidate satisfies combined invariants

After source resolution, the configuration boundary MUST validate the combined candidate against the relationships needed by its consumers. Individually valid fields MUST NOT be published when their combination violates a required budget, dependent option, selected mode, or other configuration invariant.

Validation MUST run against the candidate that will actually be published, including defaults and derived values. Validating an earlier partial input or separate fields in isolation does not establish that a later composed snapshot is valid. Derived values MUST remain traceable to the same authoritative inputs.

### CONFIG-015 — Includes and interpolation remain bounded data processing

If configuration supports includes, references, templates, or interpolation, the boundary MUST define the permitted sources, evaluation order, missing-reference behavior, and conflict rules. Recursive expansion MUST detect cycles and enforce bounds appropriate to the accepted input and trust boundary.

Untrusted configuration MUST NOT become executable code, arbitrary module loading, command execution, or unrestricted environment and filesystem discovery. Trusted repository-owned tool configuration retains the Module and Package rules for executable configuration; that is not permission to evaluate user-authored settings as code.

### CONFIG-016 — Locations are resolved against an explicit origin

Configuration containing paths, URLs, or other external locations MUST define the origin used for relative values, accepted forms, and any scope or authority restrictions. Resolution MUST NOT silently depend on the caller's incidental current directory or a different process's path interpretation.

Normalization alone MUST NOT be presented as authorization or proof about a later acquired target. The adapter MUST preserve the relevant API and Resource checks when a configured location crosses a trust boundary, can be replaced, or supplies credentials through an embedded component.

### CONFIG-017 — Configuration validity and dependency availability are distinct

Validation MUST distinguish an invalid setting from a valid setting whose required dependency cannot currently be prepared or reached. A successful syntax or domain check MUST NOT imply that a database, provider, model, file, or remote endpoint is ready.

Required capability preparation MUST occur through the owning construction boundary before readiness is published. An optional external verification step MUST state what it actually established and for which candidate; an earlier successful probe is not proof of permanent availability. Failure classification and recovery retain the Error rules.

### CONFIG-018 — Provider choices preserve capability contracts

Configuration that selects a provider or operating mode MUST produce a supported capability through composition under `IFACE-023` and `IFACE-024`. The selected combination MUST support the operations the consuming policy is entitled to use.

A flag MUST NOT excuse a required method that throws unsupported, returns a false success, or requires consumers to probe provider names or optional methods. Invalid provider-option combinations MUST be rejected before publication. Provider selection does not justify exposing provider-specific configuration throughout unrelated policy code.

### Loading and consumption

### CONFIG-019 — Configuration loading occurs at its declared effect boundary

Source reads and environment-dependent discovery MUST occur at the explicit loader, tool adapter, startup, or operation boundary permitted by `MODULE-028` through `MODULE-036`. Reusable imports and constant initialization retain their existing restrictions.

The boundary MUST make its source dependencies and loading failures visible. Moving a source read outside a constant declaration or hiding it behind a getter MUST NOT create an import-effect exception. Pure declarations and defaults MAY be shared without turning module evaluation into application startup.

### CONFIG-020 — Required configuration precedes dependent readiness

An owner MUST obtain and validate the configuration required by its promised capability before admitting work or publishing that capability as ready. Resources needed to read or prepare configuration MUST themselves have an explicit owner and failure path.

Failure MUST leave a truthful startup or construction result and preserve cleanup obligations. A partially initialized owner MUST NOT accept ordinary operations while required settings remain unknown. Background retries, defaults, or a future first request MUST NOT disguise the fallible lazy initialization prohibited by `CLASS-012`.

### CONFIG-021 — Published configuration is a coherent validated snapshot

A configuration consumer MUST receive a complete validated representation for its declared scope, with publication and immutability governed by the Type and Object standards. Raw input and an editable candidate MUST NOT be exposed through the same contract as accepted effective configuration.

After publication, mutable aliases MUST NOT allow a source adapter or editor to alter fields behind consumers' validation assumptions. A revision identifier MAY distinguish snapshots where needed, but it does not make an otherwise mutable or incomplete object safe. Separate allocations are unnecessary when an existing immutable value already proves the boundary.

### CONFIG-022 — Consumers receive only the configuration they need

Composition MUST provide each consumer with the values or narrow supported capability it requires, applying `CLASS-008` and the existing dependency rules. A consumer MUST NOT reread ambient environment or storage to recover settings that should have been supplied by its owner.

A projection MUST preserve units, validity, scope, and application time. Giving a consumer a narrow snapshot does not grant permission to invent another default, lose an authority restriction, or retain unrelated credentials. Dynamic observation requires an explicit observation contract and owner rather than a hidden global lookup.

### CONFIG-023 — An operation observes a defined configuration generation

An operation whose correctness depends on related settings MUST use a coherent selection at the declared sampling point. It MUST NOT combine fields from different updates merely because asynchronous work or callbacks read them at different times.

If an operation supports later configuration changes, the contract MUST define which fields may change and the transition at which they apply. A captured snapshot does not waive active authorization, revocation, or resource-validity requirements. Conversely, a later preference edit MUST NOT silently rewrite an admitted operation's promised parameters.

### CONFIG-024 — Accepted, saved, and applied are different outcomes

Commands, events, status values, and UI feedback MUST identify which configuration stage has completed. Accepting an edit, validating a candidate, writing a document, applying a live value, and preparing a replacement resource MUST NOT be reported as interchangeable successes.

When stages can diverge, the boundary MUST expose enough state for the caller to understand what is currently applied, what is pending, and what failed. A saved restart-only setting MAY remain unapplied until restart. A locally applied preference whose persistence failed MUST NOT be described as successfully saved.

### Updates and application

### CONFIG-025 — Edits and resets have exact setting semantics

A settings update MUST define its target scope and whether it replaces a complete configuration or applies a narrow patch. Patch shape, omission, null, removal, and resulting-object construction retain `OBJECT-022` through `OBJECT-024`.

A reset MUST state whether it removes a source override, writes a fixed value, or selects the current declared default; these may produce different future behavior. Editing one pane or group MUST NOT silently discard unrelated values or overwrite newer changes outside its accepted update contract.

### CONFIG-026 — Application acts on the validated candidate

A configuration update MUST preserve the connection between the candidate validated, any resources prepared for it, and the values eventually activated or persisted. Edits made while validation or preparation is pending MUST create a new candidate or follow another explicit protocol that prevents stale approval from authorizing changed values.

Validation alone does not complete application. The owner MUST define the activation point and any prerequisites needed before the candidate may govern new work. Preparing candidate resources MUST preserve the existing acquisition, failure, and cleanup contracts.

### CONFIG-027 — Concurrent updates have one ordering contract

When configuration updates may overlap, their owner MUST define ordering, conflict handling, and which update remains entitled to publish. An older read, validation, save response, or preparation task MUST NOT overwrite a newer accepted state merely because it finishes later.

Revision checks, serialized ownership, compare-and-set, or another supported mechanism MAY establish the order. The mechanism MUST cover the actual shared boundary rather than only one UI control. Cancelling observation of a superseded candidate does not remove responsibility for its eventual effects or resources.

### CONFIG-028 — Coupled settings activate as a coherent unit

Settings whose correctness depends on each other MUST become visible to a consumer through a coherent activation boundary. A consumer MUST NOT observe an intermediate combination that violates the candidate's validated invariants.

If independent groups can apply separately, the contract MUST identify those groups and report their actual outcomes. This does not require a universal transaction across unrelated processes or irreversible external systems. It does require that partial application remain explicit and that no aggregate success claim imply all groups applied when some did not.

### CONFIG-029 — Failed application leaves an accountable runtime state

The update owner MUST define what remains active when candidate preparation or application fails. It MAY retain the previous valid state when that state is still usable and permitted, but MUST report the rejected update and release or transfer candidate obligations.

Where effects cannot be rolled back, the result MUST identify the actual partial, terminal, or uncertain state and its recovery owner under the Error rules. A stored desired value MUST NOT overwrite evidence of the runtime state. Keeping an older snapshot MUST NOT retain revoked authority or claim readiness after its required resource became unusable.

### CONFIG-030 — Resource reconfiguration completes the replacement protocol

A configuration change that replaces a client, connection, listener, pool, process, or other resource MUST apply `RESOURCE-025` to candidate preparation, admission, publication, existing borrowers, and release. Updating a descriptor or configuration field alone MUST NOT be counted as completed replacement.

Capacity accounting MUST include old, opening, closing, and overlapping resources under `RESOURCE-036`. Candidate failure, cancellation, or cleanup failure MUST retain every outstanding release and accounting obligation until relinquished or validly transferred. In-flight operations MUST follow their declared old or new resource lifetime rather than observe an accidental mixture.

### CONFIG-031 — Reload notifications initiate a fresh guarded read

When live reload is supported, a file notification or remote invalidation MUST NOT itself prove that a complete valid configuration is available. The owner MUST read through the supported source boundary, validate a candidate, and preserve ordering before applying it.

Repeated notifications, partial writes, disappearance, and invalid revisions MUST have a bounded handling policy. Coalescing, retry, and retention of the previous valid state MUST preserve Async and Error requirements. An invalid update MUST NOT trigger an unbounded busy loop or silently reset required settings to defaults.

### CONFIG-032 — Configuration background work has an owner and shutdown

Asynchronous reads, remote lookups, validation tasks, watchers, and reconfiguration operations MUST retain an owner through completion under the Async, Event, and Resource rules. Cancellation MUST reach the relevant work when `IFACE-018` requires it.

Shutdown or scope replacement MUST revoke stale publication and release owned subscriptions and resources through their actual protocols. A timed-out caller or removed listener MUST NOT leave an unobserved late save, acquisition, or activation. Work whose external effect cannot be cancelled MUST retain a truthful eventual or uncertain outcome.

### CONFIG-033 — Shared configuration preserves scope isolation

Configuration selected for one application instance, user, session, request, or test MUST NOT leak into another through mutable global state, reused clients, or incorrectly keyed caches. Shared storage and owners MUST make their supported scope explicit.

Changing a global source for the convenience of a local override MUST NOT affect unrelated concurrent work. If multiple processes share a configuration authority, the contract MUST define how each observes updates and what consistency is promised; a local state change or event delivery does not establish global application.

### Persistence and compatibility

### CONFIG-034 — Persistence stores the intended configuration representation

The persistence boundary MUST define whether it stores authored overrides, a complete desired configuration, or another explicitly versioned representation. It MUST NOT accidentally materialize environment-derived values, transient session overrides, secrets, or applied runtime metadata into a user settings document.

Serialization and unknown-field handling retain `OBJECT-039` through `OBJECT-046`. A reader that intentionally tolerates fields for forward compatibility MUST have a safe write policy before replacing the document; silently dropping data it does not understand MUST NOT be presented as a compatible save.

### CONFIG-035 — First-run initialization does not overwrite an existing source

Creation of a missing settings source MUST be an explicit initialization effect with the required path and resource authority. Absence MUST remain distinct from access failure, malformed content, unsupported versions, and other loading failures.

If another actor can create the source between discovery and creation, the creation protocol MUST preserve existing content and handle that race through the acquired target under `RESOURCE-009`. A failed read or parse MUST NOT authorize replacing the source with defaults. Success MUST include any initial persistence that the initialization contract promises.

### CONFIG-036 — Save acknowledgement matches the storage guarantee

A save MUST define what its success proves: accepted by an owner, completely written, safely replaced, or durably committed as required by the actual contract. Completion, flush, close, and persistence remain distinct under `RESOURCE-030`.

When a save promises to preserve the previous usable configuration on failure, the write protocol MUST provide that guarantee rather than truncate the only copy before a fallible write completes. Temporary artifacts and replacement failures MUST retain their owners. The caller MUST receive a failure or uncertain outcome when the promised storage guarantee has not been established.

### CONFIG-037 — Persistence prevents unsupported lost updates

When multiple editors or processes may write the same configuration, the persistence contract MUST define conflict detection or an explicitly supported overwrite policy. A whole-document save based on an older read MUST NOT silently erase intervening edits when the contract promises to preserve them.

Any revision comparison, locking, serialization, or conditional write MUST protect the actual shared write boundary. An in-memory check in one renderer is insufficient for independent writers. A conflict response MUST leave enough non-sensitive information for an explicit retry or reconciliation without falsely acknowledging the rejected write.

### CONFIG-038 — Stored versions are identifiable before interpretation

Configuration read across software versions MUST retain the exactly identifiable version boundary required by `OBJECT-045`. That identity MAY belong to the document, its envelope, or another authoritative boundary; an inline version field in every settings object is not mandatory.

The reader MUST determine supported interpretation and any required migration before publishing effective values. It MUST NOT infer a version from missing fields or try schemas until one appears to fit. Unsupported or corrupt input MUST remain distinguishable from an absent optional setting and MUST NOT be overwritten as first-run initialization.

### CONFIG-039 — Configuration changes preserve declared compatibility

Changes to keys, accepted values, units, defaults, precedence, source selection, or application time MUST assess existing persisted and externally supplied configuration. A required breaking change MUST include an explicit migration or operational transition and validation of affected consumers under the repository workflow.

Changing a default MUST account for whether stored absence means following the current default or retaining an earlier choice. A migration MUST preserve source authority and meaningful user choices, and MUST report failure without concealing the original configuration. This requirement does not mandate an independent migration framework. Schema evolution and migration also follow the [Schema and Migration](./SCHEMA.md) standard.

### Exposure, policy, and diagnosis

### CONFIG-040 — Sensitive settings have an explicit distribution boundary

A setting that contains credentials, private locations, identifiers, or other sensitive data MUST be classified and distributed only to the owners that need it. Public identifiers, secret references, and resolved secret values MUST remain distinguishable when they confer different authority or exposure.

Raw source dumps, complete configuration objects, parser diagnostics, URLs, and nested errors MUST NOT bypass the existing secret-handling and disclosure rules. Immutability, encoding, a naming prefix, or a type annotation does not protect confidentiality. Source acquisition and storage MUST use the protections required by the actual secret boundary.

### CONFIG-041 — Build and client projections expose only intended values

A build-time or client-visible configuration projection MUST deliberately select values safe and necessary for that target. Backend-only settings and credentials MUST remain outside public bundles, generated documents, source maps, manifests, and other distributed output under the Package rules.

The build contract MUST identify which inputs are embedded and when they become fixed. A runtime source update MUST NOT be advertised as changing a previously produced artifact without an actual runtime input path or rebuild. A variable prefix or a tool's substitution mechanism MUST NOT be treated as an authorization or secrecy boundary.

### CONFIG-042 — Credential changes follow their actual consumer lifetime

If a configuration boundary supports credential refresh, rotation, or revocation, it MUST define when consumers obtain the new authority and what happens to work and resources using the previous authority. A changed secret reference or saved token MUST NOT imply that existing clients have adopted it.

Replacement, expiry, unavailable refresh, and shutdown MUST preserve the applicable API, Error, Async, and Resource contracts. Old authority MUST NOT remain usable merely because an earlier snapshot was valid. Sensitive values MUST NOT be copied into status records or retained by unrelated snapshots for diagnostic convenience.

### CONFIG-043 — Overrides remain inside the supported policy domain

User, session, request, test, and deployment overrides MUST remain within the authority and validity constraints of their setting. A supported override MUST NOT bypass required authorization, validation, resource limits, or another active construction rule by labelling the resulting behavior configurable.

Modes that intentionally differ MUST have explicit supported contracts and allowed sources. An arbitrary switch to disable a required check MUST NOT be added as a convenience. Test injection MAY supply controlled values or capabilities through an authorized boundary without changing production policy for unrelated consumers.

### CONFIG-044 — Conditional features have a defined evaluation contract

When a feature setting or rollout choice exists, its owner MUST define the supported alternatives, default or unavailable-source outcome, evaluation scope, and application time. Related decisions within one operation MUST remain coherent under its sampling contract.

Conditional exposure MUST NOT serve as the only authorization check for a protected operation. A remotely selected variant MUST satisfy the same supported capability and input contracts as local selection. A temporary setting MUST have a concrete retirement condition, and removing it MUST reconcile persisted values and remaining consumers without creating an undocumented compatibility break.

### CONFIG-045 — Configuration provenance explains the applied choice

Where multiple sources, revisions, or application phases can produce different outcomes, the supported diagnostic boundary MUST identify enough provenance to explain the selected and applied choice. Relevant facts may include the setting key, safe source identity, winning layer, revision, or pending restart state.

Provenance MUST correspond to the snapshot or application result being described, rather than a later mutable source read. It MUST be limited and sanitized under the Error and Package rules. A universal telemetry system, complete value dump, or public fingerprint of sensitive values is not required or permitted by this rule.

### CONFIG-046 — Configuration failures identify an actionable boundary

Failure results MUST distinguish source access, decoding, invalid settings, incompatible versions, update conflicts, persistence, and application when those require different caller actions. They MUST identify the affected field or safe source context where that information is needed to correct the input.

Diagnostics MUST NOT echo secrets, arbitrary document contents, or unsafe low-level error data to achieve that clarity. Retry and recovery MUST follow the actual failure category. A generic success with defaults, swallowed save error, or undifferentiated message MUST NOT conceal a failed promised stage.

### CONFIG-047 — Cached results follow their effective configuration inputs

A build cache, memoized calculation, shared client, or other reused result that depends on configuration MUST include the relevant effective inputs in its validity contract. Reuse across changed configuration MUST either remain correct by that contract or trigger the required invalidation or replacement.

Cache identity MUST preserve scope, authority, units, and application generation where they affect correctness. A file timestamp, object identity, or current global value alone MUST NOT be used when it misses meaningful changes. Secret-bearing cache keys and metadata retain the existing disclosure rules; resource reuse remains subject to Resource ownership and reset requirements.

### CONFIG-048 — Documentation and controls describe actual supported behavior

Configuration documentation, help text, examples, and controls MUST match the authoritative keys, domains, defaults, sources, precedence, and application phases they expose. A disabled control, persisted field, or example file MUST NOT claim an operational effect that the consumer does not implement.

Documentation MUST explain meaningful restart, rebuild, conflict, and persistence limitations at the boundary where users act. Examples MUST use non-sensitive values and MUST NOT suggest unsupported environment or settings contracts. Changes to a setting MUST update the directly affected documentation and controls in the same change.

### Verification

### CONFIG-049 — Resolution tests exercise complete configuration outcomes

Configuration parsing and resolution MUST be verified through supported boundaries with meaningful accepted and rejected inputs. Relevant cases include source authority and precedence, absence versus supplied false or zero, invalid text, exact ranges and units, duplicate or alias conflicts, unknown fields, and combined invariants.

Tests MUST assert the resulting effective values or classified rejection, rather than only that a helper was called. Sources MUST be controlled and isolated; tests MUST NOT depend on a developer's real environment, secrets, settings file, or incidental working directory. Declared default ownership and projection consistency MUST be covered where they can diverge.

### CONFIG-050 — Persistence tests prove the promised write boundary

Persisted settings MUST be verified through the actual supported serialization and save/load boundary. Relevant cases include first creation, existing input, malformed or unsupported versions, read and write failure, partial replacement, conflicts, reset behavior, and round-trip preservation of the intended representation.

Mocks MUST NOT hide a mismatched command argument, discarded field, or false storage acknowledgement. Tests MUST use isolated temporary or in-memory sources and check the promised retained or changed content after failure. Durability or multi-process guarantees that cannot be established by a unit test MUST have appropriate boundary validation with its limits recorded.

### CONFIG-051 — Update tests cover ordering and application failure

Supported reconfiguration MUST be verified with controlled update order, including a slow older candidate completing after a newer one. Tests MUST cover the relevant distinction between accepted, persisted, and applied state, coherent operation sampling, and partial or failed application.

Resource replacement, cancellation, and shutdown cases MUST observe retained and released obligations where those paths exist. Verification MUST demonstrate that stale work cannot activate an obsolete candidate and that a rejected update does not falsely claim the previous state is usable. Tests MUST NOT require hot reload for a setting whose contract only permits restart.

### CONFIG-052 — Cross-boundary configuration reaches the actual consumer

When configuration crosses languages, processes, packages, build phases, or public/private boundaries, verification MUST establish that the selected value reaches the intended consumer with the same domain and application semantics. Independently accepting similar shapes on each side is insufficient.

Relevant validation MUST cover argument names, serialization, defaults, provider construction, request sampling, embedded build inputs, and exclusion of sensitive values where the change affects them. A UI update or successful document write alone MUST NOT be used as proof of changed runtime behavior. Any boundary that could not be verified MUST be reported with the exact limitation.

## Repository boundary examples

These examples identify boundaries in the current source; they do not certify those implementations as compliant with this chapter or every active standard. Existing limitations are not exceptions for new or modified code.

| Observed boundary                                                                                                   | Configuration distinction                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend composition uses a configuration object assembled from protocol constants and a home-relative database path | An assembled object and its use by factories do not establish an external environment override or validation contract.                                       |
| Native settings loading parses an existing document and creates defaults only when the file is missing              | Absence, decoding failure, and initial persistence are separate outcomes.                                                                                    |
| Renderer and native settings both represent runtime, model, and generation groups                                   | Matching field names alone do not prove matching domains, defaults, or validation.                                                                           |
| The renderer's settings setter replaces in-memory state, while a separate native command writes settings            | Editing, command acceptance, persistence, and runtime application are different stages. The current save adapter also documents an argument-shape mismatch.  |
| A chat request reads temperature and reply ceiling once from a narrow settings projection                           | The request has a concrete sampling point; a later edit can affect a subsequent request without changing the admitted request.                               |
| A backend-address setting exists while the chat transport uses a fixed address                                      | Storing or displaying a setting does not prove that its intended consumer applies it.                                                                        |
| Theme application and its browser-storage write have separate failure behavior                                      | A locally applied appearance is distinct from an acknowledged saved preference. This does not authorize silent recovery from invalid required configuration. |
| Backend service tests inject configuration and inspect factory inputs                                               | Observing actual derived endpoints and paths gives evidence that configuration reaches composition; it does not test external parsing or persistence.        |

The relevant sources are the [backend configuration declaration](../../apps/backend/src/config.ts), [backend startup](../../apps/backend/src/index.ts), [service composition](../../apps/backend/src/di/singleton.ts), [native settings loading and persistence](../../apps/desktop/src-tauri/src/settings.rs), [native settings commands](../../apps/desktop/src-tauri/src/settings/commands.rs), [renderer settings types and initial values](../../apps/desktop/src/lib/store/settings.ts), [renderer settings adapter](../../apps/desktop/src/lib/apis/tauri/settings.ts), [application settings state](../../apps/desktop/src/lib/store/index.ts), [chat request sampling](../../apps/desktop/src/lib/store/chat-view/index.ts), [chat transport](../../apps/desktop/src/lib/apis/http/chat.ts), [theme behavior](../../apps/desktop/src/app/theme.ts), and [service composition tests](../../apps/backend/test/di/singleton.test.ts).

Two platform examples illustrate why decoding remains explicit:

- Node's environment-file parser produces strings even when the input resembles a number, boolean, or structured value. Typed settings still need domain decoding. See [Node.js variable values](https://nodejs.org/api/environment_variables.html#variable-values).
- JSON implementations can handle duplicate object names differently. A configuration contract therefore cannot infer a portable duplicate policy from successful JSON parsing alone. See [RFC 8259, section 4](https://www.rfc-editor.org/rfc/rfc8259.html#section-4).

These platform examples illustrate the rules; they do not add a required source format or parser dependency.
