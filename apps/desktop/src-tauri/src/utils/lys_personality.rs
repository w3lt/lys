use chrono::{Local, NaiveTime};
use std::sync::RwLock;

#[derive(PartialEq, Debug, Clone, Copy, Eq)]
pub enum LysPersonality {
    Dark,
    Light,
}

impl LysPersonality {
    pub fn name(&self) -> &'static str {
        match self {
            LysPersonality::Dark => "Caliginia",
            LysPersonality::Light => "Lysiptera",
        }
    }
}

pub struct LysPersonalitySchedule {
    pub dark_start: NaiveTime,
    pub light_start: NaiveTime,
}

impl LysPersonalitySchedule {
    pub fn personality_at(&self, t: NaiveTime) -> LysPersonality {
        if t >= self.dark_start || t < self.light_start {
            LysPersonality::Dark
        } else {
            LysPersonality::Light
        }
    }

    pub fn current(&self) -> LysPersonality {
        self.personality_at(Local::now().time())
    }
}

impl Default for LysPersonalitySchedule {
    fn default() -> Self {
        Self {
            // These values are hard coded for now, but it should be from user configuration.
            // However, it's for a future feature
            // TODO: Create an issue for this
            dark_start: NaiveTime::from_hms_opt(19, 0, 0).unwrap(),
            light_start: NaiveTime::from_hms_opt(6, 0, 0).unwrap(),
        }
    }
}
