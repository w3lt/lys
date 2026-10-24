import * as z from "zod"

/**
 * Stable problem category for a request whose `Host` or `Origin` shows that
 * it does not come from a source the backend serves.
 */
const REQUEST_SOURCE_REFUSED_PROBLEM_TYPE =
  "urn:lys:problem:http:request-source-refused"

/** Client-facing summary shared by every refused request source. */
const REQUEST_SOURCE_REFUSED_PROBLEM_TITLE = "Request source refused"

/** HTTP status accompanying a refused request source. */
const REQUEST_SOURCE_REFUSED_PROBLEM_STATUS = 403

/**
 * Validates the RFC 9457 body returned for a request from a source the
 * backend does not serve.
 *
 * @remarks The backend's HTTP transport transmits this contract with HTTP
 * 403, before routing, for every route, when the `Host` header does not name
 * the backend's own loopback address and port, or when an `Origin` header
 * names a page other than the desktop's. No route, body parser, or CORS
 * handling has run, so nothing was read or changed. The `type` literal is the
 * machine-readable discriminator; `detail`, which says which header was
 * refused, is caller-safe text. Changing any fixed field requires coordinated
 * consumers.
 */
export const requestSourceRefusedProblemSchema = z
  .strictObject({
    /** Stable discriminator separating a refused source from other failures. */
    type: z.literal(REQUEST_SOURCE_REFUSED_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(REQUEST_SOURCE_REFUSED_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(REQUEST_SOURCE_REFUSED_PROBLEM_STATUS),
    /** Caller-safe explanation naming the refused header. */
    detail: z.string().min(1)
  })
  .readonly()

/** Refused-request-source Problem Details body inferred from its schema. */
export type RequestSourceRefusedProblem = z.infer<
  typeof requestSourceRefusedProblemSchema
>
