import { positionalParameterRule } from "../rules/func-004.mts"
import {
  expectedCountReport,
  ruleTester,
  type ExpectedReport
} from "./rule-tester.mts"

/**
 * Builds the report of a function with too many positional parameters.
 *
 * @param count - Positional parameters the function declares.
 * @returns The expected report.
 */
function tooManyParameters(count: number): ExpectedReport<"tooManyParameters"> {
  return expectedCountReport("tooManyParameters", count)
}

ruleTester.run("func-004", positionalParameterRule, {
  valid: [
    {
      name: "allows three positional parameters, the limit",
      code: "function send(message, transport, retries) {}"
    },
    {
      name: "does not count a leading this declaration",
      code: "function send(this: Window, message, transport, retries) {}"
    },
    {
      name: "allows the chapter's compliant named input object",
      code: `
        type CreateMessageInput = {
          conversationId: string
          role: MessageRole
          text: string
          createdAt: Date
          modelId: string
        }

        function createMessage(input: CreateMessageInput): Message {
          return buildMessage(input)
        }
      `
    },
    {
      name: "does not check signatures without an implementation",
      code: "declare function send(a: A, b: B, c: C, d: D): void"
    }
  ],
  invalid: [
    {
      name: "reports four positional parameters, one over the limit",
      code: "function send(message, transport, retries, delay) {}",
      errors: [tooManyParameters(4)]
    },
    {
      name: "reports the chapter's noncompliant five-parameter function",
      code: `
        function createMessage(
          conversationId: string,
          role: MessageRole,
          text: string,
          createdAt: Date,
          modelId: string
        ): Message {
          return buildMessage(conversationId, role, text, createdAt, modelId)
        }
      `,
      errors: [tooManyParameters(5)]
    },
    {
      name: "counts parameters after a this declaration",
      code: "function send(this: Window, a, b, c, d) {}",
      errors: [tooManyParameters(4)]
    },
    {
      name: "reports arrow functions, methods, and rest parameters",
      code: `
        const send = (a, b, c, ...rest) => rest
        class Sender { send(a, b, c, d) {} }
      `,
      errors: [tooManyParameters(4), tooManyParameters(4)]
    }
  ]
})
