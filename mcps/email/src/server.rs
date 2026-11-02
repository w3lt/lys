//! The MCP server: the tools, their descriptions, and the limits every
//! call runs under.

use std::future::Future;
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::failure::ToolFailure;
use crate::log::log_line;
use crate::tools::drafts::{DraftIdArguments, SaveDraftArguments};
use crate::tools::folders::FolderArguments;
use crate::tools::read::{AttachmentArguments, IdArguments};
use crate::tools::search::SearchArguments;
use crate::tools::send::MessageArguments;
use crate::tools::{ToolContext, ToolResult, cut_result_text, drafts, folders, read, search, send};

/// Longest one tool call may take as a whole.
pub const CALL_LIMIT: Duration = Duration::from_secs(240);

/// The name the server reports to the client.
pub const SERVER_NAME: &str = "lys-email";

/// What the server tells the model about itself.
const INSTRUCTIONS: &str = "Reads, searches, sends, and files the person's email over their own account. Message ids come from search_emails and read_email and look like 12.345.INBOX; an id is valid until the folder changes, then search again. Reading never marks a message as read. Sending and deleting are permanent.";

/// The MCP server over the account's mail servers.
#[derive(Debug)]
pub struct EmailServer {
    /// The account and trust every call works with.
    context: ToolContext,
    /// The tools, found by name.
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl EmailServer {
    /// Creates the server.
    ///
    /// # Arguments
    ///
    /// * `context` - The account and trust.
    pub fn new(context: ToolContext) -> Self {
        Self {
            context,
            tool_router: Self::tool_router(),
        }
    }

    /// Runs one call under the cancellation token and the time limit,
    /// logs its outcome, and answers the model.
    ///
    /// # Arguments
    ///
    /// * `name` - The tool's name, for the log.
    /// * `token` - Cancelled when the client cancels the request.
    /// * `call` - The call.
    async fn run<F>(&self, name: &str, token: CancellationToken, call: F) -> CallToolResult
    where
        F: Future<Output = ToolResult>,
    {
        self.run_within(name, token, CALL_LIMIT, call).await
    }

    /// Runs one call as [`Self::run`] does, under the given time limit.
    ///
    /// # Arguments
    ///
    /// * `name` - The tool's name, for the log.
    /// * `token` - Cancelled when the client cancels the request.
    /// * `limit` - Longest the call may take.
    /// * `call` - The call.
    async fn run_within<F>(
        &self,
        name: &str,
        token: CancellationToken,
        limit: Duration,
        call: F,
    ) -> CallToolResult
    where
        F: Future<Output = ToolResult>,
    {
        let outcome = tokio::select! {
            () = token.cancelled() => Err(ToolFailure::Cancelled),
            finished = timeout(limit, call) => finished.unwrap_or(Err(ToolFailure::TimedOut)),
        };
        match outcome {
            Ok(report) => {
                log_line(&format!("tool {name}: done ({})", report.log));
                CallToolResult::success(vec![ContentBlock::text(cut_result_text(report.text))])
            }
            Err(failure) => {
                log_line(&format!("tool {name}: failed ({})", failure.class()));
                CallToolResult::error(vec![ContentBlock::text(failure.to_string())])
            }
        }
    }

    #[tool(
        name = "search_emails",
        description = "Finds messages, newest first, 20 per page. Searches one folder, or every folder when none is given. Give text, from, to, subject, since, before, unread, or flagged to narrow the search; every argument is optional. Each hit shows its id for read_email.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn search_emails(
        &self,
        Parameters(arguments): Parameters<SearchArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "search_emails",
            token,
            search::search_emails(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "read_email",
        description = "Reads one message by id: its header fields, flags, text, and the list of its attachments. Does not mark it as read.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn read_email(
        &self,
        Parameters(arguments): Parameters<IdArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "read_email",
            token,
            read::read_email(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "read_conversation",
        description = "Reads the whole conversation a message belongs to, oldest first, found through its Message-ID, In-Reply-To, and References fields in every folder; at most 50 messages, each cut to 3,000 characters of text.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn read_conversation(
        &self,
        Parameters(arguments): Parameters<IdArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "read_conversation",
            token,
            read::read_conversation(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "read_attachment",
        description = "Reads one attachment of a message as text: plain text, HTML, CSV, JSON, XML, and the like. Other kinds, such as PDF or images, cannot be read.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn read_attachment(
        &self,
        Parameters(arguments): Parameters<AttachmentArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "read_attachment",
            token,
            read::read_attachment(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "list_folders",
        description = "Lists every folder of the account with its role (Inbox, Sent, Drafts, Trash, Junk, Archive, All) and how many messages it holds.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn list_folders(&self, token: CancellationToken) -> CallToolResult {
        self.run("list_folders", token, folders::list_folders(&self.context))
            .await
    }

    #[tool(
        name = "manage_folder",
        description = "Creates, renames, or deletes a folder. A folder with a role (Inbox, Sent, Drafts, Trash, Junk, Archive, All) cannot be renamed or deleted, and a folder holding messages cannot be deleted.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn manage_folder(
        &self,
        Parameters(arguments): Parameters<FolderArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "manage_folder",
            token,
            folders::manage_folder(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "send_email",
        description = "Sends a message from the person's account. With reply_to_id it is a reply in that conversation (the recipient and the subject default to the replied message's); with forward_id it forwards that message, quoting its text and attaching its attachments. A copy is kept in Sent. Sending is permanent.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn send_email(
        &self,
        Parameters(arguments): Parameters<MessageArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "send_email",
            token,
            send::send_email(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "save_draft",
        description = "Saves a message in the Drafts folder without sending it, with the same fields as send_email. With draft_id, replaces that draft. Answers the draft's id for send_draft, save_draft, and delete_draft.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn save_draft(
        &self,
        Parameters(arguments): Parameters<SaveDraftArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "save_draft",
            token,
            drafts::save_draft(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "send_draft",
        description = "Sends a draft saved with save_draft, as it is stored, keeps a copy in Sent, and deletes the draft. Sending is permanent.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn send_draft(
        &self,
        Parameters(arguments): Parameters<DraftIdArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "send_draft",
            token,
            drafts::send_draft(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "delete_draft",
        description = "Deletes a draft saved with save_draft. Only a message in the Drafts folder can be deleted here.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn delete_draft(
        &self,
        Parameters(arguments): Parameters<DraftIdArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        self.run(
            "delete_draft",
            token,
            drafts::delete_draft(&self.context, arguments),
        )
        .await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for EmailServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

#[cfg(test)]
mod tests {
    use std::future::pending;

    use super::*;
    use crate::account::parse_account_variable;
    use crate::tools::ToolReport;
    use crate::trust::Trust;

    /// Builds a server over an account that is never connected to.
    fn build_server() -> EmailServer {
        let account = parse_account_variable(
            "{\"address\":\"person@example.com\",\"displayName\":\"\",\"userName\":\"person\",\"password\":\"synthetic-7f3a\",\"imap\":{\"host\":\"localhost\",\"port\":1,\"security\":\"plain\"},\"smtp\":{\"host\":\"localhost\",\"port\":1,\"security\":\"plain\"},\"serverKeepsSentCopy\":false}",
        )
        .expect("account");
        EmailServer::new(ToolContext::new(account, Trust::of_platform()))
    }

    /// The text of a result's first content block.
    fn text_of(result: &CallToolResult) -> String {
        result
            .content
            .first()
            .and_then(|block| block.as_text())
            .map(|text| text.text.clone())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn answers_a_cancelled_call_a_timed_out_call_and_a_long_result() {
        let server = build_server();
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        let after_cancel = server
            .run("read_email", cancelled, pending::<ToolResult>())
            .await;
        let after_limit = server
            .run_within(
                "read_email",
                CancellationToken::new(),
                Duration::from_millis(10),
                pending::<ToolResult>(),
            )
            .await;
        let long = server
            .run("read_email", CancellationToken::new(), async {
                Ok(ToolReport {
                    text: "x".repeat(crate::tools::RESULT_LIMIT + 5),
                    log: "test".to_owned(),
                })
            })
            .await;
        let failed = server
            .run("read_email", CancellationToken::new(), async {
                Err(ToolFailure::StaleId)
            })
            .await;

        assert_eq!(after_cancel.is_error, Some(true));
        assert_eq!(text_of(&after_cancel), "The call was cancelled.");
        assert_eq!(after_limit.is_error, Some(true));
        assert_eq!(
            text_of(&after_limit),
            "The call did not finish within 240 seconds and was stopped."
        );
        assert_ne!(long.is_error, Some(true));
        assert!(text_of(&long).ends_with(crate::tools::CUT_NOTE));
        assert_eq!(failed.is_error, Some(true));
        assert_eq!(
            text_of(&failed),
            "That message id is no longer valid. Search again."
        );
    }

    /// The names of the tools, in the order the spec lists them.
    const TOOL_NAMES: [&str; 10] = [
        "search_emails",
        "read_email",
        "read_conversation",
        "read_attachment",
        "list_folders",
        "send_email",
        "save_draft",
        "send_draft",
        "delete_draft",
        "manage_folder",
    ];

    #[test]
    fn routes_every_tool_with_a_description_and_a_schema() {
        let router = EmailServer::tool_router();
        let tools = router.list_all();

        let mut names: Vec<&str> = tools.iter().map(|tool| tool.name.as_ref()).collect();
        names.sort_unstable();
        let mut expected = TOOL_NAMES.to_vec();
        expected.sort_unstable();
        assert_eq!(names, expected);
        for tool in &tools {
            assert!(
                tool.description
                    .as_ref()
                    .is_some_and(|text| !text.is_empty()),
                "{} has no description",
                tool.name
            );
            let schema = serde_json::to_value(&tool.input_schema).expect("schema");
            assert_eq!(schema["type"], "object", "{} schema", tool.name);
        }
        let search = tools
            .iter()
            .find(|tool| tool.name == "search_emails")
            .expect("search tool");
        let schema = serde_json::to_value(&search.input_schema).expect("schema");
        assert!(schema["properties"]["page"].is_object(), "{schema}");
        assert_eq!(
            search
                .annotations
                .as_ref()
                .and_then(|annotations| annotations.read_only_hint),
            Some(true)
        );
    }
}
