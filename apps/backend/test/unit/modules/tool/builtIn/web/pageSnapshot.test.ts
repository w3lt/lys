import { describe, expect, it } from "vitest"
import {
  buildVisibleHtml,
  getPageSnapshot,
  MAXIMUM_PAGE_TEXT_LENGTH,
  MAXIMUM_SNAPSHOT_NODES,
  type PageSnapshot,
  type VisibleHtmlResult
} from "../../../../../../src/modules/tool/builtIn/web/pageSnapshot"
import {
  BROWSER_TEST_TIMEOUT_MS,
  openTestPage
} from "../../../../support/pageBrowser"

/** Node type of a DOM document. */
const DOCUMENT_NODE = 9

/** Node type of a DOM element. */
const ELEMENT_NODE = 1

/** Node type of a DOM text node. */
const TEXT_NODE = 3

/**
 * Builds the visible HTML of markup rendered in a real browser.
 *
 * @param html - Markup of the page; its scripts run before the snapshot.
 * @returns What {@link buildVisibleHtml} makes of the page's snapshot.
 */
async function buildVisibleHtmlOf(html: string): Promise<VisibleHtmlResult> {
  const page = await openTestPage(html)
  const snapshot = await getPageSnapshot(page)
  if (snapshot.status !== "taken") throw new Error("Expected a snapshot")
  return buildVisibleHtml(snapshot.snapshot)
}

/**
 * Finds the HTML of a built result.
 *
 * @param result - Result expected to be built.
 * @returns Its HTML.
 * @throws When the result is not built.
 */
function findBuiltHtml(result: VisibleHtmlResult): string {
  if (result.status !== "built") throw new Error("Expected built HTML")
  return result.html
}

/**
 * Builds a snapshot of one `<p>` holding one text node.
 *
 * @param text - Text of the paragraph.
 * @returns A complete snapshot: document, paragraph, text, with no layout
 * box, as outside a page's body.
 */
function buildParagraphSnapshot(text: string): PageSnapshot {
  return {
    strings: ["#document", "P", "#text", text],
    documents: [
      {
        nodes: {
          parentIndex: [-1, 0, 1],
          nodeType: [DOCUMENT_NODE, ELEMENT_NODE, TEXT_NODE],
          nodeName: [0, 1, 2],
          nodeValue: [-1, -1, 3],
          attributes: [[], [], []]
        },
        layout: { nodeIndex: [], styles: [], bounds: [] }
      }
    ]
  }
}

describe("buildVisibleHtml", () => {
  it(
    "keeps the text and nesting of the rendered page",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          "<main><p>Moths <b>fly</b> at night.</p></main>"
        )
      )

      expect(html).toContain("<main><p>Moths <b>fly</b> at night.</p></main>")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "includes text that the page's scripts wrote before the snapshot",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          '<div id="root"></div><script>document.getElementById("root").innerHTML = "<p>Written by a script.</p>"</script>'
        )
      )

      expect(html).toContain('<div id="root"><p>Written by a script.</p></div>')
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "escapes text and attribute values",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          `<p title='a "moth" &amp; a butterfly'>wings &lt; 5 cm &amp; night</p>`
        )
      )

      expect(html).toContain(
        '<p title="a &quot;moth&quot; &amp; a butterfly">wings &lt; 5 cm &amp; night</p>'
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "writes void elements without an end tag",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf('<p>moth<br>night<img alt="moth"></p>')
      )

      expect(html).toContain('<p>moth<br>night<img alt="moth"></p>')
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "keeps the title and the meta tags of the head",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          '<head><title>Moths</title><meta property="og:site_name" content="Moth Society"></head><body><p>text</p></body>'
        )
      )

      expect(html).toContain("<title>Moths</title>")
      expect(html).toContain(
        '<meta property="og:site_name" content="Moth Society">'
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "leaves out scripts, styles, noscript, templates, SVG, iframes, and comments",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          '<style>p { color: black }</style><script>var scriptText = "SCRIPT"</script><noscript>NOSCRIPT</noscript><template><p>TEMPLATE</p></template><svg><text>SVG</text></svg><iframe srcdoc="<p>IFRAME</p>"></iframe><!-- COMMENT --><p>kept</p>'
        )
      )

      expect(html).toContain("<p>kept</p>")
      for (const leftOut of [
        "color: black",
        "SCRIPT",
        "NOSCRIPT",
        "TEMPLATE",
        "SVG",
        "IFRAME",
        "COMMENT"
      ]) {
        expect(html).not.toContain(leftOut)
      }
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "writes a shadow root's content inside its host, with slotted light content where it renders",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          '<moth-card><span>light text</span></moth-card><script>customElements.define("moth-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<p>shadow text</p><slot></slot>" } })</script>'
        )
      )

      expect(html).toContain(
        "<moth-card><p>shadow text</p><slot><span>light text</span></slot></moth-card>"
      )
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "leaves out text a person cannot see on the page",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          `<style>
            body { background: #fff; margin: 0 }
            .off { position: absolute; left: -9999px }
            .white { color: #fff }
            .gone { display: none }
            .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }
            .collapsed { height: 0; overflow: hidden }
          </style>
          <p>shown-first</p>
          <p class="off">hidden-offscreen</p>
          <p class="white">hidden-white</p>
          <p style="font-size: 0">hidden-zero-font</p>
          <p class="gone">hidden-display</p>
          <p style="visibility: hidden">hidden-visibility</p>
          <div style="opacity: 0"><p>hidden-opacity</p></div>
          <p style="color: transparent">hidden-transparent</p>
          <span class="sr-only">hidden-sr-only</span>
          <div class="collapsed"><p>hidden-collapsed</p></div>
          <div style="width: 100px; overflow: hidden; white-space: nowrap"><span style="margin-left: 300px">hidden-past-the-edge</span></div>
          <p>shown-last</p>`
        )
      )

      expect(html).toContain("<p>shown-first</p>")
      expect(html).toContain("<p>shown-last</p>")
      expect(html).not.toMatch(/hidden-/)
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "takes a page without a background color as white",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          '<p>shown</p><p style="color: #fff">hidden-white</p>'
        )
      )

      expect(html).toContain("<p>shown</p>")
      expect(html).not.toContain("hidden-white")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "keeps text a person can see or scroll to",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          `<style>
            body { background: #fff; margin: 0 }
            .float-parent { height: 0 }
            .float-parent p { float: left }
            .below { position: absolute; top: 3000px }
            .scroller { height: 20px; overflow: auto }
            .picture { color: #fff; background: #fff url("data:image/gif;base64,R0lGODlhAQABAAAAACw=") }
            .dark { background: #000; color: #f0f0f0 }
          </style>
          <div class="float-parent"><p>shown-float</p></div>
          <p class="below">shown-below-the-fold</p>
          <div class="scroller"><p>first line</p><p>second line</p><p>shown-scrolled</p></div>
          <p class="picture">shown-on-picture</p>
          <p class="dark">shown-light-on-dark</p>
          <p><b>moth</b> <i>wing</i></p>`
        )
      )

      for (const shown of [
        "shown-float",
        "shown-below-the-fold",
        "shown-scrolled",
        "shown-on-picture",
        "shown-light-on-dark"
      ]) {
        expect(html).toContain(shown)
      }
      expect(html).toContain("<b>moth</b> <i>wing</i>")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "decides what is hidden from the browser's own layout, whatever the page's scripts changed",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          `<style>.off { position: absolute; left: -9999px }</style>
          <p>shown</p><p class="off">hidden-offscreen</p>
          <script>
            window.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" })
            Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30 })
          </script>`
        )
      )

      expect(html).toContain("<p>shown</p>")
      expect(html).not.toContain("hidden-offscreen")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "compares colors written in any CSS color syntax with what they are drawn on",
    async () => {
      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          `<style>
            body { margin: 0; background: oklch(14.1% 0.005 285.823); color: #fff }
            .white-band { background: #fff; color: #000 }
          </style>
          <p>shown-on-oklch-body</p>
          <p style="background: color-mix(in oklab, #000 80%, transparent)">shown-on-color-mix</p>
          <p style="background: lab(10 0 0)">shown-on-lab</p>
          <p style="background: color(display-p3 0 0 0)">shown-on-display-p3</p>
          <p style="color: oklch(14.1% 0.005 285.823)">hidden-same-as-body</p>
          <div class="white-band">
            <p style="color: oklch(1 0 0)">hidden-oklch-white</p>
            <p style="color: color(srgb 1 1 1)">hidden-srgb-white</p>
            <p style="color: lab(100 0 0)">hidden-lab-white</p>
            <p style="color: oklch(0 0 0 / 0)">hidden-transparent-oklch</p>
            <p style="color: rgba(0, 0, 0, 0.03)">hidden-faint</p>
            <p style="color: oklch(0.2 0 0)">shown-dark-oklch</p>
          </div>`
        )
      )

      for (const shown of [
        "shown-on-oklch-body",
        "shown-on-color-mix",
        "shown-on-lab",
        "shown-on-display-p3",
        "shown-dark-oklch"
      ]) {
        expect(html).toContain(shown)
      }
      expect(html).not.toMatch(/hidden-/)
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "keeps text a person can scroll to inside a scrolling area of a page that hides its own overflow",
    async () => {
      const paragraphs = Array.from(
        { length: 40 },
        (_, index) => `<p>paragraph-${index + 1}.</p>`
      ).join("")

      const html = findBuiltHtml(
        await buildVisibleHtmlOf(
          `<style>
            html, body { height: 100%; overflow: hidden; margin: 0 }
            main { height: 100%; overflow-y: auto }
            .away { position: absolute; left: -9999px; height: 50px; overflow: auto }
          </style>
          <main>${paragraphs}</main>
          <div class="away"><p>hidden-in-a-scrolling-area-out-of-sight</p></div>`
        )
      )

      for (let index = 1; index <= 40; index += 1) {
        expect(html).toContain(`paragraph-${index}.`)
      }
      expect(html).not.toContain("hidden-in-a-scrolling-area-out-of-sight")
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it("cuts very long HTML at its limit without splitting a character", () => {
    const text = `${"m".repeat(MAXIMUM_PAGE_TEXT_LENGTH - 4)}🦋🦋🦋`

    const result = buildVisibleHtml(buildParagraphSnapshot(text))

    if (result.status !== "built") throw new Error("Expected built HTML")
    expect(result.isTruncated).toBe(true)
    expect(result.html.length).toBeLessThanOrEqual(MAXIMUM_PAGE_TEXT_LENGTH)
    expect(result.html).toMatch(/m$/)
  })

  it("is not truncated when the HTML fits", () => {
    const result = buildVisibleHtml(buildParagraphSnapshot("Moths"))

    expect(result).toEqual({
      status: "built",
      html: "<p>Moths</p>",
      isTruncated: false
    })
  })

  it("refuses a page with more nodes than its limit before building it", () => {
    const nodeCount = MAXIMUM_SNAPSHOT_NODES + 1
    const snapshot: PageSnapshot = {
      strings: ["#document"],
      documents: [
        {
          nodes: {
            parentIndex: Array.from({ length: nodeCount }, (_, index) =>
              index === 0 ? -1 : 0
            ),
            nodeType: Array.from({ length: nodeCount }, () => DOCUMENT_NODE),
            nodeName: Array.from({ length: nodeCount }, () => 0),
            nodeValue: Array.from({ length: nodeCount }, () => -1),
            attributes: Array.from({ length: nodeCount }, () => [])
          },
          layout: { nodeIndex: [], styles: [], bounds: [] }
        }
      ]
    }

    expect(buildVisibleHtml(snapshot)).toEqual({ status: "too-complex" })
  })
})

describe("getPageSnapshot", () => {
  it(
    "refuses a page with more nodes than its limit before taking its snapshot",
    async () => {
      const page = await openTestPage(
        `<script>
          const moths = document.createDocumentFragment()
          for (let index = 0; index <= ${MAXIMUM_SNAPSHOT_NODES}; index += 1) {
            moths.appendChild(document.createElement("i"))
          }
          document.body.appendChild(moths)
        </script>`
      )

      expect(await getPageSnapshot(page)).toEqual({ status: "too-complex" })
    },
    BROWSER_TEST_TIMEOUT_MS
  )

  it(
    "counts only the nodes a page still has, not those it threw away",
    async () => {
      const page = await openTestPage(
        `<p>Moths fly at night.</p>
        <script>
          for (let round = 0; round < 3; round += 1) {
            const discarded = document.createElement("div")
            discarded.innerHTML = "<i></i>".repeat(${MAXIMUM_SNAPSHOT_NODES})
          }
        </script>`
      )

      const snapshot = await getPageSnapshot(page)

      expect(snapshot.status).toBe("taken")
    },
    BROWSER_TEST_TIMEOUT_MS
  )
})
