use std::fmt;

use serde::de::Error;
use serde::{Deserialize, Serialize};

/// Most characters an API key may have, inclusive. Matches
/// `MAXIMUM_API_KEY_LENGTH` in `@lys/share`, which the renderer and the
/// backend check.
const API_KEY_MAX_LENGTH: usize = 256;

/// Most characters, counted as Unicode scalar values, an email password may
/// have, inclusive. Matches `MAXIMUM_EMAIL_PASSWORD_LENGTH` in `@lys/share`,
/// which the renderer and the backend check.
const EMAIL_PASSWORD_MAX_LENGTH: usize = 1024;

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

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
/// Password, or app password, the email account signs in with; a secret.
///
/// Holds 1 to 1024 characters, none of them a control character. Spaces are
/// kept, because some providers show app passwords in spaced groups and
/// accept them either way. It serializes as a JSON string. `Debug` never
/// shows the password.
pub struct EmailPassword(
    /// The validated password.
    String,
);

impl EmailPassword {
    /// Creates a password when `value` holds 1 to 1024 characters, none of
    /// them a control character.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    pub fn new(value: String) -> Option<Self> {
        let is_valid = (1..=EMAIL_PASSWORD_MAX_LENGTH).contains(&value.chars().count())
            && !value.chars().any(char::is_control);

        is_valid.then_some(Self(value))
    }
}

impl fmt::Debug for EmailPassword {
    /// Writes a placeholder instead of the password.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EmailPassword(<redacted>)")
    }
}

/// Deserializes a JSON string and applies [`EmailPassword`] validation.
impl<'de> Deserialize<'de> for EmailPassword {
    /// Reads a JSON string and rejects one that is not a valid password.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a string or not
    /// a valid password. The error never contains the value.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;

        Self::new(value).ok_or_else(|| {
            D::Error::custom(
                "an email password must be 1 to 1024 characters, without line breaks or other control characters",
            )
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
/// Secrets persisted under the `secrets` JSON object.
///
/// A missing group or field means no key and no password. The settings file
/// holding this group is written owner-only, because the secrets are stored
/// as plain text.
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
    /// Password of the email account saved in the `email` group; `None`,
    /// JSON `null`, when no password is saved.
    pub email_password: Option<EmailPassword>,
}

#[cfg(test)]
mod tests {
    use super::{ApiKey, EmailPassword};

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

    #[test]
    fn accepts_passwords_of_one_to_1024_characters_with_spaces_and_accents() {
        for value in [
            "p".to_string(),
            "abcd efgh ijkl mnop".to_string(),
            " spaced ".to_string(),
            "pässwörd-synthetic".to_string(),
            "é".repeat(1024),
        ] {
            assert!(EmailPassword::new(value.clone()).is_some(), "{value:?}");
        }
    }

    #[test]
    fn rejects_empty_long_and_control_character_passwords() {
        for value in [
            String::new(),
            "é".repeat(1025),
            "pass\nword".to_string(),
            "pass\tword".to_string(),
            "pass\u{0000}word".to_string(),
        ] {
            assert!(EmailPassword::new(value.clone()).is_none(), "{value:?}");
        }
    }

    #[test]
    fn debug_output_never_shows_the_password() {
        let password =
            EmailPassword::new("synthetic-password-7f3a".to_string()).expect("a valid password");

        assert_eq!(format!("{password:?}"), "EmailPassword(<redacted>)");
    }
}
