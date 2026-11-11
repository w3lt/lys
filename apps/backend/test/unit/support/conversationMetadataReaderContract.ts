import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { ConversationMetadataReader } from "../../../src/modules/conversation/capabilities"
import { createFixtureUuidV7 } from "./conversationFixtures"
import {
  createFixtureTimestamp,
  createJobFixture,
  saveJob,
  saveMainConversation,
  type JobSeedingHarness
} from "./conversationRecordsContract"

/**
 * One metadata reader under test over one empty store, with the controls a
 * case needs: the rows a conversation and a job are stored with, and the
 * store's close.
 */
export type ConversationMetadataReaderHarness = JobSeedingHarness &
  Readonly<{
    /** Metadata reader under test. */
    metadataReader: ConversationMetadataReader
    /** Closes the store as its owner does. */
    closeStore: () => void
  }>

/**
 * Creates the reader over one empty store owned by the current test, which
 * closes the store when it finishes.
 */
export type ConversationMetadataReaderHarnessFactory =
  () => ConversationMetadataReaderHarness

/**
 * Registers the provider-independent {@link ConversationMetadataReader}
 * contract cases.
 *
 * @param createHarness - Creates the reader over one empty store per case.
 */
export function registerConversationMetadataReaderContractSuite(
  createHarness: ConversationMetadataReaderHarnessFactory
): void {
  describe("ConversationMetadataReader contract", () => {
    it("reads a main conversation's metadata, with no parent, job number, or delegator, and without its transcript", () => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)

      expect(harness.metadataReader.getConversationMetadata(mainId)).toEqual({
        id: mainId,
        title: null,
        agentCode: "caliginia",
        parentConversationId: null,
        jobNumber: null,
        delegatorAgentCode: null,
        createdAt: createFixtureTimestamp(0),
        updatedAt: createFixtureTimestamp(0, 1)
      })
    })

    it("reads a job's metadata with its parent, its number, and its parent's agent as the delegator", () => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))

      expect(harness.metadataReader.getConversationMetadata(job.id)).toEqual({
        id: job.id,
        title: "Job 1",
        agentCode: "researcher",
        parentConversationId: mainId,
        jobNumber: 1,
        delegatorAgentCode: "caliginia",
        createdAt: createFixtureTimestamp(1),
        updatedAt: createFixtureTimestamp(1, 2)
      })
    })

    it("returns undefined for a conversation that is not stored", () => {
      const harness = createHarness()
      saveMainConversation(harness, 1)

      expect(
        harness.metadataReader.getConversationMetadata(createFixtureUuidV7(9))
      ).toBeUndefined()
    })

    it("reads the metadata of a conversation whose stored message is invalid, because the transcript is not read", () => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      harness.saveUserMessage({
        id: "not-a-uuid",
        conversationId: mainId,
        content: "Hello",
        createdAt: createFixtureTimestamp(0, 2)
      })

      expect(
        harness.metadataReader.getConversationMetadata(mainId)
      ).toMatchObject({ id: mainId, parentConversationId: null })
    })

    it("fails when the stored metadata is invalid, and reads another conversation afterwards", () => {
      const harness = createHarness()
      const invalidId = createFixtureUuidV7(1)
      harness.saveConversation({
        id: invalidId,
        title: "",
        agentCode: "caliginia",
        createdAt: createFixtureTimestamp(0)
      })
      const mainId = saveMainConversation(harness, 10)

      expect(() =>
        harness.metadataReader.getConversationMetadata(invalidId)
      ).toThrow(z.ZodError)

      expect(
        harness.metadataReader.getConversationMetadata(mainId)
      ).toMatchObject({ id: mainId })
    })

    it("fails with `Database is closed` after the owner closes the store", () => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      harness.closeStore()

      expect(() =>
        harness.metadataReader.getConversationMetadata(mainId)
      ).toThrow("Database is closed")
    })
  })
}
