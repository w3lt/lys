import type { FastifySchemaCompiler } from "fastify"
import type * as z from "zod"

/**
 * Schemas of the request parts one LLM route validates: its path
 * parameters, which name the provider, and its body when it takes one.
 */
export type LlmRouteRequestSchemas = Readonly<{
  /** Path parameters of the route. */
  params: z.ZodType
  /** Body of the route, or undefined for a route that takes none. */
  body?: z.ZodType
}>

/** Fastify's result of validating one request part. */
type LlmRouteValidationResult =
  Readonly<{ value: unknown }> | Readonly<{ error: Error }>

/**
 * Builds the validator compiler of one LLM route, which parses each request
 * part with that part's own schema.
 *
 * @param schemas - Schemas of the parts the route declares in its `schema`.
 * @returns A compiler that Fastify calls once for each part the route
 * declares; each validator answers with the parsed value or the parse
 * failure, which Fastify sends as a 400 before the handler runs.
 * @throws When Fastify compiles a part the route has no schema for, so a
 * route that declares a part without its schema fails to register.
 */
export function buildLlmRouteValidatorCompiler(
  schemas: LlmRouteRequestSchemas
): FastifySchemaCompiler<unknown> {
  return ({ httpPart }) => {
    const schema = getLlmRouteRequestSchema(schemas, httpPart)
    return (data) => validateLlmRouteRequestPart(schema, data)
  }
}

/**
 * Gets the schema of one request part of an LLM route.
 *
 * @param schemas - Schemas of the route's parts.
 * @param httpPart - Part Fastify compiles a validator for.
 * @returns The part's schema.
 * @throws When the route has no schema for the part.
 */
function getLlmRouteRequestSchema(
  schemas: LlmRouteRequestSchemas,
  httpPart: string | undefined
): z.ZodType {
  const schema = findLlmRouteRequestSchema(schemas, httpPart)
  if (schema === undefined) {
    throw new Error(
      `The LLM route has no schema for its ${httpPart ?? "unnamed"} part.`
    )
  }
  return schema
}

/**
 * Finds the schema of one request part of an LLM route.
 *
 * @param schemas - Schemas of the route's parts.
 * @param httpPart - Part Fastify compiles a validator for.
 * @returns The params or body schema, or undefined for a body the route does
 * not take and for any other part.
 */
function findLlmRouteRequestSchema(
  schemas: LlmRouteRequestSchemas,
  httpPart: string | undefined
): z.ZodType | undefined {
  switch (httpPart) {
    case "params":
      return schemas.params
    case "body":
      return schemas.body
    default:
      return undefined
  }
}

/**
 * Validates one untrusted request part.
 *
 * @param schema - Schema of the part.
 * @param data - Part as Fastify decoded it.
 * @returns The parsed value, or the parse failure.
 */
function validateLlmRouteRequestPart(
  schema: z.ZodType,
  data: unknown
): LlmRouteValidationResult {
  const result = schema.safeParse(data)
  return result.success ? { value: result.data } : { error: result.error }
}
