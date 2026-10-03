import { MAXIMUM_AGENT_CODE_LENGTH } from "@lys/share"

/** Code base used when an agent name contains no ASCII letter or digit. */
const FALLBACK_AGENT_CODE = "agent"

/**
 * Calculates the slug of an agent name: its ASCII letters and digits,
 * lowercased, in hyphen-separated groups.
 *
 * @param name - Agent name to derive the slug from.
 * @returns The slug, of any length, or an empty text when the name has no
 * letter or digit with an ASCII form.
 * @remarks Accents are removed through Unicode compatibility decomposition, so
 * `Trợ lý` gives `tro-ly` and `ﬁ` gives `fi`. A letter without an ASCII
 * decomposition, such as `đ`, separates groups like any other character.
 */
function calculateAgentNameSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "")
}

/**
 * Calculates the code tried for an agent created without one.
 *
 * @param name - Validated name of the new agent.
 * @param attempt - One-based number of the try, a positive integer: the first
 * try uses the name's slug, and each later try appends `-<attempt>`.
 * @returns A valid agent code of at most `MAXIMUM_AGENT_CODE_LENGTH`
 * characters. The slug is cut, without a trailing hyphen, to leave room for
 * the suffix; a name with no ASCII letter or digit uses `agent` instead.
 * @remarks Tries from the second on give distinct codes, so a caller trying
 * them in order finds a free code once the tries outnumber the stored agents.
 */
export function calculateAgentCode(name: string, attempt: number): string {
  const slug = calculateAgentNameSlug(name)
  const base = slug === "" ? FALLBACK_AGENT_CODE : slug
  const suffix = attempt === 1 ? "" : `-${attempt}`
  const cutBase = base
    .slice(0, MAXIMUM_AGENT_CODE_LENGTH - suffix.length)
    .replace(/-$/, "")
  return `${cutBase}${suffix}`
}
