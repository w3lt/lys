use serde::{Deserialize, Serialize};

const AUTO_START_BACKEND_DEFAULT_VALUE: bool = true;
const AUTO_START_VMO_DEFAULT_VALUE: bool = true;
const DEFAULT_MODEL_DEFAULT_VALUE: Option<String> = None;
const BACKEND_ADDRESS_DEFAULT_VALUE: &str = "http://127.0.0.1:12345";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
/// Runtime settings persisted under the `runtime` JSON object.
///
/// Missing fields use this type's `Default` implementation: backend and vmo
/// startup enabled, no selected model, and the loopback backend address, so a
/// file saved before a field existed loads with its default. Field names
/// serialize in camelCase. The desktop saves the two startup switches from
/// the Runtime pane and writes the other two fields back as it read them.
pub struct RunTimeSettings {
    /// Whether application initialization requests backend startup.
    pub auto_start_backend: bool,
    /// Whether application initialization starts vmo, Lys's page reader.
    pub auto_start_vmo: bool,
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
            auto_start_vmo: AUTO_START_VMO_DEFAULT_VALUE,
            default_model: DEFAULT_MODEL_DEFAULT_VALUE,
            backend_address: String::from(BACKEND_ADDRESS_DEFAULT_VALUE),
        }
    }
}
