import type { ToolArgumentDefinition, ToolDefinition } from "@lys/share"
import { ChevronRight, Lock } from "lucide-react"
import { useId, type ReactElement } from "react"

import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  TOOL_APPROVALS,
  getToolChoice,
  type ToolApproval,
  type ToolChoice
} from "@/lib/store/tools"

import {
  calculateToolTokenEstimate,
  findToolApproval,
  formatToolAccessLabel,
  formatToolApprovalLabel,
  formatToolApprovalNote,
  formatToolArgumentCounts,
  formatToolArgumentRequirement,
  formatToolArgumentType,
  formatToolGroupCount,
  formatToolGroupLabel,
  formatToolTokenEstimate,
  type ToolGroupListing
} from "./tool-presentation"

/** Properties accepted by {@link ToolArgumentItem}. */
type ToolArgumentItemProps = {
  /** Argument shown by the item. */
  readonly argument: ToolArgumentDefinition
}

/**
 * Presents one argument of a tool: its name, type, requirement, meaning, and,
 * for an enum, every value it accepts.
 *
 * @remarks The list owner supplies the key; the item owns no state or
 * effects. An enum's values form a list named Accepted values, in the order
 * the model is offered them.
 * @param props - Argument shown by the item.
 * @returns One list item describing the argument.
 */
function ToolArgumentItem({ argument }: ToolArgumentItemProps): ReactElement {
  return (
    <li className="settings-view__tool-argument">
      <div className="settings-view__tool-argument-key">
        <span className="settings-view__tool-argument-name">
          {argument.name}
        </span>
        <span className="settings-view__tool-argument-meta">
          <span>{formatToolArgumentType(argument)}</span>
          <span data-required={argument.required ? "" : undefined}>
            {formatToolArgumentRequirement(argument.required)}
          </span>
        </span>
      </div>
      <div className="settings-view__tool-argument-body">
        <p>{argument.description}</p>
        {argument.type === "enum" ? (
          <ul
            aria-label="Accepted values"
            className="settings-view__tool-values"
          >
            {argument.values.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  )
}

/** Properties accepted by {@link ToolApprovalRow}. */
type ToolApprovalRowProps = {
  /** When the tool runs once the model asks for it, owned by the parent. */
  readonly approval: ToolApproval
  /** Whether the tool controls are locked. */
  readonly isLocked: boolean
  /** Proposes another approval for the tool. */
  readonly onApprovalChange: (approval: ToolApproval) => void
}

/**
 * Presents whether Lys asks before a tool runs, with the choice between Ask me
 * and Just run.
 *
 * @remarks The parent owns the approval and the lock; the row owns no state or
 * effects. The approval is a single-choice toggle group named by its label and
 * described by the current approval's note; pressing the selected approval
 * again proposes nothing, and the group is disabled while the controls are
 * locked.
 * @param props - Approval, lock, and the approval proposal.
 * @returns The approval row of a tool's details.
 */
function ToolApprovalRow({
  approval,
  isLocked,
  onApprovalChange
}: ToolApprovalRowProps): ReactElement {
  const approvalLabelId = useId()
  const approvalNoteId = useId()

  /**
   * Proposes the approval the toggle group selected.
   *
   * @param groupValue - Pressed item values the toggle group reports.
   */
  function handleApprovalValueChange(groupValue: string[]): void {
    const nextApproval = findToolApproval(groupValue)
    if (nextApproval !== undefined) onApprovalChange(nextApproval)
  }

  return (
    <div className="settings-view__tool-detail-row">
      <div className="settings-view__identity-lines">
        <h3 id={approvalLabelId}>Before it runs</h3>
        <p id={approvalNoteId}>{formatToolApprovalNote(approval)}</p>
      </div>
      <ToggleGroup
        aria-describedby={approvalNoteId}
        aria-labelledby={approvalLabelId}
        disabled={isLocked}
        onValueChange={handleApprovalValueChange}
        size="sm"
        value={[approval]}
        variant="outline"
      >
        {TOOL_APPROVALS.map((option) => (
          <ToggleGroupItem
            className="settings-view__tool-segment"
            key={option}
            value={option}
          >
            {formatToolApprovalLabel(option)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/** Properties accepted by {@link ToolDetails}. */
type ToolDetailsProps = {
  /** Identifier the row's expand button controls. */
  readonly detailsId: string
  /** Tool whose details are shown. */
  readonly tool: ToolDefinition
  /** Choice the person made for the tool. */
  readonly choice: ToolChoice
  /** Whether the tool controls are locked. */
  readonly isLocked: boolean
  /** Proposes another approval for the tool. */
  readonly onApprovalChange: (approval: ToolApproval) => void
}

/**
 * Presents the details of one expanded tool: its arguments, where it runs,
 * and whether Lys asks before it runs.
 *
 * @remarks The row owns whether the details are shown and the approval; the
 * details own no state or effects. A tool without arguments says so.
 * @param props - Tool, choice, lock, identifier, and the approval proposal.
 * @returns The tool's details.
 */
function ToolDetails({
  detailsId,
  tool,
  choice,
  isLocked,
  onApprovalChange
}: ToolDetailsProps): ReactElement {
  const argumentsHeadingId = useId()

  return (
    <div className="settings-view__tool-details" id={detailsId}>
      <section
        aria-labelledby={argumentsHeadingId}
        className="settings-view__tool-arguments"
      >
        <div className="settings-view__tool-subheading">
          <h3 id={argumentsHeadingId}>arguments</h3>
          <span>{formatToolArgumentCounts(tool.arguments)}</span>
        </div>
        {tool.arguments.length === 0 ? (
          <p className="settings-view__tool-empty">Takes no arguments.</p>
        ) : (
          <ul className="settings-view__tool-argument-list">
            {tool.arguments.map((argument) => (
              <ToolArgumentItem argument={argument} key={argument.name} />
            ))}
          </ul>
        )}
      </section>

      <div className="settings-view__tool-detail-row">
        <div className="settings-view__identity-lines">
          <h3>Runs in Lys</h3>
          <p>
            Handled by the Lys app on this machine. Works whichever runtime you
            point Lys at, and stops when you close Lys.
          </p>
        </div>
        <span className="settings-view__tool-origin">in Lys</span>
      </div>

      <ToolApprovalRow
        approval={choice.approval}
        isLocked={isLocked}
        onApprovalChange={onApprovalChange}
      />
    </div>
  )
}

/** Properties accepted by {@link ToolSummary}. */
type ToolSummaryProps = {
  /** Tool summarized. */
  readonly tool: ToolDefinition
  /** Whether the tool is on and asks before it runs. */
  readonly isAskingFirst: boolean
  /** Identifier given to the tool's name. */
  readonly nameId: string
  /** Identifier given to the access badge. */
  readonly accessId: string
  /** Identifier given to the origin badge. */
  readonly originId: string
  /** Identifier given to the description. */
  readonly descriptionId: string
  /** Identifier given to the note that the tool asks before it runs. */
  readonly asksId: string
}

/**
 * Presents a tool's name, its badges, and its description inside the row's
 * expand button.
 *
 * @remarks The expand button owns the identifiers, which name and describe
 * it; the summary owns no state or effects. When the tool asks first, a
 * decorative lock and a visually hidden note follow the name.
 * @param props - Tool, whether it asks first, and the parent's identifiers.
 * @returns The summary lines of one tool.
 */
function ToolSummary({
  tool,
  isAskingFirst,
  nameId,
  accessId,
  originId,
  descriptionId,
  asksId
}: ToolSummaryProps): ReactElement {
  return (
    <span className="settings-view__tool-lines">
      <span className="settings-view__tool-title">
        <span className="settings-view__tool-name" id={nameId}>
          {tool.name}
        </span>
        {isAskingFirst ? (
          <span className="settings-view__tool-asks">
            <Lock aria-hidden="true" />
            <span className="sr-only" id={asksId}>
              asks before it runs
            </span>
          </span>
        ) : null}
        <span
          className="settings-view__tool-badge"
          data-badge="access"
          id={accessId}
        >
          {formatToolAccessLabel(tool.access)}
        </span>
        <span
          className="settings-view__tool-badge"
          data-badge="origin"
          id={originId}
          title="Runs inside the Lys app"
        >
          in Lys
        </span>
      </span>
      <span className="settings-view__tool-description" id={descriptionId}>
        {tool.description}
      </span>
    </span>
  )
}

/** Properties accepted by {@link ToolRowToggle}. */
type ToolRowToggleProps = {
  /** Tool whose row the button expands. */
  readonly tool: ToolDefinition
  /** Whether the tool is on and asks before it runs. */
  readonly isAskingFirst: boolean
  /** Whether the row's details are shown, owned by the parent. */
  readonly isExpanded: boolean
  /** Whether the tool controls are locked. */
  readonly isLocked: boolean
  /** Identifier of the details the button controls while they are shown. */
  readonly detailsId: string
  /** Proposes showing or hiding the row's details. */
  readonly onIsExpandedChange: (isExpanded: boolean) => void
}

/**
 * Presents the button that expands a tool row into its details.
 *
 * @remarks The parent owns whether the row is expanded and the lock; the
 * button owns no state or effects. It is named by the tool's name, reports
 * whether the details are shown, and is described by the tool's badges,
 * description, and, when the tool asks first, that it asks before it runs.
 * It is disabled while the controls are locked.
 * @param props - Tool, expansion, lock, details identifier, and the proposal.
 * @returns The expand button of one tool row.
 */
function ToolRowToggle({
  tool,
  isAskingFirst,
  isExpanded,
  isLocked,
  detailsId,
  onIsExpandedChange
}: ToolRowToggleProps): ReactElement {
  const nameId = useId()
  const accessId = useId()
  const originId = useId()
  const descriptionId = useId()
  const asksId = useId()
  const describedById = isAskingFirst
    ? `${accessId} ${originId} ${descriptionId} ${asksId}`
    : `${accessId} ${originId} ${descriptionId}`

  return (
    <button
      aria-controls={isExpanded ? detailsId : undefined}
      aria-describedby={describedById}
      aria-expanded={isExpanded}
      aria-labelledby={nameId}
      className="settings-view__tool-toggle"
      disabled={isLocked}
      onClick={() => onIsExpandedChange(!isExpanded)}
      type="button"
    >
      <ChevronRight
        aria-hidden="true"
        className="settings-view__tool-chevron"
      />
      <ToolSummary
        accessId={accessId}
        asksId={asksId}
        descriptionId={descriptionId}
        isAskingFirst={isAskingFirst}
        nameId={nameId}
        originId={originId}
        tool={tool}
      />
    </button>
  )
}

/** Properties accepted by {@link ToolRow}. */
type ToolRowProps = {
  /** Tool shown by the row. */
  readonly tool: ToolDefinition
  /** Choice the person made for the tool. */
  readonly choice: ToolChoice
  /** Whether the row's details are shown, owned by the parent. */
  readonly isExpanded: boolean
  /** Whether the tool controls are locked. */
  readonly isLocked: boolean
  /** Proposes showing or hiding the row's details. */
  readonly onIsExpandedChange: (isExpanded: boolean) => void
  /** Proposes switching the tool on or off. */
  readonly onIsOnChange: (isOn: boolean) => void
  /** Proposes another approval for the tool. */
  readonly onApprovalChange: (approval: ToolApproval) => void
}

/**
 * Presents one tool as a row that expands into its details, beside its token
 * estimate and its switch.
 *
 * @remarks The parent owns whether the row is expanded, the choice, and the
 * lock; the row owns no state or effects. The expand button and the switch
 * are sibling controls. The switch is named Use followed by the tool's name.
 * While the controls are locked, both are disabled.
 * @param props - Tool, choice, expansion, lock, and the parent's proposals.
 * @returns One list item holding the row and, when expanded, its details.
 */
function ToolRow({
  tool,
  choice,
  isExpanded,
  isLocked,
  onIsExpandedChange,
  onIsOnChange,
  onApprovalChange
}: ToolRowProps): ReactElement {
  const detailsId = useId()

  return (
    <li
      className="settings-view__tool-row"
      data-expanded={isExpanded ? "" : undefined}
      data-off={choice.isOn ? undefined : ""}
    >
      <div className="settings-view__tool-header">
        <ToolRowToggle
          detailsId={detailsId}
          isAskingFirst={choice.isOn && choice.approval === "ask"}
          isExpanded={isExpanded}
          isLocked={isLocked}
          onIsExpandedChange={onIsExpandedChange}
          tool={tool}
        />
        <span className="settings-view__tool-tokens">
          {formatToolTokenEstimate(calculateToolTokenEstimate(tool))}
        </span>
        <Switch
          aria-label={`Use ${tool.name}`}
          checked={choice.isOn}
          disabled={isLocked}
          onCheckedChange={(checked) => onIsOnChange(checked)}
          size="lg"
        />
      </div>
      {isExpanded ? (
        <ToolDetails
          choice={choice}
          detailsId={detailsId}
          isLocked={isLocked}
          onApprovalChange={onApprovalChange}
          tool={tool}
        />
      ) : null}
    </li>
  )
}

/** Properties accepted by {@link ToolGroupSection}. */
export type ToolGroupSectionProps = {
  /** Group and its tools, in list order. */
  readonly listing: ToolGroupListing
  /** Choices the person changed, keyed by tool name. */
  readonly toolChoices: ReadonlyMap<string, ToolChoice>
  /** Name of the tool whose details are shown, or null when none is. */
  readonly expandedToolName: string | null
  /** Whether the tool controls are locked. */
  readonly isLocked: boolean
  /** Whether the group recedes because tool calls are off. */
  readonly isDimmed: boolean
  /** Proposes showing one tool's details, or none with null. */
  readonly onExpandedToolNameChange: (toolName: string | null) => void
  /** Proposes switching one tool on or off. */
  readonly onToolOnChange: (toolName: string, isOn: boolean) => void
  /** Proposes another approval for one tool. */
  readonly onToolApprovalChange: (
    toolName: string,
    approval: ToolApproval
  ) => void
}

/**
 * Presents one group of tools under its heading, with how many are on.
 *
 * @remarks The parent owns the listing, the choices, which tool is expanded,
 * the lock, and every proposal; the section owns no state or effects. Tools
 * keep the listing's order and are keyed by name, and at most one is
 * expanded. Expanding a tool collapses any other. The section is named by its
 * heading. While tool calls are off it recedes but stays operable.
 * @param props - Listing, choices, expansion, lock, dimming, and proposals.
 * @returns The section of one tool group.
 */
export function ToolGroupSection({
  listing,
  toolChoices,
  expandedToolName,
  isLocked,
  isDimmed,
  onExpandedToolNameChange,
  onToolOnChange,
  onToolApprovalChange
}: ToolGroupSectionProps): ReactElement {
  const headingId = useId()
  const onToolCount = listing.tools.filter(
    (tool) => getToolChoice(toolChoices, tool.name).isOn
  ).length

  /**
   * Builds the row of one listed tool.
   *
   * @param tool - Listed tool.
   * @returns The tool's row, keyed by its name.
   */
  function buildToolRow(tool: ToolDefinition): ReactElement {
    return (
      <ToolRow
        choice={getToolChoice(toolChoices, tool.name)}
        isExpanded={tool.name === expandedToolName}
        isLocked={isLocked}
        key={tool.name}
        onApprovalChange={(approval) =>
          onToolApprovalChange(tool.name, approval)
        }
        onIsExpandedChange={(isExpanded) =>
          onExpandedToolNameChange(isExpanded ? tool.name : null)
        }
        onIsOnChange={(isOn) => onToolOnChange(tool.name, isOn)}
        tool={tool}
      />
    )
  }

  return (
    <section
      aria-labelledby={headingId}
      className="settings-view__section settings-view__tool-group"
      data-dimmed={isDimmed ? "" : undefined}
    >
      <div className="settings-view__section-heading">
        <h2 id={headingId}>{formatToolGroupLabel(listing.group)}</h2>
        <span>{formatToolGroupCount(onToolCount, listing.tools.length)}</span>
      </div>
      <ul className="settings-view__tool-list">
        {listing.tools.map(buildToolRow)}
      </ul>
    </section>
  )
}
