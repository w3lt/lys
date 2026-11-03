//! The email server's integration tests, against the fake IMAP and SMTP
//! servers and the built binary, as one test program: the fakes and
//! builders they share compile once, and the compiler names any of them
//! that no test uses.

mod support;

mod check;
mod imap_commands;
mod imap_steps;
mod smtp_steps;
mod stdio;
mod tools_drafts;
mod tools_folders;
mod tools_search_read;
mod tools_send;
