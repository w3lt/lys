//! `search_emails`: messages matching criteria, newest first, by pages.

use schemars::JsonSchema;
use serde::Deserialize;

use super::{
    MAXIMUM_TEXT_ARGUMENT_LENGTH, ToolContext, ToolReport, ToolResult, check_text_argument,
    imap_failure, load_folders, require_folder,
};
use crate::email_id::EmailId;
use crate::failure::ToolFailure;
use crate::folders::{Folder, FolderRole};
use crate::imap::{Flags, ImapSession, format_search_date, format_search_text};
use crate::message::{Headers, parse_headers};

/// Messages per page.
pub const PAGE_SIZE: usize = 20;

/// Most hits taken from one folder: the newest ones.
pub const FOLDER_HIT_LIMIT: usize = 200;

/// The arguments of `search_emails`.
#[derive(Clone, Debug, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchArguments {
    /// The folder to search, as list_folders names it. Omitted: every folder that can hold messages, except an All Mail view.
    #[serde(default)]
    pub folder: Option<String>,
    /// Text the message's headers or body must contain.
    #[serde(default)]
    pub text: Option<String>,
    /// Text the From field must contain, such as an address or a name.
    #[serde(default)]
    pub from: Option<String>,
    /// Text the To field must contain.
    #[serde(default)]
    pub to: Option<String>,
    /// Text the Subject field must contain.
    #[serde(default)]
    pub subject: Option<String>,
    /// Only messages received on or after this day, as YYYY-MM-DD.
    #[serde(default)]
    pub since: Option<String>,
    /// Only messages received before this day, as YYYY-MM-DD.
    #[serde(default)]
    pub before: Option<String>,
    /// true: only unread messages; false: only read ones.
    #[serde(default)]
    pub unread: Option<bool>,
    /// true: only flagged messages; false: only unflagged ones.
    #[serde(default)]
    pub flagged: Option<bool>,
    /// The page to show, from 1; each page holds 20 messages.
    #[serde(default)]
    pub page: Option<u32>,
}

/// One message a search found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    /// The message's id.
    pub id: EmailId,
    /// Its flags.
    pub flags: Flags,
    /// The header fields the summary carries.
    pub headers: Headers,
    /// When it was sent, or received when the Date field is unreadable,
    /// as seconds since the Unix epoch; 0 when neither is known.
    pub timestamp: i64,
    /// The same as text, or `unknown`.
    pub date: String,
}

/// Searches one or every folder.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - What to search for.
pub async fn search_emails(context: &ToolContext, arguments: SearchArguments) -> ToolResult {
    let criteria = build_search_criteria(&arguments)?;
    let page = match arguments.page {
        None => 1,
        Some(0) => return Err(ToolFailure::Argument("page must be 1 or more.".to_owned())),
        Some(page) => page as usize,
    };
    if let Some(folder) = &arguments.folder {
        check_text_argument("folder", folder, super::MAXIMUM_FOLDER_NAME_LENGTH)?;
    }
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let targets: Vec<Folder> = match &arguments.folder {
        Some(name) => {
            let folder = require_folder(&folders, name)?;
            if !folder.selectable {
                return Err(ToolFailure::Argument(format!(
                    "{name} cannot hold messages. Use list_folders to see the folders."
                )));
            }
            vec![folder.clone()]
        }
        None => folders
            .iter()
            .filter(|folder| folder.selectable && folder.role != Some(FolderRole::All))
            .cloned()
            .collect(),
    };
    let mut hits = Vec::new();
    let mut cut_folders = Vec::new();
    for folder in &targets {
        let (found, cut) = collect_hits(&mut session, folder, &criteria, FOLDER_HIT_LIMIT).await?;
        hits.extend(found);
        if cut {
            cut_folders.push(folder.name.clone());
        }
    }
    session.close().await;
    sort_newest_first(&mut hits);
    let total = hits.len();
    let pages = total.div_ceil(PAGE_SIZE).max(1);
    if total == 0 {
        return Ok(ToolReport {
            text: "No message matches.".to_owned(),
            log: format!("search: {} folder(s), 0 hits", targets.len()),
        });
    }
    if page > pages {
        return Err(ToolFailure::Argument(if pages == 1 {
            "Only 1 page matches. Ask for page 1.".to_owned()
        } else {
            format!("Only {pages} pages match. Ask for a page from 1 to {pages}.")
        }));
    }
    let mut text = format!(
        "Page {page} of {pages}: {total} {} match, newest first.",
        if total == 1 { "message" } else { "messages" }
    );
    if page < pages {
        text.push_str(&format!(" Ask for page {} to see the next ones.", page + 1));
    }
    if !cut_folders.is_empty() {
        text.push_str(&format!(
            "\nMore than {FOLDER_HIT_LIMIT} messages match in {}; only the newest {FOLDER_HIT_LIMIT} of each are listed. Narrow the search to see others.",
            cut_folders.join(", ")
        ));
    }
    for hit in hits.iter().skip((page - 1) * PAGE_SIZE).take(PAGE_SIZE) {
        text.push_str("\n\n");
        text.push_str(&format_hit(hit));
    }
    Ok(ToolReport {
        text,
        log: format!(
            "search: {} folder(s), {total} hit(s), page {page} of {pages}",
            targets.len()
        ),
    })
}

/// Searches a folder and fetches the summaries of the newest hits.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folder` - The folder, which must be selectable.
/// * `criteria` - The search keys.
/// * `limit` - Most hits to keep: the newest by UID.
///
/// # Returns
///
/// The hits, and whether more than `limit` matched.
pub async fn collect_hits(
    session: &mut ImapSession,
    folder: &Folder,
    criteria: &str,
    limit: usize,
) -> Result<(Vec<Hit>, bool), ToolFailure> {
    let selected = session
        .select_folder(&folder.raw_name, true)
        .await
        .map_err(imap_failure("select the folder"))?;
    let uids = session
        .search_uids(criteria)
        .await
        .map_err(imap_failure("search"))?;
    let cut = uids.len() > limit;
    let newest: Vec<u32> = uids.into_iter().take(limit).collect();
    let summaries = session
        .fetch_summaries(&newest)
        .await
        .map_err(imap_failure("fetch the message summaries"))?;
    let hits = summaries
        .into_iter()
        .map(|summary| {
            let headers = parse_headers(&summary.header);
            let timestamp = headers
                .timestamp
                .or(summary.internal_timestamp)
                .unwrap_or_default();
            let date = headers
                .date
                .clone()
                .or(summary.internal_date)
                .unwrap_or_else(|| "unknown".to_owned());
            Hit {
                id: EmailId {
                    uid: summary.uid,
                    uid_validity: selected.uid_validity,
                    folder: folder.name.clone(),
                },
                flags: summary.flags,
                headers,
                timestamp,
                date,
            }
        })
        .collect();
    Ok((hits, cut))
}

/// Sorts hits newest first, by time then by UID.
///
/// # Arguments
///
/// * `hits` - The hits to sort.
pub fn sort_newest_first(hits: &mut [Hit]) {
    hits.sort_by(|left, right| {
        right
            .timestamp
            .cmp(&left.timestamp)
            .then(right.id.uid.cmp(&left.id.uid))
    });
}

/// Formats one hit as the model reads it.
fn format_hit(hit: &Hit) -> String {
    format!(
        "id {}\ndate {}\nfrom {}\nsubject {}\nflags {}\nfolder {}",
        hit.id,
        hit.date,
        hit.headers.from,
        hit.headers.subject,
        hit.flags.format(),
        hit.id.folder
    )
}

/// Builds the search keys of the arguments.
///
/// # Arguments
///
/// * `arguments` - The arguments.
///
/// # Returns
///
/// The keys, with `CHARSET UTF-8` in front when a text is not ASCII, or
/// why an argument breaks a rule.
pub fn build_search_criteria(arguments: &SearchArguments) -> Result<String, ToolFailure> {
    let mut keys = Vec::new();
    let mut non_ascii = false;
    for (name, key, value) in [
        ("text", "TEXT", &arguments.text),
        ("from", "FROM", &arguments.from),
        ("to", "TO", &arguments.to),
        ("subject", "SUBJECT", &arguments.subject),
    ] {
        if let Some(value) = value {
            check_text_argument(name, value, MAXIMUM_TEXT_ARGUMENT_LENGTH)?;
            if value.is_empty() {
                return Err(ToolFailure::Argument(format!("{name} must not be empty.")));
            }
            non_ascii |= !value.is_ascii();
            keys.push(format!("{key} {}", format_search_text(value)));
        }
    }
    for (name, key, value) in [
        ("since", "SINCE", &arguments.since),
        ("before", "BEFORE", &arguments.before),
    ] {
        if let Some(value) = value {
            let (year, month, day) = parse_day(value).ok_or_else(|| {
                ToolFailure::Argument(format!("{name} must be a day as YYYY-MM-DD."))
            })?;
            keys.push(format!("{key} {}", format_search_date(year, month, day)));
        }
    }
    match arguments.unread {
        Some(true) => keys.push("UNSEEN".to_owned()),
        Some(false) => keys.push("SEEN".to_owned()),
        None => {}
    }
    match arguments.flagged {
        Some(true) => keys.push("FLAGGED".to_owned()),
        Some(false) => keys.push("UNFLAGGED".to_owned()),
        None => {}
    }
    if keys.is_empty() {
        keys.push("ALL".to_owned());
    }
    let criteria = keys.join(" ");
    Ok(if non_ascii {
        format!("CHARSET UTF-8 {criteria}")
    } else {
        criteria
    })
}

/// Parses a day written as `YYYY-MM-DD`.
///
/// # Arguments
///
/// * `text` - The text.
///
/// # Returns
///
/// The year, month, and day, or `None` when the text is not a calendar
/// day.
pub fn parse_day(text: &str) -> Option<(u16, u8, u8)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u16> {
        let part = &text[range];
        part.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let year = number(0..4)?;
    let month = u8::try_from(number(5..7)?).ok()?;
    let day = u8::try_from(number(8..10)?).ok()?;
    if year < 1000 || !(1..=12).contains(&month) || day == 0 || day > days_of_month(year, month) {
        return None;
    }
    Some((year, month, day))
}

/// Counts the days of a month.
fn days_of_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) {
                29
            } else {
                28
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_search_keys_of_every_argument() {
        let arguments = SearchArguments {
            text: Some("invoice".to_owned()),
            from: Some("jane@example.com".to_owned()),
            to: Some("me".to_owned()),
            subject: Some("Grüße".to_owned()),
            since: Some("2026-01-05".to_owned()),
            before: Some("2028-02-29".to_owned()),
            unread: Some(true),
            flagged: Some(false),
            ..SearchArguments::default()
        };

        assert_eq!(
            build_search_criteria(&arguments).expect("criteria"),
            "CHARSET UTF-8 TEXT \"invoice\" FROM \"jane@example.com\" TO \"me\" SUBJECT {7+}\r\nGrüße SINCE 5-Jan-2026 BEFORE 29-Feb-2028 UNSEEN UNFLAGGED"
        );
        assert_eq!(
            build_search_criteria(&SearchArguments::default()).expect("criteria"),
            "ALL"
        );
        assert_eq!(
            build_search_criteria(&SearchArguments {
                unread: Some(false),
                flagged: Some(true),
                ..SearchArguments::default()
            })
            .expect("criteria"),
            "SEEN FLAGGED"
        );
    }

    #[test]
    fn refuses_arguments_that_break_a_rule() {
        let cases = [
            (
                SearchArguments {
                    text: Some(String::new()),
                    ..SearchArguments::default()
                },
                "text must not be empty.",
            ),
            (
                SearchArguments {
                    subject: Some("a\r\nb".to_owned()),
                    ..SearchArguments::default()
                },
                "subject must not contain line breaks or control characters.",
            ),
            (
                SearchArguments {
                    since: Some("2026-13-01".to_owned()),
                    ..SearchArguments::default()
                },
                "since must be a day as YYYY-MM-DD.",
            ),
            (
                SearchArguments {
                    before: Some("yesterday".to_owned()),
                    ..SearchArguments::default()
                },
                "before must be a day as YYYY-MM-DD.",
            ),
        ];

        for (arguments, expected) in cases {
            assert_eq!(
                build_search_criteria(&arguments),
                Err(ToolFailure::Argument(expected.to_owned()))
            );
        }
    }

    #[test]
    fn parses_calendar_days_only() {
        assert_eq!(parse_day("2026-11-02"), Some((2026, 11, 2)));
        assert_eq!(parse_day("2024-02-29"), Some((2024, 2, 29)));
        assert_eq!(parse_day("2000-02-29"), Some((2000, 2, 29)));
        assert_eq!(parse_day("2023-02-29"), None);
        assert_eq!(parse_day("1900-02-29"), None);
        assert_eq!(parse_day("2026-04-31"), None);
        assert_eq!(parse_day("2026-00-10"), None);
        assert_eq!(parse_day("0999-01-01"), None);
        assert_eq!(parse_day("2026-1-1"), None);
        assert_eq!(parse_day("2026-11-02T00:00"), None);
        assert_eq!(parse_day("２０２６-11-02"), None);
    }

    #[test]
    fn sorts_hits_newest_first_and_formats_them() {
        let build = |uid: u32, timestamp: i64| Hit {
            id: EmailId {
                uid,
                uid_validity: 7,
                folder: "INBOX".to_owned(),
            },
            flags: Flags::default(),
            headers: Headers {
                from: "Jane <jane@example.com>".to_owned(),
                subject: "Hello".to_owned(),
                ..Headers::default()
            },
            timestamp,
            date: "2026-11-02T10:30:00Z".to_owned(),
        };
        let mut hits = vec![build(1, 10), build(2, 30), build(3, 30), build(4, 20)];

        sort_newest_first(&mut hits);

        let uids: Vec<u32> = hits.iter().map(|hit| hit.id.uid).collect();
        assert_eq!(uids, vec![3, 2, 4, 1]);
        assert_eq!(
            format_hit(&hits[0]),
            "id 3.7.INBOX\ndate 2026-11-02T10:30:00Z\nfrom Jane <jane@example.com>\nsubject Hello\nflags unread\nfolder INBOX"
        );
    }
}
