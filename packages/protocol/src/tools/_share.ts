import * as z from "zod"

/**
 * Builds the schema of a declared tool failure whose only field is its `code`.
 *
 * @remarks Shared by the read-text-file and search-files failure unions. The
 * schema is strict, so a failure that carries any other key is rejected, and
 * its parsed value is read-only, like the failures that carry fields.
 * @typeParam Code - Code that identifies the failure.
 * @param code - Value the failure's `code` field must equal.
 * @returns A schema that accepts exactly `{ code }`.
 */
export function buildCodeOnlyFailureSchema<Code extends string>(code: Code) {
  return z.strictObject({ code: z.literal(code) }).readonly()
}
