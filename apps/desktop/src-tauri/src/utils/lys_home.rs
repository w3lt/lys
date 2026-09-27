use std::{
    env::VarError,
    path::{Path, PathBuf},
};

pub struct LysHome(PathBuf);

impl LysHome {
    pub fn resolve() -> Result<Self, String> {
        match Self::from_env()? {
            Some(home) => Ok(home),
            None => Self::default_dir(),
        }
    }

    fn default_dir() -> Result<Self, String> {
        Ok(Self(
            std::env::home_dir()
                .ok_or("Could not determine the home directory")?
                .join(".lys"),
        ))
    }

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

    pub fn as_path(&self) -> &Path {
        &self.0
    }
}
