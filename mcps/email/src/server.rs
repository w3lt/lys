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

use crate::failure::{SentKind, Stop, ToolFailure};
use crate::log::send_log_line;
use crate::smtp::{SendProgress, SendStage};
use crate::tools::drafts::{
    DraftIdArguments, DraftProgress, SaveDraftArguments, SendDraftArguments,
};
use crate::tools::folders::FolderArguments;
use crate::tools::read::{AttachmentArguments, IdArguments};
use crate::tools::search::SearchArguments;
use crate::tools::send::MessageArguments;
use crate::tools::{
    ToolContext, ToolResult, drafts, folders, format_result_text, read, search, send,
};

/// Longest one tool call may take as a whole.
pub const CALL_LIMIT: Duration = Duration::from_secs(240);

/// The name the server reports to the client.
pub const SERVER_NAME: &str = "lys-email";

/// What the server tells the model about itself.
const INSTRUCTIONS: &str = "Reads, searches, sends, and files the person's email over their own account. Message ids come from search_emails and read_email and look like 12.345.INBOX; an id is valid until the folder changes, then search again. Reading never marks a message as read. Sending and deleting are permanent.";

/// The MCP server over the account's mail servers.
///
/// Concurrency model: concurrent; the MCP service may run several calls at
/// once, each through a shared reference, and the only state they change
/// is the context's atomic sequence counter. Resource ownership: owns the
/// context and the tool list; it keeps no connection, as each call opens
/// and closes its own.
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

    #[tool(
        name = "search_emails",
        description = "Finds messages, newest first, 20 per page. Searches one folder, or every folder but an All Mail view when none is given. Give text, from, to, subject, since, before, unread, or flagged to narrow the search; every argument is optional. Each page runs the search again, so mail that arrives, moves, or is deleted between two pages can repeat or skip a hit. Each hit shows its id for read_email.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn run_search_emails(
        &self,
        Parameters(arguments): Parameters<SearchArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        run_tool_call(
            "search_emails",
            token,
            search::run_search_emails(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "read_email",
        description = "Reads one message by id: its header fields, flags, text, and the list of its attachments. Does not mark it as read.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn run_read_email(
        &self,
        Parameters(arguments): Parameters<IdArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        run_tool_call(
            "read_email",
            token,
            read::run_read_email(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "read_conversation",
        description = "Reads the conversation a message belongs to, oldest first, found through its Message-ID, In-Reply-To, and References fields in every folder: the newest messages that fit in the result, at most 50, each cut to 3,000 characters of text; it says how many older ones were left out.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn run_read_conversation(
        &self,
        Parameters(arguments): Parameters<IdArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        run_tool_call(
            "read_conversation",
            token,
            read::run_read_conversation(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "read_attachment",
        description = "Reads one attachment of a message as text: plain text, HTML, CSV, JSON, XML, and the like. Other kinds, such as PDF or images, cannot be read.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn run_read_attachment(
        &self,
        Parameters(arguments): Parameters<AttachmentArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        run_tool_call(
            "read_attachment",
            token,
            read::run_read_attachment(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "list_folders",
        description = "Lists every folder of the account with its role (Inbox, Sent, Drafts, Trash, Junk, Archive, All) and how many messages it holds.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn run_list_folders(&self, token: CancellationToken) -> CallToolResult {
        run_tool_call(
            "list_folders",
            token,
            folders::run_list_folders(&self.context),
        )
        .await
    }

    #[tool(
        name = "manage_folder",
        description = "Creates, renames, or deletes a folder. A folder with a role (Inbox, Sent, Drafts, Trash, Junk, Archive, All) cannot be renamed or deleted, and a folder holding messages or other folders cannot be deleted.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn run_manage_folder(
        &self,
        Parameters(arguments): Parameters<FolderArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        run_tool_call(
            "manage_folder",
            token,
            folders::run_manage_folder(&self.context, arguments),
        )
        .await
    }

    #[tool(
        name = "send_email",
        description = "Sends a message from the person's account. With reply_to_id it is a reply in that conversation; with forward_id it forwards that message, quoting its text and attaching its attachments. The recipients and the subject are always this call's own, a reply's and a forward's too. A copy is kept in Sent. Sending is permanent.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn run_send_email(
        &self,
        Parameters(arguments): Parameters<MessageArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        let progress = SendProgress::default();
        let call = send::run_send_email(&self.context, arguments, &progress);
        let outcome = run_tool_call_within(token, CALL_LIMIT, call).await;
        let reported = calculate_send_outcome(outcome, progress.read_stage(), SentKind::Message);
        handle_tool_call_outcome("send_email", reported)
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
    async fn run_save_draft(
        &self,
        Parameters(arguments): Parameters<SaveDraftArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        let progress = DraftProgress::default();
        let call = drafts::run_save_draft(&self.context, arguments, &progress);
        let outcome = run_tool_call_within(token, CALL_LIMIT, call).await;
        let reported = calculate_save_outcome(outcome, progress.has_begun_storing());
        handle_tool_call_outcome("save_draft", reported)
    }

    #[tool(
        name = "send_draft",
        description = "Sends a message of the Drafts folder as it is stored, keeps a copy in Sent, and deletes the draft, or only marks it as deleted on a server that cannot remove one message on its own. Give the draft's to, cc, bcc, subject, and body: it is sent only when each recipient field names the same addresses as the draft's, in any order, and the subject and the text equal its own; otherwise the answer names the draft's fields and nothing is sent. Sending is permanent.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn run_send_draft(
        &self,
        Parameters(arguments): Parameters<SendDraftArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        let progress = SendProgress::default();
        let call = drafts::run_send_draft(&self.context, arguments, &progress);
        let outcome = run_tool_call_within(token, CALL_LIMIT, call).await;
        let reported = calculate_send_outcome(outcome, progress.read_stage(), SentKind::Draft);
        handle_tool_call_outcome("send_draft", reported)
    }

    #[tool(
        name = "delete_draft",
        description = "Deletes a message of the Drafts folder, or only marks it as deleted on a server that cannot remove one message on its own. Only a message in the Drafts folder can be deleted here.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn run_delete_draft(
        &self,
        Parameters(arguments): Parameters<DraftIdArguments>,
        token: CancellationToken,
    ) -> CallToolResult {
        run_tool_call(
            "delete_draft",
            token,
            drafts::run_delete_draft(&self.context, arguments),
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

/// Runs one tool call under the cancellation token and [`CALL_LIMIT`],
/// logs its outcome, and answers the model.
///
/// # Arguments
///
/// * `name` - The tool's name, for the log.
/// * `token` - Cancelled when the client cancels the request.
/// * `call` - The call.
async fn run_tool_call<F>(name: &str, token: CancellationToken, call: F) -> CallToolResult
where
    F: Future<Output = ToolResult>,
{
    let outcome = run_tool_call_within(token, CALL_LIMIT, call).await;
    handle_tool_call_outcome(name, outcome)
}

/// Runs one tool call until it finishes, the token is cancelled, or the
/// limit passes, whichever comes first.
///
/// # Arguments
///
/// * `token` - Cancelled when the client cancels the request.
/// * `limit` - Longest the call may take.
/// * `call` - The call.
///
/// # Returns
///
/// The call's outcome, `Cancelled`, or `TimedOut`.
async fn run_tool_call_within<F>(token: CancellationToken, limit: Duration, call: F) -> ToolResult
where
    F: Future<Output = ToolResult>,
{
    tokio::select! {
        () = token.cancelled() => Err(ToolFailure::Cancelled),
        finished = timeout(limit, call) => finished.unwrap_or(Err(ToolFailure::TimedOut)),
    }
}

/// Reports a send tool's call that was stopped by how far its send came:
/// a stop before the end of the message was handed over sent nothing and
/// stays as it is; a stop after it, while the server's answer was awaited,
/// leaves the send unconfirmed; and a stop after the server accepted the
/// message is reported as a send whose later steps may be missing.
///
/// # Arguments
///
/// * `outcome` - What the call did, `Cancelled` or `TimedOut` when it was
///   stopped.
/// * `stage` - How far its send came.
/// * `sent` - What the tool sends.
///
/// # Returns
///
/// The outcome to report; any outcome but a stop is reported as it is.
fn calculate_send_outcome(outcome: ToolResult, stage: SendStage, sent: SentKind) -> ToolResult {
    let stop = match &outcome {
        Err(ToolFailure::Cancelled) => Stop::Cancelled,
        Err(ToolFailure::TimedOut) => Stop::TimedOut,
        Ok(_) | Err(_) => return outcome,
    };
    match stage {
        SendStage::NotHandedOver => outcome,
        SendStage::HandedOver => Err(ToolFailure::StoppedUnconfirmed(stop)),
        SendStage::Accepted => Err(ToolFailure::StoppedAfterSend { stop, sent }),
    }
}

/// Reports a `save_draft` call that was stopped by whether storing its
/// draft began: a stop before it stored nothing and stays as it is, and a
/// stop after it may have left the draft stored.
///
/// # Arguments
///
/// * `outcome` - What the call did, `Cancelled` or `TimedOut` when it was
///   stopped.
/// * `storing` - Whether storing the draft began.
///
/// # Returns
///
/// The outcome to report; any outcome but a stop is reported as it is.
fn calculate_save_outcome(outcome: ToolResult, storing: bool) -> ToolResult {
    match outcome {
        Err(ToolFailure::Cancelled) if storing => {
            Err(ToolFailure::StoppedWhileSaving(Stop::Cancelled))
        }
        Err(ToolFailure::TimedOut) if storing => {
            Err(ToolFailure::StoppedWhileSaving(Stop::TimedOut))
        }
        outcome => outcome,
    }
}

/// Handles a finished tool call: logs its outcome and answers the model,
/// with a long result cut.
///
/// # Arguments
///
/// * `name` - The tool's name, for the log.
/// * `outcome` - What the call did.
fn handle_tool_call_outcome(name: &str, outcome: ToolResult) -> CallToolResult {
    match outcome {
        Ok(report) => {
            send_log_line(&format!("tool {name}: done ({})", report.log));
            CallToolResult::success(vec![ContentBlock::text(format_result_text(report.text))])
        }
        Err(failure) => {
            send_log_line(&format!("tool {name}: failed ({})", failure.class()));
            CallToolResult::error(vec![ContentBlock::text(failure.to_string())])
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::pending;

    use super::*;
    use crate::tools::ToolReport;

    /// The text of a result's first content block.
    fn get_first_text(result: &CallToolResult) -> String {
        result
            .content
            .first()
            .and_then(|block| block.as_text())
            .map(|text| text.text.clone())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn answers_a_cancelled_call_a_timed_out_call_and_a_long_result() {
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        let after_cancel = run_tool_call("read_email", cancelled, pending::<ToolResult>()).await;
        let after_limit = handle_tool_call_outcome(
            "read_email",
            run_tool_call_within(
                CancellationToken::new(),
                Duration::from_millis(10),
                pending::<ToolResult>(),
            )
            .await,
        );
        let long = run_tool_call("read_email", CancellationToken::new(), async {
            Ok(ToolReport {
                text: "x".repeat(crate::tools::RESULT_LIMIT + 5),
                log: "test".to_owned(),
            })
        })
        .await;
        let failed = run_tool_call("read_email", CancellationToken::new(), async {
            Err(ToolFailure::StaleId)
        })
        .await;

        assert_eq!(after_cancel.is_error, Some(true));
        assert_eq!(get_first_text(&after_cancel), "The call was cancelled.");
        assert_eq!(after_limit.is_error, Some(true));
        assert_eq!(
            get_first_text(&after_limit),
            "The call did not finish within 240 seconds and was stopped."
        );
        assert_ne!(long.is_error, Some(true));
        assert!(get_first_text(&long).ends_with(crate::tools::CUT_NOTE));
        assert_eq!(failed.is_error, Some(true));
        assert_eq!(
            get_first_text(&failed),
            "That message id is no longer valid. Search again."
        );
    }

    #[test]
    fn reports_a_stopped_send_by_how_far_it_came() {
        let report = || -> ToolResult {
            Ok(ToolReport {
                text: "Sent.".to_owned(),
                log: "send".to_owned(),
            })
        };
        let stages = [
            SendStage::NotHandedOver,
            SendStage::HandedOver,
            SendStage::Accepted,
        ];
        for stage in stages {
            assert_eq!(
                calculate_send_outcome(report(), stage, SentKind::Message),
                report()
            );
            assert_eq!(
                calculate_send_outcome(Err(ToolFailure::SendUnconfirmed), stage, SentKind::Draft),
                Err(ToolFailure::SendUnconfirmed)
            );
        }
        let stops = [
            (ToolFailure::Cancelled, Stop::Cancelled),
            (ToolFailure::TimedOut, Stop::TimedOut),
        ];
        for (failure, stop) in stops {
            assert_eq!(
                calculate_send_outcome(
                    Err(failure.clone()),
                    SendStage::NotHandedOver,
                    SentKind::Message
                ),
                Err(failure.clone())
            );
            assert_eq!(
                calculate_send_outcome(
                    Err(failure.clone()),
                    SendStage::HandedOver,
                    SentKind::Draft
                ),
                Err(ToolFailure::StoppedUnconfirmed(stop))
            );
            for sent in [SentKind::Message, SentKind::Draft] {
                assert_eq!(
                    calculate_send_outcome(Err(failure.clone()), SendStage::Accepted, sent),
                    Err(ToolFailure::StoppedAfterSend { stop, sent })
                );
            }
        }
    }

    #[test]
    fn reports_a_stopped_save_by_whether_storing_its_draft_began() {
        let report = || -> ToolResult {
            Ok(ToolReport {
                text: "Draft saved.".to_owned(),
                log: "draft".to_owned(),
            })
        };
        let stops = [
            (ToolFailure::Cancelled, Stop::Cancelled),
            (ToolFailure::TimedOut, Stop::TimedOut),
        ];
        for storing in [false, true] {
            assert_eq!(calculate_save_outcome(report(), storing), report());
            assert_eq!(
                calculate_save_outcome(Err(ToolFailure::StaleId), storing),
                Err(ToolFailure::StaleId)
            );
        }
        for (failure, stop) in stops {
            assert_eq!(
                calculate_save_outcome(Err(failure.clone()), false),
                Err(failure.clone())
            );
            assert_eq!(
                calculate_save_outcome(Err(failure), true),
                Err(ToolFailure::StoppedWhileSaving(stop))
            );
        }
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
