//! The model provider choice, stored under the `providers` settings group.
//!
//! The person picks the provider every request goes to, and where LM Studio
//! and a local Ollama server run, in Settings → Providers. A missing group, a
//! missing field, and a settings file written before the group existed all
//! mean LM Studio at its default address, which is what Lys used before
//! providers could be chosen. An address of `null` means the provider's
//! default address, which only `@lys/protocol` declares, so this module never
//! holds a copy of it. API keys are not here: they live in the `secrets`
//! group. The backend reads this group from the saved file; this module only
//! stores it.

use serde::de::Error;
use serde::{Deserialize, Serialize};

/// Most characters a host name may have, inclusive. Matches
/// `MAXIMUM_HOST_NAME_LENGTH` in `@lys/share`, which the renderer and the
/// backend check.
const HOST_NAME_MAX_LENGTH: usize = 253;

/// Most characters one host name label may have, inclusive. Matches
/// `MAXIMUM_HOST_LABEL_LENGTH` in `@lys/share`.
const HOST_LABEL_MAX_LENGTH: usize = 63;

/// Most digits a port may have. A five-digit port is still checked against
/// the highest TCP port.
const PORT_MAX_DIGITS: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
/// Address of a provider server the person runs, such as `127.0.0.1:1234`.
///
/// Holds a host name or dotted IPv4 address, a colon, and a port from 1 to
/// 65535 without a leading zero. The host is 1 to 253 characters of labels
/// separated by dots; each label is 1 to 63 ASCII letters, digits, or inner
/// hyphens. The rule matches `providerAddressSchema` in `@lys/share`. It
/// serializes as a JSON string.
pub struct ProviderAddress(
    /// The validated address.
    String,
);

impl ProviderAddress {
    /// Creates an address when `value` follows the provider address rule.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    pub fn new(value: String) -> Option<Self> {
        let (host, port) = value.rsplit_once(':')?;
        let is_valid = is_host_name(host) && is_tcp_port(port);

        is_valid.then_some(Self(value))
    }
}

/// Reports whether `host` is a host name under the provider address rule.
fn is_host_name(host: &str) -> bool {
    !host.is_empty() && host.len() <= HOST_NAME_MAX_LENGTH && host.split('.').all(is_host_label)
}

/// Reports whether `label` is one host name label: 1 to 63 ASCII letters,
/// digits, or hyphens, starting and ending with a letter or digit.
fn is_host_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    let (Some(first), Some(last)) = (bytes.first(), bytes.last()) else {
        return false;
    };

    label.len() <= HOST_LABEL_MAX_LENGTH
        && first.is_ascii_alphanumeric()
        && last.is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

/// Reports whether `port` is a decimal TCP port from 1 to 65535 without a
/// leading zero.
fn is_tcp_port(port: &str) -> bool {
    let is_decimal = !port.is_empty()
        && port.len() <= PORT_MAX_DIGITS
        && !port.starts_with('0')
        && port.bytes().all(|byte| byte.is_ascii_digit());

    is_decimal && port.parse::<u16>().is_ok()
}

/// Deserializes a JSON string and applies [`ProviderAddress`] validation.
impl<'de> Deserialize<'de> for ProviderAddress {
    /// Reads a JSON string and rejects one that is not a valid address.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a string or not
    /// a valid address.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;

        Self::new(value).ok_or_else(|| {
            D::Error::custom(
                "a provider address must be a host name or IPv4 address, a colon, and a port from 1 to 65535",
            )
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Model provider every request goes to. The values match
/// `llmProviderSchema` in `@lys/share`.
pub enum LlmProvider {
    /// LM Studio, at its saved or default address.
    #[default]
    LmStudio,
    /// A local Ollama server, at its saved or default address.
    Ollama,
    /// Ollama Cloud, Ollama's hosted service, reached with the saved Ollama
    /// API key.
    OllamaCloud,
    /// Groq's hosted API.
    Groq,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// LM Studio's server, persisted under `providers.lmStudio`.
pub struct LmStudioProviderSettings {
    /// LM Studio's address; `None`, JSON `null`, for its default address.
    address: Option<ProviderAddress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// The local Ollama server, persisted under `providers.ollama`. Ollama Cloud
/// needs no address.
pub struct OllamaProviderSettings {
    /// Local server's address; `None`, JSON `null`, for its default address.
    address: Option<ProviderAddress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// Provider choice and server addresses persisted under the `providers` JSON
/// object.
///
/// A missing field takes its default: LM Studio active and both addresses
/// `null`. The group may not be `null`, and unknown fields are rejected.
pub struct ProvidersSettings {
    /// Provider every request goes to.
    active: LlmProvider,
    /// LM Studio's server.
    lm_studio: LmStudioProviderSettings,
    /// The local Ollama server.
    ollama: OllamaProviderSettings,
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{ProviderAddress, ProvidersSettings};

    /// Reads `stored` as the `providers` group.
    fn parse_providers_settings(stored: Value) -> Result<ProvidersSettings, serde_json::Error> {
        serde_json::from_value(stored)
    }

    #[test]
    fn accepts_host_names_and_ipv4_addresses_with_a_port() {
        for value in [
            "127.0.0.1:1234",
            "localhost:11434",
            "studio-box.local:1",
            "gpu-01.example.com:65535",
            &format!("{}:80", "a".repeat(63)),
        ] {
            assert!(ProviderAddress::new(value.to_string()).is_some(), "{value}");
        }
    }

    #[test]
    fn rejects_schemes_paths_bad_ports_and_bad_labels() {
        for value in [
            "",
            "127.0.0.1",
            ":1234",
            "http://127.0.0.1:1234",
            "127.0.0.1:1234/v1",
            "127.0.0.1:0",
            "127.0.0.1:01234",
            "127.0.0.1:65536",
            "-host:80",
            "host-:80",
            "ho st:80",
            "host..local:80",
            "[::1]:80",
            &format!("{}:80", "a".repeat(64)),
        ] {
            assert!(
                ProviderAddress::new(value.to_string()).is_none(),
                "{value:?}"
            );
        }
    }

    #[test]
    fn a_missing_group_or_field_means_lm_studio_at_its_default_address() {
        let empty = parse_providers_settings(json!({})).expect("an empty group");

        assert_eq!(empty, ProvidersSettings::default());
        assert_eq!(
            serde_json::to_value(&empty).expect("settings that serialize"),
            json!({
                "active": "lmStudio",
                "lmStudio": { "address": null },
                "ollama": { "address": null }
            })
        );
    }

    #[test]
    fn round_trips_each_saved_choice_and_the_addresses() {
        for active in ["lmStudio", "ollama", "ollamaCloud", "groq"] {
            let stored = json!({
                "active": active,
                "lmStudio": { "address": "studio-box.local:1234" },
                "ollama": { "address": "127.0.0.1:11500" }
            });

            let settings = parse_providers_settings(stored.clone()).expect("a saved group");

            assert_eq!(
                serde_json::to_value(&settings).expect("settings that serialize"),
                stored
            );
        }
    }

    #[test]
    fn rejects_unknown_providers_fields_and_invalid_addresses() {
        for stored in [
            json!(null),
            json!({ "active": "openai" }),
            json!({ "ollama": { "mode": "cloud" } }),
            json!({ "lmStudio": { "address": "http://127.0.0.1:1234" } }),
            json!({ "groq": {} }),
        ] {
            assert!(
                parse_providers_settings(stored.clone()).is_err(),
                "{stored}"
            );
        }
    }
}
