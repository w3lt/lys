import { describe, expect, it } from "vitest"
import {
  isBlockedAddress,
  isLocalHostName
} from "../../../../../../src/modules/tool/builtIn/web/webAddresses"

describe("isBlockedAddress", () => {
  it.each([
    ["this host", "0.0.0.0"],
    ["a private 10/8 address", "10.1.2.3"],
    ["a shared 100.64/10 address", "100.64.0.1"],
    ["the last shared 100.64/10 address", "100.127.255.255"],
    ["a loopback address", "127.0.0.1"],
    ["another loopback address", "127.255.0.9"],
    ["a link-local address", "169.254.169.254"],
    ["the first private 172.16/12 address", "172.16.0.0"],
    ["the last private 172.16/12 address", "172.31.255.255"],
    ["a protocol-assignment address", "192.0.0.8"],
    ["a documentation address", "192.0.2.10"],
    ["a 6to4 relay address", "192.88.99.1"],
    ["a private 192.168/16 address", "192.168.1.1"],
    ["a benchmarking address", "198.19.0.1"],
    ["a multicast address", "224.0.0.251"],
    ["the broadcast address", "255.255.255.255"],
    ["the unspecified IPv6 address", "::"],
    ["the IPv6 loopback address", "::1"],
    ["an IPv4-compatible loopback address", "::7f00:1"],
    ["an IPv4-mapped loopback address in hex", "::ffff:7f00:1"],
    ["an IPv4-mapped loopback address in dotted form", "::ffff:127.0.0.1"],
    ["an IPv4-mapped private address", "::ffff:192.168.0.1"],
    ["a NAT64 address", "64:ff9b::808:808"],
    ["a 6to4 address", "2002:c0a8:101::1"],
    ["a Teredo address", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["an IPv6 documentation address", "2001:db8::1"],
    ["a unique-local address", "fd12:3456::1"],
    ["a link-local IPv6 address", "fe80::1"],
    ["a site-local IPv6 address", "fec0::1"],
    ["a multicast IPv6 address", "ff02::1"]
  ])("blocks %s", (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  it.each([
    ["a public IPv4 address", "93.184.215.14"],
    ["the address before 100.64/10", "100.63.255.255"],
    ["the address after 100.64/10", "100.128.0.0"],
    ["the address before 172.16/12", "172.15.255.255"],
    ["the address after 172.16/12", "172.32.0.0"],
    ["a public IPv6 address", "2606:4700:4700::1111"],
    ["an IPv4-mapped public address", "::ffff:8.8.8.8"]
  ])("allows %s", (_label, address) => {
    expect(isBlockedAddress(address)).toBe(false)
  })

  it.each([
    ["a host name", "example.com"],
    ["an empty value", ""],
    ["a bracketed IPv6 address", "[::1]"]
  ])("blocks %s, which is not an IP address", (_label, value) => {
    expect(isBlockedAddress(value)).toBe(true)
  })
})

describe("isLocalHostName", () => {
  it.each(["localhost", "localhost.", "app.localhost", "a.b.localhost."])(
    "treats %s as this machine",
    (hostname) => {
      expect(isLocalHostName(hostname)).toBe(true)
    }
  )

  it.each(["example.com", "localhost.example.com", "mylocalhost", "local"])(
    "does not treat %s as this machine",
    (hostname) => {
      expect(isLocalHostName(hostname)).toBe(false)
    }
  )
})
