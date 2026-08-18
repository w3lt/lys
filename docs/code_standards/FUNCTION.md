# Function

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

## Definition

A function is a callable unit that accepts inputs and produces an observable result, side effect, or both.

These rules apply to named functions, methods, closures, callbacks, event handlers, and constructors implemented as callable functions. Methods, hooks, and components also receive their item-specific rules.

## Construction recipe

Before writing a function:

1. State the single operation it performs.
2. Classify it as a calculation, query, command, boundary adapter, orchestrator, or renderer-recognized declarative view projection.
3. List its required inputs.
4. Define its successful result.
5. Define expected failure and absence outcomes.
6. List every observable side effect.
7. Identify external dependencies such as storage, network, time, randomness, and process state.
8. Choose a name under `FUNC-003`, using its canonical verb vocabulary or its exact Component naming exception.
9. Design the signature with no more than three positional parameters.
10. Validate untrusted input before domain logic or side effects.
11. Write the successful path using one abstraction level and the fewest control-flow levels.
12. Add failure, boundary, cancellation, and cleanup paths.
13. Verify the function remains within the defined size and complexity limits.
14. Write tests for every observable behavior path.
15. Add the required API documentation comment.

## Function categories

Every function MUST belong to one primary category.

### Calculation

A calculation produces a value from its inputs without observable side effects.

```ts
function calculateTotalCents(lines: readonly OrderLine[]): number {
  return lines.reduce(
    (totalCents, line) => totalCents + line.unitPriceCents * line.quantity,
    0
  )
}
```

### Query

A query reads state and returns information without modifying the observed state.

```ts
async function findConversation(
  conversationId: string,
  conversationReader: ConversationReader
): Promise<Conversation | undefined> {
  return conversationReader.findConversationById(conversationId)
}
```

### Command

A command changes state or causes an external effect. Its name MUST expose that effect.

```ts
async function saveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<void> {
  await conversationWriter.saveConversation(conversation)
}
```

A command MAY return the created or updated result. Returning a result does not make the side effect optional or hidden.

### Boundary adapter

A boundary adapter translates between external and trusted representations.

```ts
function parseCreateConversationRequest(
  requestBody: unknown
): CreateConversationInput {
  return createConversationInputSchema.parse(requestBody)
}
```

### Orchestrator

An orchestrator coordinates focused collaborators to complete one use case. It MAY sequence multiple operations but MUST NOT embed their independent policies.

```ts
async function createConversation(
  requestBody: unknown,
  services: CreateConversationServices
): Promise<Conversation> {
  const input = parseCreateConversationRequest(requestBody)
  const conversation = buildConversation(input, services.clock)

  await services.conversationWriter.saveConversation(conversation)

  return conversation
}
```

### Declarative view projection

A declarative view projection is a renderer-recognized Component callable that produces a view description from its component contract and current renderer-managed inputs.

Only a Component construct under `COMP-001` MAY select this category. A direct render helper or ordinary function remains classified by its actual operation under `COMP-003`.

## Example scope

Rule-specific examples isolate the rule under discussion. A `Compliant` label means compliant with that rule; declarations and documentation unrelated to the demonstrated rule may be omitted. The complete examples at the end of this chapter demonstrate the combined construction rules.

## Mandatory rules

### FUNC-001 — One primary operation

A function MUST perform or orchestrate one primary operation.

Every statement in the function MUST do at least one of the following for that operation:

- Validate a precondition.
- Calculate part of its result.
- Delegate a required step.
- Apply its documented side effect.
- Translate its result or failure.
- Release a resource owned by the operation.

A function MUST be split when it contains two behaviors that:

1. Have different domain purposes or change triggers.
2. Can be invoked or tested independently.
3. Share no required invariant or lifecycle.

```ts
// Noncompliant: formatting and persistence are independent operations.
async function formatAndSaveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<string> {
  const formattedTitle = conversation.title.trim().toUpperCase()

  await conversationWriter.saveConversation({
    ...conversation,
    title: formattedTitle
  })

  return formattedTitle
}

// Compliant
function formatConversationTitle(title: string): string {
  return title.trim().toUpperCase()
}

async function saveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<void> {
  await conversationWriter.saveConversation(conversation)
}
```

An orchestrator passes this rule only when it delegates independent policies instead of implementing them inline. This rule is the function-level application of SRP.

### FUNC-002 — Category must remain consistent

A function MUST preserve its primary category across every behavior path.

A calculation or query MUST NOT modify externally observable state. A command or orchestrator MUST expose its side effects through its name, contract, or containing boundary.

A declarative view projection MUST remain a projection during renderer invocation. Producing a declarative view description, including binding an event callback for later invocation, is not imperative user-interface mutation. An event handler, effect callback, lifecycle callback, or other callable declared or referenced by a component remains a separate Function construct and MUST use the category matching what occurs when that callable is invoked.

```ts
// Noncompliant: a query silently updates access time.
async function findConversation(
  conversationId: string,
  conversationReader: ConversationReader,
  conversationAccessRecorder: ConversationAccessRecorder
): Promise<Conversation | undefined> {
  const conversation =
    await conversationReader.findConversationById(conversationId)

  if (conversation) {
    await conversationAccessRecorder.updateConversationLastAccessedAt(
      conversationId,
      new Date()
    )
  }

  return conversation
}
```

Use two explicit operations when both behaviors are required:

```ts
const conversation = await findConversation(conversationId, conversationReader)

if (conversation) {
  await updateConversationLastAccessedAt(
    conversationId,
    conversationAccessRecorder,
    clock
  )
}
```

### FUNC-003 — Canonical operation vocabulary

A function name MUST begin with the canonical verb or predicate that matches its operation. Synonyms MUST NOT coexist for the same operation.

| Operation                                   | Required verb                    | Contract                                                                                  |
| ------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| Retrieve one identified domain value        | `get`                            | General retrieval, whether synchronous or asynchronous. Do not use `fetch` or `retrieve`. |
| Search where absence is expected            | `find`                           | Returns an optional or explicit absence result.                                           |
| Retrieve a collection                       | `list`                           | Returns zero or more items. Do not use `getAll` or `fetchAll`.                            |
| Bring a resource into active runtime state  | `load`                           | Performs a lifecycle transition.                                                          |
| Consume raw text or bytes                   | `read`                           | Performs a low-level stream or filesystem read.                                           |
| Create a domain value                       | `create`                         | Produces a new domain entity.                                                             |
| Assemble an in-memory representation        | `build`                          | Combines existing parts without an external side effect.                                  |
| Persist a new or changed entity             | `save`                           | Completes persistence before successful return.                                           |
| Modify an existing entity                   | `update`                         | Applies a domain change.                                                                  |
| Permanently remove persisted data           | `delete`                         | Performs persistent deletion.                                                             |
| Remove an item from an in-memory collection | `remove`                         | Changes collection membership.                                                            |
| Validate and convert untrusted input        | `parse`                          | Returns a trusted value or fails.                                                         |
| Produce display text                        | `format`                         | Performs a presentation-only transformation.                                              |
| Produce a calculated value                  | `calculate`                      | Performs a deterministic calculation. Do not use `compute`.                               |
| Answer a Boolean question                   | `is`, `has`, `can`, `should`     | Returns a pure Boolean result.                                                            |
| React to a named event                      | `handle<Event>`                  | Coordinates the complete named event.                                                     |
| Begin or end a lifecycle                    | `start`, `stop`, `open`, `close` | Performs the named lifecycle transition.                                                  |
| Abandon an in-progress operation            | `cancel`                         | Ends the operation without committing its intended outcome.                               |
| Move persisted state to a supported version | `migrate`                        | Completes the declared schema or data-version transition before return.                   |

The function name MUST include the domain object or outcome after the verb. Names such as `doWork`, `process`, `manage`, `execute`, `run`, `handle`, or `util` MUST NOT be used without a domain-specific operation or complete event name.

For a type-associated factory or lifecycle operation, the owning type supplies the domain object. Names such as `SqliteConversationStore.open()` and `DraftSession::create()` are allowed. The module-level equivalents MUST include the object, such as `openSqliteConversationStore()` and `createDraftSession()`.

A native constructor declaration is exempt from the verb-prefix and domain-object wording because the language supplies its name. A compliant property accessor uses a noun property name and the parameter shape required by `CLASS-017` through `CLASS-019`; languages without property syntax MAY use their conventional equivalent accessor form.

A renderer-recognized Component declaration MUST instead use the noun or noun-phrase name required by `COMP-017`. This exception applies only to a declaration satisfying `COMP-001`; an ordinary function or direct render helper under `COMP-003` MUST use the canonical operation vocabulary.

Native constructors and compliant accessors retain their syntax-specific exceptions. A renderer-recognized Component declaration is the only repository-designed noun-name exception for an ordinary named function declaration.

```ts
// Noncompliant
function process(data: unknown): Result {
  // ...
}

async function fetchLlmList(): Promise<Llm[]> {
  // ...
}

// Compliant
function parseConversationImport(data: unknown): ConversationImport {
  // ...
}

async function listLlms(): Promise<Llm[]> {
  // ...
}
```

Language built-ins and signatures imposed by a framework, trait, protocol, foreign-function interface, or third-party contract retain their exact external names, including the browser's `fetch()` API. A required implementation or override MUST remain in an adapter and delegate repository-designed operations that use canonical vocabulary. A new repository-designed verb requires an update to this vocabulary that defines a non-overlapping operation before the verb is used in code.

A name MUST NOT claim weaker or different behavior than its implementation. A function named `find` must not create missing data, and a function named `parse` must not persist its result.

### FUNC-004 — Maximum positional parameters

A repository-owned function MUST have no more than three positional parameters. The receiver of a method, such as `this` or `self`, does not count.

When more inputs are required, use a named input object only when its fields form one cohesive operation contract.

```ts
// Noncompliant
function createMessage(
  conversationId: string,
  role: MessageRole,
  text: string,
  createdAt: Date,
  modelId: string
): Message {
  // ...
}

// Compliant
type CreateMessageInput = {
  conversationId: string
  role: MessageRole
  text: string
  createdAt: Date
  modelId: string
}

function createMessage(input: CreateMessageInput): Message {
  // ...
}
```

The named object MUST NOT become a general bag of unrelated optional settings.

Signatures imposed by a framework, language trait, foreign interface, or third-party callback are exempt. Repository-owned logic inside such a function MUST still be delegated through a compliant signature.

### FUNC-005 — No mode-selection flags

A Boolean parameter MUST NOT select between separate algorithms, effects, result shapes, or lifecycle behaviors. Create separate functions or use an explicit variant.

```ts
// Noncompliant
function getConversation(id: string, includeMessages: boolean): Conversation {
  // ...
}

// Compliant
function getConversationMetadata(id: string): ConversationMetadata {
  // ...
}

function getConversationWithMessages(id: string): Conversation {
  // ...
}
```

A Boolean parameter is allowed when it represents intrinsic input data rather than choosing which function the caller intends to invoke.

```ts
function updateAutostart(enabled: boolean): RuntimeSettings {
  // `enabled` is the domain value being written.
}
```

### FUNC-006 — Inputs must be necessary and immutable

Every parameter MUST be read by the function or deliberately forwarded as part of its operation. A function MUST NOT accept parameters for anticipated future use.

Parameters MUST NOT be mutated unless mutation is the explicit operation named by the function and ownership transfer is part of the contract.

```ts
// Noncompliant
function normalizeConversation(conversation: Conversation): Conversation {
  conversation.title = conversation.title.trim()
  return conversation
}

// Compliant
function normalizeConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    title: conversation.title.trim()
  }
}
```

A function MUST NOT retain a reference to a mutable input beyond the call unless the contract explicitly transfers or shares ownership.

### FUNC-007 — Validate at the trust boundary

A function that receives untrusted, external, serialized, persisted, or dynamically typed input MUST validate the complete required input before calling domain logic, mutating state, performing external side effects, or treating the value as a trusted type.

```ts
// Noncompliant
async function createConversation(requestBody: unknown): Promise<void> {
  const body = requestBody as CreateConversationInput
  await conversationWriter.saveConversation(buildConversation(body))
}

// Compliant
async function createConversation(requestBody: unknown): Promise<void> {
  const input = createConversationInputSchema.parse(requestBody)
  const conversation = buildConversation(input)

  await conversationWriter.saveConversation(conversation)
}
```

Internal functions receiving already validated domain types MUST NOT repeat boundary parsing unless they establish a different invariant. Precondition failure MUST occur before the first side effect whenever the precondition can be checked in advance.

### FUNC-008 — Defaults must not hide invalid input

A default parameter or fallback value MAY be used only when omission is a valid, documented input state.

A default MUST NOT conceal a missing required value, invalid external input, corrupt persisted data, missing configuration, or an unavailable required dependency.

```ts
// Noncompliant
function connectToBackend(url = "http://localhost:3000"): Connection {
  // Missing configuration becomes an implicit environment assumption.
}

// Compliant
function connectToBackend(url: BackendUrl): Connection {
  // ...
}
```

Application defaults must be applied by the layer that owns the setting before calling the function.

### FUNC-009 — One return contract

Every successful return path MUST produce the same semantic result category.

A function MUST NOT:

- Return a value on one successful path and `undefined` on another unless absence is part of the declared type.
- Throw for one expected absence path and return `undefined` for an equivalent path.
- Return sentinel values such as `-1`, `""`, `false`, or `null` when they do not represent a valid declared outcome.
- Return positional tuples whose elements do not have obvious, stable meanings.
- Return internal transport or persistence representations from a domain operation.

```ts
// Noncompliant
function findMessage(id: string): Message | null | false {
  // ...
}

// Compliant
function findMessage(id: string): Message | undefined {
  // ...
}
```

Use a named result object when multiple values form one result:

```ts
type PaginationResult<T> = {
  items: readonly T[]
  nextCursor?: string
}
```

### FUNC-010 — Expected outcomes must be explicit

Expected absence, rejection, conflict, cancellation, and validation failure MUST be represented consistently in the function's return or error contract.

A function MUST choose one contract for equivalent expected outcomes: an optional result, a result union, a domain-specific exception, or an explicit status variant. It MUST NOT mix these contracts for equivalent cases.

Rust:

```rust
fn find_conversation(id: ConversationId) -> Result<Option<Conversation>, StoreError> {
    // `None` means expected absence.
    // `Err` means retrieval failed.
}
```

TypeScript:

```ts
type GetConversationResult =
  | { status: "found"; conversation: Conversation }
  | { status: "not-found" }
  | { status: "failed"; error: ConversationAccessError }
```

Unexpected errors MUST remain observable. A function MUST NOT catch an error only to return false success.

### FUNC-011 — Observable side effects must be explicit

A function has an observable side effect when it changes or interacts with persistent data, filesystem state, network state, process state, user-interface state, shared mutable state, time-dependent scheduling, logging, telemetry, or an external resource.

A function with side effects MUST expose them through its category, name, injected dependency, return contract, or documentation.

Domain calculation functions MUST receive time, randomness, and environment-derived values as inputs instead of reading them implicitly.

```ts
// Noncompliant
function createConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString()
  }
}

// Compliant
type CreateConversationDependencies = {
  readonly createConversationId: () => string
  readonly getCurrentDate: () => Date
}

function createConversation(
  dependencies: CreateConversationDependencies
): Conversation {
  return {
    id: dependencies.createConversationId(),
    createdAt: dependencies.getCurrentDate().toISOString()
  }
}
```

### FUNC-012 — Dependencies must be visible and narrow

A function MUST NOT retrieve collaborators from a hidden mutable global, service locator, or ambient request context.

Dependencies MUST be provided through parameters, an owning object's constructor, or a language- or framework-defined context whose presence is explicit in the callable contract.

The function MUST depend on the smallest domain-facing capability that contains every operation it uses and no unrelated operations. It MUST NOT depend directly on a filesystem, database, HTTP, framework, or vendor client when a high-level domain policy needs only a domain capability.

```ts
// Noncompliant
async function saveConversation(conversation: Conversation): Promise<void> {
  await globalServices.database.conversations.insert(conversation)
}

// Noncompliant: the function receives unrelated capabilities.
async function saveConversation(
  conversation: Conversation,
  services: ApplicationServices
): Promise<void> {
  await services.conversationWriter.saveConversation(conversation)
}

// Compliant
async function saveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<void> {
  await conversationWriter.saveConversation(conversation)
}
```

This rule applies ISP and DIP to the function boundary.

### FUNC-013 — Complexity limits

A function MUST satisfy all of these limits:

- No more than **40 executable lines** in its body.
- No more than **8 decision points**.
- No more than **3 nested control-flow blocks**.
- No condition containing more than **2 Boolean operators** without extraction into a named predicate.
- No inline callback containing more than **5 executable lines** or its own nested control-flow block.

For this rule:

- Blank lines, comments, the signature, and lines containing only delimiters do not count as executable lines.
- Decision points include `if`, `else if`, conditional expressions, loops, catch clauses, guarded match arms, and Boolean short-circuit branches.
- Consecutive match or switch variants implementing one exhaustive dispatch count as separate decision paths but MAY remain together when each arm delegates to a focused operation.

When a limit is exceeded, extract a named predicate, calculation, policy, transition, boundary adapter, or focused collaborator.

Code MUST NOT satisfy the limits through meaningless one-line wrappers or fragmented functions that hide one operation.

### FUNC-014 — Guard clauses before the primary path

Invalid inputs, unavailable prerequisites, terminal states, and expected early exits SHOULD be handled before the primary successful path.

An `else` block MUST NOT follow a branch that always returns, throws, continues, or breaks.

```ts
// Noncompliant
function sendMessage(message: Message, transport: MessageTransport): void {
  if (message.text.length > 0) {
    transport.send(message)
  } else {
    throw new EmptyMessageError()
  }
}

// Compliant
function sendMessage(message: Message, transport: MessageTransport): void {
  if (message.text.length === 0) {
    throw new EmptyMessageError()
  }

  transport.send(message)
}
```

Guard clauses MUST NOT scatter one invariant across unrelated exits. Related validation failures should remain together when one validation operation can represent them.

### FUNC-015 — Exhaustive branching

A function MUST handle every variant of a closed type or state machine explicitly. A default branch MUST NOT hide newly added variants.

TypeScript:

```ts
function formatLoadingStatus(status: LoadingStatus): string {
  switch (status) {
    case "idle":
      return "Idle"
    case "loading":
      return "Loading"
    case "failed":
      return "Failed"
    default:
      return assertNever(status)
  }
}
```

Rust:

```rust
fn format_loading_status(status: LoadingStatus) -> &'static str {
    match status {
        LoadingStatus::Idle => "Idle",
        LoadingStatus::Loading => "Loading",
        LoadingStatus::Failed => "Failed",
    }
}
```

Open external values MUST be validated before being converted into a closed internal type.

### FUNC-016 — Predicates must answer one question

A predicate function MUST return a Boolean value, have a positive question-shaped name, perform no observable side effects, produce the same result for the same inputs, answer one domain question, and avoid throwing for an ordinary false result.

```ts
// Noncompliant
function checkConversation(conversation: Conversation): boolean {
  logger.info("Checking conversation")
  return conversation.messages.length > 0 && conversation.title !== null
}

// Compliant
function hasMessages(conversation: Conversation): boolean {
  return conversation.messages.length > 0
}

function hasTitle(conversation: Conversation): boolean {
  return conversation.title !== null
}
```

If answering the question can fail, return an explicit result rather than disguising failure as `false`.

### FUNC-017 — Async completion must be owned

An asynchronous function MUST define how every path completes, fails, and cancels.

Every promise, future, task, stream, process, or callback completion MUST be awaited, returned to the caller, or registered with a named lifecycle owner that observes terminal failure.

```ts
// Noncompliant: failure and completion are unobserved.
function saveConversation(conversation: Conversation): void {
  conversationWriter.saveConversation(conversation)
}

// Compliant
async function saveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<void> {
  await conversationWriter.saveConversation(conversation)
}
```

A function MUST NOT expose both callback-based and promise-based completion for the same operation.

Work that may outlive its caller MUST support cancellation or prove through its contract that late completion cannot mutate current state. Detached work requires an explicit owner, error-reporting path, and shutdown behavior.

### FUNC-018 — Resource ownership must be complete

A function that acquires a resource MUST do one of the following:

1. Release it in the same lexical scope using `finally`, defer, RAII, or an equivalent mechanism.
2. Return an owning value whose type and contract transfer responsibility to the caller.
3. Register it with a lifecycle owner that guarantees cleanup.

TypeScript:

```ts
async function readConversationFile(path: string): Promise<string> {
  const file = await open(path)

  try {
    return await file.readFile({ encoding: "utf8" })
  } finally {
    await file.close()
  }
}
```

A function MUST handle cleanup on success, failure, and cancellation. An early return MUST NOT bypass cleanup.

### FUNC-019 — Inline callbacks must remain local

An inline callback MAY be used only when it:

- Performs one operation.
- Contains no nested control-flow block.
- Contains no more than five executable lines.
- Does not require independent documentation.
- Does not capture mutable state that can outlive the current call.
- Is not reused.

```ts
// Compliant
const visibleMessages = messages.filter(
  (message) => message.status !== "hidden"
)
```

A callback that contains policy, multiple branches, resource ownership, or failure translation MUST be extracted and named.

```ts
// Noncompliant
messages.map((message) => {
  if (message.role === "assistant") {
    if (message.status === "streaming") {
      return normalizeStreamingMessage(message)
    }

    return normalizeCompletedMessage(message)
  }

  return normalizeUserMessage(message)
})

// Compliant
const normalizedMessages = messages.map(normalizeMessage)
```

### FUNC-020 — Methods must require the owning object

An instance method MUST read or change an instance invariant, use an owned resource or dependency, implement an approved interface or polymorphic contract, or require access to private state that callers must not manipulate directly.

A function that depends only on its explicit parameters MUST be a module-level function rather than a method.

```ts
// Noncompliant
class ConversationTitleFormatter {
  formatTitle(title: string): string {
    return title.trim()
  }
}

// Compliant
function formatConversationTitle(title: string): string {
  return title.trim()
}
```

Every method, accessor, constructor, and factory on a repository-owned class also follows the [Class](./CLASS.md) chapter.

### FUNC-021 — Wrappers must add a contract

A wrapper function MUST add at least one observable responsibility:

- Validation.
- Translation.
- Error context.
- Authorization.
- Retry or timeout policy.
- Caching.
- Required instrumentation.
- Compatibility adaptation.
- A stable application or domain use-case boundary.

A pass-through wrapper that only renames another function call MUST NOT be created.

```ts
// Noncompliant: no new contract or boundary is established.
function findConversation(id: string): Promise<Conversation | undefined> {
  return conversationReader.findConversationById(id)
}
```

Directly use the existing operation unless the wrapper establishes one of the responsibilities above.

### FUNC-022 — Overloads must represent one operation

Function overloads or equivalent alternate signatures MUST represent the same semantic operation and produce the same result category.

Overloads MUST NOT hide unrelated modes or side effects. The implementation MUST normalize every overload into one internal input representation before executing the operation.

```ts
function parseTimestamp(value: string): Timestamp
function parseTimestamp(value: number): Timestamp

function parseTimestamp(value: string | number): Timestamp {
  const milliseconds = typeof value === "string" ? Date.parse(value) : value

  return timestampSchema.parse(milliseconds)
}
```

Use separate functions when signatures represent different operations.

### FUNC-023 — Every named function requires API documentation

Every named repository-owned function, method, constructor, component, and hook MUST have an API documentation comment immediately before its declaration.

- JavaScript and TypeScript MUST use JSDoc.
- Rust MUST use rustdoc.
- Another language MUST use its standard API documentation format.
- An anonymous inline callback is exempt only when it satisfies `FUNC-019` and defines no independent contract.

Documentation MUST describe every applicable purpose, parameter meaning, constraint, unit, default, successful result, expected absence, failure, side effect, ownership transfer, asynchronous completion, cancellation, and resource lifecycle rule.

JavaScript and TypeScript documentation MUST follow the repository's JSDoc standard, including `@param`, `@returns`, and `@throws` requirements.

```ts
/**
 * Persists a conversation.
 *
 * @param conversation - Valid conversation to persist.
 * @param conversationWriter - Storage capability that owns persistence details.
 * @returns A promise that resolves after persistence completes.
 * @throws If the writer cannot persist the conversation.
 */
async function saveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<void> {
  await conversationWriter.saveConversation(conversation)
}
```

Documentation MUST NOT repeat type syntax, narrate implementation statements, claim behavior the function does not provide, or remain stale after a contract change.

### FUNC-024 — Tests must cover observable paths

A function's behavior MUST be testable through a public or stable internal contract.

Tests MUST cover every applicable successful result, invalid or boundary input, expected absence, expected failure, state transition, side effect, cancellation path, resource cleanup path, and exhaustive variant.

Private helpers do not require direct tests when their complete behavior is exercised through a stable public contract.

A function that cannot be tested without unrelated setup violates `FUNC-001` or `FUNC-012` and MUST be decomposed or have its dependencies made explicit.

### FUNC-025 — One abstraction level

Sibling statements inside a function MUST operate at the same abstraction level.

If one subtask is delegated, comparable sibling subtasks MUST also be delegated. A function MUST NOT coordinate one part of an operation while directly implementing another part's lower-level mechanics.

```ts
// Noncompliant: chat content is delegated while composer mechanics are inline.
function renderChatView(model: ChatViewModel): RenderedView {
  const chatContent = renderChatContent(model.messages)

  const composerElement = document.createElement("textarea")
  composerElement.value = model.draft
  composerElement.disabled = model.isGenerating

  return renderChatLayout(chatContent, composerElement)
}

// Compliant: sibling view regions use the same abstraction level.
function renderChatView(model: ChatViewModel): RenderedView {
  const chatContent = renderChatContent(model.messages)
  const composer = renderComposer(model.composer)

  return renderChatLayout(chatContent, composer)
}
```

A reviewer verifies this rule by grouping sibling statements. If one sibling names a domain operation while another manipulates the implementation details of a comparable operation, the function fails this rule.

### FUNC-026 — Responsibility matches the declared outcome

A function MUST completely own the outcome named by its contract and MUST NOT own mechanisms outside its abstraction.

Successful completion of a function named `saveConversation` means the conversation has been saved according to its persistence contract. It MUST NOT merely schedule, partially prepare, or silently skip the operation unless its name and return contract explicitly describe that weaker outcome.

A high-level save operation MUST delegate filesystem, database, serialization, and vendor API mechanics to a domain-facing persistence capability.

```ts
// Noncompliant application function:
// It owns filesystem paths, serialization, and filesystem mechanics.
async function saveConversation(conversation: Conversation): Promise<void> {
  const filePath = join(databaseDirectory, `${conversation.id}.json`)
  const serializedConversation = JSON.stringify(conversation)

  await writeFile(filePath, serializedConversation, "utf8")
}

// Compliant application function:
// It owns the save outcome and delegates persistence mechanics.
async function saveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<void> {
  await conversationWriter.saveConversation(conversation)
}
```

The adapter implementing the writer contract owns its mechanism:

```ts
/**
 * Stores serialized conversation files for filesystem adapters.
 *
 * Implementations are substitutable and reentrant. A successful save means the
 * complete file contents have been persisted.
 */
interface ConversationFileStore {
  /**
   * Persists the complete contents at one filesystem path.
   *
   * @param filePath - Path owned by the calling adapter.
   * @param contents - Complete serialized file contents.
   * @returns A promise that resolves after the contents are persisted.
   * @throws If the filesystem operation cannot complete.
   */
  saveFile(filePath: string, contents: string): Promise<void>
}

/**
 * Owns mapping persisted conversations to files within one database directory.
 *
 * @remarks
 * Primary category: resource owner or boundary adapter. The class borrows a
 * reentrant file-store capability and is itself reentrant because it retains no
 * mutable state.
 */
class FileConversationWriter implements ConversationWriter {
  /** Stable directory containing conversation files. */
  readonly #databaseDirectory: string

  /** Borrowed reentrant capability for persisting complete file contents. */
  readonly #fileStore: ConversationFileStore

  /**
   * Creates a writer for one database directory.
   *
   * @param databaseDirectory - Stable directory containing conversation files.
   * @param fileStore - Borrowed capability for persisting complete file contents.
   */
  public constructor(
    databaseDirectory: string,
    fileStore: ConversationFileStore
  ) {
    this.#databaseDirectory = databaseDirectory
    this.#fileStore = fileStore
  }

  /**
   * Implements {@link ConversationWriter.saveConversation} using JSON files.
   *
   * @param conversation - Valid immutable conversation to persist.
   * @returns A promise that resolves after the complete file is persisted.
   * @throws If serialization or file persistence cannot complete.
   */
  public async saveConversation(conversation: Conversation): Promise<void> {
    const filePath = join(this.#databaseDirectory, `${conversation.id}.json`)
    const serializedConversation = JSON.stringify(conversation)

    await this.#fileStore.saveFile(filePath, serializedConversation)
  }
}
```

This rule applies SRP and DIP: the high-level function owns what must happen, while the adapter owns how its external mechanism performs it.

### FUNC-027 — Open extension axes use composition

When a domain contract explicitly permits adding implementations without changing the coordinator, the coordinator MUST depend on a stable strategy, handler, or capability contract instead of branching on implementation type.

```ts
// Noncompliant open extension axis.
function formatConversation(
  conversation: Conversation,
  format: ConversationFormat
): string {
  if (format === "plain-text") {
    return formatConversationAsPlainText(conversation)
  }

  if (format === "markdown") {
    return formatConversationAsMarkdown(conversation)
  }

  throw new UnsupportedConversationFormatError(format)
}

// Compliant
interface ConversationFormatter {
  formatConversation(conversation: Conversation): string
}

function formatConversation(
  conversation: Conversation,
  formatter: ConversationFormatter
): string {
  return formatter.formatConversation(conversation)
}
```

This rule applies OCP only to a declared extension axis. A genuinely closed set of domain variants MUST use exhaustive branching instead of a speculative strategy abstraction.

### FUNC-028 — Abstraction consumers must honor substitution

A function accepting an interface, base type, or capability contract MUST rely only on that contract's documented behavior.

It MUST NOT inspect the concrete implementation, branch on implementation type, downcast to access undeclared members, or require undocumented ordering, error, performance, or lifecycle behavior.

```ts
// Noncompliant
async function saveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<void> {
  if (conversationWriter instanceof FileConversationWriter) {
    await conversationWriter.createConversationStorageDirectory()
  }

  await conversationWriter.saveConversation(conversation)
}

// Compliant
async function saveConversation(
  conversation: Conversation,
  conversationWriter: ConversationWriter
): Promise<void> {
  await conversationWriter.saveConversation(conversation)
}
```

Every implementation must satisfy the same preconditions, postconditions, failure contract, ownership rules, and lifecycle semantics. This is the function-level application of LSP.

## Complete TypeScript example

```ts
type CalculateRetryDelayInput = {
  attempt: number
  baseDelayMs: number
  maxDelayMs: number
}

/**
 * Calculates an exponentially increasing retry delay capped by a maximum.
 *
 * @param input - Retry position and delay boundaries in milliseconds.
 * @returns The retry delay in milliseconds, capped by `maxDelayMs`.
 * @throws If the attempt or delay boundaries are invalid.
 */
function calculateRetryDelayMs({
  attempt,
  baseDelayMs,
  maxDelayMs
}: CalculateRetryDelayInput): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new InvalidRetryAttemptError(attempt)
  }

  if (baseDelayMs <= 0 || maxDelayMs < baseDelayMs) {
    throw new InvalidRetryDelayConfigurationError({
      baseDelayMs,
      maxDelayMs
    })
  }

  const exponentialDelayMs = baseDelayMs * 2 ** attempt

  return Math.min(exponentialDelayMs, maxDelayMs)
}
```

This function performs one calculation, uses one cohesive input object, validates before calculation, has no hidden dependencies or side effects, uses one abstraction level, includes units in names, returns one semantic result, and remains inside every complexity limit.

## Complete Rust example

```rust
struct CalculateRetryDelayInput {
    attempt: u32,
    base_delay_ms: u64,
    max_delay_ms: u64,
}

/// Calculates an exponentially increasing retry delay capped by a maximum.
///
/// Returns the delay in milliseconds. Returns an error when the delay range is
/// invalid.
fn calculate_retry_delay_ms(
    input: CalculateRetryDelayInput,
) -> Result<u64, RetryDelayConfigurationError> {
    if input.base_delay_ms == 0 || input.max_delay_ms < input.base_delay_ms {
        return Err(RetryDelayConfigurationError::InvalidRange {
            base_delay_ms: input.base_delay_ms,
            max_delay_ms: input.max_delay_ms,
        });
    }

    let multiplier = 2_u64.saturating_pow(input.attempt);
    let exponential_delay_ms = input.base_delay_ms.saturating_mul(multiplier);

    Ok(exponential_delay_ms.min(input.max_delay_ms))
}
```

## SOLID mapping

The function rules apply SOLID as follows:

- **SRP:** `FUNC-001`, `FUNC-002`, `FUNC-025`, and `FUNC-026`.
- **OCP:** `FUNC-027`.
- **LSP:** `FUNC-028`.
- **ISP:** `FUNC-012`.
- **DIP:** `FUNC-012` and `FUNC-026`.

## Verification checklist

A function is compliant only when every applicable answer is “yes”:

- [ ] Does it perform or orchestrate one primary operation?
- [ ] Is its category—calculation, query, command, adapter, orchestrator, or renderer-recognized declarative view projection—consistent?
- [ ] Does its name use the canonical verb for the exact operation or an exact `FUNC-003` naming exception?
- [ ] Does it have no more than three positional parameters?
- [ ] Are mode-selection flags absent?
- [ ] Is every input necessary, typed, and unmodified?
- [ ] Is untrusted input validated before domain logic and side effects?
- [ ] Are defaults valid domain behavior rather than hidden recovery?
- [ ] Do all successful paths return one semantic result category?
- [ ] Are absence and failure represented consistently?
- [ ] Are side effects and external dependencies visible?
- [ ] Does it depend only on narrow domain-facing capabilities?
- [ ] Does it satisfy all size, decision, nesting, condition, and callback limits?
- [ ] Are terminal and invalid paths handled before the primary path?
- [ ] Is branching exhaustive for closed variants?
- [ ] Are predicates pure and limited to one question?
- [ ] Is every asynchronous completion observed and cancellable when required?
- [ ] Does every acquired resource have guaranteed cleanup or explicit ownership transfer?
- [ ] Are complex callbacks extracted and named?
- [ ] Does each method require its owning object?
- [ ] Does every wrapper add an observable contract?
- [ ] Do overloads represent one operation?
- [ ] Does every named function have accurate API documentation?
- [ ] Do sibling statements use one abstraction level?
- [ ] Does the function complete its named outcome while delegating lower-level mechanisms?
- [ ] Do declared extension axes accept new implementations without modifying the coordinator?
- [ ] Does the function treat every abstraction implementation as substitutable?
- [ ] Do tests cover every relevant behavior path?
