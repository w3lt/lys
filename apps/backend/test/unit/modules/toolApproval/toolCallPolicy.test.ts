import type { ChatToolCall } from "@lys/protocol"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  MAXIMUM_PAID_TOOL_CALLS_PER_TASK,
  MAXIMUM_TOOL_CALLS_PER_TASK,
  PAID_TOOL_CALLS_PER_TASK_WITHOUT_APPROVAL,
  buildApprovedFolders,
  decideToolCall,
  formatToolCallDenial,
  readToolCallRules,
  type ApprovedFolders,
  type ToolCallDecision,
  type ToolCallRequest,
  type ToolCallRules
} from "../../../../src/modules/toolApproval/toolCallPolicy"

/**
 * Rules of a machine whose home folder is `/home/ada` and whose Lys home is
 * `/home/ada/.lys`, with no folder listed.
 */
const RULES = Object.freeze({
  settingsFilePath: "/home/ada/.lys/settings.json",
  homeFolderPath: "/home/ada",
  approvedFolders: Object.freeze({ kind: "any" })
} satisfies ToolCallRules)

/**
 * Builds the rules of the same machine with only some folders approved.
 *
 * @param folderPaths - Approved folders, resolved by text.
 * @returns The rules.
 */
function buildListedRules(folderPaths: readonly string[]): ToolCallRules {
  return Object.freeze({
    ...RULES,
    approvedFolders: Object.freeze({ kind: "listed", folderPaths })
  })
}

/** Rules approving `/home/ada/work/app` and `/srv/shared` only. */
const LISTED_RULES = buildListedRules(["/home/ada/work/app", "/srv/shared"])

/** What a case's request says about its tool and its usage. */
type RequestTraits = Readonly<{
  /** Whether the tool's server marks it as destructive. */
  isDestructive?: boolean
  /** Whether the tool's server marks it as an open-world write. */
  isOpenWorldWrite?: boolean
  /** Whether a call spends a paid credit. */
  isPaid?: boolean
  /** Earlier calls of the tool in the reply that were not denied. */
  usageInTask?: number
}>

/** Traits of a destructive tool's first call. */
const DESTRUCTIVE_TRAITS = Object.freeze({
  isDestructive: true
} satisfies RequestTraits)

/**
 * Builds what the gateway knows about one call.
 *
 * @param callArguments - The call's checked arguments.
 * @param traits - The tool's marks and the call's usage; by default an
 * unmarked tool's first call.
 * @returns The request.
 */
function buildRequest(
  callArguments: ChatToolCall["arguments"],
  traits: RequestTraits = {}
): ToolCallRequest {
  return Object.freeze({
    action: Object.freeze({
      isDestructive: traits.isDestructive ?? false,
      isOpenWorldWrite: traits.isOpenWorldWrite ?? false,
      isPaid: traits.isPaid ?? false
    }),
    resource: Object.freeze({ arguments: callArguments }),
    environment: Object.freeze({ usageInTask: traits.usageInTask ?? 0 })
  })
}

/**
 * Builds what the gateway knows about a call without arguments.
 *
 * @param traits - The tool's marks and the call's usage.
 * @returns The request.
 */
function buildTraitRequest(traits: RequestTraits): ToolCallRequest {
  return buildRequest(Object.freeze({}), traits)
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

/** Decision for a call naming a path outside the approved folders. */
const DENIED_OUTSIDE_APPROVED_FOLDERS = Object.freeze({
  effect: "deny",
  reason: "outside-approved-folders"
} satisfies ToolCallDecision)

/** Decision for a call naming a path while the folders cannot be read. */
const DENIED_SETTINGS_UNREADABLE = Object.freeze({
  effect: "deny",
  reason: "settings-unreadable"
} satisfies ToolCallDecision)

/** Decision for a call naming a blocked network address. */
const DENIED_BLOCKED_ADDRESS = Object.freeze({
  effect: "deny",
  reason: "blocked-address"
} satisfies ToolCallDecision)

/** Decision for a call no rule denies. */
const ALLOWED = Object.freeze({ effect: "allow" } satisfies ToolCallDecision)

/**
 * Reads the cases of a fixture the host's tests read too.
 *
 * @param fileName - Name of a file in `packages/share/test/fixtures`.
 * @param caseSchema - Schema of one case.
 * @returns The cases, validated.
 * @throws When the file cannot be read or a case does not match the schema.
 */
function readSharedCases<CaseSchema extends z.ZodType>(
  fileName: string,
  caseSchema: CaseSchema
): readonly z.output<CaseSchema>[] {
  return z
    .array(caseSchema)
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            `../../../../../../packages/share/test/fixtures/${fileName}`,
            import.meta.url
          ),
          "utf8"
        )
      )
    )
}

/** Validates one case of the shared credential file names. */
const sharedCredentialNameCaseSchema = z
  .strictObject({
    /** What the case checks. */
    case: z.string(),
    /** One file or folder name. */
    name: z.string(),
    /** Whether the name is a credential name. */
    credential: z.boolean()
  })
  .readonly()

/**
 * Names that this policy and the desktop's file tools must judge alike; the
 * host's tests in `src-tauri/src/tools/credential_files.rs` read the same
 * file.
 */
const SHARED_CREDENTIAL_NAME_CASES = readSharedCases(
  "credential-file-names.json",
  sharedCredentialNameCaseSchema
)

/**
 * Validates one case of the names that may be a leftover copy of the
 * settings file.
 */
const sharedSettingsFileCopyNameCaseSchema = z
  .strictObject({
    /** What the case checks. */
    case: z.string(),
    /** One file name, beside a settings file named `settings.json`. */
    name: z.string(),
    /** Whether the name is that of a copy a stopped save left. */
    copy: z.boolean()
  })
  .readonly()

/**
 * Names that this policy and the desktop's file tools must judge alike as
 * leftover copies of the settings file; the host's tests in
 * `src-tauri/src/settings.rs` read the same file.
 */
const SHARED_SETTINGS_FILE_COPY_NAME_CASES = readSharedCases(
  "settings-file-copy-names.json",
  sharedSettingsFileCopyNameCaseSchema
)

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
  "Lys's settings file as a file URL": "file:///home/ada/.lys/settings.json",
  "a copy a stopped save left": "~/.lys/settings.json.4242.0.tmp",
  "a leftover copy as a file URL":
    "file:///home/ada/.lys/settings.json.4242.0.tmp",
  "a leftover copy in other letter case": "/HOME/ADA/.LYS/SETTINGS.JSON.1.0.TMP"
})

/** Values that look like a credential path but name none, by what each shows. */
const ALLOWED_PATH_CASES = Object.freeze({
  "a public key outside the SSH folder": "keys/id_rsa.pub",
  "a guide about SSH": "docs/ssh-guide.md",
  "another settings file": "/home/ada/project/settings.json",
  "a copy's name in another folder":
    "/home/ada/project/settings.json.4242.0.tmp",
  "a copy's name without its folder": "settings.json.4242.0.tmp",
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
      expect(decideToolCall(buildTargetRequest(value), RULES)).toStrictEqual(
        DENIED_CREDENTIAL_FILE
      )
    }
  )

  it.each(
    SHARED_CREDENTIAL_NAME_CASES.map((nameCase) => [nameCase.case, nameCase])
  )(
    "judges %s as the desktop's file tools do",
    (_label, { name, credential }) => {
      expect(
        decideToolCall(buildTargetRequest(`/home/ada/${name}`), RULES)
      ).toStrictEqual(credential ? DENIED_CREDENTIAL_FILE : ALLOWED)
    }
  )

  it.each(
    SHARED_SETTINGS_FILE_COPY_NAME_CASES.map((nameCase) => [
      nameCase.case,
      nameCase
    ])
  )(
    "judges %s in Lys's home as the desktop's file tools do",
    (_label, { name, copy }) => {
      expect(
        decideToolCall(buildTargetRequest(`/home/ada/.lys/${name}`), RULES)
      ).toStrictEqual(copy ? DENIED_CREDENTIAL_FILE : ALLOWED)
    }
  )

  it.each(Object.entries(ALLOWED_PATH_CASES))("allows %s", (_label, value) => {
    expect(decideToolCall(buildTargetRequest(value), RULES)).toStrictEqual(
      ALLOWED
    )
  })

  it.each(Object.entries(BLOCKED_ADDRESS_CASES))(
    "denies %s as a blocked address",
    (_label, value) => {
      expect(decideToolCall(buildTargetRequest(value), RULES)).toStrictEqual(
        DENIED_BLOCKED_ADDRESS
      )
    }
  )

  it.each(Object.entries(BLOCKED_HOST_FORM_CASES))(
    "denies %s as a blocked address",
    (_label, value) => {
      expect(decideToolCall(buildTargetRequest(value), RULES)).toStrictEqual(
        DENIED_BLOCKED_ADDRESS
      )
    }
  )

  it.each(Object.entries(ALLOWED_ADDRESS_CASES))(
    "allows %s",
    (_label, value) => {
      expect(decideToolCall(buildTargetRequest(value), RULES)).toStrictEqual(
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

    expect(decideToolCall(buildRequest(callArguments), RULES)).toStrictEqual({
      effect: "deny",
      reason: "credential-file"
    })
  })

  it("reads object keys too", () => {
    const callArguments = Object.freeze({
      headers: Object.freeze({ "http://10.0.0.1/": true })
    })

    expect(decideToolCall(buildRequest(callArguments), RULES)).toStrictEqual({
      effect: "deny",
      reason: "blocked-address"
    })
  })

  it("reads argument names too", () => {
    expect(
      decideToolCall(buildRequest(Object.freeze({ id_rsa: "on" })), RULES)
    ).toStrictEqual({ effect: "deny", reason: "credential-file" })
  })

  it("ignores numbers, booleans, and null", () => {
    const callArguments = Object.freeze({
      count: 2130706433,
      enabled: true,
      note: null
    })

    expect(decideToolCall(buildRequest(callArguments), RULES)).toStrictEqual({
      effect: "allow"
    })
  })

  it("allows a call without arguments", () => {
    expect(
      decideToolCall(buildRequest(Object.freeze({})), RULES)
    ).toStrictEqual({
      effect: "allow"
    })
  })

  it("names the credential file when a call breaks both rules", () => {
    const callArguments = Object.freeze({
      url: "http://127.0.0.1/",
      path: "~/.ssh/id_rsa"
    })

    expect(decideToolCall(buildRequest(callArguments), RULES)).toStrictEqual({
      effect: "deny",
      reason: "credential-file"
    })
  })

  it("requires approval of a call of a tool marked destructive", () => {
    const request = buildRequest(
      Object.freeze({ path: "notes/old.md" }),
      DESTRUCTIVE_TRAITS
    )

    expect(decideToolCall(request, RULES)).toStrictEqual({
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
      const request = buildRequest(
        Object.freeze({ target: value }),
        DESTRUCTIVE_TRAITS
      )

      expect(decideToolCall(request, RULES)).toStrictEqual(decision)
    }
  )

  it.each(
    Object.entries({
      "an open-world write": [{ isOpenWorldWrite: true }, "open-world-write"],
      "a paid tool's sixth call": [
        {
          isPaid: true,
          usageInTask: PAID_TOOL_CALLS_PER_TASK_WITHOUT_APPROVAL
        },
        "paid-tool"
      ],
      "a paid tool's twentieth call": [
        { isPaid: true, usageInTask: MAXIMUM_PAID_TOOL_CALLS_PER_TASK - 1 },
        "paid-tool"
      ]
    } satisfies Record<string, readonly [RequestTraits, string]>)
  )("requires approval of %s", (_label, [traits, reason]) => {
    expect(decideToolCall(buildTraitRequest(traits), RULES)).toStrictEqual({
      effect: "require-approval",
      reason
    })
  })

  it("denies a paid tool's call past its budget, rather than asking", () => {
    const request = buildTraitRequest({
      isPaid: true,
      usageInTask: MAXIMUM_PAID_TOOL_CALLS_PER_TASK
    })

    expect(decideToolCall(request, RULES)).toStrictEqual({
      effect: "deny",
      reason: "paid-tool-budget"
    })
  })

  it.each(
    Object.entries({
      "a paid tool's fifth call": {
        isPaid: true,
        usageInTask: PAID_TOOL_CALLS_PER_TASK_WITHOUT_APPROVAL - 1
      },
      "an unmarked tool's hundredth call": {
        usageInTask: MAXIMUM_TOOL_CALLS_PER_TASK - 1
      }
    })
  )("allows %s", (_label, traits) => {
    expect(decideToolCall(buildTraitRequest(traits), RULES)).toStrictEqual(
      ALLOWED
    )
  })

  it.each(
    Object.entries({
      "an unmarked tool": {},
      "a destructive tool": DESTRUCTIVE_TRAITS,
      "a paid tool": { isPaid: true }
    })
  )(
    "denies a call of %s past the usage limit, rather than asking",
    (_label, traits) => {
      const request = buildTraitRequest({
        ...traits,
        usageInTask: MAXIMUM_TOOL_CALLS_PER_TASK
      })

      expect(decideToolCall(request, RULES)).toStrictEqual({
        effect: "deny",
        reason: "usage-limit"
      })
    }
  )

  it("asks about a destructive tool before an open-world write", () => {
    const request = buildTraitRequest({
      isDestructive: true,
      isOpenWorldWrite: true
    })

    expect(decideToolCall(request, RULES)).toStrictEqual({
      effect: "require-approval",
      reason: "destructive-tool"
    })
  })

  it("denies a blocked address before it counts the usage", () => {
    const request = buildRequest(Object.freeze({ url: "http://127.0.0.1/" }), {
      usageInTask: MAXIMUM_TOOL_CALLS_PER_TASK
    })

    expect(decideToolCall(request, RULES)).toStrictEqual(DENIED_BLOCKED_ADDRESS)
  })

  it("compares with the settings file of the policy it is given", () => {
    const policy = Object.freeze({
      ...RULES,
      settingsFilePath: "/srv/lys/settings.json"
    } satisfies ToolCallRules)

    expect(
      decideToolCall(buildTargetRequest("/srv/lys/settings.json"), policy)
    ).toStrictEqual({ effect: "deny", reason: "credential-file" })
    expect(
      decideToolCall(buildTargetRequest("~/.lys/settings.json"), policy)
    ).toStrictEqual({ effect: "allow" })
  })

  it("reads a leftover copy by the name of the policy's settings file", () => {
    const policy = Object.freeze({
      ...RULES,
      settingsFilePath: "/srv/lys/lys.json"
    } satisfies ToolCallRules)

    expect(
      decideToolCall(buildTargetRequest("/srv/lys/lys.json.4242.0.tmp"), policy)
    ).toStrictEqual(DENIED_CREDENTIAL_FILE)
    expect(
      decideToolCall(
        buildTargetRequest("/srv/lys/settings.json.4242.0.tmp"),
        policy
      )
    ).toStrictEqual(ALLOWED)
  })
})

/** Paths inside an approved folder, by label. */
const INSIDE_APPROVED_FOLDER_CASES = Object.freeze({
  "the folder itself": "/home/ada/work/app",
  "the folder with a separator at its end": "/home/ada/work/app/",
  "a file in it": "/home/ada/work/app/src/main.ts",
  "a path that leaves and comes back": "/home/ada/work/app/src/../README.md",
  "a path in the home folder's form": "~/work/app/notes.md",
  "a path relative to the home folder": "./work/app/notes.md",
  "a file URL with an escaped space": "file:///home/ada/work/app/a%20b.txt",
  "a file in the second folder": "/srv/shared/report.txt",
  "a list of paths, one per line":
    "/home/ada/work/app/a.txt\r\n/srv/shared/b.txt"
})

/** Paths outside every approved folder, by label. */
const OUTSIDE_APPROVED_FOLDER_CASES = Object.freeze({
  "a system file": "/etc/hosts",
  "a folder next to an approved one": "/home/ada/work/app-old/a.txt",
  "the folder above an approved one": "/home/ada/work",
  "a path that climbs out": "/home/ada/work/app/../secret.txt",
  "a path that climbs out in its own words": "/home/ada/work/app/./../x",
  "the home folder": "~",
  "a file in the home folder": "~/Documents/a.txt",
  "the folder relative paths start from": ".",
  "a path relative to the home folder": "./notes.txt",
  "a relative path that climbs out": "../bob/notes.txt",
  "a file URL": "file:///etc/hosts",
  "a file URL that climbs out": "file:///home/ada/work/app/%2e%2e/secret",
  "a file URL with an escaped separator": "file:///home/ada/work/app/..%2Fx",
  "a file URL with a host": "file://server/home/ada/work/app/a.txt",
  "a path in other letter case": "/HOME/ADA/WORK/APP/a.txt",
  "a list with one path outside": "/home/ada/work/app/a.txt\n/etc/hosts"
})

/** Texts that name no path the folder rule reads, by label. */
const UNREAD_PATH_CASES = Object.freeze({
  "a relative path without a leading dot": "notes/a.txt",
  "a media type": "text/plain",
  "a command holding a path": "cat /etc/hosts",
  "a web address with a path": "https://example.com/etc/hosts",
  "a network path": "//server/share/a.txt",
  "another person's home folder": "~bob/notes.txt",
  "a dotted name": ".gitignore"
})

describe("decideToolCall with approved folders", () => {
  it.each(Object.entries(INSIDE_APPROVED_FOLDER_CASES))(
    "allows %s",
    (_label, value) => {
      expect(
        decideToolCall(buildTargetRequest(value), LISTED_RULES)
      ).toStrictEqual(ALLOWED)
    }
  )

  it.each(Object.entries(OUTSIDE_APPROVED_FOLDER_CASES))(
    "denies %s",
    (_label, value) => {
      expect(
        decideToolCall(buildTargetRequest(value), LISTED_RULES)
      ).toStrictEqual(DENIED_OUTSIDE_APPROVED_FOLDERS)
    }
  )

  it.each(Object.entries(UNREAD_PATH_CASES))(
    "leaves %s to the other rules",
    (_label, value) => {
      expect(
        decideToolCall(buildTargetRequest(value), LISTED_RULES)
      ).toStrictEqual(ALLOWED)
    }
  )

  it("reads a path in an argument name and in a nested value", () => {
    const nestedRequest = buildRequest(
      Object.freeze({ files: Object.freeze([{ "/etc/hosts": true }]) })
    )

    expect(decideToolCall(nestedRequest, LISTED_RULES)).toStrictEqual(
      DENIED_OUTSIDE_APPROVED_FOLDERS
    )
  })

  it("allows any path when no folder is listed", () => {
    expect(
      decideToolCall(buildTargetRequest("/etc/hosts"), RULES)
    ).toStrictEqual(ALLOWED)
  })

  it("denies every path when the listed folders are none", () => {
    const rules = buildListedRules([])

    expect(
      decideToolCall(buildTargetRequest("/home/ada/work/app/a.txt"), rules)
    ).toStrictEqual(DENIED_OUTSIDE_APPROVED_FOLDERS)
    expect(decideToolCall(buildTargetRequest("hello"), rules)).toStrictEqual(
      ALLOWED
    )
  })

  it("denies a call naming any path, a file URL with a host included, and leaves the rest to the other rules while the folders cannot be read", () => {
    const rules = Object.freeze({
      ...RULES,
      approvedFolders: Object.freeze({ kind: "unreadable" })
    } satisfies ToolCallRules)

    for (const value of [
      "/home/ada/work/app/a.txt",
      "~",
      "../notes.txt",
      "file://server/a.txt",
      "notes\n/etc/hosts"
    ])
      expect(
        decideToolCall(buildTargetRequest(value), rules),
        value
      ).toStrictEqual(DENIED_SETTINGS_UNREADABLE)
    for (const value of ["hello", "notes/a.txt", "cat /etc/hosts"])
      expect(
        decideToolCall(buildTargetRequest(value), rules),
        value
      ).toStrictEqual(ALLOWED)
    expect(
      decideToolCall(buildTargetRequest("/home/ada/.ssh/id_rsa"), rules)
    ).toStrictEqual(DENIED_CREDENTIAL_FILE)
  })

  it("approves everything under the root folder", () => {
    expect(
      decideToolCall(buildTargetRequest("/etc/hosts"), buildListedRules(["/"]))
    ).toStrictEqual(ALLOWED)
  })

  it.each([
    [
      "a credential file",
      "/home/ada/work/app/.ssh/id_rsa",
      DENIED_CREDENTIAL_FILE
    ],
    ["a credential file outside", "/etc/ssh/id_rsa", DENIED_CREDENTIAL_FILE],
    ["a blocked address", "http://127.0.0.1/", DENIED_BLOCKED_ADDRESS]
  ])("still denies %s by its own rule", (_label, value, decision) => {
    expect(
      decideToolCall(buildTargetRequest(value), LISTED_RULES)
    ).toStrictEqual(decision)
  })

  it("denies a path outside before it asks about a destructive tool", () => {
    const request = buildRequest(
      Object.freeze({ target: "/etc/hosts" }),
      DESTRUCTIVE_TRAITS
    )

    expect(decideToolCall(request, LISTED_RULES)).toStrictEqual(
      DENIED_OUTSIDE_APPROVED_FOLDERS
    )
  })
})

describe("buildApprovedFolders", () => {
  it("turns the rule off when no folder is saved", () => {
    expect(
      buildApprovedFolders({ status: "read", folderPaths: [] })
    ).toStrictEqual({ kind: "any" } satisfies ApprovedFolders)
  })

  it("resolves each saved folder by text", () => {
    expect(
      buildApprovedFolders({
        status: "read",
        folderPaths: ["/home/ada/work/", "/srv//shared/./x/.."]
      })
    ).toStrictEqual({
      kind: "listed",
      folderPaths: ["/home/ada/work", "/srv/shared"]
    } satisfies ApprovedFolders)
  })

  it("marks the folders unreadable when the settings file cannot be read", () => {
    expect(buildApprovedFolders({ status: "unreadable" })).toStrictEqual({
      kind: "unreadable"
    } satisfies ApprovedFolders)
  })
})

describe("readToolCallRules", () => {
  it("reads the approved folders again on every call", async () => {
    const readings: ApprovedFolders[] = [
      Object.freeze({ kind: "any" }),
      Object.freeze({ kind: "listed", folderPaths: ["/srv/shared"] })
    ]
    const policy = Object.freeze({
      settingsFilePath: RULES.settingsFilePath,
      homeFolderPath: RULES.homeFolderPath,
      readApprovedFolders: () =>
        Promise.resolve(readings.shift() ?? RULES.approvedFolders)
    })

    await expect(readToolCallRules(policy)).resolves.toStrictEqual(RULES)
    await expect(readToolCallRules(policy)).resolves.toStrictEqual(
      buildListedRules(["/srv/shared"])
    )
  })
})

describe("formatToolCallDenial", () => {
  it.each([
    [
      "credential-file",
      "This call was denied and did not run: an argument names a private key or credential file, such as one under ~/.ssh or Lys's settings file, which no tool may use. Do not try to reach it another way; tell the person what you need it for."
    ],
    [
      "outside-approved-folders",
      "This call was denied and did not run: an argument names a file or folder outside the folders the person lets tools use. Do not try to reach it another way; tell the person which file you need, so they can add its folder in Settings if they agree."
    ],
    [
      "settings-unreadable",
      "This call was denied and did not run: an argument names a file or folder, and Lys cannot read the folders the person lets tools use, because its settings file cannot be read, so no file or folder may be named until the file is fixed. Do not try to reach it another way; tell the person that Lys's settings file cannot be read."
    ],
    [
      "blocked-address",
      "This call was denied and did not run: an argument names this machine, a private network, or another address Lys never connects to. Do not try to reach it another way; tell the person what you need it for."
    ],
    [
      "usage-limit",
      "This call was denied and did not run: this reply has already called this tool 100 times, the most one reply may. Do not call it again in this reply; tell the person what you found and what is left to do."
    ],
    [
      "paid-tool-budget",
      "This call was denied and did not run: this reply has already called this tool 20 times, and each call spends the person's paid credits, so no reply may call it more. Do not call it again in this reply; work with the results you have and tell the person what is left to do."
    ]
  ] as const)("explains a %s denial", (reason, message) => {
    expect(formatToolCallDenial(reason)).toBe(message)
  })
})
