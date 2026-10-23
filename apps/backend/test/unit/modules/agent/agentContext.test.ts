import { describe, expect, it, vi } from "vitest"
import {
  buildAgentContext,
  calculateAgentContextHistoryMessageCount,
  formatSystemPrompt,
  getAgentContextImageSides,
  readAgentContextImages,
  UNSEEN_CONTEXT_IMAGES,
  type AgentContextImages,
  type FindAttachmentImage,
  type GetAttachmentImageFileStatus
} from "../../../../src/modules/agent/agentContext"
import type { ReplyContextImage } from "../../../../src/modules/agent/replyModel"
import {
  NO_UNOFFERED_TOOLS,
  TOOL_CALLS_OFF
} from "../../../../src/modules/agent/unofferedTools"
import {
  createImageAttachment,
  createTextAttachment
} from "../../support/attachmentFixtures"
import {
  createAssistantMessage,
  createFixtureUuidV7,
  createReasoningPart,
  createTextPart,
  createToolCallPart,
  createUserMessage
} from "../../support/conversationFixtures"

/** A stored web search call in round 0 that succeeded. */
const SUCCEEDED_SEARCH = createToolCallPart(
  {
    sequence: 21,
    round: 0,
    toolName: "web_search",
    argumentText: '{"query":"moths"}'
  },
  {
    status: "succeeded",
    result: "Source [1]\nTitle: Moths",
    sourceNumbers: [1]
  }
)

/** A stored page read in round 0 that failed. */
const FAILED_READ = createToolCallPart(
  {
    sequence: 22,
    round: 0,
    toolName: "read_page",
    argumentText: '{"url":"https://moths.example/"}'
  },
  { status: "failed", result: "The page did not answer." }
)

/** Images of a context whose model sees images but no file was found. */
const NO_SEEN_IMAGES: AgentContextImages = Object.freeze({
  status: "seen",
  images: new Map()
})

/** The new message of most cases, without attachments. */
const HELLO = Object.freeze({ content: "Hello", attachments: [] })

/** Bytes of a stored image, as a case's reader returns them. */
const PHOTO_BYTES = new Uint8Array([1, 2, 3])

/**
 * Builds the new message of a case.
 *
 * @param content - The person's text.
 * @returns The message without attachments.
 */
function createNewMessage(content: string) {
  return { content, attachments: [] }
}

describe("buildAgentContext", () => {
  it("sends the system prompt first and the new message last", () => {
    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: [],
        userMessage: HELLO,
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Hello", images: [] }
    ])
  })

  it("keeps earlier user messages and usable replies in transcript order", () => {
    const history = [
      createUserMessage(1, "First question"),
      createAssistantMessage(
        2,
        [
          createTextPart({
            sequence: 12,
            round: 0,
            content: "Completed answer"
          })
        ],
        {
          status: "completed",
          finishReason: "stop"
        }
      ),
      createUserMessage(3, "Second question"),
      createAssistantMessage(
        4,
        [
          createTextPart({
            sequence: 14,
            round: 0,
            content: "Truncated answer"
          })
        ],
        {
          status: "completed",
          finishReason: "length"
        }
      ),
      createUserMessage(5, "Third question"),
      createAssistantMessage(
        6,
        [createTextPart({ sequence: 16, round: 0, content: "Partial answer" })],
        {
          status: "interrupted"
        }
      )
    ]

    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: history,
        userMessage: createNewMessage("Current question"),
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "First question", images: [] },
      { role: "assistant", content: "Completed answer", toolCalls: [] },
      { role: "user", content: "Second question", images: [] },
      { role: "assistant", content: "Truncated answer", toolCalls: [] },
      { role: "user", content: "Third question", images: [] },
      { role: "assistant", content: "Partial answer", toolCalls: [] },
      { role: "user", content: "Current question", images: [] }
    ])
  })

  it("sends each round of a reply as its text and answered calls, then each call's result", () => {
    const history = [
      createUserMessage(1, "Tell me about moths"),
      createAssistantMessage(
        2,
        [
          createTextPart({ sequence: 20, round: 0, content: "Let me " }),
          createTextPart({ sequence: 23, round: 0, content: "look." }),
          SUCCEEDED_SEARCH,
          FAILED_READ,
          createTextPart({
            sequence: 24,
            round: 1,
            content: "Moths fly at night [1]."
          })
        ],
        { status: "completed", finishReason: "stop" }
      )
    ]

    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: history,
        userMessage: createNewMessage("More?"),
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Tell me about moths", images: [] },
      {
        role: "assistant",
        content: "Let me look.",
        toolCalls: [
          {
            id: SUCCEEDED_SEARCH.id,
            toolName: "web_search",
            argumentText: '{"query":"moths"}'
          },
          {
            id: FAILED_READ.id,
            toolName: "read_page",
            argumentText: '{"url":"https://moths.example/"}'
          }
        ]
      },
      {
        role: "tool",
        toolCallId: SUCCEEDED_SEARCH.id,
        content: "Source [1]\nTitle: Moths"
      },
      {
        role: "tool",
        toolCallId: FAILED_READ.id,
        content: "The page did not answer."
      },
      { role: "assistant", content: "Moths fly at night [1].", toolCalls: [] },
      { role: "user", content: "More?", images: [] }
    ])
  })

  it("sends a rejected call with the rejection the model read, and a round of calls without text", () => {
    const rejected = createToolCallPart(
      { sequence: 21, round: 0, toolName: "read_page", argumentText: "{}" },
      { status: "rejected", result: "The person did not allow this call." }
    )
    const history = [
      createAssistantMessage(2, [rejected], { status: "interrupted" })
    ]

    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: history,
        userMessage: createNewMessage("Why?"),
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toEqual([
      { role: "system", content: "You are Lys." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: rejected.id, toolName: "read_page", argumentText: "{}" }
        ]
      },
      {
        role: "tool",
        toolCallId: rejected.id,
        content: "The person did not allow this call."
      },
      { role: "user", content: "Why?", images: [] }
    ])
  })

  it("leaves out reasoning, calls without a result, and rounds left with nothing to send", () => {
    const interrupted = createToolCallPart(
      { sequence: 25, round: 1, toolName: "web_search", argumentText: "{}" },
      { status: "interrupted" }
    )
    const history = [
      createAssistantMessage(
        2,
        [
          createReasoningPart(20, 0, "Search first."),
          createTextPart({ sequence: 23, round: 0, content: "Searching." }),
          createReasoningPart(24, 1, "Then read."),
          interrupted
        ],
        { status: "interrupted" }
      )
    ]

    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: history,
        userMessage: createNewMessage("Go on"),
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "assistant", content: "Searching.", toolCalls: [] },
      { role: "user", content: "Go on", images: [] }
    ])
  })

  it("sends only the answered call of a stopped round whose other call was waiting for approval", () => {
    const stoppedRead = createToolCallPart(
      {
        sequence: 22,
        round: 0,
        toolName: "read_text_file",
        argumentText: '{"path":"/notes/moths.md"}'
      },
      { status: "interrupted" }
    )
    const history = [
      createAssistantMessage(
        2,
        [
          createTextPart({ sequence: 20, round: 0, content: "Searching." }),
          SUCCEEDED_SEARCH,
          stoppedRead
        ],
        { status: "interrupted" }
      )
    ]

    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: history,
        userMessage: createNewMessage("Go on"),
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toEqual([
      { role: "system", content: "You are Lys." },
      {
        role: "assistant",
        content: "Searching.",
        toolCalls: [
          {
            id: createFixtureUuidV7(21),
            toolName: "web_search",
            argumentText: '{"query":"moths"}'
          }
        ]
      },
      {
        role: "tool",
        toolCallId: createFixtureUuidV7(21),
        content: "Source [1]\nTitle: Moths"
      },
      { role: "user", content: "Go on", images: [] }
    ])
  })

  it.each([
    [
      "a failed reply",
      createAssistantMessage(
        2,
        [
          createTextPart({ sequence: 12, round: 0, content: "Failed text" }),
          SUCCEEDED_SEARCH
        ],
        { status: "failed" }
      )
    ],
    [
      "a reply still streaming",
      createAssistantMessage(
        2,
        [createTextPart({ sequence: 12, round: 0, content: "Streaming text" })],
        {
          status: "streaming"
        }
      )
    ],
    [
      "an interrupted reply without parts",
      createAssistantMessage(2, [], { status: "interrupted" })
    ],
    [
      "a completed reply with only reasoning",
      createAssistantMessage(2, [createReasoningPart(12, 0, "Hmm.")], {
        status: "completed",
        finishReason: "stop"
      })
    ]
  ])("excludes %s from the context", (_label, reply) => {
    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: [createUserMessage(1, "Question"), reply],
        userMessage: createNewMessage("Retry"),
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Question", images: [] },
      { role: "user", content: "Retry", images: [] }
    ])
  })

  it("sends only the fields the model reads, without stored identities, times, or source numbers", () => {
    const history = [
      createAssistantMessage(
        2,
        [createTextPart({ sequence: 12, round: 0, content: "Answer" })],
        {
          status: "completed",
          finishReason: "stop"
        }
      )
    ]

    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: history,
        userMessage: createNewMessage("Next"),
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toStrictEqual([
      { role: "system", content: "You are Lys." },
      { role: "assistant", content: "Answer", toolCalls: [] },
      { role: "user", content: "Next", images: [] }
    ])
    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: [
          createAssistantMessage(2, [SUCCEEDED_SEARCH], {
            status: "completed",
            finishReason: "stop"
          })
        ],
        userMessage: createNewMessage("Next"),
        images: UNSEEN_CONTEXT_IMAGES
      })[1]
    ).toStrictEqual({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: createFixtureUuidV7(21),
          toolName: "web_search",
          argumentText: '{"query":"moths"}'
        }
      ]
    })
  })

  describe("attachments", () => {
    it("lists each user message's attachments under its text, with the kind and size of each", () => {
      const history = [
        createUserMessage(1, "Earlier files", [
          createTextAttachment(1, "notes.md", 1234),
          createImageAttachment(2, "photo.png", { width: 640, height: 480 })
        ])
      ]
      const userMessage = {
        content: "Now this one",
        attachments: [createTextAttachment(3, "Plan.txt", 5)]
      }

      expect(
        buildAgentContext({
          systemPrompt: "You are Lys.",
          history: history,
          userMessage: userMessage,
          images: NO_SEEN_IMAGES
        })
      ).toEqual([
        { role: "system", content: "You are Lys." },
        {
          role: "user",
          content: [
            "Earlier files",
            "",
            "Attached files:",
            "[attachment 1] notes.md (text, 1,234 bytes)",
            "[attachment 2] photo.png (image/png, 640×480, 33 bytes)",
            "[attachment 2] photo.png is an image whose file is missing from this machine, so it cannot be shown."
          ].join("\n"),
          images: []
        },
        {
          role: "user",
          content: [
            "Now this one",
            "",
            "Attached files:",
            "[attachment 3] Plan.txt (text, 5 bytes)"
          ].join("\n"),
          images: []
        }
      ])
    })

    it("sends the found images of a message after its text, in attachment order, and a placeholder for a missing one", () => {
      const first = createImageAttachment(1, "first.png", {
        width: 10,
        height: 20
      })
      const second = createImageAttachment(2, "second.png")
      const third = createImageAttachment(3, "third.png", {
        width: 30,
        height: 40
      })
      const otherBytes = new Uint8Array([9])
      const firstImage: ReplyContextImage = {
        mediaType: "image/png",
        width: 10,
        height: 20,
        data: PHOTO_BYTES
      }
      const thirdImage: ReplyContextImage = {
        mediaType: "image/png",
        width: 30,
        height: 40,
        data: otherBytes
      }

      const context = buildAgentContext({
        systemPrompt: "You are Lys.",
        history: [],
        userMessage: { content: "Look", attachments: [first, second, third] },
        images: {
          status: "seen",
          images: new Map([
            [3, thirdImage],
            [1, firstImage]
          ])
        }
      })

      expect(context[1]).toEqual({
        role: "user",
        content: [
          "Look",
          "",
          "Attached files:",
          "[attachment 1] first.png (image/png, 10×20, 33 bytes)",
          "[attachment 2] second.png (image/png, 64×32, 33 bytes)",
          "[attachment 3] third.png (image/png, 30×40, 33 bytes)",
          "[attachment 2] second.png is an image whose file is missing from this machine, so it cannot be shown."
        ].join("\n"),
        images: [firstImage, thirdImage]
      })
    })

    it("replaces every image with a sentence when the model cannot see images", () => {
      const context = buildAgentContext({
        systemPrompt: "You are Lys.",
        history: [
          createUserMessage(1, "Earlier", [
            createImageAttachment(1, "earlier.png")
          ])
        ],
        userMessage: {
          content: "Now",
          attachments: [
            createTextAttachment(2, "notes.md"),
            createImageAttachment(3, "now.png")
          ]
        },
        images: UNSEEN_CONTEXT_IMAGES
      })

      expect(context.slice(1)).toEqual([
        {
          role: "user",
          content: [
            "Earlier",
            "",
            "Attached files:",
            "[attachment 1] earlier.png (image/png, 64×32, 33 bytes)",
            "[attachment 1] earlier.png is an image that this model cannot see."
          ].join("\n"),
          images: []
        },
        {
          role: "user",
          content: [
            "Now",
            "",
            "Attached files:",
            "[attachment 2] notes.md (text, 12 bytes)",
            "[attachment 3] now.png (image/png, 64×32, 33 bytes)",
            "[attachment 3] now.png is an image that this model cannot see."
          ].join("\n"),
          images: []
        }
      ])
    })
  })
})

describe("formatSystemPrompt", () => {
  it("leaves the agent's instructions unchanged when tool calls are on and no tool is named", () => {
    expect(formatSystemPrompt("You are Lys.", NO_UNOFFERED_TOOLS)).toBe(
      "You are Lys."
    )
  })

  it("adds a note after the instructions that names each switched-off tool in request order", () => {
    expect(
      formatSystemPrompt("You are Lys.", {
        status: "tool-calls-on",
        switchedOffToolNames: ["web_search", "read_text_file"],
        unavailableTools: []
      })
    ).toBe(
      "You are Lys.\n\nThese tools are turned off in Settings → Tools, so you cannot call them now: web_search, read_text_file. If a request needs one of them, say that it is turned off and can be turned on in Settings → Tools; do not guess what it would return or claim to have used it."
    )
  })

  it("adds the switched-off note, then a note naming each switched-on tool that cannot run with why and what fixes it", () => {
    expect(
      formatSystemPrompt("You are Lys.", {
        status: "tool-calls-on",
        switchedOffToolNames: ["get_location"],
        unavailableTools: [
          { name: "web_search", reason: "api-key-missing" },
          { name: "read_page", reason: "page-reader-not-ready" }
        ]
      })
    ).toBe(
      [
        "You are Lys.",
        "These tools are turned off in Settings → Tools, so you cannot call them now: get_location. If a request needs one of them, say that it is turned off and can be turned on in Settings → Tools; do not guess what it would return or claim to have used it.",
        "These tools are turned on in Settings → Tools but cannot run now, so you cannot call them: web_search, because no Tavily API key is saved (one can be added in Settings → Secrets); read_page, because vmo, Lys's page reader, is not ready (it can be started in Settings → Runtime). If a request needs one of them, say that it cannot run now, why, and what would fix that; do not guess what it would return or claim to have used it."
      ].join("\n\n")
    )
  })

  it("adds one note saying tool calls are off when they are", () => {
    expect(formatSystemPrompt("You are Lys.", TOOL_CALLS_OFF)).toBe(
      "You are Lys.\n\nTool calls are turned off in Settings → Tools. If a request needs a tool you are not offered, say that tool calls are turned off and can be turned on in Settings → Tools; do not guess what a tool would return or claim to have used one."
    )
  })
})

describe("UNSEEN_CONTEXT_IMAGES", () => {
  it("stands for the images of a model that cannot see them, so no file is read for it", () => {
    expect(UNSEEN_CONTEXT_IMAGES).toEqual({ status: "unseen" })
    expect(Object.isFrozen(UNSEEN_CONTEXT_IMAGES)).toBe(true)
  })
})

describe("readAgentContextImages", () => {
  it("reads each image of each user message in conversation order and keeps the ones found, by number", async () => {
    const earlierPhoto = createImageAttachment(1, "earlier.png")
    const missingPhoto = createImageAttachment(3, "missing.png")
    const laterPhoto = createImageAttachment(4, "later.png")
    const laterBytes = new Uint8Array([4])
    const findAttachmentImage = vi.fn<FindAttachmentImage>(
      async (_messageId, attachment) =>
        attachment.number === 3
          ? undefined
          : attachment.number === 1
            ? PHOTO_BYTES
            : laterBytes
    )

    const images = await readAgentContextImages(
      [
        createUserMessage(1, "Earlier", [
          earlierPhoto,
          createTextAttachment(2, "notes.md")
        ]),
        createAssistantMessage(
          2,
          [createTextPart({ sequence: 12, round: 0, content: "Seen." })],
          { status: "completed", finishReason: "stop" }
        ),
        createUserMessage(3, "Later", [missingPhoto, laterPhoto])
      ],
      findAttachmentImage
    )

    expect(findAttachmentImage.mock.calls).toEqual([
      [createFixtureUuidV7(1), earlierPhoto],
      [createFixtureUuidV7(3), missingPhoto],
      [createFixtureUuidV7(3), laterPhoto]
    ])
    expect(images).toEqual({
      status: "seen",
      images: new Map([
        [
          1,
          { mediaType: "image/png", width: 64, height: 32, data: PHOTO_BYTES }
        ],
        [4, { mediaType: "image/png", width: 64, height: 32, data: laterBytes }]
      ])
    })
  })

  it("rejects with the reader's failure for a file that cannot be read", async () => {
    const failure = new Error("EACCES")

    await expect(
      readAgentContextImages(
        [createUserMessage(1, "Look", [createImageAttachment(1, "photo.png")])],
        () => Promise.reject(failure)
      )
    ).rejects.toBe(failure)
  })
})

describe("getAgentContextImageSides", () => {
  it("looks up each image of each user message in conversation order and keeps the sides of the stored ones, by number", async () => {
    const earlierPhoto = createImageAttachment(1, "earlier.png", {
      width: 10,
      height: 20
    })
    const missingPhoto = createImageAttachment(3, "missing.png")
    const laterPhoto = createImageAttachment(4, "later.png")
    const getAttachmentImageFileStatus = vi.fn<GetAttachmentImageFileStatus>(
      async (_messageId, attachment) =>
        attachment.number === 3 ? "missing" : "stored"
    )

    const images = await getAgentContextImageSides(
      [
        createUserMessage(1, "Earlier", [
          earlierPhoto,
          createTextAttachment(2, "notes.md")
        ]),
        createAssistantMessage(
          2,
          [createTextPart({ sequence: 12, round: 0, content: "Seen." })],
          { status: "completed", finishReason: "stop" }
        ),
        createUserMessage(3, "Later", [missingPhoto, laterPhoto])
      ],
      getAttachmentImageFileStatus
    )

    expect(getAttachmentImageFileStatus.mock.calls).toEqual([
      [createFixtureUuidV7(1), earlierPhoto],
      [createFixtureUuidV7(3), missingPhoto],
      [createFixtureUuidV7(3), laterPhoto]
    ])
    expect(images).toEqual({
      status: "seen",
      images: new Map([
        [1, { width: 10, height: 20 }],
        [4, { width: 64, height: 32 }]
      ])
    })
  })

  it("gives the context the placeholders a turn's read would give it", async () => {
    const storedPhoto = createImageAttachment(1, "stored.png")
    const missingPhoto = createImageAttachment(2, "missing.png")
    const history = [createUserMessage(1, "Look", [storedPhoto, missingPhoto])]

    const measured = buildAgentContext({
      systemPrompt: "You are Lys.",
      history,
      userMessage: HELLO,
      images: await getAgentContextImageSides(
        history,
        (_messageId, attachment) =>
          Promise.resolve(attachment.number === 1 ? "stored" : "missing")
      )
    })
    const sent = buildAgentContext({
      systemPrompt: "You are Lys.",
      history,
      userMessage: HELLO,
      images: await readAgentContextImages(history, (_messageId, attachment) =>
        Promise.resolve(attachment.number === 1 ? PHOTO_BYTES : undefined)
      )
    })

    expect(measured).toEqual(
      sent.map((message) =>
        message.role === "user"
          ? {
              ...message,
              images: message.images.map(({ width, height }) => ({
                width,
                height
              }))
            }
          : message
      )
    )
  })

  it("rejects with the lookup's failure for a path that cannot be examined", async () => {
    const failure = new Error("EACCES")

    await expect(
      getAgentContextImageSides(
        [createUserMessage(1, "Look", [createImageAttachment(1, "photo.png")])],
        () => Promise.reject(failure)
      )
    ).rejects.toBe(failure)
  })
})

describe("calculateAgentContextHistoryMessageCount", () => {
  it("counts each stored message the context sends once, a reply with several rounds and results included", () => {
    const history = [
      createUserMessage(1, "Find moths"),
      createAssistantMessage(
        2,
        [
          createTextPart({ sequence: 20, round: 0, content: "Searching." }),
          SUCCEEDED_SEARCH,
          FAILED_READ,
          createTextPart({
            sequence: 23,
            round: 1,
            content: "Moths fly at night."
          })
        ],
        { status: "completed", finishReason: "stop" }
      ),
      createUserMessage(3, "Why?")
    ]

    expect(
      buildAgentContext({
        systemPrompt: "You are Lys.",
        history: history,
        userMessage: createNewMessage("Go on"),
        images: UNSEEN_CONTEXT_IMAGES
      })
    ).toHaveLength(8)
    expect(calculateAgentContextHistoryMessageCount(history)).toBe(3)
  })

  it("counts no reply the context leaves out", () => {
    const history = [
      createUserMessage(1, "Question"),
      createAssistantMessage(
        2,
        [createTextPart({ sequence: 12, round: 0, content: "Failed text" })],
        {
          status: "failed"
        }
      ),
      createAssistantMessage(3, [createReasoningPart(13, 0, "Hmm.")], {
        status: "completed",
        finishReason: "stop"
      }),
      createAssistantMessage(4, [], { status: "interrupted" })
    ]

    expect(calculateAgentContextHistoryMessageCount(history)).toBe(1)
  })
})
