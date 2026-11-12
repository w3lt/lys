import type { ChatToolCall } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  decideToolCall,
  formatToolCallDenial,
  type ToolCallDecision,
  type ToolCallPolicy,
  type ToolCallRequest
} from "../../../../src/modules/toolApproval/toolCallPolicy"

/** Policy of a machine whose Lys home is `/home/ada/.lys`. */
const POLICY = Object.freeze({
  settingsFilePath: "/home/ada/.lys/settings.json"
} satisfies ToolCallPolicy)

/**
 * Builds what the gateway knows about one call.
 *
 * @param callArguments - The call's checked arguments.
 * @param isDestructive - Whether the tool's server marks it as destructive;
 * false by default.
 * @returns The request.
 */
function buildRequest(
  callArguments: ChatToolCall["arguments"],
  isDestructive = false
): ToolCallRequest {
  return Object.freeze({
    action: Object.freeze({ isDestructive }),
    resource: Object.freeze({ arguments: callArguments })
  })
}

/**
 * Builds what the gateway knows about a call of a tool not marked
 * destructive, with one argument.
 *
 * @param value - The argument's value.
 * @returns The request of a call holding `value` as `target`.
 */
function buildTargetRequest(value: string): ToolCallRequest {
  return buildRequest(Object.freeze({ target: value }))
}

/** Decision for a call naming a private key or credential file. */
const DENIED_CREDENTIAL_FILE = Object.freeze({
  effect: "deny",
  reason: "credential-file"
} satisfies ToolCallDecision)

/** Decision for a call naming a blocked network address. */
const DENIED_BLOCKED_ADDRESS = Object.freeze({
  effect: "deny",
  reason: "blocked-address"
} satisfies ToolCallDecision)

/** Decision for a call no rule denies. */
const ALLOWED = Object.freeze({ effect: "allow" } satisfies ToolCallDecision)

/** Values naming a private key or credential file, by what each shows. */
const CREDENTIAL_FILE_CASES = Object.freeze({
  "a key in the SSH folder": "~/.ssh/id_rsa",
  "any file in the SSH folder": "/home/ada/.ssh/config",
  "the SSH folder itself": "/home/ada/.ssh",
  "the SSH folder in other letter case": ".SSH/known_hosts",
  "a Windows path to the AWS folder": "C:\\Users\\ada\\.aws\\credentials",
  "the GnuPG folder": "~/.gnupg/private-keys-v1.d",
  "the Azure folder": "~/.azure/msal_token_cache.json",
  "the Kubernetes folder": "~/.kube/config",
  "the Docker folder": "~/.docker/config.json",
  "the macOS keychains": "~/Library/Keychains/login.keychain-db",
  "an SSH key by name": "backup/id_ed25519",
  "an SSH key name alone": "id_rsa",
  "a security-key SSH key": "id_ecdsa_sk",
  "a .netrc file": "project/.netrc",
  "a Git credentials file": "~/.git-credentials",
  "an npm settings file": "web/.npmrc",
  "a PostgreSQL password file": ".pgpass",
  "a .env file": ".env",
  "a .env file of one environment": "app/.env.local",
  "a PEM file": "keys/server.pem",
  "a key file in other letter case": "certs/SERVER.KEY",
  "a PKCS #12 file": "cert.p12",
  "a PFX file": "cert.pfx",
  "a PuTTY key": "putty.ppk",
  "a Java keystore": "release.jks",
  "a KeePass database": "vault.kdbx",
  "a path with spaces": "/home/ada/My Keys/deploy.pem",
  "a sentence holding a key path": "fix the rights of ~/.ssh/id_rsa now",
  "a file URL of a key": "file:///home/ada/.ssh/id_rsa",
  "a percent-encoded file URL": "file:///home/ada/%2Essh/id_rsa",
  "a value with spaces around it": "  ~/.aws/credentials  ",
  "Lys's settings file": "/home/ada/.lys/settings.json",
  "Lys's settings file under ~": "~/.lys/settings.json",
  "Lys's settings file under $HOME": "$HOME/.lys/settings.json",
  "Lys's settings file under ${HOME}": "${HOME}/.lys/settings.json",
  "Lys's settings file relative to home": ".lys/settings.json",
  "Lys's settings file through ..": "/home/ada/notes/../.lys/settings.json",
  "Lys's settings file through .": "/home/ada/.lys/./settings.json",
  "Lys's settings file with a doubled slash": "~/.lys//settings.json",
  "a command reading Lys's settings file": "cat ~/.lys/settings.json",
  "Lys's settings file in other letter case": "/HOME/ADA/.LYS/Settings.JSON",
  "Lys's settings file as a file URL": "file:///home/ada/.lys/settings.json"
})

/** Values that look like a credential path but name none, by what each shows. */
const ALLOWED_PATH_CASES = Object.freeze({
  "a public key outside the SSH folder": "keys/id_rsa.pub",
  "a guide about SSH": "docs/ssh-guide.md",
  "another settings file": "/home/ada/project/settings.json",
  "a settings file without its folder": "settings.json",
  "another file in Lys's home": "~/.lys/notes.json",
  "a name that only starts like .env": ".environment",
  "a name that only ends like .key": "monkey.keys",
  "a sentence about keys": "the key to success",
  "a sentence naming .env without a path": "copy .env.example to .env",
  "a note file": "~/notes/todo.md",
  "a certificate on a web server": "https://example.com/certs/root.pem",
  "a .env file on another machine": "sftp://example.com/app/.env",
  "an empty value": ""
})

/** Values naming a blocked network address, by what each shows. */
const BLOCKED_ADDRESS_CASES = Object.freeze({
  "a loopback URL": "http://127.0.0.1:8080/",
  "a local name in a URL": "https://LOCALHOST./admin",
  "a name under localhost in a URL": "http://api.localhost/",
  "an IPv6 loopback URL": "ws://[::1]/socket",
  "a decimal spelling of loopback": "http://2130706433/",
  "a link-local URL with a user name": "http://ada:pw@169.254.169.254/latest",
  "a database URL with a hex host": "postgres://ada@0x7f.1/db",
  "a cache URL with a private address": "redis://10.0.0.5:6379",
  "a scheme without slashes": "http:192.168.0.1",
  "a file URL of another machine": "file://127.0.0.1/share",
  "a private address": "192.168.1.1",
  "a private address with a port": "10.0.0.1:22",
  "the address of this host": "0.0.0.0",
  "an IPv6 loopback address": "::1",
  "a bracketed unique-local address with a port": "[fd00::1]:443",
  "an IPv4-mapped loopback address": "::ffff:127.0.0.1",
  "a local name": "localhost",
  "a local name with a port": "api.localhost:3000",
  "a local name with a path": "localhost/admin",
  "a private address with a port and a path": "10.0.0.1:8080/api",
  "an address with spaces around it": " 127.0.0.1 "
})

/**
 * Values naming a blocked address in another common form of a host without
 * a scheme, by what each shows.
 */
const BLOCKED_HOST_FORM_CASES = Object.freeze({
  "a private host after a user name": "admin@192.168.1.10",
  "a private host after a user name holding @": "ada@contoso.com@10.0.0.5",
  "an scp target on a private host": "git@10.0.0.2:repo.git",
  "a bracketed address after a user name": "ada@[fd00::1]:22",
  "a UNC path on a private host": "\\\\10.0.0.5\\share\\notes.txt",
  "a network path to loopback": "//127.0.0.1/admin"
})

/** Values that look like an address but name no blocked one, by what each shows. */
const ALLOWED_ADDRESS_CASES = Object.freeze({
  "a public URL": "https://example.com/page",
  "a public address": "93.184.215.14",
  "a public IPv6 address": "[2606:4700:4700::1111]",
  "a number": "2130706433",
  "a version": "1.2.3",
  "a name that ends like localhost": "example.localhost.com",
  "a name that starts like localhost": "localhosts",
  "a relative path": "notes/todo.md",
  "an email address": "mailto:ada@example.com",
  "a bracketed word": "[x]",
  "a sentence naming a local address": "my app runs on http://localhost:3000",
  "a URL whose host cannot be an http host": "foo://a%zz/",
  "an email address without a scheme": "ada@example.com",
  "a network path to a named server": "//server/share",
  "a Windows path": "C:\\Users\\ada\\notes.txt",
  "a time of day": "10:30"
})

describe("decideToolCall", () => {
  it.each(Object.entries(CREDENTIAL_FILE_CASES))(
    "denies %s as a credential file",
    (_label, value) => {
      expect(decideToolCall(buildTargetRequest(value), POLICY)).toStrictEqual(
        DENIED_CREDENTIAL_FILE
      )
    }
  )

  it.each(Object.entries(ALLOWED_PATH_CASES))("allows %s", (_label, value) => {
    expect(decideToolCall(buildTargetRequest(value), POLICY)).toStrictEqual(
      ALLOWED
    )
  })

  it.each(Object.entries(BLOCKED_ADDRESS_CASES))(
    "denies %s as a blocked address",
    (_label, value) => {
      expect(decideToolCall(buildTargetRequest(value), POLICY)).toStrictEqual(
        DENIED_BLOCKED_ADDRESS
      )
    }
  )

  it.each(Object.entries(BLOCKED_HOST_FORM_CASES))(
    "denies %s as a blocked address",
    (_label, value) => {
      expect(decideToolCall(buildTargetRequest(value), POLICY)).toStrictEqual(
        DENIED_BLOCKED_ADDRESS
      )
    }
  )

  it.each(Object.entries(ALLOWED_ADDRESS_CASES))(
    "allows %s",
    (_label, value) => {
      expect(decideToolCall(buildTargetRequest(value), POLICY)).toStrictEqual(
        ALLOWED
      )
    }
  )

  it("reads every value at any depth", () => {
    const callArguments = Object.freeze({
      options: Object.freeze({
        paths: Object.freeze(["notes.md", "~/.ssh/id_rsa"])
      })
    })

    expect(decideToolCall(buildRequest(callArguments), POLICY)).toStrictEqual({
      effect: "deny",
      reason: "credential-file"
    })
  })

  it("reads object keys too", () => {
    const callArguments = Object.freeze({
      headers: Object.freeze({ "http://10.0.0.1/": true })
    })

    expect(decideToolCall(buildRequest(callArguments), POLICY)).toStrictEqual({
      effect: "deny",
      reason: "blocked-address"
    })
  })

  it("reads argument names too", () => {
    expect(
      decideToolCall(buildRequest(Object.freeze({ id_rsa: "on" })), POLICY)
    ).toStrictEqual({ effect: "deny", reason: "credential-file" })
  })

  it("ignores numbers, booleans, and null", () => {
    const callArguments = Object.freeze({
      count: 2130706433,
      enabled: true,
      note: null
    })

    expect(decideToolCall(buildRequest(callArguments), POLICY)).toStrictEqual({
      effect: "allow"
    })
  })

  it("allows a call without arguments", () => {
    expect(
      decideToolCall(buildRequest(Object.freeze({})), POLICY)
    ).toStrictEqual({
      effect: "allow"
    })
  })

  it("names the credential file when a call breaks both rules", () => {
    const callArguments = Object.freeze({
      url: "http://127.0.0.1/",
      path: "~/.ssh/id_rsa"
    })

    expect(decideToolCall(buildRequest(callArguments), POLICY)).toStrictEqual({
      effect: "deny",
      reason: "credential-file"
    })
  })

  it("requires approval of a call of a tool marked destructive", () => {
    const request = buildRequest(Object.freeze({ path: "notes/old.md" }), true)

    expect(decideToolCall(request, POLICY)).toStrictEqual({
      effect: "require-approval",
      reason: "destructive-tool"
    })
  })

  it.each([
    ["a credential file", "~/.ssh/id_rsa", DENIED_CREDENTIAL_FILE],
    ["a blocked address", "http://127.0.0.1/", DENIED_BLOCKED_ADDRESS]
  ])(
    "denies a call of a tool marked destructive that names %s, rather than asking",
    (_label, value, decision) => {
      const request = buildRequest(Object.freeze({ target: value }), true)

      expect(decideToolCall(request, POLICY)).toStrictEqual(decision)
    }
  )

  it("compares with the settings file of the policy it is given", () => {
    const policy = Object.freeze({
      settingsFilePath: "/srv/lys/settings.json"
    } satisfies ToolCallPolicy)

    expect(
      decideToolCall(buildTargetRequest("/srv/lys/settings.json"), policy)
    ).toStrictEqual({ effect: "deny", reason: "credential-file" })
    expect(
      decideToolCall(buildTargetRequest("~/.lys/settings.json"), policy)
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
