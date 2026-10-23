//! The `get_current_time` tool, which reads the local date, time, and time
//! zone of the machine running the desktop app.

use std::{env, fs, path::Path};

use jiff::{civil::Weekday, tz::TimeZone, Timestamp, Zoned};
use serde::Serialize;

use super::definition::{ToolAccess, ToolDefinition, ToolGroup, ToolRunner};

/// Seconds in one hour, used to split a UTC offset into its hours.
const SECONDS_PER_HOUR: i32 = 60 * 60;

/// Seconds in one minute, used to split a UTC offset into its minutes.
const SECONDS_PER_MINUTE: i32 = 60;

/// Path that sets the machine's time zone when `TZ` is not set: on macOS, a
/// link into the zoneinfo directory that is replaced when the zone changes in
/// System Settings or through automatic time zone.
const LOCALTIME_PATH: &str = "/etc/localtime";

/// Part of a zoneinfo path that comes just before the IANA name of the zone,
/// as in `/var/db/timezone/zoneinfo/Europe/Paris`.
const ZONEINFO_DIRECTORY: &str = "zoneinfo/";

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
    /// or an `/etc/localtime` that is not a zoneinfo link sets.
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
/// arguments. It reads the system clock and the machine's time zone at each
/// call, as [`get_machine_time_zone`] describes, so a change of zone applies
/// to the next call. It changes nothing and cannot be cancelled.
///
/// # Errors
///
/// Rejects with [`GetCurrentTimeError::TimeZoneUnknown`] when the machine's
/// time zone cannot be determined.
pub fn get_current_time() -> Result<CurrentTime, GetCurrentTimeError> {
    let now = Timestamp::now();
    let time_zone = get_machine_time_zone(now)?;

    Ok(build_current_time(&now.to_zoned(time_zone)))
}

/// Gets the machine's time zone at the instant `now`: the zone `TZ` sets when
/// it is set, otherwise the zone [`LOCALTIME_PATH`] sets, read afresh.
///
/// `TZ` is read through jiff, which keeps the zone it found for up to 5
/// minutes. Nothing in this process changes `TZ`, so that copy stays current,
/// unless `TZ` names a file whose zone changes within those 5 minutes.
///
/// # Errors
///
/// Returns [`GetCurrentTimeError::TimeZoneUnknown`] when `TZ` names no zone
/// jiff can read or, without `TZ`, as [`read_localtime_zone`] does.
fn get_machine_time_zone(now: Timestamp) -> Result<TimeZone, GetCurrentTimeError> {
    if env::var_os("TZ").is_some() {
        return TimeZone::try_system().map_err(|_| GetCurrentTimeError::TimeZoneUnknown);
    }

    read_localtime_zone(Path::new(LOCALTIME_PATH), now)
}

/// Reads the time zone that `localtime`, a path such as `/etc/localtime`,
/// sets at the instant `now`.
///
/// A link whose target holds `zoneinfo/` sets the zone named by the rest of
/// the target, such as `Europe/Paris`, when jiff's time zone database knows
/// that name. Any other link or file is read as TZif data, which names no
/// zone; see [`read_unnamed_zone`]. Nothing is kept between calls.
///
/// # Errors
///
/// Returns [`GetCurrentTimeError::TimeZoneUnknown`] when `localtime` neither
/// links to a known zone nor holds TZif data, for example because it is
/// missing.
fn read_localtime_zone(localtime: &Path, now: Timestamp) -> Result<TimeZone, GetCurrentTimeError> {
    let linked_zone = fs::read_link(localtime)
        .ok()
        .and_then(|target| find_linked_zone(&target));

    match linked_zone {
        Some(zone) => Ok(zone),
        None => read_unnamed_zone(localtime, now).ok_or(GetCurrentTimeError::TimeZoneUnknown),
    }
}

/// Finds the zone that a zoneinfo link `target`, such as
/// `/var/db/timezone/zoneinfo/Europe/Paris`, names; `None` when the target
/// holds no `zoneinfo/` or names no zone jiff's time zone database knows.
fn find_linked_zone(target: &Path) -> Option<TimeZone> {
    let target = target.to_str()?;
    let name_start = target.rfind(ZONEINFO_DIRECTORY)? + ZONEINFO_DIRECTORY.len();

    TimeZone::get(&target[name_start..]).ok()
}

/// Reads the TZif data at `path`, which names no IANA zone, as a zone fixed at
/// the offset that data gives for `now`, so the zone has no name; `None` when
/// `path` cannot be read or holds no TZif data.
///
/// jiff 0.2 builds a zone from TZif data only with a name. The empty name
/// given here stays with that zone, which serves only to find the offset. The
/// fixed zone is right for `now`, the one instant the command reports.
fn read_unnamed_zone(path: &Path, now: Timestamp) -> Option<TimeZone> {
    let data = fs::read(path).ok()?;
    let named_zone = TimeZone::tzif("", &data).ok()?;

    Some(TimeZone::fixed(named_zone.to_offset(now)))
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
    use std::{fs, os::unix::fs::symlink, path::Path};

    use jiff::{
        tz::{Offset, TimeZone},
        Timestamp,
    };
    use serde_json::json;

    use super::{build_current_time, read_localtime_zone, CurrentTime, GetCurrentTimeError};
    use crate::tools::test_directory::TestDirectory;

    /// Instant 2026-10-22T19:30:05Z, a Thursday in UTC.
    const THURSDAY_EVENING_UTC_SECONDS: i64 = 1_792_697_405;

    /// Directory of the system time zone database, which jiff reads the named
    /// zones of these tests from.
    const SYSTEM_ZONEINFO_DIRECTORY: &str = "/usr/share/zoneinfo";

    /// Builds the current time of `seconds` after the Unix epoch, plus
    /// `nanoseconds`, in `time_zone`.
    fn build_current_time_at(seconds: i64, nanoseconds: i32, time_zone: TimeZone) -> CurrentTime {
        let instant = Timestamp::new(seconds, nanoseconds).expect("a valid test instant");

        build_current_time(&instant.to_zoned(time_zone))
    }

    /// Builds the current time at [`THURSDAY_EVENING_UTC_SECONDS`] in the zone
    /// that `localtime` sets, or the failure of reading that zone.
    fn build_current_time_from(localtime: &Path) -> Result<CurrentTime, GetCurrentTimeError> {
        let instant =
            Timestamp::from_second(THURSDAY_EVENING_UTC_SECONDS).expect("a valid test instant");

        read_localtime_zone(localtime, instant)
            .map(|zone| build_current_time(&instant.to_zoned(zone)))
    }

    /// Reads the TZif data of the zone `name` from the system time zone
    /// database.
    fn read_system_tzif_data(name: &str) -> Vec<u8> {
        fs::read(Path::new(SYSTEM_ZONEINFO_DIRECTORY).join(name))
            .expect("a zone the system time zone database holds")
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
    fn reads_the_zone_a_zoneinfo_link_names_again_at_each_call() {
        let directory = TestDirectory::create("localtime-link");
        let localtime = directory.path().join("localtime");
        symlink("/var/db/timezone/zoneinfo/Europe/Paris", &localtime).expect("link to Paris");

        let in_paris = build_current_time_from(&localtime).expect("a zone for Paris");
        fs::remove_file(&localtime).expect("remove the link to Paris");
        symlink("/var/db/timezone/zoneinfo/Asia/Tokyo", &localtime).expect("link to Tokyo");
        let in_tokyo = build_current_time_from(&localtime).expect("a zone for Tokyo");

        assert_eq!(
            serde_json::to_value(in_paris).expect("serialize"),
            json!({
                "dateTime": "2026-10-22T21:30:05+02:00",
                "weekday": "Thursday",
                "utcOffset": "+02:00",
                "timeZone": "Europe/Paris"
            })
        );
        assert_eq!(
            serde_json::to_value(in_tokyo).expect("serialize"),
            json!({
                "dateTime": "2026-10-23T04:30:05+09:00",
                "weekday": "Friday",
                "utcOffset": "+09:00",
                "timeZone": "Asia/Tokyo"
            })
        );
    }

    #[test]
    fn reads_a_tzif_file_as_a_zone_without_a_name() {
        let directory = TestDirectory::create("localtime-file");
        let localtime = directory.create_file("localtime", read_system_tzif_data("Asia/Tokyo"));

        let current_time = build_current_time_from(&localtime).expect("a zone for a TZif file");

        assert_eq!(
            serde_json::to_value(current_time).expect("serialize"),
            json!({
                "dateTime": "2026-10-23T04:30:05+09:00",
                "weekday": "Friday",
                "utcOffset": "+09:00",
                "timeZone": null
            })
        );
    }

    #[test]
    fn reads_the_target_of_a_link_that_names_no_known_zone_as_a_zone_without_a_name() {
        let directory = TestDirectory::create("localtime-unknown-name");
        let target =
            directory.create_file("zoneinfo/Lys/Nowhere", read_system_tzif_data("Asia/Tokyo"));
        let localtime = directory.path().join("localtime");
        symlink(&target, &localtime).expect("link to a zone with an unknown name");

        let current_time = build_current_time_from(&localtime).expect("a zone for the target");

        assert_eq!(current_time.utc_offset, "+09:00");
        assert_eq!(current_time.time_zone, None);
    }

    #[test]
    fn fails_when_localtime_neither_links_to_a_known_zone_nor_holds_tzif_data() {
        let directory = TestDirectory::create("localtime-unknown");
        let missing = directory.path().join("missing");
        let not_tzif = directory.create_file("not-tzif", "Europe/Paris\n");
        let dangling = directory.path().join("dangling");
        symlink("/nowhere/zoneinfo/Lys/Nowhere", &dangling).expect("link to nothing");

        for localtime in [missing, not_tzif, dangling] {
            assert_eq!(
                build_current_time_from(&localtime),
                Err(GetCurrentTimeError::TimeZoneUnknown),
                "{}",
                localtime.display()
            );
        }
    }

    #[test]
    fn serializes_the_failure_with_a_camel_case_code() {
        assert_eq!(
            serde_json::to_value(GetCurrentTimeError::TimeZoneUnknown).expect("serialize"),
            json!({ "code": "timeZoneUnknown" })
        );
    }
}
