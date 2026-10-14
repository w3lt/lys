import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readTestBrowserExecutablePath } from "./pageBrowser"

/** Runs a command and resolves with its output. */
const execFileAsync = promisify(execFile)

/** Finds the process ID, parent process ID, and command line of a `ps` line. */
const PROCESS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(.*)$/

/** One running process. */
type ProcessEntry = Readonly<{
  /** Process ID. */
  id: number
  /** Parent process ID. */
  parentId: number
  /** Full command line. */
  commandLine: string
}>

/**
 * Parses one line of `ps -o pid=,ppid=,args=`.
 *
 * @param line - Line of the process table.
 * @returns The process, or undefined for a line that is not one.
 */
function parseProcessLine(line: string): ProcessEntry | undefined {
  const match = PROCESS_LINE_PATTERN.exec(line)
  if (match === null) return undefined
  return {
    id: Number(match[1]),
    parentId: Number(match[2]),
    commandLine: match[3] ?? ""
  }
}

/**
 * Finds every process descended from one process.
 *
 * @param processes - The process table.
 * @param ancestorId - Process whose descendants to find.
 * @returns IDs of its children, their children, and so on.
 */
function findDescendantIds(
  processes: readonly ProcessEntry[],
  ancestorId: number
): ReadonlySet<number> {
  const descendantIds = new Set<number>()
  const pendingIds = [ancestorId]
  for (let id = pendingIds.pop(); id !== undefined; id = pendingIds.pop()) {
    for (const entry of processes) {
      if (entry.parentId === id && !descendantIds.has(entry.id)) {
        descendantIds.add(entry.id)
        pendingIds.push(entry.id)
      }
    }
  }
  return descendantIds
}

/**
 * Lists the browser processes this test process started and that are still
 * running.
 *
 * @returns IDs of the processes descended from this process whose command
 * line runs the test browser's executable: each browser and the helper
 * processes it started. Empty once every browser it launched has exited.
 * @remarks Reads the operating system's process table with `ps`, with full
 * command lines, which macOS and Linux both provide; a process name alone is
 * cut to 15 characters on Linux.
 * @throws When no test browser is set.
 */
export async function listBrowserProcessIds(): Promise<readonly number[]> {
  const executablePath = readTestBrowserExecutablePath()
  const { stdout } = await execFileAsync(
    "ps",
    ["-A", "-ww", "-o", "pid=,ppid=,args="],
    { maxBuffer: 16 * 1024 * 1024 }
  )
  const processes = stdout
    .split("\n")
    .map(parseProcessLine)
    .filter((entry) => entry !== undefined)
  const descendantIds = findDescendantIds(processes, process.pid)
  return processes
    .filter(
      (entry) =>
        descendantIds.has(entry.id) &&
        entry.commandLine.includes(executablePath)
    )
    .map((entry) => entry.id)
}
