import { describe, expect, it } from "vitest"
import { NO_UNOFFERED_TOOLS } from "../../../../src/modules/agent/unofferedTools"
import type { TurnSettings } from "../../../../src/modules/chat/turnStart"
import ConversationWakeSettings from "../../../../src/modules/delegation/conversationWakeSettings"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Identity of the conversation most cases remember settings for. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Identity of another conversation. */
const OTHER_CONVERSATION_ID = createFixtureUuidV7(2)

/**
 * Builds the settings of a turn that offers `delegate_work` and no other
 * tool.
 *
 * @param model - Model the settings name, which tells them from the settings
 * of another model.
 * @returns Frozen settings, with frozen tool lists, for a model that sees no
 * images and is trained for tool use.
 */
function buildTurnSettings(model: string): TurnSettings {
  return Object.freeze({
    model,
    generationOptions: Object.freeze({ temperature: 0.4 }),
    clientTools: Object.freeze([]),
    builtInTools: Object.freeze([]),
    mcpTools: Object.freeze([]),
    offersDelegateWork: true,
    unofferedTools: NO_UNOFFERED_TOOLS,
    canSeeImages: false,
    trainedForToolUse: true
  })
}

/** Settings of a turn whose reply `qwen/qwen3-8b` writes. */
const QWEN_SETTINGS = buildTurnSettings("qwen/qwen3-8b")

/** Settings of a turn whose reply `openai/gpt-oss-20b` writes. */
const GPT_OSS_SETTINGS = buildTurnSettings("openai/gpt-oss-20b")

describe("ConversationWakeSettings", () => {
  it("finds the settings added last for a conversation, and none for another", () => {
    const wakeSettings = new ConversationWakeSettings()
    wakeSettings.addWakeSettings(CONVERSATION_ID, QWEN_SETTINGS)
    wakeSettings.addWakeSettings(CONVERSATION_ID, GPT_OSS_SETTINGS)

    expect(wakeSettings.findWakeSettings(CONVERSATION_ID)).toEqual({
      status: "found",
      settings: GPT_OSS_SETTINGS
    })
    expect(wakeSettings.findWakeSettings(OTHER_CONVERSATION_ID)).toEqual({
      status: "none"
    })
  })

  it("finds none after they were removed", () => {
    const wakeSettings = new ConversationWakeSettings()
    wakeSettings.addWakeSettings(CONVERSATION_ID, QWEN_SETTINGS)

    wakeSettings.removeWakeSettings(CONVERSATION_ID)

    expect(wakeSettings.findWakeSettings(CONVERSATION_ID)).toEqual({
      status: "none"
    })
  })

  it("keeps the settings of the other conversations when one conversation's are removed", () => {
    const wakeSettings = new ConversationWakeSettings()
    wakeSettings.addWakeSettings(CONVERSATION_ID, QWEN_SETTINGS)
    wakeSettings.addWakeSettings(OTHER_CONVERSATION_ID, GPT_OSS_SETTINGS)

    wakeSettings.removeWakeSettings(CONVERSATION_ID)

    expect(wakeSettings.findWakeSettings(OTHER_CONVERSATION_ID)).toEqual({
      status: "found",
      settings: GPT_OSS_SETTINGS
    })
  })

  it("changes nothing when the settings of a conversation that has none are removed", () => {
    const wakeSettings = new ConversationWakeSettings()
    wakeSettings.addWakeSettings(CONVERSATION_ID, QWEN_SETTINGS)

    wakeSettings.removeWakeSettings(OTHER_CONVERSATION_ID)

    expect(wakeSettings.findWakeSettings(CONVERSATION_ID)).toEqual({
      status: "found",
      settings: QWEN_SETTINGS
    })
  })

  it("answers closed for every conversation after close, and adds nothing afterwards", () => {
    const wakeSettings = new ConversationWakeSettings()
    wakeSettings.addWakeSettings(CONVERSATION_ID, QWEN_SETTINGS)

    wakeSettings.close()
    wakeSettings.addWakeSettings(OTHER_CONVERSATION_ID, GPT_OSS_SETTINGS)

    expect(wakeSettings.findWakeSettings(CONVERSATION_ID)).toEqual({
      status: "closed"
    })
    expect(wakeSettings.findWakeSettings(OTHER_CONVERSATION_ID)).toEqual({
      status: "closed"
    })
  })

  it("stays closed when it is closed again and when settings are removed afterwards", () => {
    const wakeSettings = new ConversationWakeSettings()
    wakeSettings.addWakeSettings(CONVERSATION_ID, QWEN_SETTINGS)
    wakeSettings.close()

    wakeSettings.close()
    wakeSettings.removeWakeSettings(CONVERSATION_ID)

    expect(wakeSettings.findWakeSettings(CONVERSATION_ID)).toEqual({
      status: "closed"
    })
  })

  it("answers every lookup with a frozen value", () => {
    const wakeSettings = new ConversationWakeSettings()
    wakeSettings.addWakeSettings(CONVERSATION_ID, QWEN_SETTINGS)

    const found = wakeSettings.findWakeSettings(CONVERSATION_ID)
    const none = wakeSettings.findWakeSettings(OTHER_CONVERSATION_ID)
    wakeSettings.close()
    const closed = wakeSettings.findWakeSettings(CONVERSATION_ID)

    expect(Object.isFrozen(found)).toBe(true)
    expect(Object.isFrozen(none)).toBe(true)
    expect(Object.isFrozen(closed)).toBe(true)
  })
})
