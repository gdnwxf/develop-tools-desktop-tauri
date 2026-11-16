use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn session_path(root: &Path, label: &str) -> Result<PathBuf, String> {
    if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("日志标签无效".into());
    }
    let dir = root.join("logs").join(label);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("requests.log"))
}

pub fn sanitized_url(value: &str) -> String {
    match tauri::Url::parse(value) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => "[invalid-url]".into(),
    }
}

pub fn append(path: &Path, event: serde_json::Value) -> Result<(), String> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&json!({"ts":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis(),"event":event})).map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

pub fn cleanup(root: &Path, retention_days: u64) -> Result<usize, String> {
    let dir = root.join("logs");
    if !dir.exists() {
        return Ok(0);
    }
    let cutoff = retention_days.saturating_mul(86_400);
    let mut removed = 0;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let file = entry.path().join("requests.log");
        if file.exists()
            && file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|d| d.as_secs() > cutoff)
        {
            fs::remove_file(file).map_err(|e| e.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

pub fn clear_all(root: &Path) -> Result<usize, String> {
    let logs = root.join("logs");
    if !logs.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in fs::read_dir(logs).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let file = entry.path().join("requests.log");
        if file.is_file() {
            fs::write(&file, []).map_err(|e| e.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logs_drop_credentials_and_query() {
        assert_eq!(
            sanitized_url("https://user:pass@a.test/x?token=secret#secret"),
            "https://a.test/x"
        );
    }
}
