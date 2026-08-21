// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import tailwindcss from "@tailwindcss/vite"

import react from "@astrojs/react"

import { COLLAPSED_RAIL, RAIL_STORAGE_KEY } from "./src/lib/handbook/rail.ts"

/**
 * Inline script restoring the reader's navigation-rail width before first paint.
 *
 * It runs in the document head, ahead of the rail itself, so a collapsed rail
 * is never rendered expanded and then snapped shut. `RailCollapseToggle` owns
 * every later change to the same attribute.
 */
const RESTORE_RAIL_WIDTH = `
try {
  if (localStorage.getItem(${JSON.stringify(RAIL_STORAGE_KEY)}) === ${JSON.stringify(COLLAPSED_RAIL)}) {
    document.documentElement.dataset.rail = ${JSON.stringify(COLLAPSED_RAIL)};
  }
} catch {}
`.trim()

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()]
  },
  integrations: [
    starlight({
      title: "Lys",
      description:
        "The engineering knowledge base for everyone working on Lys: current architecture, decisions, proposals, operations, and reference material.",
      customCss: ["./src/styles/global.css"],
      // Article pages show when their content last changed, taken from git
      // history rather than a hand-maintained frontmatter field.
      lastUpdated: true,
      editLink: {
        baseUrl: "https://github.com/w3lt/lys/edit/main/apps/docs/"
      },
      // The design places the repository link at the foot of the navigation
      // rail rather than in the header, so `Sidebar` renders it and Starlight's
      // header social list stays empty.
      head: [
        {
          tag: "script",
          content: RESTORE_RAIL_WIDTH
        }
      ],
      // Starlight keeps ownership of routing, search, article layout, and
      // accessibility behaviour. The design replaces the shell's chrome, so the
      // rail, header identity, page title, and theme control are overridden.
      components: {
        SiteTitle: "./src/components/starlight/SiteTitle.astro",
        ThemeSelect: "./src/components/starlight/ThemeSelect.astro",
        PageTitle: "./src/components/starlight/PageTitle.astro",
        Sidebar: "./src/components/starlight/Sidebar.astro"
      },
      expressiveCode: {
        themes: ["github-dark", "github-light"],
        styleOverrides: {
          borderRadius: "var(--radius-surface)",
          borderColor: "var(--app-border-default)",
          codeBackground: "var(--app-surface-code)",
          codeFontFamily: "var(--sl-font-mono), ui-monospace, monospace",
          frames: {
            editorTabBarBackground: "var(--app-surface-code-header)",
            editorTabBarBorderBottomColor: "var(--app-border-subtle)",
            editorActiveTabBackground: "var(--app-surface-code-header)",
            editorActiveTabIndicatorTopColor: "var(--lys-cyan)",
            editorActiveTabForeground: "var(--app-text-strong)",
            editorBackground: "var(--app-surface-code)",
            terminalBackground: "var(--app-surface-code)",
            terminalTitlebarBackground: "var(--app-surface-code-header)",
            terminalTitlebarBorderBottomColor: "var(--app-border-subtle)",
            terminalTitlebarForeground: "var(--doc-text-muted)",
            frameBoxShadowCssValue: "var(--shadow-card)"
          }
        }
      },
      // Navigation entries appear only where substantive content exists; the
      // structure grows as content is authored rather than being scaffolded.
      sidebar: [
        {
          label: "Architecture",
          items: [{ autogenerate: { directory: "architecture" } }]
        },
        {
          label: "Decisions",
          items: [{ autogenerate: { directory: "decisions" } }]
        },
        { label: "RFCs", items: [{ autogenerate: { directory: "rfcs" } }] },
        {
          label: "Operate",
          items: [{ autogenerate: { directory: "operate" } }]
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }]
        }
      ]
    }),
    react()
  ]
})
