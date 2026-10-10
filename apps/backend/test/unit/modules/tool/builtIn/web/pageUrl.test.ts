import { describe, expect, it } from "vitest"
import {
  formatPageUrlProblem,
  MAXIMUM_PAGE_URL_LENGTH,
  parsePageUrl,
  type PageUrlProblem
} from "../../../../../../src/modules/tool/builtIn/web/pageUrl"

/**
 * Builds a valid URL of an exact length.
 *
 * @param length - Length of the URL text.
 * @returns An `https` URL whose path pads it to `length`.
 */
function buildUrlOfLength(length: number): string {
  const prefix = "https://example.com/"
  return prefix + "a".repeat(length - prefix.length)
}

describe("parsePageUrl", () => {
  it("accepts an absolute https URL and returns its normalized form", () => {
    expect(parsePageUrl("HTTPS://Example.COM:443/a b?q=1#part")).toEqual({
      status: "valid",
      url: "https://example.com/a%20b?q=1#part"
    })
  })

  it("accepts a plain http URL", () => {
    expect(parsePageUrl("http://example.com/")).toEqual({
      status: "valid",
      url: "http://example.com/"
    })
  })

  it("accepts a public IP address", () => {
    expect(parsePageUrl("https://93.184.215.14/")).toEqual({
      status: "valid",
      url: "https://93.184.215.14/"
    })
  })

  it("accepts a URL exactly at the length limit and rejects one past it", () => {
    expect(parsePageUrl(buildUrlOfLength(MAXIMUM_PAGE_URL_LENGTH)).status).toBe(
      "valid"
    )
    expect(parsePageUrl(buildUrlOfLength(MAXIMUM_PAGE_URL_LENGTH + 1))).toEqual(
      { status: "invalid", problem: "too-long" }
    )
  })

  it.each([
    ["a relative path", "/page"],
    ["a host without a scheme", "example.com/page"],
    ["a scheme-relative URL", "//example.com/page"],
    ["text that is not a URL", "not a url at all"],
    ["an empty text", ""]
  ])("rejects %s as not absolute", (_label, text) => {
    expect(parsePageUrl(text)).toEqual({
      status: "invalid",
      problem: "not-absolute"
    })
  })

  it.each([
    ["ftp", "ftp://example.com/file"],
    ["file", "file:///etc/hosts"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<p>hi</p>"]
  ])("rejects the %s scheme", (_label, text) => {
    expect(parsePageUrl(text)).toEqual({
      status: "invalid",
      problem: "unsupported-scheme"
    })
  })

  it.each([
    ["a username", "https://user@example.com/"],
    ["a username and password", "https://user:secret@example.com/"]
  ])("rejects a URL with %s", (_label, text) => {
    expect(parsePageUrl(text)).toEqual({
      status: "invalid",
      problem: "has-credentials"
    })
  })

  it.each([
    ["localhost", "http://localhost:12345/"],
    ["a name under localhost", "http://api.localhost/"],
    ["localhost with a trailing dot", "http://LOCALHOST./"],
    ["a loopback address", "http://127.0.0.1:12345/"],
    ["a decimal spelling of loopback", "http://2130706433/"],
    ["a hex spelling of loopback", "http://0x7f.1/"],
    ["a private address", "http://192.168.1.1/"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data"],
    ["the IPv6 loopback address", "http://[::1]:8080/"],
    ["an IPv4-mapped loopback address", "http://[::ffff:127.0.0.1]/"],
    ["a unique-local IPv6 address", "http://[fd00::1]/"]
  ])("rejects %s", (_label, text) => {
    expect(parsePageUrl(text)).toEqual({
      status: "invalid",
      problem: "local-address"
    })
  })
})

describe("formatPageUrlProblem", () => {
  it.each<[PageUrlProblem, string]>([
    ["too-long", "The URL is longer than 2048 characters."],
    [
      "not-absolute",
      "The URL is not an absolute URL, such as https://example.com/page."
    ],
    ["unsupported-scheme", "Only http and https URLs can be read."],
    [
      "has-credentials",
      "The URL contains a username or password, which Lys never sends."
    ],
    [
      "local-address",
      "The URL points to this machine or a private network, which Lys never reads."
    ]
  ])("explains %s to the model", (problem, message) => {
    expect(formatPageUrlProblem(problem)).toBe(message)
  })
})
