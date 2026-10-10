import { isBlockedAddress, isLocalHostName } from "./webAddresses"

/** Nominal marker of a URL that passed {@link parsePageUrl}. */
declare const PAGE_URL_BRAND: unique symbol

/**
 * Absolute `http` or `https` URL of a web page Lys may request, in the URL
 * parser's normalized form.
 *
 * @remarks Only {@link parsePageUrl} produces it. It carries no username or
 * password, and its host is neither a local name nor a blocked IP address.
 * A host name can still resolve to a blocked address; the request checks
 * every resolved address before it connects.
 */
export type PageUrl = string & {
  /** Prevents an unchecked string from standing in for a checked URL. */
  readonly [PAGE_URL_BRAND]: "PageUrl"
}

/**
 * Most UTF-16 code units a page URL may have, inclusive, counted on the text
 * as given.
 */
export const MAXIMUM_PAGE_URL_LENGTH = 2_048

/** Why a text is not a URL Lys may request. */
export type PageUrlProblem =
  | "too-long"
  | "not-absolute"
  | "unsupported-scheme"
  | "has-credentials"
  | "local-address"

/** Outcome of checking one URL text. */
export type PageUrlResult =
  | Readonly<{
      /** The text is a URL Lys may request. */
      status: "valid"
      /** Normalized URL. */
      url: PageUrl
    }>
  | Readonly<{
      /** The text is not a URL Lys may request. */
      status: "invalid"
      /** The first problem found. */
      problem: PageUrlProblem
    }>

/** Explanations the model reads for each URL problem, by problem. */
const PAGE_URL_PROBLEM_MESSAGES = Object.freeze({
  "too-long": `The URL is longer than ${MAXIMUM_PAGE_URL_LENGTH} characters.`,
  "not-absolute":
    "The URL is not an absolute URL, such as https://example.com/page.",
  "unsupported-scheme": "Only http and https URLs can be read.",
  "has-credentials":
    "The URL contains a username or password, which Lys never sends.",
  "local-address":
    "The URL points to this machine or a private network, which Lys never reads."
} satisfies Readonly<Record<PageUrlProblem, string>>)

/**
 * Answers whether a URL host is this machine or a blocked IP address.
 *
 * @param hostname - Host as the URL parser normalized it; an IPv6 address
 * keeps its brackets.
 * @returns True for a local name or a blocked IP literal.
 */
function isLocalPageHost(hostname: string): boolean {
  if (isLocalHostName(hostname)) return true
  if (hostname.startsWith("[")) return isBlockedAddress(hostname.slice(1, -1))
  return isIpv4Literal(hostname) && isBlockedAddress(hostname)
}

/**
 * Answers whether a normalized URL host is an IPv4 address.
 *
 * @param hostname - Host as the URL parser normalized it.
 * @returns True for four dot-separated decimal numbers, the only form the
 * parser leaves an IPv4 host in.
 */
function isIpv4Literal(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Finds why a parsed URL may not be requested.
 *
 * @param url - Absolute URL from the URL parser.
 * @returns The first problem, or undefined when Lys may request it.
 */
function findPageUrlProblem(url: URL): PageUrlProblem | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "unsupported-scheme"
  }
  if (url.username !== "" || url.password !== "") return "has-credentials"
  if (isLocalPageHost(url.hostname)) return "local-address"
  return undefined
}

/**
 * Parses a URL text into a URL Lys may request.
 *
 * @param text - Untrusted URL text, such as a model's argument or a redirect
 * target already resolved against the page that sent it.
 * @returns `valid` with the normalized URL, or `invalid` with the first
 * problem: too long, not absolute, not `http` or `https`, carrying a
 * username or password, or naming this machine or a blocked IP address.
 * @remarks The URL parser normalizes odd spellings of an IP address, such as
 * `http://2130706433/`, before the host is checked.
 */
export function parsePageUrl(text: string): PageUrlResult {
  if (text.length > MAXIMUM_PAGE_URL_LENGTH) {
    return Object.freeze({ status: "invalid", problem: "too-long" })
  }
  const url = URL.parse(text)
  if (url === null) {
    return Object.freeze({ status: "invalid", problem: "not-absolute" })
  }
  const problem = findPageUrlProblem(url)
  if (problem !== undefined) {
    return Object.freeze({ status: "invalid", problem })
  }
  // The checks above prove every PageUrl invariant for this normalized text.
  const pageUrl = url.href as PageUrl
  return Object.freeze({ status: "valid", url: pageUrl })
}

/**
 * Formats the explanation the model reads for a URL problem.
 *
 * @param problem - Problem {@link parsePageUrl} found.
 * @returns One sentence naming the problem.
 */
export function formatPageUrlProblem(problem: PageUrlProblem): string {
  return PAGE_URL_PROBLEM_MESSAGES[problem]
}
