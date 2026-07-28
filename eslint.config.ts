import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier/flat"

export default defineConfig([
  globalIgnores(["dist", "node_modules"]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  },
  tseslint.configs.recommended,
  eslintConfigPrettier
])
