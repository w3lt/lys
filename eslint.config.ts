import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier/flat"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import reactX from "eslint-plugin-react-x"
import reactDom from "eslint-plugin-react-dom"

export default defineConfig([
  // Patterns are matched against every workspace, not only the repository
  // root, so a built application or generated type directory inside `apps/*`
  // is excluded as well. `.astro` holds the types Astro generates for
  // `apps/docs`.
  globalIgnores([
    "**/dist",
    "**/node_modules",
    "**/.astro",
    "**/src-tauri/target"
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
