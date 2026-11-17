import {
  agentCodeSchema,
  DELEGATE_WORK_TOOL_NAME,
  FIND_AGENTS_TOOL_NAME,
  MAXIMUM_JOB_TITLE_LENGTH,
  MAXIMUM_PROGRESS_NOTE_LENGTH,
  parseJobTitle,
  REPORT_PROGRESS_TOOL_NAME,
  STOP_JOB_TOOL_NAME,
  toolDefinitionSchema,
  type JobState,
  type ToolArgumentDefinitionCandidate,
  type ToolDefinition
} from "@lys/share"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  BuiltInToolRunContext,
  ParsedBuiltInToolCall,
  TurnBuiltInTool
} from "../tool/builtIn/builtInTool"
import { hasAgentPermission, type AgentRole } from "./agentRoles"
import { formatOneLine } from "./oneLineText"
import type {
  DelegationOffer,
  JobMessageDraft,
  JobMessageOutcome,
  JobMessageRefusal,
  JobTurn,
  StopJobOutcome,
  TurnDelegation
} from "./turnDelegation"

/**
 * What a `delegate_work` call asks for, before a run adds the identity of
 * its call.
 */
type JobMessageRequest = Omit<JobMessageDraft, "toolCallId">

/** A job message that was sent. */
type SentJobMessage = Extract<JobMessageOutcome, { status: "sent" }>

/**
 * Runs one parsed call of a delegation tool.
 *
 * @param context - The run's call identity and cancellation.
 * @returns The result the model reads, at once or once the work settled.
 */
type RunDelegationCall = (
  context: BuiltInToolRunContext
) => BuiltInToolResult | Promise<BuiltInToolResult>

/** One delegation tool: what the model is offered, and what runs its calls. */
type DelegationToolEntry = Readonly<{
  /** Definition the model is offered. */
  definition: ToolDefinition
  /** Whether each call runs at once, without the person being asked. */
  runsWithoutApproval: boolean
  /** Builds the tool that parses and runs the calls of one turn. */
  buildTool: (delegation: TurnDelegation) => BuiltInTool
}>

/** Arguments of `delegate_work`, in the order the model is offered them. */
const DELEGATE_WORK_ARGUMENTS: readonly ToolArgumentDefinitionCandidate[] =
  Object.freeze([
    Object.freeze({
      type: "string",
      name: "agent",
      description: "Code of the agent that should do the work."
    }),
    Object.freeze({
      type: "string",
      name: "title",
      description: `A few words that name the work, at most ${MAXIMUM_JOB_TITLE_LENGTH} characters on one line. The person sees it on the job's card.`
    }),
    Object.freeze({
      type: "string",
      name: "instructions",
      description:
        "Everything the agent needs to do the work. It sees only these instructions and nothing else of this conversation."
    }),
    Object.freeze({
      type: "integer",
      name: "job",
      description:
        "Number of an earlier job of this conversation to continue. Leave it out to start a new job.",
      required: false
    })
  ])

/** Arguments of `stop_job`. */
const STOP_JOB_ARGUMENTS: readonly ToolArgumentDefinitionCandidate[] =
  Object.freeze([
    Object.freeze({
      type: "integer",
      name: "job",
      description: "Number of the job to stop."
    })
  ])

/** Arguments of `report_progress`. */
const REPORT_PROGRESS_ARGUMENTS: readonly ToolArgumentDefinitionCandidate[] =
  Object.freeze([
    Object.freeze({
      type: "string",
      name: "note",
      description: `Where the job stands, at most ${MAXIMUM_PROGRESS_NOTE_LENGTH} characters.`
    })
  ])

/** Definition of the tool that gives work to another agent. */
const DELEGATE_WORK_DEFINITION = toolDefinitionSchema.parse({
  name: DELEGATE_WORK_TOOL_NAME,
  description: `Gives work to another agent in Lys. The agent works on it on its own, in a separate job, and you do not wait for it: this call returns as soon as the job has started. The job's result, or its failure, arrives later in a message that starts with reports, so end your reply when you have nothing else to do. Use ${FIND_AGENTS_TOOL_NAME} to see which agents can take work. To send a follow-up to an earlier job that is not working any more, give its number as job.`,
  group: "agents",
  access: "agents",
  runner: "backend",
  arguments: DELEGATE_WORK_ARGUMENTS
})

/** Definition of the tool that stops a job of the calling conversation. */
const STOP_JOB_DEFINITION = toolDefinitionSchema.parse({
  name: STOP_JOB_TOOL_NAME,
  description:
    "Stops a job of this conversation that is still working. Its agent's reply ends at once, and no result comes back for it.",
  group: "agents",
  access: "agents",
  runner: "backend",
  arguments: STOP_JOB_ARGUMENTS
})

/** Definition of the tool a job's agent sends its delegator a note with. */
const REPORT_PROGRESS_DEFINITION = toolDefinitionSchema.parse({
  name: REPORT_PROGRESS_TOOL_NAME,
  description:
    "Sends the agent that gave you this job a short note on where the job stands. It replaces your earlier note if that one has not been read yet, so say where the whole job stands. Your work goes on after the call.",
  group: "agents",
  access: "agents",
  runner: "backend",
  arguments: REPORT_PROGRESS_ARGUMENTS
})

/** Parse outcome of a call whose job cannot be the number of a job. */
const INVALID_JOB_CALL: ParsedBuiltInToolCall = Object.freeze({
  status: "invalid",
  message: "The job must be a whole number of 1 or more."
})

/** Sources a delegation tool's result shows: none. */
const NO_SOURCES = Object.freeze([])

/**
 * Parses an argument value as text that is not blank.
 *
 * @param value - Argument value of a call.
 * @returns The trimmed text, or undefined when the value is not text or is
 * blank.
 */
function parseTrimmedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return text === "" ? undefined : text
}

/**
 * Parses an argument value as a progress note.
 *
 * @param value - Argument value of a call.
 * @returns The trimmed note, or undefined when the value is not text, is
 * blank, or is longer than `MAXIMUM_PROGRESS_NOTE_LENGTH` of `@lys/share`.
 */
function parseProgressNote(value: unknown): string | undefined {
  const note = parseTrimmedText(value)
  if (note === undefined) return undefined
  return note.length <= MAXIMUM_PROGRESS_NOTE_LENGTH ? note : undefined
}

/**
 * Answers whether an argument value can be the number of a job.
 *
 * @param value - Argument value of a call.
 * @returns True for a safe integer of 1 or more; false for any other value,
 * such as a fraction, zero, or a negative number.
 */
function isJobNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

/**
 * Builds a parsed call around what one run of it does.
 *
 * @param runCall - Runs the call with the run's context.
 * @returns The parsed call: each run rejects with the abort reason when the
 * signal already aborted, without calling `runCall`, and otherwise settles
 * as `runCall`'s result does.
 */
function buildParsedCall(runCall: RunDelegationCall): ParsedBuiltInToolCall {
  return Object.freeze({
    status: "parsed",
    runToolCall: (context) =>
      new Promise<BuiltInToolResult>((resolve) => {
        context.abortSignal.throwIfAborted()
        resolve(runCall(context))
      })
  })
}

/**
 * Builds a result the model reads as a success.
 *
 * @param content - Text of the result.
 * @returns The result, showing no sources.
 */
function buildSucceededResult(content: string): BuiltInToolResult {
  return Object.freeze({ status: "succeeded", content, sources: NO_SOURCES })
}

/**
 * Builds a result the model reads as a failure it can act on.
 *
 * @param content - Text of the result.
 * @returns The result.
 */
function buildFailedResult(content: string): BuiltInToolResult {
  return Object.freeze({ status: "failed", content })
}

/**
 * Formats what the model reads when it named a job its conversation does
 * not have.
 *
 * @param jobNumber - Number the call named.
 * @returns The sentence.
 */
function formatMissingJob(jobNumber: number): string {
  return `This conversation has no job ${jobNumber}.`
}

/**
 * Formats what the model reads once a job message was sent.
 *
 * @param sent - The job, its agent, and its title.
 * @returns That the job started or continues, who works on what, that its
 * result arrives later, and that the reply can end. The agent's name is
 * written on one line.
 */
function formatSentJobMessage(sent: SentJobMessage): string {
  const progress = sent.isNewJob ? "started" : "continues"
  const agentName = formatOneLine(sent.agentName)
  return `Job ${sent.jobNumber} ${progress}: ${agentName} is working on "${sent.title}". Its result arrives later in a message that starts with reports. End your reply when you have nothing else to do.`
}

/**
 * Formats what the model reads when its job message was refused.
 *
 * @param refusal - Why the message was refused.
 * @returns What was wrong and what the model can do instead.
 */
function formatJobMessageRefusal(refusal: JobMessageRefusal): string {
  switch (refusal.kind) {
    case "agent-not-found":
      return `No agent has the code "${refusal.agentCode}". Use ${FIND_AGENTS_TOOL_NAME} to look one up.`
    case "agent-deleted":
      return `The agent "${refusal.agentCode}" was deleted and cannot take work.`
    case "agent-cannot-take-work":
      return `The agent "${refusal.agentCode}" is a leader and does not take work. Give the work to a member. ${FIND_AGENTS_TOOL_NAME} shows each agent's role.`
    case "job-not-found":
      return formatMissingJob(refusal.jobNumber)
    case "job-has-another-agent":
      return `Job ${refusal.jobNumber} belongs to the agent "${refusal.agentCode}". Continue it with that agent, or leave out job to start a new one.`
    case "job-is-working":
      return `Job ${refusal.jobNumber} is still working. Wait for its report, or stop it with ${STOP_JOB_TOOL_NAME} before you send it a new message.`
    case "limit-reached":
      return `You have sent ${refusal.limit} job messages since the person's last message, and that is the most allowed. Finish with the results you have, and tell the person if more work is needed.`
    case "conversation-missing":
      return "This conversation no longer exists, so no work was given."
  }
}

/**
 * Builds the result of a `stop_job` call from what the stop led to.
 *
 * @param outcome - What the stop led to.
 * @returns A success saying the job was stopped, or what it had done when it
 * was not working; a failure when the conversation has no such job.
 */
function buildStopJobResult(outcome: StopJobOutcome): BuiltInToolResult {
  /**
   * What a job that was not working had done, by its state, as the words that
   * follow "it had" in the result of `stop_job`.
   */
  const endedJobStateText: Readonly<
    Record<Exclude<JobState, "working">, string>
  > = Object.freeze({
    replied: "finished",
    failed: "failed",
    stopped: "been stopped",
    interrupted: "been interrupted"
  })

  switch (outcome.status) {
    case "stopped":
      return buildSucceededResult(
        `Job ${outcome.jobNumber} was stopped. No result comes back for it.`
      )
    case "already-ended":
      return buildSucceededResult(
        `Job ${outcome.jobNumber} was not working: it had ${endedJobStateText[outcome.state]}.`
      )
    case "job-not-found":
      return buildFailedResult(formatMissingJob(outcome.jobNumber))
  }
}

/**
 * Runs one call of `delegate_work`.
 *
 * @param createJobMessage - Sends one job message for the turn.
 * @param request - What the call asks for.
 * @param toolCallId - UUIDv7 of the call.
 * @returns A success saying the job started or continues, or a failure
 * saying why the message was refused.
 */
function runDelegateWork(
  createJobMessage: TurnDelegation["createJobMessage"],
  request: JobMessageRequest,
  toolCallId: string
): BuiltInToolResult {
  const draft: JobMessageDraft = Object.freeze({
    agentCode: request.agentCode,
    title: request.title,
    instructions: request.instructions,
    jobNumber: request.jobNumber,
    toolCallId
  })
  const outcome = createJobMessage(draft)
  return outcome.status === "sent"
    ? buildSucceededResult(formatSentJobMessage(outcome))
    : buildFailedResult(formatJobMessageRefusal(outcome.refusal))
}

/**
 * Runs one call of `stop_job`.
 *
 * @param stopJob - Stops one job of the turn's conversation.
 * @param jobNumber - Number of the job to stop.
 * @param abortSignal - Stops the wait for the job's reply to end.
 * @returns A promise resolving to what the stop led to, once the job's reply
 * has reached its stored final state.
 * @throws The abort reason when the signal aborts first.
 */
async function runStopJob(
  stopJob: TurnDelegation["stopJob"],
  jobNumber: number,
  abortSignal: AbortSignal
): Promise<BuiltInToolResult> {
  return buildStopJobResult(await stopJob(jobNumber, abortSignal))
}

/**
 * Runs one call of `report_progress`.
 *
 * @param createProgressNote - Stores one note of the turn's job.
 * @param note - The trimmed, bounded note.
 * @returns A success once the note is stored, or a failure when the job is
 * no longer stored.
 */
function runReportProgress(
  createProgressNote: TurnDelegation["createProgressNote"],
  note: string
): BuiltInToolResult {
  /** Result of a `report_progress` call whose note was stored. */
  const storedNoteResult: BuiltInToolResult = Object.freeze({
    status: "succeeded",
    content: "Noted.",
    sources: NO_SOURCES
  })

  /** Result of a `report_progress` call whose job is no longer stored. */
  const missingJobNoteResult: BuiltInToolResult = Object.freeze({
    status: "failed",
    content: "This job no longer exists, so the note was not stored."
  })

  return createProgressNote(note) === "stored"
    ? storedNoteResult
    : missingJobNoteResult
}

/**
 * Parses and runs the `delegate_work` calls of one turn.
 *
 * @remarks Implements {@link BuiltInTool}. Built once for a turn that offers
 * the tool, it keeps the turn's job message sender and nothing else.
 * Invariant: every call of the turn sends through that one sender, with the
 * identity of its own call. Parsing checks the arguments and sends nothing;
 * each run sends one job message, when it runs. Owns no resource; the
 * sender's owner keeps it usable for the turn. Concurrency model: reentrant,
 * and parsed calls run independently.
 */
class DelegateWorkTool implements BuiltInTool {
  /** Sends one job message for the turn; borrowed for the turn. */
  readonly #createJobMessage: TurnDelegation["createJobMessage"]

  /**
   * Keeps the turn's job message sender without calling it.
   * @param createJobMessage - Sends one job message for the turn, lent for
   * the turn.
   */
  public constructor(createJobMessage: TurnDelegation["createJobMessage"]) {
    this.#createJobMessage = createJobMessage
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for `delegate_work`.
   * @param callArguments - The interface-defined argument values: `agent`,
   * `title`, `instructions`, and `job` when the call continues a job.
   * @returns The interface-defined outcome. `invalid` explains the first of
   * these that cannot run: an agent that is not an agent code, a title that
   * {@link parseJobTitle} refuses, blank instructions, and a job that is not
   * a whole number of 1 or more. The run sends the trimmed title and
   * instructions.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    /** Parse outcome of a call whose agent cannot be an agent code. */
    const invalidAgentCall: ParsedBuiltInToolCall = Object.freeze({
      status: "invalid",
      message:
        "The agent must be an agent code: lowercase letters and digits in groups joined by single hyphens."
    })

    /**
     * Parse outcome of a call whose title is blank, too long, or on several
     * lines.
     */
    const invalidTitleCall: ParsedBuiltInToolCall = Object.freeze({
      status: "invalid",
      message: `The title must be 1 to ${MAXIMUM_JOB_TITLE_LENGTH} characters on one line after trimming.`
    })

    /** Parse outcome of a call whose instructions are blank. */
    const invalidInstructionsCall: ParsedBuiltInToolCall = Object.freeze({
      status: "invalid",
      message: "The instructions must not be empty."
    })

    const agentCode = agentCodeSchema.safeParse(callArguments["agent"])
    if (!agentCode.success) return invalidAgentCall
    const title = parseJobTitle(callArguments["title"])
    if (title === undefined) return invalidTitleCall
    const instructions = parseTrimmedText(callArguments["instructions"])
    if (instructions === undefined) return invalidInstructionsCall
    const jobNumber = callArguments["job"]
    if (jobNumber !== undefined && !isJobNumber(jobNumber))
      return INVALID_JOB_CALL
    const request: JobMessageRequest = Object.freeze({
      agentCode: agentCode.data,
      title,
      instructions,
      jobNumber
    })
    return buildParsedCall(({ toolCallId }) =>
      runDelegateWork(this.#createJobMessage, request, toolCallId)
    )
  }
}

/**
 * Parses and runs the `stop_job` calls of one turn.
 *
 * @remarks Implements {@link BuiltInTool}. Built once for a turn that offers
 * the tool, it keeps the turn's job stop and nothing else. Invariant: every
 * call of the turn stops through that one callback, under the cancellation
 * of its own run. Parsing checks the job number and stops nothing; each run
 * asks for one stop, when it runs, and settles when that stop does. Owns no
 * resource; the stop's owner keeps it usable for the turn. Concurrency
 * model: reentrant, and parsed calls run independently.
 */
class StopJobTool implements BuiltInTool {
  /** Stops one job of the turn's conversation; borrowed for the turn. */
  readonly #stopJob: TurnDelegation["stopJob"]

  /**
   * Keeps the turn's job stop without calling it.
   * @param stopJob - Stops one job of the turn's conversation, lent for the
   * turn.
   */
  public constructor(stopJob: TurnDelegation["stopJob"]) {
    this.#stopJob = stopJob
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for `stop_job`.
   * @param callArguments - The interface-defined argument values: `job`.
   * @returns The interface-defined outcome; `invalid` for a job that is not
   * a whole number of 1 or more. The run resolves once the job's reply has
   * reached its stored final state, and rejects with the abort reason when
   * its signal aborts first.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    const jobNumber = callArguments["job"]
    if (!isJobNumber(jobNumber)) return INVALID_JOB_CALL
    return buildParsedCall(({ abortSignal }) =>
      runStopJob(this.#stopJob, jobNumber, abortSignal)
    )
  }
}

/**
 * Parses and runs the `report_progress` calls of one turn of a job.
 *
 * @remarks Implements {@link BuiltInTool}. Built once for a turn that offers
 * the tool, it keeps the turn's progress note store and nothing else.
 * Invariant: every call of the turn stores through that one callback.
 * Parsing checks the note and stores nothing; each run stores one note, when
 * it runs. Owns no resource; the store's owner keeps it usable for the turn.
 * Concurrency model: reentrant, and parsed calls run independently.
 */
class ReportProgressTool implements BuiltInTool {
  /** Stores one note of the turn's job; borrowed for the turn. */
  readonly #createProgressNote: TurnDelegation["createProgressNote"]

  /**
   * Keeps the turn's progress note store without calling it.
   * @param createProgressNote - Stores one note of the turn's job, lent for
   * the turn.
   */
  public constructor(createProgressNote: TurnDelegation["createProgressNote"]) {
    this.#createProgressNote = createProgressNote
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for `report_progress`.
   * @param callArguments - The interface-defined argument values: `note`.
   * @returns The interface-defined outcome; `invalid` for a note that
   * {@link parseProgressNote} refuses. The run stores the trimmed note.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    /** Parse outcome of a call whose note is blank or too long. */
    const invalidNoteCall: ParsedBuiltInToolCall = Object.freeze({
      status: "invalid",
      message: `The note must be 1 to ${MAXIMUM_PROGRESS_NOTE_LENGTH} characters long after trimming.`
    })

    const note = parseProgressNote(callArguments["note"])
    if (note === undefined) return invalidNoteCall
    return buildParsedCall(() =>
      runReportProgress(this.#createProgressNote, note)
    )
  }
}

/**
 * `delegate_work`, whose every call passes the approval gate: it starts work
 * the person has not allowed yet.
 */
const DELEGATE_WORK_ENTRY: DelegationToolEntry = Object.freeze({
  definition: DELEGATE_WORK_DEFINITION,
  runsWithoutApproval: false,
  buildTool: (delegation) => new DelegateWorkTool(delegation.createJobMessage)
})

/**
 * `stop_job`, whose calls run without approval: each only acts on a job the
 * person already allowed.
 */
const STOP_JOB_ENTRY: DelegationToolEntry = Object.freeze({
  definition: STOP_JOB_DEFINITION,
  runsWithoutApproval: true,
  buildTool: (delegation) => new StopJobTool(delegation.stopJob)
})

/**
 * `report_progress`, whose calls run without approval: each only acts inside
 * a job the person already allowed.
 */
const REPORT_PROGRESS_ENTRY: DelegationToolEntry = Object.freeze({
  definition: REPORT_PROGRESS_DEFINITION,
  runsWithoutApproval: true,
  buildTool: (delegation) =>
    new ReportProgressTool(delegation.createProgressNote)
})

/**
 * Lists the delegation tools an agent of a role is offered in one turn.
 *
 * @param role - Role of the agent.
 * @param offer - What the turn's conversation and tool offer allow.
 * @returns A frozen list in offer order: `report_progress` alone in a job's
 * turn; otherwise `delegate_work` when the turn may delegate and the role
 * grants `delegate-work`, and `stop_job` when the turn offers
 * `delegate_work` or the conversation has jobs.
 * @remarks `stop_job` comes with `delegate_work` so that a turn which
 * starts its conversation's first job can stop it, as the refusal of a
 * message to a job that still works tells the model to.
 */
function listOfferedEntries(
  role: AgentRole,
  offer: DelegationOffer
): readonly DelegationToolEntry[] {
  if (offer.kind === "job") return Object.freeze([REPORT_PROGRESS_ENTRY])
  const entries: DelegationToolEntry[] = []
  const offersDelegateWork =
    offer.mayDelegate && hasAgentPermission(role, "delegate-work")
  if (offersDelegateWork) entries.push(DELEGATE_WORK_ENTRY)
  if (offersDelegateWork || offer.hasJobs) entries.push(STOP_JOB_ENTRY)
  return Object.freeze(entries)
}

/**
 * Builds one delegation tool of one turn.
 *
 * @param entry - The tool's definition, approval rule, and builder.
 * @param delegation - The turn's delegation callbacks, lent for the turn.
 * @returns The frozen tool with its definition and approval rule.
 */
function buildTurnDelegationTool(
  entry: DelegationToolEntry,
  delegation: TurnDelegation
): TurnBuiltInTool {
  const tool = entry.buildTool(delegation)
  return Object.freeze({
    definition: entry.definition,
    tool,
    runsWithoutApproval: entry.runsWithoutApproval
  })
}

/**
 * Builds the definitions of the delegation tools an agent of a role is
 * offered in one turn.
 *
 * @param role - Role of the agent.
 * @param offer - What the turn's conversation and tool offer allow.
 * @returns The frozen definitions, in offer order: `report_progress` alone
 * in a job's turn; otherwise `delegate_work` when the turn may delegate and
 * the role grants `delegate-work`, and `stop_job` when the turn offers
 * `delegate_work` or the conversation has jobs. Each is in the `agents`
 * group, has `agents` access, and runs in the backend.
 */
export function buildDelegationDefinitions(
  role: AgentRole,
  offer: DelegationOffer
): readonly ToolDefinition[] {
  return Object.freeze(
    listOfferedEntries(role, offer).map((entry) => entry.definition)
  )
}

/**
 * Builds the delegation tools one turn offers its agent.
 *
 * @param role - Role of the agent.
 * @param delegation - The turn's offer and delegation callbacks, lent for
 * the turn.
 * @returns One frozen tool per definition of
 * {@link buildDelegationDefinitions} for the role and the delegation's
 * offer, in that order, each keeping only the callback it calls. A
 * `delegate_work` call passes the approval gate; `stop_job` and
 * `report_progress` calls run without the person's approval, because they
 * only act inside a job the person already allowed.
 */
export function buildDelegationTools(
  role: AgentRole,
  delegation: TurnDelegation
): readonly TurnBuiltInTool[] {
  return Object.freeze(
    listOfferedEntries(role, delegation.offer).map((entry) =>
      buildTurnDelegationTool(entry, delegation)
    )
  )
}

/**
 * Builds the definitions of the delegation tools Settings lists.
 *
 * @returns The frozen definitions, equal on every call: `delegate_work`
 * only, because the other two have no switch.
 */
export function buildListedDelegationDefinitions(): readonly ToolDefinition[] {
  /** Definitions Settings lists: `delegate_work`, the one with a switch. */
  const listedDefinitions: readonly ToolDefinition[] = Object.freeze([
    DELEGATE_WORK_DEFINITION
  ])

  return listedDefinitions
}

/**
 * Formats the note that ends the instructions of a turn that works on a job.
 *
 * @param job - The job the turn works on.
 * @param offersProgressTool - Whether the turn offers `report_progress`.
 * @returns One paragraph: whom the agent works for, that the message it
 * answers holds that agent's instructions, that its final reply is the
 * result, how to send a progress note when the turn offers the tool, and
 * that it cannot ask the person anything. The delegator's name is written
 * on one line.
 */
export function formatJobNote(
  job: JobTurn,
  offersProgressTool: boolean
): string {
  const { jobNumber } = job
  const delegatorName = formatOneLine(job.delegatorName)
  const progress = offersProgressTool
    ? ` While you work, you can send a short note on where the job stands with ${REPORT_PROGRESS_TOOL_NAME}.`
    : ""
  return `You are working on job ${jobNumber} for ${delegatorName}, another agent in Lys. The message you answer holds ${delegatorName}'s instructions, not a person's. Your final reply goes back to ${delegatorName} as the result, so put everything it needs into that reply.${progress} You cannot ask the person anything here: when you need something to finish, say what you need in your reply.`
}
