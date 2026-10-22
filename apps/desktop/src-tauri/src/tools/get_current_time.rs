//! The `get_current_time` tool, which reads the local date, time, and time
//! zone of the machine running the desktop app.

use jiff::{civil::Weekday, tz::TimeZone, Timestamp, Zoned};
use serde::Serialize;

use super::definition::{ToolAccess, ToolDefinition, ToolGroup, ToolRunner};

/// Seconds in one hour, used to split a UTC offset into its hours.
const SECONDS_PER_HOUR: i32 = 60 * 60;

/// Seconds in one minute, used to split a UTC offset into its minutes.
const SECONDS_PER_MINUTE: i32 = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Local date, time, and time zone of this machine at one instant, as the
/// `get_current_time` command returns it.
pub struct CurrentTime {
    /// Local date and time to the second, followed by the UTC offset as in
    /// `utc_offset`, such as `2026-10-22T21:30:05+02:00`, which is RFC 3339
    /// unless the offset has seconds. Fractions of a second are dropped, never
    /// rounded up.
    date_time: String,
    /// English name of the local weekday, such as `Thursday`.
    weekday: &'static str,
    /// Offset of local time from UTC as `+HH:MM`, or `+HH:MM:SS` for an offset
    /// with seconds; UTC itself is `+00:00`.
    utc_offset: String,
    /// IANA name of the machine's time zone, such as `Europe/Paris`; `None`,
    /// JSON `null`, when the zone has none, as for a zone a POSIX `TZ` rule
    /// sets.
    time_zone: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
/// Expected failure of the `get_current_time` command.
///
/// The command rejects with a JSON object whose `code` is the camelCase
/// variant name, such as `{ "code": "timeZoneUnknown" }`.
pub enum GetCurrentTimeError {
    /// The machine's time zone could not be determined, for example because
    /// `TZ` names no known zone or `/etc/localtime` cannot be read. No time is
    /// returned: local time is unknown without the zone, and Lys never
    /// assumes UTC instead.
    TimeZoneUnknown,
}

#[tauri::command]
/// Reads the local date, time, and time zone of this machine.
///
/// The renderer invokes this command as `get_current_time` with no
/// arguments. It reads the system clock and the machine's time zone: `TZ`
/// when it is set, otherwise `/etc/localtime`. It changes nothing and cannot
/// be cancelled.
///
/// # Errors
///
/// Rejects with [`GetCurrentTimeError::TimeZoneUnknown`] when the machine's
/// time zone cannot be determined.
pub fn get_current_time() -> Result<CurrentTime, GetCurrentTimeError> {
    let time_zone = TimeZone::try_system().map_err(|_| GetCurrentTimeError::TimeZoneUnknown)?;

    Ok(build_current_time(&Timestamp::now().to_zoned(time_zone)))
}

/// Builds the local date, time, and time zone of the instant `now`, in the
/// time zone it carries.
fn build_current_time(now: &Zoned) -> CurrentTime {
    let utc_offset = format_utc_offset(now.offset().seconds());
    let local = now.datetime();
    let date_time = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{utc_offset}",
        local.year(),
        local.month(),
        local.day(),
        local.hour(),
        local.minute(),
        local.second()
    );

    CurrentTime {
        date_time,
        weekday: format_weekday(now.weekday()),
        utc_offset,
        time_zone: now.time_zone().iana_name().map(String::from),
    }
}

/// Formats an offset from UTC, given in seconds east of UTC, as `+HH:MM`, or
/// as `+HH:MM:SS` when it has seconds. A zero offset is `+00:00`.
fn format_utc_offset(offset_seconds: i32) -> String {
    let sign = if offset_seconds < 0 { '-' } else { '+' };
    let magnitude = offset_seconds.abs();
    let hours = magnitude / SECONDS_PER_HOUR;
    let minutes = magnitude % SECONDS_PER_HOUR / SECONDS_PER_MINUTE;
    let seconds = magnitude % SECONDS_PER_MINUTE;

    if seconds == 0 {
        format!("{sign}{hours:02}:{minutes:02}")
    } else {
        format!("{sign}{hours:02}:{minutes:02}:{seconds:02}")
    }
}

/// Formats a weekday as its English name, such as `Thursday`.
fn format_weekday(weekday: Weekday) -> &'static str {
    match weekday {
        Weekday::Monday => "Monday",
        Weekday::Tuesday => "Tuesday",
        Weekday::Wednesday => "Wednesday",
        Weekday::Thursday => "Thursday",
        Weekday::Friday => "Friday",
        Weekday::Saturday => "Saturday",
        Weekday::Sunday => "Sunday",
    }
}

/// Builds the definition of the get-current-time tool for the client tool
/// list. The tool takes no arguments.
pub(super) fn build_get_current_time_definition() -> ToolDefinition {
    ToolDefinition {
        name: "get_current_time",
        description: String::from(
            "Get the current local date and time of the person's machine, to the second, with its UTC offset, weekday, and IANA time zone.",
        ),
        group: ToolGroup::TimeAndPlace,
        access: ToolAccess::Reads,
        runner: ToolRunner::Client,
        arguments: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use jiff::{
        tz::{Offset, TimeZone},
        Timestamp,
    };
    use serde_json::json;

    use super::{build_current_time, CurrentTime, GetCurrentTimeError};

    /// Instant 2026-10-22T19:30:05Z, a Thursday in UTC.
    const THURSDAY_EVENING_UTC_SECONDS: i64 = 1_792_697_405;

    /// Builds the current time of `seconds` after the Unix epoch, plus
    /// `nanoseconds`, in `time_zone`.
    fn build_current_time_at(seconds: i64, nanoseconds: i32, time_zone: TimeZone) -> CurrentTime {
        let instant = Timestamp::new(seconds, nanoseconds).expect("a valid test instant");

        build_current_time(&instant.to_zoned(time_zone))
    }

    /// Gets a zone of the system time zone database by its IANA name.
    fn get_named_zone(name: &str) -> TimeZone {
        TimeZone::get(name).expect("a zone the system time zone database holds")
    }

    #[test]
    fn gives_the_local_time_offset_weekday_and_name_of_a_zone_east_of_utc() {
        let current_time = build_current_time_at(
            THURSDAY_EVENING_UTC_SECONDS,
            0,
            get_named_zone("Europe/Paris"),
        );

        assert_eq!(
            serde_json::to_value(current_time).expect("serialize"),
            json!({
                "dateTime": "2026-10-22T21:30:05+02:00",
                "weekday": "Thursday",
                "utcOffset": "+02:00",
                "timeZone": "Europe/Paris"
            })
        );
    }

    #[test]
    fn gives_the_earlier_local_date_of_a_zone_west_of_utc() {
        let next_day_utc = THURSDAY_EVENING_UTC_SECONDS + 7 * 60 * 60;

        let current_time =
            build_current_time_at(next_day_utc, 0, get_named_zone("America/New_York"));

        assert_eq!(
            serde_json::to_value(current_time).expect("serialize"),
            json!({
                "dateTime": "2026-10-22T22:30:05-04:00",
                "weekday": "Thursday",
                "utcOffset": "-04:00",
                "timeZone": "America/New_York"
            })
        );
    }

    #[test]
    fn gives_the_minutes_of_a_half_hour_offset_and_the_later_local_weekday() {
        let current_time = build_current_time_at(
            THURSDAY_EVENING_UTC_SECONDS,
            0,
            get_named_zone("Asia/Kolkata"),
        );

        assert_eq!(
            serde_json::to_value(current_time).expect("serialize"),
            json!({
                "dateTime": "2026-10-23T01:00:05+05:30",
                "weekday": "Friday",
                "utcOffset": "+05:30",
                "timeZone": "Asia/Kolkata"
            })
        );
    }

    #[test]
    fn gives_utc_as_a_zero_offset() {
        let current_time = build_current_time_at(THURSDAY_EVENING_UTC_SECONDS, 0, TimeZone::UTC);

        assert_eq!(
            serde_json::to_value(current_time).expect("serialize"),
            json!({
                "dateTime": "2026-10-22T19:30:05+00:00",
                "weekday": "Thursday",
                "utcOffset": "+00:00",
                "timeZone": "UTC"
            })
        );
    }

    #[test]
    fn gives_no_zone_name_for_a_posix_rule() {
        let posix_rule = TimeZone::posix("EST5EDT,M3.2.0,M11.1.0").expect("a valid POSIX rule");

        let current_time = build_current_time_at(THURSDAY_EVENING_UTC_SECONDS, 0, posix_rule);

        assert_eq!(
            serde_json::to_value(current_time).expect("serialize"),
            json!({
                "dateTime": "2026-10-22T15:30:05-04:00",
                "weekday": "Thursday",
                "utcOffset": "-04:00",
                "timeZone": null
            })
        );
    }

    #[test]
    fn gives_the_seconds_of_an_offset_that_has_them() {
        let offset = Offset::from_seconds(-(3 * 60 * 60 + 25 * 60 + 52)).expect("a valid offset");

        let current_time =
            build_current_time_at(THURSDAY_EVENING_UTC_SECONDS, 0, TimeZone::fixed(offset));

        assert_eq!(current_time.utc_offset, "-03:25:52");
        assert_eq!(current_time.date_time, "2026-10-22T16:04:13-03:25:52");
    }

    #[test]
    fn drops_the_fraction_of_a_second() {
        let current_time =
            build_current_time_at(THURSDAY_EVENING_UTC_SECONDS, 999_999_999, TimeZone::UTC);

        assert_eq!(current_time.date_time, "2026-10-22T19:30:05+00:00");
    }

    #[test]
    fn serializes_the_failure_with_a_camel_case_code() {
        assert_eq!(
            serde_json::to_value(GetCurrentTimeError::TimeZoneUnknown).expect("serialize"),
            json!({ "code": "timeZoneUnknown" })
        );
    }
}
