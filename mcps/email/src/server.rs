//! The MCP server: each served mailbox's copy of the tools, their
//! descriptions, and the limits every call runs under.
//!
//! [`MailboxServer`] defines the ten tools once, over one mailbox's
//! context. [`EmailServer`] serves one copy of them per mailbox, named and
//! described for that mailbox, and sends each call to the copy its name
//! belongs to.

use std::future::Future;
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock,
    Implementation, ListToolsResult, PaginatedRequestParams, ProtocolVersion, ResultType,
    ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, tool, tool_router};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::descriptions::{build_instructions, build_mailbox_tool};
use crate::failure::{SentKind, Stop, ToolFailure};
use crate::log::send_log_line;
use crate::smtp::{SendProgress, SendStage};
use crate::tools::drafts::{
    DraftIdArguments, DraftProgress, DraftStage, SaveDraftArguments, SendDraftArguments,
};
use crate::tools::folders::FolderArguments;
use crate::tools::read::{AttachmentArguments, IdArguments};
use crate::tools::search::SearchArguments;
use crate::tools::send::MessageArguments;
use crate::tools::{
    ToolContext, ToolResult, drafts, folders, format_result_text, read, search, send,
};

/// Longest one tool call may take as a whole.
const CALL_LIMIT: Duration = Duration::from_secs(240);

/// The tools of one mailbox, over its account's mail servers.
///
/// Concurrency model: concurrent; the MCP service may run several calls at
/// once, each through a shared reference, and the only state they change
/// is the shared atomic sequence of message identifiers. Resource
/// ownership: owns the mailbox's context; it keeps no connection, as each
/// call opens and closes its own.
#[derive(Debug)]
pub struct MailboxServer {
    /// The mailbox, its account, and what the calls of the process share.
    context: ToolContext,
}

#[tool_router]
impl MailboxServer {
    /// Creates the tools of a mailbox.
    ///
    /// # Arguments
    ///
    /// * `context` - The mailbox, its account, and what the calls share.
    pub fn new(context: ToolContext) -> Self {
        Self { context }
    }

    /// Runs a `search_emails` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with one
    /// page of hits, or that no message matches, as
    /// [`search::run_search_emails`] reports them; or with the sentence of
    /// what failed or stopped the call. An answer other than that sentence
    /// is cut to end with [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is
    /// longer than [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - What to search for, and which page.
    /// * `token` - Cancelled when the client cancels the request.
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
            &self.name_tool("search_emails"),
            token,
            search::run_search_emails(&self.context, arguments),
        )
        .await
    }

    /// Runs a `read_email` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with the
    /// message's header fields, flags, attachments, and text, or with the
    /// sentence of what failed or stopped the call. An answer other than
    /// that sentence is cut to end with
    /// [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is longer than
    /// [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - Which message.
    /// * `token` - Cancelled when the client cancels the request.
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
            &self.name_tool("read_email"),
            token,
            read::run_read_email(&self.context, arguments),
        )
        .await
    }

    /// Runs a `read_conversation` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with the
    /// conversation the message belongs to: the newest of its messages that
    /// fit in the answer, at most 50, oldest first, with how many older
    /// ones were left out, as [`read::run_read_conversation`] reports it;
    /// or with the sentence of what failed or stopped the call. An answer
    /// other than that sentence is cut to end with
    /// [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is longer than
    /// [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - Which message.
    /// * `token` - Cancelled when the client cancels the request.
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
            &self.name_tool("read_conversation"),
            token,
            read::run_read_conversation(&self.context, arguments),
        )
        .await
    }

    /// Runs a `read_attachment` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with the
    /// attachment's name, type, size, and text, or with the sentence of
    /// what failed or stopped the call. An answer other than that sentence
    /// is cut to end with [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is
    /// longer than [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - Which message, and which of its attachments.
    /// * `token` - Cancelled when the client cancels the request.
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
            &self.name_tool("read_attachment"),
            token,
            read::run_read_attachment(&self.context, arguments),
        )
        .await
    }

    /// Runs a `list_folders` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with every
    /// folder, its role, and how many messages it holds or that it cannot
    /// hold any, or that the account has no folder; or with the sentence of
    /// what failed or stopped the call. An answer other than that sentence
    /// is cut to end with [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is
    /// longer than [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `token` - Cancelled when the client cancels the request.
    #[tool(
        name = "list_folders",
        description = "Lists every folder of the account with its role (Inbox, Sent, Drafts, Trash, Junk, Archive, All) and how many messages it holds.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn run_list_folders(&self, token: CancellationToken) -> CallToolResult {
        run_tool_call(
            &self.name_tool("list_folders"),
            token,
            folders::run_list_folders(&self.context),
        )
        .await
    }

    /// Runs a `manage_folder` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with the
    /// folder created, renamed, or deleted, or with the sentence of what
    /// failed or stopped the call. An answer other than that sentence is
    /// cut to end with [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is
    /// longer than [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - What to do with which folder.
    /// * `token` - Cancelled when the client cancels the request.
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
            &self.name_tool("manage_folder"),
            token,
            folders::run_manage_folder(&self.context, arguments),
        )
        .await
    }

    /// Runs a `send_email` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with what
    /// was sent and what became of its Sent copy, or with the sentence of
    /// what failed the call. A call stopped first is answered by how far
    /// its send came, as [`calculate_send_outcome`] reports it. An answer
    /// other than the sentence of a failure or a stop is cut to end with
    /// [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is longer than
    /// [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - The message.
    /// * `token` - Cancelled when the client cancels the request.
    #[tool(
        name = "send_email",
        description = "Sends a message from this mailbox: from must be its own address. With reply_to_id it is a reply in that conversation; with forward_id it forwards that message, quoting its text and attaching its attachments. The recipients and the subject are always this call's own, a reply's and a forward's too. A copy is kept in Sent. Sending is permanent.",
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
        let reported = calculate_send_outcome(outcome, progress.stage(), SentKind::Message);
        handle_tool_call_outcome(&self.name_tool("send_email"), reported)
    }

    /// Runs a `save_draft` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with the
    /// stored draft's id and fields, or, when the server did not report the
    /// id or it could not be found, with the Drafts folder and why; then
    /// with what became of the draft it replaces, if any. A failed call is
    /// answered with the sentence of what failed it, and a call stopped
    /// first by whether storing its draft began, as
    /// [`calculate_save_outcome`] reports it. An answer other than the
    /// sentence of a failure or a stop is cut to end with
    /// [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is longer than
    /// [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - The draft's fields, and the draft it replaces, if
    ///   any.
    /// * `token` - Cancelled when the client cancels the request.
    #[tool(
        name = "save_draft",
        description = "Saves a message in the Drafts folder without sending it, with the fields of send_email but from. With draft_id, replaces that draft. Answers the draft's id for send_draft, save_draft, and delete_draft.",
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
        let reported = calculate_save_outcome(outcome, progress.stage());
        handle_tool_call_outcome(&self.name_tool("save_draft"), reported)
    }

    /// Runs a `send_draft` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with what
    /// was sent and what became of its Sent copy and of the draft, or with
    /// the sentence of what failed the call. A call stopped first is
    /// answered by how far its send came, as [`calculate_send_outcome`]
    /// reports it. An answer other than the sentence of a failure or a stop
    /// is cut to end with [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is
    /// longer than [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - The draft, and the recipients, subject, and text it
    ///   must hold.
    /// * `token` - Cancelled when the client cancels the request.
    #[tool(
        name = "send_draft",
        description = "Sends a message of the Drafts folder as it is stored, from this mailbox: from must be its own address. It keeps a copy in Sent, and deletes the draft, or only marks it as deleted on a server that cannot remove one message on its own. Give the draft's to, cc, bcc, subject, and body: it is sent only when each recipient field names the same addresses as the draft's, in any order, and the subject and the text equal its own; otherwise the answer names the draft's fields and nothing is sent. Sending is permanent.",
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
        let reported = calculate_send_outcome(outcome, progress.stage(), SentKind::Draft);
        handle_tool_call_outcome(&self.name_tool("send_draft"), reported)
    }

    /// Runs a `delete_draft` call under the client's cancellation and
    /// [`CALL_LIMIT`], logs its outcome, and answers the model with whether
    /// the draft was deleted or only marked as deleted, or with the
    /// sentence of what failed or stopped the call. An answer other than
    /// that sentence is cut to end with
    /// [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is longer than
    /// [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT).
    ///
    /// # Arguments
    ///
    /// * `arguments` - Which draft.
    /// * `token` - Cancelled when the client cancels the request.
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
            &self.name_tool("delete_draft"),
            token,
            drafts::run_delete_draft(&self.context, arguments),
        )
        .await
    }
}

impl MailboxServer {
    /// Names one of the mailbox's tools as the client calls it and the log
    /// names it: with the mailbox's tool prefix, so that a log line tells
    /// the mailbox without its address.
    ///
    /// # Arguments
    ///
    /// * `tool` - The tool's name in its definition.
    fn name_tool(&self, tool: &str) -> String {
        format!("{}{tool}", self.context.mailbox.tool_prefix())
    }
}

/// The MCP server over the mailboxes the process serves: one copy of the
/// tools per mailbox.
///
/// Concurrency model: concurrent; the MCP service may run several calls at
/// once, of either mailbox, each through a shared reference. Resource
/// ownership: owns each mailbox's tools and router; it keeps no
/// connection, as each call opens and closes its own. Invariant: the
/// mailboxes are distinct, so no two copies share a name.
#[derive(Debug)]
pub struct EmailServer {
    /// The mailboxes served, in the order their tools are listed.
    mailboxes: Vec<ServedMailbox>,
}

/// One mailbox the server serves: its tools, and its copy of them by the
/// names the client calls.
#[derive(Debug)]
struct ServedMailbox {
    /// The mailbox's tools.
    server: MailboxServer,
    /// Its copies of the tools, found by name.
    router: ToolRouter<MailboxServer>,
}

impl ServedMailbox {
    /// Creates a served mailbox: each tool named and described for it, as
    /// [`build_mailbox_tool`] does.
    ///
    /// # Arguments
    ///
    /// * `context` - The mailbox, its account, and what the calls share.
    fn new(context: ToolContext) -> Self {
        let address = context.account.address.to_string();
        let mut router = ToolRouter::new();
        for mut route in MailboxServer::tool_router() {
            route.attr = build_mailbox_tool(route.attr.clone(), context.mailbox, &address);
            router.add_route(route);
        }
        Self {
            server: MailboxServer::new(context),
            router,
        }
    }
}

impl EmailServer {
    /// Creates the server over the mailboxes.
    ///
    /// # Arguments
    ///
    /// * `contexts` - One context per mailbox served, each of another
    ///   mailbox, in the order their tools are listed.
    pub fn new(contexts: Vec<ToolContext>) -> Self {
        Self {
            mailboxes: contexts.into_iter().map(ServedMailbox::new).collect(),
        }
    }

    /// Finds the mailbox whose copy of the tools has the name.
    ///
    /// # Arguments
    ///
    /// * `tool` - The name the client calls.
    fn find_mailbox(&self, tool: &str) -> Option<&ServedMailbox> {
        self.mailboxes
            .iter()
            .find(|served| served.router.has_route(tool))
    }
}

impl ServerHandler for EmailServer {
    /// Describes the server to the client: its name, `lys-email`, and the
    /// crate's version; tools, its only capability; and the instructions
    /// the model reads about the mailboxes served.
    fn get_info(&self) -> ServerConfig {
        /// The name the server reports to the client.
        const SERVER_NAME: &str = "lys-email";

        let mailboxes: Vec<_> = self
            .mailboxes
            .iter()
            .map(|served| served.server.context.mailbox)
            .collect();
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION")))
            .with_instructions(build_instructions(&mailboxes))
    }

    /// Lists every served mailbox's copy of the tools, mailbox by mailbox,
    /// each mailbox's by name; the list is complete, with no next page,
    /// and fresh for no time where the protocol can say so.
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let supports_cache_hints = context
            .protocol_version()
            .is_some_and(|version| version >= ProtocolVersion::V_2026_07_28);
        Ok(ListToolsResult {
            result_type: Some(ResultType::COMPLETE),
            tools: self
                .mailboxes
                .iter()
                .flat_map(|served| served.router.list_all())
                .collect(),
            meta: None,
            next_cursor: None,
            ttl_ms: supports_cache_hints.then_some(0),
            cache_scope: supports_cache_hints.then_some(CacheScope::Public),
        })
    }

    /// Runs a call on the mailbox whose copy of the tools has its name, or
    /// refuses a name no copy has as an invalid parameter, as rmcp's own
    /// router does.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let Some(served) = self.find_mailbox(&request.name) else {
            return Err(ErrorData::invalid_params("tool not found", None));
        };
        served
            .router
            .call(ToolCallContext::new(&served.server, request, context))
            .await
    }

    /// Gets the copy of a tool with the name, from the mailbox it belongs
    /// to.
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.find_mailbox(name)
            .and_then(|served| served.router.get(name).cloned())
    }
}

/// Runs one tool call under the cancellation token and [`CALL_LIMIT`], logs
/// its outcome, and answers the model with the call's report, cut to end
/// with [`CUT_NOTE`](crate::tools::CUT_NOTE) when it is longer than
/// [`RESULT_LIMIT`](crate::tools::RESULT_LIMIT), or with the sentence of
/// what failed or stopped the call.
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
    let outcome = calculate_call_outcome(run_tool_call_within(token, CALL_LIMIT, call).await);
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
/// The call's outcome once it finished, or what stopped it first: the
/// cancellation or the limit.
async fn run_tool_call_within<F>(
    token: CancellationToken,
    limit: Duration,
    call: F,
) -> Result<ToolResult, Stop>
where
    F: Future<Output = ToolResult>,
{
    tokio::select! {
        () = token.cancelled() => Err(Stop::Cancelled),
        finished = timeout(limit, call) => finished.map_err(|_| Stop::TimedOut),
    }
}

/// Calculates what a call reports when how far it came does not change
/// the report of its stop, as for every tool but the two send tools and
/// `save_draft`: the call's outcome once it finished, or the stop that
/// came first, as it is.
///
/// # Arguments
///
/// * `outcome` - What the call did once it finished, or what stopped it
///   first.
fn calculate_call_outcome(outcome: Result<ToolResult, Stop>) -> ToolResult {
    outcome.unwrap_or_else(|stop| Err(stop.into()))
}

/// Reports a send tool's call that was stopped by how far its send came:
/// a stop before the end of the message was handed over sent nothing and
/// is reported as it is; a stop after it, while the server's answer was
/// awaited, leaves the send unconfirmed; and a stop after the server
/// accepted the message is reported as a send whose later steps may be
/// missing.
///
/// # Arguments
///
/// * `outcome` - What the call did once it finished, or what stopped it
///   first.
/// * `stage` - How far its send came.
/// * `sent` - What the tool sends.
///
/// # Returns
///
/// The outcome to report; a call that finished is reported as it is.
fn calculate_send_outcome(
    outcome: Result<ToolResult, Stop>,
    stage: SendStage,
    sent: SentKind,
) -> ToolResult {
    let stop = match outcome {
        Ok(finished) => return finished,
        Err(stop) => stop,
    };
    match stage {
        SendStage::NotHandedOver => Err(stop.into()),
        SendStage::HandedOver => Err(ToolFailure::StoppedUnconfirmed(stop)),
        SendStage::Accepted => Err(ToolFailure::StoppedAfterSend { stop, sent }),
    }
}

/// Reports a `save_draft` call that was stopped by whether storing its
/// draft began: a stop before it stored nothing and is reported as it is,
/// and a stop after it may have left the draft stored, and the draft it
/// replaces, which it names, still in Drafts.
///
/// # Arguments
///
/// * `outcome` - What the call did once it finished, or what stopped it
///   first.
/// * `stage` - How far the call came, with the draft it replaces once
///   storing began.
///
/// # Returns
///
/// The outcome to report; a call that finished is reported as it is.
fn calculate_save_outcome(outcome: Result<ToolResult, Stop>, stage: DraftStage) -> ToolResult {
    let stop = match outcome {
        Ok(finished) => return finished,
        Err(stop) => stop,
    };
    match stage {
        DraftStage::BeforeStoring => Err(stop.into()),
        DraftStage::Storing { replaced } => Err(ToolFailure::StoppedWhileSaving { stop, replaced }),
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
    use crate::email_id::EmailId;
    use crate::mailbox::Mailbox;
    use crate::tools::{SharedCalls, ToolReport};
    use crate::trust::Trust;

    /// The text of a result's first content block.
    fn get_first_text(result: &CallToolResult) -> String {
        result
            .content
            .first()
            .and_then(|block| block.as_text())
            .map(|text| text.text.clone())
            .unwrap_or_default()
    }

    /// Checks that a cancelled call and a call past its time limit answer
    /// with their error sentences, that a long result is cut to end with
    /// `CUT_NOTE`, and that a failure answers with its sentence as an
    /// error.
    #[tokio::test]
    async fn answers_a_cancelled_call_a_timed_out_call_and_a_long_result() {
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        let after_cancel = run_tool_call("read_email", cancelled, pending::<ToolResult>()).await;
        let after_limit = handle_tool_call_outcome(
            "read_email",
            calculate_call_outcome(
                run_tool_call_within(
                    CancellationToken::new(),
                    Duration::from_millis(10),
                    pending::<ToolResult>(),
                )
                .await,
            ),
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

    /// Checks that a send's result passes through at every stage, while a
    /// cancellation or time-out reads as plain before the message was
    /// handed over, as unconfirmed once it was, and as stopped after the
    /// send once the server accepted it.
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
                calculate_send_outcome(Ok(report()), stage, SentKind::Message),
                report()
            );
            assert_eq!(
                calculate_send_outcome(
                    Ok(Err(ToolFailure::SendUnconfirmed)),
                    stage,
                    SentKind::Draft
                ),
                Err(ToolFailure::SendUnconfirmed)
            );
        }
        let stops = [
            (ToolFailure::Cancelled, Stop::Cancelled),
            (ToolFailure::TimedOut, Stop::TimedOut),
        ];
        for (failure, stop) in stops {
            assert_eq!(
                calculate_send_outcome(Err(stop), SendStage::NotHandedOver, SentKind::Message),
                Err(failure)
            );
            assert_eq!(
                calculate_send_outcome(Err(stop), SendStage::HandedOver, SentKind::Draft),
                Err(ToolFailure::StoppedUnconfirmed(stop))
            );
            for sent in [SentKind::Message, SentKind::Draft] {
                assert_eq!(
                    calculate_send_outcome(Err(stop), SendStage::Accepted, sent),
                    Err(ToolFailure::StoppedAfterSend { stop, sent })
                );
            }
        }
    }

    /// The id of the draft a save replaces in the tests below,
    /// `1.1003.Drafts`.
    fn build_replaced_draft_id() -> EmailId {
        EmailId {
            mailbox: Mailbox::Person,
            uid: 1,
            uid_validity: 1003,
            folder: "Drafts".to_owned(),
        }
    }

    /// Checks that a save's result passes through at every stage, while a
    /// cancellation or time-out reads as plain before storing began and,
    /// once it began, as stopped while saving, with the draft it replaces
    /// if any.
    #[test]
    fn reports_a_stopped_save_by_whether_storing_its_draft_began() {
        let report = || -> ToolResult {
            Ok(ToolReport {
                text: "Draft saved.".to_owned(),
                log: "draft".to_owned(),
            })
        };
        let stages = [
            DraftStage::BeforeStoring,
            DraftStage::Storing { replaced: None },
            DraftStage::Storing {
                replaced: Some(build_replaced_draft_id()),
            },
        ];
        for stage in stages {
            assert_eq!(
                calculate_save_outcome(Ok(report()), stage.clone()),
                report()
            );
            assert_eq!(
                calculate_save_outcome(Ok(Err(ToolFailure::StaleId)), stage),
                Err(ToolFailure::StaleId)
            );
        }
        let stops = [
            (ToolFailure::Cancelled, Stop::Cancelled),
            (ToolFailure::TimedOut, Stop::TimedOut),
        ];
        for (failure, stop) in stops {
            assert_eq!(
                calculate_save_outcome(Err(stop), DraftStage::BeforeStoring),
                Err(failure)
            );
            for replaced in [None, Some(build_replaced_draft_id())] {
                let stage = DraftStage::Storing {
                    replaced: replaced.clone(),
                };
                assert_eq!(
                    calculate_save_outcome(Err(stop), stage),
                    Err(ToolFailure::StoppedWhileSaving { stop, replaced })
                );
            }
        }
    }

    /// Checks that a save cancelled or timed out after storing began
    /// answers, as an error, that the draft may be in the Drafts folder and
    /// that the draft it replaces may still be there too.
    #[tokio::test]
    async fn answers_a_save_stopped_once_storing_began_with_the_draft_it_replaces() {
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let storing = DraftStage::Storing {
            replaced: Some(build_replaced_draft_id()),
        };

        let after_cancel =
            run_tool_call_within(cancelled, CALL_LIMIT, pending::<ToolResult>()).await;
        let after_limit = run_tool_call_within(
            CancellationToken::new(),
            Duration::from_millis(10),
            pending::<ToolResult>(),
        )
        .await;
        let cancel_answer = handle_tool_call_outcome(
            "save_draft",
            calculate_save_outcome(after_cancel, storing.clone()),
        );
        let limit_answer =
            handle_tool_call_outcome("save_draft", calculate_save_outcome(after_limit, storing));

        assert_eq!(cancel_answer.is_error, Some(true));
        assert_eq!(
            get_first_text(&cancel_answer),
            "The call was cancelled after saving the draft began, so the draft may be in the Drafts folder; search that folder before saving it again. The draft it replaces, 1.1003.Drafts, may still be in the Drafts folder too."
        );
        assert_eq!(limit_answer.is_error, Some(true));
        assert_eq!(
            get_first_text(&limit_answer),
            "The call did not finish within 240 seconds and was stopped after saving the draft began, so the draft may be in the Drafts folder; search that folder before saving it again. The draft it replaces, 1.1003.Drafts, may still be in the Drafts folder too."
        );
    }

    /// Checks that the server finds each mailbox's copy of a tool by the
    /// name the client calls, the send tools described with their own
    /// mailbox's address, and no tool by a name neither mailbox has.
    #[test]
    fn finds_each_mailbox_s_copy_of_a_tool_by_its_name() {
        let shared = SharedCalls::new(Trust::create_with_extra_roots(Vec::new()));
        let server = EmailServer::new(vec![
            ToolContext::build_without_sign_in(Mailbox::Person, "person@example.com", &shared),
            ToolContext::build_without_sign_in(Mailbox::Lys, "lys@example.net", &shared),
        ]);
        let found_in = |name: &str| {
            server
                .find_mailbox(name)
                .map(|served| served.server.context.mailbox)
        };
        let sends_from = |name: &str, address: &str| {
            let ending = format!("This mailbox's address is {address}.");
            let described = server.get_tool(name).and_then(|tool| tool.description);
            described.is_some_and(|text| text.ends_with(&ending))
        };

        assert_eq!(found_in("read_email"), Some(Mailbox::Person));
        assert_eq!(found_in("lys_read_email"), Some(Mailbox::Lys));
        assert_eq!(found_in("lys_nothing"), None);
        assert!(sends_from("send_email", "person@example.com"));
        assert!(sends_from("lys_send_email", "lys@example.net"));
        assert!(sends_from("lys_send_draft", "lys@example.net"));
        assert_eq!(server.get_tool("lys_nothing"), None);
    }

    /// Checks that one mailbox's tools are exactly ten, each with a
    /// description and an object input schema, and that `search_emails`
    /// takes a page and is marked read-only.
    #[test]
    fn routes_every_tool_with_a_description_and_a_schema() {
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

        let router = MailboxServer::tool_router();
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
