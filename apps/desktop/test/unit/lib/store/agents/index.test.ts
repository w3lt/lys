import type { Agent } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute,
  type BackendRoutes
} from "../../../support/backendFake"
import {
  buildAgent,
  buildAgentCodeTakenProblem,
  buildAgentListPage,
  buildAgentNotFoundProblem,
  buildAgentSummary
} from "../../../support/agentFixtures"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../../support/settlement"

/** Backend origin the application store reports; it differs from the default. */
const BACKEND_URL = "http://backend.test:4100"

/** Stored agents, oldest first. */
const RESEARCHER = buildAgent("researcher", { name: "Researcher" })
const WRITER = buildAgent("writer", { name: "Writer" })

/** Route key of the agent list. */
const LIST_ROUTE = "GET /api/v1/agents"

/**
 * Imports a fresh agent store and the application store it reads the
 * backend from, so no state or pending work of another case reaches this
 * one.
 *
 * @param isBackendRunning - Whether the application store reports a running
 * backend; its origin is always {@link BACKEND_URL}.
 * @returns The fresh agent store hook.
 */
async function importFreshAgentStore(isBackendRunning = true) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useAgentStore } = await import("@/lib/store/agents")
  useLysStore.setState({
    backendUrl: BACKEND_URL,
    backendServerInfo: { status: isBackendRunning ? "running" : "stopped" }
  })
  return useAgentStore
}

/**
 * Builds a route listing the given agents on one final page.
 *
 * @param agents - Stored agents, oldest first.
 * @returns The route.
 */
function answerAgentList(agents: readonly Agent[]): BackendRoute {
  return () => buildJsonResponse(200, buildAgentListPage(agents))
}

/**
 * Imports a fresh agent store whose list shows the given agents.
 *
 * @param agents - Stored agents, oldest first.
 * @param routes - Routes the case needs after the list is read.
 * @returns The store hook and the backend observation handle.
 */
async function importLoadedAgentStore(
  agents: readonly Agent[],
  routes: BackendRoutes = {}
) {
  const backend = startBackendFake({
    [LIST_ROUTE]: answerAgentList(agents),
    ...routes
  })
  const useAgentStore = await importFreshAgentStore()
  await useAgentStore.getState().loadAgents()
  return { useAgentStore, backend }
}

/**
 * Lists the route keys of the requests a backend received, in order.
 *
 * @param backend - Backend observation handle.
 * @returns `<METHOD> <path>` of each request.
 */
function listRouteKeys(backend: ReturnType<typeof startBackendFake>) {
  return backend.requests.map(
    (request) => `${request.method} ${new URL(request.url).pathname}`
  )
}

describe("useAgentStore", () => {
  it("starts with no list and a closed editor", async () => {
    const useAgentStore = await importFreshAgentStore()

    expect(useAgentStore.getState()).toMatchObject({
      list: { status: "idle" },
      editor: { status: "closed" },
      savedAgentCode: null
    })
  })

  describe("loadAgents", () => {
    it("reads every page at the largest page size and lists the agents oldest first", async () => {
      const backend = startBackendFake({
        [LIST_ROUTE]: (request) =>
          new URL(request.url).searchParams.get("cursor") === "page-2"
            ? buildJsonResponse(200, buildAgentListPage([WRITER]))
            : buildJsonResponse(
                200,
                buildAgentListPage([RESEARCHER], {
                  storedCount: 2,
                  nextCursor: "page-2"
                })
              )
      })
      const useAgentStore = await importFreshAgentStore()

      await useAgentStore.getState().loadAgents()

      expect(useAgentStore.getState().list).toEqual({
        status: "loaded",
        agents: [buildAgentSummary(RESEARCHER), buildAgentSummary(WRITER)],
        isRefreshing: false
      })
      expect(
        backend.requests.map((request) => new URL(request.url).search)
      ).toEqual(["?limit=50", "?cursor=page-2&limit=50"])
      expect(new URL(backend.requests[0]?.url ?? "").origin).toBe(BACKEND_URL)
    })

    it("shows loading on the first read and keeps a displayed list while reading it again", async () => {
      const reread = createControlledPromise<Response>()
      let reads = 0
      startBackendFake({
        [LIST_ROUTE]: () => {
          reads += 1
          return reads === 1
            ? buildJsonResponse(200, buildAgentListPage([RESEARCHER]))
            : reread.promise
        }
      })
      const useAgentStore = await importFreshAgentStore()
      const firstRead = useAgentStore.getState().loadAgents()
      const whileFirstRead = useAgentStore.getState().list
      await firstRead

      const secondRead = useAgentStore.getState().loadAgents()
      const whileSecondRead = useAgentStore.getState().list
      reread.resolve(buildJsonResponse(200, buildAgentListPage([RESEARCHER])))
      await secondRead

      expect(whileFirstRead).toEqual({ status: "loading" })
      expect(whileSecondRead).toEqual({
        status: "loaded",
        agents: [buildAgentSummary(RESEARCHER)],
        isRefreshing: true
      })
    })

    it("fails without a request while the backend is stopped", async () => {
      const backend = startBackendFake({})
      const useAgentStore = await importFreshAgentStore(false)

      await useAgentStore.getState().loadAgents()

      expect(useAgentStore.getState().list).toEqual({
        status: "failed",
        error: "The backend is not running, so agents cannot be read."
      })
      expect(backend.requests).toEqual([])
    })

    it("shows why the list could not be read", async () => {
      startBackendFake({ [LIST_ROUTE]: () => buildJsonResponse(500, {}) })
      const useAgentStore = await importFreshAgentStore()

      await useAgentStore.getState().loadAgents()

      expect(useAgentStore.getState().list).toMatchObject({
        status: "failed",
        error: expect.stringContaining("500")
      })
    })

    it.each([
      [
        "an empty page that promises more",
        [
          buildAgentListPage([], { storedCount: 1, nextCursor: "page-2" }),
          buildAgentListPage([RESEARCHER])
        ]
      ],
      [
        "an agent repeated on a later page",
        [
          buildAgentListPage([RESEARCHER], {
            storedCount: 2,
            nextCursor: "page-2"
          }),
          buildAgentListPage([RESEARCHER], { storedCount: 2 })
        ]
      ]
    ])("fails on %s", async (_label, pages) => {
      let pageIndex = 0
      startBackendFake({
        [LIST_ROUTE]: () => buildJsonResponse(200, pages[pageIndex++])
      })
      const useAgentStore = await importFreshAgentStore()

      await useAgentStore.getState().loadAgents()

      expect(useAgentStore.getState().list.status).toBe("failed")
    })

    it("fails instead of holding more than 1,000 agents", async () => {
      const agents = Array.from({ length: 1001 }, (_, index) =>
        buildAgent(`agent-${index}`)
      )
      startBackendFake({
        [LIST_ROUTE]: (request) => {
          const start = Number(
            new URL(request.url).searchParams.get("cursor") ?? 0
          )
          const end = start + 50
          return buildJsonResponse(
            200,
            buildAgentListPage(agents.slice(start, end), {
              storedCount: agents.length,
              nextCursor: end < agents.length ? String(end) : null
            })
          )
        }
      })
      const useAgentStore = await importFreshAgentStore()

      await useAgentStore.getState().loadAgents()

      expect(useAgentStore.getState().list).toMatchObject({
        status: "failed",
        error: expect.stringContaining("1000")
      })
    })

    it("commits only the newest of overlapping reads and aborts the older one", async () => {
      const olderRead = createControlledPromise<Response>()
      let reads = 0
      const backend = startBackendFake({
        [LIST_ROUTE]: () => {
          reads += 1
          return reads === 1
            ? olderRead.promise
            : buildJsonResponse(200, buildAgentListPage([WRITER]))
        }
      })
      const useAgentStore = await importFreshAgentStore()
      const older = useAgentStore.getState().loadAgents()

      await useAgentStore.getState().loadAgents()
      olderRead.resolve(
        buildJsonResponse(200, buildAgentListPage([RESEARCHER]))
      )
      await older

      expect(useAgentStore.getState().list).toMatchObject({
        agents: [buildAgentSummary(WRITER)]
      })
      expect(backend.requests[0]?.signal?.aborted).toBe(true)
    })
  })

  describe("openAgent", () => {
    it("shows the agent being read, then its editor holding the stored text", async () => {
      const { useAgentStore } = await importLoadedAgentStore([RESEARCHER], {
        "GET /api/v1/agents/researcher": () =>
          buildJsonResponse(200, RESEARCHER)
      })

      const open = useAgentStore.getState().openAgent("researcher")
      const whileOpening = useAgentStore.getState().editor
      await open

      expect(whileOpening).toEqual({
        status: "opening",
        agentCode: "researcher"
      })
      expect(useAgentStore.getState().editor).toEqual({
        status: "editing",
        agent: RESEARCHER,
        draft: {
          name: RESEARCHER.name,
          bio: RESEARCHER.bio,
          systemPrompt: RESEARCHER.systemPrompt
        },
        saveAttemptCount: 0,
        activity: { status: "idle", failure: null }
      })
    })

    it("reports an agent that no longer exists and removes its row", async () => {
      const { useAgentStore } = await importLoadedAgentStore(
        [RESEARCHER, WRITER],
        {
          "GET /api/v1/agents/researcher": () =>
            buildJsonResponse(404, buildAgentNotFoundProblem())
        }
      )

      await useAgentStore.getState().openAgent("researcher")

      expect(useAgentStore.getState()).toMatchObject({
        editor: {
          status: "unavailable",
          agentCode: "researcher",
          error: "That agent no longer exists."
        },
        list: { agents: [buildAgentSummary(WRITER)] }
      })
    })

    it("reports why the agent could not be read", async () => {
      const { useAgentStore } = await importLoadedAgentStore([RESEARCHER], {
        "GET /api/v1/agents/researcher": () => buildJsonResponse(500, {})
      })

      await useAgentStore.getState().openAgent("researcher")

      expect(useAgentStore.getState().editor).toMatchObject({
        status: "unavailable",
        error: expect.stringContaining("500")
      })
    })

    it("reports a stopped backend without a request", async () => {
      const backend = startBackendFake({})
      const useAgentStore = await importFreshAgentStore(false)

      await useAgentStore.getState().openAgent("researcher")

      expect(useAgentStore.getState().editor).toEqual({
        status: "unavailable",
        agentCode: "researcher",
        error: "The backend is not running, so agents cannot be read."
      })
      expect(backend.requests).toEqual([])
    })

    it("abandons a read when the editor is closed before it answers", async () => {
      const read = createControlledPromise<Response>()
      const { useAgentStore, backend } = await importLoadedAgentStore(
        [RESEARCHER],
        { "GET /api/v1/agents/researcher": () => read.promise }
      )
      const open = useAgentStore.getState().openAgent("researcher")
      await waitForMicrotasks()

      useAgentStore.getState().closeAgentEditor()
      read.resolve(buildJsonResponse(200, RESEARCHER))
      await open

      expect(useAgentStore.getState().editor).toEqual({ status: "closed" })
      expect(backend.requests.at(-1)?.signal?.aborted).toBe(true)
    })

    it("lets a newer open replace a pending one", async () => {
      const olderRead = createControlledPromise<Response>()
      const { useAgentStore } = await importLoadedAgentStore(
        [RESEARCHER, WRITER],
        {
          "GET /api/v1/agents/researcher": () => olderRead.promise,
          "GET /api/v1/agents/writer": () => buildJsonResponse(200, WRITER)
        }
      )
      const older = useAgentStore.getState().openAgent("researcher")

      await useAgentStore.getState().openAgent("writer")
      olderRead.resolve(buildJsonResponse(200, RESEARCHER))
      await older

      expect(useAgentStore.getState().editor).toMatchObject({
        status: "editing",
        agent: WRITER
      })
    })
  })

  describe("openNewAgent and openAgentCopy", () => {
    it("opens an empty editor for a new agent", async () => {
      const useAgentStore = await importFreshAgentStore()

      useAgentStore.getState().openNewAgent()

      expect(useAgentStore.getState().editor).toEqual({
        status: "creating",
        draft: { name: "", bio: "", systemPrompt: "" },
        code: "",
        saveAttemptCount: 0,
        activity: { status: "idle", failure: null }
      })
    })

    it("copies the edited agent into a new agent under a free name and an empty code", async () => {
      const { useAgentStore } = await importLoadedAgentStore(
        [RESEARCHER, buildAgent("copy", { name: "Researcher copy" })],
        {
          "GET /api/v1/agents/researcher": () =>
            buildJsonResponse(200, RESEARCHER)
        }
      )
      await useAgentStore.getState().openAgent("researcher")

      useAgentStore.getState().openAgentCopy()

      expect(useAgentStore.getState().editor).toEqual({
        status: "creating",
        draft: {
          name: "Researcher copy 2",
          bio: RESEARCHER.bio,
          systemPrompt: RESEARCHER.systemPrompt
        },
        code: "",
        saveAttemptCount: 0,
        activity: { status: "idle", failure: null }
      })
    })

    it("ignores a copy request without a stored agent being edited", async () => {
      const useAgentStore = await importFreshAgentStore()
      useAgentStore.getState().openNewAgent()
      const before = useAgentStore.getState().editor

      useAgentStore.getState().openAgentCopy()

      expect(useAgentStore.getState().editor).toBe(before)
    })
  })

  describe("draft edits", () => {
    it("replaces the draft being written", async () => {
      const useAgentStore = await importFreshAgentStore()
      useAgentStore.getState().openNewAgent()
      const draft = { name: "Scout", bio: "", systemPrompt: "" }

      useAgentStore.getState().updateAgentDraft(draft)

      expect(useAgentStore.getState().editor).toMatchObject({ draft })
    })

    it("ignores a draft while no editor is open", async () => {
      const useAgentStore = await importFreshAgentStore()

      useAgentStore
        .getState()
        .updateAgentDraft({ name: "Scout", bio: "", systemPrompt: "" })

      expect(useAgentStore.getState().editor).toEqual({ status: "closed" })
    })

    it("keeps the code form of what is typed for a new agent", async () => {
      const useAgentStore = await importFreshAgentStore()
      useAgentStore.getState().openNewAgent()

      useAgentStore.getState().updateNewAgentCode("Web Scout!")

      expect(useAgentStore.getState().editor).toMatchObject({
        code: "web-scout-"
      })
    })

    it("ignores a code for a stored agent, whose code never changes", async () => {
      const { useAgentStore } = await importLoadedAgentStore([RESEARCHER], {
        "GET /api/v1/agents/researcher": () =>
          buildJsonResponse(200, RESEARCHER)
      })
      await useAgentStore.getState().openAgent("researcher")
      const before = useAgentStore.getState().editor

      useAgentStore.getState().updateNewAgentCode("other")

      expect(useAgentStore.getState().editor).toBe(before)
    })
  })
})

/** Draft every check accepts for a new agent. */
const SCOUT_DRAFT = Object.freeze({
  name: "Scout",
  bio: "Finds things.",
  systemPrompt: "You find things."
})

/** Agent the backend stores for {@link SCOUT_DRAFT}. */
const SCOUT = buildAgent("scout", SCOUT_DRAFT)

/**
 * Imports a store whose list shows the given agents and whose editor holds
 * {@link SCOUT_DRAFT} for a new agent.
 *
 * @param agents - Listed agents.
 * @param routes - Routes the save needs.
 * @returns The store hook and the backend observation handle.
 */
async function importNewAgentEditor(
  agents: readonly Agent[],
  routes: BackendRoutes
) {
  const loaded = await importLoadedAgentStore(agents, routes)
  loaded.useAgentStore.getState().openNewAgent()
  loaded.useAgentStore.getState().updateAgentDraft(SCOUT_DRAFT)
  return loaded
}

/**
 * Imports a store whose list shows {@link RESEARCHER} and {@link WRITER} and
 * whose editor holds the researcher as stored.
 *
 * @param routes - Routes the change needs.
 * @returns The store hook and the backend observation handle.
 */
async function importResearcherEditor(routes: BackendRoutes) {
  const loaded = await importLoadedAgentStore([RESEARCHER, WRITER], {
    "GET /api/v1/agents/researcher": () => buildJsonResponse(200, RESEARCHER),
    ...routes
  })
  await loaded.useAgentStore.getState().openAgent("researcher")
  return loaded
}

describe("useAgentStore saves", () => {
  it("stores a new agent, closes the editor, lists it last, and marks it saved", async () => {
    const { useAgentStore, backend } = await importNewAgentEditor(
      [RESEARCHER],
      {
        "POST /api/v1/agents": () => buildJsonResponse(201, SCOUT)
      }
    )

    await useAgentStore.getState().saveAgentDraft()

    expect(backend.requests.at(-1)?.body).toEqual(SCOUT_DRAFT)
    expect(useAgentStore.getState()).toMatchObject({
      editor: { status: "closed" },
      list: {
        agents: [buildAgentSummary(RESEARCHER), buildAgentSummary(SCOUT)]
      },
      savedAgentCode: "scout"
    })
  })

  it("sends the typed code with a new agent", async () => {
    const { useAgentStore, backend } = await importNewAgentEditor([], {
      "POST /api/v1/agents": () => buildJsonResponse(201, SCOUT)
    })
    useAgentStore.getState().updateNewAgentCode("scout")

    await useAgentStore.getState().saveAgentDraft()

    expect(backend.requests.at(-1)?.body).toEqual({
      code: "scout",
      ...SCOUT_DRAFT
    })
  })

  it("does not send a draft with a problem and counts the attempt so the problem shows", async () => {
    const { useAgentStore, backend } = await importNewAgentEditor(
      [RESEARCHER],
      {}
    )
    useAgentStore
      .getState()
      .updateAgentDraft({ ...SCOUT_DRAFT, name: "Researcher" })

    await useAgentStore.getState().saveAgentDraft()

    expect(useAgentStore.getState().editor).toMatchObject({
      status: "creating",
      saveAttemptCount: 1,
      activity: { status: "idle", failure: null }
    })
    expect(listRouteKeys(backend)).toEqual([LIST_ROUTE])
  })

  it("reports a taken code and keeps the draft", async () => {
    const { useAgentStore } = await importNewAgentEditor([], {
      "POST /api/v1/agents": () =>
        buildJsonResponse(409, buildAgentCodeTakenProblem())
    })
    useAgentStore.getState().updateNewAgentCode("scout")

    await useAgentStore.getState().saveAgentDraft()

    expect(useAgentStore.getState().editor).toMatchObject({
      status: "creating",
      draft: SCOUT_DRAFT,
      activity: {
        status: "idle",
        failure: "Another agent already uses the code scout."
      }
    })
  })

  it("reports an unconfirmed creation and reads the list again in case it was stored", async () => {
    let reads = 0
    const { useAgentStore } = await importNewAgentEditor([], {
      [LIST_ROUTE]: () => {
        reads += 1
        return buildJsonResponse(
          200,
          buildAgentListPage(reads === 1 ? [] : [SCOUT])
        )
      },
      "POST /api/v1/agents": () => Promise.reject(new TypeError("fetch failed"))
    })

    await useAgentStore.getState().saveAgentDraft()
    await waitForMicrotasks()

    expect(useAgentStore.getState()).toMatchObject({
      editor: {
        status: "creating",
        activity: {
          failure: expect.stringMatching(/^Saving could not be confirmed: /)
        }
      },
      list: { agents: [buildAgentSummary(SCOUT)] }
    })
  })

  it("changes a stored agent with the draft and replaces its row", async () => {
    const renamed = buildAgent("researcher", { name: "Scout" })
    const { useAgentStore, backend } = await importResearcherEditor({
      "PATCH /api/v1/agents/researcher": () => buildJsonResponse(200, renamed)
    })
    const draft = {
      name: "Scout",
      bio: RESEARCHER.bio,
      systemPrompt: RESEARCHER.systemPrompt
    }
    useAgentStore.getState().updateAgentDraft(draft)

    await useAgentStore.getState().saveAgentDraft()

    expect(backend.requests.at(-1)?.body).toEqual(draft)
    expect(useAgentStore.getState()).toMatchObject({
      editor: { status: "closed" },
      list: { agents: [buildAgentSummary(renamed), buildAgentSummary(WRITER)] },
      savedAgentCode: "researcher"
    })
  })

  it("keeps the draft of an agent that no longer exists and removes its row", async () => {
    const { useAgentStore } = await importResearcherEditor({
      "PATCH /api/v1/agents/researcher": () =>
        buildJsonResponse(404, buildAgentNotFoundProblem())
    })

    await useAgentStore.getState().saveAgentDraft()

    expect(useAgentStore.getState()).toMatchObject({
      editor: {
        status: "editing",
        activity: {
          failure:
            "That agent no longer exists. Duplicate it to keep your changes."
        }
      },
      list: { agents: [buildAgentSummary(WRITER)] }
    })
  })

  it("reports a failed change and keeps the draft", async () => {
    const { useAgentStore } = await importResearcherEditor({
      "PATCH /api/v1/agents/researcher": () => buildJsonResponse(500, {})
    })

    await useAgentStore.getState().saveAgentDraft()

    expect(useAgentStore.getState().editor).toMatchObject({
      status: "editing",
      activity: {
        status: "idle",
        failure: expect.stringMatching(/^Saving failed: .*500/)
      }
    })
  })

  it("reports a stopped backend without a request and counts the attempt", async () => {
    const { useAgentStore, backend } = await importNewAgentEditor([], {})
    const { useLysStore } = await import("@/lib/store")
    useLysStore.setState({ backendServerInfo: { status: "stopped" } })

    await useAgentStore.getState().saveAgentDraft()

    expect(useAgentStore.getState().editor).toMatchObject({
      saveAttemptCount: 1,
      activity: {
        status: "idle",
        failure: "The backend is not running, so the change was not made."
      }
    })
    expect(listRouteKeys(backend)).toEqual([LIST_ROUTE])
  })

  it("does not save while the list is being read again", async () => {
    const reread = createControlledPromise<Response>()
    let reads = 0
    const { useAgentStore, backend } = await importNewAgentEditor([], {
      [LIST_ROUTE]: () => {
        reads += 1
        return reads === 1
          ? buildJsonResponse(200, buildAgentListPage([]))
          : reread.promise
      }
    })
    const listRead = useAgentStore.getState().loadAgents()

    await useAgentStore.getState().saveAgentDraft()
    reread.resolve(buildJsonResponse(200, buildAgentListPage([])))
    await listRead

    expect(listRouteKeys(backend)).toEqual([LIST_ROUTE, LIST_ROUTE])
    expect(useAgentStore.getState().editor).toMatchObject({
      saveAttemptCount: 0
    })
  })

  it("keeps the editor open and unchanged while a save is pending", async () => {
    const creation = createControlledPromise<Response>()
    const { useAgentStore } = await importNewAgentEditor([], {
      "POST /api/v1/agents": () => creation.promise
    })
    const save = useAgentStore.getState().saveAgentDraft()
    const whileSaving = useAgentStore.getState().editor

    useAgentStore.getState().closeAgentEditor()
    useAgentStore.getState().openNewAgent()
    useAgentStore.getState().updateAgentDraft({ ...SCOUT_DRAFT, name: "Other" })
    const afterIgnoredActions = useAgentStore.getState().editor
    creation.resolve(buildJsonResponse(201, SCOUT))
    await save

    expect(whileSaving).toMatchObject({ activity: { status: "saving" } })
    expect(afterIgnoredActions).toBe(whileSaving)
  })

  it("replaces a list read pending when a save settles, so the old answer cannot undo the save", async () => {
    const staleRead = createControlledPromise<Response>()
    let reads = 0
    const { useAgentStore, backend } = await importNewAgentEditor([], {
      [LIST_ROUTE]: () => {
        reads += 1
        if (reads === 2) return staleRead.promise
        return buildJsonResponse(
          200,
          buildAgentListPage(reads === 1 ? [] : [SCOUT])
        )
      },
      "POST /api/v1/agents": () => buildJsonResponse(201, SCOUT)
    })
    const save = useAgentStore.getState().saveAgentDraft()
    const pendingRead = useAgentStore.getState().loadAgents()

    await save
    staleRead.resolve(buildJsonResponse(200, buildAgentListPage([])))
    await pendingRead
    await waitForMicrotasks()

    const listReads = backend.requests.filter(
      (request) => request.method === "GET"
    )
    expect(listReads[1]?.signal?.aborted).toBe(true)
    expect(useAgentStore.getState().list).toMatchObject({
      agents: [buildAgentSummary(SCOUT)],
      isRefreshing: false
    })
  })
})

describe("useAgentStore deletions", () => {
  it("asks for confirmation before deleting", async () => {
    const { useAgentStore, backend } = await importResearcherEditor({})

    await useAgentStore.getState().deleteAgent()
    useAgentStore.getState().openAgentDeleteConfirmation()

    expect(listRouteKeys(backend)).not.toContain(
      "DELETE /api/v1/agents/researcher"
    )
    expect(useAgentStore.getState().editor).toMatchObject({
      activity: { status: "confirming-delete" }
    })
  })

  it("keeps the agent when the confirmation is closed", async () => {
    const { useAgentStore } = await importResearcherEditor({})
    useAgentStore.getState().openAgentDeleteConfirmation()

    useAgentStore.getState().closeAgentDeleteConfirmation()

    expect(useAgentStore.getState().editor).toMatchObject({
      status: "editing",
      activity: { status: "idle", failure: null }
    })
  })

  it.each([
    ["the backend deletes it", () => new Response(null, { status: 204 })],
    [
      "it was already gone",
      () => buildJsonResponse(404, buildAgentNotFoundProblem())
    ]
  ])("closes the editor and removes the row when %s", async (_label, route) => {
    const { useAgentStore } = await importResearcherEditor({
      "DELETE /api/v1/agents/researcher": route
    })
    useAgentStore.getState().openAgentDeleteConfirmation()

    const deletion = useAgentStore.getState().deleteAgent()
    const whileDeleting = useAgentStore.getState().editor
    await deletion

    expect(whileDeleting).toMatchObject({ activity: { status: "deleting" } })
    expect(useAgentStore.getState()).toMatchObject({
      editor: { status: "closed" },
      list: { agents: [buildAgentSummary(WRITER)] }
    })
  })

  it("reports a failed deletion and keeps the editor", async () => {
    const { useAgentStore } = await importResearcherEditor({
      "DELETE /api/v1/agents/researcher": () => buildJsonResponse(500, {})
    })
    useAgentStore.getState().openAgentDeleteConfirmation()

    await useAgentStore.getState().deleteAgent()

    expect(useAgentStore.getState()).toMatchObject({
      editor: {
        status: "editing",
        activity: {
          status: "idle",
          failure: expect.stringMatching(/^Deleting failed: .*500/)
        }
      },
      list: {
        agents: [buildAgentSummary(RESEARCHER), buildAgentSummary(WRITER)]
      }
    })
  })

  it("reports a stopped backend without a request", async () => {
    const { useAgentStore, backend } = await importResearcherEditor({})
    useAgentStore.getState().openAgentDeleteConfirmation()
    const { useLysStore } = await import("@/lib/store")
    useLysStore.setState({ backendServerInfo: { status: "stopped" } })

    await useAgentStore.getState().deleteAgent()

    expect(useAgentStore.getState().editor).toMatchObject({
      activity: {
        failure: "The backend is not running, so the change was not made."
      }
    })
    expect(listRouteKeys(backend)).not.toContain(
      "DELETE /api/v1/agents/researcher"
    )
  })
})
