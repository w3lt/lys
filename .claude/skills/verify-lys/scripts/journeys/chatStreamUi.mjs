/**
 * Journey: in the renderer, sending a message shows the reply streaming
 * with a caret, the whole reply when done, and the titled conversation in
 * Past conversations.
 */

import { rejectUnless } from "../lib/journey.mjs"
import { ESCAPE_KEY } from "../lib/rendererPage.mjs"
import {
  COMPOSER_TEXTAREA,
  LAST_ASSISTANT_TEXT,
  SEND_BUTTON,
  waitForComposerReady
} from "../lib/rendererSteps.mjs"
import {
  VERIFICATION_REPLY_TEXT,
  VERIFICATION_TITLE,
  formatComparableText
} from "../lib/verificationProvider.mjs"
import { VERIFICATION_MESSAGE } from "./chatStreamApi.mjs"

/** Expression that is truthy while the reply streams. */
const STREAMING_CARET_PRESENT = `document.querySelector('[data-testid="streaming-caret"]') !== null`

/** Expression that is truthy once the reply finished. */
const REPLY_FINISHED = `document.querySelector('[data-testid="streaming-caret"]') === null && ${SEND_BUTTON}?.textContent.trim() === "Send"`

/** Opening words of the reply, expected in the mid-stream text. */
const REPLY_OPENING = "Lys verification reply:"

/** Closing words of the reply, expected only in the finished text. */
const REPLY_CLOSING = "all at once."

export default Object.freeze({
  id: "chat-stream-ui",
  feature: "chat-streaming",
  title:
    "Typing a message and pressing Send shows the reply arriving word by word with a streaming caret and a Stop button, then the whole reply, and the titled conversation in Past conversations",
  needsRenderer: true,
  needsNative: false,
  async run(steps, context) {
    const page = await context.openPage()
    try {
      await steps.step(
        "the composer is ready for the default agent",
        async (evidence) => {
          const placeholder = await waitForComposerReady(page, 60_000)
          await page.captureScreenshot(evidence.buildPath("ready.png"))
          return { placeholder }
        }
      )
      await steps.step("type the message and press Send", async () => {
        await page.click(COMPOSER_TEXTAREA)
        await page.typeText(VERIFICATION_MESSAGE)
        await page.waitForPageCondition({
          description: "the Send button to enable",
          expression: `${SEND_BUTTON} !== null && !${SEND_BUTTON}.disabled && ${SEND_BUTTON}.textContent.trim() === "Send"`,
          timeoutMs: 5000
        })
        await page.click(SEND_BUTTON)
        return { message: VERIFICATION_MESSAGE }
      })
      const midStream = await steps.step(
        "the reply streams: caret shown, Stop offered, text partial",
        async (evidence) => {
          await page.waitForPageCondition({
            description: "the streaming caret",
            expression: STREAMING_CARET_PRESENT,
            timeoutMs: 20_000
          })
          await page.captureScreenshot(evidence.buildPath("streaming.png"))
          const partialText = formatComparableText(
            await page.evaluate(LAST_ASSISTANT_TEXT)
          )
          const sendLabel = await page.evaluate(
            `${SEND_BUTTON}?.textContent.trim()`
          )
          evidence.saveJson("mid-stream.json", { partialText, sendLabel })
          rejectUnless(
            sendLabel === "Stop",
            "The send button must read Stop while the reply streams.",
            sendLabel
          )
          rejectUnless(
            partialText.includes(REPLY_OPENING),
            "The mid-stream text must show the reply's opening words.",
            partialText
          )
          rejectUnless(
            !partialText.includes(REPLY_CLOSING),
            "The mid-stream text must not show the reply's closing words yet.",
            partialText
          )
          return { partialText, sendLabel }
        }
      )
      await steps.step(
        "the reply completes with the whole text",
        async (evidence) => {
          await page.waitForPageCondition({
            description: "the reply to finish",
            expression: REPLY_FINISHED,
            timeoutMs: 60_000
          })
          await page.captureScreenshot(evidence.buildPath("complete.png"))
          const finalText = formatComparableText(
            await page.evaluate(LAST_ASSISTANT_TEXT)
          )
          evidence.saveText("final-reply.txt", `${finalText}\n`)
          rejectUnless(
            finalText.includes(formatComparableText(VERIFICATION_REPLY_TEXT)),
            "The transcript must show the provider's whole reply.",
            finalText
          )
          rejectUnless(
            midStream.partialText.length < finalText.length,
            "The mid-stream text must be shorter than the finished text.",
            { partial: midStream.partialText.length, final: finalText.length }
          )
          return {
            partialLength: midStream.partialText.length,
            finalLength: finalText.length
          }
        }
      )
      await steps.step(
        "Past conversations lists the conversation under its generated title",
        async (evidence) => {
          await page.click(
            `document.querySelector('button[title="Past conversations (⌘K)"]')`
          )
          await page.waitForPageCondition({
            description:
              "the Past conversations dialog to list the titled conversation",
            expression: `(() => {
            const dialog = document.querySelector('[aria-label="Past conversations"]');
            return dialog !== null && dialog.textContent.includes(${JSON.stringify(VERIFICATION_TITLE)});
          })()`,
            timeoutMs: 15_000
          })
          await page.captureScreenshot(evidence.buildPath("history.png"))
          await page.pressKey(ESCAPE_KEY)
          return { title: VERIFICATION_TITLE }
        }
      )
    } finally {
      await page.close()
    }
  }
})
