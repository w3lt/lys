//! Load settings stored under the `loadConfiguration` settings group.
//!
//! The group holds one default and, per model key, the settings a person
//! changed for that model. Both hold only the settings written to the
//! settings file. The desktop renderer resolves the settings of one load from
//! them and from the committed default, and sends them with the load request;
//! this module only stores them. The accepted values match the load request's
//! contract: whole numbers from 1 to 4,294,967,295, and booleans.

use std::{collections::BTreeMap, num::NonZeroU32};

use serde::{Deserialize, Deserializer, Serialize};

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
fn parse_present_setting<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// Load settings written to the settings file, for one model or as the
/// default for every model.
///
/// Every setting is optional. A setting that is absent is left out of the
/// serialized object, and the renderer supplies it from the next layer when a
/// model is loaded. Unknown settings and `null` are rejected.
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

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
/// Load settings persisted under the `loadConfiguration` JSON object.
///
/// A missing part is empty, and so is a missing group, which a settings file
/// written before load settings existed lacks. Neither part may be `null`.
/// Model keys are stored in ascending order, so that saving unchanged
/// settings rewrites the same text.
pub struct LoadConfigurationSettings {
    /// Settings for every model that has none of its own, in the `default`
    /// object. Empty unless a person writes settings into it; the committed
    /// default is never copied here.
    #[serde(rename = "default")]
    default_configuration: ModelLoadConfiguration,
    /// Settings each model has of its own, keyed by the model's key.
    models: BTreeMap<String, ModelLoadConfiguration>,
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{LoadConfigurationSettings, ModelLoadConfiguration};

    /// Returns the JSON form of `settings`.
    fn get_settings_json(settings: &LoadConfigurationSettings) -> Value {
        serde_json::to_value(settings).expect("settings that serialize")
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
    fn group_reads_a_missing_part_as_empty() {
        let read_groups = [
            (json!({}), json!({ "default": {}, "models": {} })),
            (
                json!({ "models": { "a/model": { "contextLength": 4096 } } }),
                json!({ "default": {}, "models": { "a/model": { "contextLength": 4096 } } }),
            ),
            (
                json!({ "default": { "flashAttention": false } }),
                json!({ "default": { "flashAttention": false }, "models": {} }),
            ),
        ];

        for (stored, expected) in read_groups {
            let settings: LoadConfigurationSettings =
                serde_json::from_value(stored.clone()).expect("a valid group");

            assert_eq!(get_settings_json(&settings), expected, "read {stored}");
        }
    }

    #[test]
    fn empty_group_is_the_group_default() {
        assert_eq!(
            get_settings_json(&LoadConfigurationSettings::default()),
            json!({ "default": {}, "models": {} })
        );
    }

    #[test]
    fn group_keeps_every_setting_of_the_default() {
        let stored = json!({
            "default": {
                "contextLength": 4096,
                "evalBatchSize": 256,
                "flashAttention": false,
                "offloadKVCacheToGpu": false,
                "numExperts": 2
            },
            "models": {}
        });

        let settings: LoadConfigurationSettings =
            serde_json::from_value(stored.clone()).expect("a valid group");

        assert_eq!(get_settings_json(&settings), stored);
    }

    #[test]
    fn group_rejects_an_unknown_or_null_part_or_setting() {
        let rejected_groups = [
            json!({ "extra": true }),
            json!({ "default": null }),
            json!({ "models": null }),
            json!({ "models": { "a/model": null } }),
            json!({ "default": { "seed": 1 } }),
            json!({ "default": { "numExperts": null } }),
            json!({ "default": { "contextLength": 0 } }),
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
            "default": {},
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
