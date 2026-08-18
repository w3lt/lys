use std::{fs, path::Path};

pub fn read_text_file(file_path: &Path) -> Result<String, String> {
    let content =
        fs::read_to_string(file_path).map_err(|err| format!("Error reading file {err}"))?;

    Ok(content)
}
