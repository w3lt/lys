import { Blocks, Bookmark, Paperclip, Plus, Waypoints } from "lucide-react"
import type { ComponentType } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

/** One capability shown in the menu ahead of the work that will provide it. */
type UnwiredComposerAction = {
  /** Visible name of the planned capability. */
  readonly label: string
  /** Icon rendered beside the label. */
  readonly Icon: ComponentType<{ "aria-hidden"?: boolean }>
}

/**
 * Capabilities the menu announces but cannot perform yet.
 *
 * @remarks These entries are permanently disabled and marked `soon`. They are
 * listed so the menu's shape is settled, and each becomes actionable only when
 * the capability behind it exists.
 */
const UNWIRED_COMPOSER_ACTIONS: readonly UnwiredComposerAction[] = [
  { label: "Connect an app", Icon: Waypoints },
  { label: "Plugins", Icon: Blocks },
  { label: "Saved prompts", Icon: Bookmark }
]

/** Properties accepted by {@link ComposerPlusMenu}. */
export type ComposerPlusMenuProps = {
  /** Whether the trigger and every action are unavailable. */
  readonly disabled: boolean
  /** Whether the tray currently holds at least one file. */
  readonly hasAttachments: boolean
  /** Invoked once when the user chooses to attach a file. */
  readonly onAttachFile: () => void
}

/**
 * Offers the actions that add context to the next message.
 *
 * @remarks Primary category: interactive feature. The parent owns availability,
 * whether the tray is occupied, and the attach action; this component owns only
 * the menu's open state, which the underlying menu adapter holds. Keyboard
 * navigation, dismissal, and focus return belong to that adapter. Only "Attach
 * a file" is actionable; {@link UNWIRED_COMPOSER_ACTIONS} render disabled and
 * marked `soon`, and their absence of a handler is deliberate rather than an
 * omission. The trigger reflects an occupied tray through a tone change and
 * through its accessible name, not through color alone.
 *
 * @param props - Availability, tray occupancy, and the attach callback.
 * @returns The composer's add-to-message menu.
 */
export default function ComposerPlusMenu({
  disabled,
  hasAttachments,
  onAttachFile
}: ComposerPlusMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={
          hasAttachments
            ? "Add to this message; files are attached"
            : "Add to this message"
        }
        className="composer__plus"
        data-occupied={hasAttachments ? "" : undefined}
        disabled={disabled}
        title="Add to this message"
      >
        <Plus aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="composer__menu" side="top">
        <DropdownMenuItem onClick={onAttachFile}>
          <Paperclip aria-hidden="true" />
          Attach a file
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel className="composer__menu-eyebrow">
            not yet wired
          </DropdownMenuLabel>

          {UNWIRED_COMPOSER_ACTIONS.map(({ label, Icon }) => (
            <DropdownMenuItem disabled key={label}>
              <Icon aria-hidden={true} />
              <span className="composer__menu-grow">{label}</span>
              <span className="composer__menu-tag">soon</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
