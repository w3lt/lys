//! The model providers that are on, stored under the `providers` settings
//! group.
//!
//! The person turns providers on, and sets where LM Studio and a local Ollama
//! server run, in Settings → Providers. Every provider that is on answers
//! requests for its own models. A missing group and a settings file written
//! before the group existed mean LM Studio on at its default address, which
//! is what Lys used before providers could be chosen. A group written before
//! several providers could be on names one `active` provider instead of the
//! `enabled` list; that provider is the one on, and the next save writes the
//! `enabled` list without `active`. An address of `null` means the provider's
//! default address, which only `@lys/protocol` declares, so this module never
//! holds a copy of it. API keys are not here: they live in the `secrets`
//! group. The backend reads this group from the saved file; this module only
//! stores it.

use std::collections::BTreeSet;

use serde::de::Error;
use serde::{Deserialize, Deserializer, Serialize};

use super::host_name::is_host_name;
use super::json::parse_json_object;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Model provider Lys can reach. The values match `llmProviderSchema` in
/// `@lys/share`.
///
/// The declaration order is provider order, the order `@lys/share` lists
/// providers in: providers compare in that order, so a set of them is saved
/// in it. Reordering the variants changes the saved text of the `enabled`
/// list.
pub enum LlmProvider {
    /// LM Studio, at its saved or default address. It is the default: the
    /// provider on when the `providers` group is missing or has neither an
    /// `enabled` list nor an `active` provider.
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Providers that are on and server addresses persisted under the
/// `providers` JSON object.
///
/// The group, and each server in it, is read from a JSON object only, as
/// `@lys/share` reads it; the group may not be `null`, and unknown fields are
/// rejected. A missing group reads as an empty one: LM Studio on and both
/// addresses `null`. The `enabled` list may be empty, when no provider is on;
/// it may not be `null` or name a provider twice. Providers are saved in
/// provider order whatever order they were read in, so that saving unchanged
/// choices rewrites the same text.
///
/// A group without `enabled` was written before several providers could be
/// on: its `active` provider, or LM Studio when it names none, is the one on.
/// When `enabled` is present, `active` is ignored, though it must still name
/// a provider. `active` is read only: a save writes `enabled` without it, so a
/// build from before several providers could be on refuses the saved group.
pub struct ProvidersSettings {
    /// Providers that are on, in the `enabled` array.
    enabled: BTreeSet<LlmProvider>,
    /// LM Studio's server.
    lm_studio: LmStudioProviderSettings,
    /// The local Ollama server.
    ollama: OllamaProviderSettings,
}

/// Holds what a missing `providers` group means: the settings of an empty
/// group.
impl Default for ProvidersSettings {
    /// Reads an empty group, which turns LM Studio on at its default address.
    fn default() -> Self {
        Self::from(StoredProvidersSettings::default())
    }
}

/// Deserializes the group and decides which providers are on.
impl<'de> Deserialize<'de> for ProvidersSettings {
    /// Reads the `providers` object and rejects a group that breaks a rule.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not an object with
    /// only `enabled`, `active`, `lmStudio`, and `ollama` fields, a field
    /// breaks its rule, or `enabled` names a provider twice.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let stored: StoredProvidersSettings = parse_json_object(deserializer)?;

        Ok(Self::from(stored))
    }
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// The `providers` JSON object before the providers that are on are decided.
struct StoredProvidersSettings {
    /// Providers that are on, each once; `None` when the group has no
    /// `enabled` list.
    #[serde(deserialize_with = "parse_enabled_providers")]
    enabled: Option<BTreeSet<LlmProvider>>,
    /// The one provider on in a group without `enabled`.
    active: LlmProvider,
    /// LM Studio's server.
    #[serde(deserialize_with = "parse_json_object")]
    lm_studio: LmStudioProviderSettings,
    /// The local Ollama server.
    #[serde(deserialize_with = "parse_json_object")]
    ollama: OllamaProviderSettings,
}

impl From<StoredProvidersSettings> for ProvidersSettings {
    /// Takes the `enabled` list when the group has one, and otherwise turns
    /// the `active` provider on alone; the servers are taken as stored.
    fn from(stored: StoredProvidersSettings) -> Self {
        let enabled = stored
            .enabled
            .unwrap_or_else(|| BTreeSet::from([stored.active]));

        Self {
            enabled,
            lm_studio: stored.lm_studio,
            ollama: stored.ollama,
        }
    }
}

/// Reads the `enabled` array into the set of providers that are on.
///
/// The array is checked before it becomes a set, which would otherwise keep
/// one copy of a provider listed twice without a trace.
///
/// # Errors
///
/// Returns the deserializer's error when the input is not an array of
/// provider names, or names a provider twice.
fn parse_enabled_providers<'de, D>(
    deserializer: D,
) -> Result<Option<BTreeSet<LlmProvider>>, D::Error>
where
    D: Deserializer<'de>,
{
    let listed = Vec::<LlmProvider>::deserialize(deserializer)?;
    let enabled: BTreeSet<LlmProvider> = listed.iter().copied().collect();
    if enabled.len() != listed.len() {
        return Err(D::Error::custom(
            "the enabled providers must name each provider once",
        ));
    }

    Ok(Some(enabled))
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

    /// Reads `stored` as the `providers` group and returns the JSON form a
    /// save writes for it.
    fn get_saved_providers_json(stored: Value) -> Value {
        let settings = parse_providers_settings(stored).expect("a usable group");

        serde_json::to_value(&settings).expect("settings that serialize")
    }

    #[test]
    fn a_missing_group_or_field_means_lm_studio_on_at_its_default_address() {
        let empty = parse_providers_settings(json!({})).expect("an empty group");

        assert_eq!(empty, ProvidersSettings::default());
        assert_eq!(
            serde_json::to_value(&empty).expect("settings that serialize"),
            json!({
                "enabled": ["lmStudio"],
                "lmStudio": { "address": null },
                "ollama": { "address": null }
            })
        );
    }

    #[test]
    fn round_trips_the_enabled_providers_and_the_addresses() {
        for enabled in [
            json!([]),
            json!(["lmStudio"]),
            json!(["ollama"]),
            json!(["ollamaCloud"]),
            json!(["groq"]),
            json!(["lmStudio", "ollama", "ollamaCloud", "groq"]),
        ] {
            let stored = json!({
                "enabled": enabled,
                "lmStudio": { "address": "studio-box.local:1234" },
                "ollama": { "address": "127.0.0.1:11500" }
            });

            assert_eq!(get_saved_providers_json(stored.clone()), stored);
        }
    }

    #[test]
    fn saves_the_enabled_providers_in_provider_order() {
        let saved = get_saved_providers_json(
            json!({ "enabled": ["groq", "ollamaCloud", "ollama", "lmStudio"] }),
        );

        assert_eq!(
            saved["enabled"],
            json!(["lmStudio", "ollama", "ollamaCloud", "groq"])
        );
    }

    #[test]
    fn a_group_without_enabled_turns_its_active_provider_on_and_saves_without_it() {
        for active in ["lmStudio", "ollama", "ollamaCloud", "groq"] {
            let stored = json!({
                "active": active,
                "lmStudio": { "address": "studio-box.local:1234" },
                "ollama": { "address": "127.0.0.1:11500" }
            });

            assert_eq!(
                get_saved_providers_json(stored),
                json!({
                    "enabled": [active],
                    "lmStudio": { "address": "studio-box.local:1234" },
                    "ollama": { "address": "127.0.0.1:11500" }
                })
            );
        }
    }

    #[test]
    fn the_enabled_providers_win_over_the_active_provider_even_when_empty() {
        for enabled in [json!(["ollama"]), json!([])] {
            let stored = json!({ "enabled": enabled, "active": "groq" });

            assert_eq!(
                get_saved_providers_json(stored),
                json!({
                    "enabled": enabled,
                    "lmStudio": { "address": null },
                    "ollama": { "address": null }
                })
            );
        }
    }

    #[test]
    fn rejects_a_provider_listed_twice() {
        let failure = parse_providers_settings(json!({ "enabled": ["groq", "lmStudio", "groq"] }))
            .expect_err("a provider listed twice");

        assert!(
            failure.to_string().contains("name each provider once"),
            "{failure}"
        );
    }

    #[test]
    fn rejects_unknown_providers_fields_and_invalid_addresses() {
        for stored in [
            json!(null),
            json!([["lmStudio"], "lmStudio", { "address": null }, { "address": null }]),
            json!({ "enabled": ["openai"] }),
            json!({ "enabled": null }),
            json!({ "enabled": "groq" }),
            json!({ "enabled": ["groq"], "active": "openai" }),
            json!({ "active": "openai" }),
            json!({ "active": null }),
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
