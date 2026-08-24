use serde::{Deserialize, Serialize};

const CONTEXT_SIZE_DEFAULT_VALUE: u32 = 32_768;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelSettings {
    /// Context-window size in tokens, defaulting to zero.
    pub context_size: u32,
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            context_size: CONTEXT_SIZE_DEFAULT_VALUE,
        }
    }
}
