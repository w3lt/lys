// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import tailwindcss from "@tailwindcss/vite"

import react from "@astrojs/react"

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
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/w3lt/lys"
        }
      ],
      // Narrow overrides only. Starlight keeps ownership of navigation, search,
      // article layout, and accessibility behaviour.
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
