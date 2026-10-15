import type { Page } from "playwright-core"
import { describe, expect, it } from "vitest"
import {
  getPageDocument,
  MAXIMUM_PAGE_TEXT_LENGTH,
  type PageDocument
} from "../../../../../../src/modules/tool/builtIn/web/pageDocument"
import {
  BROWSER_TEST_TIMEOUT_MS,
  openTestPage,
  readTestBrowserExecutablePath,
  startTestBrowser
} from "../../../../support/pageBrowser"
import {
  answerWithBody,
  routeByPath,
  startPageServer,
  type PageRoute
} from "../../../../support/pageServer"

/**
 * Characters the document adds around the body of markup written into an
 * empty test page: `<html><head></head><body>` and `</body></html>`.
 */
const EMPTY_PAGE_FRAME_LENGTH = "<html><head></head><body></body></html>".length

/**
 * Reads the document of markup rendered in a real browser.
 *
 * @param html - Markup of the page; its scripts run before it is read.
 * @returns What {@link getPageDocument} reads from the page.
 */
async function readTestDocument(html: string): Promise<PageDocument> {
  return getPageDocument(await openTestPage(html))
}

/**
 * Opens a page served by a local page server in a fresh test browser, with
 * no proxy between them.
 *
 * @param route - Answers the page's request.
 * @returns The page, once its document has loaded.
 */
async function openServedTestPage(route: PageRoute): Promise<Page> {
  const server = await startPageServer(route)
  const browser = await startTestBrowser({
    executablePath: readTestBrowserExecutablePath(),
    headless: true
  })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.port}/moths`)
  return page
}

describe("getPageDocument", () => {
  it(
    "keeps the text and nesting of the rendered page",
    async () => {
      const document = await readTestDocument(
        "<main><p>Moths <b>fly</b> at night.</p></main>"
      )

      expect(document.text).toBe(
        "<html><head></head><body><main><p>Moths <b>fly</b> at night.</p></main></body></html>"
      )
      expect(document.isTruncated).toBe(false)
      expect(document.contentType).toBe("text/html")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "includes text that the page's scripts wrote before it is read",
    async () => {
      const document = await readTestDocument(
        '<div id="root"></div><script>document.getElementById("root").innerHTML = "<p>Written by a script.</p>"</script>'
      )

      expect(document.text).toContain(
        '<div id="root"><p>Written by a script.</p></div>'
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "escapes text and attribute values",
    async () => {
      const document = await readTestDocument(
        `<p title='a "moth" &amp; a butterfly'>wings &lt; 5 cm &amp; night</p>`
      )

      expect(document.text).toContain(
        '<p title="a &quot;moth&quot; &amp; a butterfly">wings &lt; 5 cm &amp; night</p>'
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "writes void elements without an end tag",
    async () => {
      const document = await readTestDocument(
        '<p>moth<br>night<img alt="moth"></p>'
      )

      expect(document.text).toContain('<p>moth<br>night<img alt="moth"></p>')
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "keeps the title and the meta tags of the head",
    async () => {
      const document = await readTestDocument(
        '<head><title>Moths</title><meta property="og:site_name" content="Moth Society"></head><body><p>text</p></body>'
      )

      expect(document.text).toContain("<title>Moths</title>")
      expect(document.text).toContain(
        '<meta property="og:site_name" content="Moth Society">'
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "leaves out scripts, styles, noscript, templates, SVG, iframes, and comments",
    async () => {
      const document = await readTestDocument(
        '<style>p { color: black }</style><script>var scriptText = "SCRIPT"</script><noscript>NOSCRIPT</noscript><template><p>TEMPLATE</p></template><svg><text>SVG</text></svg><iframe srcdoc="<p>IFRAME</p>"></iframe><!-- COMMENT --><p>kept</p>'
      )

      expect(document.text).toContain("<p>kept</p>")
      for (const leftOut of [
        "color: black",
        "SCRIPT",
        "NOSCRIPT",
        "TEMPLATE",
        "SVG",
        "IFRAME",
        "COMMENT"
      ]) {
        expect(document.text).not.toContain(leftOut)
      }
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "writes an open shadow root's content inside its host, with slotted light content where it renders",
    async () => {
      const document = await readTestDocument(
        '<moth-card><span>light text</span></moth-card><script>customElements.define("moth-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<p>shadow text</p><slot></slot>" } })</script>'
      )

      expect(document.text).toContain(
        "<moth-card><p>shadow text</p><slot><span>light text</span></slot></moth-card>"
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "writes a slot's own content when nothing is slotted into it",
    async () => {
      const document = await readTestDocument(
        '<moth-card></moth-card><script>customElements.define("moth-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<slot>No moths yet.</slot>" } })</script>'
      )

      expect(document.text).toContain(
        "<moth-card><slot>No moths yet.</slot></moth-card>"
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "writes the light content of a host whose shadow root is closed, since the closed root cannot be read",
    async () => {
      const document = await readTestDocument(
        '<moth-card><span>light text</span></moth-card><script>customElements.define("moth-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<p>closed shadow text</p><slot></slot>" } })</script>'
      )

      expect(document.text).toContain(
        "<moth-card><span>light text</span></moth-card>"
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "keeps text the page hides from view, without the attributes that hide it",
    async () => {
      const document = await readTestDocument(
        `<style>
          .off { position: absolute; left: -9999px }
          .gone { display: none }
        </style>
        <p class="off">offscreen text</p>
        <p style="color: #fff">white text</p>
        <p class="gone">display-none text</p>
        <p style="display: none">inline-hidden text</p>
        <p hidden>hidden-attribute text</p>
        <p aria-hidden="true">aria-hidden text</p>
        <details><summary>More</summary><p>collapsed text</p></details>`
      )

      for (const kept of [
        "offscreen text",
        "white text",
        "display-none text",
        "inline-hidden text",
        "hidden-attribute text",
        "aria-hidden text",
        "collapsed text"
      ]) {
        expect(document.text).toContain(kept)
      }
      expect(document.text).not.toMatch(/ (style|hidden|aria-hidden)=/)
      expect(document.text).toContain('<p class="gone">display-none text</p>')
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "reads the page's DOM as the browser holds it, whatever the page's scripts changed in their own world",
    async () => {
      const document = await readTestDocument(
        `<p>Moths fly at night.</p>
        <script>
          Object.defineProperty(Node.prototype, "childNodes", { get() { return [] } })
          Object.defineProperty(Element.prototype, "localName", { get() { return "forged" } })
          String.prototype.replaceAll = () => "forged"
          Array.from = () => []
        </script>`
      )

      expect(document.text).toContain("<p>Moths fly at night.</p>")
      expect(document.text).not.toContain("forged")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "keeps HTML exactly as long as its limit whole",
    async () => {
      const textLength = MAXIMUM_PAGE_TEXT_LENGTH - EMPTY_PAGE_FRAME_LENGTH

      const document = await readTestDocument(
        `<body><script>document.body.textContent = "m".repeat(${textLength})</script></body>`
      )

      expect(document.isTruncated).toBe(false)
      expect(document.text).toHaveLength(MAXIMUM_PAGE_TEXT_LENGTH)
      expect(document.text).toMatch(/m<\/body><\/html>$/)
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "cuts HTML one character longer than its limit to the limit",
    async () => {
      const textLength = MAXIMUM_PAGE_TEXT_LENGTH - EMPTY_PAGE_FRAME_LENGTH + 1

      const document = await readTestDocument(
        `<body><script>document.body.textContent = "m".repeat(${textLength})</script></body>`
      )

      expect(document.isTruncated).toBe(true)
      expect(document.text).toHaveLength(MAXIMUM_PAGE_TEXT_LENGTH)
      expect(document.text).toMatch(/m<\/body><\/html$/)
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "cuts long HTML without splitting a character",
    async () => {
      const document = await readTestDocument(
        `<body><script>document.body.textContent = "m".repeat(${MAXIMUM_PAGE_TEXT_LENGTH - 30}) + "🦋".repeat(40)</script></body>`
      )

      expect(document.isTruncated).toBe(true)
      expect(document.text.length).toBeLessThanOrEqual(MAXIMUM_PAGE_TEXT_LENGTH)
      expect(document.text).toMatch(/🦋$/u)
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "never sends Lys more than its limit, however much text the page's scripts generate",
    async () => {
      const document = await readTestDocument(
        `<p>Moths fly at night.</p>
        <script>
          const hidden = document.createElement("div")
          hidden.hidden = true
          hidden.textContent = "m".repeat(30_000_000)
          hidden.setAttribute("data-wings", "w".repeat(30_000_000))
          document.body.append(hidden)
        </script>`
      )

      expect(document.isTruncated).toBe(true)
      expect(document.text.length).toBeLessThanOrEqual(MAXIMUM_PAGE_TEXT_LENGTH)
      expect(document.text).toContain("<p>Moths fly at night.</p>")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "reads a plain-text document's text as it is",
    async () => {
      const page = await openServedTestPage(
        answerWithBody("text/plain; charset=utf-8", "Moths <fly> at night.")
      )

      const document = await getPageDocument(page)

      expect(document).toEqual({
        url: page.url(),
        contentType: "text/plain",
        responseStatus: 200,
        text: "Moths <fly> at night.",
        isTruncated: false
      })
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "keeps a plain-text document exactly as long as its limit whole, and cuts one a character longer",
    async () => {
      const fitting = await getPageDocument(
        await openServedTestPage(
          answerWithBody("text/plain", "m".repeat(MAXIMUM_PAGE_TEXT_LENGTH))
        )
      )
      const longer = await getPageDocument(
        await openServedTestPage(
          answerWithBody("text/plain", "m".repeat(MAXIMUM_PAGE_TEXT_LENGTH + 1))
        )
      )

      expect(fitting.isTruncated).toBe(false)
      expect(fitting.text).toHaveLength(MAXIMUM_PAGE_TEXT_LENGTH)
      expect(longer.isTruncated).toBe(true)
      expect(longer.text).toHaveLength(MAXIMUM_PAGE_TEXT_LENGTH)
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "reports the HTTP status of the document the page shows",
    async () => {
      const page = await openServedTestPage((_request, response) => {
        response.writeHead(404, { "content-type": "text/html" })
        response.end("<p>No moths here.</p>")
      })

      const document = await getPageDocument(page)

      expect(document.responseStatus).toBe(404)
      expect(document.contentType).toBe("text/html")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "reports the media type of a document that is neither HTML nor plain text, and reads no text from it",
    async () => {
      const page = await openServedTestPage(
        answerWithBody("application/json", '{"moths":"fly at night"}')
      )

      const document = await getPageDocument(page)

      expect(document).toEqual({
        url: page.url(),
        contentType: "application/json",
        responseStatus: 200,
        text: "",
        isTruncated: false
      })
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "reads the document a page replaced its first one with",
    async () => {
      const page = await openServedTestPage(
        routeByPath({
          "/moths": answerWithBody(
            "text/html",
            '<meta http-equiv="refresh" content="0;url=/moths/new"><p>Old moths.</p>'
          ),
          "/moths/new": answerWithBody("text/html", "<p>New moths.</p>")
        })
      )
      await page.waitForURL("**/moths/new")

      const document = await getPageDocument(page)

      expect(document.url).toMatch(/\/moths\/new$/)
      expect(document.text).toContain("<p>New moths.</p>")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "never fails while a page keeps replacing its document, and reads one of them or keeps reading",
    async () => {
      const page = await openServedTestPage(
        routeByPath({
          "/moths": answerWithBody(
            "text/html",
            '<meta http-equiv="refresh" content="0;url=/moths/again"><p>Moths.</p>'
          ),
          "/moths/again": answerWithBody(
            "text/html",
            '<meta http-equiv="refresh" content="0;url=/moths"><p>Moths again.</p>'
          )
        })
      )

      const outcome = await Promise.race([
        getPageDocument(page).then(
          (document) => document.url,
          (error: unknown) => error
        ),
        new Promise((resolve) =>
          setTimeout(() => resolve("still reading"), 1_500)
        )
      ])

      expect(outcome).not.toBeInstanceOf(Error)
      expect(String(outcome)).toMatch(/^(still reading|.*\/moths(\/again)?)$/)
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "stops the page's scripts before it reads the page",
    async () => {
      const page = await openTestPage(
        '<p id="ticks">0</p><script>let ticks = 0; setInterval(() => { document.getElementById("ticks").textContent = String(++ticks) }, 5)</script>'
      )

      const first = await getPageDocument(page)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const second = await getPageDocument(page)

      expect(second.text).toBe(first.text)
    },
    BROWSER_TEST_TIMEOUT_MS
  )
})
