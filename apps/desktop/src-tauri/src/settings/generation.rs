use serde::de::Error;
use serde::{Deserialize, Serialize};

const REPLY_CEILING_DEFAULT_VALUE: u32 = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
/// Sampling temperature constrained to the inclusive interval `[0, 1]`.
///
/// Serialization represents the value as a JSON number. Deserialization uses
/// the same range validation, so values above `1.0`, negative values, `NaN`, and infinities
/// are rejected; the default is `0.7`.
pub struct GenerationTemperature(
    /// The validated sampling value serialized as a JSON number.
    f64,
);

impl GenerationTemperature {
    /// Creates a temperature when `value` is in `[0, 1]`.
    ///
    /// Returns `None` for values outside the range, including non-finite
    /// values.
    pub fn new(value: f64) -> Option<Self> {
        (0.0..=1.0).contains(&value).then_some(Self(value))
    }

    /// Returns the validated floating-point temperature.
    pub fn get(&self) -> f64 {
        self.0
    }
}

impl Default for GenerationTemperature {
    /// Returns the default sampling temperature, `0.7`.
    fn default() -> Self {
        Self(0.7)
    }
}

/// Deserializes a JSON number and applies [`GenerationTemperature`] validation.
///
/// The serialized representation is a scalar number rather than an object.
impl<'de> Deserialize<'de> for GenerationTemperature {
    /// Reads a JSON number and rejects values outside `[0, 1]`.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a number or does
    /// not satisfy the temperature range.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value: f64 = f64::deserialize(deserializer)?;

        Self::new(value)
            .ok_or_else(|| D::Error::custom("temperature must be between 0 and 1 inclusive"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
/// Generation settings persisted under the `generation` JSON object.
///
/// Missing fields default to a 2048-token reply ceiling and temperature `0.7`.
/// Field names serialize in camelCase; a zero reply ceiling means no explicit limit.
pub struct GenerationSettings {
    /// Validated sampling temperature.
    pub temperature: GenerationTemperature,
    /// Maximum reply tokens; zero is translated to an omitted chat request limit.
    pub reply_ceiling: u32,
}

impl Default for GenerationSettings {
    fn default() -> Self {
        Self {
            temperature: Default::default(),
            reply_ceiling: REPLY_CEILING_DEFAULT_VALUE,
        }
    }
}
