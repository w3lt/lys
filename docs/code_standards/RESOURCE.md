# Resource

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines how a resource's acquisition, access, ownership transfer, and release obligations remain complete across the boundaries that use it.

## Definition and scope

A **resource** is a facility, reservation, registration, allocation, or external entity whose use carries an explicit lifetime or release obligation. Examples include open files, database connections, prepared operations tied to a connection, stream readers, locks, pool reservations, native buffers, timers, listener registrations, process handles, and owned temporary artifacts. An ordinary immutable value managed by the language does not become a resource merely because it occupies memory.

An **underlying resource** is the facility or entity being used. A **handle** is a concrete means of accessing it. A **descriptor** is data identifying or describing it. A **lease or share token** represents an entitlement to use a resource under an explicit lifetime contract. These can have different identities, owners, and release operations.

An **owner** carries a release obligation. A **borrower** receives permitted access while another owner retains that obligation. **Shared ownership** gives each participant an owned share or token while an identified mechanism controls the underlying resource's release. These meanings retain `CLASS-026`; multiple references alone do not establish shared ownership.

An **acquisition** establishes access and any associated obligations. A **transfer** changes which owner carries an obligation at a defined acceptance point. A **release** ends the obligation covered by its actual protocol. Releasing a lock, returning a pool lease, closing a handle, terminating work, committing data, and deleting an external object are distinct operations unless the contract explicitly combines them.

The rules apply to repository-owned acquisition paths, resource wrappers, borrowing and transfer boundaries, lifecycle integration, pools and resource caches, and release paths. External resources and language-managed owning values retain their actual platform contracts; repository adapters remain responsible for the guarantees they expose.

Lexical ownership may use an existing owning value, scope guard, deterministic disposal protocol, or supported framework lifecycle. This chapter does not require a new class per handle, universal resource interface, reference-counting scheme, lease manager, pool, registry, or diagnostics layer. A repository-defined stateful owner still follows the Class rules; a passive record cannot acquire hidden lifecycle behavior by being named a resource.

Configuration contracts also follow [Configuration](./CONFIGURATION.md). Schema contracts and migrations also follow [Schema and Migration](./SCHEMA.md). Tests and fixtures also follow [Test and Fixture](./TEST.md). Comment construction also follows [Comment](./COMMENT.md). Resource ownership and lifetime documentation retains the requirements in this chapter.

## Existing rule ownership

Each active standard retains its exact triggers and permitted cases. Resource rules connect existing lifecycle contracts across acquisitions, handles, borrowers, and receiving owners.

| Concern                                                                                                  | Authoritative rule or document                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callable purpose, naming, input ownership, authority, outcomes, effects, and dependencies                | `FUNC-001` through `FUNC-012` in [Function](./FUNCTION.md)                                                                                                                         |
| Completion ownership, lexical release or transfer, callbacks, documentation, and tests                   | `FUNC-017` through `FUNC-026` in [Function](./FUNCTION.md)                                                                                                                         |
| Valid representations, immutability, capability eligibility, authority, and compatibility                | `TYPE-002` through `TYPE-012`, `TYPE-017`, `TYPE-019`, `TYPE-020` in [Type](./TYPE.md)                                                                                             |
| Stateful owners, dependency graphs, construction, readiness, and memoization                             | `CLASS-001`, `CLASS-008` through `CLASS-012`, `CLASS-020` in [Class](./CLASS.md)                                                                                                   |
| Concurrency, ownership categories, cleanup protocol, terminal state, identity, and duplication           | `CLASS-023` through `CLASS-028`, `CLASS-033`, `CLASS-034` in [Class](./CLASS.md)                                                                                                   |
| Capability authority, synchrony, cancellation, readiness, returned resources, and mutable representation | `IFACE-014` through `IFACE-021`, `IFACE-024` in [Interface](./INTERFACE.md)                                                                                                        |
| Object roles, publication, mutable aliases, passive records, copying, and provider restrictions          | `OBJECT-005`, `OBJECT-013` through `OBJECT-017`, `OBJECT-025`, `OBJECT-047` through `OBJECT-054` in [Object](./OBJECT.md)                                                          |
| Explicit module startup, loading effects, application lifetime, and dependency placement                 | `MODULE-028` through `MODULE-033` in [Module and File](./MODULE.md), and [Package and Dependency](./PACKAGE.md)                                                                    |
| Renderer resource ownership, replacement, cleanup, and imperative bridges                                | `COMP-097` through `COMP-106` in [Component](./COMPONENT.md); `HOOK-026` through `HOOK-029`, `HOOK-035`, `HOOK-036` in [Hook](./HOOK.md)                                           |
| External authority, partial effects, cancellation, stream outcomes, and compatibility                    | `API-009`, `API-012` through `API-019`, `API-026` through `API-041` in [API](./API.md)                                                                                             |
| Failure meaning, retry permission, cleanup failures, terminal state, and diagnostics                     | [Error](./ERROR.md), especially `ERROR-024` through `ERROR-034`                                                                                                                    |
| Registration identity, subscription teardown, and native event lifetimes                                 | `EVENT-036` through `EVENT-040` in [Event and Message](./EVENT.md)                                                                                                                 |
| Task ownership, capacity, cancellation, late acquisition, shutdown, stream release, and verification     | [Async Task and Stream](./ASYNC.md), especially `ASYNC-003` through `ASYNC-007`, `ASYNC-010` through `ASYNC-030`, `ASYNC-031` through `ASYNC-044`, `ASYNC-047` through `ASYNC-052` |
| Documentation and change workflow                                                                        | [JSDoc Standard](../JSDOC.md) and [Contributing to Lys](../../CONTRIBUTING.md)                                                                                                     |

The words acquire, borrow, transfer, release, dispose, lease, and reclaim describe concepts; they do not add repository-designed function verbs to `FUNC-003`. Externally imposed signatures retain their existing exception. `CLASS-027` remains the authority for one repository-owned cleanup entry point and its deterministic, idempotent, complete behavior.

Platform constraints do not waive active rules. In particular, resource wrappers do not exempt unbounded waits from `IFACE-018`, permit fallible lazy initialization under `CLASS-012`, turn resource caching into pure memoization under `CLASS-020`, or make mutable published data compliant by renaming it a resource. Any necessary exception follows [Contributing to Lys](../../CONTRIBUTING.md).

## Construction process

Before adding or changing a resource boundary:

1. Identify the underlying resource, concrete handles, passive descriptors, and each release obligation.
2. Identify the owner, borrowers, shared participants, and authority each consumer requires.
3. Trace acquisition, initialization, registration, publication, and partial failure.
4. Establish the lifetime and release dependencies between parent resources and derived handles.
5. Define each borrow's validity and each transfer's acceptance and failure behavior.
6. Trace outstanding operations, aliases, callbacks, and retained views through replacement and shutdown.
7. Select the actual platform release protocol and determine what success or failure proves.
8. For shared, pooled, or cached resources, define capacity, reuse, invalidation, and final release.
9. Assess external authority, inherited handles, temporary artifacts, compatibility, and diagnostic exposure.
10. Verify the relevant acquisition, use, handoff, and release paths with observable resource outcomes.

## Mandatory rules

### Resource identity and responsibility

### RESOURCE-001 — Every managed resource has a defined obligation

A resource boundary MUST identify what is acquired and which obligations that acquisition creates. The underlying resource, its access handle, and any reservation, registration, or share token MUST be distinguished when releasing one does not release the others.

The contract MUST make clear what ends each obligation and which outcomes leave it outstanding. Returning loaded data, a status snapshot, or an identifier MUST NOT imply transfer of an open handle or authority over the represented entity. Resource machinery MUST NOT be added to ordinary values without an actual lifetime concern.

### RESOURCE-002 — Every obligation has one accountable ownership path

Ownership MUST follow `FUNC-018`, `IFACE-020`, and the owned, borrowed, or shared categories of `CLASS-026` where applicable. At each handoff, the implementation MUST be able to identify which scope or owner remains responsible for every outstanding obligation.

An obligation MUST NOT disappear because a reference is overwritten, a container entry is removed, or a caller stops observing it. Multiple handles or wrappers MUST NOT silently create multiple exclusive owners of one release obligation. Shared ownership requires a real mechanism governing the underlying lifetime, not a label applied to otherwise uncoordinated references.

### RESOURCE-003 — The resource representation preserves construct ownership

A repository-defined resource controller retaining state, dependencies, invariants, or a lifecycle MUST use the owner required by the Class, Type, and Object standards. A dependency record, provider object, or captured closure MUST NOT hide an independent resource owner that those standards require to be explicit.

Existing native owning values, lexical guards, and renderer-provided lifecycle protocols MAY be used under their applicable rules without a speculative wrapper. The choice MUST still make the owner and release path visible at the boundary. A passive record may carry a permitted capability; that does not make the record the capability's lifecycle owner.

### RESOURCE-004 — Use authority and lifecycle authority are separate

A consumer MUST receive only the operational and lifecycle authority justified by its responsibility, applying `IFACE-019` and the existing dependency rules. A borrower MUST NOT gain the right to close a shared client or application service merely because it can use that service.

When different owners need operational and cleanup capabilities, the boundary MUST preserve that distinction through its supported contract. A signal, status value, or immutable descriptor MUST NOT be treated as a cancellation, disposal, or deletion capability. Hiding a method in documentation alone is insufficient if ordinary consumers can invoke it through the supported surface.

### RESOURCE-005 — Resource access preserves its permission boundary

Acquisition and delegation MUST preserve the access modes and authority required by the operation. A resource opened for one principal, scope, transaction, or tenant MUST NOT be reused across another boundary without the applicable authorization and isolation contract.

A wrapper MUST NOT silently broaden access, retain unnecessary privileged handles, or expose a raw mechanism that bypasses a narrow capability's restrictions. Resource ownership does not replace API authorization, and permission to observe an external entity does not imply permission to destroy it. Security-sensitive handle metadata remains governed by the existing disclosure rules.

### RESOURCE-006 — A release targets the acquired resource incarnation

Release and replacement logic MUST identify the actual acquisition or lease it owns when a path, key, pointer, descriptor number, process identifier, or pool slot can be reused. Equal lookup keys MUST NOT authorize stale cleanup to release a newer resource.

The implementation MUST retain an appropriate owning handle, registration identity, generation, or other mechanism supported by the boundary. Universal identifiers are not required where lexical ownership already proves the target. A passive snapshot of identity MUST NOT be presented as proof that the corresponding resource remains live or exclusively owned.

### RESOURCE-007 — Lifetime dependencies form a valid ownership graph

Resource ownership and retained dependencies MUST preserve the acyclic graph required by `CLASS-009`. A dependent resource MUST NOT outlive the provider it needs for valid use or release unless the provider contract explicitly supplies an independent retained lifetime.

Strong back-references, cleanup callbacks, and shared-token relationships MUST be included when determining that graph. A garbage collector or reference counter MUST NOT be used to justify a prohibited lifecycle cycle. The acquisition design MUST permit the release order required by the owning standard without needing an already released dependency.

### Acquisition and publication

### RESOURCE-008 — Acquisition and retention serve an actual lifetime need

Resources MUST be acquired for an identified operation or owner and retained only for the supported lifetime that needs them. Long-lived reuse MAY be appropriate for application services or expensive resources, but MUST have an explicit owner, release point, and capacity policy where accumulation is possible.

Acquiring per observation or per iteration MUST NOT multiply resources that an existing owner is meant to share. Conversely, a module cache, global reference, or incidental import MUST NOT extend an operation resource's lifetime beyond its contract; module loading and startup retain `MODULE-028` through `MODULE-033`.

### RESOURCE-009 — Acquisition establishes facts about the actual target

When correctness depends on the acquired target's identity, access mode, exclusivity, or creation status, the operation MUST establish those facts through the actual acquisition protocol. An earlier check of a replaceable name or external state MUST NOT be treated as proof that a later acquisition obtained the same target.

Atomic platform operations or validation against the acquired handle MUST be used where the contract requires protection against such a race. Input normalization and permission checks retain their existing owners. Acquisition MUST NOT truncate, overwrite, or replace an existing resource when the requested operation only permits creating or observing it.

### RESOURCE-010 — Publication follows complete required preparation

An acquired resource MUST NOT be published as ready before its required initialization, validation, and ownership installation have succeeded under `CLASS-011`, `CLASS-012`, and `IFACE-019`.

Obtaining a handle alone does not prove that the promised capability is usable. Failure while preparing dependent statements, configuring a session, or adapting a native handle MUST remain inside the responsible acquisition boundary. Real lazy operations retain the Async rules; they MUST NOT disguise missing mandatory preparation of an exposed owner.

### RESOURCE-011 — Registration cannot leave an acquisition unprotected

After acquisition succeeds, its release obligation MUST be protected before the next step that can fail, suspend, invoke external code, or publish the resource without an accepted owner. Protection may come from the language's owning value, a lexical release guard, or a successfully installed lifecycle registration.

Installation of that protection MUST itself have a failure path. If adding a cleanup callback, decorating a host, or registering an owner fails, the acquiring scope MUST still release or validly transfer the resource. An intended future registration MUST NOT be counted as accepted ownership.

### RESOURCE-012 — Partial acquisition accounts for every successful part

A multi-resource acquisition MUST retain responsibility for all parts successfully acquired before another part fails or is cancelled. A combined failure result MUST NOT discard handles that still require release.

Rollback MUST release those parts according to the existing Function, Interface, Class, and Error contracts, including reverse acquisition order and preservation of required cleanup failures when `CLASS-027` applies. Partial success may escape only through a contract that explicitly transfers the acquired subset and its obligations. A failure to construct the aggregate does not make its acquisitions disappear.

### RESOURCE-013 — Asynchronous acquisition retains its eventual result

An asynchronous acquisition whose result can arrive after its caller leaves MUST follow `ASYNC-028`: the late resource still requires valid ownership transfer or release. Cancellation and deadline behavior retain `IFACE-018` and the Async rules.

The acquisition boundary MUST retain the information and dependencies needed to release a late handle, including when the intended receiver has already closed. Ignoring the result, rejecting a wrapper promise, or revoking publication authority MUST NOT lose the eventual release obligation. A failed transfer into a closed receiver remains part of this acquisition path.

### Borrowing, sharing, and transfer

### RESOURCE-014 — Every borrow has a valid end boundary

A borrowed resource MUST have a lifetime during which its owner guarantees the permitted access remains valid. The borrower MUST finish that access before the lifetime ends or obtain an explicitly accepted extension, transfer, or shared entitlement.

Returning a borrowed value, capturing it in a callback, or retaining it across suspension MUST NOT silently extend that lifetime. The owner MUST account for permitted outstanding borrowers before release. An operation-level borrow may be enforced by language lifetimes or a scoped capability; a custom lease object is not required when the existing mechanism establishes the boundary.

### RESOURCE-015 — Borrowing preserves mutation and concurrency restrictions

A borrow MUST preserve the resource's allowed reads, writes, concurrency, and re-entry behavior under the Class, Interface, and Object rules. Shared lifetime does not grant unrestricted shared mutation, and a read-only reference does not establish that an external resource cannot change.

The borrower MUST NOT retain a mutable alias or borrowed view beyond its permitted contract. Where access requires synchronization, ownership of the handle or its reference count MUST NOT be treated as the synchronization mechanism. The permitted operations must remain valid while other authorized users act on the same underlying resource.

For example, Rust's `Arc` coordinates shared ownership; it does not independently make the contained value safe for concurrent mutation. [Rust `Arc` thread-safety documentation](https://doc.rust-lang.org/std/sync/struct.Arc.html#thread-safety).

### RESOURCE-016 — Derived handles and views retain their parent dependency

A derived resource, cursor, reader, statement, slice, or view MUST define whether it owns an independent lifetime or borrows from a parent. The parent MUST remain valid for every supported use and release of its dependents.

A derived value MUST NOT be transferred or cached as independent merely because it has a different object identity. If a consumer needs to retain its data after the parent is released or reuses storage, the boundary MUST provide a permitted ownership-preserving copy or independent resource. Published values still satisfy `IFACE-021` and the Object rules.

### RESOURCE-017 — Validity checks cover the actual access interval

When release, replacement, or revocation can race with use, checking that a resource is live MUST be coordinated with the operation that uses it. A status check followed by unprotected access MUST NOT permit a resource to close or change ownership between those steps.

The owner MUST use the appropriate borrow, reservation, operation admission, or synchronization mechanism for the lifetime being protected. Suspension and cancellation retain the Async rules, and synchronous critical sections retain `CLASS-025`. This rule does not permit holding an ordinary lock across asynchronous work to manufacture a lifetime guarantee.

### RESOURCE-018 — Shared ownership accounts for each entitlement separately

A shared-resource mechanism MUST define what acquiring and releasing one share changes, when the underlying resource becomes eligible for release, and how the last entitled user is identified. Each participant MUST release only the entitlement it owns.

Duplicating a token reference MUST NOT silently create another entitlement, and releasing it twice MUST NOT consume another participant's share. New shares MUST NOT be granted after the shared owner has closed admission. Lifetime accounting MUST include legitimate retained users, not merely the currently visible observers or entries in one lookup.

### RESOURCE-019 — Weak observation does not establish continued liveness

A weak reference or registry lookup that does not retain ownership MUST be treated as an observation that may no longer yield a usable resource. Before use, the consumer MUST obtain the valid access guaranteed by the actual weak-reference or registry protocol.

An earlier successful lookup MUST NOT authorize later access after the resource's owner releases it. If weak observation is used to avoid an ownership cycle, the failure-to-obtain case MUST be part of the consumer contract. Weak references MUST NOT become the primary cleanup mechanism or substitute for explicit release responsibility.

### RESOURCE-020 — Transfer has one accepted ownership transition

A transfer MUST define the point at which the receiving owner accepts the resource and its release obligation. Until that point, responsibility MUST remain with the sender or an explicitly identified intermediate owner.

The handoff MUST preserve both lifetime and required access authority without a gap or two exclusive owners. After acceptance, the former owner MUST relinquish the transferred release right and any access the transfer contract ends. A borrowed alias may survive only if the new owner explicitly supports its continued borrow; ordinary assignment does not establish that relationship.

### RESOURCE-021 — Failed transfer defines which owner keeps responsibility

A transfer that can fail MUST specify whether the resource was not accepted, was consumed despite the failure, or remains in an explicitly recoverable intermediate state. Sender and receiver MUST agree on that outcome before either can release or reuse the resource.

An exception from a receiving callback or adapter MUST NOT automatically be interpreted as proof that ownership never moved. Partial batch transfers MUST account for each accepted and unaccepted member. Reconstructing an owning wrapper around a raw handle after an uncertain transfer MUST NOT risk duplicating a live release obligation.

### RESOURCE-022 — Copying and duplication have explicit lifetime semantics

Copying a descriptor or data record MUST NOT copy ownership of the resource it describes. A meaningful resource duplication MUST follow `CLASS-034` and establish the new handle or entitlement, its release responsibility, and its failure contract.

Independent handle release MUST NOT be advertised as independent underlying state when duplicated handles still share a cursor, session, allocation, or remote entity. Wrappers, object spread, serialization, and generic cloning MUST NOT be used to duplicate behavior owners or manufacture ownership. Resource duplication and ownership-preserving data copying remain different operations.

### RESOURCE-023 — Wrappers preserve the exact underlying release contract

A wrapper or adapter MUST state whether it owns, borrows, or shares its underlying resource and which obligations its cleanup covers. Nesting wrappers MUST NOT cause the same exclusive handle to be released independently by multiple layers or leave each layer expecting another to release it.

Detaching or extracting a raw resource MUST follow the transfer rules and invalidate the old ownership path as required. Wrappers MUST retain the standard disposal protocol and single-entry requirement of `CLASS-027` where applicable; multiple cleanup aliases or a no-op cleanup member MUST NOT conceal an absent responsibility.

### RESOURCE-024 — Lexical release covers the resource's actual use

A lexical guard or scope-based release MUST enclose every use for which that scope owns the resource. Returning a task, iterator, callback, or derived view that still needs the resource MUST NOT let the guard release it before that use finishes.

Code MUST either complete the use within the scope or explicitly transfer the required lifetime under `FUNC-018` and the Async rules. Early return and failure MUST retain the guard's real behavior. Conversely, a lexical scope MUST NOT retain a scarce resource across unrelated waiting or work when its supported use has already ended and prompt release is required.

### RESOURCE-025 — Replacement distinguishes old and new obligations

Replacing an owned resource MUST define how the old resource stops receiving new use, how existing users finish, when the new resource becomes authoritative, and which owner releases each acquisition. The overlap, if any, MUST fit the applicable capacity and dependency contracts.

Failure to acquire the replacement MUST preserve the documented state of the old owner. Failure to release the old resource MUST NOT authorize stale cleanup to affect the replacement or silently restore a terminal owner to readiness. A replacement using the same logical key still has its own acquisition and ownership history.

### Release and external effects

### RESOURCE-026 — Release uses the resource's actual terminal protocol

The release path MUST perform the operations that end the obligation it promises to end. Removing a reference, marking a flag, unlocking a reader, requesting cancellation, or closing one local endpoint MUST NOT stand in for another required release step.

Required asynchronous release MUST retain completion ownership under `FUNC-017` and the Async rules. The owner MUST distinguish completion of a local release operation from confirmed termination of an external resource when those facts differ. Successful cleanup MUST NOT claim guarantees that the underlying protocol does not establish.

### RESOURCE-027 — Release dependencies remain available until their last use

Resources needed by another resource's finalization MUST remain valid until that finalization no longer requires them. The acquisition and ownership design MUST support the release order mandated by the applicable owner, including reverse acquisition order under `CLASS-027`.

Cleanup callbacks, diagnostic channels, allocators, event loops, and parent handles used by release MUST be included in the dependency analysis. A release failure MUST NOT skip other required releases under the Class and Error rules. Dependency safety MUST be designed into cleanup rather than used afterward to excuse an abandoned obligation.

### RESOURCE-028 — Repeated cleanup cannot repeat an exclusive native release

An owner MUST coordinate repeated or concurrent cleanup according to the idempotence and joining contract of `CLASS-027` and `IFACE-019` where applicable. Repeated requests MUST NOT issue another exclusive native release against a handle that may already have ended or been reused.

The coordination MUST account for re-entrant completion callbacks and failures during release. An empty owner slot MUST NOT be treated as proof that an earlier asynchronous release has finished. Existing native protocol restrictions remain binding even when the repository's cleanup operation supports repeated calls.

### RESOURCE-029 — Release failure preserves identity and truthful state

After release fails, the owner MUST distinguish a still-owned live resource, a released handle with a reported failure, and an uncertain external outcome as the platform contract permits. The canonical lifecycle state MUST remain truthful and terminal where `CLASS-028` requires it; failure MUST NOT silently restore normal use.

A release MUST NOT be retried solely because it reported failure. Any retry requires evidence that the same obligation remains valid and that the protocol permits the retry. It MUST remain within the original cleanup operation or an explicit recovery ownership path, preserving repeated cleanup's promised outcome and all required failures under the Error rules.

Linux documents that retrying a failed `close` can close a descriptor reused by another thread. The appropriate release policy depends on the actual platform contract. [Linux `close(2)` manual](https://man7.org/linux/man-pages/man2/close.2.html).

### RESOURCE-030 — Release does not imply commit, durability, or deletion

A resource contract MUST distinguish release from flushing buffered data, durable synchronization, committing or rolling back a transaction, and deleting an external artifact when those outcomes matter to the caller.

An operation promising one of those effects MUST observe the required explicit protocol and report its outcome before claiming success. Successful close alone MUST NOT establish that unrelated domain work committed or persisted durably. Default transaction behavior on release MUST be understood and consistent with the operation contract; cleanup MUST NOT silently commit work that failure handling was meant to abandon.

### RESOURCE-031 — Local ownership does not imply ownership of remote entities

Owning a client, connection, session, or local handle MUST NOT be treated as exclusive ownership of every external entity reachable through it. Release MUST be limited to the entities and obligations actually acquired or authorized by the operation.

Closing a local connection and deleting or stopping a remote entity require their respective contracts. Where other clients can change remote state, an inventory snapshot or matching logical key MUST NOT authorize reclaiming unrelated resources. Remote release acknowledgements, retries, partial effects, and reconciliation retain the API, Event, Error, and Async rules.

### RESOURCE-032 — Temporary-artifact cleanup preserves unrelated data

An operation that owns temporary files, directories, or similar artifacts MUST record which artifacts it actually created or validly acquired for deletion. Cleanup MUST target that ownership scope even when names are reused, acquisition partially fails, or the operation exits early.

Persistent data, borrowed paths, and pre-existing directories MUST NOT be removed merely because an operation used them. Broad deletion by naming convention, unverified path prefix, or stale identity MUST NOT replace verified ownership. Intentional persistence or transfer of a temporary artifact MUST end the old deletion obligation through an explicit handoff.

### RESOURCE-033 — Use and release preserve platform affinity

A native resource MUST be used, transferred, and released with the thread, executor, event loop, device context, process, allocator, or runtime required by its actual contract. A generic cleanup callback MUST NOT erase these constraints.

Memory and handles MUST be released through the matching ownership protocol; a different allocator or superficially similar release function is not interchangeable without a guarantee. When release must be dispatched to another context, that context and the dispatch completion MUST retain owners until release completes. A terminated context MUST NOT be assumed available for later cleanup.

### RESOURCE-034 — Cross-process handoffs and inherited handles are deliberate

When process creation, native interoperation, or serialization can copy or inherit resource access, the boundary MUST define which handles are transferred, independently duplicated, borrowed, or retained by the originating owner.

Unnecessary inherited access MUST NOT extend a resource's lifetime or disclose capabilities to another process. Failure after a partial handoff MUST retain responsibility for all remaining local and remote obligations. Serializing a raw identifier MUST NOT manufacture a live owning handle or establish that a receiver has the authority and context needed to use it.

### Shared facilities, pools, and specialized resources

### RESOURCE-035 — Pools and resource caches retain an explicit owner

A pool or cache retaining managed resources MUST have an explicit lifecycle owner and define the difference between owning an underlying resource and borrowing or leasing it for an operation. Resource retention MUST NOT be disguised as pure memoization under `CLASS-020`.

The user of a checked-out resource MUST follow the pool's return or retirement protocol rather than directly dispose the underlying resource without authority. Removing a cache entry MUST account for any active users and the remaining release obligation. A pool or cache MUST serve an actual reuse or capacity requirement, not hypothetical future demand.

### RESOURCE-036 — Capacity includes every retained resource state

When a resource owner enforces a capacity limit, its accounting MUST include all states that consume the constrained resource: acquisitions in progress, checked-out resources, idle retained resources, and resources still closing where applicable.

The implementation MUST reserve capacity before launching constrained acquisition. Every failure, cancellation, or release path MUST retain responsibility for the reservation until the constrained capacity is actually relinquished, or transfer its accounting and remaining release obligation to a continuing owner. Pending waiters retain the Async capacity and cancellation rules. Removing a resource from a lookup or declaring it retired MUST NOT make its still-consumed capacity disappear; replacement and retry must account for any overlap.

### RESOURCE-037 — Reuse requires a ready and correctly scoped resource

Before a pooled or cached resource is made available for another use, its owner MUST establish the readiness, access scope, and reset conditions required by that use. Unfinished transactions, pending callbacks, buffered protocol state, and previous-user data MUST NOT leak into the next borrower.

If reset or validation fails, the resource MUST be retired, isolated for explicit recovery, or otherwise kept unavailable under a defined ownership policy. A returned slot MUST NOT be treated as usable solely because a borrower finished its wait. Isolation or retirement still requires a release owner and truthful capacity accounting.

### RESOURCE-038 — Lease expiry and invalidation control actual access

An expiring or revocable entitlement MUST define when access becomes invalid, how holders observe that change, and what prevents obsolete holders from continuing effects that the contract forbids. Expiring a timestamp or clearing a cache entry MUST NOT be presented as proof that another task or process stopped using the resource.

Where stale holders can continue acting, the design MUST enforce the required authority at the resource boundary or retain a safe non-overlapping lifetime until use ends. Renewal and replacement MUST distinguish the current entitlement from an old one. Returning an expired or duplicate lease MUST NOT release a replacement's share.

### RESOURCE-039 — Shared-facility shutdown accounts for outstanding users

A pool, cache, or shared-resource owner MUST close admission before teardown and account for outstanding leases, borrows, acquisitions, and owned work under the Class and Async shutdown rules.

Underlying resources MUST NOT be destroyed while permitted users still require them. Any supported revocation or cancellation path MUST establish the required end of access before release. A shutdown deadline or an emptied collection MUST NOT imply successful cleanup while obligations remain; late returns and late acquisitions still need a valid receiving or release owner.

### RESOURCE-040 — Registration ownership is limited to the relationship acquired

A timer, listener, observer, subscription, or callback registration MUST be owned as the actual relationship established with its host. The registration owner MUST release the exact relationship it owns without releasing the borrowed host or another consumer's registration.

Multiple registrations and replacement MUST retain their separate identities and lifetimes under the Event, Hook, and Component rules. Cleanup MUST account for work already started by the registration under the Async rules. Clearing a timer or unregistering a callback MUST NOT be advertised as terminating that work without the required evidence.

### RESOURCE-041 — Streams retain each distinct resource obligation

A stream adapter MUST account separately for any underlying source or sink, acquired reader or writer, lock, buffered owned resource, and pipeline task when they have different release responsibilities. Acquiring one capability MUST NOT silently transfer all of them.

Natural exhaustion, early exit, cancellation, and failure MUST perform the releases required by the actual ownership contract, following `ASYNC-031` through `ASYNC-041`. Releasing a reader lock MUST NOT substitute for cancelling an owned source, and cancelling a borrowed source MUST NOT be used to release only the consumer's observation.

### RESOURCE-042 — Process ownership covers the declared process scope

An owner of a process or process group MUST define the scope it starts and is responsible for terminating, observing, and releasing. The direct child, descendants, communication channels, and operating-system process handle MUST be distinguished where their lifetimes differ.

A stop request or dropped local handle MUST NOT be treated as observed process termination or completion of required reaping. Observing one child exit MUST NOT establish that its descendants have exited. The implementation MUST preserve the identity and authority required for its declared scope, while process waiting and shutdown retain the Interface and Async rules.

### RESOURCE-043 — Automatic destruction preserves required release outcomes

Language-managed destruction and deterministic disposal MUST be evaluated against the resource's required release outcomes. When native destruction cannot report a failure the operation promises to observe, the boundary MUST provide an explicit observable operation for that guarantee or follow the documented exception process if a platform constraint prevents compliance.

A finalizer may serve only the fallback role permitted by `CLASS-028`; garbage collection or process termination MUST NOT become normal cleanup under `IFACE-020`. Automatic destruction MUST NOT be presented as proof that fallible finalization, asynchronous release, or persistence guarantees completed.

Rust's `File` closes during destruction but its `Drop` implementation ignores closing errors. A deterministic lifetime alone therefore does not establish observation of every release failure. [Rust `File` documentation](https://doc.rust-lang.org/std/fs/struct.File.html).

### Documentation, compatibility, and verification

### RESOURCE-044 — Contracts document the consumer's ownership obligations

Documentation required by the existing Function, Interface, Class, and JSDoc standards MUST identify the resource's owner, borrowed or shared access, transfer point, valid lifetime, required release operation, and failure behavior wherever the consumer needs those facts.

Relevant dependent-resource lifetimes, concurrency restrictions, release affinity, pool return conditions, and remote-state limitations MUST be stated at their authoritative boundary. Comments saying a value is safe, managed, or disposable MUST NOT substitute for the actual contract. Diagnostics follow the Error rules and MUST NOT expose credentials or private contents embedded in handles.

### RESOURCE-045 — Ownership changes receive compatibility review

Changing a returned resource from owned to borrowed, altering transfer-on-failure behavior, shortening a borrow, adding shared reuse, changing release timing, or exposing a different cleanup protocol MUST be assessed as a contract change when callers depend on it.

Affected owners, consumers, adapters, tests, and documentation MUST remain consistent under the existing compatibility rules. A signature remaining unchanged does not preserve compatibility if callers can now double-release a resource, use it after return, or lose an outcome they were promised. An internal representation change preserving every observable guarantee needs no invented migration process.

### RESOURCE-046 — Acquisition tests cover ownership installation and rollback

Verification of an acquisition boundary MUST cover relevant failure before acquisition, after each successful partial acquisition, during required preparation, and while installing release responsibility. Each case MUST establish who owns the successfully acquired resources and how they reach the required terminal state.

Where acquisition is asynchronous, controlled schedules MUST exercise cancellation or receiver closure before a late result arrives under the Async verification rules. Tests MUST verify preserved operation and cleanup failures where both can occur. Cases apply to the actual acquisition protocol and supported failure paths, not hypothetical infrastructure.

### RESOURCE-047 — Borrow and transfer tests prove the handoff contract

Where resources are borrowed, shared, or transferred, verification MUST exercise the relevant lifetime end, accepted handoff, rejected handoff, partial consumption, and repeated-token behavior. Assertions MUST distinguish the previous owner's authority from the receiver's authority.

Tests MUST establish that a borrower cannot release another owner's resource, a transferred obligation is released by its accepted owner, and permitted retained users remain valid. Reused keys or handles MUST be tested where the implementation can confuse old and replacement acquisitions. Test assertions SHOULD use observable ownership behavior rather than private bookkeeping alone.

### RESOURCE-048 — Release tests verify completion and failure preservation

A resource owner with cleanup MUST be verified on the relevant normal, early-return, operation-failure, cancellation, and cleanup-failure paths. Tests MUST prove the required release order, continued release attempts, and preservation of all required failures under the owning standards.

Repeated and concurrent cleanup, and permitted re-entry during completion, MUST follow the actual contract. A test that only records a release method call MUST NOT establish terminal cleanup when work or dependent resources remain active. Platform rules about a failed release MUST be represented accurately; a test double MUST NOT encourage an unsafe retry of a reused handle.

### RESOURCE-049 — Reuse and replacement tests cover stale holders

Pools, resource caches, leases, and replaceable owners MUST be verified for applicable exhausted capacity, failed acquisition or reset, stale return, duplicate release, expiry, and shutdown while a user remains active. Tests MUST account for resources opening or closing when those states consume capacity.

Assertions MUST establish that a resource is ready and correctly scoped before reuse, that failed resources remain unavailable, and that old cleanup cannot affect a replacement. Controlled schedules MUST cover the relevant lifetime overlap. These cases do not require adding a pool, lease mechanism, or expiry policy to an owner that does not have one.

### RESOURCE-050 — Adapter verification reflects the real release protocol

Resource adapters MUST be validated against the actual platform or dependency contract where an in-memory double cannot establish handle lifetime, release affinity, ownership transfer, inherited access, or external completion. Use the smallest reliable integration or platform check for the changed boundary.

Verification MUST cover supported exceptional behavior that materially affects the promised resource outcome, and document limitations when it cannot be exercised safely or deterministically. Test-created resources MUST have their own failure-safe cleanup. Temporary-artifact checks MUST verify that pre-existing or unrelated data survives, and process checks MUST cover the declared child or group scope where applicable.

## Repository boundary examples

These examples identify useful review boundaries in the current repository. They do not certify that existing implementations satisfy every rule in this chapter.

| Situation                                                                             | Contract distinction                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A service bundle exposes operation capabilities and a module-private close capability | Using a service and owning the bundle's complete cleanup are different responsibilities. A frozen outer record does not by itself establish compliant lifecycle ownership.   |
| Each service acquisition is registered before acquiring the next service              | The next acquisition can fail without removing responsibility for the services already acquired. Installation into the final application host is another ownership boundary. |
| An SDK client is captured by functions supplied to the model runtime                  | Hiding the concrete client behind operations does not remove the captured dependency's lifetime or cleanup obligation.                                                       |
| A database owner retains prepared statements                                          | The statements' use depends on the connection remaining valid; a different statement object does not prove independent resource ownership.                                   |
| A model inventory operation returns immutable instance identities                     | The snapshot is data. It does not establish exclusive ownership of models that other clients can change.                                                                     |
| A chat sender captures a borrowed reply connection                                    | The sender can use the connection within its permitted lifetime without owning the connection's release.                                                                     |
| An effect registers pointer and keyboard listeners on the document                    | The effect owns its two registrations and borrows the document and DOM references.                                                                                           |
| A view observes an application-owned model-transition timer                           | Removing the observer does not transfer or end the application's timer ownership. The current model transition is simulated.                                                 |
| A stream adapter cancels early consumption and then releases its reader lock          | Upstream cancellation and lock release are separate obligations; cleanup failures still need their proper outcome.                                                           |
| Native shutdown observes the direct child process                                     | Direct-child exit, descendant lifetime, process-group termination, and handle release are separate facts.                                                                    |

The relevant sources are the [service bundle and client acquisition](../../apps/backend/src/di/singleton.ts), [application lifetime registration](../../apps/backend/src/di/fastify.ts), [database and statement owner](../../apps/backend/src/di/services/conversationService/index.ts), [model runtime](../../apps/backend/src/di/services/lmStudioLlmRuntime.ts), [remote model reconciliation](../../apps/backend/src/modules/llm/stopLlmModelsByKey.ts), [borrowed reply sender](../../apps/backend/src/modules/chat/chat/share.ts), [listener registrations](../../apps/desktop/src/components/ComposerComponents/ComposerContextMeter.tsx), [application timer](../../apps/desktop/src/lib/store/index.ts), [stream reader](../../apps/desktop/src/lib/apis/http/chat.ts), [native process owner](../../apps/desktop/src-tauri/src/backend.rs), and [service lifetime tests](../../apps/backend/test/di/singleton.test.ts).
