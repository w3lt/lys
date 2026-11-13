//! The email MCP server Lys ships: ten tools for each mailbox it serves,
//! the person's own and Lys's own, over IMAP and SMTP.
//!
//! The backend starts the `email` binary over stdio with each saved account
//! and its password in an environment variable of its own,
//! `LYS_EMAIL_ACCOUNT` for the person's mailbox and `LYS_EMAIL_LYS_ACCOUNT`
//! for Lys's, and runs `email check` to sign in to both servers of either
//! account, given in `LYS_EMAIL_ACCOUNT`, before it is saved. One process
//! serves either mailbox or both: Lys's tools are named with `lys_` before
//! them and its ids with `lys.`, so that no call reaches the other mailbox,
//! and each mailbox sends only from its own address. Every tool call opens
//! at most one IMAP and one SMTP connection of its own and closes them
//! before answering. A reply, a forward, and a draft being sent keep their
//! IMAP connection open while they send; any other send that files a Sent
//! copy opens IMAP only after the send. Nothing stays open between calls,
//! so stopping the process closes every connection.
//!
//! The modules follow the data path: [`account`] reads the environment,
//! [`mailbox`] names the mailboxes, [`trust`] decides which server
//! certificates are accepted, [`imap`] and [`smtp`] speak the protocols,
//! [`message`] reads fetched mail and [`compose`] writes outgoing mail,
//! [`folders`], [`folder_name`], and [`email_id`] name what the tools work
//! on, [`failure`] names what goes wrong, [`tools`] do the work,
//! [`descriptions`] names and describes each mailbox's tools, [`server`]
//! offers them over MCP, [`check`] signs in for the desktop's account
//! cards, and [`log`] writes the lines the backend keeps. Standard error
//! carries the operation, the mailbox, the counts, and the class of a
//! failure, never the password, an address, a subject, or a body.

pub mod account;
pub mod check;
pub mod compose;
pub mod descriptions;
pub mod email_id;
pub mod failure;
pub mod folder_name;
pub mod folders;
pub mod imap;
pub mod log;
pub mod mailbox;
pub mod message;
mod network;
pub mod server;
pub mod smtp;
pub mod tools;
pub mod trust;
