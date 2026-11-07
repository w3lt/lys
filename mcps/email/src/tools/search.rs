//! `search_emails`: messages matching criteria, newest first, by pages.

use std::cmp::Ordering;

use schemars::JsonSchema;
use serde::Deserialize;

use super::{
    MAXIMUM_TEXT_ARGUMENT_LENGTH, ToolContext, ToolReport, ToolResult,
    build_imap_failure_conversion, get_folder, load_folders, parse_text_argument,
};
use crate::email_id::EmailId;
use crate::failure::ToolFailure;
use crate::folders::{Folder, FolderRole};
use crate::imap::{Flags, FolderAccess, ImapSession, SearchWord, Summary, build_search_date};
use crate::message::{Headers, parse_headers};

/// Messages per page.
const PAGE_SIZE: usize = 20;

/// Most hits taken from one folder: the newest ones.
const FOLDER_HIT_LIMIT: usize = 200;

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
pub async fn run_search_emails(context: &ToolContext, arguments: SearchArguments) -> ToolResult {
    let criteria = build_search_criteria(&arguments)?;
    let page = parse_page(arguments.page)?;
    if let Some(folder) = &arguments.folder {
        parse_text_argument("folder", folder, super::MAXIMUM_FOLDER_NAME_LENGTH)?;
    }
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let targets = list_search_folders(&folders, arguments.folder.as_deref())?;
    let mut found = find_search_hits(&mut session, &targets, &criteria).await?;
    session.close().await;
    found.hits.sort_by(calculate_hit_order);
    build_search_report(&found, page, targets.len())
}

/// The hits a search found in its folders, and the folders where more
/// messages matched than were read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct SearchHits {
    /// The hits of every folder.
    hits: Vec<Hit>,
    /// The folders where more than [`FOLDER_HIT_LIMIT`] messages matched,
    /// so that only the newest of them were read.
    cut_folders: Vec<String>,
}

/// Parses the page argument.
///
/// # Arguments
///
/// * `page` - The page asked for, from 1, or `None` for the first.
///
/// # Returns
///
/// The page, or the rule a page of 0 breaks as the model reads it.
fn parse_page(page: Option<u32>) -> Result<usize, ToolFailure> {
    match page {
        None => Ok(1),
        Some(0) => Err(ToolFailure::Argument("page must be 1 or more.".to_owned())),
        Some(page) => Ok(page as usize),
    }
}

/// Lists the folders a search reads: the one named, or every folder that
/// can hold messages but an All Mail view, whose messages the other
/// folders already hold.
///
/// # Arguments
///
/// * `folders` - The classified folders.
/// * `name` - The folder asked for, if any.
///
/// # Returns
///
/// The folders, or why the one named cannot be searched.
fn list_search_folders(folders: &[Folder], name: Option<&str>) -> Result<Vec<Folder>, ToolFailure> {
    let Some(name) = name else {
        return Ok(folders
            .iter()
            .filter(|folder| {
                folder.selectable && folder.role.is_none_or(FolderRole::has_own_messages)
            })
            .cloned()
            .collect());
    };
    let folder = get_folder(folders, name)?;
    if !folder.selectable {
        return Err(ToolFailure::Argument(format!(
            "{name} cannot hold messages. Use list_folders to see the folders."
        )));
    }
    Ok(vec![folder.clone()])
}

/// Searches each folder, keeping its newest [`FOLDER_HIT_LIMIT`] hits.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `targets` - The folders to search.
/// * `criteria` - The search keys.
async fn find_search_hits(
    session: &mut ImapSession,
    targets: &[Folder],
    criteria: &[SearchWord],
) -> Result<SearchHits, ToolFailure> {
    let mut found = SearchHits::default();
    for folder in targets {
        let query = HitQuery {
            criteria,
            limit: FOLDER_HIT_LIMIT,
        };
        let (hits, cut) = list_folder_hits(session, folder, query).await?;
        found.hits.extend(hits);
        if cut {
            found.cut_folders.push(folder.name.clone());
        }
    }
    Ok(found)
}

/// Builds the report of one page of a search.
///
/// # Arguments
///
/// * `found` - The hits, newest first, and the folders that were cut.
/// * `page` - The page asked for, from 1.
/// * `folder_count` - How many folders were searched, for the log.
///
/// # Returns
///
/// The page, or the pages there are when the one asked for is past them.
fn build_search_report(found: &SearchHits, page: usize, folder_count: usize) -> ToolResult {
    let total = found.hits.len();
    if total == 0 {
        return Ok(ToolReport {
            text: "No message matches.".to_owned(),
            log: format!("search: {folder_count} folder(s), 0 hits"),
        });
    }
    let pages = total.div_ceil(PAGE_SIZE);
    if page > pages {
        return Err(build_page_failure(pages));
    }
    let mut text = format_search_heading(found, page, pages);
    for hit in found
        .hits
        .iter()
        .skip((page - 1) * PAGE_SIZE)
        .take(PAGE_SIZE)
    {
        text.push_str("\n\n");
        text.push_str(&format_hit(hit));
    }
    Ok(ToolReport {
        text,
        log: format!("search: {folder_count} folder(s), {total} hit(s), page {page} of {pages}"),
    })
}

/// Builds the refusal of a page past the last one.
///
/// # Arguments
///
/// * `pages` - How many pages there are, at least 1.
fn build_page_failure(pages: usize) -> ToolFailure {
    ToolFailure::Argument(if pages == 1 {
        "Only 1 page matches. Ask for page 1.".to_owned()
    } else {
        format!("Only {pages} pages match. Ask for a page from 1 to {pages}.")
    })
}

/// Formats the heading of a search page: which page of how many, how many
/// messages match, and the folders that matched more than were read.
///
/// # Arguments
///
/// * `found` - The hits and the folders that were cut.
/// * `page` - The page shown.
/// * `pages` - How many pages there are.
fn format_search_heading(found: &SearchHits, page: usize, pages: usize) -> String {
    let total = found.hits.len();
    let mut text = format!(
        "Page {page} of {pages}: {total} {} match, newest first.",
        if total == 1 { "message" } else { "messages" }
    );
    if page < pages {
        text.push_str(&format!(" Ask for page {} to see the next ones.", page + 1));
    }
    if !found.cut_folders.is_empty() {
        text.push_str(&format!(
            "\nMore than {FOLDER_HIT_LIMIT} messages match in {}; only the newest {FOLDER_HIT_LIMIT} of each are listed. Narrow the search to see others.",
            found.cut_folders.join(", ")
        ));
    }
    text
}

/// What a folder is searched for: the search keys, and how many of the
/// newest hits to keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HitQuery<'a> {
    /// The search keys.
    pub criteria: &'a [SearchWord],
    /// Most hits to keep: the newest by UID.
    pub limit: usize,
}

/// Searches a folder and fetches the summaries of the newest hits.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folder` - The folder, which must be selectable.
/// * `query` - The search keys and how many hits to keep.
///
/// # Returns
///
/// The hits, and whether more than the query's limit matched.
pub async fn list_folder_hits(
    session: &mut ImapSession,
    folder: &Folder,
    query: HitQuery<'_>,
) -> Result<(Vec<Hit>, bool), ToolFailure> {
    let HitQuery { criteria, limit } = query;
    let selected = session
        .open_folder(&folder.raw_name, FolderAccess::Read)
        .await
        .map_err(build_imap_failure_conversion("select the folder"))?;
    let uids = session
        .list_matching_uids(criteria)
        .await
        .map_err(build_imap_failure_conversion("search"))?;
    let cut = uids.len() > limit;
    let newest: Vec<u32> = uids.into_iter().take(limit).collect();
    let summaries = session
        .list_summaries(&newest)
        .await
        .map_err(build_imap_failure_conversion("fetch the message summaries"))?;
    let hits = summaries
        .into_iter()
        .map(|summary| build_hit(summary, folder, selected.uid_validity))
        .collect();
    Ok((hits, cut))
}

/// Builds the hit of a fetched summary.
///
/// # Arguments
///
/// * `summary` - The summary the server answered.
/// * `folder` - The folder it was found in.
/// * `uid_validity` - The folder's UIDVALIDITY when it was selected.
fn build_hit(summary: Summary, folder: &Folder, uid_validity: u32) -> Hit {
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
            uid_validity,
            folder: folder.name.clone(),
        },
        flags: summary.flags,
        headers,
        timestamp,
        date,
    }
}

/// Calculates the order of two hits, newest first: by time, then by UID.
///
/// # Arguments
///
/// * `left` - One hit.
/// * `right` - The other hit.
pub fn calculate_hit_order(left: &Hit, right: &Hit) -> Ordering {
    right
        .timestamp
        .cmp(&left.timestamp)
        .then(right.id.uid.cmp(&left.id.uid))
}

/// Formats one hit as the model reads it.
fn format_hit(hit: &Hit) -> String {
    format!(
        "id {}\ndate {}\nfrom {}\nsubject {}\nflags {}\nfolder {}",
        hit.id,
        hit.date,
        hit.headers.from,
        hit.headers.subject,
        hit.flags.format_flag_list(),
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
/// The keys, or why an argument breaks a rule.
fn build_search_criteria(arguments: &SearchArguments) -> Result<Vec<SearchWord>, ToolFailure> {
    let mut keys = Vec::new();
    for (name, key, value) in [
        ("text", "TEXT", &arguments.text),
        ("from", "FROM", &arguments.from),
        ("to", "TO", &arguments.to),
        ("subject", "SUBJECT", &arguments.subject),
    ] {
        if let Some(value) = value {
            parse_text_argument(name, value, MAXIMUM_TEXT_ARGUMENT_LENGTH)?;
            if value.is_empty() {
                return Err(ToolFailure::Argument(format!("{name} must not be empty.")));
            }
            keys.push(SearchWord::Plain(key.to_owned()));
            keys.push(SearchWord::Text(value.clone()));
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
            keys.push(SearchWord::Plain(key.to_owned()));
            keys.push(SearchWord::Plain(build_search_date(year, month, day)));
        }
    }
    match arguments.unread {
        Some(true) => keys.push(SearchWord::Plain("UNSEEN".to_owned())),
        Some(false) => keys.push(SearchWord::Plain("SEEN".to_owned())),
        None => {}
    }
    match arguments.flagged {
        Some(true) => keys.push(SearchWord::Plain("FLAGGED".to_owned())),
        Some(false) => keys.push(SearchWord::Plain("UNFLAGGED".to_owned())),
        None => {}
    }
    if keys.is_empty() {
        keys.push(SearchWord::Plain("ALL".to_owned()));
    }
    Ok(keys)
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
fn parse_day(text: &str) -> Option<(u16, u8, u8)> {
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
    if year < 1000 || !is_day_of_month(year, month, day) {
        return None;
    }
    Some((year, month, day))
}

/// Whether the month exists and has the day.
fn is_day_of_month(year: u16, month: u8, day: u8) -> bool {
    (1..=12).contains(&month) && (1..=calculate_days_in_month(year, month)).contains(&day)
}

/// Counts the days of a month.
fn calculate_days_in_month(year: u16, month: u8) -> u8 {
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
        let plain = |word: &str| SearchWord::Plain(word.to_owned());
        let text = |value: &str| SearchWord::Text(value.to_owned());

        assert_eq!(
            build_search_criteria(&arguments).expect("criteria"),
            [
                plain("TEXT"),
                text("invoice"),
                plain("FROM"),
                text("jane@example.com"),
                plain("TO"),
                text("me"),
                plain("SUBJECT"),
                text("Grüße"),
                plain("SINCE"),
                plain("5-Jan-2026"),
                plain("BEFORE"),
                plain("29-Feb-2028"),
                plain("UNSEEN"),
                plain("UNFLAGGED"),
            ]
        );
        assert_eq!(
            build_search_criteria(&SearchArguments::default()).expect("criteria"),
            [plain("ALL")]
        );
        assert_eq!(
            build_search_criteria(&SearchArguments {
                unread: Some(false),
                flagged: Some(true),
                ..SearchArguments::default()
            })
            .expect("criteria"),
            [plain("SEEN"), plain("FLAGGED")]
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
    fn refuses_a_page_past_the_last_one_with_how_many_pages_match() {
        assert_eq!(
            build_page_failure(1),
            ToolFailure::Argument("Only 1 page matches. Ask for page 1.".to_owned())
        );
        assert_eq!(
            build_page_failure(3),
            ToolFailure::Argument("Only 3 pages match. Ask for a page from 1 to 3.".to_owned())
        );
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

    /// An unread hit in INBOX from Jane, with the UID and the timestamp.
    fn build_hit(uid: u32, timestamp: i64) -> Hit {
        Hit {
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
        }
    }

    #[test]
    fn sorts_hits_newest_first_and_formats_them() {
        let mut hits = [
            build_hit(1, 10),
            build_hit(2, 30),
            build_hit(3, 30),
            build_hit(4, 20),
        ];

        hits.sort_by(calculate_hit_order);

        let uids: Vec<u32> = hits.iter().map(|hit| hit.id.uid).collect();
        assert_eq!(uids, vec![3, 2, 4, 1]);
        assert_eq!(
            format_hit(&hits[0]),
            "id 3.7.INBOX\ndate 2026-11-02T10:30:00Z\nfrom Jane <jane@example.com>\nsubject Hello\nflags unread\nfolder INBOX"
        );
    }
}
