# Schema and Migration

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines how schema declarations establish usable contracts and how changes to representations and stored data preserve those contracts through validation, migration, failure, and deployment.

## Definition and scope

A **schema** is an authoritative description of an accepted or emitted representation and its enforceable invariants. It may describe a request, response, event, settings document, database relation, import, export, or other named boundary. A runtime validator, generated decoder, database constraint, and static type can express different parts of that contract; their presence alone does not prove that the complete boundary enforces it.

A **representation version** identifies the contract used to interpret data. A **migration** is a named, ordered transition from an identified supported representation or storage state to another. It may change structure, stored values, constraints, indexes, triggers, or their meaning. A **backfill** populates or converts existing records as part of such a transition. A **migration history** or version marker records completed transitions; it is not proof that unrelated state, application deployment, or external effects also changed.

A **reader** interprets a representation; a **writer** produces or updates it. Compatibility is a relationship between particular readers, writers, versions, and operations. A **cutover** makes a prepared representation authoritative for its consumers. Transaction rollback, application downgrade, restoring a backup, and compensating for committed effects are different recovery operations.

The rules apply to repository-owned schemas, schema composition and generation, validators, codecs, storage definitions, migration declarations and runners, backfills, version adapters, and directly affected readers and writers. They apply to both persisted data and serialized boundaries that can outlive their producer. Ordinary domain operations do not become migrations merely because they update a record.

This chapter does not require a particular schema library, database, ORM, migration framework, metadata table, checksum format, inline version field, online rollout, dual writes, universal transaction, or downgrade implementation. A supported offline migration may remain offline. A storage migration is not required for a purely internal type refactor that changes no stored or serialized contract.

Tests and fixtures also follow [Test and Fixture](./TEST.md). Comment construction also follows [Comment](./COMMENT.md). Schema and migration documentation retains the requirements in this chapter.

## Existing rule ownership

Each active standard retains its exact triggers, mandatory requirements, and permitted cases. This chapter connects schema enforcement and representation evolution without replacing those owners.

| Concern                                                                                                    | Authoritative rule or document                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact domains, absence, validation authority, compatibility, refinements, units, and recursive values      | `TYPE-002` through `TYPE-009`, `TYPE-017`, `TYPE-020` through `TYPE-025` in [Type](./TYPE.md)                                                             |
| Complete immutable values, explicit source merging, and narrow invariant-preserving patches                | `OBJECT-007` through `OBJECT-024` in [Object](./OBJECT.md)                                                                                                |
| Named serialization, allowlisted properties, trust, round trips, version dispatch, and canonical encoding  | `OBJECT-039` through `OBJECT-046` in [Object](./OBJECT.md)                                                                                                |
| Callable naming, input trust, defaults, effects, and completion                                            | `FUNC-003`, `FUNC-007` through `FUNC-017` in [Function](./FUNCTION.md)                                                                                    |
| Default ownership, pure initialization, and meaningful limits                                              | `CONST-007` through `CONST-011` in [Constant](./CONSTANT.md)                                                                                              |
| Stateful owners, pure constructors, readiness, mutation, and failure-safe lifecycle                        | [Class](./CLASS.md) and [Interface](./INTERFACE.md)                                                                                                       |
| Import effects, explicit startup, and module boundaries                                                    | [Module and File](./MODULE.md)                                                                                                                            |
| Declared build inputs, generated artifacts, dependency compatibility, and distribution                     | [Package and Dependency](./PACKAGE.md)                                                                                                                    |
| External contracts, authorization, serialization, and consumer compatibility                               | [API](./API.md)                                                                                                                                           |
| Historical messages, delivery, replay, and event compatibility                                             | [Event and Message](./EVENT.md)                                                                                                                           |
| Failure classification, partial effects, recovery, retry, and safe diagnosis                               | [Error](./ERROR.md)                                                                                                                                       |
| Task ownership, cancellation, ordering, bounded work, and shutdown                                         | [Async Task and Stream](./ASYNC.md)                                                                                                                       |
| Actual target identity, preparation, replacement, commit versus release, temporary artifacts, and capacity | `RESOURCE-009`, `RESOURCE-010`, `RESOURCE-025`, `RESOURCE-029` through `RESOURCE-032`, `RESOURCE-036` through `RESOURCE-039` in [Resource](./RESOURCE.md) |
| Settings resolution, application, persistence, stored versions, and meaningful user choices                | `CONFIG-008` through `CONFIG-014`, `CONFIG-024` through `CONFIG-039`, `CONFIG-049` through `CONFIG-052` in [Configuration](./CONFIGURATION.md)            |
| Documentation, compatibility changes, exceptions, and validation workflow                                  | [JSDoc Standard](../JSDOC.md) and [Contributing to Lys](../../CONTRIBUTING.md)                                                                            |

The words parse, decode, validate, migrate, backfill, and reconcile describe concepts; they do not extend the repository-designed function verbs allowed by `FUNC-003`. An externally imposed declaration retains its existing exception. Schema transformations and migrations retain explicit property construction under `OBJECT-021` through `OBJECT-024`; a schema library does not permit blind merging or unrestricted patches.

Schema loading or migration does not permit hidden import effects under `CONST-007` or `MODULE-028`, effectful constructors, or fallible lazy initialization under the Class rules. Direct constructors retain the supplied-value validation and rejection permitted by `CLASS-010`. Existing implementations used as examples do not create exceptions. Any necessary exception follows [Contributing to Lys](../../CONTRIBUTING.md).

## Construction process

Before adding or changing a schema or migration:

1. Identify the named boundary, authoritative contract, actual enforcement point, readers, and writers.
2. Trace raw input, decoding, normalization, validation, mapping, and publication.
3. Account for presence, defaults, units, relationships, unknown fields, and intentional information loss.
4. Identify representation versions, supported compatibility directions, and existing persisted states.
5. Define the exact source-to-target transition, preconditions, postconditions, and migration identity.
6. Trace storage ownership, concurrency, transaction limits, version recording, and publication.
7. Define interruption, retry, partial completion, data preservation, and recovery behavior.
8. Account for populated data, concurrent writers, temporary capacity, and any rollout or cutover.
9. Verify historical fixtures, actual storage behavior, and affected consumers through supported boundaries.
10. Record the resulting compatibility contract and validation limits with the change.

## Mandatory rules

### Schema contracts and enforcement

### SCHEMA-001 — Every schema serves an identified boundary

A schema MUST identify its domain meaning, represented operation, owning contract, and actual consumer. Its name and location MUST make clear whether it describes raw accepted input, normalized output, a public representation, or stored data.

A declaration that is never applied MUST NOT be presented as an enforced boundary. A schema MUST NOT combine unrelated entities or operations merely because they share fields. A generic schema registry or reusable base requires an actual shared contract rather than hypothetical future use.

### SCHEMA-002 — Schema authority includes its effective enforcement

Static and runtime representations MUST retain the authority required by `TYPE-009`. Generated projections, native declarations, storage mappings, and runtime validators MUST have a traceable relationship to the contract they implement.

The boundary MUST account for the effective validator configuration, custom refinements, compiler or generator behavior, and adapter invocation needed to enforce that contract. A keyword accepted by a schema tool but ignored during validation MUST NOT be counted as a checked invariant. Generator and schema dependencies retain the Package rules.

### SCHEMA-003 — Different representations have deliberate mappings

Request, response, stored-row, settings, and internal-value schemas MUST expose only their intended contract under `OBJECT-039` and `OBJECT-040`. Reuse is permitted only where the complete meaning and invariants agree.

Creation, replacement, and patch inputs MUST remain distinguishable when their required fields, authority, or absence meanings differ. A broad partial form of the current stored value MUST NOT substitute for the named operation required by `OBJECT-023`. Renamed fields and different units require an explicit boundary mapping.

### SCHEMA-004 — Validation completes the declared trust boundary

The schema path MUST identify which stages establish syntax, representation validity, domain invariants, and relationships under `TYPE-008` and `OBJECT-042`. Successful parsing of a shape MUST NOT be described as validation of checks performed only later or nowhere.

A boundary MAY divide validation across named stages, but only the result whose complete promised invariant has been established may be published as trusted. A generated decoder or database row type MUST NOT bypass a required domain check.

### SCHEMA-005 — Presence and defaults preserve the contract's meaning

Schema optionality, nullability, serializer omission, and defaults MUST implement the authoritative absence contract. Missing, explicit null, empty text, zero, and false MUST NOT be treated as interchangeable merely because a tool permits it.

Defaults retain the Constant, Function, Object, and Configuration rules. They MUST NOT turn corrupt required input into a valid-looking current record. Changing a default or making a field optional MUST account for existing readers, writers, and historical data that relied on the previous meaning.

### SCHEMA-006 — Decoding and normalization are explicit transformations

A schema that coerces, trims, normalizes, decodes, or otherwise transforms input MUST define its accepted source forms, output domain, failure behavior, and any intentional information loss. Validation MUST establish the invariant of the transformed result.

Locale, timezone, rounding, whitespace, case, and encoding behavior MUST NOT depend accidentally on the executing host. A many-to-one transformation MUST account for identity and uniqueness collisions. Parser acceptance alone MUST NOT establish a canonical representation under `OBJECT-046`.

### SCHEMA-007 — Scalar constraints survive each representation boundary

Schema mappings MUST preserve the units, ranges, precision, formats, and special-value behavior required by the Type and Object rules. Numeric storage or decoding MUST account for the exact representable domain on both sides.

A valid integer in one runtime MUST NOT silently round in another. A timestamp or identifier stored as text MUST NOT lose its format or identity contract. Narrowing a range, changing precision, or converting an encoding MUST be evaluated as a compatibility change for existing values.

### SCHEMA-008 — Variant selection is unambiguous

Closed variants MUST preserve their authoritative discriminant under `TYPE-006`. A schema MUST validate the selected variant's required and forbidden combinations rather than accept a mixture of independently optional variant fields.

Overlapping alternatives MUST NOT let evaluation order choose a different domain meaning. Representation-version dispatch retains `OBJECT-045`; trying current and historical schemas until one accepts is prohibited. Selecting a schema does not eliminate validation of the selected representation.

### SCHEMA-009 — Schema composition preserves every promised invariant

Extending, selecting, omitting, intersecting, or specializing a schema MUST account for cross-field refinements, discriminants, unknown-field policy, defaults, and transformations. The result MUST satisfy its own named contract and any substitutability promise under `TYPE-016` and `TYPE-025`.

A derived shape MUST NOT silently drop a refinement because the schema operation copied only fields. Shared fragments MUST remain cohesive and authoritative. An intentionally different boundary requires its own explicit contract rather than an assertion that the original invariant still holds.

### SCHEMA-010 — Key handling is enforced before information is lost

Unknown properties retain the default rejection and narrow forward-compatibility case in `OBJECT-042`. Duplicate names, normalized-name collisions, and dynamic keys MUST have an explicit policy where the input format can express them.

If the contract rejects duplicates, the processing stage that still observes them MUST enforce that rejection. A decoded map that has already discarded earlier entries cannot prove the original representation was unambiguous. Accepted extra fields MUST NOT leak into trusted internal objects or unauthorized output.

### SCHEMA-011 — Relational invariants hold at the mutation boundary

Schemas MUST account for the relationships their contract promises, including coupled fields, uniqueness, references, ordering, and permitted state combinations. The implementation MUST identify the owner and enforcement point for checks that require existing state.

A preliminary lookup MUST NOT be the sole protection for a cross-record invariant when another writer can invalidate it before mutation. Applicable storage constraints, transactions, conditional writes, or another supported coordination mechanism MUST cover the actual shared boundary. This does not require every layer to repeat every check.

### SCHEMA-012 — Structural validity does not establish authority or freshness

A validated identifier, path, URL, reference, or version MUST NOT itself grant permission to access or change its target. A structurally valid record MUST NOT prove that its referenced resource still exists or that an earlier entitlement remains valid.

State-dependent authorization, availability, and mutation checks retain the API, Function, and Resource rules at their actual use boundary. A validator that performs external work MUST declare that effect and its owner; it MUST NOT conceal a mutation behind a pure-validation claim.

### SCHEMA-013 — Validation work is bounded and controlled

Validation of untrusted input MUST bound the work its accepted representation can induce, including applicable size, collection count, nesting, recursion, pattern matching, expansion, and reference traversal. Limits MUST apply before or during the expensive stage they protect.

External schema references, includes, custom code, or remote lookups MUST use explicitly supported trusted sources and retain their dependency, authority, and lifecycle contracts. Input MUST NOT select arbitrary executable code or an unbounded network traversal. A recursion-safe type alone does not bound decoding costs.

### SCHEMA-014 — Consumers use the validated result

When validation transforms or projects input, consumers MUST receive that validated result. Validating one value and then storing, returning, or acting on the original untrusted value is prohibited.

Validation and use MUST operate on a coherent value whose invariant cannot be invalidated by an uncontrolled mutation between those stages. Published results retain the Object immutability and alias rules. A successful validation cached for one value, version, or policy context MUST NOT authorize a different one.

### SCHEMA-015 — Emitted representations satisfy their actual contract

A producer MUST establish that the representation it emits satisfies the selected output schema, including mappings, serializer behavior, discriminants, and cross-field invariants. Construction may establish this proof; redundant runtime parsing of an already proven immutable result is not universally required.

Tests and boundary validation MUST inspect what consumers actually receive. A typed producer value, installed request validator, or generated description alone MUST NOT prove response, event, export, or persistence conformance. Intentional projections retain their declared round-trip limits under `OBJECT-044`.

### SCHEMA-016 — Storage constraints use the engine's actual semantics

A storage schema MUST express the constraints and referential behavior on which its readers and writers rely. Null handling, type conversion, comparison, collation, uniqueness, generated values, and constraint activation MUST be checked against the actual storage engine and connection setup.

An application validator MUST NOT be presented as protection against writers that bypass it. Conversely, a declared storage type or constraint MUST NOT be presented as proof of a stronger domain invariant it does not enforce. Disabled or deferred checks retain an explicit enforcement obligation before success is claimed.

### SCHEMA-017 — Validation failures identify the failed boundary

Validation failures MUST distinguish applicable decoding, unsupported-version, representation, domain, and mapping failures. An unavailable dependency, failed storage read, or programming defect MUST NOT be relabeled as malformed user input merely because it occurred during validation.

Errors MUST provide actionable safe context under the Error rules without dumping sensitive records, credentials, or entire submitted documents. Failed validation MUST NOT publish partial trusted objects, silently substitute required data, or report an empty successful result.

### Version identity and migration planning

### SCHEMA-018 — Version identity precedes version-specific interpretation

Long-lived data retains the exactly identifiable version required by `OBJECT-045`. The processing boundary MUST establish that identity before interpreting version-specific fields, using the declared envelope, marker, or authoritative protocol boundary.

A minimal version-selection representation MAY be decoded first; that is not validation of the complete payload. Missing fields, a successful trial parse, the currently installed application version, or a filename without a declared identity contract MUST NOT stand in for the stored representation's version.

### SCHEMA-019 — Compatibility is assessed in each supported direction

A schema change MUST identify which old and new readers consume which old and new writers or stored versions. Assessment MUST include value meaning and allowed operations, not only whether a parser accepts the shape.

Relevant changes include requiredness, unknown fields, enum alternatives, defaults, units, precision, normalization, uniqueness, and relationship constraints. Adding an optional field is not automatically compatible with a strict older reader. Widening a writer's output domain can break an unchanged consumer even when the new reader accepts more input.

### SCHEMA-020 — Supported versions and downgrade limits are explicit

A boundary MUST define which versions it may read, write, migrate, or refuse. A read-only compatibility mode MUST NOT accidentally perform initialization, normalization writes, history updates, or unsupported format replacement.

An older program encountering a newer unsupported representation MUST fail explicitly before modifying that representation. Downgrade support MUST NOT be implied by the existence of forward migrations or a reversible-looking schema change. Required breaking changes and migration paths retain the approval and compatibility workflow in Contributing to Lys.

### SCHEMA-021 — Structural and data changes are assessed together

A migration proposal MUST identify changes to stored values and observable storage behavior as well as structural changes. Constraints, defaults, indexes, triggers, generated columns, reference actions, and encoding rules are part of that assessment where they affect the contract.

Changing an application type or current schema declaration MUST NOT be treated as updating existing data. Conversely, a purely internal representation refactor MUST NOT trigger an unnecessary storage rewrite. Every planned migration must have an actual source-state change to perform.

### SCHEMA-022 — Applied migration identities remain stable

Once a migration may have been applied to a supported persistent store, its identity, ordering meaning, and completed effects MUST remain reproducible. Corrections to already-applied history MUST use a new explicit transition or a documented supported history-conversion procedure.

Reordering an indexed migration array, reusing an old identifier, or editing applied SQL so fresh and upgraded stores silently diverge is prohibited. Squashing history requires preservation of supported upgrade paths and verifiable equivalence. A particular filename, checksum, or metadata-table format is not mandatory.

### SCHEMA-023 — Migration paths are named, ordered, and complete

Each migration MUST identify its accepted source state, intended target state, dependencies, and postconditions. The runner MUST select one supported ordered path and reject missing, conflicting, ambiguous, or unsupported transitions before relying on their result.

Ordering MUST NOT depend on incidental filesystem enumeration or lexical sorting that does not implement the declared version order. A branched history requires an explicit reconciliation contract. A simple linear history does not require a general migration graph or registry.

### SCHEMA-024 — Version markers and actual storage state agree

The runner MUST establish the preconditions needed by the selected migration against the intended store. A current marker MUST NOT conceal a known incompatible structure, incomplete prior transition, or history from a different storage contract.

The required verification may follow from controlled history or explicit state checks; inspecting every object on every startup is not universally required. When an operation encounters unexpected existing structures or drift, it MUST reject or use a named recovery path. Broad existence guards MUST NOT turn an incompatible object into a successful migration.

### SCHEMA-025 — Migration execution has an explicit owner and entry point

The component responsible for migration MUST own its selected target, execution, result, and cleanup through the actual completion boundary. Importing a schema or model module MUST NOT start storage modification.

Required migrations and schema-dependent preparation MUST complete before the corresponding capability is published as ready under the Class, Interface, Module, and Resource rules. A startup migration may be supported without requiring a separate executable, but it does not permit effectful constructors or fallible lazy initialization. Direct constructor validation retains `CLASS-010`.

### SCHEMA-026 — Initial creation is distinguished from existing data

Creating a new store MUST establish that the target is eligible for initialization through its actual acquisition and mutation boundary. A missing marker, version zero, unreadable file, or failed schema query MUST NOT by itself authorize clearing or replacing existing data.

Existing unversioned data requires an explicitly identifiable legacy contract and supported transition when it must be retained. Initialization MUST NOT overwrite a store created by another actor after an earlier absence check. Settings initialization also retains `CONFIG-035`.

### SCHEMA-027 — Migration code and inputs remain controlled

Migration definitions MUST come from the declared repository or explicitly supported trusted delivery boundary. Stored data may supply values to a defined transformation; it MUST NOT choose arbitrary executable migration code, SQL fragments, or schema definitions.

Dynamic values and identifiers MUST use the actual engine's safe binding or explicit allowlist contract as applicable. File, database, namespace, and tenant selection MUST remain within the operation's authority. A development convenience MUST NOT broaden the production migration target or privileges.

### SCHEMA-028 — The migration plan states its failure and recovery boundary

Before a migration can change persistent state, its contract MUST identify what is atomic, what may remain after interruption, how progress is established, and which supported recovery path owns an incomplete result.

The plan MUST distinguish retry, transaction rollback, forward repair, application downgrade, backup restoration, and compensation where they differ. It MUST NOT promise universal reversibility. A small transaction may provide a small complete recovery contract; unrelated irreversible systems do not become transactional because a database migration coordinates them.

### Execution, interruption, and data preservation

### SCHEMA-029 — Coordination covers every competing migrator

When multiple actors can migrate the same store, coordination MUST prevent incompatible transitions from executing concurrently at that shared boundary. The authoritative source version MUST be read or revalidated within the protection that authorizes the transition.

A process-local flag does not serialize other processes. Lock expiry or a timed-out caller does not prove an old migrator stopped writing. Lease-based coordination MUST fence obsolete writers or otherwise preserve the required non-overlap under `RESOURCE-038`. No distributed lock is required for an actually exclusive local owner.

### SCHEMA-030 — Preconditions remain valid through execution

A migration MUST act on the target and source state for which its preconditions were established. If a plan, preview, backup, or validation was prepared earlier, execution MUST preserve or re-establish the relevant identity, version, and concurrency facts before mutation.

A successful dry run MUST NOT be presented as proof of later write authority, available capacity, or unchanged data. Changes between planning and execution MUST produce a supported conflict or a newly validated plan, not silent application to a different target.

### SCHEMA-031 — Atomicity includes schema, data, and completion records

Within a promised atomic migration unit, schema effects, transformed data, and the completion marker MUST commit or roll back together through a mechanism that actually covers them. The runner MUST account for transactional DDL support, implicit commits, connection boundaries, and operations that cannot join the transaction.

If the complete transition cannot be atomic, its phases MUST expose recoverable intermediate states and truthful progress. An external write, emitted message, copied file, or remote command MUST NOT be described as rolled back merely because the local database transaction failed.

### SCHEMA-032 — Completion is recorded only for established postconditions

A migration may be recorded as completed only when its required structure, data, constraints, and conversion postconditions have been established. Inside an atomic unit, the marker may be written before commit, but success MUST await that unit's actual commit result.

The runner MUST distinguish a completed step from a completed multi-step migration and from an application cutover. Recording the target version before all required steps and postconditions succeed, swallowing failed steps to continue as if they succeeded, or recording attempted work as completed is prohibited. A fully atomic transition MAY record its final version once after all required steps succeed. Commit uncertainty retains the Error and Resource outcome contracts.

### SCHEMA-033 — Failure preserves actual transaction and storage state

After failure, the runner MUST determine and handle the transaction state that the platform actually exposes. It MUST NOT assume every error either rolled back all prior statements or left the whole transaction active.

Required rollback and cleanup MUST preserve the initiating failure and any additional failures under the Error rules. Failed or uncertain cleanup MUST NOT restore a false ready state. The result MUST identify whether the prior state remains usable, a committed prefix remains, or recovery must resolve an uncertain outcome.

### SCHEMA-034 — Restart follows established progress

Rerunning after interruption MUST use the actual completed history and supported partial-state contract. A committed step MUST NOT repeat an irreversible transformation merely because its caller did not observe success.

The implementation MUST establish safe re-entry through atomic progress, idempotent steps, conditional transitions, or explicit reconciliation as appropriate. Every SQL statement need not be independently idempotent inside a fully rolled-back transaction. Conversely, existence checks alone MUST NOT hide partially transformed data or a missing required effect.

### SCHEMA-035 — Cancellation retains the migration's remaining obligations

Cancellation and shutdown MUST occur through the supported interruption boundary and retain ownership of pending work, rollback, completion recording, and cleanup. Stopping observation MUST NOT abandon an executing migration or its eventual storage effects.

A cancellation result MUST NOT imply that no changes committed when the commit boundary may already have passed. A non-interruptible step requires an owner until it settles and a truthful eventual or uncertain outcome. Subsequent actors MUST NOT enter conflicting work solely because an earlier wait timed out.

### SCHEMA-036 — Backfill values have an explicit derivation

A data transformation MUST define how each target value is derived from identified source data and any permitted additional input. Required identity, timestamps, permissions, or business facts MUST NOT be invented merely to satisfy the target schema.

When time, randomness, generated identifiers, or an external lookup are legitimately required, their meaning and retry behavior MUST be explicit. Resuming or repeating a supported unit MUST NOT silently change previously established identities or outcomes. A current application default is not automatically the historical meaning of an absent value.

### SCHEMA-037 — Legacy and invalid records have a declared treatment

A migration MUST interpret existing records through their supported source contract and establish the target invariant before successful publication. It MUST define the outcome for source values that cannot be converted, including malformed records, collisions, missing dependencies, or out-of-domain historical values.

Failing the migration, retaining an unchanged source, or an explicitly supported quarantine or lossy conversion may be appropriate to the approved contract. Silently dropping, clamping, resetting, or skipping records to make the migration pass is prohibited. Accepted data outside a narrow projection requires a preservation policy before rewriting its broader document.

### SCHEMA-038 — Identity and relationships survive conversion deliberately

A migration MUST preserve the identity and relationships promised by its source-to-target contract. Rekeying requires an explicit mapping that consistently updates every affected reference, uniqueness constraint, ordering key, and external binding within the supported scope.

Copying rows MUST NOT accidentally create new domain entities, break parent-child relationships, or collapse distinct values after normalization. Counts alone do not prove preservation. Intentional aggregation or identity changes require the declared different representation and compatibility treatment under the Object and Type rules.

### SCHEMA-039 — Storage replacement preserves the full required contract

A table rebuild, file conversion, or equivalent replacement MUST carry forward or intentionally change every relevant constraint, index, trigger, reference action, generated value, and storage property. Copying visible fields alone does not establish equivalent behavior.

Candidate storage and intermediate artifacts retain Resource ownership, capacity, replacement, and cleanup rules. The previous usable source MUST remain protected until the promised replacement boundary is established. Connection settings or temporarily deferred checks MUST be restored or completed as required before the resulting store becomes available.

### SCHEMA-040 — Destructive changes serve an explicit approved requirement

Dropping data, narrowing representable values, discarding information, or removing a supported interpretation MUST be part of the requested change and its compatibility assessment under Contributing to Lys. The affected data and consumers MUST be identified before the destructive boundary.

A failed load, unfamiliar version, or troublesome migration MUST NOT trigger automatic deletion and recreation as error recovery. A lossy transition MUST state what cannot be recovered and how that consequence is handled. Development reset procedures MUST remain separate from supported persistent-data upgrades.

### SCHEMA-041 — Recovery copies provide the guarantee actually required

When the recovery plan relies on a backup, snapshot, or retained source, the operation MUST establish that it covers the required consistent state and can be restored through a supported procedure. Copying a filename or observing that an artifact exists is insufficient proof.

The plan MUST account for relevant companion data, encryption or access requirements, target version, and writes made after the recovery point. Restoration MUST NOT silently discard later accepted work or overwrite an unrelated target. Recovery artifacts retain their confidentiality, retention, and cleanup obligations; not every additive atomic migration requires a new backup system.

### SCHEMA-042 — Batched migration progress cannot skip or duplicate work

A migration performed in batches MUST define a stable traversal, boundary keys, checkpoint meaning, and treatment of records inserted, changed, or deleted during the operation. Updating a traversal key MUST NOT make later batches miss or repeat records accidentally.

Checkpoints MUST correspond to established effects through the promised atomic or recoverable boundary. The final batch or an empty page MUST NOT by itself prove every required record was converted. Resumption MUST preserve the declared result under the actual retry and concurrent-write policy.

### SCHEMA-043 — Migration cost respects the supported operating boundary

A migration MUST account for applicable data volume, lock duration, transaction growth, temporary space, overlapping copies, and memory use. Work that can grow beyond the supported operating budget MUST be bounded, staged, or assigned an explicit offline maintenance boundary.

Performance and capacity claims MUST use relevant evidence when feasible, including representative populated data. A tiny empty-store test does not establish production-size behavior. A migration MUST NOT introduce busy retry loops or claim continuous availability without validating its actual blocking and coordination behavior.

### Rollout and continuing readers

### SCHEMA-044 — Deployment order preserves the compatibility window

When readers or writers of different versions can overlap, the change MUST define which combinations are supported throughout deployment and how incompatible combinations are prevented. New writers MUST NOT emit a representation before every required reader or gate can handle it.

An expand, migrate, then remove sequence is appropriate only when it establishes the needed compatibility. An explicitly coordinated offline transition may be simpler. A schema being present MUST NOT be treated as evidence that a required backfill, application deployment, or feature activation is complete.

### SCHEMA-045 — Concurrent application writes follow the migration contract

If ordinary writes continue during a migration, their interaction with old data, converted data, and the target representation MUST be defined. The design MUST prevent a backfill from overwriting newer accepted work or leaving writes stranded only in the retired representation.

Quiescence, conditional updates, change capture, dual writes, or another supported mechanism MAY provide this guarantee. Dual writes alone do not prove atomicity or eventual agreement when one write fails. Reconciliation and the final cutoff MUST cover the actual writer population and promised consistency.

### SCHEMA-046 — Cutover follows complete readiness

Before consumers switch to the target representation, the owner MUST establish the required conversion, constraints, references, and dependent preparation. Relevant prepared statements, cached projections, handles, and long-lived readers MUST follow their actual invalidation or replacement protocol.

Cutover MUST define the point after which new work uses the target and the treatment of already admitted work. A completed database step, saved desired version, or updated in-memory flag MUST NOT falsely imply that every consumer has switched. Required resource preparation retains `RESOURCE-010` and `RESOURCE-025`.

### SCHEMA-047 — Per-record conversion has an explicit read and write contract

When conversion happens on access, the boundary MUST identify the record's source version, selected transformation, resulting trusted contract, and whether the read also persists an upgrade. A read-only API MUST NOT hide a migration write.

Concurrent conversion and ordinary edits MUST preserve accepted changes through the actual conditional or serialized boundary. This pattern MUST NOT defer initialization required for an owner to be ready or weaken the Class prohibition on fallible lazy initialization. Unvisited records remain historical data that later maintenance and compatibility decisions must account for.

### SCHEMA-048 — Historical representations retain their recorded meaning

Queued events, stored messages, exports, snapshots, and caches MUST retain their authoritative version and source meaning across supported reads. An adapter may produce the current internal value only through the declared validated conversion path.

Replaying an old event through a current shape MUST NOT invent a new historical fact or imply that a domain action occurred again. Rewriting an authoritative history requires its own explicit migration contract. Regenerating a disposable cache is permitted only when its declared ownership, source availability, and invalidation semantics support that recovery.

### SCHEMA-049 — Removing compatibility accounts for retained data and consumers

Before removing an old reader, writer, field, or migration path, the change MUST establish that the declared support boundary permits its removal. Relevant consumers include offline installations, delayed messages, archived exports, recovery copies, and records not yet visited by lazy conversion.

A recently observed current deployment does not prove that all supported historical data disappeared. The contract MAY define finite support and retention windows, but their end and recovery consequences MUST be explicit. Removing code MUST NOT silently strand data the product still promises to read.

### Verification and operational evidence

### SCHEMA-050 — Migration diagnosis describes progress without exposing records

Migration outcomes MUST identify the relevant source and target versions, failed or completed phase, and actual recovery state. Counts, safe identifiers, and postcondition results SHOULD be available when needed to distinguish complete, partial, and uncertain progress.

Diagnostics MUST NOT dump row contents, secrets, personal data, or whole serialized documents. A migration marker or progress percentage MUST NOT claim guarantees beyond what it records. A simple local migration does not require a telemetry service or a universal audit framework.

### SCHEMA-051 — Schema tests exercise the effective acceptance contract

Schema verification MUST assert accepted outputs and rejected inputs through the actual boundary, including relevant presence, null, defaults, ranges, units, unknown or duplicate keys, variants, relationships, and transformations. Composed refinements and generated or configured validators MUST be checked where they can diverge from the declaration.

Tests MUST use untrusted representations for invalid inputs and observe the validated result that reaches the consumer. Calling a helper, type-checking an annotation, or snapshotting a schema declaration is not sufficient evidence. Cases are required only for behavior the boundary supports.

### SCHEMA-052 — Historical fixtures represent the version they claim

Migration fixtures MUST model actual supported historical structure and representative populated values, with their authoritative version identity. They MUST be isolated and free of real user data or secrets.

A fixture created solely through current declarations MUST NOT be labeled evidence of a historical upgrade path unless that equivalence is established. Fixtures MUST preserve enough original representation to expose renamed fields, old defaults, constraints, and conversion edge cases. Current production invariants MUST NOT be bypassed to fabricate trusted invalid objects.

### SCHEMA-053 — Migration tests prove supported paths and retained behavior

Verification MUST cover each supported starting version or explicitly justified equivalent path, including already-current input when accepted. Unsupported newer and otherwise unrecognized versions MUST exercise their promised refusal behavior. For persistent stores, verification MUST also cover supported fresh creation and reopening of the current version.

Tests MUST inspect migrated data and the resulting constraints, indexes, triggers, mappings, and consumer operations where affected. When a migration changes stored state, reopening the migrated store MUST preserve the promised result. A target marker, table list, empty-database success, or unchanged row count alone MUST NOT establish a successful upgrade.

### SCHEMA-054 — Failure tests prove restart and coordination behavior

Migration verification MUST cover relevant failed steps, commit or rollback failure, interruption, repeat execution, partial progress, and competing actors through controlled ordering. Tests MUST observe the actual result available to the next consumer or invocation. Where the migration changes storage or acquires resources, assertions MUST also cover the relevant retained data, completion records, reopening behavior, and resource release.

For staged replacements and backfills, relevant cases include incomplete copies, failed cutover, stale checkpoints, conflicting writes, and owned-artifact cleanup. Mock success responses MUST NOT hide the storage boundary being claimed. Unverified crash, durability, or multi-process guarantees MUST be reported with their exact limits.

### SCHEMA-055 — Compatibility tests reach affected producers and consumers

A schema change crossing packages, languages, processes, or deployment versions MUST be verified through the affected serialization and consumption paths. Relevant old/new reader and writer combinations MUST exercise semantic results, not only similar field names or separate successful parses.

Tests MUST account for defaults, argument envelopes, emitted variants, storage mappings, and generation or build inputs where changed. Operational checks MUST match any supported capacity or availability claim. Passing schema unit tests MUST NOT stand in for a boundary that could not be verified.

### SCHEMA-056 — Documentation records the migration's supported contract

The authoritative declaration and change documentation MUST explain the relevant source and target versions, compatibility window, data transformation, preconditions, completion boundary, irreversible effects, and recovery behavior. Names and locations MUST make the ordered migration and its consumers discoverable.

Documentation MUST describe implemented behavior and the validation actually performed. It MUST NOT promise backup restoration, online migration, downgrade, or repair commands that do not exist. Rule ownership and declaration documentation remain with the existing standards rather than being copied into competing checklists.

## Repository boundary examples

These examples identify boundaries in the current source; they do not certify those implementations as compliant with this chapter or every active standard. Existing limitations are not exceptions for new or modified code.

| Observed boundary                                                                                                                                     | Schema and migration distinction                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversation storage keeps an ordered array of SQL migrations and uses its position as the version                                                    | Array order is persistent history; changing an applied entry can make fresh and upgraded stores disagree.                                                                                        |
| The migration runner acquires a write transaction before reading the version, applies pending changes, updates the marker, and commits                | Coordination, schema changes, and version recording have a concrete boundary; this does not prove general application writes or external effects are atomic.                                     |
| The store rejects a newer version and prepares statements after migration                                                                             | Supported opening versions and dependent preparation are explicit concerns. The existing constructor does not waive the active Class construction rules.                                         |
| Conversation tables define role checks, correlated assistant status and finish reason, indexes, and timestamp triggers                                | A storage schema contains behavioral invariants beyond its column names. Copying rows alone would not preserve the complete contract.                                                            |
| Shared conversation schemas constrain UUIDs and timestamps, while SQL enforces an assistant-state relationship not fully encoded in the runtime shape | Similar representations do not prove identical enforcement; each invariant needs a deliberate owner and consistent affected mappings.                                                            |
| Conversation metadata reads alias stored column names and validate the returned value                                                                 | A query result and its static type are separate from the trusted internal representation. Missing rows and invalid rows have different outcomes.                                                 |
| Conversation-list cursors carry a version and query binding                                                                                           | Versioned representation contracts extend beyond databases. The current decoder validates its shape before rejecting unsupported versions; its existence does not waive version-selection rules. |
| The chat route installs a shared request schema and the desktop validates decoded stream events                                                       | Schema changes affect real producers and consumers, including coercion, required fields, discriminants, and strict unknown-field handling.                                                       |
| Native settings initialize defaults when absent and deserialize existing JSON, but have no explicit format migration path                             | Defaults and current field names do not establish historical version identity or a failure-safe document migration. Configuration rules remain applicable.                                       |
| Service tests open an in-memory conversation store while the recovery runbook declares no supported repair procedure                                  | Fresh construction is useful evidence, but does not establish populated historical upgrades, restart recovery, or an operator repair capability.                                                 |

The relevant sources are the [conversation store and migration runner](../../apps/backend/src/di/services/conversationService/index.ts), [shared conversation schemas](../../packages/share/src/models/conversation.ts), [cursor encoding and decoding](../../apps/backend/src/di/services/conversationService/utils.ts), [chat protocol schemas](../../packages/protocol/src/apis/chat/chatRoute.ts), [backend chat registration](../../apps/backend/src/modules/chat/chat/index.ts), [desktop stream validation](../../apps/desktop/src/lib/apis/http/chat.ts), [native settings persistence](../../apps/desktop/src-tauri/src/settings.rs), [service composition tests](../../apps/backend/test/di/singleton.test.ts), and [current recovery-support statement](../../apps/docs/src/content/docs/operate/runbooks/recover-session-database.mdx).

Two platform examples illustrate why the effective storage behavior matters:

- SQLite allows a `CHECK` expression that evaluates to null and does not generally recheck constraints when a row is read. A declaration must therefore be assessed against the invariant it actually enforces. See [SQLite CHECK constraints](https://sqlite.org/lang_createtable.html#check_constraints).
- SQLite documents that some transaction errors may undo one statement or the entire transaction, and a busy commit can leave the transaction active. Recovery must follow the actual state and error contract. See [SQLite transactions](https://www.sqlite.org/lang_transaction.html).

These platform examples illustrate the rules; they do not prescribe SQLite for other boundaries or transfer its guarantees to another storage engine.
