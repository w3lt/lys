import { mockIPC } from "@tauri-apps/api/mocks"
import { expect, onTestFinished } from "vitest"

/** One native command the renderer invoked through Tauri IPC. */
export type ObservedNativeCommand = Readonly<{
  /** Registered command name. */
  command: string
  /** Arguments as invoked, or undefined when the command took none. */
  args: unknown
}>

/**
 * Produces the result of one native command the case expects.
 *
 * @remarks Return the command's value to resolve the invoke call. Throw or
 * reject with a string to fail it the way a Rust command returning `Err`
 * does; Tauri rejects the invoke call with that value.
 */
export type NativeCommand = (args: unknown) => unknown

/** Native commands answered by the host double, keyed by command name. */
export type NativeCommands = Readonly<Record<string, NativeCommand>>

/** Observation handle of a started native host double. */
export type NativeHostFake = Readonly<{
  /** Commands in invocation order; grows as the renderer invokes them. */
  commands: readonly ObservedNativeCommand[]
}>

/**
 * Answers Tauri IPC with the commands a case declares, through the
 * `mockIPC` seam Tauri provides for renderer tests.
 *
 * @param commands - Results of the commands the case expects.
 * @returns A handle recording every invoked command.
 * @remarks The test setup removes the IPC double after each case. A command
 * the case does not declare rejects and fails the case when it finishes, so
 * an unexpected native call can never pass as a handled command failure.
 */
export function startNativeHostFake(commands: NativeCommands): NativeHostFake {
  const observed: ObservedNativeCommand[] = []
  const unexpectedCommands: string[] = []
  onTestFinished(() => {
    expect(unexpectedCommands, "commands the case did not expect").toEqual([])
  })
  mockIPC((command, args) => {
    observed.push(Object.freeze({ command, args }))
    const handle = commands[command]
    if (handle === undefined) {
      unexpectedCommands.push(command)
      throw `Unexpected native command: ${command}`
    }
    return handle(args)
  })
  return Object.freeze({ commands: observed })
}
