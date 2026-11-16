/**
 * Journey: in the renderer, the person asks Caliginia to give work to a
 * member agent and allows the `delegate_work` call on its approval card;
 * the job's card then shows the member working and its progress note, the
 * lead's reply ends while the job works, and the job's end wakes the lead,
 * which answers once both reports are delivered. The job opens read-only,
 * history lists only the main conversation, and SQLite, the backend's log,
 * and the provider's request log hold what happened.
 *
 * @remarks The fake provider plays both agents from the delegation script in
 * `lib/verificationProvider.mjs`. The backend with its delegation module and
 * activity stream, and the renderer with its stores, are the real code. Only
 * the member agent is stored through the API, before the page opens, so the
 * renderer reads it with the agent list as it starts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sendJsonRequest } from "../lib/httpProbe.mjs"
import { rejectUnless } from "../lib/journey.mjs"
import { ESCAPE_KEY } from "../lib/rendererPage.mjs"
import {
  COMPOSER_NOTICE_TEXTS,
  COMPOSER_TEXTAREA,
  LAST_ASSISTANT_MESSAGE,
  LAST_ASSISTANT_TEXT,
  PAST_CONVERSATIONS_BUTTON,
  PAST_CONVERSATIONS_DIALOG,
  REPLY_FINISHED,
  SEND_BUTTON,
  SEND_ENABLED,
  TOOLS_PANE,
  TOOL_APPROVAL_CARD,
  TRANSCRIPT_MESSAGES,
  buildButtonExpression,
  buildDeliveredReportsExpression,
  buildJobCardExpression,
  buildLabeledButtonExpression,
  buildReportsLineExpression,
  buildSwitchExpression,
  buildToolRowExpression,
  closeSettingsView,
  openSettingsPane,
  readSwitchState,
  waitForComposerReady
} from "../lib/rendererSteps.mjs"
import { readJobRows } from "../lib/sqliteEvidence.mjs"
import {
  DELEGATE_WORK_TOOL_NAME,
  DELEGATION_FINAL_TEXT,
  DELEGATION_INSTRUCTIONS,
  DELEGATION_INTERIM_TEXT,
  DELEGATION_JOB_TITLE,
  DELEGATION_MEMBER,
  DELEGATION_MESSAGE,
  DELEGATION_NOTE,
  REPORTS_BLOCK_OPENING,
  REPORT_PROGRESS_TOOL_NAME,
  VERIFICATION_REPLY_TEXT,
  formatComparableText
} from "../lib/verificationProvider.mjs"
import { waitForCondition } from "../lib/waiting.mjs"

/** Accessible name of the button that opens the job from its card. */
const JOB_CARD_LABEL = `${DELEGATION_JOB_TITLE}, job 1`

/** Text of the line that opens to the reports the wake-up delivered. */
const DELIVERED_REPORTS_LABEL = "Reports · 2"

/**
 * Identities of the delegation the renderer showed, and when the journey
 * started.
 *
 * @typedef {object} ShownDelegation
 * @property {string} mainId - UUIDv7 of the main conversation.
 * @property {string} jobId - UUIDv7 of the job, read from its card.
 * @property {string} startedAt - ISO time the journey started; earlier
 * provider requests belong to other journeys.
 */

/**
 * Stores the member agent unless the backend already has it, since the
 * backend's database carries over between the journeys of one run.
 *
 * @param {string} backendUrl - The backend origin.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<{created: boolean, code: string}>} Whether this step
 * stored it, and its code.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the backend
 * neither has the member nor stores it.
 */
async function saveDelegationMember(backendUrl, evidence) {
  const lookup = await sendJsonRequest(
    `${backendUrl}/api/v1/agents/${DELEGATION_MEMBER.code}`
  )
  evidence.saveJson("agent-lookup.json", lookup)
  if (lookup.status === 200) return { created: false, code: lookup.body.code }
  rejectUnless(
    lookup.status === 404,
    "The agent lookup must find the member or answer 404.",
    lookup
  )
  const creation = await sendJsonRequest(`${backendUrl}/api/v1/agents`, {
    method: "POST",
    json: DELEGATION_MEMBER
  })
  evidence.saveJson("agent-created.json", creation)
  rejectUnless(
    creation.status === 201 && creation.body?.code === DELEGATION_MEMBER.code,
    "Creating the member must answer 201 with its code.",
    creation
  )
  return { created: true, code: creation.body.code }
}

/**
 * Gets the `delegate_work` row of Settings, Tools pane, then closes
 * Settings.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<{groupHeading: string, accessLabel: string, switchState: string}>}
 * The row's group heading, access label, and switch state.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the row is not
 * under agents, does not read `gives work`, or is switched off.
 */
async function getDelegateWorkToolRow(page, evidence) {
  const switchLabel = `Use ${DELEGATE_WORK_TOOL_NAME}`
  await waitForComposerReady(page, 60_000)
  await openSettingsPane(page, TOOLS_PANE)
  const row = await page.waitForPageCondition({
    description: `the ${DELEGATE_WORK_TOOL_NAME} row in the Tools pane`,
    expression: buildToolRowExpression(DELEGATE_WORK_TOOL_NAME),
    timeoutMs: 10_000
  })
  const switchState = await readSwitchState(page, switchLabel)
  await page.evaluate(
    `${buildSwitchExpression(switchLabel)}?.scrollIntoView({ block: "center" })`
  )
  await page.captureScreenshot(evidence.buildPath("tools-pane.png"))
  rejectUnless(
    row.groupHeading === "agents" && row.accessLabel === "gives work",
    `${DELEGATE_WORK_TOOL_NAME} must be listed under agents with the access label "gives work".`,
    row
  )
  rejectUnless(
    switchState === "true",
    `The "${switchLabel}" switch must be on.`,
    switchState
  )
  await closeSettingsView(page)
  return { ...row, switchState }
}

/**
 * Types the delegation message into the composer and presses Send.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page,
 * with the composer ready.
 * @returns {Promise<{message: string}>} The message sent.
 * @throws If Send does not enable within 5 seconds.
 */
async function sendDelegationMessage(page) {
  await page.click(COMPOSER_TEXTAREA)
  await page.typeText(DELEGATION_MESSAGE)
  await page.waitForPageCondition({
    description: "the Send button to enable",
    expression: SEND_ENABLED,
    timeoutMs: 5000
  })
  await page.click(SEND_BUTTON)
  return { message: DELEGATION_MESSAGE }
}

/**
 * Waits for the approval card of the `delegate_work` call, checks what it
 * says, and answers it with Allow once.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<{cardText: string}>} The card's text, whitespace
 * normalised.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the card does not
 * name the tool or describe the job, the member, and its instructions.
 */
async function sendDelegateWorkApproval(page, evidence) {
  const expectedSummary = `Give ${DELEGATION_MEMBER.code} the job “${DELEGATION_JOB_TITLE}”. It gets only these instructions: ${DELEGATION_INSTRUCTIONS}`
  const cardText = await page.waitForPageCondition({
    description: "the approval card of the delegate_work call",
    expression: `${TOOL_APPROVAL_CARD}?.innerText ?? false`,
    timeoutMs: 20_000
  })
  await page.captureScreenshot(evidence.buildPath("approval-card.png"))
  const comparableText = formatComparableText(cardText)
  evidence.saveText("approval-card.txt", `${cardText}\n`)
  rejectUnless(
    comparableText.includes(DELEGATE_WORK_TOOL_NAME) &&
      comparableText.includes(expectedSummary),
    `The approval card must name ${DELEGATE_WORK_TOOL_NAME} and read: ${expectedSummary}`,
    comparableText
  )
  await page.click(buildButtonExpression("Allow once"))
  await page.waitForPageCondition({
    description: "the approval card to go once the call is allowed",
    expression: `${TOOL_APPROVAL_CARD} === null`,
    timeoutMs: 10_000
  })
  return { cardText: comparableText }
}

/**
 * Waits until the job's card shows the progress note, and checks that the
 * member still works then.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<object>} The card as read, with the job's identity from
 * its element identifier as `jobId`.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the card does not
 * sit in the lead's reply, name the member, read Working, or offer Stop.
 */
async function waitForWorkingJobCard(page, evidence) {
  const card = await page.waitForPageCondition({
    description: "the job's card to show the progress note",
    expression: `(() => {
      const card = ${buildJobCardExpression(JOB_CARD_LABEL)};
      return card?.note === ${JSON.stringify(DELEGATION_NOTE)} ? card : false;
    })()`,
    timeoutMs: 20_000
  })
  await page.captureScreenshot(evidence.buildPath("job-working.png"))
  evidence.saveJson("job-card.json", card)
  rejectUnless(
    card.state === "working" && card.stateLabel === "Working",
    "The card must read Working while the member works.",
    card
  )
  rejectUnless(
    card.agentName === DELEGATION_MEMBER.name,
    `The card must name the member, ${DELEGATION_MEMBER.name}.`,
    card
  )
  rejectUnless(
    card.isInReply && card.hasStop,
    "The card must sit in the lead's reply and offer Stop while the job works.",
    card
  )
  return { ...card, jobId: card.elementId.replace(/^job-/, "") }
}

/**
 * Waits until the lead's reply has ended with its interim text, and checks
 * that the job still works then and the jobs bar offers to stop it.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<object>} The reply's text, the notices, the card, and
 * whether Stop all jobs is offered.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the job ended
 * first or the jobs bar does not read `1 job is working` with Stop all jobs.
 */
async function waitForInterimReplyEnd(page, evidence) {
  const notices = await page.waitForPageCondition({
    description: "the lead's reply to end with its interim text",
    expression: `(() => {
      const isEnded = ${REPLY_FINISHED} && ${LAST_ASSISTANT_TEXT}.includes(${JSON.stringify(DELEGATION_INTERIM_TEXT)});
      return isEnded ? ${COMPOSER_NOTICE_TEXTS} : false;
    })()`,
    timeoutMs: 20_000
  })
  await page.captureScreenshot(evidence.buildPath("lead-reply-ended.png"))
  const card = await page.evaluate(buildJobCardExpression(JOB_CARD_LABEL))
  const hasStopAll = await page.evaluate(
    `${buildLabeledButtonExpression("Stop all jobs")} !== null`
  )
  evidence.saveJson("lead-reply-ended.json", { notices, card, hasStopAll })
  rejectUnless(
    card?.state === "working",
    "The job must still work when the lead's reply ends.",
    card
  )
  rejectUnless(
    notices.includes("1 job is working") && hasStopAll,
    "The jobs bar must read 1 job is working and offer Stop all jobs.",
    { notices, hasStopAll }
  )
  return { notices, hasStopAll, cardState: card.state }
}

/**
 * Opens the reports the wake-up delivered once the job has replied and the
 * lead's woken reply has ended, and checks them.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<object>} The card's state label, the delivered reports,
 * and the lead's last reply.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the card does not
 * read Replied, the reports are not the note and the result in that order,
 * or the lead's last reply is not the final text.
 */
async function openDeliveredReports(page, evidence) {
  await page.waitForPageCondition({
    description: `the job to reply, ${DELIVERED_REPORTS_LABEL} to show, and the lead's woken reply to end`,
    expression: `${buildJobCardExpression(JOB_CARD_LABEL)}?.state === "replied" && ${buildReportsLineExpression(DELIVERED_REPORTS_LABEL)} !== undefined && ${REPLY_FINISHED} && ${LAST_ASSISTANT_TEXT}.includes(${JSON.stringify(DELEGATION_FINAL_TEXT)})`,
    timeoutMs: 60_000
  })
  await page.click(buildReportsLineExpression(DELIVERED_REPORTS_LABEL))
  const delivered = await page.waitForPageCondition({
    description: `the reports under ${DELIVERED_REPORTS_LABEL} to open`,
    expression: `(() => {
      const delivered = ${buildDeliveredReportsExpression(DELIVERED_REPORTS_LABEL)};
      return delivered?.isOpen ? delivered : false;
    })()`,
    timeoutMs: 5000
  })
  await page.evaluate(
    `${LAST_ASSISTANT_MESSAGE}?.scrollIntoView({ block: "end" })`
  )
  await page.captureScreenshot(evidence.buildPath("lead-woken.png"))
  const card = await page.evaluate(buildJobCardExpression(JOB_CARD_LABEL))
  const lastReply = formatComparableText(
    await page.evaluate(LAST_ASSISTANT_TEXT)
  )
  evidence.saveJson("lead-woken.json", { card, delivered, lastReply })
  rejectUnless(
    card.stateLabel === "Replied",
    "The card must read Replied.",
    card
  )
  parseDeliveredReports(delivered.reports)
  rejectUnless(
    lastReply.endsWith(DELEGATION_FINAL_TEXT),
    `The lead's last reply must end as ${DELEGATION_FINAL_TEXT}`,
    lastReply
  )
  return { cardState: card.stateLabel, reports: delivered.reports, lastReply }
}

/**
 * Checks the reports the wake-up message delivered, as its line shows them.
 *
 * @param {readonly {heading: string | null, content: string}[]} reports -
 * The reports in shown order.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If they are not the
 * member's progress note and then its result, each with its text.
 */
function parseDeliveredReports(reports) {
  const headingStart = `${DELEGATION_MEMBER.name} · ${DELEGATION_JOB_TITLE} · `
  rejectUnless(
    reports.map((report) => report.heading).join("\n") ===
      `${headingStart}Progress note\n${headingStart}Result`,
    "The delivered reports must be the member's progress note, then its result.",
    reports
  )
  rejectUnless(
    reports[0].content === DELEGATION_NOTE &&
      formatComparableText(reports[1].content) ===
        formatComparableText(VERIFICATION_REPLY_TEXT),
    "The note must hold the member's note and the result its whole reply.",
    reports
  )
}

/**
 * Opens the job from its card and checks that it shows read-only.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page,
 * showing the main conversation.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<object>} The job's notice, its message count, and
 * whether the message field and Send are disabled.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the job does not
 * show the lead's instructions, the member's whole reply, and a disabled
 * field and Send.
 */
async function openJobView(page, evidence) {
  const leadName = "Caliginia"
  const notice = `This is a job from ${leadName}. You can read it and stop it.`
  await page.click(buildLabeledButtonExpression(JOB_CARD_LABEL))
  await page.waitForPageCondition({
    description: "the job's read-only notice and the member's whole reply",
    expression: `${COMPOSER_NOTICE_TEXTS}.includes(${JSON.stringify(notice)}) && ${LAST_ASSISTANT_TEXT}.includes("all at once.")`,
    timeoutMs: 15_000
  })
  await page.captureScreenshot(evidence.buildPath("job-view.png"))
  const messages = await page.evaluate(TRANSCRIPT_MESSAGES)
  const reply = formatComparableText(await page.evaluate(LAST_ASSISTANT_TEXT))
  const isFieldDisabled = await page.evaluate(
    `${COMPOSER_TEXTAREA}.disabled && ${SEND_BUTTON}.disabled`
  )
  evidence.saveJson("job-view.json", { messages, reply, isFieldDisabled })
  const [delegatorMessage] = messages
  rejectUnless(
    delegatorMessage?.speaker === leadName &&
      delegatorMessage.copy?.includes(DELEGATION_INSTRUCTIONS),
    `The job must open with ${leadName}'s message holding the instructions.`,
    messages
  )
  rejectUnless(
    messages.at(-1)?.speaker === DELEGATION_MEMBER.name &&
      reply.includes(formatComparableText(VERIFICATION_REPLY_TEXT)),
    "The job must end with the member's whole reply under its name.",
    { messages, reply }
  )
  rejectUnless(
    isFieldDisabled,
    "The job's message field and its Send button must be disabled."
  )
  return { notice, messageCount: messages.length, isFieldDisabled }
}

/**
 * Gets the job as its read-only view shows it, then goes back to the main
 * conversation.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page,
 * showing the main conversation.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<object>} What {@link openJobView} read, and that the main
 * conversation shows again.
 * @throws As {@link openJobView} and {@link closeJobView} do.
 */
async function getReadOnlyJob(page, evidence) {
  const shown = await openJobView(page, evidence)
  const closed = await closeJobView(page, evidence)
  return { ...shown, ...closed }
}

/**
 * Leaves the job with Back to the conversation and waits for the main
 * conversation with the job's card and the lead's last reply.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page,
 * showing the job.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<{isMainShown: boolean}>} That the main conversation shows.
 * @throws If the main conversation does not show within 15 seconds.
 */
async function closeJobView(page, evidence) {
  await page.click(buildButtonExpression("Back to the conversation"))
  await page.waitForPageCondition({
    description:
      "the main conversation with the job's card and the lead's last reply",
    expression: `${COMPOSER_NOTICE_TEXTS}.length === 0 && ${buildJobCardExpression(JOB_CARD_LABEL)} !== null && ${LAST_ASSISTANT_TEXT}.includes(${JSON.stringify(DELEGATION_FINAL_TEXT)})`,
    timeoutMs: 15_000
  })
  await page.captureScreenshot(evidence.buildPath("main-again.png"))
  return { isMainShown: true }
}

/**
 * Gets the job and the main conversation over the API, and the history
 * list, which must hold the main conversation and not the job.
 *
 * @param {string} backendUrl - The backend origin.
 * @param {string} jobId - UUIDv7 of the job, from its card.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<{mainId: string, mainTitle: string}>} The main
 * conversation's identity and title.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the job is not a
 * job, or the history list lacks the main conversation or holds the job.
 */
async function getHistoryConversations(backendUrl, jobId, evidence) {
  const conversationsUrl = `${backendUrl}/api/v1/conversations`
  const job = await sendJsonRequest(`${conversationsUrl}/${jobId}`)
  rejectUnless(
    job.status === 200 && job.body.kind === "job",
    "The card's job must be stored as a job.",
    job
  )
  const mainId = job.body.parentConversationId
  const main = await sendJsonRequest(`${conversationsUrl}/${mainId}`)
  const history = await sendJsonRequest(conversationsUrl)
  evidence.saveJson("conversations.json", { job, main, history })
  const listedIds = history.body.conversations.map(
    (conversation) => conversation.id
  )
  rejectUnless(
    listedIds.includes(mainId) && !listedIds.includes(jobId),
    "GET /api/v1/conversations must list the main conversation and not the job.",
    { mainId, jobId, listedIds }
  )
  return { mainId, mainTitle: main.body.title }
}

/**
 * Gets what history shows of the delegation: the conversation list over the
 * API, then the Past conversations dialog.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {{backendUrl: string, jobId: string}} lookup - The backend origin,
 * and UUIDv7 of the job, from its card.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<{mainId: string, mainTitle: string, isJobListed: boolean}>}
 * The main conversation's identity and title, and that the dialog leaves the
 * job out.
 * @throws {import("../lib/journey.mjs").JourneyFailure} As
 * {@link getHistoryConversations} and {@link getHistoryDialog} do.
 */
async function getDelegationHistory(page, lookup, evidence) {
  const listed = await getHistoryConversations(
    lookup.backendUrl,
    lookup.jobId,
    evidence
  )
  const shown = await getHistoryDialog(page, listed.mainTitle, evidence)
  return { ...listed, ...shown }
}

/**
 * Opens Past conversations and checks that it lists the main conversation's
 * title and not the job's.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {string} mainTitle - The main conversation's title.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<{isJobListed: boolean}>} That the dialog leaves the job
 * out.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the dialog does
 * not list the main title in 15 seconds or lists the job's title.
 */
async function getHistoryDialog(page, mainTitle, evidence) {
  await page.click(PAST_CONVERSATIONS_BUTTON)
  const dialogText = await page.waitForPageCondition({
    description: "the Past conversations dialog to list the main conversation",
    expression: `(() => {
      const dialog = ${PAST_CONVERSATIONS_DIALOG};
      return dialog?.textContent.includes(${JSON.stringify(mainTitle)}) ? dialog.innerText : false;
    })()`,
    timeoutMs: 15_000
  })
  await page.captureScreenshot(evidence.buildPath("history.png"))
  await page.pressKey(ESCAPE_KEY)
  const isJobListed = dialogText.includes(DELEGATION_JOB_TITLE)
  rejectUnless(
    !isJobListed,
    "Past conversations must not list the job.",
    dialogText
  )
  return { isJobListed }
}

/**
 * Checks the stored job and its job message.
 *
 * @param {{jobs: object[], jobMessages: object[]}} rows - Rows from
 * {@link readJobRows}.
 * @param {ShownDelegation} delegation - The identities the renderer showed.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the main
 * conversation does not have exactly the one job, numbered 1, for the
 * member, under its title, whose only message is the lead's job message for
 * the main conversation's `delegate_work` call.
 */
function parseJobRows(rows, delegation) {
  const [job] = rows.jobs
  rejectUnless(
    rows.jobs.length === 1 && job.id === delegation.jobId,
    "The main conversation must have exactly the job its card showed.",
    rows.jobs
  )
  rejectUnless(
    job.job_number === 1 &&
      job.agent_code === DELEGATION_MEMBER.code &&
      job.title === DELEGATION_JOB_TITLE,
    `The job must be job 1 of ${DELEGATION_MEMBER.code}, titled ${DELEGATION_JOB_TITLE}.`,
    job
  )
  const [message] = rows.jobMessages
  rejectUnless(
    rows.jobMessages.length === 1 &&
      message.origin === "delegator" &&
      message.content.includes(DELEGATION_INSTRUCTIONS),
    "The job's only message must be the lead's, holding the instructions.",
    rows.jobMessages
  )
  rejectUnless(
    message.call_conversation_id === delegation.mainId &&
      message.call_tool_name === DELEGATE_WORK_TOOL_NAME,
    "The job message must name the main conversation's delegate_work call.",
    message
  )
}

/**
 * Checks the stored reports of the job.
 *
 * @param {readonly object[]} reports - Report rows from {@link readJobRows},
 * oldest first.
 * @param {string} mainId - UUIDv7 of the main conversation.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If they are not a
 * note with the note's text and a result with the member's reply, both
 * delivered by one wake-up message of the main conversation.
 */
function parseReportRows(reports, mainId) {
  const [note, result] = reports
  rejectUnless(
    reports.map((report) => report.kind).join() === "note,result",
    "The job must have stored a note, then a result.",
    reports
  )
  rejectUnless(
    note.content === DELEGATION_NOTE &&
      formatComparableText(result.content) ===
        formatComparableText(VERIFICATION_REPLY_TEXT),
    "The note must hold the member's note and the result its whole reply.",
    reports
  )
  rejectUnless(
    note.delivered_message_id !== null &&
      note.delivered_message_id === result.delivered_message_id,
    "Both reports must be delivered with one message.",
    reports
  )
  rejectUnless(
    note.delivered_conversation_id === mainId &&
      note.delivered_origin === "wake-up",
    "The delivering message must be a wake-up message of the main conversation.",
    note
  )
}

/**
 * Lists the backend's own log entries about one conversation.
 *
 * @param {string} lysHome - The scratch Lys home.
 * @param {string} conversationId - UUIDv7 the entries name as
 * `conversationId`.
 * @returns {object[]} The parsed entries in log order; a line that is not
 * JSON is skipped.
 */
function listConversationLogEntries(lysHome, conversationId) {
  const logsDir = join(lysHome, "logs")
  if (!existsSync(logsDir)) return []
  return readdirSync(logsDir)
    .filter((name) => name.startsWith("backend-") && name.endsWith(".log"))
    .flatMap((name) => readFileSync(join(logsDir, name), "utf8").split("\n"))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.conversationId === conversationId)
}

/**
 * Finds the delegation's entries about the main conversation in the
 * backend's log.
 *
 * @param {string} lysHome - The scratch Lys home.
 * @param {string} mainId - UUIDv7 of the main conversation.
 * @returns {object[]} The entries about the main conversation, once exactly
 * one names the work given, two the stored reports (a note and a result),
 * and one the started wake-up turn.
 * @throws {Error} Naming how often each was logged, while the counts differ.
 */
function findDelegationLogEntries(lysHome, mainId) {
  const expectedCounts = {
    "An agent gave work to another agent": 1,
    "A job report was stored": 2,
    "A wake-up turn started": 1
  }
  const entries = listConversationLogEntries(lysHome, mainId)
  const counts = Object.fromEntries(
    Object.keys(expectedCounts).map((message) => [
      message,
      entries.filter((entry) => entry.msg === message).length
    ])
  )
  if (JSON.stringify(counts) === JSON.stringify(expectedCounts)) return entries
  throw new Error(`The log holds ${JSON.stringify(counts)}.`)
}

/**
 * Waits until the backend's log holds the delegation's entries about the
 * main conversation.
 *
 * @param {string} lysHome - The scratch Lys home.
 * @param {string} mainId - UUIDv7 of the main conversation.
 * @returns {Promise<object[]>} The entries {@link findDelegationLogEntries}
 * finds.
 * @throws {import("../lib/waiting.mjs").WaitTimeoutError} If the log does
 * not hold them within 5 seconds, with the counts last seen.
 */
function waitForDelegationLogEntries(lysHome, mainId) {
  return waitForCondition({
    description:
      "the backend's log to record the work given, both reports, and the wake-up",
    timeoutMs: 5000,
    check: () => findDelegationLogEntries(lysHome, mainId)
  })
}

/**
 * Lists the streamed chat requests the provider logged since a time.
 *
 * @param {string} logPath - The provider's NDJSON request log.
 * @param {string} sinceIso - ISO time; earlier requests are left out.
 * @returns {object[]} The streamed chat completion requests, oldest first.
 */
function listStreamedChatRequests(logPath, sinceIso) {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .filter(
      (entry) =>
        entry.at >= sinceIso &&
        entry.stream === true &&
        entry.path === "/v1/chat/completions"
    )
}

/**
 * Answers whether a logged request ends with a user message holding a text.
 *
 * @param {object} request - One logged request.
 * @param {string} text - Text the last message must contain.
 * @returns {boolean} True when the last message is a user message with it.
 */
function isUserMessageRequest(request, text) {
  return (
    request.lastMessageRole === "user" &&
    request.lastUserContent?.includes(text) === true
  )
}

/**
 * Answers whether a logged request ends with a tool result the fake
 * answered with a text.
 *
 * @param {object} request - One logged request.
 * @param {string} answerText - The text the fake streamed back.
 * @returns {boolean} True when the last message is a tool result and the
 * answer is that text, which tells which tool's call the result answers.
 */
function isToolResultRequest(request, answerText) {
  return (
    request.lastMessageRole === "tool" &&
    request.scriptedAnswer?.text === answerText
  )
}

/**
 * Lists the five streamed requests delegation makes the provider answer.
 *
 * @returns {{description: string, isMatch: (request: object) => boolean}[]}
 * What each request ends with, and the predicate that recognises it: the
 * lead's request for the delegation message, its request after the
 * `delegate_work` result, the member's request for the instructions, its
 * request after the `report_progress` result, and the lead's wake-up
 * request for the reports.
 */
function listExpectedProviderRequests() {
  return [
    {
      description: "the delegation message while delegate_work is offered",
      isMatch: (request) =>
        isUserMessageRequest(request, DELEGATION_MESSAGE) &&
        request.offeredToolNames.includes(DELEGATE_WORK_TOOL_NAME)
    },
    {
      description: "the delegate_work result, answered with the interim reply",
      isMatch: (request) =>
        isToolResultRequest(request, DELEGATION_INTERIM_TEXT)
    },
    {
      description: "the job's instructions while report_progress is offered",
      isMatch: (request) =>
        isUserMessageRequest(request, DELEGATION_INSTRUCTIONS) &&
        request.offeredToolNames.includes(REPORT_PROGRESS_TOOL_NAME)
    },
    {
      description:
        "the report_progress result, answered with the member's reply",
      isMatch: (request) =>
        isToolResultRequest(request, VERIFICATION_REPLY_TEXT)
    },
    {
      description: "the reports block, answered with the final reply",
      isMatch: (request) =>
        isUserMessageRequest(request, REPORTS_BLOCK_OPENING) &&
        request.scriptedAnswer?.text === DELEGATION_FINAL_TEXT
    }
  ]
}

/**
 * Checks the streamed requests the provider answered during the journey.
 *
 * @param {readonly object[]} requests - From {@link listStreamedChatRequests}.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If there are not
 * exactly the five requests of {@link listExpectedProviderRequests}, one
 * each, or the member was offered `delegate_work`.
 */
function parseProviderRequests(requests) {
  const expectedRequests = listExpectedProviderRequests()
  rejectUnless(
    requests.length === expectedRequests.length,
    `The provider must have streamed exactly ${expectedRequests.length} chat requests during the journey.`,
    requests
  )
  for (const expected of expectedRequests)
    rejectUnless(
      requests.filter(expected.isMatch).length === 1,
      `Exactly one streamed request must end with ${expected.description}.`,
      requests
    )
  const memberRequest = requests.find(expectedRequests[2].isMatch)
  rejectUnless(
    !memberRequest.offeredToolNames.includes(DELEGATE_WORK_TOOL_NAME),
    "The member, which may not give work, must not be offered delegate_work.",
    memberRequest
  )
}

/**
 * Gets what the delegation stored and logged: the SQLite rows, the backend's
 * log entries, and the provider's streamed requests.
 *
 * @param {object} context - The journey context, for the run's paths.
 * @param {ShownDelegation} delegation - The identities the renderer showed.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder.
 * @returns {Promise<object>} The counts and kinds that were checked.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the rows or the
 * requests break their checks; a wait failure if the log lacks an entry.
 */
async function getStoredDelegation(context, delegation, evidence) {
  const rows = readJobRows(
    join(context.paths.lysHome, "lys_db.sqlite"),
    delegation.mainId
  )
  evidence.saveJson("sqlite-rows.json", rows)
  parseJobRows(rows, delegation)
  parseReportRows(rows.reports, delegation.mainId)
  const logEntries = await waitForDelegationLogEntries(
    context.paths.lysHome,
    delegation.mainId
  )
  evidence.saveJson("backend-log.json", logEntries)
  const requests = listStreamedChatRequests(
    join(context.paths.logsDir, "provider-requests.ndjson"),
    delegation.startedAt
  )
  evidence.saveJson("provider-requests.json", requests)
  parseProviderRequests(requests)
  return {
    jobNumbers: rows.jobs.map((job) => job.job_number),
    reportKinds: rows.reports.map((report) => report.kind),
    logMessages: logEntries.map((entry) => entry.msg),
    streamedRequestCount: requests.length
  }
}

/**
 * Runs the steps that start the delegation in the renderer: the switch in
 * Settings, the message, and the person's approval of the call.
 *
 * @param {import("../lib/journey.mjs").StepRunner} steps - The journey's
 * step runner.
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @returns {Promise<void>} Resolves once the call is allowed.
 * @throws Whatever a step throws; the steps after it do not run.
 */
async function sendDelegation(steps, page) {
  await steps.step(
    "the Tools pane of Settings lists delegate_work under agents as gives work, switched on; Done goes back to the chat",
    (evidence) => getDelegateWorkToolRow(page, evidence)
  )
  await steps.step("type the delegation message and press Send", () =>
    sendDelegationMessage(page)
  )
  await steps.step(
    "the approval card describes the delegate_work call; Allow once",
    (evidence) => sendDelegateWorkApproval(page, evidence)
  )
}

/**
 * Runs the steps that follow the allowed job to the lead's final answer.
 *
 * @param {import("../lib/journey.mjs").StepRunner} steps - The journey's
 * step runner.
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @returns {Promise<string>} UUIDv7 of the job, read from its card.
 * @throws Whatever a step throws; the steps after it do not run.
 */
async function waitForDelegationEnd(steps, page) {
  const card = await steps.step(
    "the job's card shows in the lead's reply: Verifier, Working, and its progress note",
    (evidence) => waitForWorkingJobCard(page, evidence)
  )
  await steps.step(
    "the lead's reply ends while the job works: Send is back and the jobs bar reads 1 job is working with Stop all jobs",
    (evidence) => waitForInterimReplyEnd(page, evidence)
  )
  await steps.step(
    "the job replies and wakes the lead: the card reads Replied, Reports · 2 opens to the note and the result, and the lead answers",
    (evidence) => openDeliveredReports(page, evidence)
  )
  return card.jobId
}

export default Object.freeze({
  id: "agent-delegation-ui",
  feature: "agent-delegation",
  title:
    "Asking Caliginia to give work to a member and allowing the delegate_work call shows the job's card working with its progress note, ends the lead's reply while the job works, and wakes the lead with both reports when the job replies; the job opens read-only, history lists only the main conversation, and SQLite, the backend's log, and the provider's requests agree",
  needsRenderer: true,
  needsNative: false,
  async run(steps, context) {
    const startedAt = new Date().toISOString()
    await steps.step(
      "a member agent exists: GET /api/v1/agents/verify-member, then POST /api/v1/agents when it is missing",
      (evidence) => saveDelegationMember(context.backendUrl, evidence)
    )
    const page = await context.openPage()
    try {
      await sendDelegation(steps, page)
      const jobId = await waitForDelegationEnd(steps, page)
      await steps.step(
        "the job opens read-only, and Back to the conversation shows the main conversation again",
        (evidence) => getReadOnlyJob(page, evidence)
      )
      const history = await steps.step(
        "history lists the main conversation and not the job, over the API and in Past conversations",
        (evidence) =>
          getDelegationHistory(
            page,
            { backendUrl: context.backendUrl, jobId },
            evidence
          )
      )
      await steps.step(
        "SQLite, the backend's log, and the provider's requests hold the job, its two reports, and the wake-up",
        (evidence) =>
          getStoredDelegation(
            context,
            { ...history, jobId, startedAt },
            evidence
          )
      )
    } finally {
      await page.close()
    }
  }
})
