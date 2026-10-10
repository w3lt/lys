import { describe, expect, it } from "vitest"
import {
  extractPageArticle,
  MAXIMUM_PAGE_DEPTH_SUM,
  MAXIMUM_PAGE_ELEMENTS
} from "../../../../../../src/modules/tool/builtIn/web/pageExtraction"
import type { PageResponse } from "../../../../../../src/modules/tool/builtIn/web/pageRequest"
import {
  parsePageUrl,
  type PageUrl
} from "../../../../../../src/modules/tool/builtIn/web/pageUrl"

/** Sentence long enough that a few of them make a readable article. */
const ARTICLE_SENTENCE =
  "Moths are insects closely related to butterflies, and most of them fly at night. "

/** Paragraph long enough to count as article text on its own. */
const ARTICLE_PARAGRAPH = ARTICLE_SENTENCE.repeat(4).trim()

/**
 * Builds the checked URL of a test page.
 *
 * @param text - URL text.
 * @returns The checked URL.
 */
function buildPageUrl(text: string): PageUrl {
  const parsed = parsePageUrl(text)
  if (parsed.status !== "valid") throw new Error("Invalid test page URL")
  return parsed.url
}

/**
 * Builds a page response for extraction.
 *
 * @param mediaType - Media type of the body.
 * @param text - Body text.
 * @returns A response from https://moths.example/article.
 */
function buildPage(
  mediaType: PageResponse["mediaType"],
  text: string
): PageResponse {
  return {
    url: buildPageUrl("https://moths.example/article"),
    mediaType,
    text,
    isTruncated: false
  }
}

/**
 * Builds a complete HTML article page.
 *
 * @param bodyHtml - Markup inside `<article>`.
 * @param headHtml - Markup inside `<head>`.
 * @returns The page markup with a site header, navigation, and footer
 * around the article.
 */
function buildArticleHtml(
  bodyHtml: string,
  headHtml = "<title>Moths</title>"
): string {
  return `<!doctype html><html><head>${headHtml}</head><body>
    <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
    <main><article>${bodyHtml}</article></main>
    <footer>Copyright Moth Society</footer>
  </body></html>`
}

describe("extractPageArticle", () => {
  it("extracts the main text of an HTML article as headings and text blocks", () => {
    const html = buildArticleHtml(`
      <h1>Moths</h1>
      <p>${ARTICLE_PARAGRAPH}</p>
      <h2>Life cycle</h2>
      <p>${ARTICLE_PARAGRAPH}</p>
      <ul><li>Egg</li><li>Larva</li></ul>
    `)

    const result = extractPageArticle(buildPage("text/html", html))

    expect(result.status).toBe("extracted")
    if (result.status !== "extracted") return
    expect(result.article.blocks).toEqual([
      { kind: "text", text: ARTICLE_PARAGRAPH },
      { kind: "heading", text: "Life cycle" },
      { kind: "text", text: ARTICLE_PARAGRAPH },
      { kind: "text", text: "- Egg" },
      { kind: "text", text: "- Larva" }
    ])
    expect(result.article.title).toBe("Moths")
  })

  it("never reads scripts, styles, templates, or noscript text", () => {
    const html = buildArticleHtml(`
      <p>${ARTICLE_PARAGRAPH}</p>
      <script>window.secret = "script text"</script>
      <style>.hidden { color: red }</style>
      <template><p>template text</p></template>
      <noscript>noscript text</noscript>
    `)

    const result = extractPageArticle(buildPage("text/html", html))

    expect(result.status).toBe("extracted")
    const text = JSON.stringify(result)
    expect(text).not.toContain("script text")
    expect(text).not.toContain("color: red")
    expect(text).not.toContain("template text")
    expect(text).not.toContain("noscript text")
  })

  it("keeps the line breaks of preformatted text", () => {
    const html = buildArticleHtml(
      `<p>${ARTICLE_PARAGRAPH}</p><pre>first line   \nsecond line</pre>`
    )

    const result = extractPageArticle(buildPage("text/html", html))

    expect(
      result.status === "extracted" && result.article.blocks
    ).toContainEqual({
      kind: "text",
      text: "first line\nsecond line"
    })
  })

  it("makes loose text between elements a block of its own", () => {
    const html = buildArticleHtml(
      `<div>${ARTICLE_PARAGRAPH}<div>Second part.</div>Third part.</div>`
    )

    const result = extractPageArticle(buildPage("text/html", html))

    expect(result.status === "extracted" && result.article.blocks).toEqual([
      { kind: "text", text: ARTICLE_PARAGRAPH },
      { kind: "text", text: "Second part." },
      { kind: "text", text: "Third part." }
    ])
  })

  it("reads the site name and publication date the page states", () => {
    const html = buildArticleHtml(
      `<p>${ARTICLE_PARAGRAPH}</p>`,
      `<title>Moths</title>
       <meta property="og:site_name" content="Moth Society">
       <meta property="article:published_time" content="2026-07-01T09:00:00Z">`
    )

    const result = extractPageArticle(buildPage("text/html", html))

    expect(result).toMatchObject({
      status: "extracted",
      article: {
        siteName: "Moth Society",
        publishedTime: "2026-07-01T09:00:00Z"
      }
    })
  })

  it("titles a page without a title by its host", () => {
    const html = `<!doctype html><html><head></head><body><p>${ARTICLE_PARAGRAPH}</p></body></html>`

    const result = extractPageArticle(buildPage("text/html", html))

    expect(result).toMatchObject({
      status: "extracted",
      article: {
        title: "moths.example",
        siteName: undefined,
        publishedTime: undefined
      }
    })
  })

  it("reads markup that has no <html> or <body> element", () => {
    const result = extractPageArticle(
      buildPage("text/html", `<p>${ARTICLE_PARAGRAPH}</p>`)
    )

    expect(result.status === "extracted" && result.article.blocks).toEqual([
      { kind: "text", text: ARTICLE_PARAGRAPH }
    ])
  })

  it("reports no readable text for a page that only shows a JavaScript shell", () => {
    const html = `<!doctype html><html><head><title>App</title></head><body>
      <div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>
      <script src="/app.js"></script></body></html>`

    expect(extractPageArticle(buildPage("text/html", html))).toEqual({
      status: "no-readable-text"
    })
  })

  it("extracts a short page and reports a blank one as having no readable text", () => {
    expect(extractPageArticle(buildPage("text/plain", "Moths."))).toMatchObject(
      {
        status: "extracted",
        article: { blocks: [{ kind: "text", text: "Moths." }] }
      }
    )
    expect(extractPageArticle(buildPage("text/plain", " \n\n \t"))).toEqual({
      status: "no-readable-text"
    })
  })

  it("extracts the short text of a small HTML page", () => {
    const html =
      "<html><head><title>Example Domain</title></head><body><div><h1>Example Domain</h1><p>This domain is for use in documentation examples.</p></div></body></html>"

    expect(extractPageArticle(buildPage("text/html", html))).toMatchObject({
      status: "extracted",
      article: { title: "Example Domain" }
    })
  })

  it("splits a plain-text page into paragraphs and titles it by its host", () => {
    const text = `${ARTICLE_PARAGRAPH}\n\n  \n${ARTICLE_SENTENCE}\nstill the same paragraph`

    expect(extractPageArticle(buildPage("text/plain", text))).toEqual({
      status: "extracted",
      article: {
        title: "moths.example",
        siteName: undefined,
        publishedTime: undefined,
        blocks: [
          { kind: "text", text: ARTICLE_PARAGRAPH },
          {
            kind: "text",
            text: `${ARTICLE_SENTENCE.trim()} still the same paragraph`
          }
        ]
      }
    })
  })

  it("refuses a page with more elements than the limit", () => {
    const html = `<!doctype html><html><head></head><body>${"<span>x</span>".repeat(MAXIMUM_PAGE_ELEMENTS)}</body></html>`

    expect(extractPageArticle(buildPage("text/html", html))).toEqual({
      status: "too-complex"
    })
  })

  it("refuses a page whose element depths add up past the limit", () => {
    const depth = 1_000
    const html = `<!doctype html><html><body>${"<div>".repeat(depth)}<p>${ARTICLE_PARAGRAPH}</p>${"</div>".repeat(depth)}</body></html>`

    expect(depth * depth).toBeGreaterThan(MAXIMUM_PAGE_DEPTH_SUM)
    expect(extractPageArticle(buildPage("text/html", html))).toEqual({
      status: "too-complex"
    })
  })
})
