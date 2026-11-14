import type { FastifyBaseLogger } from "fastify"
import type ActivityHub from "../activity/activityHub"
import type Agent from "../agent/agent"
import type { FoundAgent } from "../agent/capabilities"
import type { ConversationTurnWriter } from "../chat/persistence"
import type ReplyGenerationRegistry from "../chat/replyGenerationRegistry"
import type { StartTurn, StartTurnOptions } from "../chat/turnStart"
import type ConversationWakeSettings from "./conversationWakeSettings"
import type { DelegationEvent } from "./delegationEvent"
import type { JobActivityReader, JobReader, JobReportWriter } from "./records"
import type ReplyStopRequests from "./replyStopRequests"

/** How the delegation policies look agents up. */
export type DelegationAgentLookups = Readonly<{
  /**
   * Finds a built-in or stored agent by its code, deleted or not; undefined
   * when no agent has the code.
   */
  findAgent: (code: string) => FoundAgent | undefined
  /**
   * Loads the live agent that answers turns under a code; undefined when no
   * agent has the code or its agent is deleted.
   */
  loadChatAgent: (code: string) => Agent | undefined
  /**
   * Finds the code of the agent a stored conversation is answered by;
   * undefined when the conversation is not stored.
   */
  findConversationAgentCode: (conversationId: string) => string | undefined
}>

/**
 * What the delegation policies borrow from the composition root, for as long
 * as turns are started and their generations run.
 */
export type DelegationDependencies = DelegationAgentLookups &
  Readonly<{
    /** Reads the jobs of conversations. */
    jobs: JobReader
    /** Reads what the replies and reports of conversations wait for. */
    jobActivity: JobActivityReader
    /** Stores the reports jobs send to their delegators. */
    reports: JobReportWriter
    /** Stores each job turn and each wake-up turn. */
    turns: Pick<ConversationTurnWriter, "createConversationTurn">
    /** Starts the generation of each stored job turn and wake-up turn. */
    startTurn: StartTurn
    /** Finds the running generation of a reply, to stop it. */
    generations: Pick<ReplyGenerationRegistry, "findReplyGeneration">
    /**
     * Tells the activity streams which replies delegation started and how
     * jobs changed.
     */
    hub: Pick<ActivityHub, "addReply" | "removeReply" | "sendJobUpdate">
    /** Settings of the wake-up turns of each conversation. */
    wakeSettings: ConversationWakeSettings
    /** Who asked each reply to stop, until the reply ends. */
    stopRequests: ReplyStopRequests
    /**
     * Job messages agents may send in one main conversation since the
     * person's last message there; a positive integer.
     */
    agentJobMessageLimit: number
    /** Receives, for the log, what delegation did that no caller observes. */
    reportEvent: (event: DelegationEvent) => void
    /** Logger of the turns delegation starts. */
    logger: FastifyBaseLogger
  }>

/**
 * What every delegation policy runs with: the collaborators, and the hooks
 * handed to each turn delegation starts, which call the delegation policies
 * with this runtime.
 */
export type DelegationRuntime = DelegationDependencies &
  Readonly<{
    /**
     * Handles the start of every turn delegation starts, as
     * {@link StartTurnOptions} describes the hook.
     */
    handleTurnStarted: StartTurnOptions["handleTurnStarted"]
    /**
     * Creates the part in delegation of every turn delegation starts, as
     * {@link StartTurnOptions} describes the hook.
     */
    createTurnDelegation: StartTurnOptions["createTurnDelegation"]
    /**
     * Handles the end of the reply of every turn delegation starts, as
     * {@link StartTurnOptions} describes the hook.
     */
    handleReplyEnded: StartTurnOptions["handleReplyEnded"]
  }>
