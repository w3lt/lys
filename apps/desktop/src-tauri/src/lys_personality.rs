//! Lys's dark and light sides, selected by the local time of day.
//!
//! The desktop host is the authority on which side is active. The renderer
//! reads it through [`get_lys_personality_period`], shows the side's portrait
//! and theme, and sends the side to the backend with each chat request.

use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime};
use serde::Serialize;

/// Local time at which Lysiptera, the light side, begins each day.
///
/// Inclusive: from this time until [`DARK_SIDE_START`] the light side is
/// active. The schedule is fixed; no setting overrides it.
const LIGHT_SIDE_START: NaiveTime =
    NaiveTime::from_hms_opt(6, 0, 0).expect("06:00 is a clock time");

/// Local time at which Caliginia, the dark side, begins each evening.
///
/// Inclusive: from this time until [`LIGHT_SIDE_START`] on the next day the
/// dark side is active. The schedule is fixed; no setting overrides it.
const DARK_SIDE_START: NaiveTime =
    NaiveTime::from_hms_opt(19, 0, 0).expect("19:00 is a clock time");

/// Side of Lys's personality that answers the person.
///
/// Serialized as `"dark"` or `"light"`, the values the renderer validates and
/// forwards to the backend with each chat request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LysPersonality {
    /// Caliginia, the dark side, active through the night.
    Dark,
    /// Lysiptera, the light side, active through the day.
    Light,
}

/// One continuous span of local time during which a single side of Lys is
/// active.
///
/// Serialized as `{ "personality": "dark", "startDate": "2026-10-02" }`. Every
/// reading taken within the same span produces an equal value, so the renderer
/// compares periods to recognize that the side changed, including while the
/// application was closed or the computer was asleep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LysPersonalityPeriod {
    /// Side active throughout the period.
    personality: LysPersonality,
    /// Local calendar date on which the period began, serialized as an ISO
    /// 8601 `YYYY-MM-DD` date. A dark period keeps the date of the evening on
    /// which it began after local midnight.
    start_date: NaiveDate,
}

/// Calculates the period of Lys's personality that contains a local date and
/// time.
///
/// The light side is active from [`LIGHT_SIDE_START`] until
/// [`DARK_SIDE_START`], and its period begins on the same date. The dark side
/// covers the rest of the day: from [`DARK_SIDE_START`] its period begins on
/// the same date, and before [`LIGHT_SIDE_START`] it continues the period that
/// began the previous evening.
///
/// # Errors
///
/// Returns an error when `local_date_time` lies before [`LIGHT_SIDE_START`]
/// on the earliest calendar date chrono can represent, because the period
/// containing it began on an unrepresentable date.
fn calculate_lys_personality_period(
    local_date_time: NaiveDateTime,
) -> Result<LysPersonalityPeriod, String> {
    let date = local_date_time.date();
    let time = local_date_time.time();

    if time < LIGHT_SIDE_START {
        let start_date = date
            .pred_opt()
            .ok_or_else(|| format!("No calendar date precedes {date}"))?;

        return Ok(LysPersonalityPeriod {
            personality: LysPersonality::Dark,
            start_date,
        });
    }

    let personality = if time < DARK_SIDE_START {
        LysPersonality::Light
    } else {
        LysPersonality::Dark
    };

    Ok(LysPersonalityPeriod {
        personality,
        start_date: date,
    })
}

#[tauri::command]
/// Returns the period of Lys's personality that contains the current local
/// time.
///
/// The host reads its local clock and time zone on every call; the renderer
/// calls this command again to notice when the side changes.
///
/// # Errors
///
/// Returns an error when the current local time lies before the morning
/// boundary of the earliest calendar date chrono can represent, because the
/// period containing it began on an unrepresentable date.
pub fn get_lys_personality_period() -> Result<LysPersonalityPeriod, String> {
    calculate_lys_personality_period(Local::now().naive_local())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a local date and time from literal calendar and clock fields.
    fn build_local_date_time(date: (i32, u32, u32), time: (u32, u32, u32)) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2)
            .and_then(|day| day.and_hms_opt(time.0, time.1, time.2))
            .expect("test fixtures use valid calendar dates and clock times")
    }

    /// Builds the period expected for a side that began on a literal date.
    fn build_period(
        personality: LysPersonality,
        start_date: (i32, u32, u32),
    ) -> LysPersonalityPeriod {
        LysPersonalityPeriod {
            personality,
            start_date: NaiveDate::from_ymd_opt(start_date.0, start_date.1, start_date.2)
                .expect("test fixtures use valid calendar dates"),
        }
    }

    #[test]
    fn light_side_begins_at_six_in_the_morning() {
        assert_eq!(
            calculate_lys_personality_period(build_local_date_time((2026, 10, 3), (6, 0, 0))),
            Ok(build_period(LysPersonality::Light, (2026, 10, 3)))
        );
    }

    #[test]
    fn dark_side_continues_the_previous_evening_until_six() {
        assert_eq!(
            calculate_lys_personality_period(build_local_date_time((2026, 10, 3), (5, 59, 59))),
            Ok(build_period(LysPersonality::Dark, (2026, 10, 2)))
        );
    }

    #[test]
    fn light_side_lasts_until_just_before_seven_in_the_evening() {
        assert_eq!(
            calculate_lys_personality_period(build_local_date_time((2026, 10, 3), (18, 59, 59))),
            Ok(build_period(LysPersonality::Light, (2026, 10, 3)))
        );
    }

    #[test]
    fn dark_side_begins_at_seven_in_the_evening() {
        assert_eq!(
            calculate_lys_personality_period(build_local_date_time((2026, 10, 3), (19, 0, 0))),
            Ok(build_period(LysPersonality::Dark, (2026, 10, 3)))
        );
    }

    #[test]
    fn one_night_is_one_period_across_midnight() {
        let before_midnight =
            calculate_lys_personality_period(build_local_date_time((2026, 10, 31), (23, 59, 59)));
        let after_midnight =
            calculate_lys_personality_period(build_local_date_time((2026, 11, 1), (0, 0, 0)));

        assert_eq!(
            before_midnight,
            Ok(build_period(LysPersonality::Dark, (2026, 10, 31)))
        );
        assert_eq!(after_midnight, before_midnight);
    }

    #[test]
    fn nights_on_different_evenings_are_different_periods() {
        assert_ne!(
            calculate_lys_personality_period(build_local_date_time((2026, 10, 3), (5, 0, 0))),
            calculate_lys_personality_period(build_local_date_time((2026, 10, 3), (22, 0, 0)))
        );
    }

    #[test]
    fn night_before_the_earliest_date_has_no_start_date() {
        let earliest_morning = NaiveDate::MIN
            .and_hms_opt(5, 0, 0)
            .expect("five o'clock is a valid clock time");

        assert!(calculate_lys_personality_period(earliest_morning).is_err());
    }

    #[test]
    fn period_serializes_with_lowercase_side_and_iso_start_date() {
        let serialized = serde_json::to_value(build_period(LysPersonality::Dark, (2026, 9, 30)))
            .expect("a period always serializes");

        assert_eq!(
            serialized,
            serde_json::json!({ "personality": "dark", "startDate": "2026-09-30" })
        );
    }
}
