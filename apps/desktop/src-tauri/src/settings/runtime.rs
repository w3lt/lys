use serde::{Deserialize, Serialize};

const AUTO_START_BACKEND_DEFAULT_VALUE: bool = true;
const DEFAULT_MODEL_DEFAULT_VALUE: Option<String> = None;
const BACKEND_ADDRESS_DEFAULT_VALUE: &str = "http://127.0.0.1:12345";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
/// Runtime settings persisted under the `runtime` JSON object.
///
/// Missing fields use this type's `Default` implementation: backend startup
/// enabled, no selected model, and the loopback backend address. Field names
/// serialize in camelCase; runtime edits in the desktop UI remain session-only.
pub struct RunTimeSettings {
    /// Whether application initialization requests backend startup.
    pub auto_start_backend: bool,
    /// Optional default-model selection; selecting it does not load weights.
    pub default_model: Option<String>,
    /// Backend address shown in runtime settings; HTTP consumers use shared
    /// protocol constants.
    pub backend_address: String,
}

impl Default for RunTimeSettings {
    fn default() -> Self {
        Self {
            auto_start_backend: AUTO_START_BACKEND_DEFAULT_VALUE,
            default_model: DEFAULT_MODEL_DEFAULT_VALUE,
            backend_address: String::from(BACKEND_ADDRESS_DEFAULT_VALUE),
        }
    }
}
