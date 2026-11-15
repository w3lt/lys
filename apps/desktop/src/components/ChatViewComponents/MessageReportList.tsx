import type { JobReport } from "@lys/share"
import type { ReactElement } from "react"

import {
  formatJobReportKind,
  formatMessageControlName,
  type JobCardPresentation
} from "./job-presentation"

/** Properties accepted by {@link MessageReportList}. */
export type MessageReportListProps = {
  /** Summary of the disclosure, which says how the reports were delivered. */
  readonly label: string
  /**
   * One-based position of the message among the transcript's user messages,
   * which the summary's name adds after the label.
   */
  readonly messageNumber: number
  /** Reports the message delivered, oldest first. */
  readonly reports: readonly JobReport[]
  /**
   * Cards of the jobs the reports came from, which name their agents; a
   * report whose job has no card is named by its agent's code.
   */
  readonly jobCards: readonly JobCardPresentation[]
}

/**
 * Formats the heading of one delivered report.
 *
 * @param report - The report.
 * @param jobCards - Cards of the jobs the reports came from.
 * @returns `<agent> · <title> · <kind>`, such as `Nyx · News · Result`. The
 * agent is the name on the card of the report's job, else the report's agent
 * code.
 */
function formatReportHeading(
  report: JobReport,
  jobCards: readonly JobCardPresentation[]
): string {
  const card = jobCards.find((jobCard) => jobCard.job.id === report.jobId)
  const agentName = card?.agentName ?? report.agentCode
  return `${agentName} · ${report.title} · ${formatJobReportKind(report.kind)}`
}

/** Properties accepted by {@link DeliveredReport}. */
type DeliveredReportProps = {
  /** Who sent the report, for which job, and what it says. */
  readonly heading: string
  /** Text of the report as the job wrote it; empty when it has none. */
  readonly content: string
}

/**
 * Renders one delivered report: its heading, then its content when it has
 * any.
 *
 * @param props - The report's heading and content.
 * @returns The heading and the content as plain text.
 */
function DeliveredReport({
  heading,
  content
}: DeliveredReportProps): ReactElement {
  return (
    <>
      <p className="chat-view__report-heading">{heading}</p>
      {content !== "" && <p className="chat-view__report-content">{content}</p>}
    </>
  )
}

/**
 * Presents the reports one message delivered as a disclosure that starts
 * collapsed.
 *
 * @remarks The parent owns the label, the message's position, the reports,
 * and the cards that name their agents. The summary shows the label, and its
 * name adds the message, such as `Reports · 1, message 3`, so the reports of
 * different messages have different names. Opening the disclosure shows a
 * list named `Reports`, one item per report in delivery order, each headed
 * by its agent, its job's title, and what it says, such as
 * `Nyx · News · Result`, then its content when it has any. A job wrote that
 * content, so it is untrusted: it is shown as written, line breaks kept, and
 * never rendered as Markdown. The native disclosure owns whether it is open.
 * @param props - The label, the message's position, the reports, and the
 * cards of their jobs.
 * @returns The reports disclosure.
 */
export default function MessageReportList({
  label,
  messageNumber,
  reports,
  jobCards
}: MessageReportListProps): ReactElement {
  return (
    <details className="chat-view__reports">
      <summary
        aria-label={formatMessageControlName(label, messageNumber)}
        className="chat-view__disclosure"
      >
        {label}
      </summary>
      <ul aria-label="Reports" className="chat-view__report-list">
        {reports.map((report) => (
          <li className="chat-view__report" key={report.id}>
            <DeliveredReport
              content={report.content}
              heading={formatReportHeading(report, jobCards)}
            />
          </li>
        ))}
      </ul>
    </details>
  )
}
