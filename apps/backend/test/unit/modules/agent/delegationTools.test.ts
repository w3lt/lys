import { describe, expect, it, vi } from "vitest"
import type { AgentRole } from "../../../../src/modules/agent/agentRoles"
import {
  buildDelegationDefinitions,
  buildDelegationTools,
  buildListedDelegationDefinitions,
  formatJobNote
} from "../../../../src/modules/agent/delegationTools"
import type {
  DelegationOffer,
  JobMessageOutcome,
  JobMessageRefusal,
  JobTurn,
  StopJobOutcome,
  TurnDelegation
} from "../../../../src/modules/agent/turnDelegation"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  ParsedBuiltInToolCall,
  TurnBuiltInTool
} from "../../../../src/modules/tool/builtIn/builtInTool"
import {
  createRecordedRunContext,
  registerBuiltInToolContractSuite,
  type BuiltInToolHarness
} from "../../support/builtInToolContract"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"
import {
  buildTurnDelegation,
  handleUnexpectedDelegationCall
} from "../../support/turnDelegationFakes"

/** The job a member's turn works on in the cases about a job's turn. */
const JOB_TURN: JobTurn = Object.freeze({
  delegatorName: "Caliginia",
  jobNumber: 2
})

/** Offer of a main conversation's turn that may delegate and has no job yet. */
const DELEGATING_OFFER: DelegationOffer = Object.freeze({
  mayDelegate: true,
  hasJobs: false,
  job: undefined
})

/** Offer of a main conversation's turn that may delegate and has jobs. */
const DELEGATING_OFFER_WITH_JOBS: DelegationOffer = Object.freeze({
  mayDelegate: true,
  hasJobs: true,
  job: undefined
})

/**
 * Offer of a turn whose conversation has jobs and whose tool offer leaves
 * `delegate_work` out.
 */
const JOBS_ONLY_OFFER: DelegationOffer = Object.freeze({
  mayDelegate: false,
  hasJobs: true,
  job: undefined
})

/** Offer of a turn of {@link JOB_TURN}'s job. */
const JOB_OFFER: DelegationOffer = Object.freeze({
  mayDelegate: false,
  hasJobs: false,
  job: JOB_TURN
})

/** Arguments of a `delegate_work` call that starts a new job. */
const DELEGATE_WORK_ARGUMENTS = Object.freeze({
  agent: "researcher",
  title: "Hologram news",
  instructions: "Collect this week's news about holograms."
})

/** Arguments of a `stop_job` call that names job 2. */
const STOP_JOB_ARGUMENTS = Object.freeze({ job: 2 })

/** Arguments of a `report_progress` call that can run. */
const REPORT_PROGRESS_ARGUMENTS = Object.freeze({
  note: "Two of five sources are read."
})

/** Outcome of the job message that started job 1. */
const SENT_NEW_JOB: JobMessageOutcome = Object.freeze({
  status: "sent",
  jobNumber: 1,
  agentName: "Researcher",
  title: "Hologram news",
  isNewJob: true
})

/** Outcome of a job message that continued job 1. */
const SENT_CONTINUED_JOB: JobMessageOutcome = Object.freeze({
  status: "sent",
  jobNumber: 1,
  agentName: "Researcher",
  title: "Hologram news",
  isNewJob: false
})

/** Matches the parse outcome of a call that can run. */
const PARSED_CALL = Object.freeze({
  status: "parsed",
  runToolCall: expect.any(Function)
})

/** Parse outcome of a `delegate_work` call whose agent is no agent code. */
const INVALID_AGENT_CALL = Object.freeze({
  status: "invalid",
  message:
    "The agent must be an agent code: lowercase letters and digits in groups joined by single hyphens."
})

/** Parse outcome of a `delegate_work` call whose title cannot run. */
const INVALID_TITLE_CALL = Object.freeze({
  status: "invalid",
  message: "The title must be 1 to 80 characters on one line after trimming."
})

/** Parse outcome of a `delegate_work` call whose instructions are blank. */
const INVALID_INSTRUCTIONS_CALL = Object.freeze({
  status: "invalid",
  message: "The instructions must not be empty."
})

/** Parse outcome of a call whose job number cannot be one. */
const INVALID_JOB_CALL = Object.freeze({
  status: "invalid",
  message: "The job must be a whole number of 1 or more."
})

/** One offer, the role it is applied for, and the tools it leads to. */
type OfferCase = [
  label: string,
  role: AgentRole,
  offer: DelegationOffer,
  toolNames: string[]
]

/** One text argument of a call with the parse outcome it leads to. */
type TextParseCase = [
  label: string,
  status: ParsedBuiltInToolCall["status"],
  text: string,
  outcome: unknown
]

/** One number that cannot be a job's. */
type JobNumberCase = [label: string, job: number]

/** One `delegate_work` call with the first thing wrong with it. */
type InvalidCallCase = [
  label: string,
  callArguments: BuiltInToolCallArguments,
  outcome: unknown
]

/** One outcome of a job message with the result the model reads for it. */
type JobMessageOutcomeCase = [
  label: string,
  outcome: JobMessageOutcome,
  result: BuiltInToolResult
]

/** One outcome of a stop with the result the model reads for it. */
type StopJobOutcomeCase = [
  label: string,
  outcome: StopJobOutcome,
  result: BuiltInToolResult
]

/** What one call of a case led to: its result, or why it cannot run. */
type DelegationCallOutcome =
  BuiltInToolResult | Extract<ParsedBuiltInToolCall, { status: "invalid" }>

/**
 * Builds the result the model reads for a call that did its work.
 *
 * @param content - Text of the result.
 * @returns The succeeded result, which shows no sources.
 */
function buildSucceededResult(content: string): BuiltInToolResult {
  return { status: "succeeded", content, sources: [] }
}

/**
 * Builds the result the model reads for a call that could not do its work.
 *
 * @param content - Text of the result.
 * @returns The failed result.
 */
function buildFailedResult(content: string): BuiltInToolResult {
  return { status: "failed", content }
}

/**
 * Builds the outcome of a job message that was refused.
 *
 * @param refusal - Why it was refused.
 * @returns The refused outcome.
 */
function buildRefusedOutcome(refusal: JobMessageRefusal): JobMessageOutcome {
  return { status: "refused", refusal }
}

/**
 * Gets one delegation tool of a turn by its name.
 *
 * @param tools - The turn's delegation tools.
 * @param name - Name of the tool.
 * @returns The tool.
 * @throws If the turn has no tool of that name.
 */
function getDelegationTool(
  tools: readonly TurnBuiltInTool[],
  name: string
): BuiltInTool {
  const entry = tools.find((tool) => tool.definition.name === name)
  if (entry === undefined) throw new Error(`No tool named ${name}`)
  return entry.tool
}

/**
 * Builds the `delegate_work` tool of a leader's turn that may delegate.
 *
 * @param createJobMessage - Answers each job message the tool sends.
 * @returns The tool.
 */
function buildDelegateWorkTool(
  createJobMessage: TurnDelegation["createJobMessage"]
): BuiltInTool {
  const delegation = buildTurnDelegation(DELEGATING_OFFER, { createJobMessage })
  return getDelegationTool(
    buildDelegationTools("leader", delegation),
    "delegate_work"
  )
}

/**
 * Builds the `stop_job` tool of a leader's turn whose conversation has jobs.
 *
 * @param stopJob - Answers each stop the tool asks for.
 * @returns The tool.
 */
function buildStopJobTool(stopJob: TurnDelegation["stopJob"]): BuiltInTool {
  const delegation = buildTurnDelegation(JOBS_ONLY_OFFER, { stopJob })
  return getDelegationTool(
    buildDelegationTools("leader", delegation),
    "stop_job"
  )
}

/**
 * Builds the `report_progress` tool of a member's turn of a job.
 *
 * @param createProgressNote - Answers each note the tool stores.
 * @returns The tool.
 */
function buildReportProgressTool(
  createProgressNote: TurnDelegation["createProgressNote"]
): BuiltInTool {
  const delegation = buildTurnDelegation(JOB_OFFER, { createProgressNote })
  return getDelegationTool(
    buildDelegationTools("member", delegation),
    "report_progress"
  )
}

/**
 * Parses and runs one call of a delegation tool.
 *
 * @param tool - The called tool.
 * @param callArguments - Argument values of the call.
 * @returns The run's result, or the parse outcome when the arguments cannot
 * run.
 */
async function runDelegationTool(
  tool: BuiltInTool,
  callArguments: BuiltInToolCallArguments
): Promise<DelegationCallOutcome> {
  const parsed = tool.parseToolCall(callArguments)
  if (parsed.status === "invalid") return parsed
  return await parsed.runToolCall(
    createRecordedRunContext(new AbortController().signal).context
  )
}

/**
 * Creates the `delegate_work` tool one contract case runs.
 *
 * @returns The tool over a sender that starts job 1, arguments it can run,
 * arguments whose title is blank, and the count of job messages it sent.
 */
function createDelegateWorkHarness(): Promise<BuiltInToolHarness> {
  /** Arguments of a `delegate_work` call whose title is blank. */
  const blankTitleArguments = Object.freeze({
    ...DELEGATE_WORK_ARGUMENTS,
    title: "   "
  })

  const createJobMessage = vi.fn<TurnDelegation["createJobMessage"]>(
    () => SENT_NEW_JOB
  )
  const harness: BuiltInToolHarness = {
    tool: buildDelegateWorkTool(createJobMessage),
    runnableArguments: DELEGATE_WORK_ARGUMENTS,
    invalidArguments: blankTitleArguments,
    countStartedWork: () => createJobMessage.mock.calls.length
  }
  return Promise.resolve(harness)
}

/**
 * Creates the `stop_job` tool one contract case runs.
 *
 * @returns The tool over a stop that answers `stopped`, a job number it can
 * run, one that cannot be a job's, and the count of stops it asked for.
 */
function createStopJobHarness(): Promise<BuiltInToolHarness> {
  /** Arguments of a `stop_job` call whose number cannot be a job's. */
  const zeroJobArguments = Object.freeze({ job: 0 })

  const stopJob = vi.fn<TurnDelegation["stopJob"]>((jobNumber) =>
    Promise.resolve({ status: "stopped", jobNumber })
  )
  const harness: BuiltInToolHarness = {
    tool: buildStopJobTool(stopJob),
    runnableArguments: STOP_JOB_ARGUMENTS,
    invalidArguments: zeroJobArguments,
    countStartedWork: () => stopJob.mock.calls.length
  }
  return Promise.resolve(harness)
}

/**
 * Creates the `report_progress` tool one contract case runs.
 *
 * @returns The tool over a store that keeps every note, a note it can run, a
 * blank note, and the count of notes it stored.
 */
function createReportProgressHarness(): Promise<BuiltInToolHarness> {
  /** Arguments of a `report_progress` call whose note is blank. */
  const blankNoteArguments = Object.freeze({ note: "   " })

  const createProgressNote = vi.fn<TurnDelegation["createProgressNote"]>(
    () => "stored"
  )
  const harness: BuiltInToolHarness = {
    tool: buildReportProgressTool(createProgressNote),
    runnableArguments: REPORT_PROGRESS_ARGUMENTS,
    invalidArguments: blankNoteArguments,
    countStartedWork: () => createProgressNote.mock.calls.length
  }
  return Promise.resolve(harness)
}

describe("buildDelegationDefinitions", () => {
  /** Offer of a turn that takes no part in delegation. */
  const noOffer: DelegationOffer = Object.freeze({
    mayDelegate: false,
    hasJobs: false,
    job: undefined
  })

  it.for<OfferCase>([
    [
      "a leader that may delegate",
      "leader",
      DELEGATING_OFFER,
      ["delegate_work", "stop_job"]
    ],
    ["a member whose turn may delegate", "member", DELEGATING_OFFER, []],
    [
      "a leader in a conversation with jobs",
      "leader",
      DELEGATING_OFFER_WITH_JOBS,
      ["delegate_work", "stop_job"]
    ],
    [
      "a leader whose offer leaves delegate_work out",
      "leader",
      JOBS_ONLY_OFFER,
      ["stop_job"]
    ],
    [
      "a member in a conversation with jobs",
      "member",
      DELEGATING_OFFER_WITH_JOBS,
      ["stop_job"]
    ],
    ["a member in a job", "member", JOB_OFFER, ["report_progress"]],
    ["a turn outside delegation", "leader", noOffer, []]
  ])("offers %s exactly these tools", ([, role, offer, toolNames]) => {
    const definitions = buildDelegationDefinitions(role, offer)
    const tools = buildDelegationTools(role, buildTurnDelegation(offer))

    expect(definitions.map((definition) => definition.name)).toEqual(toolNames)
    expect(tools.map((tool) => tool.definition)).toEqual(definitions)
  })

  it("describes stop_job and its argument to the model", () => {
    /** Arguments of `stop_job` as the model is offered them. */
    const stopJobArgumentDefinitions = Object.freeze([
      {
        type: "integer",
        name: "job",
        description: "Number of the job to stop.",
        required: true
      }
    ])

    const definitions = buildDelegationDefinitions("leader", JOBS_ONLY_OFFER)

    expect(definitions).toEqual([
      {
        name: "stop_job",
        description:
          "Stops a job of this conversation that is still working. Its agent's reply ends at once, and no result comes back for it.",
        group: "agents",
        access: "agents",
        runner: "backend",
        arguments: stopJobArgumentDefinitions
      }
    ])
  })

  it("describes report_progress and its argument to the model", () => {
    /** Arguments of `report_progress` as the model is offered them. */
    const reportProgressArgumentDefinitions = Object.freeze([
      {
        type: "string",
        name: "note",
        description: "Where the job stands, at most 2000 characters.",
        required: true
      }
    ])

    const definitions = buildDelegationDefinitions("member", JOB_OFFER)

    expect(definitions).toEqual([
      {
        name: "report_progress",
        description:
          "Sends the agent that gave you this job a short note on where the job stands. It replaces your earlier note if that one has not been read yet, so say where the whole job stands. Your work goes on after the call.",
        group: "agents",
        access: "agents",
        runner: "backend",
        arguments: reportProgressArgumentDefinitions
      }
    ])
  })
})

describe("buildListedDelegationDefinitions", () => {
  it("lists only delegate_work for Settings, in the agents group with agents access", () => {
    /** Arguments of `delegate_work` as the model is offered them, in order. */
    const delegateWorkArgumentDefinitions = Object.freeze([
      {
        type: "string",
        name: "agent",
        description: "Code of the agent that should do the work.",
        required: true
      },
      {
        type: "string",
        name: "title",
        description:
          "A few words that name the work, at most 80 characters on one line. The person sees it on the job's card.",
        required: true
      },
      {
        type: "string",
        name: "instructions",
        description:
          "Everything the agent needs to do the work. It sees only these instructions and nothing else of this conversation.",
        required: true
      },
      {
        type: "integer",
        name: "job",
        description:
          "Number of an earlier job of this conversation to continue. Leave it out to start a new job.",
        required: false
      }
    ])

    expect(buildListedDelegationDefinitions()).toEqual([
      {
        name: "delegate_work",
        description:
          "Gives work to another agent in Lys. The agent works on it on its own, in a separate job, and you do not wait for it: this call returns as soon as the job has started. The job's result, or its failure, arrives later in a message that starts with reports, so end your reply when you have nothing else to do. Use find_agents to see which agents can take work. To send a follow-up to an earlier job that is not working any more, give its number as job.",
        group: "agents",
        access: "agents",
        runner: "backend",
        arguments: delegateWorkArgumentDefinitions
      }
    ])
  })

  it("lists only the delegate_work definition a leader that may delegate is offered", () => {
    const offered = buildDelegationDefinitions("leader", DELEGATING_OFFER)

    expect(buildListedDelegationDefinitions()).toEqual(
      offered.filter((definition) => definition.name === "delegate_work")
    )
  })
})

describe("buildDelegationTools", () => {
  it("asks the person before delegate_work and runs report_progress and stop_job without asking", () => {
    const leaderTools = buildDelegationTools(
      "leader",
      buildTurnDelegation(DELEGATING_OFFER_WITH_JOBS)
    )
    const memberTools = buildDelegationTools(
      "member",
      buildTurnDelegation(JOB_OFFER)
    )

    expect(
      [...leaderTools, ...memberTools].map((tool) => [
        tool.definition.name,
        tool.runsWithoutApproval
      ])
    ).toEqual([
      ["delegate_work", false],
      ["stop_job", true],
      ["report_progress", true]
    ])
  })

  describe("delegate_work", () => {
    registerBuiltInToolContractSuite(createDelegateWorkHarness)

    it.for<TextParseCase>([
      ["80 characters", "parsed", "a".repeat(80), PARSED_CALL],
      [
        "80 characters between spaces",
        "parsed",
        `  ${"a".repeat(80)} `,
        PARSED_CALL
      ],
      ["81 characters", "invalid", "a".repeat(81), INVALID_TITLE_CALL],
      ["two lines", "invalid", "a\nb", INVALID_TITLE_CALL],
      ["two lines split by a return", "invalid", "a\rb", INVALID_TITLE_CALL],
      [
        "two lines split by a line separator",
        "invalid",
        "a\u2028b",
        INVALID_TITLE_CALL
      ],
      [
        "two lines split by a paragraph separator",
        "invalid",
        "a\u2029b",
        INVALID_TITLE_CALL
      ],
      ["only spaces", "invalid", "   ", INVALID_TITLE_CALL]
    ])("parses a title of %s as %s", ([, , title, outcome]) => {
      const tool = buildDelegateWorkTool(handleUnexpectedDelegationCall)

      const parsed = tool.parseToolCall({ ...DELEGATE_WORK_ARGUMENTS, title })

      expect(parsed).toEqual(outcome)
    })

    it.each<JobNumberCase>([
      ["0", 0],
      ["-1", -1],
      ["1.5", 1.5]
    ])("refuses the job number %s", (_label, job) => {
      const tool = buildDelegateWorkTool(handleUnexpectedDelegationCall)

      const parsed = tool.parseToolCall({ ...DELEGATE_WORK_ARGUMENTS, job })

      expect(parsed).toEqual(INVALID_JOB_CALL)
    })

    it("refuses an agent that is not an agent code, and blank instructions", () => {
      const tool = buildDelegateWorkTool(handleUnexpectedDelegationCall)

      const namedAgent = tool.parseToolCall({
        ...DELEGATE_WORK_ARGUMENTS,
        agent: "Researcher"
      })
      const paddedCode = tool.parseToolCall({
        ...DELEGATE_WORK_ARGUMENTS,
        agent: " researcher "
      })
      const blankInstructions = tool.parseToolCall({
        ...DELEGATE_WORK_ARGUMENTS,
        instructions: " \n "
      })

      expect(namedAgent).toEqual(INVALID_AGENT_CALL)
      expect(paddedCode).toEqual(INVALID_AGENT_CALL)
      expect(blankInstructions).toEqual(INVALID_INSTRUCTIONS_CALL)
    })

    it.each<InvalidCallCase>([
      [
        "the agent",
        { agent: "Researcher", title: "a\nb", instructions: " ", job: 0 },
        INVALID_AGENT_CALL
      ],
      [
        "the title",
        { agent: "researcher", title: "a\nb", instructions: " ", job: 0 },
        INVALID_TITLE_CALL
      ],
      [
        "the instructions",
        { agent: "researcher", title: "News", instructions: " ", job: 0 },
        INVALID_INSTRUCTIONS_CALL
      ],
      [
        "the job",
        { agent: "researcher", title: "News", instructions: "Read.", job: 0 },
        INVALID_JOB_CALL
      ]
    ])(
      "explains %s when it is the first argument that cannot run",
      (_label, callArguments, outcome) => {
        const tool = buildDelegateWorkTool(handleUnexpectedDelegationCall)

        expect(tool.parseToolCall(callArguments)).toEqual(outcome)
      }
    )

    it("sends the trimmed title and instructions, the job number, and the run context's tool call id to createJobMessage", async () => {
      const createJobMessage = vi.fn<TurnDelegation["createJobMessage"]>(
        () => SENT_CONTINUED_JOB
      )
      const parsed = buildDelegateWorkTool(createJobMessage).parseToolCall({
        agent: "researcher",
        title: "  Hologram news \n",
        instructions: "\n Collect this week's news about holograms.  ",
        job: 3
      })
      if (parsed.status !== "parsed") throw new Error("Expected a parsed call")
      const { signal } = new AbortController()

      await parsed.runToolCall({
        toolCallId: createFixtureUuidV7(7),
        abortSignal: signal,
        addWebSources: () => []
      })

      expect(createJobMessage).toHaveBeenCalledExactlyOnceWith({
        agentCode: "researcher",
        title: "Hologram news",
        instructions: "Collect this week's news about holograms.",
        jobNumber: 3,
        toolCallId: "01900000-0000-7000-8000-000000000007"
      })
    })

    it("sends a job message without a job number when the call names no job", async () => {
      const createJobMessage = vi.fn<TurnDelegation["createJobMessage"]>(
        () => SENT_NEW_JOB
      )
      const tool = buildDelegateWorkTool(createJobMessage)

      await runDelegationTool(tool, DELEGATE_WORK_ARGUMENTS)

      expect(createJobMessage.mock.calls).toStrictEqual([
        [
          {
            agentCode: "researcher",
            title: "Hologram news",
            instructions: "Collect this week's news about holograms.",
            jobNumber: undefined,
            toolCallId: expect.any(String)
          }
        ]
      ])
    })

    it.each<JobMessageOutcomeCase>([
      [
        "a new job",
        SENT_NEW_JOB,
        buildSucceededResult(
          'Job 1 started: Researcher is working on "Hologram news". Its result arrives later in a message that starts with reports. End your reply when you have nothing else to do.'
        )
      ],
      [
        "a continued job",
        SENT_CONTINUED_JOB,
        buildSucceededResult(
          'Job 1 continues: Researcher is working on "Hologram news". Its result arrives later in a message that starts with reports. End your reply when you have nothing else to do.'
        )
      ],
      [
        "an agent that does not exist",
        buildRefusedOutcome({ kind: "agent-not-found", agentCode: "nobody" }),
        buildFailedResult(
          'No agent has the code "nobody". Use find_agents to look one up.'
        )
      ],
      [
        "a deleted agent",
        buildRefusedOutcome({ kind: "agent-deleted", agentCode: "archivist" }),
        buildFailedResult(
          'The agent "archivist" was deleted and cannot take work.'
        )
      ],
      [
        "a leader",
        buildRefusedOutcome({
          kind: "agent-cannot-take-work",
          agentCode: "lysiptera"
        }),
        buildFailedResult(
          `The agent "lysiptera" is a leader and does not take work. Give the work to a member. find_agents shows each agent's role.`
        )
      ],
      [
        "a job the conversation does not have",
        buildRefusedOutcome({ kind: "job-not-found", jobNumber: 9 }),
        buildFailedResult("This conversation has no job 9.")
      ],
      [
        "another agent's job",
        buildRefusedOutcome({
          kind: "job-has-another-agent",
          jobNumber: 1,
          agentCode: "writer"
        }),
        buildFailedResult(
          'Job 1 belongs to the agent "writer". Continue it with that agent, or leave out job to start a new one.'
        )
      ],
      [
        "a job that is still working",
        buildRefusedOutcome({ kind: "job-is-working", jobNumber: 1 }),
        buildFailedResult(
          "Job 1 is still working. Wait for its report, or stop it with stop_job before you send it a new message."
        )
      ],
      [
        "a job message over the limit",
        buildRefusedOutcome({ kind: "limit-reached", limit: 12 }),
        buildFailedResult(
          "You have sent 12 job messages since the person's last message, and that is the most allowed. Finish with the results you have, and tell the person if more work is needed."
        )
      ],
      [
        "a deleted conversation",
        buildRefusedOutcome({ kind: "conversation-missing" }),
        buildFailedResult(
          "This conversation no longer exists, so no work was given."
        )
      ]
    ])("answers %s with its text", async (_label, outcome, result) => {
      const tool = buildDelegateWorkTool(() => outcome)

      const answer = await runDelegationTool(tool, DELEGATE_WORK_ARGUMENTS)

      expect(answer).toEqual(result)
    })

    it("writes an agent name that holds line breaks on one line", async () => {
      const tool = buildDelegateWorkTool(() => ({
        ...SENT_NEW_JOB,
        agentName: "Web\n\tResearcher"
      }))

      const answer = await runDelegationTool(tool, DELEGATE_WORK_ARGUMENTS)

      expect(answer).toEqual(
        buildSucceededResult(
          'Job 1 started: Web Researcher is working on "Hologram news". Its result arrives later in a message that starts with reports. End your reply when you have nothing else to do.'
        )
      )
    })
  })

  describe("stop_job", () => {
    registerBuiltInToolContractSuite(createStopJobHarness)

    it.each<JobNumberCase>([
      ["0", 0],
      ["-1", -1],
      ["1.5", 1.5]
    ])("refuses the job number %s", (_label, job) => {
      const tool = buildStopJobTool(handleUnexpectedDelegationCall)

      expect(tool.parseToolCall({ job })).toEqual(INVALID_JOB_CALL)
    })

    it.each<StopJobOutcomeCase>([
      [
        "a stopped job",
        { status: "stopped", jobNumber: 2 },
        buildSucceededResult("Job 2 was stopped. No result comes back for it.")
      ],
      [
        "a job that had replied",
        { status: "already-ended", jobNumber: 2, state: "replied" },
        buildSucceededResult("Job 2 was not working: it had finished.")
      ],
      [
        "a job that had failed",
        { status: "already-ended", jobNumber: 2, state: "failed" },
        buildSucceededResult("Job 2 was not working: it had failed.")
      ],
      [
        "a job that had been stopped",
        { status: "already-ended", jobNumber: 2, state: "stopped" },
        buildSucceededResult("Job 2 was not working: it had been stopped.")
      ],
      [
        "a job that had been interrupted",
        { status: "already-ended", jobNumber: 2, state: "interrupted" },
        buildSucceededResult("Job 2 was not working: it had been interrupted.")
      ],
      [
        "a job the conversation does not have",
        { status: "job-not-found", jobNumber: 2 },
        buildFailedResult("This conversation has no job 2.")
      ]
    ])("answers %s with its text", async (_label, outcome, result) => {
      const tool = buildStopJobTool(() => Promise.resolve(outcome))

      const answer = await runDelegationTool(tool, STOP_JOB_ARGUMENTS)

      expect(answer).toEqual(result)
    })

    it("passes the job number and the run context's abort signal to stopJob", async () => {
      const stopJob = vi.fn<TurnDelegation["stopJob"]>((jobNumber) =>
        Promise.resolve({ status: "stopped", jobNumber })
      )
      const parsed = buildStopJobTool(stopJob).parseToolCall(STOP_JOB_ARGUMENTS)
      if (parsed.status !== "parsed") throw new Error("Expected a parsed call")
      const { context } = createRecordedRunContext(new AbortController().signal)

      await parsed.runToolCall(context)

      expect(stopJob).toHaveBeenCalledExactlyOnceWith(2, context.abortSignal)
    })

    it("rejects with the reason stopJob rejected with, as when the reply is stopped while the job ends", async () => {
      const stopReason = new Error("stopped while the job ended")
      const tool = buildStopJobTool(() => Promise.reject(stopReason))

      await expect(runDelegationTool(tool, STOP_JOB_ARGUMENTS)).rejects.toBe(
        stopReason
      )
    })
  })

  describe("report_progress", () => {
    registerBuiltInToolContractSuite(createReportProgressHarness)

    /** Parse outcome of a `report_progress` call whose note cannot run. */
    const invalidNoteCall = Object.freeze({
      status: "invalid",
      message: "The note must be 1 to 2000 characters long after trimming."
    })

    it.for<TextParseCase>([
      ["2000 characters", "parsed", "n".repeat(2000), PARSED_CALL],
      [
        "2000 characters between line breaks",
        "parsed",
        `\n${"n".repeat(2000)}\n`,
        PARSED_CALL
      ],
      ["2001 characters", "invalid", "n".repeat(2001), invalidNoteCall],
      ["only spaces and line breaks", "invalid", " \n ", invalidNoteCall]
    ])("parses a note of %s as %s", ([, , note, outcome]) => {
      const tool = buildReportProgressTool(handleUnexpectedDelegationCall)

      expect(tool.parseToolCall({ note })).toEqual(outcome)
    })

    it("stores the trimmed note, keeping the line breaks inside it", async () => {
      const createProgressNote = vi.fn<TurnDelegation["createProgressNote"]>(
        () => "stored"
      )
      const tool = buildReportProgressTool(createProgressNote)

      await runDelegationTool(tool, {
        note: "  Two of five sources are read.\nThree to go. \n"
      })

      expect(createProgressNote).toHaveBeenCalledExactlyOnceWith(
        "Two of five sources are read.\nThree to go."
      )
    })

    it("answers a stored note with Noted. and a missing job as failed", async () => {
      const storing = buildReportProgressTool(() => "stored")
      const orphaned = buildReportProgressTool(() => "job-missing")

      const stored = await runDelegationTool(storing, REPORT_PROGRESS_ARGUMENTS)
      const missing = await runDelegationTool(
        orphaned,
        REPORT_PROGRESS_ARGUMENTS
      )

      expect(stored).toEqual(buildSucceededResult("Noted."))
      expect(missing).toEqual(
        buildFailedResult(
          "This job no longer exists, so the note was not stored."
        )
      )
    })
  })
})

describe("formatJobNote", () => {
  it("writes the job note with and without the report_progress sentence", () => {
    const withProgressTool = formatJobNote(JOB_TURN, true)
    const withoutProgressTool = formatJobNote(JOB_TURN, false)

    expect(withProgressTool).toBe(
      "You are working on job 2 for Caliginia, another agent in Lys. The message you answer holds Caliginia's instructions, not a person's. Your final reply goes back to Caliginia as the result, so put everything it needs into that reply. While you work, you can send a short note on where the job stands with report_progress. You cannot ask the person anything here: when you need something to finish, say what you need in your reply."
    )
    expect(withoutProgressTool).toBe(
      "You are working on job 2 for Caliginia, another agent in Lys. The message you answer holds Caliginia's instructions, not a person's. Your final reply goes back to Caliginia as the result, so put everything it needs into that reply. You cannot ask the person anything here: when you need something to finish, say what you need in your reply."
    )
  })

  it("writes a delegator name that holds line breaks on one line in the job note", () => {
    const note = formatJobNote(
      { delegatorName: "Cali\nginia", jobNumber: 2 },
      false
    )

    expect(note).toBe(
      "You are working on job 2 for Cali ginia, another agent in Lys. The message you answer holds Cali ginia's instructions, not a person's. Your final reply goes back to Cali ginia as the result, so put everything it needs into that reply. You cannot ask the person anything here: when you need something to finish, say what you need in your reply."
    )
  })
})
