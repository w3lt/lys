import { guardClauseRule } from "../rules/func-014.mts"
import { expectedReport, ruleTester } from "./rule-tester.mts"

/** Report of an `else` block after a branch that always exits. */
const elseAfterExit = expectedReport("elseAfterExit")

ruleTester.run("func-014", guardClauseRule, {
  valid: [
    {
      name: "allows the chapter's compliant guard clause",
      code: `function sendMessage(message: Message, transport: MessageTransport): void {
        if (message.text.length === 0) {
          throw new EmptyMessageError()
        }

        transport.send(message)
      }`
    },
    {
      name: "leaves the chapter's noncompliant ordering to review, since no branch before the else exits",
      code: `function sendMessage(message: Message, transport: MessageTransport): void {
        if (message.text.length > 0) {
          transport.send(message)
        } else {
          throw new EmptyMessageError()
        }
      }`
    },
    {
      name: "allows an else if after an exiting branch",
      code: "function pick(a) { if (a) { return 1 } else if (other) { log() } }"
    },
    {
      name: "allows an else after a branch that exits only sometimes",
      code: "function pick(a, b) { if (a) { if (b) { return 1 } } else { log() } }"
    },
    {
      name: "treats a try statement as not exiting",
      code: "function pick(a) { if (a) { try { return 1 } finally { log() } } else { log() } }"
    }
  ],
  invalid: [
    {
      name: "reports an else after return, throw, continue, and break",
      code: `function pick(a, items) {
        if (a) { return 1 } else { log() }
        if (a) { throw new Error("a") } else { log() }
        for (const item of items) {
          if (item) { continue } else { log() }
          if (item) { break } else { log() }
        }
      }`,
      errors: [elseAfterExit, elseAfterExit, elseAfterExit, elseAfterExit]
    },
    {
      name: "reports an else after a branch whose nested if exits on both paths",
      code: "function pick(a, b) { if (a) { if (b) { return 1 } else { return 2 } } else { log() } }",
      errors: [elseAfterExit, elseAfterExit]
    },
    {
      name: "reports the final else of a chain after an exiting else if branch",
      code: "function pick(a, b) { if (a) { log() } else if (b) { return 2 } else { log() } }",
      errors: [elseAfterExit]
    }
  ]
})
