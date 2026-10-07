import * as z from "zod"

/**
 * Builds the schema of a declared tool failure whose only field is its `code`.
 *
 * @remarks Shared by the read-text-file and search-files failure unions. The
 * schema is strict, so a failure that carries any other key is rejected, and
 * its parsed value is read-only, like the failures that carry fields. The
 * caller passes the whole shape rather than the code alone so that the
 * description written on its `code` field stays on the inferred failure type,
 * where editors show it.
 * @typeParam Shape - Shape whose `code` field holds the failure's literal
 * code; any other key is a compile-time error.
 * @param shape - Field schemas of the failure, with `code` as the only field.
 * @returns A schema that accepts exactly `{ code }`.
 */
export function buildCodeOnlyFailureSchema<
  Shape extends { readonly code: z.ZodLiteral<string> }
>(shape: Shape & Record<Exclude<keyof Shape, "code">, never>) {
  return z.strictObject(shape).readonly()
}
