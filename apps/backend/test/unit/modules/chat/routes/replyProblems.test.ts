import {
  chatAttachmentUnsupportedProblemSchema,
  chatBackendToolUnavailableProblemSchema,
  chatImageNeedsVisionProblemSchema,
  type BackendToolUnavailableReason
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  createChatAttachmentUnsupportedProblem,
  createChatBackendToolUnavailableProblem,
  createChatImageNeedsVisionProblem
} from "../../../../../src/modules/chat/routes/replyProblems"

/** One unavailable tool and the clause its problem gives as why. */
type UnavailableToolCase = Readonly<{
  /** Tool that cannot run. */
  toolName: string
  /** Why it cannot run. */
  reason: BackendToolUnavailableReason
  /** Clause the problem's detail ends with. */
  clause: string
}>

/** Every unavailable reason, with a tool it applies to. */
const UNAVAILABLE_TOOL_CASES: readonly UnavailableToolCase[] = [
  {
    toolName: "web_search",
    reason: "api-key-missing",
    clause: "no Tavily API key is saved."
  },
  {
    toolName: "web_search",
    reason: "api-key-invalid",
    clause: "the saved Tavily API key is not valid."
  },
  {
    toolName: "web_search",
    reason: "settings-unreadable",
    clause: "Lys could not read its settings file."
  },
  {
    toolName: "read_page",
    reason: "page-reader-not-ready",
    clause: "vmo, Lys's page reader, is not ready."
  }
]

describe("createChatBackendToolUnavailableProblem", () => {
  it.each(UNAVAILABLE_TOOL_CASES)(
    "explains $toolName being unavailable for $reason",
    ({ toolName, reason, clause }) => {
      const problem = createChatBackendToolUnavailableProblem(
        toolName,
        reason,
        "/api/v1/chat"
      )

      expect(problem).toEqual({
        type: "urn:lys:problem:chat:backend-tool-unavailable",
        title: "Backend tool unavailable",
        status: 409,
        detail: `${toolName} is unavailable: ${clause}`,
        instance: "/api/v1/chat",
        toolName,
        reason
      })
      expect(
        chatBackendToolUnavailableProblemSchema.safeParse(problem).success
      ).toBe(true)
    }
  )
})

describe("createChatAttachmentUnsupportedProblem", () => {
  it("names the file whose content Lys cannot send", () => {
    const problem = createChatAttachmentUnsupportedProblem(
      "clip.gif",
      "/api/v1/chat"
    )

    expect(problem).toEqual({
      type: "urn:lys:problem:chat:attachment-unsupported",
      title: "Attachment unsupported",
      status: 400,
      detail: "The file clip.gif is not a text file or an image Lys can send.",
      instance: "/api/v1/chat",
      fileName: "clip.gif"
    })
    expect(
      chatAttachmentUnsupportedProblemSchema.safeParse(problem).success
    ).toBe(true)
  })
})

describe("createChatImageNeedsVisionProblem", () => {
  it("names the image and the model that cannot see it", () => {
    const problem = createChatImageNeedsVisionProblem(
      "photo.png",
      "qwen/qwen3-8b",
      "/api/v1/chat"
    )

    expect(problem).toEqual({
      type: "urn:lys:problem:chat:image-needs-vision",
      title: "Image needs vision",
      status: 409,
      detail:
        "The image photo.png needs a model with vision, and qwen/qwen3-8b cannot see images.",
      instance: "/api/v1/chat",
      fileName: "photo.png",
      model: "qwen/qwen3-8b"
    })
    expect(chatImageNeedsVisionProblemSchema.safeParse(problem).success).toBe(
      true
    )
  })
})
