import {
  MAXIMUM_AGENT_LIST_PAGE_SIZE,
  type AgentSummary,
  type ListAgentsApiQuery,
  type ListAgentsApiResponse
} from "@lys/protocol"
import type { Agent, AgentDefinitionCandidate } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import * as agentApi from "@/lib/apis/http/agents"
import type {
  AgentApiConnection,
  AgentUpdate,
  CreateAgentResult,
  DeleteAgentResult,
  GetAgentResult,
  UpdateAgentResult
} from "@/lib/apis/http/agents"
import { useLysStore } from "@/lib/store"

import {
  buildStoredAgentDraft,
  calculateAgentCodeFromText,
  calculateDuplicateAgentName,
  EMPTY_AGENT_DRAFT,
  findAgentDraftProblem,
  type AgentDraft,
  type AgentDraftSubject
} from "./agent-draft"

export {
  calculateAgentCodeFromName,
  calculateAgentDraftProblemField,
  findAgentDraftProblem,
  isAgentDraftChanged,
  isNewAgentDraftStarted,
  type AgentDraft,
  type AgentDraftField,
  type AgentDraftProblem,
  type AgentDraftSubject
} from "./agent-draft"

/** Backend origin and availability sampled when an agent request starts. */
export type AgentBackend = {
  /** Application-owned backend origin. */
  readonly backendUrl: string
  /** Whether the backend process currently admits requests. */
  readonly isRunning: boolean
}

/**
 * Runtime dependencies used by one independently owned agent store.
 *
 * @remarks The store owns its list read, its agent read, and every change it
 * starts; these dependencies provide only transport and backend
 * availability.
 */
export type AgentStoreDependencies = {
  /** Lists one page of agents; the store supplies its abort signal. */
  readonly listAgents: (
    query: ListAgentsApiQuery,
    connection: AgentApiConnection
  ) => Promise<ListAgentsApiResponse>
  /** Reads one agent; the store supplies its abort signal. */
  readonly getAgent: (
    agentCode: string,
    connection: AgentApiConnection
  ) => Promise<GetAgentResult>
  /** Stores a new agent; mutations are never cancelled locally. */
  readonly createAgent: (
    definition: AgentDefinitionCandidate,
    connection: AgentApiConnection
  ) => Promise<CreateAgentResult>
  /** Changes one agent; mutations are never cancelled locally. */
  readonly updateAgent: (
    update: AgentUpdate,
    connection: AgentApiConnection
  ) => Promise<UpdateAgentResult>
  /** Deletes one agent; mutations are never cancelled locally. */
  readonly deleteAgent: (
    agentCode: string,
    connection: AgentApiConnection
  ) => Promise<DeleteAgentResult>
  /** Samples the backend origin and whether it admits requests. */
  readonly getBackend: () => AgentBackend
}

/**
 * Lifecycle of the list of every stored agent.
 *
 * @remarks The list holds every stored agent, oldest first, because names
 * are checked for uniqueness against all of them.
 */
export type AgentListState =
  | {
      /** No read has started. */
      readonly status: "idle"
    }
  | {
      /** The first read is pending and nothing is displayed yet. */
      readonly status: "loading"
    }
  | {
      /** Every stored agent was read. */
      readonly status: "loaded"
      /** Agents oldest first, each code once. */
      readonly agents: readonly AgentSummary[]
      /** Whether a replacement read is pending while these stay displayed. */
      readonly isRefreshing: boolean
    }
  | {
      /** The latest read failed. */
      readonly status: "failed"
      /** User-presentable reason. */
      readonly error: string
    }

/** Change or confirmation in progress in the editor of a stored agent. */
export type StoredAgentActivity =
  | {
      /** Nothing is pending. */
      readonly status: "idle"
      /** Latest failure of a save or delete, or null when there is none. */
      readonly failure: string | null
    }
  | {
      /** Deletion awaits confirmation. */
      readonly status: "confirming-delete"
    }
  | {
      /** A save awaits the backend. */
      readonly status: "saving"
    }
  | {
      /** A deletion awaits the backend. */
      readonly status: "deleting"
    }

/** Change in progress in the editor of a new agent. */
export type NewAgentActivity = Extract<
  StoredAgentActivity,
  { readonly status: "idle" | "saving" }
>

/**
 * What the agent editor shows.
 *
 * @remarks Only one agent is edited at a time. The editor outlives the
 * settings pane, so a draft survives leaving and returning to it; closing the
 * editor discards the draft. While a save or delete is pending, the editor
 * cannot be closed or replaced.
 */
export type AgentEditorState =
  | {
      /** The list is shown instead of an editor. */
      readonly status: "closed"
    }
  | {
      /** A stored agent is being read so it can be edited. */
      readonly status: "opening"
      /** Code of the agent being read. */
      readonly agentCode: string
    }
  | {
      /** A stored agent could not be read. */
      readonly status: "unavailable"
      /** Code of the agent that could not be read. */
      readonly agentCode: string
      /** User-presentable reason. */
      readonly error: string
    }
  | {
      /** A new agent is being written. */
      readonly status: "creating"
      /** Text as typed. */
      readonly draft: AgentDraft
      /** Code as kept from typing; empty asks the backend to derive one. */
      readonly code: string
      /** Whether a save was attempted, so draft problems are shown. */
      readonly isSaveAttempted: boolean
      /** Save in progress or the latest save failure. */
      readonly activity: NewAgentActivity
    }
  | {
      /** A stored agent is being changed. */
      readonly status: "editing"
      /** Agent as read when the editor opened. */
      readonly agent: Agent
      /** Text as typed. */
      readonly draft: AgentDraft
      /** Whether a save was attempted, so draft problems are shown. */
      readonly isSaveAttempted: boolean
      /** Change or confirmation in progress. */
      readonly activity: StoredAgentActivity
    }

/** Observable state of agent management. */
export type AgentState = {
  /** Lifecycle of the list of every stored agent. */
  readonly list: AgentListState
  /** What the agent editor shows. */
  readonly editor: AgentEditorState
  /**
   * Code of the agent saved most recently, or null when no save happened
   * since an editor last opened.
   */
  readonly savedAgentCode: string | null
}

/**
 * Actions that change agent management or read agents from the backend.
 *
 * @remarks Asynchronous actions resolve after their outcome is committed or
 * after a newer action supersedes them; failures are recorded in state and
 * never rejected. An action that does not apply to the current editor state
 * is ignored.
 */
export type AgentActions = {
  /**
   * Reads every stored agent, replacing any pending list read; a displayed
   * list stays displayed while it is read again.
   */
  readonly loadAgents: () => Promise<void>
  /** Opens an empty editor for a new agent. */
  readonly openNewAgent: () => void
  /** Reads one stored agent and opens its editor. */
  readonly openAgent: (agentCode: string) => Promise<void>
  /** Opens an editor for a new agent holding a copy of the edited one. */
  readonly duplicateAgent: () => void
  /** Closes the editor and discards its draft. */
  readonly closeAgentEditor: () => void
  /** Replaces the edited draft. */
  readonly updateAgentDraft: (draft: AgentDraft) => void
  /**
   * Replaces the new agent's code with the code form of the typed text, as
   * calculated by `calculateAgentCodeFromText`.
   */
  readonly updateNewAgentCode: (typedCode: string) => void
  /** Asks whether to delete the edited agent. */
  readonly openAgentDeleteConfirmation: () => void
  /** Keeps the edited agent after its deletion was asked. */
  readonly closeAgentDeleteConfirmation: () => void
  /**
   * Saves the draft when it has no problem; otherwise records the attempt so
   * its first problem is shown.
   */
  readonly saveAgentDraft: () => Promise<void>
  /** Permanently deletes the edited agent once its deletion is confirmed. */
  readonly deleteAgent: () => Promise<void>
}

/** State and actions exposed by one agent store. */
export type AgentStore = AgentState & AgentActions

/** Editor states in which a draft is written. */
type DraftingAgentEditor = Extract<
  AgentEditorState,
  { readonly status: "creating" | "editing" }
>

/** Editor of a new agent. */
type NewAgentEditor = Extract<AgentEditorState, { readonly status: "creating" }>

/** Editor of a stored agent. */
type StoredAgentEditor = Extract<
  AgentEditorState,
  { readonly status: "editing" }
>

/** Store-private transport resource correlated with one read. */
type AgentReadResource = {
  /** Token authorizing this read to commit its outcome. */
  readonly token: number
  /** Controller owned exclusively by the store. */
  readonly abortController: AbortController
}

/** Settled outcome of reading one agent for the editor. */
type AgentOpenOutcome =
  | {
      /** The agent was read. */
      readonly status: "found"
      /** Agent as stored. */
      readonly agent: Agent
    }
  | {
      /** The agent is no longer stored. */
      readonly status: "missing"
    }
  | {
      /** The agent could not be read. */
      readonly status: "failed"
      /** User-presentable failure. */
      readonly error: string
    }

/** Settled outcome of saving a draft. */
type AgentSaveOutcome =
  | {
      /** The backend stored the draft. */
      readonly status: "saved"
      /** Agent as stored. */
      readonly agent: Agent
    }
  | {
      /** The backend refused it; nothing was stored. */
      readonly status: "refused"
      /** User-presentable reason. */
      readonly error: string
    }
  | {
      /** The edited agent is no longer stored. */
      readonly status: "missing"
      /** Code of that agent. */
      readonly agentCode: string
    }
  | {
      /** The save could not be confirmed. */
      readonly status: "failed"
      /** User-presentable failure. */
      readonly error: string
    }

/** Settled outcome of deleting the edited agent. */
type AgentDeletionOutcome =
  | {
      /** The agent is no longer stored. */
      readonly status: "removed"
    }
  | {
      /** The deletion could not be confirmed. */
      readonly status: "failed"
      /** User-presentable failure. */
      readonly error: string
    }

/**
 * Inclusive maximum number of agents one list read collects.
 *
 * @remarks The list is held whole in memory, so a read stops with a failure
 * instead of growing past this many agents. It bounds only the desktop's
 * read; the backend stores any number.
 */
const MAXIMUM_LISTED_AGENT_COUNT = 1000

/** Failure shown when agents are read while the backend is not running. */
const BACKEND_STOPPED_READ_MESSAGE =
  "The backend is not running, so agents cannot be read."

/** Failure shown when a change is requested while the backend is stopped. */
const BACKEND_STOPPED_MUTATION_MESSAGE =
  "The backend is not running, so the change was not made."

/** Failure shown when an agent being opened is no longer stored. */
const MISSING_AGENT_MESSAGE = "That agent no longer exists."

/** Failure shown when an agent being saved is no longer stored. */
const MISSING_EDITED_AGENT_MESSAGE =
  "That agent no longer exists. Duplicate it to keep your changes."

/** Shared closed editor; it carries no data. */
const CLOSED_AGENT_EDITOR: AgentEditorState = Object.freeze({
  status: "closed"
})

/** Shared idle activity without a failure. */
const IDLE_AGENT_ACTIVITY: NewAgentActivity = Object.freeze({
  status: "idle",
  failure: null
})

/** Shared saving activity. */
const SAVING_AGENT_ACTIVITY: NewAgentActivity = Object.freeze({
  status: "saving"
})

/** Shared confirming-delete activity. */
const CONFIRMING_DELETE_ACTIVITY: StoredAgentActivity = Object.freeze({
  status: "confirming-delete"
})

/** Shared deleting activity. */
const DELETING_AGENT_ACTIVITY: StoredAgentActivity = Object.freeze({
  status: "deleting"
})

/** Shared list before any read. */
const IDLE_AGENT_LIST: AgentListState = Object.freeze({ status: "idle" })

/** Shared list while its first read is pending. */
const LOADING_AGENT_LIST: AgentListState = Object.freeze({ status: "loading" })

/** Initial observable state used as a fresh value by independent stores. */
const INITIAL_AGENT_STATE: AgentState = Object.freeze({
  list: IDLE_AGENT_LIST,
  editor: CLOSED_AGENT_EDITOR,
  savedAgentCode: null
})

/**
 * Converts an unknown value thrown by a read into a message.
 *
 * @param error - Value thrown while reading.
 * @param fallback - Message used when the value carries none.
 * @returns A non-empty, user-presentable reason.
 */
function formatAgentReadError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Converts an unknown value thrown by a change into a message.
 *
 * @param changeLabel - Gerund naming the failed change, such as `Saving`.
 * @param error - Value thrown while making the change.
 * @returns A non-empty message naming the change and its reason.
 */
function formatAgentMutationError(changeLabel: string, error: unknown): string {
  return error instanceof Error && error.message
    ? `${changeLabel} failed: ${error.message}`
    : `${changeLabel} failed.`
}

/**
 * Builds the list row of a stored agent.
 *
 * @param agent - Agent as stored.
 * @returns A frozen summary without the system prompt.
 */
function buildAgentSummary(agent: Agent): AgentSummary {
  return Object.freeze({
    code: agent.code,
    name: agent.name,
    bio: agent.bio,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  })
}

/**
 * Builds a displayed list.
 *
 * @param agents - Every stored agent, oldest first.
 * @param isRefreshing - Whether a replacement read is pending.
 * @returns A frozen loaded list.
 */
function buildLoadedAgentList(
  agents: readonly AgentSummary[],
  isRefreshing: boolean
): AgentListState {
  return Object.freeze({ status: "loaded", agents, isRefreshing })
}

/**
 * Builds the list for a read that failed.
 *
 * @param error - User-presentable reason.
 * @returns A frozen failed list.
 */
function buildFailedAgentList(error: string): AgentListState {
  return Object.freeze({ status: "failed", error })
}

/**
 * Calculates the list while a read is pending.
 *
 * @param list - List before the read.
 * @returns The displayed agents marked as refreshing, or the loading list
 * when nothing is displayed.
 */
function calculatePendingAgentList(list: AgentListState): AgentListState {
  return list.status === "loaded"
    ? buildLoadedAgentList(list.agents, true)
    : LOADING_AGENT_LIST
}

/**
 * Calculates the list after an agent was saved.
 *
 * @param list - Current list.
 * @param agent - Agent as stored.
 * @returns The displayed list with that agent's row replaced, or appended as
 * the newest when it is not listed; any other list unchanged.
 */
function calculateListWithSavedAgent(
  list: AgentListState,
  agent: Agent
): AgentListState {
  if (list.status !== "loaded") return list

  const summary = buildAgentSummary(agent)
  const isListed = list.agents.some((listed) => listed.code === agent.code)
  const agents = isListed
    ? list.agents.map((listed) =>
        listed.code === agent.code ? summary : listed
      )
    : [...list.agents, summary]

  return buildLoadedAgentList(Object.freeze(agents), list.isRefreshing)
}

/**
 * Calculates the list after an agent was found not to be stored.
 *
 * @param list - Current list.
 * @param agentCode - Code of the agent that is no longer stored.
 * @returns The displayed list without that agent; any other list unchanged.
 */
function calculateListWithoutAgent(
  list: AgentListState,
  agentCode: string
): AgentListState {
  if (list.status !== "loaded") return list

  const agents = list.agents.filter((agent) => agent.code !== agentCode)
  return buildLoadedAgentList(Object.freeze(agents), list.isRefreshing)
}

/**
 * Builds the editor of a stored agent that was just read.
 *
 * @param agent - Agent as stored.
 * @returns A frozen editor holding the stored text, nothing pending.
 */
function buildStoredAgentEditor(agent: Agent): AgentEditorState {
  return Object.freeze({
    status: "editing",
    agent,
    draft: buildStoredAgentDraft(agent),
    isSaveAttempted: false,
    activity: IDLE_AGENT_ACTIVITY
  })
}

/**
 * Builds the editor of a new agent.
 *
 * @param draft - Text the editor starts with.
 * @returns A frozen editor with an empty code, nothing pending.
 */
function buildNewAgentEditor(draft: AgentDraft): AgentEditorState {
  return Object.freeze({
    status: "creating",
    draft,
    code: "",
    isSaveAttempted: false,
    activity: IDLE_AGENT_ACTIVITY
  })
}

/**
 * Builds the editor shown when a stored agent could not be read.
 *
 * @param agentCode - Code of that agent.
 * @param error - User-presentable reason.
 * @returns A frozen unavailable editor.
 */
function buildUnavailableAgentEditor(
  agentCode: string,
  error: string
): AgentEditorState {
  return Object.freeze({ status: "unavailable", agentCode, error })
}

/**
 * Builds the editor shown while a stored agent is read.
 *
 * @param agentCode - Code of the agent being read.
 * @returns A frozen opening editor.
 */
function buildOpeningAgentEditor(agentCode: string): AgentEditorState {
  return Object.freeze({ status: "opening", agentCode })
}

/**
 * Builds the idle activity that reports a failed change.
 *
 * @param failure - User-presentable failure.
 * @returns A frozen idle activity.
 */
function buildFailedAgentActivity(failure: string): NewAgentActivity {
  return Object.freeze({ status: "idle", failure })
}

/**
 * Builds an editor whose latest change failed.
 *
 * @param editor - Editor whose change settled.
 * @param failure - User-presentable failure.
 * @returns A frozen copy of the editor, idle and reporting the failure.
 */
function buildFailedAgentEditor(
  editor: DraftingAgentEditor,
  failure: string
): AgentEditorState {
  const activity = buildFailedAgentActivity(failure)

  return Object.freeze({ ...editor, activity })
}

/**
 * Reports whether the editor waits on a save or delete.
 *
 * @param editor - Current editor.
 * @returns Whether a change awaits the backend, so the editor stays.
 */
function isAgentMutationPending(editor: AgentEditorState): boolean {
  if (editor.status !== "creating" && editor.status !== "editing") return false

  return (
    editor.activity.status === "saving" || editor.activity.status === "deleting"
  )
}

/**
 * Reports whether the editor holds a draft that may be edited.
 *
 * @param editor - Current editor.
 * @returns Whether a draft is written and no change awaits the backend.
 */
function isDraftEditable(
  editor: AgentEditorState
): editor is DraftingAgentEditor {
  if (editor.status !== "creating" && editor.status !== "editing") return false

  return !isAgentMutationPending(editor)
}

/**
 * Builds the request that stores a draft as a new agent.
 *
 * @param editor - Editor of the new agent.
 * @returns The definition; an empty code is omitted so the backend derives
 * one from the name.
 */
function buildAgentDefinition(
  editor: NewAgentEditor
): AgentDefinitionCandidate {
  const { name, bio, systemPrompt } = editor.draft

  return Object.freeze({
    ...(editor.code === "" ? {} : { code: editor.code }),
    name,
    bio,
    systemPrompt
  })
}

/**
 * Builds the request query for one page of agents.
 *
 * @param cursor - Continuation of the previous page, or undefined for the
 * first page.
 * @returns List parameters requesting the largest page.
 */
function buildAgentPageQuery(cursor: string | undefined): ListAgentsApiQuery {
  return cursor === undefined
    ? { limit: MAXIMUM_AGENT_LIST_PAGE_SIZE }
    : { cursor, limit: MAXIMUM_AGENT_LIST_PAGE_SIZE }
}

/**
 * Validates one page against the pages read before it and appends it.
 *
 * @param listedAgents - Agents collected from earlier pages.
 * @param page - Page just read.
 * @returns A frozen list of the earlier agents followed by the page's.
 * @throws When a page that promises more is empty, when an agent repeats an
 * earlier page's, or when the agents exceed
 * {@link MAXIMUM_LISTED_AGENT_COUNT}.
 */
function parseAgentListWithPage(
  listedAgents: readonly AgentSummary[],
  page: ListAgentsApiResponse
): readonly AgentSummary[] {
  if (page.nextCursor !== null && page.agents.length === 0) {
    throw new Error("The backend returned an empty page of agents.")
  }
  const listedCodes = new Set(listedAgents.map((agent) => agent.code))
  if (page.agents.some((agent) => listedCodes.has(agent.code))) {
    throw new Error("The backend listed an agent more than once.")
  }
  if (listedAgents.length + page.agents.length > MAXIMUM_LISTED_AGENT_COUNT) {
    throw new Error(
      `Lys lists at most ${MAXIMUM_LISTED_AGENT_COUNT} agents, and more are stored.`
    )
  }

  return Object.freeze([...listedAgents, ...page.agents])
}

/**
 * Creates one independently owned agent store.
 *
 * @param dependencies - Transport and backend availability.
 * @returns A Zustand hook and store API owning one agent-management lifecycle.
 */
export function createAgentStore(
  dependencies: AgentStoreDependencies
): UseBoundStore<StoreApi<AgentStore>> {
  /** Next read token; tokens never authorize another store. */
  let nextReadToken = 1
  /** Current store-owned list read, or absent when none is owned. */
  let activeListRead: AgentReadResource | undefined
  /** Current store-owned agent read, or absent when none is owned. */
  let activeAgentRead: AgentReadResource | undefined

  /**
   * Creates a read resource with a token no earlier read used.
   *
   * @returns A fresh resource owned by the caller.
   */
  function createReadResource(): AgentReadResource {
    const resource = {
      token: nextReadToken,
      abortController: new AbortController()
    }
    nextReadToken += 1

    return resource
  }

  /**
   * Starts a list read that supersedes any owned one.
   *
   * @returns The new read's resource; the superseded read is invalidated
   * before its transport is aborted.
   */
  function startListRead(): AgentReadResource {
    const supersededRead = activeListRead
    activeListRead = createReadResource()
    supersededRead?.abortController.abort()

    return activeListRead
  }

  /**
   * Starts an agent read that supersedes any owned one.
   *
   * @returns The new read's resource; the superseded read is invalidated
   * before its transport is aborted.
   */
  function startAgentRead(): AgentReadResource {
    cancelAgentRead()
    activeAgentRead = createReadResource()

    return activeAgentRead
  }

  /** Invalidates the owned agent read, if any, aborting its transport. */
  function cancelAgentRead(): void {
    const resource = activeAgentRead
    activeAgentRead = undefined
    resource?.abortController.abort()
  }

  /**
   * Lists one page while its read remains owned.
   *
   * @param query - List parameters for the page.
   * @param backendUrl - Backend origin sampled when the read started.
   * @param resource - Resource owned by this read.
   * @returns The validated page, or undefined when the read was superseded.
   * @throws The failure of a read that is still owned.
   */
  async function listOwnedAgentPage(
    query: ListAgentsApiQuery,
    backendUrl: string,
    resource: AgentReadResource
  ): Promise<ListAgentsApiResponse | undefined> {
    try {
      const page = await dependencies.listAgents(query, {
        backendUrl,
        signal: resource.abortController.signal
      })
      return activeListRead === resource ? page : undefined
    } catch (error) {
      if (activeListRead !== resource) return undefined
      throw error
    }
  }

  /**
   * Lists every stored agent while the read remains owned.
   *
   * @param backendUrl - Backend origin sampled when the read started.
   * @param resource - Resource owned by this read.
   * @returns Every agent oldest first, or undefined when the read was
   * superseded; pages are read one after another.
   * @throws The failure of a read that is still owned, including a page
   * rejected by {@link parseAgentListWithPage}.
   */
  async function listOwnedAgents(
    backendUrl: string,
    resource: AgentReadResource
  ): Promise<readonly AgentSummary[] | undefined> {
    let listedAgents: readonly AgentSummary[] = Object.freeze([])
    let cursor: string | undefined
    do {
      const page = await listOwnedAgentPage(
        buildAgentPageQuery(cursor),
        backendUrl,
        resource
      )
      if (page === undefined) return undefined
      listedAgents = parseAgentListWithPage(listedAgents, page)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)

    return listedAgents
  }

  /**
   * Reads one agent while its read remains owned.
   *
   * @param agentCode - Code of the agent to read.
   * @param backendUrl - Backend origin sampled when the read started.
   * @param resource - Resource owned by this read.
   * @returns The outcome, or undefined when the read was superseded;
   * ownership is released before an owned outcome is returned.
   */
  async function getOwnedAgent(
    agentCode: string,
    backendUrl: string,
    resource: AgentReadResource
  ): Promise<AgentOpenOutcome | undefined> {
    try {
      const result = await dependencies.getAgent(agentCode, {
        backendUrl,
        signal: resource.abortController.signal
      })
      if (activeAgentRead !== resource) return undefined
      activeAgentRead = undefined
      return result.status === "found"
        ? { status: "found", agent: result.agent }
        : { status: "missing" }
    } catch (error) {
      if (activeAgentRead !== resource) return undefined
      activeAgentRead = undefined
      const message = formatAgentReadError(
        error,
        "The agent could not be read."
      )
      return { status: "failed", error: message }
    }
  }

  /**
   * Stores a new agent and reports the settled outcome.
   *
   * @param editor - Editor of the new agent, its draft free of problems.
   * @param backendUrl - Backend origin sampled when the save started.
   * @returns The outcome; failures are returned rather than thrown.
   */
  async function createStoredAgent(
    editor: NewAgentEditor,
    backendUrl: string
  ): Promise<AgentSaveOutcome> {
    try {
      const result = await dependencies.createAgent(
        buildAgentDefinition(editor),
        { backendUrl }
      )
      return result.status === "created"
        ? { status: "saved", agent: result.agent }
        : {
            status: "refused",
            error: `Another agent already uses the code ${editor.code}.`
          }
    } catch (error) {
      return {
        status: "failed",
        error: formatAgentMutationError("Saving", error)
      }
    }
  }

  /**
   * Changes a stored agent and reports the settled outcome.
   *
   * @param editor - Editor of the stored agent, its draft free of problems.
   * @param backendUrl - Backend origin sampled when the save started.
   * @returns The outcome; failures are returned rather than thrown.
   */
  async function updateStoredAgent(
    editor: StoredAgentEditor,
    backendUrl: string
  ): Promise<AgentSaveOutcome> {
    try {
      const result = await dependencies.updateAgent(
        { agentCode: editor.agent.code, changes: editor.draft },
        { backendUrl }
      )
      return result.status === "updated"
        ? { status: "saved", agent: result.agent }
        : { status: "missing", agentCode: editor.agent.code }
    } catch (error) {
      return {
        status: "failed",
        error: formatAgentMutationError("Saving", error)
      }
    }
  }

  /**
   * Deletes a stored agent and reports the settled outcome.
   *
   * @param agentCode - Code of the agent to delete.
   * @param backendUrl - Backend origin sampled when the deletion started.
   * @returns The outcome; failures are returned rather than thrown.
   * @remarks The missing-agent problem also establishes removal.
   */
  async function deleteStoredAgent(
    agentCode: string,
    backendUrl: string
  ): Promise<AgentDeletionOutcome> {
    try {
      await dependencies.deleteAgent(agentCode, { backendUrl })
      return { status: "removed" }
    } catch (error) {
      return {
        status: "failed",
        error: formatAgentMutationError("Deleting", error)
      }
    }
  }

  /**
   * Creates the state and actions that own this store's lifecycle.
   *
   * @param set - Zustand capability that applies observable state changes.
   * @param get - Zustand capability that reads current observable state.
   * @returns Initial agent state and its actions.
   */
  function createAgentStoreState(
    set: StoreApi<AgentStore>["setState"],
    get: StoreApi<AgentStore>["getState"]
  ): AgentStore {
    /**
     * Reads every stored agent, replacing any owned list read.
     *
     * @returns A promise that resolves after the list or failure commits, or
     * after a newer read supersedes this one.
     * @remarks A displayed list stays visible while its replacement is read.
     * A stopped backend fails the read without sending a request.
     */
    async function loadAgents(): Promise<void> {
      const resource = startListRead()
      const backend = dependencies.getBackend()
      if (!backend.isRunning) {
        activeListRead = undefined
        set({ list: buildFailedAgentList(BACKEND_STOPPED_READ_MESSAGE) })
        return
      }

      set({ list: calculatePendingAgentList(get().list) })
      try {
        const agents = await listOwnedAgents(backend.backendUrl, resource)
        if (agents === undefined) return
        activeListRead = undefined
        set({ list: buildLoadedAgentList(agents, false) })
      } catch (error) {
        activeListRead = undefined
        const message = formatAgentReadError(error, "Agents could not be read.")
        set({ list: buildFailedAgentList(message) })
      }
    }

    /**
     * Replaces a pending list read after a change to an agent settles.
     *
     * @remarks A read already sent may answer from before the change was
     * stored, and committing it would undo the change on screen. Without a
     * pending read, the settled change has already been applied to the
     * displayed list and nothing is read.
     */
    function loadAgentsAfterMutation(): void {
      if (activeListRead !== undefined) void loadAgents()
    }

    /**
     * Opens an empty editor for a new agent.
     *
     * @remarks Ignored while a save or delete is pending. Any agent read is
     * cancelled.
     */
    function openNewAgent(): void {
      if (isAgentMutationPending(get().editor)) return

      cancelAgentRead()
      set({
        editor: buildNewAgentEditor(EMPTY_AGENT_DRAFT),
        savedAgentCode: null
      })
    }

    /**
     * Reads one stored agent and opens its editor.
     *
     * @param agentCode - Code of a listed agent.
     * @returns A promise that resolves after the editor or failure commits,
     * or after a newer editor action supersedes the read.
     * @remarks Ignored while a save or delete is pending. An agent that is no
     * longer stored is removed from the list.
     */
    async function openAgent(agentCode: string): Promise<void> {
      if (isAgentMutationPending(get().editor)) return

      const resource = startAgentRead()
      set({ editor: buildOpeningAgentEditor(agentCode), savedAgentCode: null })
      const backend = dependencies.getBackend()
      if (!backend.isRunning) {
        activeAgentRead = undefined
        const editor = buildUnavailableAgentEditor(
          agentCode,
          BACKEND_STOPPED_READ_MESSAGE
        )
        set({ editor })
        return
      }

      const outcome = await getOwnedAgent(
        agentCode,
        backend.backendUrl,
        resource
      )
      if (outcome === undefined) return
      updateAgentEditorAfterOpen(agentCode, outcome)
    }

    /**
     * Updates the editor with the outcome of reading its agent.
     *
     * @param agentCode - Code of the agent that was read.
     * @param outcome - Owned outcome of the read; an agent no longer stored
     * is also removed from the list.
     */
    function updateAgentEditorAfterOpen(
      agentCode: string,
      outcome: AgentOpenOutcome
    ): void {
      switch (outcome.status) {
        case "found":
          set({ editor: buildStoredAgentEditor(outcome.agent) })
          return
        case "missing": {
          const editor = buildUnavailableAgentEditor(
            agentCode,
            MISSING_AGENT_MESSAGE
          )
          const list = calculateListWithoutAgent(get().list, agentCode)
          set({ editor, list })
          return
        }
        case "failed":
          set({ editor: buildUnavailableAgentEditor(agentCode, outcome.error) })
          return
      }
    }

    /**
     * Opens an editor for a new agent holding a copy of the edited one.
     *
     * @remarks Applies only to an idle stored-agent editor. The copy's name
     * is one no listed agent uses, and its code is empty.
     */
    function duplicateAgent(): void {
      const { editor, list } = get()
      if (editor.status !== "editing" || editor.activity.status !== "idle") {
        return
      }

      const listedAgents = list.status === "loaded" ? list.agents : []
      const draft: AgentDraft = Object.freeze({
        name: calculateDuplicateAgentName(editor.draft.name, listedAgents),
        bio: editor.draft.bio,
        systemPrompt: editor.draft.systemPrompt
      })
      set({ editor: buildNewAgentEditor(draft), savedAgentCode: null })
    }

    /**
     * Closes the editor and discards its draft.
     *
     * @remarks Ignored while a save or delete is pending. Any agent read is
     * cancelled.
     */
    function closeAgentEditor(): void {
      if (isAgentMutationPending(get().editor)) return

      cancelAgentRead()
      set({ editor: CLOSED_AGENT_EDITOR })
    }

    /**
     * Replaces the edited draft.
     *
     * @param draft - Text as typed.
     * @remarks Ignored unless a draft is being written and no change awaits
     * the backend.
     */
    function updateAgentDraft(draft: AgentDraft): void {
      const { editor } = get()
      if (!isDraftEditable(editor)) return

      const draftedEditor: AgentEditorState = Object.freeze({
        ...editor,
        draft
      })
      set({ editor: draftedEditor })
    }

    /**
     * Replaces the new agent's code with the code form of the typed text.
     *
     * @param typedCode - Text typed or pasted into the code field.
     * @remarks Ignored unless a new agent is being written and its save is
     * not pending.
     */
    function updateNewAgentCode(typedCode: string): void {
      const { editor } = get()
      if (editor.status !== "creating" || !isDraftEditable(editor)) return

      const code = calculateAgentCodeFromText(typedCode)
      const codedEditor: AgentEditorState = Object.freeze({ ...editor, code })
      set({ editor: codedEditor })
    }

    /**
     * Asks whether to delete the edited agent.
     *
     * @remarks Applies only to an idle stored-agent editor; a reported
     * failure is cleared.
     */
    function openAgentDeleteConfirmation(): void {
      const { editor } = get()
      if (editor.status !== "editing" || editor.activity.status !== "idle") {
        return
      }

      const activity = CONFIRMING_DELETE_ACTIVITY
      const confirmingEditor: AgentEditorState = Object.freeze({
        ...editor,
        activity
      })
      set({ editor: confirmingEditor })
    }

    /** Keeps the edited agent after its deletion was asked. */
    function closeAgentDeleteConfirmation(): void {
      const { editor } = get()
      if (
        editor.status !== "editing" ||
        editor.activity.status !== "confirming-delete"
      ) {
        return
      }

      const activity = IDLE_AGENT_ACTIVITY
      const keptEditor: AgentEditorState = Object.freeze({
        ...editor,
        activity
      })
      set({ editor: keptEditor })
    }

    /**
     * Records a save attempt, and reports whether the draft may be sent.
     *
     * @param editor - Idle editor whose draft is being saved.
     * @param agents - Every listed agent.
     * @returns The backend origin when the draft has no problem and the
     * backend runs, with the editor then saving; otherwise undefined, with
     * the attempt or the stopped backend recorded.
     */
    function startAgentSave(
      editor: DraftingAgentEditor,
      agents: readonly AgentSummary[]
    ): string | undefined {
      const subject: AgentDraftSubject =
        editor.status === "creating"
          ? { kind: "new", code: editor.code }
          : { kind: "stored", code: editor.agent.code }
      if (findAgentDraftProblem(editor.draft, subject, agents) !== undefined) {
        const attemptedEditor: AgentEditorState = Object.freeze({
          ...editor,
          isSaveAttempted: true
        })
        set({ editor: attemptedEditor })
        return undefined
      }
      const backend = dependencies.getBackend()
      const activity = backend.isRunning
        ? SAVING_AGENT_ACTIVITY
        : buildFailedAgentActivity(BACKEND_STOPPED_MUTATION_MESSAGE)
      const savingEditor: AgentEditorState = Object.freeze({
        ...editor,
        isSaveAttempted: true,
        activity
      })
      set({ editor: savingEditor })

      return backend.isRunning ? backend.backendUrl : undefined
    }

    /**
     * Updates the editor and the list with the outcome of a save.
     *
     * @param outcome - Settled outcome of the save.
     * @remarks A saved agent closes the editor, updates or appends its row,
     * and becomes the saved agent; a pending list read is replaced. An agent
     * found missing is removed from the list while its draft stays. Any
     * other outcome keeps the draft and reports the failure.
     */
    function updateAgentsAfterSave(outcome: AgentSaveOutcome): void {
      const { editor, list } = get()
      if (editor.status !== "creating" && editor.status !== "editing") return

      switch (outcome.status) {
        case "saved":
          set({
            editor: CLOSED_AGENT_EDITOR,
            list: calculateListWithSavedAgent(list, outcome.agent),
            savedAgentCode: outcome.agent.code
          })
          loadAgentsAfterMutation()
          return
        case "missing":
          set({
            editor: buildFailedAgentEditor(
              editor,
              MISSING_EDITED_AGENT_MESSAGE
            ),
            list: calculateListWithoutAgent(list, outcome.agentCode)
          })
          return
        case "refused":
        case "failed":
          set({ editor: buildFailedAgentEditor(editor, outcome.error) })
          return
      }
    }

    /**
     * Saves the draft when it has no problem.
     *
     * @returns A promise that resolves after the outcome commits.
     * @remarks Applies only to an idle editor while the list is displayed,
     * since names are checked against it. A draft with a problem is not sent;
     * the attempt is recorded so the problem is shown. A stopped backend
     * reports a failure without sending a request.
     */
    async function saveAgentDraft(): Promise<void> {
      const { editor, list } = get()
      if (list.status !== "loaded" || !isDraftEditable(editor)) return
      if (editor.activity.status !== "idle") return

      const backendUrl = startAgentSave(editor, list.agents)
      if (backendUrl === undefined) return

      const outcome =
        editor.status === "creating"
          ? await createStoredAgent(editor, backendUrl)
          : await updateStoredAgent(editor, backendUrl)
      updateAgentsAfterSave(outcome)
    }

    /**
     * Permanently deletes the edited agent once its deletion is confirmed.
     *
     * @returns A promise that resolves after the outcome commits.
     * @remarks Once the agent is no longer stored, the editor closes, its row
     * is removed, and a pending list read is replaced; a failure keeps the
     * editor and reports it. A stopped backend reports a failure without
     * sending a request.
     */
    async function deleteAgent(): Promise<void> {
      const { editor } = get()
      if (
        editor.status !== "editing" ||
        editor.activity.status !== "confirming-delete"
      ) {
        return
      }
      const backend = dependencies.getBackend()
      if (!backend.isRunning) {
        set({
          editor: buildFailedAgentEditor(
            editor,
            BACKEND_STOPPED_MUTATION_MESSAGE
          )
        })
        return
      }

      const activity = DELETING_AGENT_ACTIVITY
      const deletingEditor: AgentEditorState = Object.freeze({
        ...editor,
        activity
      })
      set({ editor: deletingEditor })
      const agentCode = editor.agent.code
      const outcome = await deleteStoredAgent(agentCode, backend.backendUrl)
      updateAgentsAfterDeletion(agentCode, outcome)
    }

    /**
     * Updates the editor and the list with the outcome of a deletion.
     *
     * @param agentCode - Code of the agent that was deleted.
     * @param outcome - Settled outcome of the deletion.
     */
    function updateAgentsAfterDeletion(
      agentCode: string,
      outcome: AgentDeletionOutcome
    ): void {
      const { editor, list } = get()
      if (editor.status !== "editing") return

      if (outcome.status === "failed") {
        set({ editor: buildFailedAgentEditor(editor, outcome.error) })
        return
      }
      set({
        editor: CLOSED_AGENT_EDITOR,
        list: calculateListWithoutAgent(list, agentCode)
      })
      loadAgentsAfterMutation()
    }

    return {
      ...INITIAL_AGENT_STATE,
      loadAgents,
      openNewAgent,
      openAgent,
      duplicateAgent,
      closeAgentEditor,
      updateAgentDraft,
      updateNewAgentCode,
      openAgentDeleteConfirmation,
      closeAgentDeleteConfirmation,
      saveAgentDraft,
      deleteAgent
    }
  }

  return create<AgentStore>(createAgentStoreState)
}

/**
 * Samples the backend origin and availability from the application store.
 *
 * @returns The current origin and whether the backend process is running.
 */
function getApplicationBackend(): AgentBackend {
  const { backendUrl, backendServerInfo } = useLysStore.getState()

  return { backendUrl, isRunning: backendServerInfo.status === "running" }
}

/**
 * Agent store used by the desktop React tree.
 *
 * @remarks This singleton manages agents through the backend named by the
 * application store. Tests or alternate compositions should call
 * {@link createAgentStore} to obtain a separate owner.
 */
export const useAgentStore: UseBoundStore<StoreApi<AgentStore>> =
  createAgentStore({
    listAgents: agentApi.listAgents,
    getAgent: agentApi.getAgent,
    createAgent: agentApi.createAgent,
    updateAgent: agentApi.updateAgent,
    deleteAgent: agentApi.deleteAgent,
    getBackend: getApplicationBackend
  })
