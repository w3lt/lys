use std::fmt;

use serde::de::Error;
use serde::{Deserialize, Serialize};

/// Most characters an API key may have, inclusive. Matches
/// `MAXIMUM_API_KEY_LENGTH` in `@lys/share`, which the renderer and the
/// backend check.
const API_KEY_MAX_LENGTH: usize = 256;

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
/// API key of a service Lys sends requests to, such as Tavily, Ollama's
/// cloud, or Groq; a secret.
///
/// Holds 1 to 256 visible ASCII characters (`!` through `~`), so it never
/// contains a space, line break, or other byte that could split the HTTP
/// header it is sent in. It serializes as a JSON string. `Debug` never shows
/// the key.
pub struct ApiKey(
    /// The validated key text.
    String,
);

impl ApiKey {
    /// Creates a key when `value` holds 1 to 256 visible ASCII characters.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    pub fn new(value: String) -> Option<Self> {
        let is_valid = !value.is_empty()
            && value.len() <= API_KEY_MAX_LENGTH
            && value.bytes().all(|byte| byte.is_ascii_graphic());

        is_valid.then_some(Self(value))
    }
}

impl fmt::Debug for ApiKey {
    /// Writes a placeholder instead of the key.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ApiKey(<redacted>)")
    }
}

/// Deserializes a JSON string and applies [`ApiKey`] validation.
impl<'de> Deserialize<'de> for ApiKey {
    /// Reads a JSON string and rejects one that is not a valid key.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a string or not
    /// a valid key. The error never contains the value.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;

        Self::new(value)
            .ok_or_else(|| D::Error::custom("an API key must be 1 to 256 visible ASCII characters"))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
/// Secrets persisted under the `secrets` JSON object.
///
/// A missing group or field means no key. The settings file holding this
/// group is written owner-only, because the keys are stored as plain text.
pub struct SecretsSettings {
    /// Key of the Tavily search service; `None`, JSON `null`, when no key is
    /// saved.
    pub tavily_api_key: Option<ApiKey>,
    /// Key of Ollama Cloud, sent while Ollama Cloud is the active provider;
    /// `None`, JSON `null`, when no key is saved.
    pub ollama_api_key: Option<ApiKey>,
    /// Key of Groq's API, sent while Groq is the active provider; `None`, JSON
    /// `null`, when no key is saved.
    pub groq_api_key: Option<ApiKey>,
}

#[cfg(test)]
mod tests {
    use super::ApiKey;

    #[test]
    fn accepts_visible_ascii_keys_from_one_to_256_characters() {
        for value in ["k", "tvly-synthetic-0123456789", &"k".repeat(256)] {
            assert!(ApiKey::new(value.to_string()).is_some(), "{value}");
        }
    }

    #[test]
    fn rejects_empty_long_spaced_and_non_ascii_keys() {
        for value in [
            String::new(),
            "k".repeat(257),
            "tvly-key ".to_string(),
            "tvly-\nkey".to_string(),
            "tvly-clé".to_string(),
        ] {
            assert!(ApiKey::new(value.clone()).is_none(), "{value:?}");
        }
    }

    #[test]
    fn debug_output_never_shows_the_key() {
        let key = ApiKey::new("tvly-synthetic-0123456789".to_string()).expect("a valid key");

        assert_eq!(format!("{key:?}"), "ApiKey(<redacted>)");
    }
}
