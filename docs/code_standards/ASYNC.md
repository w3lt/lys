# Async Task and Stream

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines how asynchronous work starts, remains owned, coordinates with other work, and reaches an observable terminal state without abandoning its effects or resources.

## Definition and scope

An **asynchronous operation** can make progress or complete after control returns to its caller. A **task** is one execution of such work. A **completion handle**, such as a promise or future, exposes an operation's outcome according to its runtime contract; possessing, awaiting, or dropping that handle does not by itself define whether the underlying work starts or stops.

An **owner** is responsible for a task's lifetime, terminal outcome, and retained resources. A **child task** belongs to another operation or lifecycle owner. A **join** observes the terminal completion of the work it covers. An **admission decision** accepts work into an owner's responsibility; accepted work can still be queued before execution starts.

A **cancellation request** asks work to stop under its operation contract. **Cancellation completion** establishes the operation's defined terminal cancellation outcome. A **deadline** bounds an operation's permitted waiting or execution budget. The deadline expiring, a caller ceasing to wait, and the underlying work actually stopping are different events.

A **stream** supplies a sequence of items over time through a consumption protocol. A **producer** supplies items; a **consumer** requests or receives them. **Backpressure** communicates limited downstream capacity upstream. A **pipeline** connects production, transformation, and consumption stages whose work and retained data require coordinated lifetimes.

The rules apply to repository-owned asynchronous functions, task groups, queues, timers, callback adapters, deferred continuations, stream producers and consumers, and asynchronous lifecycle coordination. Runtime futures, promises, async iterators, streams, worker operations, and process completions retain their actual platform contracts. The chapter governs their repository-owned use and adaptation.

A finite asynchronous operation does not automatically require a task registry, custom scheduler, worker pool, status envelope, cancellation wrapper, or new interface. Stateful owners retain the Class rules; passive descriptions retain the Type and Object rules. Merely wrapping synchronous work in an asynchronous signature does not change its execution or blocking behavior.

Resource ownership and release also follow [Resource](./RESOURCE.md). Configuration contracts also follow [Configuration](./CONFIGURATION.md). Schema contracts and migrations also follow [Schema and Migration](./SCHEMA.md). Tests and fixtures also follow [Test and Fixture](./TEST.md). Comment construction also follows [Comment](./COMMENT.md). Asynchronous execution and stream documentation retains the requirements in this chapter.

## Existing rule ownership

Each active standard retains its exact triggers and permitted cases. Async rules connect those contracts across execution, suspension, cancellation, and consumption boundaries.

| Concern                                                                                                                        | Authoritative rule or document                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Callable responsibility, naming, input ownership, outcomes, and side effects                                                   | `FUNC-001` through `FUNC-003`, `FUNC-006` through `FUNC-011` in [Function](./FUNCTION.md)                   |
| Completion ownership, one completion protocol, resource release, callbacks, documentation, and tests                           | `FUNC-017` through `FUNC-026` in [Function](./FUNCTION.md)                                                  |
| Valid state representations, capability owners, immutability, and compatibility                                                | `TYPE-002` through `TYPE-012`, `TYPE-017`, `TYPE-019`, `TYPE-020` in [Type](./TYPE.md)                      |
| Publication by capture, mutable builders, resource aliases, and stateless providers                                            | `OBJECT-005`, `OBJECT-013` through `OBJECT-016`, `OBJECT-047` through `OBJECT-054` in [Object](./OBJECT.md) |
| Capability eligibility, exact completion, nonblocking operations, cancellation, readiness, and returned resources              | `IFACE-001` through `IFACE-007`, `IFACE-014` through `IFACE-021` in [Interface](./INTERFACE.md)             |
| Construction, readiness, invariants, concurrency, locking, cleanup, and lifecycle state                                        | `CLASS-010` through `CLASS-016`, `CLASS-023` through `CLASS-028` in [Class](./CLASS.md)                     |
| Component actions, late results, owner lifetimes, and renderer effects                                                         | `COMP-091` through `COMP-108` in [Component](./COMPONENT.md)                                                |
| Hook completion, effect protocol, cancellation authority, replacement, and store observation                                   | `HOOK-018`, `HOOK-024` through `HOOK-033` in [Hook](./HOOK.md)                                              |
| API capacity, commit uncertainty, retry, cancellation, deadlines, framing, and stream completion                               | `API-019`, `API-026` through `API-041` in [API](./API.md)                                                   |
| Failure channels, causes, retry permission, cancellation classification, ownership, cleanup failures, and stream failure scope | [Error](./ERROR.md), especially `ERROR-024` through `ERROR-034`                                             |
| Message completion, ordering, delivery guarantees, replay, buffering, subscriptions, and native phases                         | `EVENT-017`, `EVENT-021` through `EVENT-040` in [Event and Message](./EVENT.md)                             |
| Placement, dependency direction, published contracts, and consumer compatibility                                               | [Module and File](./MODULE.md) and [Package and Dependency](./PACKAGE.md)                                   |
| Documentation and change workflow                                                                                              | [JSDoc Standard](../JSDOC.md) and [Contributing to Lys](../../CONTRIBUTING.md)                              |

The words start, spawn, schedule, join, poll, drain, and retry describe execution concepts; they do not add repository-designed function verbs to `FUNC-003`. Externally imposed signatures retain their existing exception. In particular, the canonical `cancel` verb means ending an operation without committing its intended outcome; acknowledging a cancellation request alone does not establish that postcondition.

Work outliving its requesting caller under `FUNC-017` remains subject to the cancellation and application-ownership requirements of `IFACE-018`. Platform limitations alone do not establish its application-owned completion-only case; a boundary outside the permitted cases requires the documented exception process. Lazy operation execution does not permit the fallible lazy initialization forbidden by `CLASS-012` or weaken readiness under `IFACE-019`.

## Construction process

Before adding or changing asynchronous work or a stream:

1. Identify the operation's purpose, execution owner, consumers, and authoritative contract.
2. Establish what creates the work, when it starts, and whether a handle represents fresh or existing execution.
3. Trace admission, scheduling, suspension points, retained state, external effects, and terminal observation.
4. Define which completion stage the caller observes and who owns work continuing beyond it.
5. Identify cancellation authority, potentially unbounded waits, deadlines, and commit boundaries.
6. Define task-group membership, sibling failure behavior, queue capacity, and relevant ordering.
7. For streams, define consumption, demand, item ownership, terminal meaning, and early-exit behavior.
8. Trace partial acquisition, late completion, ownership transfer, and shutdown through required release.
9. Assess affected callers, renderer phases, platform constraints, and compatibility promises.
10. Verify the relevant execution schedules, failure paths, cancellation races, and resource lifetimes.

## Mandatory rules

### Execution contracts and ownership

### ASYNC-001 — Every task belongs to an explicit execution contract

A repository-owned task MUST have an identified operation and lifetime owner under `FUNC-017`. Its contract MUST make the start condition, observable completion stage, and retained responsibility understandable to its caller or supervising owner.

A completion handle MUST NOT be treated as the work itself when the distinction affects execution or cleanup. A handle that reports acceptance, stream acquisition, or a selected result MUST NOT imply that all resulting work has finished. Internal scheduling details need documentation only when callers or owners depend on them.

### ASYNC-002 — Creation, activation, and repeated use are distinguished

An asynchronous abstraction MUST define whether construction or invocation starts execution, schedules it, or produces work that starts only when consumed or polled. It MUST distinguish a reusable operation factory from a single execution when repeated use could repeat effects or violate the runtime protocol.

Code MUST NOT assume that ignoring a lazy value starts its work, that observing a completion again starts new work, or that discarding a handle stops an independently executing task. Required capability initialization remains governed by `CLASS-010` through `CLASS-012` and `IFACE-019`.

For example, Rust documents futures that require polling and futures that observe independently executing tasks. Their handles do not establish identical execution ownership. [Rust `Future` documentation](https://doc.rust-lang.org/std/future/trait.Future.html#runtime-characteristics).

### ASYNC-003 — Ownership is established before execution can escape

The caller or lifecycle owner MUST establish responsibility for a task before the launch path can return, throw, suspend, or invoke external code in a way that loses that responsibility.

If launch can execute synchronously or produce an immediate failure, the launch and registration sequence MUST still account for that outcome. A task collection populated only after a fallible registration step MUST NOT leave already started work unowned. Ownership may be lexical or supplied by an existing runtime facility; this rule does not require a global registry.

### ASYNC-004 — Continuations retain terminal observation

Every derived asynchronous operation created by a continuation, failure handler, finalizer, or progress handler MUST remain covered by the completion ownership required by `FUNC-017` and `ERROR-028`.

Observing the source task does not automatically observe a derived task that can fail independently. A detached marker, ignored return value, or global unhandled-failure hook MUST NOT replace the required owner. When completion observation is transferred, the receiving owner MUST accept responsibility before the originating scope stops supervising it.

### ASYNC-005 — Completion is one stable decision at a defined scope

An operation MUST use the single completion protocol required by `FUNC-017`. Concurrent success, failure, cancellation, and timeout paths MUST resolve the operation's terminal decision consistently and prevent later paths from replacing it or repeating terminal side effects.

Progress notifications and stream items MAY accompany that protocol when they do not create a second final callback for the same operation. Repeated observation or release MUST follow the actual abstraction's contract; joining the same outcome does not require completion-handle object identity, and a one-shot polling protocol MUST NOT be polled after completion.

### ASYNC-006 — Admission precedes execution and closes atomically with shutdown

An owner that accepts queued or concurrent work MUST make acceptance an explicit decision before starting that work. The decision MUST use current lifecycle state and account for any capacity the accepted work reserves.

When shutdown closes admission, concurrent submissions MUST either become owned accepted work or receive the defined rejection outcome. Work MUST NOT start after being rejected, disappear between an admission check and registration, or enter through a delayed continuation that bypasses the closed state. Work deliberately retained after the initiating caller leaves still requires an owner.

### ASYNC-007 — Suspension preserves state and captured-value contracts

Before suspending, code MUST leave owned shared state valid under the applicable Class and Type rules. After resuming, it MUST revalidate any mutable condition or operation authority on which its next effect depends.

Captured arguments, records, buffers, and handles MUST retain their actual publication and ownership contract under `OBJECT-013` through `OBJECT-016` and `IFACE-021`. A temporary mutable builder MUST NOT cross suspension or escape by capture where `OBJECT-015` forbids it. Copying an outer reference or adding a read-only type does not make mutable nested data safe across execution boundaries.

### ASYNC-008 — Execution context supports the operation's contract

Code MUST execute blocking, CPU-intensive, and latency-sensitive work in a context compatible with the caller's responsiveness and synchronization requirements. An asynchronous signature MUST NOT be used as evidence that execution is nonblocking or parallel.

Where work can monopolize an event loop, executor thread, or required owner, the implementation MUST bound each uninterrupted segment or use an appropriate existing execution facility. Required nonblocking interface operations retain `IFACE-017`. A worker, thread pool, or custom executor MUST NOT be introduced solely because a function is asynchronous.

### ASYNC-009 — Repeated scheduling allows required progress

Polling, retry waiting, and recursively scheduled work MUST allow the dependencies needed for progress, cancellation, and shutdown to execute. Code MUST NOT busy-wait on a completion that requires the same execution context or create an unbounded chain of immediately resumed work that starves required timers or I/O.

When scheduling fairness or responsiveness is part of the contract, the implementation MUST use the runtime's appropriate notification or yielding mechanism and test that boundary. Merely inserting an await does not prove that competing work receives execution time.

### Task groups, queues, and shared work

### ASYNC-010 — Task groups have complete membership and exit rules

An operation that starts child tasks MUST identify which tasks belong to its completion and which, if any, transfer to a longer-lived owner. The group MUST account for children started before a later launch fails and for children created by other owned children.

A scope MUST NOT release resources still used by its children. Before its ownership ends, every child MUST have reached its required terminal state or been accepted by a named owner that also retains the resources it needs. A combinator's returned result alone does not prove those conditions.

### ASYNC-011 — Aggregate results preserve the selected failure policy

The task group MUST implement the sibling failure and outcome policy required by `ERROR-029`: whether independent work continues, dependent work stops, and which outcomes the caller receives. Selecting a result early MUST NOT discard required failure observation or cleanup of other members.

An all-settled collection MUST be inspected according to that policy; merely waiting for all members does not handle their failures. Conversely, normalizing a private coordination completion MAY keep later independent work usable only when each original operation's outcome remains observable through its authoritative channel.

### ASYNC-012 — Races retain ownership of every participant

Code that selects the first settlement, first success, or deadline outcome MUST define the fate of every nonselected participant. Cancellation, joining, or transfer MUST follow each participant's actual contract, including resources or effects produced after selection.

The winner's result MUST NOT imply that losing work stopped. Empty input, all-failed input, and participants that never settle MUST have behavior consistent with the enclosing operation's completion and cancellation requirements. A timer participating in a race requires release when it is no longer needed.

JavaScript's `Promise.race` settles from the first input settlement; its algorithm does not cancel other inputs. Repository ownership must therefore be handled separately. [ECMAScript `Promise.race`](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise.race).

### ASYNC-013 — Concurrency limits apply before work is launched

When input size or arrival rate can exceed available execution capacity, the owner MUST limit admission or activation before starting the constrained work. Creating every task eagerly and limiting only the later await or result-processing step MUST NOT be presented as an execution limit.

The limit MUST cover the resource actually constrained, such as active requests, retained bytes, subprocesses, or per-key operations. Finite work with a demonstrated bound MAY use that bound without a configurable limiter. A limit on active tasks alone does not bound pending input or completed results awaiting consumption.

### ASYNC-014 — Pending work has a bounded retention policy

A queue or pending-work collection whose producer can outpace its consumer MUST define a finite retained-work bound and its admission or overflow behavior. The bound MUST account for the significant retained data and resources, including waiting submitters when they retain requests outside the queue.

Backpressure, rejection, or contractually permitted replacement MUST resolve the submitter's outcome without orphaning work. Event coalescing and loss retain `EVENT-033`; arbitrary work MUST NOT be silently dropped because its queue is full. Capacity and fairness obligations MUST be enforceable at the actual owner.

### ASYNC-015 — Queue ordering refers to the relevant execution stage

A queue MUST define the ordering domain and stage that its consumers depend on, such as admission, start, effect commit, or completion. Ordered starts MUST NOT be advertised as ordered completion when operations overlap.

Cancellation of queued work MUST prevent its later activation or route it through a defined cancellation checkpoint before effects begin, release reserved capacity, and settle its submission outcome. A failed operation MUST NOT poison subsequent independent work unless stopping the queue is the explicit failure policy. Message ordering retains `EVENT-023` and `EVENT-024`.

### ASYNC-016 — Permits and serialization cannot strand progress

A task that acquires a concurrency permit or serialization position MUST release it on every terminal path, including cancellation before activation and failure during setup. Responsibility for releasing it MUST transfer exactly once if another task takes over.

Code MUST NOT await work that can progress only after that same task releases its current permit or queue position. Re-entry and locking retain `CLASS-025`: synchronous critical sections cannot suspend, while an asynchronous serialization queue may span await without synchronously re-entering itself. Lock or queue ownership MUST NOT be inferred solely from execution on one thread.

### ASYNC-017 — Shared execution separates each observer from the work owner

When callers share one in-flight operation, the contract MUST distinguish each caller's observation lifetime from the lifetime of the shared execution. One caller abandoning its wait MUST NOT cancel work still required by another owner unless the shared contract explicitly grants that authority.

Shared keys MUST include every input or authority boundary necessary for equivalent work. Result reuse, failure retention, last-observer departure, and eventual resource release MUST follow an explicit policy. Deduplicating a completion handle MUST NOT accidentally share mutable output, tenant authority, or cancellation ownership.

### Cancellation, deadlines, and timers

### ASYNC-018 — Deadline propagation preserves the remaining budget

An operation with a deadline MUST define the budget's scope, clock semantics, and expiry outcome. Nested waits, queue residence, retries, and cleanup included in that scope MUST consume the same remaining budget rather than silently restarting it at each layer.

An exhausted budget MUST be checked before new affected work begins. Elapsed-time budgets MUST use a clock suitable for duration measurement; externally supplied timestamps require explicit conversion and clock assumptions. A local deadline MAY be stricter than its parent, but MUST NOT extend the parent's permitted wait or misrepresent continuing work as stopped.

### ASYNC-019 — Cancellation authority follows the operation owner

Cancellation propagation MUST identify which owner can request termination of which work. A child MUST NOT cancel its parent, siblings, or shared dependency merely because it holds an observation signal or borrowed completion handle.

Owned child work MUST receive the cancellation required by its parent contract, while borrowed or transferred work retains its own owner's authority. Cancellation links and listeners MUST remain owned resources and be removed when no longer needed. A signal is a request and observation mechanism; it is not proof of terminal execution or revoked publication authority.

### ASYNC-020 — Pre-cancellation and registration races cannot be missed

An operation accepting cancellation MUST handle an already-cancelled request before starting avoidable work. Installing cancellation observation and checking the current state MUST use a sequence or runtime primitive that cannot miss cancellation between those steps.

The same requirement applies when cancellation occurs during admission, resource acquisition, callback registration, or transfer to a child. Synchronous cancellation callbacks MUST encounter valid owner state. If some effect has already become unavoidable, the operation MUST account for that effect through its established outcome and ownership contract instead of reporting an unqualified cancellation success.

### ASYNC-021 — Cancellation reaches active waits and work checkpoints

Code MUST propagate cancellation to the active waits and owned work covered by its contract. A signal check only before entering a potentially unbounded wait does not satisfy `IFACE-018` if that wait cannot subsequently respond.

Long-running computation MUST observe cancellation at intervals compatible with the promised response, and cancellation of pending queue admission MUST settle that wait. An adapter around a dependency MUST explain what its cancellation can actually interrupt. Ending only local observation MUST NOT be substituted for a required cancellable operation or conceal unowned continuing work.

### ASYNC-022 — Cancellation and timeout remain distinct from termination

An owner MUST track the distinction between requesting cancellation, completing an observer's wait, and observing the underlying work's terminal outcome whenever those stages can differ. Terminal release and subsequent operations MUST use the stage their contract requires.

Deadline expiry MUST NOT falsely imply rollback, resource release, or execution termination. Cancellation classification and timeout uncertainty remain governed by `ERROR-025` and `ERROR-026`. A later signal change MUST NOT relabel an unrelated failure, and a successful cancellation result MUST satisfy the actual cancellation postcondition, including `FUNC-003` where that verb is used.

### ASYNC-023 — Cancellation races respect commit and partial progress

When cancellation can race with a commit or externally visible effect, the operation MUST define which transition determines whether the effect proceeds and how the resulting outcome is observed. Checks before an await MUST NOT be treated as protection for effects performed after it without revalidation.

An operation that has committed MUST preserve the outcome or uncertainty required by the API and Error contracts rather than claim that cancellation prevented the effect. Partial stream delivery and independently committed child operations MUST be accounted for at their own scope. Compensation requires its own real operation and failure contract; cancellation alone is not compensation.

### ASYNC-024 — Abandoning a pending operation preserves its invariant

Code that drops a future, ends an iterator, abandons a wait, or loses a race MUST account for the runtime's actual behavior at that suspension point. It MUST identify whether work stops, continues elsewhere, leaves partial protocol state, or requires explicit release.

An operation MUST NOT be abandoned while leaving a consumed input, held permit, partial write, or acquired handle in a state its owner cannot recover or complete. If cancellation requires a protocol recovery step or supervised continuation, that work MUST retain ownership and terminal observation. Dropping an observation handle MUST NOT be assumed to perform asynchronous cleanup.

### ASYNC-025 — Late work revalidates authority before publication

When replacement, navigation, disposal, or a newer operation can revoke a task's right to affect current state, every affected success, failure, progress, and finalization path MUST check current authority under the relevant Component, Hook, Class, and Event rules.

Resource identity alone MUST NOT stand in for execution identity when two operations target the same resource. An obsolete task MUST NOT clear a replacement task's pending state or release its resources. Suppressing stale publication does not remove the obsolete task's own cleanup and failure-observation obligations or satisfy a stronger cancellation contract.

### ASYNC-026 — Timers have owned callbacks and defined recurrence

A timer MUST have an owner, a release point, and a defined effect if its callback becomes runnable during cancellation or shutdown. Clearing the timer MUST NOT be assumed to stop an already executing callback or work that callback started.

A recurring asynchronous operation MUST define whether executions overlap, queue, skip, or replace when one interval's work is still active. It MUST account for delayed or missed ticks without uncontrolled catch-up work. When elapsed time matters, the value MUST derive from the relevant clock contract rather than assuming that callback count measures exact elapsed duration.

### ASYNC-027 — Retry scheduling implements the existing retry policy

When retries are permitted by `ERROR-024` and the applicable API or Event rules, their scheduling MUST remain owned, cancellable where required, and within the shared attempt and time budgets. Cancellation or deadline expiry during a retry delay MUST prevent an unauthorized later attempt.

A new attempt MUST NOT accidentally overlap a still-running timed-out attempt. Deliberate overlapping attempts require an explicit effects, identity, capacity, and loser-ownership contract. Async coordination MUST NOT add retry permission, conceal uncertain prior effects, or introduce another retry layer beyond the authoritative policy.

### Resource lifetime and shutdown

### ASYNC-028 — Asynchronous acquisition cannot lose a late resource

The owner of an asynchronous acquisition MUST remain responsible for a resource that arrives after cancellation, deadline expiry, partial construction failure, or abandonment of the caller's wait.

The resulting resource MUST either transfer to an owner permitted to use it or be released under its actual lifecycle contract. Ignoring a late result MUST NOT leak its handle. Registration and rollback MUST preserve `FUNC-018`, `IFACE-020`, and the Class construction rules; a required ready capability MUST NOT escape before acquisition and initialization have established its invariants.

### ASYNC-029 — Shutdown waits for the work covered by its postcondition

An asynchronous owner MUST close admission before releasing dependencies that accepted work can still use. It MUST coordinate queued, active, deferred, and timer-started work according to its lifecycle contract and the cleanup requirements of `CLASS-027`.

Concurrent shutdown requests MUST join the same cleanup operation and observe its outcome where the Class contract requires idempotence. A timeout, emptied registry, or abandoned join MUST NOT count as successful terminal cleanup while owned work can still access released resources. Failed cleanup retains the terminal-state requirements of `CLASS-028` and the failure policy of `ERROR-027`.

### ASYNC-030 — Cleanup remains executable after operation cancellation

Cancellation of an operation MUST NOT automatically prevent the releases needed to end its ownership. Cleanup MUST use an execution context in which its required actions can actually proceed; blindly forwarding an already-cancelled operation signal to every release is insufficient when that skips release.

When cleanup has its own bounded context, its deadline and failure behavior MUST be explicit and MUST NOT imply successful release after abandonment. Operation and cleanup failures retain `ERROR-030` and `ERROR-031`. Fallible or asynchronous cleanup MUST have an observable owner; it MUST NOT rely on garbage collection or unsupported asynchronous destructor behavior.

### Stream contracts and consumption

### ASYNC-031 — Stream acquisition and activation have separate contracts

A stream-producing operation MUST define what returning the stream establishes and what begins production. If iteration activates work lazily, the owner MUST account for a stream that is never iterated, fails on its first read, or is closed before production begins.

Resources acquired before the first item MUST already have an accessible release path; cleanup located only inside a body that may never execute is insufficient. Lazy consumption MUST NOT hide fallible initialization of a capability required to be ready under the Class and Interface rules.

### ASYNC-032 — Item delivery and stream completion prove different things

A stream contract MUST distinguish obtaining an item, accepting a write, completing the sequence, and completing the domain operation whenever these stages differ. The consumer MUST use the stage required by its actual postcondition.

An item, successful write, or end-of-input marker MUST NOT imply durable processing or business completion without that guarantee. A domain completion item MAY cover one sub-operation while other work continues. API framing and terminal response semantics remain with `API-033` through `API-037`; message acknowledgements and completion retain the Event rules.

For Web Streams, a successful write promise has the completion meaning supplied by the underlying sink; it is not a universal durability guarantee. [WHATWG Streams Standard, §5.1](https://streams.spec.whatwg.org/#ws-intro).

### ASYNC-033 — Terminal stream states define pending and buffered work

A stream MUST define the effects of normal exhaustion, producer failure, consumer cancellation, and owner shutdown on pending reads or writes, buffered items, and required finalization. A finite stream MUST NOT silently remain pending after its producer can no longer make progress.

An intentionally open-ended stream MAY wait for future input under its cancellation and lifecycle contract. Buffered or final partial items MUST be delivered, rejected, or discarded only as that contract permits. Normal exhaustion MUST NOT conceal truncation or scoped failure governed by `ERROR-033` and the API contract.

### ASYNC-034 — Consumer cardinality and repeated iteration are explicit

A stream MUST define whether it is single-consumer, repeatable, or shared among multiple consumers when that affects ownership or effects. Repeated iteration MUST NOT accidentally restart an external operation, compete for one cursor, or replay effects without an explicit contract.

A second consumer MUST receive the documented independent sequence, shared delivery, or rejection behavior. The consumer that releases an iterator or reader MUST possess the relevant ownership; it MUST NOT close a borrowed shared source merely because its own observation ends.

### ASYNC-035 — Read and write concurrency follows the actual protocol

Consumers and producers MUST obey their stream's permitted overlap of reads, writes, iteration steps, cancellation, and close operations. Concurrent operations MUST NOT be introduced on an assumption that an async signature makes the underlying cursor or writer safe to share.

Where the repository provides serialization, it MUST preserve the required ordering and settle pending operations when termination occurs. Releasing a reader or writer lock MUST NOT be assumed to cancel its underlying work or settle every outstanding operation; the adapter MUST perform the actual required protocol steps.

### ASYNC-036 — Demand controls production at the responsible boundary

When production can outpace consumption, the implementation MUST propagate demand or apply a bounded retention policy before uncontrolled work or data accumulates. Awaiting a read or write in one loop MUST NOT be presented as proof that upstream production, parsing, or transport buffering is bounded.

The owner MUST identify where backpressure stops being effective and apply capacity handling there. Unavoidable external buffering MUST have an understood operational bound or containment policy; repository code MUST NOT add unbounded buffering behind a nominally backpressured interface. Event loss and coalescing retain `EVENT-033`.

### ASYNC-037 — Pipeline stages share a complete lifetime contract

A pipeline owner MUST account for every producer, transform, consumer, and coordinating task it starts. Downstream early exit, upstream failure, and cancellation MUST propagate according to the pipeline's actual contract and leave no stage waiting on work that can no longer occur.

The pipeline's completion MUST include the stages and finalization promised to its caller. Any stage deliberately continuing independently requires accepted ownership and retained resources. Options that suppress upstream cancellation or downstream close MUST be used only with a corresponding owner and termination path for the work they preserve.

### ASYNC-038 — Transform expansion and retained results count toward capacity

Transforms that decode, decompress, batch, aggregate, reorder, or expand stream items MUST account for their own retained input and output when enforcing capacity. A bounded input-item count MUST NOT stand in for a byte or output bound when item sizes or expansion can be large.

An operation that collects a complete stream into memory MUST establish that the sequence and resulting allocation fit the operation's supported bound. A transform MUST handle oversized or incomplete input through its defined failure or partial-result contract instead of waiting indefinitely for a condition that cannot be satisfied within its capacity.

### ASYNC-039 — Fan-out and fan-in preserve branch ownership

A split, multicast, or merged stream MUST define each branch's ownership, slow-consumer behavior, cancellation propagation, and terminal contribution. One abandoned branch MUST NOT silently retain an unbounded backlog or cancel work still owned by another consumer.

A merge MUST define any ordering its consumer depends on and how a failed or exhausted input affects remaining inputs. Fairness is required where promised by the consumption contract. Per-branch capacity MUST account for shared upstream retention; adding a branch MUST NOT silently invalidate the existing bound or completion guarantee.

### ASYNC-040 — Early consumer exit performs the required source release

A consumer that stops before natural stream exhaustion MUST invoke or transfer responsibility for the source's required cancellation, iterator finalization, or resource release. Breaking a loop, releasing a lock, or dropping a wrapper MUST NOT be assumed sufficient without the actual protocol guarantee.

Asynchronous finalization MUST be awaited or accepted by the appropriate lifecycle owner. Failures during source release MUST preserve the primary outcome under the Error rules. An adapter MUST retain a release path when validation or transformation fails before the next item reaches the consumer.

Web Streams distinguish releasing a reader lock from cancelling the stream. Their asynchronous iterator normally cancels on early return, while `preventCancel` changes that behavior; adapters must preserve the chosen ownership contract. [WHATWG stream iteration](https://streams.spec.whatwg.org/#rs-asynciterator).

### ASYNC-041 — Item ownership survives suspension and buffer reuse

Each stream boundary MUST define whether an item is an immutable value, an independent copy, a borrowed view with a limited lifetime, or an explicitly transferred resource under the applicable Object and Interface rules.

A consumer MUST NOT retain a borrowed view beyond its valid lifetime or observe a buffer after its producer reuses or transfers it. Copying or retaining data MUST be accounted for in the capacity policy. Transport chunks MUST NOT be treated as complete application records unless the framing contract guarantees that boundary.

### Callback adapters and runtime boundaries

### ASYNC-042 — Callback adapters settle once and release registration

An adapter converting callback-driven work to an asynchronous completion MUST handle synchronous callback invocation during registration, setup failure after partial registration, repeated callbacks, and cancellation racing with completion where the source permits them.

Only one terminal path may determine the result or perform each release. A callback arriving after termination MUST NOT regain authority, leak a newly supplied resource, or create an unobserved failure. The adapter MUST release the exact registration it owns without removing another consumer's registration. Subscription semantics remain with `EVENT-036` through `EVENT-040`.

### ASYNC-043 — Deferred work retains only valid execution context

Work deferred from a callback, renderer phase, request scope, or native event MUST retain only the data, capabilities, and authority valid for its later execution. An expired native object or borrowed request resource MUST NOT be treated as a durable context merely because a closure captured it.

Deferred execution MUST preserve the applicable Component, Hook, and Event phase restrictions, including the actual effect setup and cleanup protocol. Creating a task MUST NOT make ordinary callbacks eligible to call Hooks or make an unsupported asynchronous effect return value valid.

### ASYNC-044 — Cross-runtime completion accounts for actual remote work

When a task delegates work to a worker, thread, subprocess, or remote operation, the boundary MUST define what its local completion handle observes and how termination or loss of that handle affects the delegated execution.

Stopping observation, sending a termination request, and observing execution exit MUST NOT be conflated. Required output channels, child resources, and failure reporting MUST retain owners until their promised completion or explicit transfer. A worker or process adapter MUST respect its runtime's thread, polling, blocking, and release requirements rather than projecting one language's promise semantics onto another runtime.

### Documentation, compatibility, and verification

### ASYNC-045 — Contracts document observable temporal behavior

Documentation required by the existing Function, Interface, Class, API, Event, and JSDoc standards MUST include the temporal facts callers need: activation, completion scope, ownership, cancellation effect, deadlines, permitted concurrency, and release responsibilities where applicable.

Streams additionally require relevant demand, consumption, item-lifetime, and early-exit semantics. Guarantees MUST distinguish enforced behavior from dependency limitations. Documentation MUST NOT promise immediate cancellation, ordered effects, bounded memory, or complete cleanup solely because an implementation uses a familiar asynchronous primitive.

### ASYNC-046 — Temporal changes receive compatibility review

Changing eager versus lazy execution, accepted versus completed outcomes, overlap, ordering, cancellation scope, queue rejection, stream reuse, or cleanup timing MUST be assessed as a contract change when callers rely on that behavior.

Affected callers, owners, adapters, tests, and documentation MUST remain consistent under the existing compatibility rules. Keeping the same signature is insufficient if the change introduces new effects before observation, releases a resource earlier, or changes which failures reach the caller. Internal scheduling changes that preserve every observable guarantee need no invented migration process.

### ASYNC-047 — Tests control meaningful execution boundaries

Tests for asynchronous coordination MUST establish the relevant schedule using controlled completions, barriers, clocks, or runtime facilities where practical. Arbitrary sleeps MUST NOT be the sole evidence that work started, remained blocked, respected ordering, or finished cleanup.

Assertions MUST observe the required effects and terminal outcomes, not merely the existence of a promise or a called cancellation method. Tests themselves MUST observe and release the work they start. Production cancellation, clocks, and scheduling MUST remain real dependencies rather than being weakened to satisfy the test.

### ASYNC-048 — Startup and group tests cover partial ownership

Where an operation starts or supervises multiple tasks, verification MUST cover relevant partial launch failure, synchronous completion during setup, child failure, derived-continuation failure, and parent exit while a child remains pending.

Race and aggregate tests MUST verify the fate of nonselected work, including its failures and resources, and applicable empty or all-failed inputs. Shared-execution tests MUST verify one observer leaving while another still requires the work. Cases apply to the actual abstraction and supported inputs; tests MUST NOT invent unsupported features to satisfy a checklist.

### ASYNC-049 — Cancellation tests cover the transitions that can race

Cancellation and deadline verification MUST cover relevant cancellation before activation, during queue admission or a pending wait, after partial progress, and around the operation's commit boundary. The test MUST distinguish the observer's outcome from the work's actual terminal state.

Where work can be replaced, tests MUST verify late success, failure, and finalization cannot affect the replacement. Where acquisition can finish late, tests MUST verify release or valid ownership transfer. A signal changing after an unrelated failure MUST NOT make the test accept a false cancellation classification.

### ASYNC-050 — Queue and timer tests verify progress and capacity

For bounded or serialized work, verification MUST cover the relevant active and pending limits, admission during shutdown, queued cancellation, permit release, and behavior after an operation fails. The test MUST prove that later independent work can progress when that is the queue contract.

Recurring asynchronous work MUST be tested with an execution lasting beyond a recurrence interval and with shutdown racing a runnable callback where those paths are supported. Retry tests MUST verify cancelled delays and exhausted budgets do not start another attempt, and timed-out attempts do not accidentally overlap a retry.

### ASYNC-051 — Stream tests cover demand and early termination

Stream verification MUST cover relevant no-consumption, first-read failure, normal exhaustion, early consumer exit, producer failure, cancellation with a pending operation, and release failure. Assertions MUST include source and stage cleanup and the correct treatment of partial or buffered output.

When capacity, transformation, or branching is part of the implementation, tests MUST include slow downstream consumption, supported oversized-input handling, transform expansion, and an abandoned branch as applicable. Framed adapters MUST exercise records split across chunks and multiple records in one chunk under the API contract.

### ASYNC-052 — Shutdown tests prove terminal ownership

An asynchronous owner with cleanup MUST be verified while work is queued, active, or completing late as applicable. Tests MUST prove admission closes at the required point, dependencies remain usable until owned work no longer needs them, and all required releases are attempted despite failure.

Repeated or concurrent cleanup MUST produce the promised shared outcome and terminal state. Verification MUST include operation-plus-cleanup failure preservation and any supported cleanup-deadline failure path. A test that only checks a cancellation request or release call MUST NOT establish that background work terminated or resources became safe to release.
