import {
  chromium,
  type Browser,
  type LaunchOptions,
  type Page
} from "playwright-core"
import { onTestFinished } from "vitest"

/** Environment variable naming the browser executable the tests run. */
const TEST_BROWSER_EXECUTABLE_VARIABLE = "LYS_TEST_BROWSER_EXECUTABLE_PATH"

/** Most milliseconds a test that runs the browser may take. */
export const BROWSER_TEST_TIMEOUT_MS = 30_000

/**
 * Reads which Chrome Headless Shell the tests run.
 *
 * @returns The absolute executable path set in
 * `LYS_TEST_BROWSER_EXECUTABLE_PATH`.
 * @throws When the variable is unset or empty, naming how to install the
 * browser; tests that need it then fail instead of passing without it.
 */
export function readTestBrowserExecutablePath(): string {
  const executablePath = process.env[TEST_BROWSER_EXECUTABLE_VARIABLE]
  if (executablePath === undefined || executablePath === "") {
    throw new Error(
      `${TEST_BROWSER_EXECUTABLE_VARIABLE} is not set. Install the browser with scripts/install-chrome-headless-shell.sh <directory> and set ${TEST_BROWSER_EXECUTABLE_VARIABLE} to <directory>/chrome-headless-shell.`
    )
  }
  return executablePath
}

/**
 * Starts the test browser the way production does, so a test can watch it.
 *
 * @param options - Playwright launch options; production passes its proxy
 * and arguments here.
 * @returns The started browser; the test closes it when it finishes.
 */
export async function startTestBrowser(
  options: LaunchOptions = {}
): Promise<Browser> {
  const browser = await chromium.launch(options)
  onTestFinished(() => browser.close())
  return browser
}

/**
 * Opens a page in a fresh test browser.
 *
 * @param html - Markup the page shows; its scripts run.
 * @returns The page, once its markup has loaded.
 */
export async function openTestPage(html: string): Promise<Page> {
  const browser = await startTestBrowser({
    executablePath: readTestBrowserExecutablePath(),
    headless: true
  })
  const page = await browser.newPage()
  await page.setContent(html)
  return page
}
