//! The list of every client tool Lys has, and the command that gives it to
//! the renderer's Tools settings pane.

use std::sync::LazyLock;

use super::{
    definition::ToolDefinition, read_text_file::build_read_text_file_definition,
    search_files::build_search_files_definition,
};

/// Every client tool, in the order Settings lists them.
///
/// Each tool builds its own definition next to the limits it enforces, so a
/// description always states the current limits. The list is built once, on
/// first use; building it reads nothing and has no side effect.
static CLIENT_TOOLS: LazyLock<[ToolDefinition; 2]> = LazyLock::new(|| {
    [
        build_read_text_file_definition(),
        build_search_files_definition(),
    ]
});

#[tauri::command]
/// Lists every client tool for the renderer's Tools settings pane.
///
/// The renderer invokes this command as `list_tools` with no arguments. It
/// returns [`CLIENT_TOOLS`] in the tool definition shape shared with the
/// renderer, which validates it with `listToolsResultSchema` from
/// `@lys/protocol`. The command reads nothing and never fails.
pub fn list_tools() -> &'static [ToolDefinition] {
    CLIENT_TOOLS.as_slice()
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::list_tools;

    #[test]
    fn lists_every_client_tool_in_the_shared_definition_shape() {
        assert_eq!(
            to_value(list_tools()).expect("serialize the client tools"),
            json!([
                {
                    "name": "read_text_file",
                    "description": "Read one UTF-8 text file and return its complete text. A file over 1 MiB or one that is not UTF-8 text is refused, never truncated.",
                    "group": "files",
                    "access": "reads",
                    "arguments": [
                        {
                            "name": "path",
                            "description": "Absolute path of the file. Symbolic links are followed.",
                            "required": true,
                            "type": "string"
                        }
                    ]
                },
                {
                    "name": "search_files",
                    "description": "Find files under a directory whose name or content contains the query, ignoring case. Returns each matching file's absolute path and, for content matches, its first matching lines with their line numbers.",
                    "group": "files",
                    "access": "reads",
                    "arguments": [
                        {
                            "name": "root",
                            "description": "Absolute path of the directory whose tree is searched. Symbolic links below it are not followed.",
                            "required": true,
                            "type": "string"
                        },
                        {
                            "name": "query",
                            "description": "Text to find, on one line, at most 200 characters.",
                            "required": true,
                            "type": "string"
                        },
                        {
                            "name": "target",
                            "description": "What is compared with the query: file names, file contents, or both.",
                            "required": true,
                            "type": "enum",
                            "values": ["name", "content", "nameAndContent"]
                        },
                        {
                            "name": "maxResults",
                            "description": "Most matching files to return, 1–200. Defaults to 50.",
                            "required": false,
                            "type": "integer"
                        },
                        {
                            "name": "maxSnippetsPerFile",
                            "description": "Most matching lines per file, 1–20. Defaults to 3. Unused when target is name.",
                            "required": false,
                            "type": "integer"
                        }
                    ]
                }
            ])
        );
    }
}
