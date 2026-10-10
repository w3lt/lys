import { listBackendToolsApiResponseSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { createBuiltInTools } from "../../../../../src/modules/tool/builtIn/builtInTools"
import { buildReadPageDefinition } from "../../../../../src/modules/tool/builtIn/web/readPageTool"
import registerToolRoutes from "../../../../../src/modules/tool/routes"
import { createTestFastify } from "../../../support/fastifyTestApp"
import {
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "../../../support/scriptedBuiltInTool"

describe("registerToolRoutes", () => {
  it("lists the definition of every backend tool in order at the published path", async () => {
    const { app } = createTestFastify()
    app.decorate("builtInTools", [
      ...createBuiltInTools(),
      { definition: LOOK_UP_WORD_TOOL, tool: new ScriptedBuiltInTool() }
    ])
    await registerToolRoutes(app)

    const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      tools: [buildReadPageDefinition(), LOOK_UP_WORD_TOOL]
    })
    expect(
      listBackendToolsApiResponseSchema.safeParse(response.json()).success
    ).toBe(true)
  })

  it("lists no tools when the backend runs none", async () => {
    const { app } = createTestFastify()
    app.decorate("builtInTools", [])
    await registerToolRoutes(app)

    const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

    expect(response.json()).toEqual({ tools: [] })
  })

  it("registers the tools path for GET only", async () => {
    const { app } = createTestFastify()
    app.decorate("builtInTools", [])
    await registerToolRoutes(app)

    const response = await app.inject({ method: "POST", url: "/api/v1/tools" })

    expect(response.statusCode).toBe(404)
  })
})
