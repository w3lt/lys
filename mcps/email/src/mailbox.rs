//! Which mailbox a tool works on: the person's own, or Lys's own.
//!
//! One process serves either mailbox or both. Each mailbox has its own
//! account variable, its own tool names, and its own form of message id, so
//! that a call never reaches the other mailbox by mistake. Logs name the
//! mailbox, never its address.

/// One of the mailboxes the server can serve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mailbox {
    /// The person's own mailbox, served under the tool names without a
    /// prefix, with ids such as `12.345.INBOX`.
    Person,
    /// Lys's own mailbox, served under the tool names with the `lys_`
    /// prefix, with ids such as `lys.12.345.INBOX`.
    Lys,
}

impl Mailbox {
    /// The environment variable that holds the mailbox's account and
    /// password as JSON: `LYS_EMAIL_ACCOUNT` for the person's and
    /// `LYS_EMAIL_LYS_ACCOUNT` for Lys's.
    pub fn variable_name(self) -> &'static str {
        match self {
            Self::Person => "LYS_EMAIL_ACCOUNT",
            Self::Lys => "LYS_EMAIL_LYS_ACCOUNT",
        }
    }

    /// The text the mailbox's tool names begin with: none for the person's,
    /// `lys_` for Lys's.
    pub fn tool_prefix(self) -> &'static str {
        match self {
            Self::Person => "",
            Self::Lys => "lys_",
        }
    }

    /// The text the mailbox's message ids begin with: none for the
    /// person's, `lys.` for Lys's. A person's id begins with a digit, so
    /// the two never overlap.
    pub fn id_prefix(self) -> &'static str {
        match self {
            Self::Person => "",
            Self::Lys => "lys.",
        }
    }

    /// The name the logs give the mailbox: `person` or `lys`.
    pub fn log_name(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Lys => "lys",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checks that each mailbox has its own variable, tool prefix, id
    /// prefix, and log name, the person's keeping those from before Lys
    /// had a mailbox.
    #[test]
    fn names_each_mailbox_s_variable_tools_ids_and_log() {
        let names = |mailbox: Mailbox| {
            (
                mailbox.variable_name(),
                mailbox.tool_prefix(),
                mailbox.id_prefix(),
                mailbox.log_name(),
            )
        };

        assert_eq!(
            names(Mailbox::Person),
            ("LYS_EMAIL_ACCOUNT", "", "", "person")
        );
        assert_eq!(
            names(Mailbox::Lys),
            ("LYS_EMAIL_LYS_ACCOUNT", "lys_", "lys.", "lys")
        );
    }
}
