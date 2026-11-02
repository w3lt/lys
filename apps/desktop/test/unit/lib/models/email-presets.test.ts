import { describe, expect, it } from "vitest"
import { findEmailPreset } from "@/lib/models/email-presets"

describe("findEmailPreset", () => {
  it.each([
    ["ada@gmail.com", "Gmail"],
    ["ada@googlemail.com", "Gmail"],
    ["ada@outlook.com", "Outlook"],
    ["ada@hotmail.com", "Outlook"],
    ["ada@live.com", "Outlook"],
    ["ada@icloud.com", "iCloud"],
    ["ada@me.com", "iCloud"],
    ["ada@mac.com", "iCloud"],
    ["ada@yahoo.com", "Yahoo"],
    ["ada@fastmail.com", "Fastmail"]
  ])("finds the preset of %s", (address, name) => {
    expect(findEmailPreset(address)?.name).toBe(name)
  })

  it("compares the domain without regard to case or surrounding spaces", () => {
    expect(findEmailPreset("  Ada@GMail.COM  ")?.name).toBe("Gmail")
  })

  it("reads the domain after the last @", () => {
    expect(findEmailPreset("ada@work@fastmail.com")?.name).toBe("Fastmail")
  })

  it.each([
    ["no @", "ada.fastmail.com"],
    ["a domain without a preset", "ada@example.test"],
    ["a subdomain of a provider", "ada@mail.gmail.com"],
    ["an empty domain", "ada@"]
  ])("finds nothing for %s", (_label, address) => {
    expect(findEmailPreset(address)).toBeUndefined()
  })

  it("holds the published servers of Gmail with TLS on both sides", () => {
    expect(findEmailPreset("ada@gmail.com")).toEqual({
      name: "Gmail",
      imap: { host: "imap.gmail.com", port: 993, security: "tls" },
      smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
      serverKeepsSentCopy: true
    })
  })

  it("holds the published servers of Outlook with STARTTLS for sending", () => {
    expect(findEmailPreset("ada@outlook.com")).toEqual({
      name: "Outlook",
      imap: { host: "outlook.office365.com", port: 993, security: "tls" },
      smtp: { host: "smtp-mail.outlook.com", port: 587, security: "starttls" },
      serverKeepsSentCopy: true
    })
  })

  it("knows iCloud does not file sent mail itself", () => {
    expect(findEmailPreset("ada@icloud.com")).toMatchObject({
      imap: { host: "imap.mail.me.com" },
      smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
      serverKeepsSentCopy: false
    })
  })

  it("returns frozen presets", () => {
    const preset = findEmailPreset("ada@yahoo.com")

    expect(Object.isFrozen(preset)).toBe(true)
    expect(Object.isFrozen(preset?.imap)).toBe(true)
    expect(Object.isFrozen(preset?.smtp)).toBe(true)
  })
})
