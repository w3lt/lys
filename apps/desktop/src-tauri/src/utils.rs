use std::path::PathBuf;

pub fn get_default_lys_home_dir() -> Result<PathBuf, String> {
    Ok(std::env::home_dir()
        .ok_or("Could not determine the home directory")?
        .join(".lys"))
}

pub fn get_lys_home_dir() -> Result<PathBuf, String> {
    match std::env::var("LYS_HOME").map_err(|err| err.to_string()) {
        Ok(env_value) => Ok(PathBuf::from(env_value)),
        Err(_) => get_default_lys_home_dir(),
    }
}

pub fn get_prod_runtime_dir() -> Result<PathBuf, String> {
    Ok(get_lys_home_dir()?.join("runtime"))
}

pub fn get_node_executable_path() -> Result<PathBuf, String> {
    Ok(get_prod_runtime_dir()?.join("node/bin/node"))
}

pub fn get_backend_script_path() -> Result<PathBuf, String> {
    Ok(get_prod_runtime_dir()?.join("backend/dist/backend.mjs"))
}
