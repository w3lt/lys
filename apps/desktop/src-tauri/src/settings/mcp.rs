//! MCP servers stored under the `mcp` settings group.
//!
//! The group lists the Model Context Protocol servers Lys connects to, in the
//! order Settings shows them: a command Lys starts and talks to over its
//! standard input and output (`stdio`), or a URL it sends requests to over
//! Streamable HTTP (`http`). A missing group, a missing `servers` list, and a
//! settings file written before the group existed all mean no server. The
//! backend reads the group from the saved file and connects to each server;
//! this module only stores it.
//!
//! Every rule matches `mcpSettingsSchema` in `@lys/share`, which the renderer
//! and the backend check. A text with a lone surrogate, which that schema
//! refuses, never reaches these rules: the JSON reader refuses its escape, so
//! the whole settings file fails to load. URLs to internationalized domain
//! names are refused on both sides, because this host's URL parser and the
//! JavaScript ones convert such names differently.
//!
//! Environment variable values and header values can hold secrets, such as
//! tokens: they are stored as plain text in the owner-only settings file,
//! `Debug` never shows them, and a validation error about a server entry,
//! where they sit, never quotes a value. An error about the group itself,
//! such as a `servers` value that is not a list, can quote that value, because
//! it is the JSON reader's own message.

use std::{collections::HashSet, fmt};

use serde::de::{DeserializeOwned, Error};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use tauri::Url;

/// Most servers the group may hold, inclusive. Matches
/// `MAXIMUM_MCP_SERVER_COUNT` in `@lys/share`.
const SERVER_MAX_COUNT: usize = 16;

/// Most bytes the group may take, inclusive: the UTF-8 bytes of the group
/// written as compact JSON. Matches `MAXIMUM_MCP_SETTINGS_BYTES` in
/// `@lys/share`, half of the settings file the backend reads, so the group,
/// the indentation this host writes, and the other groups fit in it.
const SETTINGS_MAX_BYTES: usize = 512 * 1024;

/// Most characters a server name may have, inclusive. Matches
/// `MAXIMUM_MCP_SERVER_NAME_LENGTH` in `@lys/share`.
const SERVER_NAME_MAX_LENGTH: usize = 20;

/// Most characters, counted as Unicode scalar values, of a stdio command.
/// Matches `MAXIMUM_MCP_COMMAND_LENGTH` in `@lys/share`.
const COMMAND_MAX_LENGTH: usize = 1024;

/// Most arguments a stdio command may have, inclusive. Matches
/// `MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT` in `@lys/share`.
const COMMAND_ARGUMENT_MAX_COUNT: usize = 64;

/// Most characters, counted as Unicode scalar values, of one command
/// argument. Matches `MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH` in `@lys/share`.
const COMMAND_ARGUMENT_MAX_LENGTH: usize = 1024;

/// Most environment variables a stdio server may set, inclusive. Matches
/// `MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT` in `@lys/share`.
const ENVIRONMENT_VARIABLE_MAX_COUNT: usize = 32;

/// Most characters of an environment variable name, inclusive. Matches the
/// variable name pattern of `@lys/share`.
const ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH: usize = 128;

/// Most characters, counted as Unicode scalar values, of one variable's
/// value. Matches `MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH` in `@lys/share`.
const ENVIRONMENT_VALUE_MAX_LENGTH: usize = 4096;

/// Most characters, counted as Unicode scalar values, of a server URL.
/// Matches `MAXIMUM_MCP_SERVER_URL_LENGTH` in `@lys/share`.
const SERVER_URL_MAX_LENGTH: usize = 2048;

/// Most headers a remote server may be sent, inclusive. Matches
/// `MAXIMUM_MCP_HEADER_COUNT` in `@lys/share`.
const HEADER_MAX_COUNT: usize = 32;

/// Most characters of a header name, inclusive. Matches the header name
/// pattern of `@lys/share`.
const HEADER_NAME_MAX_LENGTH: usize = 128;

/// Most characters of a header value, inclusive. Matches
/// `MAXIMUM_MCP_HEADER_VALUE_LENGTH` in `@lys/share`.
const HEADER_VALUE_MAX_LENGTH: usize = 8192;

/// Header names the HTTP transport sets itself, in lowercase; a server is
/// never sent another value for them.
const TRANSPORT_HEADER_NAMES: [&str; 7] = [
    "accept",
    "content-length",
    "content-type",
    "host",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
];

/// Header names, in lowercase, that Node's fetch, which the backend sends MCP
/// requests with, refuses: a request with one of them fails before it is
/// sent. Matches the list of `@lys/share`.
const UNSENDABLE_HEADER_NAMES: [&str; 4] = ["expect", "keep-alive", "transfer-encoding", "upgrade"];

/// Hosts a server URL may reach over plain `http:`, as the URL parser writes
/// them.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Start of a label of an internationalized domain name, in ASCII form.
const PUNYCODE_LABEL_PREFIX: &str = "xn--";

/// Characters an HTTP header name may hold besides ASCII letters and digits:
/// the rest of an RFC 9110 token.
const HEADER_NAME_SYMBOLS: &[u8] = b"!#$%&'*+.^_`|~-";

/// Error of a server that is not an object of a known transport with only its
/// own fields, each of the right type.
const SERVER_SHAPE_ERROR: &str = "an MCP server must be an object whose transport is stdio or http, with only that transport's fields, each of the right type";

#[derive(Debug, Clone, Default, Serialize)]
/// MCP servers persisted under the `mcp` JSON object.
///
/// A missing group or a missing `servers` list means no server. The group and
/// the list may not be `null`, and unknown fields are rejected. It holds at
/// most 16 servers, each name once, in the order Settings lists them, which
/// take at most 512 KiB together as compact JSON.
pub struct McpSettings {
    /// Servers in list order.
    servers: Vec<McpServer>,
}

/// Deserializes the group and applies its rules.
impl<'de> Deserialize<'de> for McpSettings {
    /// Reads the `mcp` object and rejects a group that breaks a rule.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not an object with
    /// only a `servers` list, a server breaks a rule, or the group holds more
    /// than 16 servers or two with one name.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let stored: StoredMcpSettings = parse_json_object(deserializer)?;

        Self::try_from(stored).map_err(D::Error::custom)
    }
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
/// The `mcp` JSON object before the group's own rules apply.
struct StoredMcpSettings {
    /// Servers in list order, each already valid on its own.
    servers: Vec<McpServer>,
}

impl TryFrom<StoredMcpSettings> for McpSettings {
    type Error = &'static str;

    /// Applies the server count, the distinct-name rule, and the group's
    /// size limit.
    ///
    /// # Errors
    ///
    /// Returns a message without any value when there are more than 16
    /// servers, two share a name, or the group takes more than 512 KiB as
    /// compact JSON.
    fn try_from(stored: StoredMcpSettings) -> Result<Self, Self::Error> {
        if stored.servers.len() > SERVER_MAX_COUNT {
            return Err("the mcp group may hold at most 16 servers");
        }
        if !has_distinct_values(stored.servers.iter().map(McpServer::name)) {
            return Err("each MCP server must have its own name");
        }
        let settings = Self {
            servers: stored.servers,
        };
        if !settings.is_within_size_limit() {
            return Err("the MCP servers may take at most 512 KiB of settings together");
        }

        Ok(settings)
    }
}

impl McpSettings {
    /// Reports whether the group takes at most [`SETTINGS_MAX_BYTES`] as
    /// compact JSON, as it is written with every list filled in.
    fn is_within_size_limit(&self) -> bool {
        serde_json::to_vec(self).is_ok_and(|bytes| bytes.len() <= SETTINGS_MAX_BYTES)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "transport", rename_all = "lowercase")]
/// One MCP server, by the way Lys talks to it.
enum McpServer {
    /// A command Lys starts and talks to over stdio.
    Stdio(StdioMcpServer),
    /// A URL Lys sends requests to over Streamable HTTP.
    Http(HttpMcpServer),
}

impl McpServer {
    /// Returns the name the server is listed and its tools are named by.
    fn name(&self) -> &str {
        match self {
            Self::Stdio(server) => &server.name,
            Self::Http(server) => &server.name,
        }
    }
}

/// Deserializes one server and applies its rules.
impl<'de> Deserialize<'de> for McpServer {
    /// Reads one server object and rejects one that breaks a rule.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a server object
    /// of a known transport with only its own fields, or a field breaks its
    /// rule. The error names the rule and never contains a value, because
    /// the deserializer's own messages can quote one.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let stored: StoredMcpServer =
            parse_json_object(deserializer).map_err(|_| D::Error::custom(SERVER_SHAPE_ERROR))?;

        Self::try_from(stored).map_err(D::Error::custom)
    }
}

#[derive(Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase")]
/// One server object before its rules apply.
enum StoredMcpServer {
    /// A command server.
    Stdio(StoredStdioMcpServer),
    /// A URL server.
    Http(StoredHttpMcpServer),
}

impl TryFrom<StoredMcpServer> for McpServer {
    type Error = &'static str;

    /// Applies the rules of the server's transport.
    ///
    /// # Errors
    ///
    /// Returns the message of the first broken rule, without any value.
    fn try_from(stored: StoredMcpServer) -> Result<Self, Self::Error> {
        match stored {
            StoredMcpServer::Stdio(server) => StdioMcpServer::try_from(server).map(Self::Stdio),
            StoredMcpServer::Http(server) => HttpMcpServer::try_from(server).map(Self::Http),
        }
    }
}

#[derive(Clone, Serialize)]
/// A server Lys starts as a command and talks to over stdio.
///
/// `Debug` shows the command and how many arguments it has; the arguments
/// and the variables' values can hold secrets and are not shown.
struct StdioMcpServer {
    /// Name the server is listed and its tools are named by.
    name: String,
    /// Program to run, found through `PATH` unless it is a path.
    command: String,
    /// Arguments in order; empty when there is none.
    arguments: Vec<String>,
    /// Variables added to the default environment, each name once.
    environment: Vec<McpEnvironmentVariable>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
/// A command server object before its rules apply.
struct StoredStdioMcpServer {
    /// Server name.
    name: String,
    /// Command text.
    command: String,
    /// Arguments; a missing list means none.
    #[serde(default)]
    arguments: Vec<String>,
    /// Variables; a missing list means none.
    #[serde(default, deserialize_with = "parse_json_objects")]
    environment: Vec<StoredNamedValue>,
}

impl TryFrom<StoredStdioMcpServer> for StdioMcpServer {
    type Error = &'static str;

    /// Applies the name, command, argument, and environment rules.
    ///
    /// # Errors
    ///
    /// Returns the message of the first broken rule, without any value.
    fn try_from(stored: StoredStdioMcpServer) -> Result<Self, Self::Error> {
        let name = parse_server_name(stored.name)?;
        if !is_command(&stored.command) {
            return Err("a command must be 1 to 1024 characters, without control characters or tabs, and without white space at either end");
        }
        if stored.arguments.len() > COMMAND_ARGUMENT_MAX_COUNT {
            return Err("a command may have at most 64 arguments");
        }
        if !stored
            .arguments
            .iter()
            .all(|argument| is_command_argument(argument))
        {
            return Err("an argument must be 1 to 1024 characters, without line breaks or other control characters");
        }

        Ok(Self {
            name,
            command: stored.command,
            arguments: stored.arguments,
            environment: build_environment(stored.environment)?,
        })
    }
}

#[derive(Clone, Serialize)]
/// A server Lys sends requests to over Streamable HTTP.
///
/// `Debug` shows the URL without its query; the query and the headers'
/// values can hold secrets and are not shown.
struct HttpMcpServer {
    /// Name the server is listed and its tools are named by.
    name: String,
    /// Endpoint of the server.
    url: String,
    /// Headers sent with every request, each name once ignoring case.
    headers: Vec<McpHeader>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
/// A URL server object before its rules apply.
struct StoredHttpMcpServer {
    /// Server name.
    name: String,
    /// URL text.
    url: String,
    /// Headers; a missing list means none.
    #[serde(default, deserialize_with = "parse_json_objects")]
    headers: Vec<StoredNamedValue>,
}

impl TryFrom<StoredHttpMcpServer> for HttpMcpServer {
    type Error = &'static str;

    /// Applies the name, URL, and header rules.
    ///
    /// # Errors
    ///
    /// Returns the message of the first broken rule, without any value.
    fn try_from(stored: StoredHttpMcpServer) -> Result<Self, Self::Error> {
        let name = parse_server_name(stored.name)?;
        if !is_server_url(&stored.url) {
            return Err("a URL must be up to 2048 characters without spaces, start with https://, or http:// for localhost, 127.0.0.1, or [::1], and have no user name, password, or #");
        }
        if has_internationalized_host(&stored.url) {
            return Err("a URL's host must not be an internationalized domain name: no part of it may start with xn--");
        }

        Ok(Self {
            name,
            url: stored.url,
            headers: build_headers(stored.headers)?,
        })
    }
}

impl fmt::Debug for StdioMcpServer {
    /// Writes the name, the command, the argument count, and the variables
    /// without their values.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StdioMcpServer")
            .field("name", &self.name)
            .field("command", &self.command)
            .field("argument_count", &self.arguments.len())
            .field("environment", &self.environment)
            .finish()
    }
}

impl fmt::Debug for HttpMcpServer {
    /// Writes the name, the URL without its query, and the headers without
    /// their values.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let url_without_query = self
            .url
            .split_once('?')
            .map_or(self.url.as_str(), |(start, _)| start);
        formatter
            .debug_struct("HttpMcpServer")
            .field("name", &self.name)
            .field("url", &url_without_query)
            .field("headers", &self.headers)
            .finish()
    }
}

#[derive(Clone, Serialize)]
/// One environment variable a stdio server is started with.
///
/// The value can be a secret; `Debug` shows only the name.
struct McpEnvironmentVariable {
    /// Variable name.
    name: String,
    /// Variable value; empty is allowed.
    value: String,
}

impl fmt::Debug for McpEnvironmentVariable {
    /// Writes the name and a placeholder instead of the value.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpEnvironmentVariable")
            .field("name", &self.name)
            .field("value", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Serialize)]
/// One HTTP header sent to a remote server.
///
/// The value can be a secret, such as a bearer token; `Debug` shows only the
/// name.
struct McpHeader {
    /// Header name.
    name: String,
    /// Header value; empty is allowed.
    value: String,
}

impl fmt::Debug for McpHeader {
    /// Writes the name and a placeholder instead of the value.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpHeader")
            .field("name", &self.name)
            .field("value", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
/// An environment variable or header object before its rules apply.
struct StoredNamedValue {
    /// Name text.
    name: String,
    /// Value text.
    value: String,
}

/// Reads a JSON object into a stored shape, refusing every other JSON value.
///
/// Serde's derived structs and tagged enums also read a JSON array as their
/// fields in order; `mcpSettingsSchema` refuses that form, so every stored
/// shape is read from an object first.
///
/// # Errors
///
/// Returns the deserializer's error when the input is not a JSON object, and
/// the shape's error when the object does not match it.
fn parse_json_object<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let object = Map::<String, Value>::deserialize(deserializer)?;

    T::deserialize(Value::Object(object)).map_err(D::Error::custom)
}

/// Reads a JSON array of objects into stored shapes, refusing any item that is
/// not a JSON object, as [`parse_json_object`] does for one.
///
/// # Errors
///
/// Returns the deserializer's error when the input is not an array of JSON
/// objects, and the shape's error when an object does not match it.
fn parse_json_objects<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Vec::<Map<String, Value>>::deserialize(deserializer)?
        .into_iter()
        .map(|object| T::deserialize(Value::Object(object)).map_err(D::Error::custom))
        .collect()
}

/// Parses a stored server name.
///
/// # Errors
///
/// Returns the name rule when `name` breaks it.
fn parse_server_name(name: String) -> Result<String, &'static str> {
    if is_server_name(&name) {
        Ok(name)
    } else {
        Err("an MCP server name must be 1 to 20 lowercase letters and digits, with single hyphens between them")
    }
}

/// Builds the environment of a stdio server from its stored variables.
///
/// # Errors
///
/// Returns the broken rule when there are more than 32 variables, a name or a
/// value breaks its rule, or two variables share a name.
fn build_environment(
    stored: Vec<StoredNamedValue>,
) -> Result<Vec<McpEnvironmentVariable>, &'static str> {
    if stored.len() > ENVIRONMENT_VARIABLE_MAX_COUNT {
        return Err("a server may set at most 32 environment variables");
    }
    if !stored
        .iter()
        .all(|variable| is_environment_variable_name(&variable.name))
    {
        return Err("a variable name must be up to 128 ASCII letters, digits, and underscores, not starting with a digit");
    }
    if !stored
        .iter()
        .all(|variable| is_environment_value(&variable.value))
    {
        return Err("a variable's value must be up to 4096 characters, without line breaks or other control characters");
    }
    if !has_distinct_values(stored.iter().map(|variable| variable.name.as_str())) {
        return Err("a server must set each environment variable once");
    }

    Ok(stored
        .into_iter()
        .map(|variable| McpEnvironmentVariable {
            name: variable.name,
            value: variable.value,
        })
        .collect())
}

/// Builds the headers of a remote server from its stored headers.
///
/// # Errors
///
/// Returns the broken rule when there are more than 32 headers, a name or a
/// value breaks its rule, or two headers share a name ignoring case.
fn build_headers(stored: Vec<StoredNamedValue>) -> Result<Vec<McpHeader>, &'static str> {
    if stored.len() > HEADER_MAX_COUNT {
        return Err("a server may be sent at most 32 headers");
    }
    if !stored.iter().all(|header| is_header_name(&header.name)) {
        return Err("a header name must be up to 128 letters, digits, and the characters !#$%&'*+.^_`|~-, and not one Lys sets itself or cannot send");
    }
    if !stored.iter().all(|header| is_header_value(&header.value)) {
        return Err("a header value must be up to 8192 visible ASCII characters, spaces, and tabs, with no space or tab at either end");
    }
    let lowercase_names: Vec<String> = stored
        .iter()
        .map(|header| header.name.to_ascii_lowercase())
        .collect();
    if !has_distinct_values(lowercase_names.iter().map(String::as_str)) {
        return Err("a server must be sent each header once");
    }

    Ok(stored
        .into_iter()
        .map(|header| McpHeader {
            name: header.name,
            value: header.value,
        })
        .collect())
}

/// Reports whether every value appears once, compared exactly.
fn has_distinct_values<'value>(mut values: impl Iterator<Item = &'value str>) -> bool {
    let mut seen = HashSet::new();

    values.all(|value| seen.insert(value))
}

/// Reports whether `value` holds a control character other than a tab.
fn has_control_character_other_than_tab(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_control() && character != '\t')
}

/// Reports whether `value` is 1 to 20 lowercase ASCII letters and digits in
/// runs joined by single hyphens, without a hyphen at either end.
fn is_server_name(value: &str) -> bool {
    value.len() <= SERVER_NAME_MAX_LENGTH
        && value.split('-').all(|run| {
            !run.is_empty()
                && run
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

/// Reports whether `value` is a command: 1 to 1024 characters, no control
/// character (tabs included), and no white space at either end.
fn is_command(value: &str) -> bool {
    (1..=COMMAND_MAX_LENGTH).contains(&value.chars().count())
        && !value.chars().any(char::is_control)
        && !value.starts_with(char::is_whitespace)
        && !value.ends_with(char::is_whitespace)
}

/// Reports whether `value` is a command argument: 1 to 1024 characters and
/// no control character other than a tab.
fn is_command_argument(value: &str) -> bool {
    (1..=COMMAND_ARGUMENT_MAX_LENGTH).contains(&value.chars().count())
        && !has_control_character_other_than_tab(value)
}

/// Reports whether `value` is an environment variable name: an ASCII letter
/// or underscore, then up to 127 ASCII letters, digits, or underscores.
fn is_environment_variable_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    let starts_well = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_');

    starts_well
        && value.len() <= ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Reports whether `value` is an environment variable value: up to 4096
/// characters and no control character other than a tab.
fn is_environment_value(value: &str) -> bool {
    value.chars().count() <= ENVIRONMENT_VALUE_MAX_LENGTH
        && !has_control_character_other_than_tab(value)
}

/// Reports whether `value` is a URL Lys may send MCP requests to.
///
/// It holds up to 2048 characters without white space or control characters
/// and without `#`, and parses as an absolute `https:` URL, or an `http:` URL
/// whose host is `localhost`, `127.0.0.1`, or `[::1]` as the URL parser
/// writes it, with no user name or password.
fn is_server_url(value: &str) -> bool {
    let is_plain_text = value.chars().count() <= SERVER_URL_MAX_LENGTH
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && !value.contains('#');
    if !is_plain_text {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    match url.scheme() {
        "https" => true,
        "http" => url
            .host_str()
            .is_some_and(|host| LOOPBACK_HOSTS.contains(&host)),
        _ => false,
    }
}

/// Reports whether `value` parses as a URL whose host, as the URL parser
/// writes it in lowercase ASCII, has a label starting with `xn--`, which a
/// Unicode host such as `bücher.example` also gets.
///
/// URL parsers do not convert such names alike: this host's and Node's
/// accept different ones. Refusing them all keeps one judgement of every
/// server URL with `@lys/share`.
fn has_internationalized_host(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.host_str().is_some_and(|host| {
            host.split('.')
                .any(|label| label.starts_with(PUNYCODE_LABEL_PREFIX))
        })
    })
}

/// Reports whether `value` is a header name: 1 to 128 characters of an RFC
/// 9110 token, and not one the transport sets itself or Node's fetch cannot
/// send, ignoring case.
fn is_header_name(value: &str) -> bool {
    let is_token = (1..=HEADER_NAME_MAX_LENGTH).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || HEADER_NAME_SYMBOLS.contains(&byte));
    let lowercase_name = value.to_ascii_lowercase();

    is_token
        && !TRANSPORT_HEADER_NAMES.contains(&lowercase_name.as_str())
        && !UNSENDABLE_HEADER_NAMES.contains(&lowercase_name.as_str())
}

/// Reports whether `value` is a header value: up to 8192 visible ASCII
/// characters, spaces, and tabs, with no space or tab at either end.
fn is_header_value(value: &str) -> bool {
    let is_edge_visible = |byte: &u8| byte.is_ascii_graphic();

    value.len() <= HEADER_VALUE_MAX_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ' || byte == b'\t')
        && value.as_bytes().first().is_none_or(is_edge_visible)
        && value.as_bytes().last().is_none_or(is_edge_visible)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{
        McpSettings, COMMAND_ARGUMENT_MAX_COUNT, ENVIRONMENT_VALUE_MAX_LENGTH,
        ENVIRONMENT_VARIABLE_MAX_COUNT, SERVER_MAX_COUNT, SETTINGS_MAX_BYTES,
    };

    /// Reads `stored` as the `mcp` group.
    fn parse_mcp_settings(stored: Value) -> Result<McpSettings, serde_json::Error> {
        serde_json::from_value(stored)
    }

    /// Returns a valid stdio server named `name`, with every field written.
    fn get_stdio_server(name: &str) -> Value {
        json!({
            "name": name,
            "transport": "stdio",
            "command": "/opt/homebrew/bin/npx",
            "arguments": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Notes"],
            "environment": [{ "name": "LOG_LEVEL", "value": "warn" }]
        })
    }

    /// Returns a valid HTTP server named `name`, with every field written.
    fn get_http_server(name: &str) -> Value {
        json!({
            "name": name,
            "transport": "http",
            "url": "https://mcp.example.com/mcp",
            "headers": [{ "name": "Authorization", "value": "Bearer synthetic-token" }]
        })
    }

    /// Reads a group holding only `server`.
    fn parse_server(server: Value) -> Result<McpSettings, serde_json::Error> {
        parse_mcp_settings(json!({ "servers": [server] }))
    }

    /// Asserts that a group holding only `server` is accepted.
    fn assert_server_accepted(server: Value) {
        let parsed = parse_server(server.clone());

        assert!(parsed.is_ok(), "{server}: {parsed:?}");
    }

    /// Asserts that a group holding only `server` is refused without quoting
    /// `secret`.
    fn assert_server_refused(server: Value, secret: &str) {
        let failure = parse_server(server.clone()).expect_err("an invalid server");

        assert!(!failure.to_string().contains(secret), "{failure}");
    }

    /// Returns a stdio server with one field replaced.
    fn get_stdio_server_with(field: &str, value: Value) -> Value {
        let mut server = get_stdio_server("files");
        server[field] = value;

        server
    }

    /// Returns an HTTP server with one field replaced.
    fn get_http_server_with(field: &str, value: Value) -> Value {
        let mut server = get_http_server("docs");
        server[field] = value;

        server
    }

    /// Returns the bytes `value` takes as compact JSON.
    fn calculate_compact_json_bytes(value: &Value) -> usize {
        serde_json::to_vec(value).expect("serialize").len()
    }

    /// Returns an `mcp` group that takes exactly `bytes` as compact JSON: the
    /// most stdio servers, each with the most one-character arguments and the
    /// most variables, whose values take the remaining bytes in list order.
    fn build_group_of_bytes(bytes: usize) -> Value {
        let mut servers: Vec<Value> = (0..SERVER_MAX_COUNT)
            .map(|server_index| {
                let environment: Vec<Value> = (0..ENVIRONMENT_VARIABLE_MAX_COUNT)
                    .map(|variable_index| json!({ "name": format!("V{variable_index}"), "value": "" }))
                    .collect();
                json!({
                    "name": format!("server-{server_index}"),
                    "transport": "stdio",
                    "command": "c",
                    "arguments": vec!["a"; COMMAND_ARGUMENT_MAX_COUNT],
                    "environment": environment
                })
            })
            .collect();
        let mut remaining = bytes - calculate_compact_json_bytes(&json!({ "servers": servers }));
        for server in &mut servers {
            for variable in server["environment"].as_array_mut().expect("variables") {
                let length = remaining.min(ENVIRONMENT_VALUE_MAX_LENGTH);
                variable["value"] = json!("v".repeat(length));
                remaining -= length;
            }
        }

        json!({ "servers": servers })
    }

    /// Groups that the host and `mcpSettingsSchema` in `@lys/share` must judge
    /// alike; the backend's tests of its settings reader read the same file.
    const SHARED_CASES: &str =
        include_str!("../../../../../packages/share/test/fixtures/mcp-settings-groups.json");

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    /// One case of the shared groups.
    struct SharedCase {
        /// What the case checks.
        case: String,
        /// Value of the `mcp` group.
        group: Value,
        /// Whether the rules accept the group.
        accepted: bool,
        /// What the host writes back for an accepted group.
        written: Option<Value>,
    }

    /// Describes how the host's judgement of `case` differs from the shared
    /// one, or returns `None` when it matches.
    fn find_shared_case_mismatch(case: SharedCase) -> Option<String> {
        match (parse_mcp_settings(case.group), case.accepted) {
            (Ok(_), false) => Some(format!("{}: accepted", case.case)),
            (Err(error), true) => Some(format!("{}: refused ({error})", case.case)),
            (Err(_), false) => None,
            (Ok(settings), true) => {
                let written = serde_json::to_value(&settings).expect("serialize");

                (case.written.as_ref() != Some(&written))
                    .then(|| format!("{}: writes {written}", case.case))
            }
        }
    }

    #[test]
    fn reads_a_missing_group_list_as_no_server_and_writes_an_empty_list() {
        let settings = parse_mcp_settings(json!({})).expect("an empty group");

        assert_eq!(
            serde_json::to_value(&settings).expect("serialize"),
            json!({ "servers": [] })
        );
        assert_eq!(
            serde_json::to_value(McpSettings::default()).expect("serialize"),
            json!({ "servers": [] })
        );
    }

    #[test]
    fn writes_both_transports_back_unchanged() {
        let stored = json!({ "servers": [get_stdio_server("files"), get_http_server("docs")] });

        let settings = parse_mcp_settings(stored.clone()).expect("a valid group");

        assert_eq!(serde_json::to_value(&settings).expect("serialize"), stored);
    }

    #[test]
    fn reads_missing_lists_of_a_server_as_empty() {
        let settings = parse_mcp_settings(json!({ "servers": [
            { "name": "files", "transport": "stdio", "command": "npx" },
            { "name": "docs", "transport": "http", "url": "https://mcp.example.com/mcp" }
        ] }))
        .expect("a valid group");

        assert_eq!(
            serde_json::to_value(&settings).expect("serialize"),
            json!({ "servers": [
                { "name": "files", "transport": "stdio", "command": "npx", "arguments": [], "environment": [] },
                { "name": "docs", "transport": "http", "url": "https://mcp.example.com/mcp", "headers": [] }
            ] })
        );
    }

    #[test]
    fn rejects_a_null_group_a_null_list_unknown_fields_and_unknown_transports() {
        for stored in [
            Value::Null,
            json!({ "servers": null }),
            json!({ "servers": [], "enabled": true }),
            json!({ "servers": [{ "name": "files", "transport": "sse", "url": "https://mcp.example.com" }] }),
            json!({ "servers": [{ "name": "files", "command": "npx" }] }),
            json!({ "servers": [get_stdio_server_with("url", json!("https://mcp.example.com"))] }),
            json!({ "servers": [get_http_server_with("command", json!("npx"))] }),
        ] {
            assert!(parse_mcp_settings(stored.clone()).is_err(), "{stored}");
        }
    }

    #[test]
    fn accepts_up_to_16_servers_with_distinct_names() {
        let servers: Vec<Value> = (0..16)
            .map(|index| get_stdio_server(&format!("server-{index}")))
            .collect();

        assert!(parse_mcp_settings(json!({ "servers": servers })).is_ok());
    }

    #[test]
    fn rejects_more_than_16_servers_and_repeated_names() {
        let servers: Vec<Value> = (0..17)
            .map(|index| get_stdio_server(&format!("server-{index}")))
            .collect();

        for stored in [
            json!({ "servers": servers }),
            json!({ "servers": [get_stdio_server("files"), get_http_server("files")] }),
        ] {
            assert!(parse_mcp_settings(stored.clone()).is_err(), "{stored}");
        }
    }

    #[test]
    fn accepts_a_group_of_512_kib_and_rejects_one_byte_more() {
        let group = build_group_of_bytes(SETTINGS_MAX_BYTES);
        let too_large_group = build_group_of_bytes(SETTINGS_MAX_BYTES + 1);

        let settings = parse_mcp_settings(group.clone()).expect("a group at the limit");
        let failure = parse_mcp_settings(too_large_group).expect_err("a group past the limit");

        assert_eq!(calculate_compact_json_bytes(&group), 512 * 1024);
        assert_eq!(serde_json::to_value(&settings).expect("serialize"), group);
        assert!(failure.to_string().contains("512 KiB"), "{failure}");
    }

    #[test]
    fn counts_the_group_in_utf8_bytes_not_in_characters() {
        let mut group = build_group_of_bytes(SETTINGS_MAX_BYTES);
        group["servers"][0]["environment"][0]["value"] =
            json!("é".repeat(ENVIRONMENT_VALUE_MAX_LENGTH / 2 + 1));
        let characters = group.to_string().chars().count();

        let parsed = parse_mcp_settings(group);

        assert!(characters < SETTINGS_MAX_BYTES, "{characters}");
        assert!(parsed.is_err());
    }

    #[test]
    fn rejects_a_lone_surrogate_in_every_text_field() {
        for stored in [
            r#"{ "servers": [{ "name": "files", "transport": "stdio", "command": "server\ud800" }] }"#,
            r#"{ "servers": [{ "name": "files", "transport": "stdio", "command": "server", "arguments": ["\udc00"] }] }"#,
            r#"{ "servers": [{ "name": "files", "transport": "stdio", "command": "server", "environment": [{ "name": "TOKEN", "value": "secret\ud83d" }] }] }"#,
            r#"{ "servers": [{ "name": "docs", "transport": "http", "url": "https://mcp.example.com/\udc00" }] }"#,
        ] {
            let failure =
                serde_json::from_str::<McpSettings>(stored).expect_err("a lone surrogate");

            assert!(!failure.to_string().contains("secret"), "{failure}");
        }
    }

    #[test]
    fn accepts_names_of_lowercase_letters_and_digits_in_hyphen_joined_runs() {
        for name in ["a", "files", "github-2", "a-b-c", "x".repeat(20).as_str()] {
            assert_server_accepted(get_stdio_server(name));
        }
    }

    #[test]
    fn rejects_other_server_names() {
        for name in [
            String::new(),
            "x".repeat(21),
            "Files".to_string(),
            "my_files".to_string(),
            "-files".to_string(),
            "files-".to_string(),
            "my--files".to_string(),
            "fïles".to_string(),
            "my files".to_string(),
        ] {
            assert!(parse_server(get_stdio_server(&name)).is_err(), "{name:?}");
        }
    }

    #[test]
    fn accepts_commands_of_one_to_1024_characters_with_inner_spaces() {
        for command in [
            "n".to_string(),
            "/Applications/My App/bin/server".to_string(),
            "é".repeat(1024),
        ] {
            assert_server_accepted(get_stdio_server_with("command", json!(command)));
        }
    }

    #[test]
    fn rejects_empty_long_padded_tabbed_and_control_character_commands() {
        for command in [
            String::new(),
            "é".repeat(1025),
            " npx".to_string(),
            "npx ".to_string(),
            "npx\u{00a0}".to_string(),
            "n\tpx".to_string(),
            "n\npx".to_string(),
            "n\u{0000}px".to_string(),
        ] {
            assert_server_refused(get_stdio_server_with("command", json!(command)), "npx");
        }
    }

    #[test]
    fn accepts_up_to_64_arguments_of_one_to_1024_characters_with_tabs() {
        let many_arguments: Vec<String> = (0..64).map(|index| format!("--flag-{index}")).collect();

        for arguments in [
            json!([]),
            json!(many_arguments),
            json!(["a", " padded ", "with\ttab", "é".repeat(1024)]),
        ] {
            assert_server_accepted(get_stdio_server_with("arguments", arguments));
        }
    }

    #[test]
    fn rejects_too_many_empty_long_and_control_character_arguments() {
        let too_many_arguments: Vec<String> =
            (0..65).map(|index| format!("--flag-{index}")).collect();

        for arguments in [
            json!(too_many_arguments),
            json!([""]),
            json!(["é".repeat(1025)]),
            json!(["secret\nline"]),
            json!(["secret\u{0085}"]),
            json!("--flag"),
        ] {
            assert_server_refused(get_stdio_server_with("arguments", arguments), "secret");
        }
    }

    #[test]
    fn accepts_up_to_32_distinct_variables_with_empty_and_tabbed_values() {
        let many_variables: Vec<Value> = (0..32)
            .map(|index| json!({ "name": format!("VARIABLE_{index}"), "value": "1" }))
            .collect();

        for environment in [
            json!([]),
            json!(many_variables),
            json!([
                { "name": "_PRIVATE", "value": "" },
                { "name": "a1", "value": "with\ttab" },
                { "name": "x".repeat(128), "value": "é".repeat(4096) }
            ]),
        ] {
            assert_server_accepted(get_stdio_server_with("environment", environment));
        }
    }

    #[test]
    fn rejects_bad_variables_without_quoting_their_values() {
        let too_many_variables: Vec<Value> = (0..33)
            .map(|index| json!({ "name": format!("VARIABLE_{index}"), "value": "secret" }))
            .collect();

        for environment in [
            json!(too_many_variables),
            json!([{ "name": "1TOKEN", "value": "secret" }]),
            json!([{ "name": "MY-TOKEN", "value": "secret" }]),
            json!([{ "name": "", "value": "secret" }]),
            json!([{ "name": "x".repeat(129), "value": "secret" }]),
            json!([{ "name": "TOKEN", "value": "secret\n" }]),
            json!([{ "name": "TOKEN", "value": format!("secret{}", "é".repeat(4091)) }]),
            json!([{ "name": "TOKEN", "value": "secret" }, { "name": "TOKEN", "value": "other" }]),
            json!([{ "name": "TOKEN", "value": "secret", "exported": true }]),
            json!(["secret"]),
            json!({ "TOKEN": "secret" }),
        ] {
            assert_server_refused(get_stdio_server_with("environment", environment), "secret");
        }
    }

    #[test]
    fn accepts_https_urls_and_http_urls_to_loopback_hosts() {
        for url in [
            "https://mcp.example.com/mcp",
            "https://mcp.example.com:8443/mcp?region=eu",
            "HTTPS://MCP.EXAMPLE.COM/mcp",
            "http://localhost:3000/mcp",
            "http://LOCALHOST/mcp",
            "http://127.0.0.1:3000/mcp",
            "http://127.1/mcp",
            "http://[::1]:3000/mcp",
            "http://[0:0:0:0:0:0:0:1]/mcp",
        ] {
            assert_server_accepted(get_http_server_with("url", json!(url)));
        }
        let long_url = format!("https://mcp.example.com/{}", "a".repeat(2048 - 24));
        assert_server_accepted(get_http_server_with("url", json!(long_url)));
    }

    #[test]
    fn rejects_other_urls_without_quoting_them() {
        let too_long_url = format!("https://secret.example.com/{}", "a".repeat(2048 - 26));

        for url in [
            String::new(),
            too_long_url,
            "secret.example.com/mcp".to_string(),
            "/mcp?secret".to_string(),
            "http://secret.example.com/mcp".to_string(),
            "http://127.0.0.2/secret".to_string(),
            "http://localhost.secret/mcp".to_string(),
            "ftp://secret.example.com/mcp".to_string(),
            "ws://localhost/secret".to_string(),
            "https://user:secret@mcp.example.com/mcp".to_string(),
            "https://secret@mcp.example.com/mcp".to_string(),
            "https://mcp.example.com/mcp#secret".to_string(),
            "https://mcp.example.com/mcp#".to_string(),
            " https://secret.example.com/mcp".to_string(),
            "https://secret.example.com/m cp".to_string(),
            "https://secret.example.com/\u{0007}".to_string(),
            "https://secret.bücher.example/mcp".to_string(),
            "https://secret.xn--bcher-kva.example/mcp".to_string(),
        ] {
            assert_server_refused(get_http_server_with("url", json!(url)), "secret");
        }
    }

    #[test]
    fn accepts_up_to_32_token_named_headers_with_empty_and_tabbed_values() {
        let many_headers: Vec<Value> = (0..32)
            .map(|index| json!({ "name": format!("X-Header-{index}"), "value": "1" }))
            .collect();

        for headers in [
            json!([]),
            json!(many_headers),
            json!([
                { "name": "Authorization", "value": "Bearer synthetic-token" },
                { "name": "X-Empty", "value": "" },
                { "name": "X-Tabbed", "value": "a\tb c" },
                { "name": "!#$%&'*+.^_`|~-", "value": "~" },
                { "name": "x".repeat(128), "value": "v".repeat(8192) }
            ]),
        ] {
            assert_server_accepted(get_http_server_with("headers", headers));
        }
    }

    #[test]
    fn rejects_bad_headers_without_quoting_their_values() {
        let too_many_headers: Vec<Value> = (0..33)
            .map(|index| json!({ "name": format!("X-Header-{index}"), "value": "secret" }))
            .collect();

        for headers in [
            json!(too_many_headers),
            json!([{ "name": "", "value": "secret" }]),
            json!([{ "name": "X Token", "value": "secret" }]),
            json!([{ "name": "X:Token", "value": "secret" }]),
            json!([{ "name": "x".repeat(129), "value": "secret" }]),
            json!([{ "name": "Content-Type", "value": "secret" }]),
            json!([{ "name": "MCP-Session-Id", "value": "secret" }]),
            json!([{ "name": "accept", "value": "secret" }]),
            json!([{ "name": "Host", "value": "secret" }]),
            json!([{ "name": "Last-Event-ID", "value": "secret" }]),
            json!([{ "name": "Content-Length", "value": "secret" }]),
            json!([{ "name": "mcp-protocol-version", "value": "secret" }]),
            json!([{ "name": "Expect", "value": "secret" }]),
            json!([{ "name": "keep-alive", "value": "secret" }]),
            json!([{ "name": "Transfer-Encoding", "value": "secret" }]),
            json!([{ "name": "UPGRADE", "value": "secret" }]),
            json!([{ "name": "X-Token", "value": " secret" }]),
            json!([{ "name": "X-Token", "value": "secret\t" }]),
            json!([{ "name": "X-Token", "value": "secret\r\nX-Other: 1" }]),
            json!([{ "name": "X-Token", "value": "secrét" }]),
            json!([{ "name": "X-Token", "value": format!("secret{}", "v".repeat(8187)) }]),
            json!([{ "name": "X-Token", "value": "secret" }, { "name": "x-token", "value": "other" }]),
            json!([{ "name": "X-Token", "value": "secret", "sensitive": true }]),
            json!(["secret"]),
        ] {
            assert_server_refused(get_http_server_with("headers", headers), "secret");
        }
    }

    #[test]
    fn debug_output_never_shows_arguments_url_queries_or_variable_and_header_values() {
        let mut stdio_server = get_stdio_server_with(
            "environment",
            json!([{ "name": "API_TOKEN", "value": "env-secret-value" }]),
        );
        stdio_server["arguments"] = json!(["--token", "argument-secret"]);
        let settings = parse_mcp_settings(json!({ "servers": [
            stdio_server,
            get_http_server_with("url", json!("https://mcp.example.com/mcp?key=query-secret"))
        ] }))
        .expect("a valid group");

        let debug_output = format!("{settings:?}");

        for secret in [
            "env-secret-value",
            "synthetic-token",
            "argument-secret",
            "query-secret",
        ] {
            assert!(!debug_output.contains(secret), "{debug_output}");
        }
        for shown in [
            "API_TOKEN",
            "Authorization",
            "argument_count: 2",
            "https://mcp.example.com/mcp",
        ] {
            assert!(debug_output.contains(shown), "{debug_output}");
        }
    }

    #[test]
    fn judges_and_writes_every_shared_group_as_the_share_package_rules_do() {
        let cases: Vec<SharedCase> = serde_json::from_str(SHARED_CASES).expect("the shared groups");

        let mismatches: Vec<String> = cases
            .into_iter()
            .filter_map(find_shared_case_mismatch)
            .collect();

        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }
}
