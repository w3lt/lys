//! Load settings stored under the `loadConfiguration` settings group.
//!
//! The group holds one default and, per model key, the settings a person
//! changed for that model. The desktop renderer resolves the settings of one
//! load from both and sends them with the load request; this module only
//! stores them. The accepted values match the load request's contract: whole
//! numbers from 1 to 4,294,967,295, and booleans.

use std::{collections::BTreeMap, num::NonZeroU32};

use serde::{Deserialize, Deserializer, Serialize};

/// Committed default load configuration, embedded when the host is built.
///
/// It is the default of a settings file that has no load configuration yet.
/// Editing the file changes what such files are given; a settings file that
/// already has the group keeps its stored default.
const COMMITTED_DEFAULT_JSON: &str = include_str!("../../default_model_load_configuration.json");

/// Deserializes a setting that is present in the input.
///
/// Used for optional settings, so that an explicit `null` is rejected rather
/// than read as an absent setting; an absent setting never reaches this
/// function.
///
/// # Errors
///
/// Returns the deserializer's error when the input, including `null`, is not a
/// valid value of the setting's type.
pub(super) fn parse_present_setting<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// Load settings one model has of its own.
///
/// Every setting is optional. A setting that is absent is supplied by the
/// stored default when the model is loaded, and is left out of the serialized
/// object. Unknown settings and `null` are rejected.
pub struct ModelLoadConfiguration {
    /// Context window the model is loaded with, in tokens.
    #[serde(
        deserialize_with = "parse_present_setting",
        skip_serializing_if = "Option::is_none"
    )]
    context_length: Option<NonZeroU32>,
    /// Prompt tokens evaluated together in one batch.
    #[serde(
        deserialize_with = "parse_present_setting",
        skip_serializing_if = "Option::is_none"
    )]
    eval_batch_size: Option<NonZeroU32>,
    /// Whether the model is loaded with flash attention.
    #[serde(
        deserialize_with = "parse_present_setting",
        skip_serializing_if = "Option::is_none"
    )]
    flash_attention: Option<bool>,
    /// Whether the KV cache is kept in GPU memory rather than in RAM.
    ///
    /// The wire name keeps LM Studio's capitalization, which camelCase
    /// renaming would not produce.
    #[serde(
        rename = "offloadKVCacheToGpu",
        deserialize_with = "parse_present_setting",
        skip_serializing_if = "Option::is_none"
    )]
    offload_kv_cache_to_gpu: Option<bool>,
    /// Experts active per token; only mixture-of-experts models use it.
    #[serde(
        deserialize_with = "parse_present_setting",
        skip_serializing_if = "Option::is_none"
    )]
    num_experts: Option<NonZeroU32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// Load settings used for a model that has none of its own.
///
/// The context length, eval batch size, flash attention, and KV cache settings
/// are required, so a load Lys starts always sends them. The expert count is
/// optional and is left out of the serialized object when absent. Unknown
/// settings and `null` are rejected.
pub struct DefaultModelLoadConfiguration {
    /// Context window a model is loaded with, in tokens.
    context_length: NonZeroU32,
    /// Prompt tokens evaluated together in one batch.
    eval_batch_size: NonZeroU32,
    /// Whether a model is loaded with flash attention.
    flash_attention: bool,
    /// Whether the KV cache is kept in GPU memory rather than in RAM.
    ///
    /// The wire name keeps LM Studio's capitalization, which camelCase
    /// renaming would not produce.
    #[serde(rename = "offloadKVCacheToGpu")]
    offload_kv_cache_to_gpu: bool,
    /// Experts active per token; only mixture-of-experts models use it.
    #[serde(
        default,
        deserialize_with = "parse_present_setting",
        skip_serializing_if = "Option::is_none"
    )]
    num_experts: Option<NonZeroU32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Load settings persisted under the `loadConfiguration` JSON object.
///
/// Both parts are required when the group is present. Model keys are stored
/// in ascending order, so that saving unchanged settings rewrites the same
/// text.
pub struct LoadConfigurationSettings {
    /// Settings used for a model that has none of its own, in the `default`
    /// object.
    #[serde(rename = "default")]
    default_configuration: DefaultModelLoadConfiguration,
    /// Settings each model has of its own, keyed by the model's key.
    models: BTreeMap<String, ModelLoadConfiguration>,
}

impl LoadConfigurationSettings {
    /// Creates the load settings of a settings file that has none yet: the
    /// committed default and no model settings.
    ///
    /// # Errors
    ///
    /// Returns an error when the committed default file is not a valid default
    /// configuration.
    pub fn create_initial() -> Result<Self, String> {
        let default_configuration =
            serde_json::from_str(COMMITTED_DEFAULT_JSON).map_err(|err| {
                format!("Failed to parse the committed default load configuration: {err}")
            })?;

        Ok(Self {
            default_configuration,
            models: BTreeMap::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{DefaultModelLoadConfiguration, LoadConfigurationSettings, ModelLoadConfiguration};

    /// Returns the JSON form of the settings a settings file without the group
    /// is given.
    fn get_initial_settings_json() -> Value {
        let settings =
            LoadConfigurationSettings::create_initial().expect("a valid committed default");

        serde_json::to_value(settings).expect("settings that serialize")
    }

    #[test]
    fn initial_settings_hold_the_committed_default_and_no_model() {
        assert_eq!(
            get_initial_settings_json(),
            json!({
                "default": {
                    "contextLength": 8192,
                    "evalBatchSize": 512,
                    "flashAttention": true,
                    "offloadKVCacheToGpu": true
                },
                "models": {}
            })
        );
    }

    #[test]
    fn model_settings_keep_every_set_setting_under_its_wire_name() {
        let stored = json!({
            "contextLength": 16384,
            "evalBatchSize": 1024,
            "flashAttention": false,
            "offloadKVCacheToGpu": false,
            "numExperts": 4
        });

        let configuration: ModelLoadConfiguration =
            serde_json::from_value(stored.clone()).expect("valid model settings");

        assert_eq!(
            serde_json::to_value(configuration).expect("settings that serialize"),
            stored
        );
    }

    #[test]
    fn model_settings_leave_out_a_setting_that_is_not_set() {
        let configuration: ModelLoadConfiguration =
            serde_json::from_value(json!({ "contextLength": 4096 })).expect("valid model settings");

        assert_eq!(
            serde_json::to_value(configuration).expect("settings that serialize"),
            json!({ "contextLength": 4096 })
        );
    }

    #[test]
    fn model_settings_accept_the_whole_number_bounds() {
        for context_length in [1_u64, 4_294_967_295] {
            let stored = json!({ "contextLength": context_length });

            let configuration: Result<ModelLoadConfiguration, _> =
                serde_json::from_value(stored.clone());

            assert_eq!(
                serde_json::to_value(configuration.expect("a bound that is accepted"))
                    .expect("settings that serialize"),
                stored
            );
        }
    }

    #[test]
    fn model_settings_reject_values_outside_their_domain() {
        let rejected_settings = [
            json!({ "contextLength": 0 }),
            json!({ "contextLength": -1 }),
            json!({ "contextLength": 1.5 }),
            json!({ "contextLength": 4_294_967_296_u64 }),
            json!({ "contextLength": "8192" }),
            json!({ "contextLength": null }),
            json!({ "evalBatchSize": 0 }),
            json!({ "numExperts": 0 }),
            json!({ "flashAttention": "on" }),
            json!({ "flashAttention": null }),
            json!({ "offloadKVCacheToGpu": 1 }),
        ];

        for stored in rejected_settings {
            let configuration: Result<ModelLoadConfiguration, _> =
                serde_json::from_value(stored.clone());

            assert!(configuration.is_err(), "accepted {stored}");
        }
    }

    #[test]
    fn model_settings_reject_an_unknown_setting() {
        let rejected_settings = [
            json!({ "seed": 1 }),
            json!({ "offloadKvCacheToGpu": true }),
            json!({ "context_length": 8192 }),
        ];

        for stored in rejected_settings {
            let configuration: Result<ModelLoadConfiguration, _> =
                serde_json::from_value(stored.clone());

            assert!(configuration.is_err(), "accepted {stored}");
        }
    }

    #[test]
    fn default_settings_keep_an_expert_count_that_is_set() {
        let stored = json!({
            "contextLength": 4096,
            "evalBatchSize": 256,
            "flashAttention": false,
            "offloadKVCacheToGpu": false,
            "numExperts": 2
        });

        let configuration: DefaultModelLoadConfiguration =
            serde_json::from_value(stored.clone()).expect("valid default settings");

        assert_eq!(
            serde_json::to_value(configuration).expect("settings that serialize"),
            stored
        );
    }

    #[test]
    fn default_settings_reject_a_missing_required_setting() {
        for missing_setting in [
            "contextLength",
            "evalBatchSize",
            "flashAttention",
            "offloadKVCacheToGpu",
        ] {
            let mut stored = json!({
                "contextLength": 8192,
                "evalBatchSize": 512,
                "flashAttention": true,
                "offloadKVCacheToGpu": true
            });
            stored
                .as_object_mut()
                .expect("a JSON object")
                .remove(missing_setting);

            let configuration: Result<DefaultModelLoadConfiguration, _> =
                serde_json::from_value(stored);

            assert!(
                configuration.is_err(),
                "accepted a default without {missing_setting}"
            );
        }
    }

    #[test]
    fn default_settings_reject_an_unknown_or_null_setting() {
        for (setting, stored_setting) in [("seed", json!(1)), ("numExperts", Value::Null)] {
            let mut stored = json!({
                "contextLength": 8192,
                "evalBatchSize": 512,
                "flashAttention": true,
                "offloadKVCacheToGpu": true
            });
            stored
                .as_object_mut()
                .expect("a JSON object")
                .insert(setting.to_owned(), stored_setting);

            let configuration: Result<DefaultModelLoadConfiguration, _> =
                serde_json::from_value(stored);

            assert!(configuration.is_err(), "accepted a default with {setting}");
        }
    }

    #[test]
    fn group_rejects_a_missing_part_or_an_unknown_one() {
        let default_configuration = json!({
            "contextLength": 8192,
            "evalBatchSize": 512,
            "flashAttention": true,
            "offloadKVCacheToGpu": true
        });
        let rejected_groups = [
            json!({ "models": {} }),
            json!({ "default": default_configuration }),
            json!({ "default": default_configuration, "models": {}, "extra": true }),
            json!({ "default": default_configuration, "models": { "a/model": null } }),
        ];

        for stored in rejected_groups {
            let settings: Result<LoadConfigurationSettings, _> =
                serde_json::from_value(stored.clone());

            assert!(settings.is_err(), "accepted {stored}");
        }
    }

    #[test]
    fn group_stores_models_in_key_order() {
        let settings: LoadConfigurationSettings = serde_json::from_value(json!({
            "default": {
                "contextLength": 8192,
                "evalBatchSize": 512,
                "flashAttention": true,
                "offloadKVCacheToGpu": true
            },
            "models": {
                "zeta/model": { "contextLength": 4096 },
                "alpha/model": { "numExperts": 2 }
            }
        }))
        .expect("valid settings");

        let serialized = serde_json::to_string(&settings).expect("settings that serialize");

        let alpha_position = serialized.find("alpha/model").expect("the alpha entry");
        let zeta_position = serialized.find("zeta/model").expect("the zeta entry");
        assert!(
            alpha_position < zeta_position,
            "models are not in key order: {serialized}"
        );
    }
}
