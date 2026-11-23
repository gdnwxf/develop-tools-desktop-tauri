//! recent_store.rs -- “最近打开”独立存储（`~/.my_devops/recent_sites.json`）
//! 记录被打开过的页面（含动态页面），按打开时间倒序、同 URL 只留最新一条、最多 100 条、只看最近 7 天。
//! 与 devops_state.json 完全分开，避免互相覆盖；写入使用 tmp + rename 的原子替换。

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const VERSION: u64 = 2;
const MAX_ITEMS: usize = 100;
const RECENT_DAYS: i64 = 7;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub fn file_path(root: &Path) -> PathBuf {
    root.join("recent_sites.json")
}

fn now_ms() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp_nanos() as i64 / 1_000_000
}

fn key_of(url: &str, site_id: &str) -> String {
    let text = url.trim().to_lowercase();
    let trimmed = text.trim_end_matches('/').to_string();
    if trimmed.is_empty() { format!("id:{site_id}") } else { trimmed }
}

/// 读取：只返回最近 7 天内的记录，按打开时间倒序（最近的在第一个位置）
pub fn read(root: &Path) -> Vec<Value> {
    let path = file_path(root);
    let Ok(text) = fs::read_to_string(&path) else { return Vec::new() };
    let Ok(data) = serde_json::from_str::<Value>(&text) else {
        eprintln!("[recent] 读取失败，按空列表处理: {}", path.display());
        return Vec::new();
    };
    let cutoff = now_ms() - RECENT_DAYS * DAY_MS;
    let mut items: Vec<Value> = data["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item["siteId"].as_str().is_some())
        .filter(|item| item["ts"].as_i64().unwrap_or(0) >= cutoff)
        .collect();
    items.sort_by(|a, b| b["ts"].as_i64().unwrap_or(0).cmp(&a["ts"].as_i64().unwrap_or(0)));
    items.truncate(MAX_ITEMS);
    items
}

fn write(root: &Path, items: &[Value]) {
    let path = file_path(root);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let payload = json!({ "version": VERSION, "items": items });
    let temp = path.with_extension("json.tmp");
    match serde_json::to_vec_pretty(&payload) {
        Ok(bytes) => {
            if let Err(error) = fs::write(&temp, bytes) {
                eprintln!("[recent] 写入临时文件失败: {error}");
                return;
            }
            if let Err(error) = fs::rename(&temp, &path) {
                eprintln!("[recent] 替换文件失败: {error}");
            }
        }
        Err(error) => eprintln!("[recent] 序列化失败: {error}"),
    }
}

/// 记录一次打开：同 URL 只保留最新且排到第一个；克隆 tab 不记录
pub fn touch(root: &Path, site_id: &str, name: &str, url: &str, group_key: &str) -> Vec<Value> {
    let id = site_id.trim();
    if id.is_empty() || id.starts_with("copy-") {
        return read(root);
    }
    let key = key_of(url, id);
    let mut items: Vec<Value> = read(root)
        .into_iter()
        .filter(|item| {
            let item_url = item["url"].as_str().unwrap_or("");
            let item_id = item["siteId"].as_str().unwrap_or("");
            key_of(item_url, item_id) != key
        })
        .collect();
    items.insert(0, json!({
        "siteId": id,
        "name": name,
        "url": url,
        "groupKey": group_key,
        "ts": now_ms(),
    }));
    items.truncate(MAX_ITEMS);
    write(root, &items);
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("devops-recent-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn newest_open_comes_first_and_same_url_is_deduped() {
        let root = temp_root("order");
        touch(&root, "a-0", "A", "https://a.test/", "db");
        touch(&root, "b-0", "B", "https://b.test/", "db");
        let items = touch(&root, "a-0", "A", "https://a.test", "db"); // 同 URL（尾斜杠不同）重复打开
        assert_eq!(items[0]["siteId"], "a-0", "最近打开的排在第一");
        assert_eq!(items.len(), 2, "同 URL 去重");
        let ids: Vec<&str> = items.iter().map(|i| i["siteId"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a-0", "b-0"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clone_tabs_are_not_recorded_and_window_filters_old_entries() {
        let root = temp_root("filter");
        touch(&root, "copy-1", "复制", "https://a.test/", "db");
        assert!(read(&root).is_empty(), "克隆 tab 不记录");
        touch(&root, "a-0", "A", "https://a.test/", "db");
        // 手工塞一条 8 天前的记录，读取时应被过滤
        let path = file_path(&root);
        let mut data: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        data["items"].as_array_mut().unwrap().push(json!({
            "siteId": "old-0", "name": "old", "url": "https://old.test/", "groupKey": "db",
            "ts": now_ms() - 8 * DAY_MS,
        }));
        fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        let items = read(&root);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["siteId"], "a-0");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_is_capped_and_dynamic_pages_are_recorded() {
        let root = temp_root("cap");
        for index in 0..(MAX_ITEMS + 5) {
            touch(&root, &format!("s-{index}"), "S", &format!("https://s{index}.test/"), "db");
        }
        touch(&root, "page-dyn-1", "x.test", "https://x.test/", "page");
        let items = read(&root);
        assert_eq!(items.len(), MAX_ITEMS, "最多保留 {MAX_ITEMS} 条");
        assert_eq!(items[0]["siteId"], "page-dyn-1", "动态页面也记录并排最前");
        assert_eq!(items[0]["groupKey"], "page");
        let _ = fs::remove_dir_all(&root);
    }
}
