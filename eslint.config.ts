import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier/flat"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import reactX from "eslint-plugin-react-x"
import reactDom from "eslint-plugin-react-dom"

/**
 * Repository-wide ESLint flat configuration.
 *
 * @remarks Applies the JavaScript, TypeScript, React, and Prettier-compatible
 * rules used by the workspace lint command. Configured global ignores cover
 * `dist`, `node_modules`, `.astro`, and `src-tauri/target` paths in every
 * workspace, and the root `worktree/` directory; this configuration affects
 * static analysis only and has no application runtime effect.
 */
export default defineConfig([
  // Patterns are matched against every workspace, not only the repository
  // root, so a built application or generated type directory inside `apps/*`
  // is excluded as well. `.astro` holds the types Astro generates for
  // `apps/docs`. `worktree/` matches only at the root, where AI agents create
  // git worktrees (docs/agent_operations/WORK_ON_ISSUE.md): each one is another
  // checkout of this repository, which ESLint would otherwise lint again under
  // that checkout's own configuration.
  globalIgnores([
    "**/dist",
    "**/node_modules",
    "**/.astro",
    "**/src-tauri/target",
    "worktree/"
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: { js },
    extends: [
      "js/recommended",
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      reactX.configs["recommended-typescript"],
      reactDom.configs.recommended
    ],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports"
        }
      ]
    },
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  },
  tseslint.configs.recommended,
  eslintConfigPrettier
])
