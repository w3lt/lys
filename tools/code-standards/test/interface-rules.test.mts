import { interfaceMemberRule } from "../rules/iface-002.mts"
import { interfaceOperationCountRule } from "../rules/iface-006.mts"
import { optionalOperationRule } from "../rules/iface-008.mts"
import { interfaceOperationRule } from "../rules/iface-010.mts"
import {
  expectedCountReport,
  expectedReport,
  ruleTester
} from "./rule-tester.mts"

/**
 * Builds an interface with the given member lines.
 *
 * @param members - Member signatures, one per line.
 * @returns Source of the interface `Store`.
 */
function storeInterface(...members: readonly string[]): string {
  return `interface Store {\n${members.join("\n")}\n}`
}

/**
 * Builds method signatures named `operation0`, `operation1`, and so on.
 *
 * @param count - Number of method signatures.
 * @returns The signatures.
 */
function operations(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `operation${index}(): void`
  )
}

/** Augmentation of an external interface, which no interface rule checks. */
const externalAugmentation = `declare module "fastify" {
  interface FastifyInstance {
    store: Store
    load?(): void
  }
}`

ruleTester.run("iface-002", interfaceMemberRule, {
  valid: [
    {
      name: "allows the chapter's required method signature",
      code: storeInterface(
        "saveConversation(conversation: Conversation): Promise<void>"
      )
    },
    {
      name: "allows the chapter's required accessor pair",
      code: storeInterface(
        "get content(): DraftContent",
        "set content(content: DraftContent)"
      )
    },
    { name: "skips an external augmentation", code: externalAugmentation }
  ],
  invalid: [
    {
      name: "reports the chapter's prohibited function-valued property",
      code: storeInterface(
        "saveConversation: (conversation: Conversation) => Promise<void>"
      ),
      errors: [expectedReport("nonOperationMember")]
    },
    {
      name: "reports the chapter's prohibited data property",
      code: storeInterface("readonly content: DraftContent"),
      errors: [expectedReport("nonOperationMember")]
    },
    {
      name: "reports index, call, and construct signatures",
      code: storeInterface(
        "[key: string]: unknown",
        "(input: Input): void",
        "new (input: Input): Store"
      ),
      errors: [
        expectedReport("nonOperationMember"),
        expectedReport("nonOperationMember"),
        expectedReport("nonOperationMember")
      ]
    }
  ]
})

ruleTester.run("iface-006", interfaceOperationCountRule, {
  valid: [
    {
      name: "allows five operations, the limit",
      code: storeInterface(...operations(5))
    },
    {
      name: "leaves inherited operations to review when the interface extends another",
      code: "interface Store extends Reader {}"
    },
    { name: "skips an external augmentation", code: externalAugmentation }
  ],
  invalid: [
    {
      name: "reports six operations, one over the limit",
      code: storeInterface(...operations(6)),
      errors: [expectedCountReport("tooManyOperations", 6)]
    },
    {
      name: "counts each overload, getter, and setter",
      code: storeInterface(
        ...operations(3),
        "operation0(input: string): void",
        "get size(): number",
        "set size(size: number)"
      ),
      errors: [expectedCountReport("tooManyOperations", 6)]
    },
    {
      name: "reports an interface with no operation that extends nothing",
      code: storeInterface("readonly id: string"),
      errors: [expectedReport("noOperations")]
    }
  ]
})

ruleTester.run("iface-008", optionalOperationRule, {
  valid: [
    {
      name: "allows a required operation",
      code: storeInterface("load(): void")
    },
    {
      name: "leaves optional methods of object types to other rules",
      code: "type Store = { load?(): void }"
    },
    { name: "skips an external augmentation", code: externalAugmentation }
  ],
  invalid: [
    {
      name: "reports an optional operation",
      code: storeInterface("load?(): void"),
      errors: [expectedReport("optionalOperation")]
    }
  ]
})

ruleTester.run("iface-010", interfaceOperationRule, {
  valid: [
    {
      name: "allows three positional parameters after a this declaration",
      code: storeInterface(
        "save(this: Store, first: A, second: B, third: C): void"
      )
    },
    {
      name: "does not treat a getter and setter pair as an overload",
      code: storeInterface("get size(): number", "set size(size: number)")
    }
  ],
  invalid: [
    {
      name: "reports four positional parameters",
      code: storeInterface(
        "save(first: A, second: B, third: C, fourth: D): void"
      ),
      errors: [expectedCountReport("tooManyParameters", 4)]
    },
    {
      name: "reports every signature after the first of an overloaded method",
      code: storeInterface(
        "load(id: string): Item",
        "load(ids: string[]): Item[]",
        '"load"(): void'
      ),
      errors: [expectedReport("overload"), expectedReport("overload")]
    }
  ]
})
