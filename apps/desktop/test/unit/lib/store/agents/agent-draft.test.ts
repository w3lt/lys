import { describe, expect, it } from "vitest"
import {
  buildStoredAgentDraft,
  calculateAgentCodeFromName,
  calculateAgentCodeFromText,
  calculateAgentDraftProblemField,
  calculateDuplicateAgentName,
  EMPTY_AGENT_DRAFT,
  findAgentDraftProblem,
  isAgentDraftChanged,
  isNewAgentDraftStarted,
  type AgentDraft,
  type AgentDraftSubject
} from "@/lib/store/agents/agent-draft"
import { buildAgent, buildAgentSummary } from "../../../support/agentFixtures"

/** Stored agent the stored-subject cases edit. */
const RESEARCHER = buildAgent("researcher", { name: "Researcher" })

/** Another listed agent whose name and code a draft may collide with. */
const WRITER = buildAgent("writer", { name: "Writer" })

/** Every listed agent. */
const LISTED_AGENTS = [buildAgentSummary(RESEARCHER), buildAgentSummary(WRITER)]

/** Draft that every check accepts. */
const VALID_DRAFT: AgentDraft = Object.freeze({
  name: "Scout",
  bio: "Finds things.",
  systemPrompt: "You find things."
})

/** Draft for a new agent whose code the backend derives. */
const NEW_DERIVED_CODE: AgentDraftSubject = { kind: "new", code: "" }

/** Draft that edits {@link RESEARCHER}. */
const EDIT_RESEARCHER: AgentDraftSubject = {
  kind: "stored",
  code: "researcher",
  name: "Researcher"
}

describe("findAgentDraftProblem", () => {
  it("accepts a complete draft", () => {
    expect(
      findAgentDraftProblem(VALID_DRAFT, NEW_DERIVED_CODE, LISTED_AGENTS)
    ).toBeUndefined()
  })

  it.each([
    ["a blank name", { name: "   " }, { kind: "name-missing" }],
    [
      "a name over 64 characters",
      { name: "n".repeat(65) },
      { kind: "name-too-long" }
    ],
    ["a blank bio", { bio: "\n" }, { kind: "bio-missing" }],
    [
      "a bio over 128 characters",
      { bio: "b".repeat(129) },
      { kind: "bio-too-long" }
    ],
    [
      "a blank system prompt",
      { systemPrompt: " " },
      { kind: "system-prompt-missing" }
    ]
  ])("reports %s", (_label, change, problem) => {
    expect(
      findAgentDraftProblem(
        { ...VALID_DRAFT, ...change },
        NEW_DERIVED_CODE,
        LISTED_AGENTS
      )
    ).toEqual(problem)
  })

  it("measures the name and bio limits after trimming", () => {
    const draft = {
      ...VALID_DRAFT,
      name: ` ${"n".repeat(64)} `,
      bio: ` ${"b".repeat(128)} `
    }

    expect(
      findAgentDraftProblem(draft, NEW_DERIVED_CODE, LISTED_AGENTS)
    ).toBeUndefined()
  })

  it("reports a name another agent has, compared case-insensitively and trimmed", () => {
    expect(
      findAgentDraftProblem(
        { ...VALID_DRAFT, name: "  wRiTeR " },
        NEW_DERIVED_CODE,
        LISTED_AGENTS
      )
    ).toEqual({ kind: "name-taken", name: "wRiTeR" })
  })

  it("lets a stored agent keep its own name even when another agent shares it", () => {
    const twin = buildAgentSummary(buildAgent("twin", { name: "Researcher" }))

    expect(
      findAgentDraftProblem(
        { ...VALID_DRAFT, name: "researcher" },
        EDIT_RESEARCHER,
        [...LISTED_AGENTS, twin]
      )
    ).toBeUndefined()
  })

  it("does not count the edited agent's own listed name as taken when the list is older than the agent", () => {
    const renamedResearcher: AgentDraftSubject = {
      kind: "stored",
      code: "researcher",
      name: "Scout"
    }

    expect(
      findAgentDraftProblem(
        { ...VALID_DRAFT, name: "Researcher" },
        renamedResearcher,
        LISTED_AGENTS
      )
    ).toBeUndefined()
  })

  it("reports renaming a stored agent to another agent's name", () => {
    expect(
      findAgentDraftProblem(
        { ...VALID_DRAFT, name: "Writer" },
        EDIT_RESEARCHER,
        LISTED_AGENTS
      )
    ).toEqual({ kind: "name-taken", name: "Writer" })
  })

  it.each(["Web Researcher", "-scout", "scout-", "sc--out", "c".repeat(65)])(
    "reports the malformed new-agent code %j",
    (code) => {
      expect(
        findAgentDraftProblem(VALID_DRAFT, { kind: "new", code }, LISTED_AGENTS)
      ).toEqual({ kind: "code-malformed" })
    }
  )

  it("reports a new-agent code another listed agent has", () => {
    expect(
      findAgentDraftProblem(
        VALID_DRAFT,
        { kind: "new", code: "writer" },
        LISTED_AGENTS
      )
    ).toEqual({ kind: "code-taken", code: "writer" })
  })

  it("accepts a valid new-agent code no listed agent has", () => {
    expect(
      findAgentDraftProblem(
        VALID_DRAFT,
        { kind: "new", code: "web-scout-2" },
        LISTED_AGENTS
      )
    ).toBeUndefined()
  })

  it("does not check a stored agent's code, which never changes", () => {
    expect(
      findAgentDraftProblem(
        VALID_DRAFT,
        { kind: "stored", code: "writer", name: "Writer" },
        LISTED_AGENTS
      )
    ).toBeUndefined()
  })

  it("reports the first problem in field order: name, code, bio, system prompt", () => {
    const draft = { name: "", bio: "", systemPrompt: "" }
    const malformedCode: AgentDraftSubject = { kind: "new", code: "Bad Code" }

    expect([
      findAgentDraftProblem(draft, malformedCode, LISTED_AGENTS),
      findAgentDraftProblem(
        { ...draft, name: "Scout" },
        malformedCode,
        LISTED_AGENTS
      ),
      findAgentDraftProblem(
        { ...draft, name: "Scout" },
        NEW_DERIVED_CODE,
        LISTED_AGENTS
      )
    ]).toEqual([
      { kind: "name-missing" },
      { kind: "code-malformed" },
      { kind: "bio-missing" }
    ])
  })
})

describe("calculateAgentDraftProblemField", () => {
  it.each([
    [{ kind: "name-missing" }, "name"],
    [{ kind: "name-too-long" }, "name"],
    [{ kind: "name-taken", name: "Writer" }, "name"],
    [{ kind: "code-malformed" }, "code"],
    [{ kind: "code-taken", code: "writer" }, "code"],
    [{ kind: "bio-missing" }, "bio"],
    [{ kind: "bio-too-long" }, "bio"],
    [{ kind: "system-prompt-missing" }, "systemPrompt"]
  ] as const)("points %o at the %s field", (problem, field) => {
    expect(calculateAgentDraftProblemField(problem)).toBe(field)
  })
})

describe("calculateAgentCodeFromText", () => {
  it.each([
    ["Web Researcher", "web-researcher"],
    ["Café Ünïcode", "cafe-unicode"],
    ["ﬁle tool", "file-tool"],
    ["a!!!b", "a-b"],
    ["  leading", "leading"],
    ["typing ", "typing-"],
    ["日本語", ""]
  ])("keeps %j as %j", (text, code) => {
    expect(calculateAgentCodeFromText(text)).toBe(code)
  })

  it("keeps at most 64 characters", () => {
    expect(calculateAgentCodeFromText("c".repeat(70))).toBe("c".repeat(64))
  })
})

describe("calculateAgentCodeFromName", () => {
  it.each([
    ["Web Researcher", "web-researcher"],
    ["Researcher ", "researcher"],
    ["日本語", ""]
  ])("offers %j as %j", (name, code) => {
    expect(calculateAgentCodeFromName(name)).toBe(code)
  })

  it("drops a hyphen left at the 64-character cut", () => {
    expect(calculateAgentCodeFromName(`${"a".repeat(63)} b`)).toBe(
      "a".repeat(63)
    )
  })
})

describe("calculateDuplicateAgentName", () => {
  it("names the first copy '<name> copy'", () => {
    expect(calculateDuplicateAgentName("  Researcher ", LISTED_AGENTS)).toBe(
      "Researcher copy"
    )
  })

  it("numbers later copies from 2, skipping names in use case-insensitively", () => {
    const copies = ["researcher COPY", "Researcher copy 2"].map((name, index) =>
      buildAgentSummary(buildAgent(`copy-${index}`, { name }))
    )

    expect(
      calculateDuplicateAgentName("Researcher", [...LISTED_AGENTS, ...copies])
    ).toBe("Researcher copy 3")
  })

  it("names a copy of a blank name after 'Agent'", () => {
    expect(calculateDuplicateAgentName("  ", [])).toBe("Agent copy")
  })

  it("cuts a long name so the copy fits 64 characters", () => {
    const copyName = calculateDuplicateAgentName("x".repeat(64), [])

    expect(copyName).toBe(`${"x".repeat(59)} copy`)
  })

  it("drops whitespace left at the cut", () => {
    expect(calculateDuplicateAgentName(`${"a".repeat(58)} bcdef`, [])).toBe(
      `${"a".repeat(58)} copy`
    )
  })

  it("does not split a surrogate pair at the cut", () => {
    expect(calculateDuplicateAgentName(`${"a".repeat(58)}😀bbbb`, [])).toBe(
      `${"a".repeat(58)} copy`
    )
  })
})

describe("buildStoredAgentDraft", () => {
  it("starts from the stored text and cannot be changed in place", () => {
    const draft = buildStoredAgentDraft(RESEARCHER)

    expect(draft).toEqual({
      name: RESEARCHER.name,
      bio: RESEARCHER.bio,
      systemPrompt: RESEARCHER.systemPrompt
    })
    expect(Object.isFrozen(draft)).toBe(true)
  })
})

describe("isAgentDraftChanged", () => {
  it("reports an unedited draft unchanged", () => {
    expect(
      isAgentDraftChanged(buildStoredAgentDraft(RESEARCHER), RESEARCHER)
    ).toBe(false)
  })

  it.each([
    ["name", { name: `${RESEARCHER.name} ` }],
    ["bio", { bio: "Other." }],
    ["systemPrompt", { systemPrompt: "Other." }]
  ])("reports a change to the %s, whitespace included", (_field, change) => {
    expect(
      isAgentDraftChanged(
        { ...buildStoredAgentDraft(RESEARCHER), ...change },
        RESEARCHER
      )
    ).toBe(true)
  })
})

describe("isNewAgentDraftStarted", () => {
  it("reports an empty draft without a code as not started", () => {
    expect(isNewAgentDraftStarted(EMPTY_AGENT_DRAFT, "")).toBe(false)
  })

  it.each([
    ["name", { name: " " }, ""],
    ["bio", { bio: "b" }, ""],
    ["systemPrompt", { systemPrompt: "p" }, ""],
    ["code", {}, "c"]
  ])("reports a draft with a typed %s as started", (_field, change, code) => {
    expect(
      isNewAgentDraftStarted({ ...EMPTY_AGENT_DRAFT, ...change }, code)
    ).toBe(true)
  })
})
