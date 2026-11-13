//! What the model reads about each mailbox's tools: their names and
//! descriptions, and the server's instructions.
//!
//! Both mailboxes offer the same ten tools, each from one definition. This
//! module names a mailbox's copy of a tool, with `lys_` before Lys's, and
//! begins each description with the mailbox the tool works on. The two send
//! tools' descriptions end with the mailbox's address, the only one they
//! send from, so that the model can give it as `from`. The address reaches
//! the model; the log never holds it.

use rmcp::model::Tool;

use crate::mailbox::Mailbox;

/// The tools that send mail, whose descriptions name the address they send
/// from.
const SENDING_TOOL_NAMES: [&str; 2] = ["send_email", "send_draft"];

/// Builds one mailbox's copy of a tool: its name with the mailbox's tool
/// prefix, and its description after the sentence of the mailbox it works
/// on, with the address it sends from for a send tool.
///
/// # Arguments
///
/// * `tool` - The tool as its definition describes it.
/// * `mailbox` - The mailbox the copy works on.
/// * `address` - The mailbox's address.
///
/// # Returns
///
/// The copy; everything else about the tool, such as its schema and its
/// annotations, is kept.
pub fn build_mailbox_tool(tool: Tool, mailbox: Mailbox, address: &str) -> Tool {
    let sender = if SENDING_TOOL_NAMES.contains(&tool.name.as_ref()) {
        format!(" This mailbox's address is {address}.")
    } else {
        String::new()
    };
    let description = format!(
        "{} {}{sender}",
        describe_tool_mailbox(mailbox),
        tool.description.as_deref().unwrap_or_default()
    );
    let mut copy = tool;
    copy.name = format!("{}{}", mailbox.tool_prefix(), copy.name).into();
    copy.description = Some(description.into());
    copy
}

/// Builds the instructions the server gives the model about itself: which
/// tools work on which of the mailboxes served, and how ids behave.
///
/// # Arguments
///
/// * `mailboxes` - The mailboxes served, in the order their tools are
///   listed.
pub fn build_instructions(mailboxes: &[Mailbox]) -> String {
    let served: Vec<&str> = mailboxes
        .iter()
        .map(|mailbox| describe_served_mailbox(*mailbox))
        .collect();
    format!(
        "Reads, searches, sends, and files email over IMAP and SMTP. {} Message ids come from search_emails and read_email; an id is valid until its folder changes, then search again. Reading never marks a message as read. Sending and deleting are permanent.",
        served.join(" ")
    )
}

/// The sentence each description of a mailbox's tool begins with.
///
/// # Arguments
///
/// * `mailbox` - The mailbox the tool works on.
fn describe_tool_mailbox(mailbox: Mailbox) -> &'static str {
    match mailbox {
        Mailbox::Person => "Works on the person's own mailbox.",
        Mailbox::Lys => {
            "Works on Lys's own mailbox, not the person's: its ids begin with lys., and each tool this text or an answer names stands for its lys_ twin, such as lys_read_email for read_email."
        }
    }
}

/// The sentence of the instructions that names a served mailbox's tools
/// and ids.
///
/// # Arguments
///
/// * `mailbox` - The mailbox served.
fn describe_served_mailbox(mailbox: Mailbox) -> &'static str {
    match mailbox {
        Mailbox::Person => {
            "The tools without a prefix work on the person's own mailbox, with ids such as 12.345.INBOX."
        }
        Mailbox::Lys => {
            "The tools whose names begin with lys_ work on Lys's own mailbox, with ids such as lys.12.345.INBOX; for that mailbox, read each tool these instructions name as its lys_ twin."
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rmcp::model::{JsonObject, ToolAnnotations};

    use super::*;

    /// A tool as its definition describes it, with an annotation that the
    /// copies must keep.
    fn build_tool(name: &'static str) -> Tool {
        Tool::new(name, "Does the thing.", Arc::new(JsonObject::new()))
            .annotate(ToolAnnotations::new().read_only(true))
    }

    /// Checks that a mailbox's copy of a tool that does not send keeps its
    /// name for the person and gains `lys_` for Lys, begins its
    /// description with the mailbox, names no address, and keeps its
    /// annotations.
    #[test]
    fn names_and_describes_each_mailbox_s_copy_of_a_tool() {
        let person = build_mailbox_tool(
            build_tool("read_email"),
            Mailbox::Person,
            "person@example.com",
        );
        let lys = build_mailbox_tool(build_tool("read_email"), Mailbox::Lys, "lys@example.net");

        assert_eq!(person.name, "read_email");
        assert_eq!(
            person.description.as_deref(),
            Some("Works on the person's own mailbox. Does the thing.")
        );
        assert_eq!(lys.name, "lys_read_email");
        assert_eq!(
            lys.description.as_deref(),
            Some(
                "Works on Lys's own mailbox, not the person's: its ids begin with lys., and each tool this text or an answer names stands for its lys_ twin, such as lys_read_email for read_email. Does the thing."
            )
        );
        assert_eq!(lys.annotations, build_tool("read_email").annotations);
    }

    /// Checks that each send tool's copy ends its description with the
    /// mailbox's address.
    #[test]
    fn names_the_address_each_send_tool_sends_from() {
        for name in SENDING_TOOL_NAMES {
            let copy = build_mailbox_tool(build_tool(name), Mailbox::Lys, "lys@example.net");

            assert!(
                copy.description.as_deref().is_some_and(|text| text
                    .ends_with("Does the thing. This mailbox's address is lys@example.net.")),
                "{copy:?}"
            );
        }
    }

    /// Checks that the instructions name the tools and the ids of each
    /// mailbox served, and only those.
    #[test]
    fn names_the_tools_and_ids_of_each_mailbox_served() {
        let person = build_instructions(&[Mailbox::Person]);
        let lys = build_instructions(&[Mailbox::Lys]);
        let both = build_instructions(&[Mailbox::Person, Mailbox::Lys]);

        assert!(person.contains("person's own mailbox, with ids such as 12.345.INBOX."));
        assert!(!person.contains("lys_"));
        assert!(lys.contains("lys_ work on Lys's own mailbox"));
        assert!(!lys.contains("person's"));
        assert!(both.contains(&format!(
            "{} {}",
            describe_served_mailbox(Mailbox::Person),
            describe_served_mailbox(Mailbox::Lys)
        )));
        assert!(both.ends_with("Sending and deleting are permanent."));
    }
}
