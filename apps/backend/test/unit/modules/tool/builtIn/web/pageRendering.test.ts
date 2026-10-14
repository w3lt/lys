import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  getRenderedPage,
  type PageRenderingResult
} from "../../../../../../src/modules/tool/builtIn/web/pageRendering"
import { MAXIMUM_PAGE_TEXT_LENGTH } from "../../../../../../src/modules/tool/builtIn/web/pageSnapshot"
import {
  parsePageUrl,
  type PageUrl
} from "../../../../../../src/modules/tool/builtIn/web/pageUrl"
import { BROWSER_TEST_TIMEOUT_MS } from "../../../../support/pageBrowser"
import { listBrowserProcessIds } from "../../../../support/browserProcesses"
import {
  answerWithBody,
  buildPageServerDependencies,
  buildTestPageUrl,
  startPageServer,
  type PageRoute,
  type PageServerReadOptions
} from "../../../../support/pageServer"

/**
 * Reads one page of a test server in the test browser.
 *
 * @param url - Page to read.
 * @param options - Read settings a case changes.
 * @returns The rendering result.
 */
function renderTestPage(
  url: PageUrl,
  options: PageServerReadOptions = {}
): Promise<PageRenderingResult> {
  return getRenderedPage(
    url,
    new AbortController().signal,
    buildPageServerDependencies(options)
  )
}

/**
 * Builds a route that answers each path with its own handler.
 *
 * @param routes - Handler of each path; any other path gets a 404.
 * @returns The route.
 */
function routeByPath(routes: Readonly<Record<string, PageRoute>>): PageRoute {
  return (request, response) => {
    const route = routes[request.url ?? ""]
    if (route !== undefined) {
      route(request, response)
      return
    }
    response.writeHead(404)
    response.end()
  }
}

/**
 * Builds a route that redirects.
 *
 * @param status - Redirect status code.
 * @param location - Where it redirects to.
 * @returns The route.
 */
function redirectTo(status: number, location: string): PageRoute {
  return (_request, response) => {
    response.writeHead(status, { location })
    response.end()
  }
}

/**
 * Builds the HTML route of one paragraph.
 *
 * @param text - Text of the paragraph.
 * @returns The route.
 */
function answerWithParagraph(text: string): PageRoute {
  return answerWithBody("text/html; charset=utf-8", `<p>${text}</p>`)
}

/**
 * Finds the page of a rendered result.
 *
 * @param result - Result expected to be rendered.
 * @returns Its page.
 * @throws When the read failed.
 */
function findRenderedPage(result: PageRenderingResult) {
  if (result.status !== "rendered") {
    throw new Error(`Expected a rendered page, got ${JSON.stringify(result)}`)
  }
  return result.page
}

/**
 * Starts a server on the IPv6 loopback that a page may try to reach.
 *
 * @returns Its port and how many TCP connections reached it; it closes after
 * the test.
 */
async function startPrivateServer(): Promise<
  Readonly<{ port: number; countConnections: () => number }>
> {
  let connectionCount = 0
  const server = createServer(
    (_request: IncomingMessage, response: ServerResponse) => {
      response.end("secret")
    }
  )
  server.on("connection", () => {
    connectionCount += 1
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(0, "::1", resolve))
  const { port } = server.address() as AddressInfo
  return { port, countConnections: () => connectionCount }
}

/**
 * Finds a port of the IPv6 loopback that nothing listens on.
 *
 * @returns A port that was free a moment ago and is closed again.
 */
async function findClosedPrivatePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "::1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * Builds a route that sends the start of an HTML page and never ends it.
 *
 * @param html - Markup sent at once.
 * @returns The route.
 */
function answerWithEndlessHtml(html: string): PageRoute {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.write(html)
  }
}

/**
 * Builds a route that counts the requests it answers.
 *
 * @param route - Route that answers them.
 * @returns The counting route and the count so far.
 */
function countRequests(
  route: PageRoute
): Readonly<{ route: PageRoute; count: () => number }> {
  let requestCount = 0
  return {
    route: (request, response) => {
      requestCount += 1
      route(request, response)
    },
    count: () => requestCount
  }
}

/**
 * Waits until a browser this test process started is running.
 *
 * @returns A promise that settles once the process table shows one.
 */
async function waitForBrowserProcess(): Promise<void> {
  while ((await listBrowserProcessIds()).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Builds a route that receives a request and never answers it.
 *
 * @returns The route and a promise that settles once a request arrived.
 */
function holdRequests(): Readonly<{
  route: PageRoute
  requestArrived: Promise<void>
}> {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { route: () => resolve(), requestArrived: promise }
}

describe("getRenderedPage", { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it("reads the text a page's script builds after loading", async () => {
    const server = await startPageServer(
      routeByPath({
        "/moths": answerWithBody(
          "text/html",
          '<main id="root">Loading…</main><script>fetch("/moths.json").then((response) => response.json()).then((moths) => { document.getElementById("root").innerHTML = "<p>" + moths.text + "</p>" })</script>'
        ),
        "/moths.json": answerWithBody(
          "application/json",
          JSON.stringify({ text: "Moths fly at night." })
        )
      })
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths"))
    )

    expect(page.mediaType).toBe("text/html")
    expect(page.text).toContain(
      '<main id="root"><p>Moths fly at night.</p></main>'
    )
    expect(page.url).toBe(buildTestPageUrl(server.port, "/moths"))
    expect(page.isTruncated).toBe(false)
  })

  it("follows a chain of HTTP redirects and gives the final URL", async () => {
    const server = await startPageServer(
      routeByPath({
        "/old": redirectTo(301, "/newer"),
        "/newer": redirectTo(302, "/moths"),
        "/moths": answerWithParagraph("Moths fly at night.")
      })
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/old"))
    )

    expect(page.url).toBe(buildTestPageUrl(server.port, "/moths"))
    expect(page.text).toContain("<p>Moths fly at night.</p>")
  })

  it.each([
    [
      "a meta refresh",
      '<meta http-equiv="refresh" content="0;url=/moths"><p>Moved.</p>'
    ],
    [
      "a script navigation",
      '<p>Moved.</p><script>location.assign("/moths")</script>'
    ]
  ])(
    "follows %s and reads the page it leads to",
    async (_name, redirectingPage) => {
      const server = await startPageServer(
        routeByPath({
          "/old": answerWithBody("text/html", redirectingPage),
          "/moths": answerWithParagraph("Moths fly at night.")
        })
      )

      const page = findRenderedPage(
        await renderTestPage(buildTestPageUrl(server.port, "/old"))
      )

      expect(page.url).toBe(buildTestPageUrl(server.port, "/moths"))
      expect(page.text).toContain("<p>Moths fly at night.</p>")
    }
  )

  it("refuses a redirect to an address the rule blocks", async () => {
    const server = await startPageServer(
      routeByPath({ "/old": redirectTo(302, "http://private.test/moths") })
    )

    const result = await renderTestPage(buildTestPageUrl(server.port, "/old"))

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "blocked-address" }
    })
  })

  it("refuses a page whose host has no address", async () => {
    const url = parsePageUrl("http://missing.test/moths")
    if (url.status !== "valid") throw new Error("Expected a valid URL")

    const result = await renderTestPage(url.url)

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unresolvable-host" }
    })
  })

  it("reads a page that tries to reach a private address, without reaching it", async () => {
    const privateServer = await startPrivateServer()
    const server = await startPageServer(
      answerWithBody(
        "text/html",
        `<p>Moths fly at night.</p><script>fetch("http://[::1]:${privateServer.port}/secret").catch(() => {})</script>`
      )
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths"))
    )

    expect(page.text).toContain("<p>Moths fly at night.</p>")
    expect(privateServer.countConnections()).toBe(0)
  })

  it("keeps a page off this machine even when Playwright is told not to proxy it", async () => {
    vi.stubEnv("PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK", "1")
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const privateServer = await startPrivateServer()
    const server = await startPageServer(
      answerWithBody(
        "text/html",
        `<p>Moths fly at night.</p><script>fetch("http://[::1]:${privateServer.port}/secret").catch(() => {})</script>`
      )
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths"))
    )

    expect(page.text).toContain("<p>Moths fly at night.</p>")
    expect(privateServer.countConnections()).toBe(0)
  })

  it("refuses a redirect to a blocked IP address where nothing listens", async () => {
    const closedPort = await findClosedPrivatePort()
    const server = await startPageServer(
      routeByPath({
        "/old": redirectTo(302, `http://[::1]:${closedPort}/moths`)
      })
    )

    const result = await renderTestPage(buildTestPageUrl(server.port, "/old"))

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "blocked-address" }
    })
  })

  it.each([
    [
      "a meta refresh to an address the rule blocks",
      '<meta http-equiv="refresh" content="0;url=http://private.test/moths"><p>Moved.</p>',
      "blocked-address"
    ],
    [
      "a meta refresh to a host without an address",
      '<meta http-equiv="refresh" content="0;url=http://missing.test/moths"><p>Moved.</p>',
      "unresolvable-host"
    ],
    [
      "a script navigation after loading to an address the rule blocks",
      '<p>Moved.</p><script>addEventListener("load", () => location.assign("http://private.test/moths"))</script>',
      "blocked-address"
    ]
  ])(
    "says why the page could not be read after %s",
    async (_name, redirectingPage, kind) => {
      const server = await startPageServer(
        routeByPath({ "/old": answerWithBody("text/html", redirectingPage) })
      )

      const result = await renderTestPage(buildTestPageUrl(server.port, "/old"))

      expect(result).toEqual({ status: "failed", failure: { kind } })
    }
  )

  it.each([
    [
      "a script that never arrives",
      routeByPath({
        "/moths": answerWithBody(
          "text/html",
          '<p>Moths fly at night.</p><script src="/never.js"></script><p>after</p>'
        ),
        "/never.js": holdRequests().route
      })
    ],
    [
      "a body that never ends",
      answerWithEndlessHtml("<p>Moths fly at night.</p>")
    ]
  ])(
    "reads what has rendered when the document waits on %s",
    async (_name, route) => {
      const server = await startPageServer(route)

      const page = findRenderedPage(
        await renderTestPage(buildTestPageUrl(server.port, "/moths"))
      )

      expect(page.text).toContain("<p>Moths fly at night.</p>")
    }
  )

  it("reads what has rendered when the page never stops loading", async () => {
    const server = await startPageServer(
      routeByPath({
        "/moths": answerWithBody(
          "text/html",
          '<p>Moths fly at night.</p><script>setInterval(() => fetch("/beacon").catch(() => {}), 100)</script>'
        ),
        "/beacon": answerWithBody("text/plain", "ok")
      })
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths"), {
        settleTimeoutMs: 500
      })
    )

    expect(page.text).toContain("<p>Moths fly at night.</p>")
  })

  it("times out when the page's document never arrives", async () => {
    const held = holdRequests()
    const server = await startPageServer(held.route)

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      {
        readTimeoutMs: 3_000
      }
    )

    expect(result).toEqual({ status: "failed", failure: { kind: "timed-out" } })
  })

  it("fails with the status of a page the server does not have", async () => {
    const server = await startPageServer(routeByPath({}))

    const result = await renderTestPage(buildTestPageUrl(server.port, "/moths"))

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "http-status", status: 404 }
    })
  })

  it("fails a PDF as not a web page and names its media type", async () => {
    const server = await startPageServer(
      answerWithBody("application/pdf", "%PDF-1.4 moths")
    )

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths.pdf")
    )

    expect(result).toEqual({
      status: "failed",
      failure: {
        kind: "unsupported-content-type",
        mediaType: "application/pdf"
      }
    })
  })

  it("reads a plain-text page as its text", async () => {
    const server = await startPageServer(
      answerWithBody(
        "text/plain; charset=utf-8",
        "Moths fly at night.\n\nThey rest by day."
      )
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths.txt"))
    )

    expect(page).toEqual({
      url: buildTestPageUrl(server.port, "/moths.txt"),
      mediaType: "text/plain",
      text: "Moths fly at night.\n\nThey rest by day.",
      isTruncated: false
    })
  })

  it("reads the beginning of a plain-text page far longer than the limit", async () => {
    const line = "Moths fly at night.\n"
    const lineCount = Math.ceil((24 * 1024 * 1024) / line.length)
    const server = await startPageServer(
      answerWithBody("text/plain", line.repeat(lineCount))
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths.txt"), {
        readTimeoutMs: 25_000
      })
    )

    expect(page.mediaType).toBe("text/plain")
    expect(page.isTruncated).toBe(true)
    expect(page.text).toHaveLength(MAXIMUM_PAGE_TEXT_LENGTH)
    expect(page.text.startsWith(`${line}${line}`)).toBe(true)
  })

  it("reads the page a plain-text page refreshes to as that page", async () => {
    const server = await startPageServer(
      routeByPath({
        "/moths.txt": (_request, response) => {
          response.writeHead(200, {
            "content-type": "text/plain",
            refresh: "0;url=/moths"
          })
          response.end("Moved.")
        },
        "/moths": answerWithBody(
          "text/html",
          '<p>Moths fly at night.</p><p style="color: #fff">hidden-white</p>'
        )
      })
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths.txt"))
    )

    expect(page.mediaType).toBe("text/html")
    expect(page.url).toBe(buildTestPageUrl(server.port, "/moths"))
    expect(page.text).toContain("<p>Moths fly at night.</p>")
    expect(page.text).not.toContain("hidden-white")
  })

  it("opens no other window a page asks for", async () => {
    const popup = countRequests(answerWithParagraph("Popup."))
    const server = await startPageServer(
      routeByPath({
        "/moths": answerWithBody(
          "text/html",
          '<p>Moths fly at night.</p><script>window.open("/popup")</script>'
        ),
        "/popup": popup.route
      })
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths"))
    )

    expect(page.text).toContain("<p>Moths fly at night.</p>")
    expect(popup.count()).toBe(0)
  })

  it("keeps only the beginning of a plain-text page longer than the limit", async () => {
    const server = await startPageServer(
      answerWithBody("text/plain", "m".repeat(MAXIMUM_PAGE_TEXT_LENGTH + 100))
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths.txt"))
    )

    expect(page.isTruncated).toBe(true)
    expect(page.text).toHaveLength(MAXIMUM_PAGE_TEXT_LENGTH)
  })

  it("fails a page that crashes the browser while it loads", async () => {
    const server = await startPageServer(
      answerWithBody(
        "text/html",
        "<p>Moths</p><script>const moths = []; for (;;) moths.push(new Array(1e7).fill(1.5))</script>"
      )
    )

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      {
        readTimeoutMs: 25_000
      }
    )

    expect(result).toEqual({ status: "failed", failure: { kind: "crashed" } })
  })

  it("fails a page that crashes the browser while Lys takes its snapshot", async () => {
    const server = await startPageServer(
      answerWithBody(
        "text/html",
        "<p>Moths</p><script>const moths = []; for (;;) moths.push(new Array(1e7).fill(1.5))</script>"
      )
    )

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      { readTimeoutMs: 25_000, settleTimeoutMs: 100 }
    )

    expect(result).toEqual({ status: "failed", failure: { kind: "crashed" } })
  })

  it("says the browser is missing when its executable does not exist, and sends nothing", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      {
        browserExecutablePath: "/nonexistent/lys/chrome-headless-shell"
      }
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "browser-missing" }
    })
    expect(server.receivedHeaders).toHaveLength(0)
  })

  it("says the browser could not start when its executable is not a browser", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      {
        browserExecutablePath: "/usr/bin/true"
      }
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "browser-failed" }
    })
    expect(server.receivedHeaders).toHaveLength(0)
  })

  it("leaves no browser running after a read", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))

    findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths"))
    )

    expect(await listBrowserProcessIds()).toEqual([])
  })

  it("rejects with the stop reason and starts nothing when already stopped", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))
    const abortController = new AbortController()
    const stopReason = new Error("stopped")
    abortController.abort(stopReason)

    await expect(
      getRenderedPage(
        buildTestPageUrl(server.port, "/moths"),
        abortController.signal,
        buildPageServerDependencies()
      )
    ).rejects.toBe(stopReason)
    expect(server.receivedHeaders).toHaveLength(0)
    expect(await listBrowserProcessIds()).toEqual([])
  })

  it("stops a read whose page is still loading and closes the browser", async () => {
    const held = holdRequests()
    const server = await startPageServer(held.route)
    const abortController = new AbortController()
    const stopReason = new Error("stopped")

    const read = getRenderedPage(
      buildTestPageUrl(server.port, "/moths"),
      abortController.signal,
      buildPageServerDependencies()
    )
    await held.requestArrived
    abortController.abort(stopReason)

    await expect(read).rejects.toBe(stopReason)
    expect(await listBrowserProcessIds()).toEqual([])
  })

  it("stops a read while its browser is starting and closes the browser once started", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))
    const abortController = new AbortController()
    const stopReason = new Error("stopped")

    const read = getRenderedPage(
      buildTestPageUrl(server.port, "/moths"),
      abortController.signal,
      buildPageServerDependencies()
    )
    await waitForBrowserProcess()
    abortController.abort(stopReason)

    await expect(read).rejects.toBe(stopReason)
    expect(server.receivedHeaders).toHaveLength(0)
    expect(await listBrowserProcessIds()).toEqual([])
  })
})
