pub mod lys_home;

use std::path::PathBuf;

use crate::utils::lys_home::LysHome;

pub fn get_prod_runtime_dir() -> Result<PathBuf, String> {
    Ok(LysHome::resolve()?.as_path().join("runtime"))
}

pub fn get_node_executable_path() -> Result<PathBuf, String> {
    Ok(get_prod_runtime_dir()?.join("node/bin/node"))
}

pub fn get_backend_script_path() -> Result<PathBuf, String> {
    Ok(get_prod_runtime_dir()?.join("backend/dist/backend.mjs"))
}

pub fn get_settings_path() -> Result<PathBuf, String> {
    Ok(LysHome::resolve()?.as_path().join("settings.json"))
}
