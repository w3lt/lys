import { approvedFolderPathSchema } from "@lys/share"
import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement
} from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** Why a typed folder cannot be added. */
type FolderProblem = "invalid" | "listed"

/** What the person reads for each problem with a typed folder. */
const FOLDER_PROBLEM_MESSAGES = Object.freeze({
  invalid:
    "Type an absolute path that starts with /, such as /Users/you/Projects, in at most 1024 characters, on one line.",
  listed: "This folder is already listed."
} satisfies Readonly<Record<FolderProblem, string>>)

/** Properties accepted by {@link ApprovedFoldersCard}. */
type ApprovedFoldersCardProps = {
  /** Folders the person lets tools use, in the listed order. */
  readonly folderPaths: readonly string[]
  /** Requests that the parent add a folder whose path passed the rule. */
  readonly onAddFolder: (folderPath: string) => void
  /** Requests that the parent remove a listed folder. */
  readonly onRemoveFolder: (folderPath: string) => void
}

/**
 * Presents the folders the person lets tools use: the list, each with
 * Remove, and a field to add one.
 *
 * @remarks The application store owns the list and saves it; the card owns
 * only the typed path and why it cannot be added. Enter or Add folder asks
 * the parent to add the trimmed path when it passes the shared approved
 * folder path rule and is not listed yet, then empties the field; otherwise
 * the field says what to change, until the person types again. Remove asks
 * the parent to remove the folder and moves focus to the field, because the
 * button leaves with its row. Whether the folder exists is not checked.
 * @param props - The list and the requests to change it.
 * @returns The card.
 */
export default function ApprovedFoldersCard({
  folderPaths,
  onAddFolder,
  onRemoveFolder
}: ApprovedFoldersCardProps): ReactElement {
  const [typedPath, setTypedPath] = useState("")
  const [problem, setProblem] = useState<FolderProblem | undefined>(undefined)
  const fieldRef = useRef<HTMLInputElement>(null)
  const cardId = useId()
  const fieldId = `${cardId}-field`
  const problemId = `${cardId}-problem`
  const folderPath = typedPath.trim()

  /**
   * Adds the typed folder when it can be added, or says why not.
   *
   * @param event - Submit event of the form.
   */
  function handleAddFolder(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (folderPath === "") return
    if (!approvedFolderPathSchema.safeParse(folderPath).success) {
      setProblem("invalid")
      return
    }
    if (folderPaths.includes(folderPath)) {
      setProblem("listed")
      return
    }
    onAddFolder(folderPath)
    setTypedPath("")
    setProblem(undefined)
  }

  /**
   * Removes a listed folder and keeps focus in the card.
   *
   * @param listedPath - Folder to remove.
   */
  function handleRemoveFolder(listedPath: string): void {
    onRemoveFolder(listedPath)
    fieldRef.current?.focus()
  }

  return (
    <div className="settings-view__folder-card">
      {folderPaths.length === 0 ? (
        <p className="settings-view__note">
          No folder listed: tools may use any file Lys can read, except private
          keys, credential files, and Lys&apos;s settings file.
        </p>
      ) : (
        <ul
          aria-label="Folders tools may use"
          className="settings-view__folder-list"
        >
          {folderPaths.map((listedPath) => (
            <li className="settings-view__folder-row" key={listedPath}>
              <code>{listedPath}</code>
              <Button
                aria-label={`Remove ${listedPath}`}
                onClick={() => handleRemoveFolder(listedPath)}
                size="sm"
                type="button"
                variant="outline"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="settings-view__folder-form" onSubmit={handleAddFolder}>
        <label htmlFor={fieldId}>Folder</label>
        <div className="settings-view__folder-add">
          <Input
            aria-describedby={problem === undefined ? undefined : problemId}
            aria-invalid={problem === undefined ? undefined : true}
            autoComplete="off"
            id={fieldId}
            onChange={(event) => {
              setTypedPath(event.target.value)
              setProblem(undefined)
            }}
            placeholder="/Users/you/Projects"
            ref={fieldRef}
            spellCheck={false}
            type="text"
            value={typedPath}
          />
          <Button disabled={folderPath === ""} size="sm" type="submit">
            Add folder
          </Button>
        </div>
        {problem === undefined ? null : (
          <p className="settings-view__folder-field-error" id={problemId}>
            {FOLDER_PROBLEM_MESSAGES[problem]}
          </p>
        )}
      </form>
    </div>
  )
}
