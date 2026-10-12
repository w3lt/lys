import { generateKeyPairSync, sign } from "node:crypto"

/** A private key and a self-signed certificate for one local test server. */
export type TestTlsCredentials = Readonly<{
  /** PKCS #8 PEM private key; generated for one test, never reused. */
  key: string
  /** PEM certificate signed by its own key, so no client trusts it. */
  cert: string
}>

/** DER algorithm identifier of ECDSA with SHA-256. */
const ECDSA_WITH_SHA256_OBJECT_ID = Buffer.from([
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02
])

/** DER object identifier of an X.500 common name. */
const COMMON_NAME_OBJECT_ID = Buffer.from([0x55, 0x04, 0x03])

/** Start of the certificate's validity, as an ASN.1 UTCTime. */
const VALID_FROM = "260101000000Z"

/** End of the certificate's validity, as an ASN.1 GeneralizedTime. */
const VALID_UNTIL = "21260101000000Z"

/** Characters of base64 per PEM line. */
const PEM_LINE_LENGTH = 64

/**
 * Encodes the length of one DER value.
 *
 * @param length - Byte length of the value's content.
 * @returns The short form below 128, the long form otherwise.
 */
function encodeDerLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let remaining = length; remaining > 0; remaining >>= 8) {
    bytes.unshift(remaining & 0xff)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/**
 * Encodes one DER value.
 *
 * @param tag - ASN.1 tag byte.
 * @param parts - Content, concatenated in order.
 * @returns The tag, the length, and the content.
 */
function encodeDer(tag: number, ...parts: readonly Buffer[]): Buffer {
  const content = Buffer.concat(parts)
  return Buffer.concat([
    Buffer.from([tag]),
    encodeDerLength(content.length),
    content
  ])
}

/**
 * Encodes an X.500 name made of one common name.
 *
 * @param commonName - The common name.
 * @returns The DER name.
 */
function encodeCommonName(commonName: string): Buffer {
  const attribute = encodeDer(
    0x30,
    encodeDer(0x06, COMMON_NAME_OBJECT_ID),
    encodeDer(0x0c, Buffer.from(commonName, "utf8"))
  )
  return encodeDer(0x30, encodeDer(0x31, attribute))
}

/**
 * Formats DER bytes as one PEM block.
 *
 * @param label - PEM label, such as `CERTIFICATE`.
 * @param bytes - DER bytes.
 * @returns The PEM text with a trailing newline.
 */
function formatPem(label: string, bytes: Buffer): string {
  const base64 = bytes.toString("base64")
  const lines: string[] = []
  for (let start = 0; start < base64.length; start += PEM_LINE_LENGTH) {
    lines.push(base64.slice(start, start + PEM_LINE_LENGTH))
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

/**
 * Creates a fresh P-256 key and a certificate it signs itself, so a local
 * HTTPS server can run in a test without any committed key.
 *
 * @param commonName - Subject and issuer common name, such as the host name
 * the test client asks for.
 * @returns The PEM key and certificate. The certificate is an X.509 v3
 * certificate valid from 2026 to 2126 without extensions; no trust store
 * holds it, so a client that verifies certificates refuses it.
 */
export function createSelfSignedTlsCredentials(
  commonName: string
): TestTlsCredentials {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256"
  })
  const algorithm = encodeDer(
    0x30,
    encodeDer(0x06, ECDSA_WITH_SHA256_OBJECT_ID)
  )
  const name = encodeCommonName(commonName)
  const validity = encodeDer(
    0x30,
    encodeDer(0x17, Buffer.from(VALID_FROM, "ascii")),
    encodeDer(0x18, Buffer.from(VALID_UNTIL, "ascii"))
  )
  const certificateBody = encodeDer(
    0x30,
    encodeDer(0xa0, encodeDer(0x02, Buffer.from([2]))),
    encodeDer(0x02, Buffer.from([1])),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ type: "spki", format: "der" })
  )
  const signature = sign("sha256", certificateBody, privateKey)
  const certificate = encodeDer(
    0x30,
    certificateBody,
    algorithm,
    encodeDer(0x03, Buffer.from([0]), signature)
  )
  return Object.freeze({
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: formatPem("CERTIFICATE", certificate)
  })
}
