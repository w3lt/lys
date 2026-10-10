//! Definitions of Lys's client tools: what a model is offered for each tool,
//! and how Settings describes it.
//!
//! These types mirror the tool definition that the backend and the renderer
//! share (`toolDefinitionSchema` in `@lys/share`). They serialize to the same
//! camelCase JSON, which the renderer validates against that schema when it
//! lists the tools, so a field added here must be added there as well.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Group a tool is listed under in Settings.
///
/// Only groups that a current tool uses exist; a new group is also added to
/// the shared definition.
pub enum ToolGroup {
    /// Tools that work with files on this machine.
    Files,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// What a tool does with the machine it runs on.
///
/// Only access levels that a current tool uses exist; a new level is also
/// added to the shared definition.
pub enum ToolAccess {
    /// Reads data on this machine and sends nothing off it.
    Reads,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Which side of Lys runs a tool.
///
/// Every tool this list holds runs in the desktop app, so only `Client`
/// exists here; the shared definition also accepts `backend`, the runner of
/// the tools the backend lists itself.
pub enum ToolRunner {
    /// Runs in the desktop app, which runs each call itself.
    Client,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
/// Type of the value a model supplies for one argument, serialized as the
/// argument's `type` key.
///
/// Only the types that a client tool uses are declared; the shared definition
/// also accepts `number` and `boolean`.
pub enum ToolArgumentType {
    /// Any JSON string.
    String,
    /// Any JSON integer.
    Integer,
    /// One of `values`; the model sends it as a JSON string.
    Enum {
        /// Every accepted value, in the order offered to the model. It is
        /// non-empty and lists each value once.
        values: Vec<&'static str>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// One argument a model supplies when it calls a client tool.
///
/// `argument_type` is flattened, so its `type` key, and an enum's `values`,
/// sit beside the argument's other keys. No other field is named `type` or
/// `values`, so the flattened keys cannot collide.
pub struct ToolArgumentDefinition {
    /// Key of the argument in the tool's parameters object; it is the exact
    /// key the tool's command accepts.
    pub(super) name: &'static str,
    /// Text that tells the model what the argument means.
    pub(super) description: String,
    /// Whether the model must supply the argument.
    pub(super) required: bool,
    /// Type of the value, serialized as `type`, with `values` for an enum.
    #[serde(flatten)]
    pub(super) argument_type: ToolArgumentType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// One client tool: what a model is offered, how Settings groups it, what it
/// does with the machine, and which side of Lys runs it.
pub struct ToolDefinition {
    /// Name the model calls the tool by; also its identity in Settings.
    pub(super) name: &'static str,
    /// Text that tells the model what the tool does; Settings shows it too.
    pub(super) description: String,
    /// Group the tool is listed under in Settings.
    pub(super) group: ToolGroup,
    /// What the tool does with the machine it runs on.
    pub(super) access: ToolAccess,
    /// Which side of Lys runs the tool.
    pub(super) runner: ToolRunner,
    /// Arguments in declaration order, each name once.
    pub(super) arguments: Vec<ToolArgumentDefinition>,
}
