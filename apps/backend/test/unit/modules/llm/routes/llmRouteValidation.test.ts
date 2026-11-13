import { describe, expect, it } from "vitest"
import * as z from "zod"
import { buildLlmRouteValidatorCompiler } from "../../../../../src/modules/llm/routes/llmRouteValidation"

/** Path parameters of a route that names the provider. */
const PARAMS_SCHEMA = z.strictObject({ provider: z.enum(["lmStudio", "groq"]) })

/** Body of a route that takes a model key. */
const BODY_SCHEMA = z.strictObject({ modelKey: z.string().min(1) })

/**
 * Compiles the validator Fastify would build for one request part.
 *
 * @param httpPart - Part Fastify compiles a validator for.
 * @param withBody - Whether the route declares a body schema.
 * @returns The part's validator.
 */
function compileValidator(httpPart: string, withBody: boolean) {
  const compile = buildLlmRouteValidatorCompiler(
    withBody
      ? { params: PARAMS_SCHEMA, body: BODY_SCHEMA }
      : { params: PARAMS_SCHEMA }
  )
  return compile({ schema: {}, method: "POST", url: "/test", httpPart })
}

describe("buildLlmRouteValidatorCompiler", () => {
  it.each([
    ["params", { provider: "groq" }],
    ["body", { modelKey: "qwen/qwen3-8b" }]
  ])("answers the %s part with the value its schema parsed", (part, data) => {
    expect(compileValidator(part, true)(data)).toEqual({ value: data })
  })

  it.each([
    ["params", { provider: "openai" }],
    ["body", { modelKey: "" }]
  ])(
    "answers a %s part its schema refuses with the parse failure",
    (part, data) => {
      expect(compileValidator(part, true)(data)).toEqual({
        error: expect.any(z.ZodError)
      })
    }
  )

  it.each([
    ["the body of a route that takes none", "body"],
    ["the query string", "querystring"],
    ["the headers", "headers"]
  ])("refuses to compile a validator for %s", (_label, part) => {
    expect(() => compileValidator(part, false)).toThrow(
      `The LLM route has no schema for its ${part} part.`
    )
  })
})
