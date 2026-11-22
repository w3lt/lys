import { VOICE_HOST, VOICE_PORT, VOICE_SOCKET_PORT } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import hostVoiceSource from "../../../../../src-tauri/src/voice.rs?raw"
import voiceWebServerSource from "../../../../../../voice/Sources/voice/WebServer/WebServer.swift?raw"
import voiceSpeechSocketSource from "../../../../../../voice/Sources/voice/WebSocket/SpeechSocketServer.swift?raw"

/** Repository path of the Tauri host's voice module, for failure messages. */
const HOST_VOICE_SOURCE_PATH = "apps/desktop/src-tauri/src/voice.rs"

/** Repository path of voice's web server, for failure messages. */
const VOICE_WEB_SERVER_SOURCE_PATH =
  "apps/voice/Sources/voice/WebServer/WebServer.swift"

/** Repository path of voice's speech socket server, for failure messages. */
const VOICE_SOCKET_SERVER_SOURCE_PATH =
  "apps/voice/Sources/voice/WebSocket/SpeechSocketServer.swift"

/**
 * The Tauri host's health-check address: an `Ipv4Addr` constant such as
 * `LOCALHOST` as `host`, and the port.
 */
const HOST_VOICE_ADDRESS_PATTERN =
  /const VOICE_ADDRESS: SocketAddrV4 =\s*SocketAddrV4::new\(\s*Ipv4Addr::(?<host>\w+)\s*,\s*(?<port>\d+)\s*\);/g

/** The default host and port of voice's web server initializer. */
const VOICE_WEB_SERVER_ADDRESS_PATTERN =
  /init\(\s*router: Router,\s*host: NWEndpoint\.Host = "(?<host>[^"]*)",\s*port: NWEndpoint\.Port = (?<port>\d+)/g

/**
 * The default host and port of voice's speech socket server: the listener
 * settings its initializer takes when the caller gives none.
 */
const VOICE_SOCKET_ADDRESS_PATTERN =
  /init\(\s*jobs: VoiceJobs,\s*settings: ListenerSettings = ListenerSettings\(\s*host: "(?<host>[^"]*)",\s*port: (?<port>\d+)\s*\)/g

/** Dotted addresses of the Rust `Ipv4Addr` constants the host may name. */
const RUST_IPV4_CONSTANT_ADDRESSES: Readonly<Record<string, string>> =
  Object.freeze({ LOCALHOST: "127.0.0.1" })

/** voice's address as one source file declares it, unconverted. */
type DeclaredVoiceAddress = {
  /** Host as written in the source. */
  readonly host: string
  /** Port as written in the source. */
  readonly port: string
}

/**
 * Parses the one declaration of voice's address that `pattern` matches in a
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
function parseDeclaredVoiceAddress(
  source: string,
  pattern: RegExp,
  sourcePath: string
): DeclaredVoiceAddress {
  const matches = [...source.matchAll(pattern)]
  const groups = matches[0]?.groups
  if (
    matches.length !== 1 ||
    groups?.host === undefined ||
    groups.port === undefined
  ) {
    throw new Error(
      `Expected one declaration of voice's address in ${sourcePath}, found ${matches.length}. Update this check and the CONST-005 exception in reference/standard-application.mdx together with the declaration.`
    )
  }
  return Object.freeze({ host: groups.host, port: groups.port })
}

// Rust and Swift cannot import @lys/protocol, so the Tauri host's health
// check and voice's listeners declare voice's addresses again. These cases
// guard the CONST-005 exception recorded in reference/standard-application.mdx:
// they fail as soon as a copy differs from VOICE_HOST, VOICE_PORT, or
// VOICE_SOCKET_PORT, or can no longer be found, and the raw imports fail to
// load when a file moves.
describe("voice address copies kept under the CONST-005 exception", () => {
  it("keeps the Tauri host's health-check address equal to VOICE_HOST and VOICE_PORT", () => {
    const declared = parseDeclaredVoiceAddress(
      hostVoiceSource,
      HOST_VOICE_ADDRESS_PATTERN,
      HOST_VOICE_SOURCE_PATH
    )
    const host = RUST_IPV4_CONSTANT_ADDRESSES[declared.host] ?? declared.host

    expect({ host, port: Number(declared.port) }).toEqual({
      host: VOICE_HOST,
      port: VOICE_PORT
    })
  })

  it("keeps voice's default health address equal to VOICE_HOST and VOICE_PORT", () => {
    const declared = parseDeclaredVoiceAddress(
      voiceWebServerSource,
      VOICE_WEB_SERVER_ADDRESS_PATTERN,
      VOICE_WEB_SERVER_SOURCE_PATH
    )

    expect({ host: declared.host, port: Number(declared.port) }).toEqual({
      host: VOICE_HOST,
      port: VOICE_PORT
    })
  })

  it("keeps voice's default socket address equal to VOICE_HOST and VOICE_SOCKET_PORT", () => {
    const declared = parseDeclaredVoiceAddress(
      voiceSpeechSocketSource,
      VOICE_SOCKET_ADDRESS_PATTERN,
      VOICE_SOCKET_SERVER_SOURCE_PATH
    )

    expect({ host: declared.host, port: Number(declared.port) }).toEqual({
      host: VOICE_HOST,
      port: VOICE_SOCKET_PORT
    })
  })
})
