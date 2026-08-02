# Variable

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

## Definition

A variable is a named binding whose value is intentionally reassigned during its lifetime. If the binding is never reassigned, it must be a constant.

## Construction recipe

Before creating a variable:

1. Identify the single domain value it represents.
2. Confirm that the binding must be reassigned.
3. Choose the innermost lexical scope containing every read and write.
4. Give it its first valid domain value at declaration.
5. Name it according to meaning, state, and units.
6. Enumerate every write and confirm each preserves the same meaning and invariants.
7. Confirm that one owner controls all writes.
8. Replace coupled variables with one state object when they must change atomically.

## Mandatory rules

### VAR-001 — Mutation must be necessary

A variable MUST have at least one assignment after initialization. Otherwise, use a constant.

If separate branches assign one final value and the value is read only after those branches, construct the value with a conditional, match expression, or focused function instead.

TypeScript:

```ts
// Noncompliant
let accessLevel: AccessLevel

if (user.isAdministrator) {
  accessLevel = "administrator"
} else {
  accessLevel = "member"
}

// Compliant
const accessLevel: AccessLevel = user.isAdministrator
  ? "administrator"
  : "member"
```

Rust:

```rust
// Noncompliant
let access_level;

if user.is_administrator {
    access_level = AccessLevel::Administrator;
} else {
    access_level = AccessLevel::Member;
}

// Compliant
let access_level = if user.is_administrator {
    AccessLevel::Administrator
} else {
    AccessLevel::Member
};
```

### VAR-002 — One variable, one meaning

Every assignment MUST represent the same domain concept, type, unit, and lifecycle state.

A variable MUST NOT be reused for another purpose merely to avoid declaring another binding.

```ts
// Noncompliant: `value` changes meaning three times.
let value: unknown = request.body
value = requestSchema.parse(value)
value = createConversationCommand(value)

// Compliant
const requestBody: unknown = request.body
const parsedRequest = requestSchema.parse(requestBody)
const command = createConversationCommand(parsedRequest)
```

### VAR-003 — Innermost possible scope

A variable MUST be declared inside the innermost lexical block containing all its reads and writes.

It MUST NOT exist before its first required operation or remain accessible after its final use.

```ts
// Noncompliant
let retryDelayMs = 0

if (shouldRetry(error)) {
  retryDelayMs = calculateRetryDelay(error)
  await wait(retryDelayMs)
}

// Compliant
if (shouldRetry(error)) {
  const retryDelayMs = calculateRetryDelay(error)
  await wait(retryDelayMs)
}
```

### VAR-004 — Valid initialization

A variable MUST receive a valid domain value when declared.

Placeholder values such as `null`, `undefined`, `0`, `-1`, `""`, or an empty collection MUST NOT be used only to permit later assignment.

Such a value is allowed only when it represents a real domain state and the variable's type explicitly models that state.

```ts
// Noncompliant: `undefined` is only an initialization workaround.
let conversation: Conversation | undefined
conversation = await loadConversation(id)
return conversation.title

// Compliant
const conversation = await loadConversation(id)
return conversation.title
```

```rust
// Noncompliant: `None` is not a real state here.
let mut conversation: Option<Conversation> = None;
conversation = Some(load_conversation(id)?);

// Compliant
let conversation = load_conversation(id)?;
```

### VAR-005 — Domain-specific naming

A variable name MUST identify the value without requiring the reader to inspect its assignments.

Names MUST follow these rules:

- Use a domain noun or noun phrase.
- Name Boolean values as predicates, such as `isLoaded`, `hasMessages`, or `canRetry`.
- Name collections with either a plural noun or their domain collection type, such as `messages`, `messageQueue`, or `userIndex`.
- Include the unit when the type does not encode it, such as `timeoutMs`, `sizeBytes`, or `temperatureCelsius`.
- Include lifecycle state when relevant, such as `pendingRequest` or `activeConversation`.
- Do not use `data`, `value`, `item`, `object`, `thing`, `temp`, `flag`, or `result` when a domain name is available.
- Single-letter names are allowed only for established mathematical coordinates or a loop index whose entire scope is the loop.

```ts
// Noncompliant
let flag = messages.length > 0
let delay = 5
let data = await repository.find(id)

// Compliant
const hasMessages = messages.length > 0
const retryDelayMs = 5
const conversation = await repository.find(id)
```

### VAR-006 — Explicit write ownership

One function, object, or state owner MUST control every write to a variable.

A mutable local MUST NOT be written by multiple asynchronous callbacks, tasks, subscriptions, or event handlers. Promote that value to an explicit state owner, reducer, synchronized structure, or message channel.

```ts
// Noncompliant: two asynchronous operations mutate the same local.
let completedRequests = 0

firstRequest.then(() => {
  completedRequests += 1
})

secondRequest.then(() => {
  completedRequests += 1
})

// Compliant: collect results through one operation.
const completedRequests = (
  await Promise.allSettled([firstRequest, secondRequest])
).filter((result) => result.status === "fulfilled").length
```

Rust:

```rust
// Noncompliant conceptually:
// multiple tasks mutating an unsynchronized shared counter.

// Compliant: ownership and synchronization are explicit.
let completed_requests = Arc::new(AtomicUsize::new(0));
```

The Rust example remains compliant only when the atomic ordering and ownership contract are appropriate and documented.

### VAR-007 — Local and auditable writes

Every write to a local variable MUST be visible within the same function body.

A mutable variable MUST NOT be changed through a hidden alias or a helper that receives a mutable reference without the mutation being part of the helper's named contract.

```rust
// Noncompliant: the name does not disclose mutation.
adjust(&mut retry_count);

// Compliant
decrement_remaining_retries(&mut remaining_retries);
```

If understanding the current value requires tracing writes across unrelated branches or callbacks, replace the variable with:

- An immutable result.
- A focused function.
- An explicit state machine.
- A reducer.
- An owned object with named transition methods.

### VAR-008 — Atomic invariants

Variables that form one invariant MUST change as one value.

If two or more variables must always be updated together to remain valid, replace them with a single object, record, tuple, or state variant.

```ts
// Noncompliant: these values can contradict each other.
let isLoading = false
let loadingError: Error | null = null

// Compliant
type LoadingState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; error: Error }

let loadingState: LoadingState = { status: "idle" }
```

### VAR-009 — No duplicated derived state

A variable MUST NOT store a value that can become stale after its source changes.

Choose one of these implementations:

1. Calculate the value when needed.
2. Update the source and derived value atomically inside one owner.
3. Use a cache with an explicit key and invalidation contract.

```ts
// Noncompliant
let messages: Message[] = []
let messageCount = messages.length

messages.push(newMessage)
// `messageCount` is now stale.

// Compliant
let messages: Message[] = []
messages.push(newMessage)

const messageCount = messages.length
```

### VAR-010 — No ambiguous shadowing

A binding MUST NOT shadow another binding with the same name while the original binding remains logically relevant.

Sequential shadowing is allowed only when the new binding is a refined representation of the same concept and the previous representation is no longer used.

Rust:

```rust
// Compliant: the text is refined into the same domain concept.
let port = read_port_setting();
let port: u16 = port.parse()?;

// Noncompliant: the name changes domain meaning.
let value = read_port_setting();
let value = connect_to_server(value)?;
```

### VAR-011 — Mutation must preserve invariants

Every assignment MUST leave the variable in a valid state according to its type and domain contract.

A variable MUST NOT temporarily hold an invalid value between operations.

```ts
// Noncompliant: balance is temporarily invalid.
accountBalanceCents -= withdrawalCents

if (accountBalanceCents < 0) {
  accountBalanceCents += withdrawalCents
  throw new InsufficientFundsError()
}

// Compliant
if (withdrawalCents > accountBalanceCents) {
  throw new InsufficientFundsError()
}

accountBalanceCents -= withdrawalCents
```

## Appropriate uses

A variable is appropriate for:

- A loop counter.
- An accumulator.
- A cursor that advances through input.
- A retry counter.
- A value transitioning through an explicit local state machine.
- A resource handle whose lifecycle explicitly includes replacement or release.

Every use must still satisfy the rules above.

## Verification checklist

A variable is compliant only when every answer is “yes”:

- [ ] Is the binding reassigned after initialization?
- [ ] Does every assignment preserve one domain meaning, type, and unit?
- [ ] Is it declared in the innermost block containing all uses?
- [ ] Is its initial value valid rather than a placeholder?
- [ ] Does its name identify its meaning and units?
- [ ] Does one identifiable owner perform every write?
- [ ] Are all local writes visible and auditable?
- [ ] Are coupled invariants represented as one value?
- [ ] Can the value remain synchronized with every source it derives from?
- [ ] Is shadowing absent or limited to same-concept refinement?
- [ ] Does every assignment preserve the variable's invariant?
