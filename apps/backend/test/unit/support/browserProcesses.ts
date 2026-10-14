import { execFile } from "node:child_process"
import { promisify } from "node:util"

/** Runs a command and resolves with its output. */
const execFileAsync = promisify(execFile)

/**
 * Lists the browser processes this test process started and that are still
 * running.
 *
 * @returns Process IDs of the Chrome Headless Shell processes whose parent is
 * this process; empty once every browser it launched has exited.
 * @remarks Reads the operating system's process table with `ps`, which
 * macOS and Linux both provide.
 */
export async function listBrowserProcessIds(): Promise<readonly number[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "ppid=,pid=,comm="])
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([parentId, , command]) =>
        Number(parentId) === process.pid &&
        command !== undefined &&
        command.includes("chrome-headless-shell")
    )
    .map(([, processId]) => Number(processId))
}
