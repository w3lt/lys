/**
 * Answers whether every value in a list appears once.
 *
 * @param values - Values to inspect, compared exactly, such as tool names.
 * @returns True when no value repeats.
 */
export function hasDistinctValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}
