import { VMO_HOST, VMO_PORT } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import hostVmoSource from "../../../../../src-tauri/src/vmo.rs?raw"
import vmoWebServerSource from "../../../../../../vmo/Sources/vmo/WebServer/WebServer.swift?raw"

/** Repository path of the Tauri host's vmo module, for failure messages. */
const HOST_VMO_SOURCE_PATH = "apps/desktop/src-tauri/src/vmo.rs"

/** Repository path of vmo's web server, for failure messages. */
const VMO_WEB_SERVER_SOURCE_PATH =
  "apps/vmo/Sources/vmo/WebServer/WebServer.swift"

/**
 * The Tauri host's health-check address: an `Ipv4Addr` constant such as
 * `LOCALHOST` as `host`, and the port.
 */
const HOST_VMO_ADDRESS_PATTERN =
  /const VMO_ADDRESS: SocketAddrV4 =\s*SocketAddrV4::new\(\s*Ipv4Addr::(?<host>\w+)\s*,\s*(?<port>\d+)\s*\);/g

/** The default host and port of vmo's web server initializer. */
const VMO_WEB_SERVER_ADDRESS_PATTERN =
  /init\(\s*router: Router,\s*host: NWEndpoint\.Host = "(?<host>[^"]*)",\s*port: NWEndpoint\.Port = (?<port>\d+)\s*\)/g

/** Dotted addresses of the Rust `Ipv4Addr` constants the host may name. */
const RUST_IPV4_CONSTANT_ADDRESSES: Readonly<Record<string, string>> =
  Object.freeze({ LOCALHOST: "127.0.0.1" })

/** vmo's address as one source file declares it, unconverted. */
type DeclaredVmoAddress = {
  /** Host as written in the source. */
  readonly host: string
  /** Port as written in the source. */
  readonly port: string
}

/**
 * Parses the one declaration of vmo's address that `pattern` matches in a
 * repository source file.
 *
 * @param source - Text of the source file.
 * @param pattern - Global pattern whose `host` and `port` groups capture the
 * address.
 * @param sourcePath - Repository path of the source file, for the failure
 * message.
 * @returns The host and port as the file writes them.
 * @throws When the pattern does not match exactly once, so a moved or
 * reworded declaration fails the check instead of passing it unchecked.
 */
function parseDeclaredVmoAddress(
  source: string,
  pattern: RegExp,
  sourcePath: string
): DeclaredVmoAddress {
  const matches = [...source.matchAll(pattern)]
  const groups = matches[0]?.groups
  if (
    matches.length !== 1 ||
    groups?.host === undefined ||
    groups.port === undefined
  ) {
    throw new Error(
      `Expected one declaration of vmo's address in ${sourcePath}, found ${matches.length}. Update this check and the CONST-005 exception in reference/standard-application.mdx together with the declaration.`
    )
  }
  return Object.freeze({ host: groups.host, port: groups.port })
}

// Rust and Swift cannot import @lys/protocol, so the Tauri host's health
// check and vmo's web server declare vmo's address again. These cases guard
// the CONST-005 exception recorded in reference/standard-application.mdx:
// they fail as soon as a copy differs from VMO_HOST and VMO_PORT or can no
// longer be found, and the raw imports fail to load when a file moves.
// #207 removes the Rust copy; vmo's own default stays.
describe("vmo address copies kept under the CONST-005 exception until #207", () => {
  it("keeps the Tauri host's health-check address equal to VMO_HOST and VMO_PORT", () => {
    const declared = parseDeclaredVmoAddress(
      hostVmoSource,
      HOST_VMO_ADDRESS_PATTERN,
      HOST_VMO_SOURCE_PATH
    )
    const host = RUST_IPV4_CONSTANT_ADDRESSES[declared.host] ?? declared.host

    expect({ host, port: Number(declared.port) }).toEqual({
      host: VMO_HOST,
      port: VMO_PORT
    })
  })

  it("keeps vmo's default listening address equal to VMO_HOST and VMO_PORT", () => {
    const declared = parseDeclaredVmoAddress(
      vmoWebServerSource,
      VMO_WEB_SERVER_ADDRESS_PATTERN,
      VMO_WEB_SERVER_SOURCE_PATH
    )

    expect({ host: declared.host, port: Number(declared.port) }).toEqual({
      host: VMO_HOST,
      port: VMO_PORT
    })
  })
})
