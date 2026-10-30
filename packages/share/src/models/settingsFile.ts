/**
 * Most bytes of the desktop's settings file, `settings.json`, that the
 * backend reads, inclusive; the backend treats a larger file as unreadable.
 *
 * @remarks The desktop host writes the file and the backend reads its
 * groups, so a settings group that can grow takes at most a share of this
 * limit, as `MAXIMUM_MCP_SETTINGS_BYTES` does for the `mcp` group. Lowering
 * it makes saved files unreadable to the backend; changing it requires a
 * coordinated desktop and backend release.
 */
export const MAXIMUM_SETTINGS_FILE_BYTES = 1024 * 1024
