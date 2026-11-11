import type { ChatToolCall } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  decideToolCall,
  formatToolCallDenial,
  type ToolCallPolicy
} from "../../../../src/modules/toolApproval/toolCallPolicy"

/** Policy of a machine whose Lys home is `/home/ada/.lys`. */
const POLICY = Object.freeze({
  settingsFilePath: "/home/ada/.lys/settings.json"
} satisfies ToolCallPolicy)

/**
 * Builds the checked arguments of a call with one argument.
 *
 * @param value - The argument's value.
 * @returns Arguments holding `value` as `target`.
 */
function buildArguments(value: string): ChatToolCall["arguments"] {
  return Object.freeze({ target: value })
}

describe("decideToolCall", () => {
  it.each([
    ["a key in the SSH folder", "~/.ssh/id_rsa"],
    ["any file in the SSH folder", "/home/ada/.ssh/config"],
    ["the SSH folder itself", "/home/ada/.ssh"],
    ["the SSH folder in other letter case", ".SSH/known_hosts"],
    ["a Windows path to the AWS folder", "C:\\Users\\ada\\.aws\\credentials"],
    ["the GnuPG folder", "~/.gnupg/private-keys-v1.d"],
    ["the Azure folder", "~/.azure/msal_token_cache.json"],
    ["the Kubernetes folder", "~/.kube/config"],
    ["the Docker folder", "~/.docker/config.json"],
    ["the macOS keychains", "~/Library/Keychains/login.keychain-db"],
    ["an SSH key by name", "backup/id_ed25519"],
    ["an SSH key name alone", "id_rsa"],
    ["a security-key SSH key", "id_ecdsa_sk"],
    ["a .netrc file", "project/.netrc"],
    ["a Git credentials file", "~/.git-credentials"],
    ["an npm settings file", "web/.npmrc"],
    ["a PostgreSQL password file", ".pgpass"],
    ["a .env file", ".env"],
    ["a .env file of one environment", "app/.env.local"],
    ["a PEM file", "keys/server.pem"],
    ["a key file in other letter case", "certs/SERVER.KEY"],
    ["a PKCS #12 file", "cert.p12"],
    ["a PFX file", "cert.pfx"],
    ["a PuTTY key", "putty.ppk"],
    ["a Java keystore", "release.jks"],
    ["a KeePass database", "vault.kdbx"],
    ["a path with spaces", "/home/ada/My Keys/deploy.pem"],
    ["a sentence holding a key path", "fix the rights of ~/.ssh/id_rsa now"],
    ["a file URL of a key", "file:///home/ada/.ssh/id_rsa"],
    ["a percent-encoded file URL", "file:///home/ada/%2Essh/id_rsa"],
    ["a value with spaces around it", "  ~/.aws/credentials  "],
    ["Lys's settings file", "/home/ada/.lys/settings.json"],
    ["Lys's settings file under ~", "~/.lys/settings.json"],
    ["Lys's settings file under $HOME", "$HOME/.lys/settings.json"],
    ["Lys's settings file under ${HOME}", "${HOME}/.lys/settings.json"],
    ["Lys's settings file relative to home", ".lys/settings.json"],
    ["Lys's settings file through ..", "/home/ada/notes/../.lys/settings.json"],
    ["Lys's settings file through .", "/home/ada/.lys/./settings.json"],
    ["Lys's settings file with a doubled slash", "~/.lys//settings.json"],
    ["a command reading Lys's settings file", "cat ~/.lys/settings.json"],
    [
      "Lys's settings file in other letter case",
      "/HOME/ADA/.LYS/Settings.JSON"
    ],
    ["Lys's settings file as a file URL", "file:///home/ada/.lys/settings.json"]
  ])("denies %s as a credential file", (_label, value) => {
    expect(decideToolCall(buildArguments(value), POLICY)).toStrictEqual({
      effect: "deny",
      reason: "credential-file"
    })
  })

  it.each([
    ["a public key outside the SSH folder", "keys/id_rsa.pub"],
    ["a guide about SSH", "docs/ssh-guide.md"],
    ["another settings file", "/home/ada/project/settings.json"],
    ["a settings file without its folder", "settings.json"],
    ["another file in Lys's home", "~/.lys/notes.json"],
    ["a name that only starts like .env", ".environment"],
    ["a name that only ends like .key", "monkey.keys"],
    ["a sentence about keys", "the key to success"],
    ["a sentence naming .env without a path", "copy .env.example to .env"],
    ["a note file", "~/notes/todo.md"],
    ["a certificate on a web server", "https://example.com/certs/root.pem"],
    ["a .env file on another machine", "sftp://example.com/app/.env"],
    ["an empty value", ""]
  ])("allows %s", (_label, value) => {
    expect(decideToolCall(buildArguments(value), POLICY)).toStrictEqual({
      effect: "allow"
    })
  })

  it.each([
    ["a loopback URL", "http://127.0.0.1:8080/"],
    ["a local name in a URL", "https://LOCALHOST./admin"],
    ["a name under localhost in a URL", "http://api.localhost/"],
    ["an IPv6 loopback URL", "ws://[::1]/socket"],
    ["a decimal spelling of loopback", "http://2130706433/"],
    [
      "a link-local URL with a user name",
      "http://ada:pw@169.254.169.254/latest"
    ],
    ["a database URL with a hex host", "postgres://ada@0x7f.1/db"],
    ["a cache URL with a private address", "redis://10.0.0.5:6379"],
    ["a scheme without slashes", "http:192.168.0.1"],
    ["a file URL of another machine", "file://127.0.0.1/share"],
    ["a private address", "192.168.1.1"],
    ["a private address with a port", "10.0.0.1:22"],
    ["the address of this host", "0.0.0.0"],
    ["an IPv6 loopback address", "::1"],
    ["a bracketed unique-local address with a port", "[fd00::1]:443"],
    ["an IPv4-mapped loopback address", "::ffff:127.0.0.1"],
    ["a local name", "localhost"],
    ["a local name with a port", "api.localhost:3000"],
    ["a local name with a path", "localhost/admin"],
    ["a private address with a port and a path", "10.0.0.1:8080/api"],
    ["an address with spaces around it", " 127.0.0.1 "]
  ])("denies %s as a blocked address", (_label, value) => {
    expect(decideToolCall(buildArguments(value), POLICY)).toStrictEqual({
      effect: "deny",
      reason: "blocked-address"
    })
  })

  it.each([
    ["a public URL", "https://example.com/page"],
    ["a public address", "93.184.215.14"],
    ["a public IPv6 address", "[2606:4700:4700::1111]"],
    ["a number", "2130706433"],
    ["a version", "1.2.3"],
    ["a name that ends like localhost", "example.localhost.com"],
    ["a name that starts like localhost", "localhosts"],
    ["a relative path", "notes/todo.md"],
    ["an email address", "mailto:ada@example.com"],
    ["a bracketed word", "[x]"],
    [
      "a sentence naming a local address",
      "my app runs on http://localhost:3000"
    ],
    ["a URL whose host cannot be an http host", "foo://a%zz/"]
  ])("allows %s", (_label, value) => {
    expect(decideToolCall(buildArguments(value), POLICY)).toStrictEqual({
      effect: "allow"
    })
  })

  it("reads every value at any depth", () => {
    const callArguments = Object.freeze({
      options: Object.freeze({
        paths: Object.freeze(["notes.md", "~/.ssh/id_rsa"])
      })
    })

    expect(decideToolCall(callArguments, POLICY)).toStrictEqual({
      effect: "deny",
      reason: "credential-file"
    })
  })

  it("reads object keys too", () => {
    const callArguments = Object.freeze({
      headers: Object.freeze({ "http://10.0.0.1/": true })
    })

    expect(decideToolCall(callArguments, POLICY)).toStrictEqual({
      effect: "deny",
      reason: "blocked-address"
    })
  })

  it("reads argument names too", () => {
    expect(
      decideToolCall(Object.freeze({ id_rsa: "on" }), POLICY)
    ).toStrictEqual({ effect: "deny", reason: "credential-file" })
  })

  it("ignores numbers, booleans, and null", () => {
    const callArguments = Object.freeze({
      count: 2130706433,
      enabled: true,
      note: null
    })

    expect(decideToolCall(callArguments, POLICY)).toStrictEqual({
      effect: "allow"
    })
  })

  it("allows a call without arguments", () => {
    expect(decideToolCall(Object.freeze({}), POLICY)).toStrictEqual({
      effect: "allow"
    })
  })

  it("names the credential file when a call breaks both rules", () => {
    const callArguments = Object.freeze({
      url: "http://127.0.0.1/",
      path: "~/.ssh/id_rsa"
    })

    expect(decideToolCall(callArguments, POLICY)).toStrictEqual({
      effect: "deny",
      reason: "credential-file"
    })
  })

  it("compares with the settings file of the policy it is given", () => {
    const policy = Object.freeze({
      settingsFilePath: "/srv/lys/settings.json"
    } satisfies ToolCallPolicy)

    expect(
      decideToolCall(buildArguments("/srv/lys/settings.json"), policy)
    ).toStrictEqual({ effect: "deny", reason: "credential-file" })
    expect(
      decideToolCall(buildArguments("~/.lys/settings.json"), policy)
    ).toStrictEqual({ effect: "allow" })
  })
})

describe("formatToolCallDenial", () => {
  it.each([
    [
      "credential-file",
      "This call was denied and did not run: an argument names a private key or credential file, such as one under ~/.ssh or Lys's settings file, which no tool may use. Do not try to reach it another way; tell the person what you need it for."
    ],
    [
      "blocked-address",
      "This call was denied and did not run: an argument names this machine, a private network, or another address Lys never connects to. Do not try to reach it another way; tell the person what you need it for."
    ]
  ] as const)("explains a %s denial", (reason, message) => {
    expect(formatToolCallDenial(reason)).toBe(message)
  })
})
