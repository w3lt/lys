//! Resolution of the Lys home directory from the `LYS_HOME` environment
//! variable, and the locations the desktop host derives from it.

use std::{
    env::VarError,
    path::{Path, PathBuf},
};

/// Lys home directory: the root for the desktop settings file, the backend's
/// conversation database, and the runtime that release builds start.
///
/// Values are created only by [`LysHome::resolve`]. The directory is not
/// created or required to exist, and the derived paths below are computed
/// without touching the filesystem.
pub struct LysHome(PathBuf);

impl LysHome {
    /// Resolves the Lys home from the `LYS_HOME` environment variable.
    ///
    /// An unset or empty `LYS_HOME` selects `.lys` under the current user's home
    /// directory. Any other value must be an absolute path and is used as given;
    /// a leading `~` is not expanded. Each call reads the current process
    /// environment.
    ///
    /// # Errors
    ///
    /// Returns an error when `LYS_HOME` is a relative path or is not valid
    /// UTF-8, or when it is unset or empty and the home directory cannot be
    /// determined.
    pub fn resolve() -> Result<Self, String> {
        match Self::from_env()? {
            Some(home) => Ok(home),
            None => Self::default_dir(),
        }
    }

    /// Returns `.lys` under the current user's home directory, the Lys home used
    /// when `LYS_HOME` is unset or empty.
    ///
    /// # Errors
    ///
    /// Returns an error when the operating system cannot determine the home
    /// directory.
    fn default_dir() -> Result<Self, String> {
        Ok(Self(
            std::env::home_dir()
                .ok_or("Could not determine the home directory")?
                .join(".lys"),
        ))
    }

    /// Reads and validates an explicit `LYS_HOME` value.
    ///
    /// Returns `Ok(None)` when the variable is unset or empty, leaving the
    /// default to the caller, and `Ok(Some(_))` for an absolute path.
    ///
    /// # Errors
    ///
    /// Returns an error when the value is a relative path, including one that
    /// starts with an unexpanded `~`, or is not valid UTF-8.
    fn from_env() -> Result<Option<Self>, String> {
        match std::env::var("LYS_HOME") {
            Ok(value) if !value.is_empty() => {
                let path = PathBuf::from(value);
                if path.is_absolute() {
                    Ok(Some(Self(path)))
                } else {
                    Err(format!("LYS_HOME must be an absolute path, got {path:?}"))
                }
            }
            Ok(_) | Err(VarError::NotPresent) => Ok(None),
            Err(VarError::NotUnicode(_)) => Err(String::from("LYS_HOME is not valid UTF-8")),
        }
    }

    /// Returns the resolved Lys home directory, for example to pass to the
    /// backend process as `LYS_HOME`.
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    /// Returns the `runtime` directory that holds the Node.js runtime and
    /// backend bundle started by release builds.
    ///
    /// `build.sh` installs the release runtime into this directory; the paths
    /// derived from it must stay in step with that installer's layout.
    pub fn prod_runtime_dir(&self) -> PathBuf {
        self.0.join("runtime")
    }

    /// Returns the Node.js executable that release builds use to run the
    /// backend, `runtime/node/bin/node` under the Lys home.
    pub fn node_executable_path(&self) -> PathBuf {
        self.prod_runtime_dir().join("node/bin/node")
    }

    /// Returns the backend bundle that release builds pass to Node.js,
    /// `runtime/backend/backend.mjs` under the Lys home.
    pub fn backend_script_path(&self) -> PathBuf {
        self.prod_runtime_dir().join("backend/backend.mjs")
    }

    /// Returns the desktop settings file, `settings.json` under the Lys home.
    pub fn settings_path(&self) -> PathBuf {
        self.0.join("settings.json")
    }
}
