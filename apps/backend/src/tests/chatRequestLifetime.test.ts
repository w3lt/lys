import assert from "node:assert/strict"
import { test } from "node:test"
import { ChatRequestLifetime } from "../modules/chat/chat/requestLifetime"

/** Verifies disposal closes admission and shares completion while admitted work drains. */
async function handleConcurrentDisposal(): Promise<void> {
  await using lifetime = new ChatRequestLifetime()
  const release = Promise.withResolvers<void>()
  using cleanup = new DisposableStack()
  cleanup.defer(release.resolve)
  const task = lifetime.createRequestTask(() => release.promise)
  const closing = lifetime[Symbol.asyncDispose]()
  assert.equal(lifetime[Symbol.asyncDispose](), closing)
  await assert.rejects(
    lifetime.createRequestTask(async () =>
      assert.fail("Closed work was admitted")
    ),
    /closed/
  )
  release.resolve()
  await Promise.all([task, closing])
  assert.equal(lifetime[Symbol.asyncDispose](), closing)
  await assert.rejects(
    lifetime.createRequestTask(async () =>
      assert.fail("Disposed work was admitted")
    ),
    /closed/
  )
}

/** Verifies request rejection remains observable without preventing resource drainage. */
async function handleRejectedRequest(): Promise<void> {
  await using lifetime = new ChatRequestLifetime()
  const failure = new Error("Controlled request failure")
  /** Rejects one admitted request at the public lifetime boundary. */
  async function handleFailure(): Promise<void> {
    throw failure
  }
  const request = lifetime.createRequestTask(handleFailure)
  const observed = assert.rejects(request, failure)
  await lifetime[Symbol.asyncDispose]()
  await observed
}

test(
  "chat disposal is shared and permanently closes request admission",
  handleConcurrentDisposal
)
test(
  "chat disposal drains a rejecting request without hiding its failure",
  handleRejectedRequest
)
