import type { Job } from "@lys/share"
import { useRef, type ReactElement } from "react"

import {
  useFocusedRemovalReport,
  useFocusSuccessor
} from "@/components/focus-target"

import { Button } from "../ui/button"
import {
  canStopJob,
  formatJobCardState,
  formatJobElementId,
  type JobCardPresentation,
  type ReplyJobsPresentation
} from "./job-presentation"

/** Properties accepted by {@link ReplyJobList}. */
export type ReplyJobListProps = {
  /** The jobs the reply started and those it only continued. */
  readonly jobs: ReplyJobsPresentation
  /** Opens a job's conversation; receives the job's identity. */
  readonly onOpenJob: (jobId: string) => void
  /** Stops a job's latest reply; receives the job. */
  readonly onStopJob: (job: Job) => void
}

/** Properties accepted by {@link JobStopButton}. */
type JobStopButtonProps = {
  /** Number of the job in its parent, which names the button. */
  readonly jobNumber: number
  /** Requests that the card stop its job. */
  readonly onStopJob: () => void
  /**
   * Requests that the card move focus to the button's successor, because the
   * button leaves while it has focus; called once, in the commit that
   * removes the button. The card moves focus in that commit, when focus fell
   * to the document.
   */
  readonly onFocusSuccessor: () => void
}

/**
 * Renders the Stop button of a working job's card.
 *
 * @remarks The card owns whether the button is shown and where focus goes
 * once it leaves. When the button leaves while it has focus, it asks for its
 * successor through `onFocusSuccessor` before its node is detached, the last
 * moment its focus can be read; a button that leaves without focus asks for
 * nothing.
 * @param props - The job's number and the stop and focus requests.
 * @returns The button, named `Stop job <number>`.
 */
function JobStopButton(props: JobStopButtonProps): ReactElement {
  const { jobNumber, onFocusSuccessor, onStopJob } = props
  const buttonRef = useFocusedRemovalReport(onFocusSuccessor)

  return (
    <Button
      aria-label={`Stop job ${jobNumber}`}
      className="chat-view__job-stop"
      onClick={onStopJob}
      ref={buttonRef}
      size="sm"
      type="button"
      variant="outline"
    >
      Stop
    </Button>
  )
}

/** Properties accepted by {@link JobCard}. */
type JobCardProps = {
  /** What the card shows. */
  readonly card: JobCardPresentation
  /** Opens the job's conversation; receives the job's identity. */
  readonly onOpenJob: (jobId: string) => void
  /** Stops the job's latest reply; receives the job. */
  readonly onStopJob: (job: Job) => void
}

/**
 * Renders the card of one job a reply started.
 *
 * @remarks The card is an article whose element identifier
 * {@link formatJobElementId} gives, so a link can lead to it. Its two
 * controls are siblings: the title, a button named `<title>, job <number>`
 * that opens the job and whose hit area covers the card, and, while the job
 * works, Stop. The agent's name, the card's state, and the job's latest
 * note, when it has one, are plain text. When the job ends while Stop has
 * focus, focus moves to the title in the same commit.
 * @param props - The card and the open and stop callbacks.
 * @returns The job's card.
 */
function JobCard(props: JobCardProps): ReactElement {
  const { card, onOpenJob, onStopJob } = props
  const { job } = card
  const isStoppable = canStopJob(card.state)
  const titleRef = useRef<HTMLButtonElement>(null)
  const handleFocusedStopRemoval = useFocusSuccessor(isStoppable, [titleRef])

  return (
    <article
      className="chat-view__job"
      data-state={card.state}
      id={formatJobElementId(job.id)}
    >
      <button
        aria-label={`${job.title}, job ${job.number}`}
        className="chat-view__job-open"
        onClick={() => onOpenJob(job.id)}
        ref={titleRef}
        type="button"
      >
        {job.title}
      </button>
      <p className="chat-view__job-meta">
        <span>{card.agentName}</span>
        <span className="chat-view__job-state">
          {formatJobCardState(card.state)}
        </span>
      </p>
      {job.latestNote !== null && (
        <p className="chat-view__job-note">{job.latestNote}</p>
      )}
      {isStoppable && (
        <JobStopButton
          jobNumber={job.number}
          onFocusSuccessor={handleFocusedStopRemoval}
          onStopJob={() => onStopJob(job)}
        />
      )}
    </article>
  )
}

/**
 * Renders the jobs one reply shows: the cards of the jobs it started, then
 * one link per job it only continued.
 *
 * @remarks The parent owns the jobs, which job a reply shows, and what
 * opening and stopping a job do. The cards form a list named `Jobs`; each
 * one offers to open its job and, while the job works, to stop it. A link,
 * `Continued job <number> with <agent>`, leads to the card of a job the
 * reply sent a later message, which an earlier reply shows. No list renders
 * for a reply that started no job, and nothing renders for a reply that sent
 * no job a message.
 * @param props - The reply's jobs and the open and stop callbacks.
 * @returns The cards and links, possibly none.
 */
export default function ReplyJobList(props: ReplyJobListProps): ReactElement {
  const { jobs, onOpenJob, onStopJob } = props

  return (
    <>
      {jobs.started.length > 0 && (
        <ul aria-label="Jobs" className="chat-view__job-list">
          {jobs.started.map((card) => (
            <li key={card.job.id}>
              <JobCard
                card={card}
                onOpenJob={onOpenJob}
                onStopJob={onStopJob}
              />
            </li>
          ))}
        </ul>
      )}
      {jobs.continued.map((card) => (
        <p className="chat-view__job-link" key={card.job.id}>
          <a href={`#${formatJobElementId(card.job.id)}`}>
            Continued job {card.job.number} with {card.agentName}
          </a>
        </p>
      ))}
    </>
  )
}
