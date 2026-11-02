/** Most characters one host name label may have, inclusive. */
const MAXIMUM_HOST_LABEL_LENGTH = 63

/** Most characters a host name may have, inclusive. */
const MAXIMUM_HOST_NAME_LENGTH = 253

/** Highest TCP port number, inclusive. */
export const MAXIMUM_TCP_PORT = 65_535

/**
 * Finds one host name label: letters, digits, and inner hyphens, which also
 * covers each part of a dotted IPv4 address.
 */
const HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

/**
 * Answers whether a text is a host name: 1 to
 * {@link MAXIMUM_HOST_NAME_LENGTH} characters of labels separated by dots,
 * each label 1 to {@link MAXIMUM_HOST_LABEL_LENGTH} letters, digits, or
 * inner hyphens, which also covers a dotted IPv4 address.
 *
 * @param host - Text to inspect, as typed.
 * @returns True for such a host name; false for an empty text, a scheme, a
 * path, a port, an IPv6 address, or a label outside the rule.
 * @remarks The desktop host keeps the same rule in its own copy; changing
 * it changes which settings files load and requires a coordinated desktop
 * and backend release.
 */
export function isHostName(host: string): boolean {
  if (host.length === 0 || host.length > MAXIMUM_HOST_NAME_LENGTH) return false
  return host
    .split(".")
    .every(
      (label) =>
        label.length <= MAXIMUM_HOST_LABEL_LENGTH &&
        HOST_LABEL_PATTERN.test(label)
    )
}
