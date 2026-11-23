use serde_json::{json, Value};
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

/// 目录名清洗：只保留 ascii 字母数字与 - _ .，长度上限 64，避免路径逃逸与奇怪字符。
fn sanitize_dir_name(value: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in value.trim().chars().take(64) {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches(|c| c == '_' || c == '.').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

/// 站点级日志路径：`logs/<group>/<site>/requests.log`（打开新页面等动态站点用，
/// 与按 webview 标签分目录的 [`session_path`] 区分）。
pub fn site_session_path(root: &Path, group: &str, site: &str) -> Result<PathBuf, String> {
    let dir = root
        .join("logs")
        .join(sanitize_dir_name(group, "unknown"))
        .join(sanitize_dir_name(site, "unknown"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("requests.log"))
}

/// 接口调试输出目录：`logs/api-tool/<group>/<site>/requests.log`
pub fn tool_session_path(root: &Path, group: &str, site: &str) -> Result<PathBuf, String> {
    let dir = root
        .join("logs")
        .join("api-tool")
        .join(sanitize_dir_name(group, "unknown"))
        .join(sanitize_dir_name(site, "unknown"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("requests.log"))
}

/// 读取日志文件内容，供渲染层“复制日志文件”使用。
/// 超过 `max_bytes` 时只返回尾部（最新内容），并用 truncated 标记。
pub fn read_tail(path: &Path, max_bytes: u64) -> Result<(String, bool, u64), String> {
    let meta = fs::metadata(path).map_err(|e| format!("日志文件不可读: {e}"))?;
    let size = meta.len();
    let limit = if max_bytes == 0 { 2 * 1024 * 1024 } else { max_bytes };
    if size <= limit {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        return Ok((text, false, size));
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(size - limit)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(limit as usize);
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok((String::from_utf8_lossy(&buf).into_owned(), true, size))
}

const LIST_EVENTS: [&str; 4] = ["completed", "error", "timeout", "cancelled"];

/// 读取某个日志目录里的请求列表：只要完成/失败终态、过滤 OPTIONS、支持关键字、时间倒序。
pub fn list_requests(log_dir: &Path, keyword: &str, limit: usize) -> serde_json::Value {
    let file = log_dir.join("requests.log");
    let Ok(text) = fs::read_to_string(&file) else {
        return json!({"items": [], "total": 0});
    };
    let needle = keyword.trim().to_lowercase();
    let mut items: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for line in text.lines().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let event = &record["event"];
        let kind = event["event"].as_str().unwrap_or_default();
        if !LIST_EVENTS.contains(&kind) {
            continue;
        }
        let method = event["method"].as_str().unwrap_or("GET").to_ascii_uppercase();
        if method == "OPTIONS" {
            continue;
        }
        let url = event["url"].as_str().unwrap_or_default();
        if url.is_empty() {
            continue;
        }
        if !needle.is_empty() {
            let hay = format!(
                "{} {} {}",
                method,
                url,
                event["requestBody"].as_str().unwrap_or_default()
            )
            .to_lowercase();
            if !hay.contains(&needle) {
                continue;
            }
        }
        total += 1;
        if items.len() >= limit {
            continue;
        }
        items.push(json!({
            "time": record["ts"].as_u64().unwrap_or_default(),
            "method": method,
            "url": url,
            "requestHeaders": event["requestHeaders"].clone(),
            "statusCode": event["statusCode"].clone(),
            "durationMs": event["durationMs"].clone(),
            "error": event["error"].clone(),
        }));
    }
    json!({"items": items, "total": total})
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
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let line =
        serde_json::to_string(&json!({"ts": ts, "event": event})).map_err(|e| e.to_string())?;
    // 入队即返回；真正的文件 IO 与 flush 在后台写入线程完成。
    crate::log_writer::append(path, line)
}

pub fn cleanup(root: &Path, retention_days: u64) -> Result<usize, String> {
    let dir = root.join("logs");
    if !dir.exists() {
        return Ok(0);
    }
    let cutoff = retention_days.saturating_mul(86_400);
    let mut removed = 0;
    cleanup_dir(&dir, cutoff, &mut removed, 0)?;
    Ok(removed)
}

/// 递归清理过期日志；深度上限防止异常目录结构导致过深遍历。
fn cleanup_dir(dir: &Path, cutoff: u64, removed: &mut usize, depth: usize) -> Result<(), String> {
    if depth > 4 {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let child = entry.path();
        cleanup_dir(&child, cutoff, removed, depth + 1)?;
        let file = child.join("requests.log");
        if file.exists()
            && file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|d| d.as_secs() > cutoff)
        {
            fs::remove_file(&file).map_err(|e| e.to_string())?;
            *removed += 1;
        }
    }
    Ok(())
}

pub fn clear_all(root: &Path) -> Result<usize, String> {
    crate::log_writer::clear_all(root)
}

pub fn clear_path(path: &Path) -> Result<(), String> {
    crate::log_writer::clear_path(path)
}

pub fn shutdown() {
    crate::log_writer::shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_log_dirs_are_two_levels_and_sanitized() {
        let root = std::env::temp_dir().join(format!("devops-site-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = site_session_path(&root, "page", "admin.test").unwrap();
        assert_eq!(path, root.join("logs").join("page").join("admin.test").join("requests.log"));
        assert!(path.parent().unwrap().exists(), "目录应被创建");
        // 路径逃逸/奇怪字符被清洗:结果必须仍在 logs 下,且不含 . / .. 之类的路径段
        let escaped = site_session_path(&root, "../evil", "a/../../b c").unwrap();
        let relative = escaped.strip_prefix(&root).unwrap();
        for component in relative.components() {
            match component {
                std::path::Component::Normal(name) => {
                    assert!(name != ".." && name != ".", "出现了越权路径段: {name:?}");
                }
                other => panic!("出现了非普通路径段: {other:?}"),
            }
        }
        let text = escaped.to_string_lossy().to_string();
        assert!(text.starts_with(&root.join("logs").to_string_lossy().to_string()));
        assert!(text.contains("a_.._.._b_c"), "slash/空格被替换为下划线: {text}");
        // 全点号的名字退化为 unknown
        let dotted = site_session_path(&root, "..", "...").unwrap();
        assert!(dotted.to_string_lossy().contains("unknown"));
        // 空值回退
        let fallback = site_session_path(&root, "", "  ").unwrap();
        assert!(fallback.to_string_lossy().contains("unknown"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_removes_expired_logs_in_nested_site_dirs() {
        let root = std::env::temp_dir().join(format!("devops-cleanup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let nested = root.join("logs").join("page").join("admin.test");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("requests.log");
        fs::write(&file, "x").unwrap();
        // 把 mtime 设为很早：用 retention_days = 0 即可判定过期(now - 0 > 0)
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let removed = cleanup(&root, 0).unwrap();
        assert_eq!(removed, 1, "嵌套站点目录里的过期日志也要清理");
        assert!(!file.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn logs_drop_credentials_and_query() {
        assert_eq!(
            sanitized_url("https://user:pass@a.test/x?token=secret#secret"),
            "https://a.test/x"
        );
    }

    #[test]
    fn request_list_filters_options_and_orders_newest_first() {
        let root = std::env::temp_dir().join(format!("devops-api-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("requests.log");
        let lines = vec![
            json!({"ts":1,"event":{"event":"completed","method":"OPTIONS","url":"https://a.test/preflight"}}),
            json!({"ts":2,"event":{"event":"completed","method":"GET","url":"https://a.test/api/one","statusCode":200,"requestHeaders":{"X-Trace":"1"}}}),
            json!({"ts":3,"event":{"event":"completed","method":"POST","url":"https://a.test/api/login","statusCode":200}}),
            json!({"ts":4,"event":{"event":"request","method":"GET","url":"https://a.test/api/pending"}}),
        ];
        let text: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        fs::write(&file, text.join("\n") + "\n").unwrap();

        let all = list_requests(&root, "", 10);
        let items = all["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "只保留终态且过滤 OPTIONS");
        assert_eq!(items[0]["url"], "https://a.test/api/login", "时间倒序");
        assert_eq!(items[1]["url"], "https://a.test/api/one");
        assert_eq!(items[1]["requestHeaders"]["X-Trace"], "1");
        assert_eq!(all["total"], 2);

        let filtered = list_requests(&root, "login", 10);
        assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
        assert_eq!(list_requests(&root, "zzz", 10)["items"].as_array().unwrap().len(), 0);
        assert_eq!(list_requests(&root, "", 1)["items"].as_array().unwrap().len(), 1, "limit 生效");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tool_session_path_nests_under_api_tool() {
        let root = std::env::temp_dir().join(format!("devops-api-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let path = tool_session_path(&root, "db", "Example").unwrap();
        assert_eq!(path, root.join("logs").join("api-tool").join("db").join("Example").join("requests.log"));
        let _ = fs::remove_dir_all(&root);
    }
}
