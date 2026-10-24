import * as z from "zod"

/**
 * Most arrays and objects a JSON value may sit inside, counting itself,
 * inclusive.
 *
 * @remarks Bounds the recursion of {@link jsonValueSchema} and of every
 * consumer that walks a value. The backend refuses deeper values before it
 * sends any, so raising it requires a coordinated backend and desktop
 * release.
 */
export const MAXIMUM_JSON_NESTING_DEPTH = 32

/**
 * Any JSON value, read-only all the way down.
 *
 * @remarks Recursive: arrays and objects hold JSON values. A value checked
 * by {@link jsonValueSchema} nests at most {@link MAXIMUM_JSON_NESTING_DEPTH}
 * arrays and objects deep, which ends every walk over it. Object keys are
 * any text except `__proto__`, which {@link jsonValueSchema} refuses so a
 * key is never lost to an object prototype.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>

/** A JSON value with the depth at which it sits. */
type NestedJsonValue = Readonly<{
  /** Value to inspect. */
  value: unknown
  /** Arrays and objects the value sits inside; 0 for the outermost value. */
  depth: number
}>

/** Object key that would replace an object's prototype when assigned. */
const PROTOTYPE_KEY = "__proto__"

/**
 * Lists the values one array or plain object holds.
 *
 * @param value - Value to inspect.
 * @returns The items of an array, the own enumerable values of an object,
 * or an empty list for anything else.
 */
function listNestedValues(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === "object" && value !== null) return Object.values(value)
  return []
}

/**
 * Answers whether a value is an array or an object, which adds a level of
 * nesting.
 *
 * @param value - Value to inspect.
 * @returns True for an array or a non-null object.
 */
function isJsonContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

/**
 * Answers whether a value is within the limits Lys puts on every JSON value
 * it reads: arrays and objects nested at most
 * {@link MAXIMUM_JSON_NESTING_DEPTH} deep, counting the value itself, and no
 * object with an own `__proto__` key.
 *
 * @param value - Untrusted value, such as the output of `JSON.parse`.
 * @returns True when the value keeps both limits. Scalars nest 0 deep.
 * @remarks Walks the value with an explicit stack, so a deep value never
 * exhausts the call stack; it stops at the first level past the depth
 * limit. Checking it before a recursive parse bounds that parse.
 */
export function isWithinJsonValueLimits(value: unknown): boolean {
  const pending: NestedJsonValue[] = [{ value, depth: 0 }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!isJsonContainer(next.value)) continue
    const depth = next.depth + 1
    if (
      depth > MAXIMUM_JSON_NESTING_DEPTH ||
      Object.hasOwn(next.value, PROTOTYPE_KEY)
    )
      return false
    for (const nested of listNestedValues(next.value))
      pending.push({ value: nested, depth })
  }
  return true
}

/**
 * Validates one JSON value of any shape after its depth was checked, and
 * freezes every array and object in it.
 */
const jsonValueTreeSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueTreeSchema).readonly(),
    z.record(z.string(), jsonValueTreeSchema).readonly()
  ])
)

/**
 * Validates any JSON value nested at most
 * {@link MAXIMUM_JSON_NESTING_DEPTH} arrays and objects deep, without a
 * `__proto__` key. The output is frozen all the way down.
 *
 * @remarks The depth and the key are checked first, without recursion, so
 * the structural parse that follows is bounded. Numbers must be finite.
 */
export const jsonValueSchema = z
  .unknown()
  .refine(
    (value) => isWithinJsonValueLimits(value),
    `A JSON value nests at most ${MAXIMUM_JSON_NESTING_DEPTH} arrays and objects deep and has no ${PROTOTYPE_KEY} key.`
  )
  .pipe(jsonValueTreeSchema)
