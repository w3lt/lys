//! The email MCP server Lys ships: ten tools over one IMAP and SMTP account.
//!
//! The backend starts the `email` binary over stdio with the saved account
//! and its password in the `LYS_EMAIL_ACCOUNT` environment variable, and
//! runs `email check` to sign in to both servers before an account is saved.
//! Every tool call opens at most one IMAP and one SMTP connection of its
//! own and closes them before answering. A reply, a forward, and a draft
//! being sent keep their IMAP connection open while they send; any other
//! send that files a Sent copy opens IMAP only after the send. Nothing
//! stays open between calls, so stopping the process closes every
//! connection.
//!
//! The modules follow the data path: [`account`] reads the environment,
//! [`trust`] decides which server certificates are accepted, [`imap`] and
//! [`smtp`] speak the protocols, [`message`] reads fetched mail and
//! [`compose`] writes outgoing mail, [`folders`], [`folder_name`], and
//! [`email_id`] name what the tools work on, [`failure`] names what goes
//! wrong, [`tools`] do the work, [`server`] offers them over MCP,
//! [`check`] signs in for the desktop's account card, and [`log`] writes
//! the lines the backend keeps. Standard error carries the operation, the
//! counts, and the class of a failure, never the password, an address, a
//! subject, or a body.

pub mod account;
pub mod check;
pub mod compose;
pub mod email_id;
pub mod failure;
pub mod folder_name;
pub mod folders;
pub mod imap;
pub mod log;
pub mod message;
mod network;
pub mod server;
pub mod smtp;
pub mod tools;
pub mod trust;
