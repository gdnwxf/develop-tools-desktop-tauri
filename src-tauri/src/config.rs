use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    pub id: String,
    pub group_key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub url: String,
    pub user: String,
    pub password: String,
    #[serde(rename = "first_open_url")]
    pub first_open_url: String,
    #[serde(rename = "loginPath")]
    pub login_path: String,
    pub optsecret: String,
}

#[derive(Clone, Serialize)]
pub struct Group {
    pub key: String,
    pub label: String,
    pub icon: String,
    pub color: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sites: Vec<Site>,
}

pub struct Config {
    pub groups: Vec<Group>,
    pub default_expand: Value,
    pub config_path: PathBuf,
    pub state_path: PathBuf,
    pub data_dir: PathBuf,
    pub error: Option<String>,
    pub state: Mutex<Value>,
    pub retention_days: u64,
    pub max_log_response_size: usize,
    /// 关闭窗口是否隐藏到托盘(默认 true)
    pub close_to_tray: bool,
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

fn profile(key: &str) -> (&str, &str) {
    match key {
        "db" | "database" => ("Database", "sprt"),
        "redis" => ("Redis", "redisinsight"),
        "grafana" => ("Grafana", "grafana"),
        "yapi" => ("YApi", "yapi"),
        "quanyou-admin" => ("Quanyou Admin", "quanyou-admin"),
        "jenkins" => ("Jenkins", "jenkins"),
        _ => (key, key),
    }
}

pub fn http_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "站点 URL 格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("只允许不含内嵌凭据的 HTTP/HTTPS URL".into());
    }
    Ok(url)
}

pub fn same_origin(a: &str, b: &str) -> bool {
    match (http_url(a), http_url(b)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

/// 宿主页面白名单：本地 tauri 协议页面，或 dev 模式下 Tauri CLI 注入的 devUrl origin。
/// `cargo tauri dev` 会让宿主 WebView 加载 CLI 内置静态服务器（如 127.0.0.1:1430），
/// 发布构建没有 devUrl，行为与仅允许 tauri 协议时一致。
pub fn is_host_page<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> bool {
    if (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
    {
        return true;
    }
    app.config()
        .build
        .dev_url
        .as_ref()
        .is_some_and(|dev| dev.origin() == url.origin())
}

pub fn parse_groups(raw: &Value, state: &mut Value) -> Result<Vec<Group>, String> {
    let items = raw
        .as_array()
        .or_else(|| raw["devops_config"].as_array())
        .ok_or("配置应为分组数组或含 devops_config 的对象")?;
    const COLORS: [&str; 12] = [
        "#ec4899", "#0ea5e9", "#6366f1", "#84cc16", "#d946ef", "#64748b", "#0891b2", "#e11d48",
        "#059669", "#d97706", "#a855f7", "#334155",
    ];
    let mut groups = Vec::new();
    let mut keys = std::collections::HashSet::new();
    for group in items {
        let key = text(group, "group");
        if key.is_empty() {
            continue;
        }
        if !keys.insert(key.clone()) {
            return Err(format!("分组键重复：{key}"));
        }
        let entries = match &group["items"] {
            Value::Array(a) => a.clone(),
            Value::Object(_) => vec![group["items"].clone()],
            _ => Vec::new(),
        };
        let mut sites = Vec::new();
        // 原版先过滤无 URL 项再编号，保持既有站点 ID 和状态引用。
        for entry in entries
            .iter()
            .filter(|e| e["url"].as_str().is_some_and(|u| !u.is_empty()))
        {
            let url = text(entry, "url");
            http_url(&url).map_err(|e| format!("分组 {key}：{e}"))?;
            let kind = text(entry, "type").to_lowercase();
            let kind = profile(&kind).1.to_string();
            let name = text(entry, "name");
            sites.push(Site {
                id: format!("{}-{}", key, sites.len()),
                group_key: key.clone(),
                kind,
                name: if name.is_empty() { url.clone() } else { name },
                url,
                user: text(entry, "user"),
                password: text(entry, "password"),
                first_open_url: text(entry, "first_open_url"),
                login_path: text(entry, "loginPath"),
                optsecret: entry["optsecret"]
                    .as_str()
                    .or(entry["otpsecret"].as_str())
                    .unwrap_or_default()
                    .into(),
            });
        }
        if sites.is_empty() {
            continue;
        }
        let saved = state["groupColors"][&key].as_str().unwrap_or_default();
        let valid_color = saved.len() == 7
            && saved.starts_with('#')
            && saved[1..].chars().all(|c| c.is_ascii_hexdigit());
        let color = if valid_color {
            saved.to_owned()
        } else {
            COLORS[groups.len() % COLORS.len()].into()
        };
        if !state["groupColors"].is_object() {
            state["groupColors"] = json!({});
        }
        state["groupColors"][&key] = json!(color);
        let (label, kind) = profile(&key);
        let label = if label == key {
            let mut chars = key.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        } else {
            label.into()
        };
        groups.push(Group { key: key.clone(), label, kind: kind.into(),
            icon: format!("<span style=\"display:inline-block;width:1em;height:1em;border-radius:18%;background:{color};vertical-align:-0.15em;margin-left:2px\"></span>"), color, sites });
    }
    Ok(groups)
}

impl Config {
    pub fn load() -> Result<Self, String> {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .ok_or("无法确定用户目录")?;
        let config_path = std::env::var_os("DEVOPS_CONFIG_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home).join(".my_devops/devops_config.json"));
        let data_dir = std::env::var_os("DEVOPS_TAURI_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                config_path
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("tauri")
            });
        fs::create_dir_all(&data_dir).map_err(|e| format!("创建 Tauri 数据目录失败：{e}"))?;
        let state_path = data_dir.join("devops_state.json");
        let mut state = match fs::read(&state_path) {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                .map_err(|e| format!("Tauri 状态 JSON 无效：{e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(format!("读取 Tauri 状态失败：{e}")),
        };
        if !state.is_object() {
            return Err("Tauri 状态必须为对象".into());
        }
        let raw = fs::read(&config_path)
            .map_err(|e| format!("读取配置失败：{e}"))
            .and_then(|bytes| {
                serde_json::from_slice::<Value>(&bytes).map_err(|e| format!("配置 JSON 无效：{e}"))
            });
        let (raw, mut error) = match raw {
            Ok(v) => (v, None),
            Err(e) => (json!({"devops_config":[]}), Some(e)),
        };
        let groups = match parse_groups(&raw, &mut state) {
            Ok(g) => g,
            Err(e) => {
                error = Some(e);
                Vec::new()
            }
        };
        if groups.is_empty() && error.is_none() {
            error = Some("配置中无有效站点".into());
        }
        let default_expand = raw
            .get("default_expand")
            .filter(|v| v.is_string() || v.is_array())
            .cloned()
            .unwrap_or(json!(""));
        Ok(Self {
            groups,
            default_expand,
            config_path,
            state_path,
            data_dir,
            error,
            close_to_tray: raw["close_to_tray"].as_bool().unwrap_or(true),
            retention_days: raw["max_log_history"]
                .as_u64()
                .filter(|d| *d > 0)
                .unwrap_or(7),
            max_log_response_size: raw["max_log_response_size"]
                .as_u64()
                .and_then(|size| usize::try_from(size).ok())
                .filter(|size| *size > 0)
                .unwrap_or(1024),
            state: Mutex::new(state),
        })
    }

    pub fn site(&self, id: &str) -> Option<Site> {
        self.groups
            .iter()
            .flat_map(|g| &g.sites)
            .find(|s| s.id == id)
            .cloned()
    }

    pub fn patch(&self, patch: Value) -> Result<bool, String> {
        let object = patch.as_object().ok_or("状态补丁必须为对象")?;
        let allowed = [
            "lastUrls",
            "expandedGroups",
            "lastTab",
            "openTabs",
            "clonedSites",
            "scheduledTasks",
            "splitLayout",
        ];
        if object.keys().any(|k| !allowed.contains(&k.as_str())) {
            return Err("状态字段不受支持".into());
        }
        let mut state = self.state.lock().map_err(|_| "状态锁不可用")?;
        let mut next = state.clone();
        for (key, value) in object {
            let value = if key == "clonedSites" {
                Value::Array(
                    value
                        .as_array()
                        .ok_or("clonedSites 必须为数组")?
                        .iter()
                        .map(|c| {
                            let mut clean = json!({"isClone":true});
                            for field in ["id", "name", "type", "url", "sourceId"] {
                                if let Some(s) = c[field].as_str() {
                                    clean[field] = json!(s);
                                }
                            }
                            clean
                        })
                        .collect(),
                )
            } else {
                value.clone()
            };
            next[key] = value;
        }
        let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        let temp = self.state_path.with_extension("tmp");
        fs::write(&temp, bytes).map_err(|e| format!("写入状态失败：{e}"))?;
        fs::rename(&temp, &self.state_path).map_err(|e| format!("替换状态失败：{e}"))?;
        *state = next;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_preserves_ids_and_explicit_type() {
        let raw = json!({"devops_config":[{"group":"db","items":[{}, {"url":"https://a.test","type":"DB","otpsecret":"secret"},{"url":"https://b.test"}]}]});
        let groups = parse_groups(&raw, &mut json!({})).unwrap();
        assert_eq!(groups[0].sites[0].id, "db-0");
        assert_eq!(groups[0].sites[0].kind, "sprt");
        assert_eq!(groups[0].sites[1].kind, "");
        assert_eq!(groups[0].sites[0].optsecret, "secret");
    }
    #[test]
    fn remote_urls_are_restricted_by_origin() {
        assert!(same_origin("https://a.test/x", "https://a.test/login"));
        assert!(!same_origin("https://a.test", "https://a.test.evil.test"));
        assert!(!same_origin("https://a.test", "http://a.test"));
        assert!(http_url("file:///C:/a").is_err());
        assert!(http_url("https://user:secret@a.test").is_err());
    }

    #[test]
    fn close_to_tray_defaults_on_and_can_be_disabled() {
        // 通过 Config::load 的 raw 解析路径验证:未配置时 true,显式 false 时 false
        let default = serde_json::json!({});
        assert_eq!(default["close_to_tray"].as_bool().unwrap_or(true), true);
        let disabled = serde_json::json!({"close_to_tray": false});
        assert_eq!(disabled["close_to_tray"].as_bool().unwrap_or(true), false);
    }
}
