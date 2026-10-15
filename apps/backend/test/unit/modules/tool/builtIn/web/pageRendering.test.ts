import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { performance } from "node:perf_hooks"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  getRenderedPage,
  type PageRenderingResult
} from "../../../../../../src/modules/tool/builtIn/web/pageRendering"
import { MAXIMUM_PAGE_TEXT_LENGTH } from "../../../../../../src/modules/tool/builtIn/web/pageDocument"
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
  routeByPath,
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
        readTimeoutMs: 25_000,
        settleTimeoutMs: 15_000
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
        "/moths": answerWithParagraph("Moths fly at night.")
      })
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths.txt"))
    )

    expect(page.mediaType).toBe("text/html")
    expect(page.url).toBe(buildTestPageUrl(server.port, "/moths"))
    expect(page.text).toContain("<p>Moths fly at night.</p>")
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

  it("fails a page whose scripts hold more than 1 GiB", async () => {
    const server = await startPageServer(
      answerWithBody(
        "text/html",
        "<p>Moths</p><script>const moths = []; for (let index = 0; index < 15; index += 1) moths.push(new Array(1e7).fill(1.5))</script>"
      )
    )

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      { readTimeoutMs: 25_000 }
    )

    expect(result).toEqual({ status: "failed", failure: { kind: "crashed" } })
  })

  it("fails a page that crashes the browser while Lys reads its document", async () => {
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

  it("says the browser is missing when its executable does not exist, reports why, and sends nothing", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))
    const reportBrowserFailure = vi.fn()

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      {
        browserExecutablePath: "/nonexistent/lys/chrome-headless-shell",
        reportBrowserFailure
      }
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "browser-missing" }
    })
    expect(server.receivedHeaders).toHaveLength(0)
    expect(reportBrowserFailure.mock.calls[0]?.[0]).toMatchObject({
      code: "ENOENT"
    })
  })

  it("says the browser could not start when its executable is not a browser, and reports why", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))
    const reportBrowserFailure = vi.fn()

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      {
        browserExecutablePath: "/usr/bin/true",
        reportBrowserFailure
      }
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "browser-failed" }
    })
    expect(server.receivedHeaders).toHaveLength(0)
    expect(reportBrowserFailure).toHaveBeenCalledTimes(1)
    expect(reportBrowserFailure.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it.each([
    ["a read that succeeds", answerWithParagraph("Moths"), "rendered"],
    ["a read that fails", routeByPath({}), "failed"],
    ["a read that times out", holdRequests().route, "failed"],
    [
      "a read whose page crashes",
      answerWithBody(
        "text/html",
        "<p>Moths</p><script>const moths = []; for (;;) moths.push(new Array(1e7).fill(1.5))</script>"
      ),
      "failed"
    ]
  ])("leaves no browser running after %s", async (_label, route, status) => {
    const server = await startPageServer(route)

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      { readTimeoutMs: 6_000 }
    )

    expect(result.status).toBe(status)
    expect(await listBrowserProcessIds()).toEqual([])
  })

  it.each([
    [
      "a meta refresh",
      '<meta http-equiv="refresh" content="0;url=/missing"><p>Moved.</p>'
    ],
    [
      "a script navigation",
      '<p>Moved.</p><script>addEventListener("load", () => location.assign("/missing"))</script>'
    ]
  ])(
    "fails with the status of a page that %s leads to",
    async (_label, redirectingPage) => {
      const server = await startPageServer(
        routeByPath({
          "/old": answerWithBody("text/html", redirectingPage),
          "/missing": (_request, response) => {
            response.writeHead(404, { "content-type": "text/html" })
            response.end("<p>No moths here.</p>")
          }
        })
      )

      const result = await renderTestPage(buildTestPageUrl(server.port, "/old"))

      expect(result).toEqual({
        status: "failed",
        failure: { kind: "http-status", status: 404 }
      })
    }
  )

  it("fails a page whose script leads to a document that is not a web page, and names its media type", async () => {
    const server = await startPageServer(
      routeByPath({
        "/old": answerWithBody(
          "text/html",
          '<p>Moved.</p><script>addEventListener("load", () => location.assign("/moths.json"))</script>'
        ),
        "/moths.json": answerWithBody("application/json", '{"moths":"fly"}')
      })
    )

    const result = await renderTestPage(buildTestPageUrl(server.port, "/old"))

    expect(result).toEqual({
      status: "failed",
      failure: {
        kind: "unsupported-content-type",
        mediaType: "application/json"
      }
    })
  })

  it("fails a page that sends itself to a URL Lys may not read", async () => {
    const server = await startPageServer(
      answerWithBody(
        "text/html",
        '<p>Moths fly at night.</p><script>addEventListener("load", () => location.replace("about:blank"))</script>'
      )
    )

    const result = await renderTestPage(buildTestPageUrl(server.port, "/moths"))

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "invalid-redirect", problem: "unsupported-scheme" }
    })
  })

  it("keeps nothing a page stores, such as a cookie or local storage, for the next read", async () => {
    const server = await startPageServer(
      answerWithBody(
        "text/html",
        `<p id="kept"></p>
        <script>
          const kept = [document.cookie, localStorage.getItem("moth"), sessionStorage.getItem("moth")]
          document.getElementById("kept").textContent = "kept:" + kept.filter((value) => value !== null && value !== "").join(",") + "."
          document.cookie = "moth=luna; max-age=3600"
          localStorage.setItem("moth", "luna")
          sessionStorage.setItem("moth", "luna")
        </script>`
      )
    )
    const url = buildTestPageUrl(server.port, "/moths")

    const first = findRenderedPage(await renderTestPage(url))
    const second = findRenderedPage(await renderTestPage(url))

    expect(first.text).toContain('<p id="kept">kept:.</p>')
    expect(second.text).toContain('<p id="kept">kept:.</p>')
  })

  it("times out a page whose scripts never let the browser read it", async () => {
    const server = await startPageServer(
      answerWithBody(
        "text/html",
        '<p>Moths fly at night.</p><script>addEventListener("load", () => { for (;;) {} })</script>'
      )
    )

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      { readTimeoutMs: 4_000, settleTimeoutMs: 500 }
    )

    expect(result).toEqual({ status: "failed", failure: { kind: "timed-out" } })
    expect(await listBrowserProcessIds()).toEqual([])
  })

  it.each([
    ["a media type of exactly 100 characters", 100, 100],
    ["a media type of 101 characters", 101, 100]
  ])(
    "reports %s cut to at most 100 characters",
    async (_label, mediaTypeLength, reportedLength) => {
      const mediaType = `application/${"x".repeat(mediaTypeLength - "application/".length)}`
      const server = await startPageServer(answerWithBody(mediaType, "moths"))

      const result = await renderTestPage(
        buildTestPageUrl(server.port, "/moths")
      )

      expect(result).toEqual({
        status: "failed",
        failure: {
          kind: "unsupported-content-type",
          mediaType: mediaType.slice(0, reportedLength)
        }
      })
    }
  )

  it("reports a media type with its whitespace flattened", async () => {
    const server = await startPageServer(
      answerWithBody("application/x\tmoth", "moths")
    )

    const result = await renderTestPage(buildTestPageUrl(server.port, "/moths"))

    expect(result).toEqual({
      status: "failed",
      failure: {
        kind: "unsupported-content-type",
        mediaType: "application/x moth"
      }
    })
  })

  it("fails a document that comes without a content type as not a web page", async () => {
    const server = await startPageServer(
      answerWithBody(undefined, "<p>Moths fly at night.</p>")
    )

    const result = await renderTestPage(buildTestPageUrl(server.port, "/moths"))

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unsupported-content-type", mediaType: undefined }
    })
  })

  it("never fetches the images, fonts, or media a page names", async () => {
    const resources = countRequests(answerWithBody("image/png", "png"))
    const server = await startPageServer(
      routeByPath({
        "/moths": answerWithBody(
          "text/html",
          `<style>@font-face { font-family: Moth; src: url("/moth.woff2") } p { font-family: Moth }</style>
          <p>Moths fly at night.</p><img src="/moth.png"><video src="/moth.mp4" autoplay muted></video>`
        ),
        "/moth.png": resources.route,
        "/moth.woff2": resources.route,
        "/moth.mp4": resources.route
      })
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths"))
    )

    expect(page.text).toContain("<p>Moths fly at night.</p>")
    expect(resources.count()).toBe(0)
  })

  it("lets no page register a service worker", async () => {
    const worker = countRequests(
      answerWithBody(
        "text/javascript",
        "self.addEventListener('fetch', () => {})"
      )
    )
    const server = await startPageServer(
      routeByPath({
        "/moths": answerWithBody(
          "text/html",
          `<p id="worker"></p>
          <script>
            navigator.serviceWorker.register("/worker.js").then(
              () => { document.getElementById("worker").textContent = "registered" },
              () => { document.getElementById("worker").textContent = "refused" }
            )
          </script>`
        ),
        "/worker.js": worker.route
      })
    )

    const page = findRenderedPage(
      await renderTestPage(buildTestPageUrl(server.port, "/moths"))
    )

    expect(page.text).not.toContain("registered")
    expect(worker.count()).toBe(0)
  })

  it("fails a page that downloads instead of showing a document", async () => {
    const server = await startPageServer(
      answerWithBody("text/html", "<p>Moths fly at night.</p>", {
        "content-disposition": 'attachment; filename="moths.html"'
      })
    )

    const result = await renderTestPage(buildTestPageUrl(server.port, "/moths"))

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "transfer-failed", code: "ERR_ABORTED" }
    })
  })

  it("times out without starting the browser when the read has no time left", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))
    const reportBrowserFailure = vi.fn()
    let nowMs = 0
    vi.spyOn(performance, "now").mockImplementation(() => {
      nowMs += 10
      return nowMs
    })

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      {
        browserExecutablePath: "/usr/bin/true",
        readTimeoutMs: 5,
        reportBrowserFailure
      }
    )

    expect(result).toEqual({ status: "failed", failure: { kind: "timed-out" } })
    expect(server.receivedHeaders).toHaveLength(0)
    expect(reportBrowserFailure, "no start was tried").not.toHaveBeenCalled()
  })

  it("times out, rather than calling the browser broken, when the browser runs out of the read's time while starting, and the browser exits", async () => {
    const server = await startPageServer(answerWithParagraph("Moths"))
    const reportBrowserFailure = vi.fn()

    const result = await renderTestPage(
      buildTestPageUrl(server.port, "/moths"),
      { readTimeoutMs: 40, reportBrowserFailure }
    )

    expect(result).toEqual({ status: "failed", failure: { kind: "timed-out" } })
    expect(reportBrowserFailure).not.toHaveBeenCalled()
    await vi.waitFor(
      async () => expect(await listBrowserProcessIds()).toEqual([]),
      { timeout: 2_000, interval: 50 }
    )
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
