//! scheduler.rs -- 定时任务:按 cron 触发 GET 请求,输出写到单独的任务目录(类似日志)。
//! 任务定义存在 devops_state.json 的 scheduledTasks(不代写用户维护的 devops_config.json)。
//! 请求在隐藏的原生 WebView 中发起,复用同一 WebView2 用户数据目录的登录态。
//! 输出:~/.my_devops/tasks/<group>/<site>/requests.log

use crate::{config::Config, cron, request_log};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const MAX_TASKS: usize = 200;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

fn sanitize_dir_name(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .take(64)
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' { ch } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '_' || c == '.').to_string();
    if trimmed.is_empty() { fallback.to_string() } else { trimmed }
}

/// 任务输出目录:`tasks/<group>/<site>/`
pub fn task_dir(root: &Path, group: &str, site: &str) -> PathBuf {
    root.join("tasks")
        .join(sanitize_dir_name(group, "unknown"))
        .join(sanitize_dir_name(site, "unknown"))
}

/// 校验并规范化任务;非法输入返回可读错误。
pub fn normalize(raw: &Value, existing_id: Option<&str>) -> Result<Value, String> {
    let name = raw["name"].as_str().unwrap_or_default().trim();
    if name.is_empty() {
        return Err("任务名称不能为空".into());
    }
    if name.chars().count() > 60 {
        return Err("任务名称不能超过 60 个字符".into());
    }
    let expression = raw["cron"].as_str().unwrap_or_default().trim();
    cron::parse(expression)?;
    let group_key = raw["groupKey"].as_str().unwrap_or_default().trim();
    if group_key.is_empty() {
        return Err("请选择分组".into());
    }
    let site_name = raw["siteName"].as_str().unwrap_or_default().trim();
    if site_name.is_empty() {
        return Err("请选择站点".into());
    }
    let url = raw["url"].as_str().unwrap_or_default().trim();
    crate::config::http_url(url)?;
    // 请求方法 / 请求头 / 请求体;请求头支持 {{localStorage:KEY}} 占位符,执行时在页面里解析
    let method = raw["method"].as_str().unwrap_or("GET").trim().to_ascii_uppercase();
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(&method.as_str()) {
        return Err(format!("不支持的请求方法: {method}"));
    }
    let headers = match &raw["headers"] {
        Value::Null => json!({}),
        Value::String(text) if text.trim().is_empty() => json!({}),
        Value::String(text) => {
            let parsed: Value = serde_json::from_str(text).map_err(|_| "请求头必须是合法 JSON 对象")?;
            if !parsed.is_object() {
                return Err("请求头必须是 JSON 对象".into());
            }
            parsed
        }
        Value::Object(map) => Value::Object(map.clone()),
        _ => return Err("请求头必须是 JSON 对象".into()),
    };
    let body = raw["body"].as_str().unwrap_or_default();
    let id = existing_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| format!("task-{}", time::OffsetDateTime::now_utc().unix_timestamp_nanos()));
    Ok(json!({
        "id": id,
        "name": name,
        "cron": expression,
        "groupKey": group_key,
        "siteName": site_name,
        "url": url,
        "method": method,
        "headers": headers,
        "body": body,
        "enabled": raw["enabled"].as_bool().unwrap_or(true),
        "lastRunAt": raw["lastRunAt"].as_str().unwrap_or_default(),
        "lastStatus": raw["lastStatus"].as_str().unwrap_or_default(),
    }))
}

fn read_tasks(app: &AppHandle) -> Vec<Value> {
    let cfg = app.state::<Config>();
    let state = match cfg.state.lock() {
        Ok(state) => state,
        Err(_) => return Vec::new(),
    };
    state["scheduledTasks"].as_array().cloned().unwrap_or_default()
}

fn write_tasks(app: &AppHandle, tasks: Vec<Value>) -> Result<(), String> {
    let cfg = app.state::<Config>();
    cfg.patch(json!({ "scheduledTasks": tasks }))?;
    Ok(())
}

/// 执行日志列表:递归扫描 tasks 目录,只取 scheduled-task 事件,时间倒序 + 关键字筛选。
pub fn list_runs(app: &AppHandle, keyword: &str) -> Value {
    let root = app.state::<Config>().data_dir.join("tasks");
    let needle = keyword.trim().to_lowercase();
    let mut items: Vec<Value> = Vec::new();
    fn walk(dir: &Path, depth: usize, needle: &str, items: &mut Vec<Value>) {
        if depth > 4 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, depth + 1, needle, items);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("log")) != Some(true) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for line in text.lines() {
                let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
                let event = &record["event"];
                if event["event"].as_str() != Some("scheduled-task") {
                    continue;
                }
                let task_name = event["taskName"].as_str().unwrap_or_default().to_string();
                let url = event["url"].as_str().unwrap_or_default().to_string();
                let error = event["error"].as_str().unwrap_or_default().to_string();
                let status_text = event["statusCode"].as_u64().map(|s| s.to_string()).unwrap_or_default();
                if !needle.is_empty() {
                    let hay = format!("{task_name} {url} {status_text} {error}").to_lowercase();
                    if !hay.contains(needle) {
                        continue;
                    }
                }
                items.push(json!({
                    "time": record["ts"].as_u64().unwrap_or_default(),
                    "taskName": task_name,
                    "method": event["method"],
                    "url": url,
                    "statusCode": event["statusCode"],
                    "durationMs": event["durationMs"],
                    "via": event["via"],
                    "skippedHeaders": event["skippedHeaders"],
                    "error": error,
                    "logPath": path.to_string_lossy(),
                }));
            }
        }
    }
    walk(&root, 0, &needle, &mut items);
    items.sort_by(|a, b| b["time"].as_u64().unwrap_or(0).cmp(&a["time"].as_u64().unwrap_or(0)));
    let total = items.len();
    items.truncate(300);
    json!({ "ok": true, "items": items, "total": total, "dir": root.to_string_lossy() })
}

/// 任务列表:附下次执行时间与运行中标记。
pub fn list(app: &AppHandle) -> Value {
    let running = app.state::<SchedulerState>().running.lock().map(|set| set.clone()).unwrap_or_default();
    let now = time::OffsetDateTime::now_utc();
    let tasks: Vec<Value> = read_tasks(app)
        .into_iter()
        .map(|task| {
            let mut item = task.clone();
            let next = if task["enabled"].as_bool().unwrap_or(true) {
                task["cron"].as_str().and_then(|expression| cron::next_run(expression, now).ok().flatten())
            } else {
                None
            };
            item["nextRunAt"] = json!(next.map(|value| value.unix_timestamp()));
            item["running"] = json!(running.iter().any(|id| task["id"] == json!(id)));
            item
        })
        .collect();
    let dir = app.state::<Config>().data_dir.join("tasks");
    json!({ "ok": true, "tasks": tasks, "dir": dir.to_string_lossy() })
}

pub fn save(app: &AppHandle, raw: &Value) -> Result<Value, String> {
    let tasks = read_tasks(app);
    let incoming_id = raw["id"].as_str().filter(|id| !id.is_empty());
    let existing = incoming_id.and_then(|id| tasks.iter().find(|task| task["id"] == json!(id)).cloned());
    let normalized = normalize(raw, existing.as_ref().and_then(|task| task["id"].as_str()))?;
    if existing.is_none() && tasks.len() >= MAX_TASKS {
        return Err(format!("定时任务数量已达上限({MAX_TASKS})"));
    }
    let id = normalized["id"].as_str().unwrap_or_default().to_string();
    let mut next: Vec<Value> = tasks
        .into_iter()
        .filter(|task| task["id"] != json!(id))
        .collect();
    next.push(normalized.clone());
    write_tasks(app, next)?;
    reschedule(app);
    crate::app_log!("info", "[scheduler] 保存任务: {} {}", normalized["name"], normalized["cron"]);
    Ok(json!({ "ok": true, "task": normalized }))
}

pub fn remove(app: &AppHandle, id: &str) -> Result<Value, String> {
    let tasks = read_tasks(app);
    if !tasks.iter().any(|task| task["id"] == json!(id)) {
        return Ok(json!({ "ok": false, "error": "任务不存在" }));
    }
    let next: Vec<Value> = tasks.into_iter().filter(|task| task["id"] != json!(id)).collect();
    write_tasks(app, next)?;
    reschedule(app);
    Ok(json!({ "ok": true }))
}

pub fn toggle(app: &AppHandle, id: &str, enabled: bool) -> Result<Value, String> {
    let tasks = read_tasks(app);
    let Some(task) = tasks.iter().find(|task| task["id"] == json!(id)).cloned() else {
        return Ok(json!({ "ok": false, "error": "任务不存在" }));
    };
    let mut updated = task;
    updated["enabled"] = json!(enabled);
    let next: Vec<Value> = tasks
        .into_iter()
        .map(|item| if item["id"] == json!(id) { updated.clone() } else { item })
        .collect();
    write_tasks(app, next)?;
    reschedule(app);
    Ok(json!({ "ok": true }))
}

/// 执行一次任务(manual=true 时忽略 enabled)。结果写任务目录并更新 lastRunAt/lastStatus。
pub async fn run(app: AppHandle, id: &str, manual: bool) -> Result<Value, String> {
    let tasks = read_tasks(&app);
    let Some(task) = tasks.iter().find(|task| task["id"] == json!(id)).cloned() else {
        return Ok(json!({ "ok": false, "error": "任务不存在" }));
    };
    if !manual && !task["enabled"].as_bool().unwrap_or(true) {
        return Ok(json!({ "ok": false, "error": "任务已停用" }));
    }
    // 同一任务不重叠
    {
        let state = app.state::<SchedulerState>();
        let mut running = state.running.lock().map_err(|_| "调度锁不可用")?;
        if running.contains(&id.to_string()) {
            return Ok(json!({ "ok": false, "error": "任务正在执行,已跳过本次" }));
        }
        running.insert(id.to_string());
    }

    let started = std::time::Instant::now();
    let result = fetch_in_webview(&app, &task).await;
    let duration = started.elapsed().as_millis() as u64;

    {
        let state = app.state::<SchedulerState>();
        if let Ok(mut running) = state.running.lock() {
            running.remove(id);
        };
    }

    let group = task["groupKey"].as_str().unwrap_or("unknown");
    let site = task["siteName"].as_str().unwrap_or("unknown");
    let dir = task_dir(&app.state::<Config>().data_dir, group, site);
    let mut log_path = String::new();
    if std::fs::create_dir_all(&dir).is_ok() {
        let path = dir.join("requests.log");
        let record = match &result {
            Ok(value) => json!({"event": "scheduled-task", "taskName": task["name"], "cron": task["cron"],
                "group": group, "site": site, "url": task["url"], "method": task["method"],
                "via": value["via"], "skippedHeaders": value["skipped"], "statusCode": value["status"],
                "responseBody": value["body"], "durationMs": duration}),
            Err(error) => json!({"event": "scheduled-task", "taskName": task["name"], "cron": task["cron"],
                "group": group, "site": site, "url": task["url"], "error": error, "durationMs": duration}),
        };
        let _ = request_log::append(&path, record);
        log_path = path.to_string_lossy().to_string();
    }

    // 记录最近一次结果
    if let Ok(next) = (|| -> Result<Vec<Value>, String> {
        let tasks = read_tasks(&app);
        Ok(tasks.into_iter().map(|item| {
            if item["id"] == json!(id) {
                let mut updated = item;
                updated["lastRunAt"] = json!(time::OffsetDateTime::now_utc().unix_timestamp());
                updated["lastStatus"] = match &result {
                    Ok(value) => json!(value["status"].as_u64().map(|s| s.to_string()).unwrap_or_else(|| "ok".into())),
                    Err(_) => json!("error"),
                };
                updated
            } else { item }
        }).collect())
    })() {
        let _ = write_tasks(&app, next);
    }
    reschedule(&app);

    match result {
        Ok(value) => {
            crate::app_log!("info", "[scheduler] 执行完成: {} status={} {}ms", task["name"], value["status"], duration);
            Ok(json!({ "ok": true, "statusCode": value["status"], "durationMs": duration,
                "truncated": value["truncated"], "logPath": log_path }))
        }
        Err(error) => {
            crate::app_log!("warn", "[scheduler] 执行失败: {} error={}", task["name"], error);
            Ok(json!({ "ok": false, "error": error, "durationMs": duration, "logPath": log_path }))
        }
    }
}

/// 在隐藏 WebView 里用页面上下文发 GET(与手动打开站点共用用户数据目录,自带登录态)。
async fn fetch_in_webview(app: &AppHandle, task: &Value) -> Result<Value, String> {
    let url = task["url"].as_str().ok_or("任务缺少 URL")?;
    crate::config::http_url(url)?;
    let method = task["method"].as_str().unwrap_or("GET").to_ascii_uppercase();
    let headers = task["headers"].clone();
    let body = task["body"].as_str().unwrap_or_default();
    let label = format!("task-{}", time::OffsetDateTime::now_utc().unix_timestamp_nanos());
    let cfg = app.state::<Config>();
    // 与站点视图共用同一 WebView2 用户数据目录:同源 cookie / localStorage 都能复用
    let profile = cfg.data_dir.join("webview-profile");
    let window = app.get_window("shell").ok_or("宿主窗口不存在")?;
    let builder = tauri::webview::WebviewBuilder::new(
        &label,
        tauri::WebviewUrl::External(tauri::Url::parse(url).map_err(|e| e.to_string())?),
    )
    .data_directory(profile);
    let view = window
        .add_child(builder, tauri::LogicalPosition::new(0, 0), tauri::LogicalSize::new(16, 16))
        .map_err(|e| e.to_string())?;
    let _ = view.hide();
    // 先在当前页面里解析请求头占位符({{localStorage:KEY}} / {{sessionStorage:KEY}} / {{storage:KEY}}),
    // 再发请求:cookie 由浏览器自动携带,localStorage 按 origin 读取
    let config = json!({
        "url": url,
        "method": method,
        "headers": headers,
        "body": body,
        "limit": MAX_RESPONSE_BYTES,
    });
    let script = build_task_script(&config.to_string());
    // 页面加载完成后才能 fetch:轮询 dom-ready 最多 15s
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if std::time::Instant::now() > deadline {
            let _ = view.close();
            return Err("任务页面加载超时".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        if view.eval(&script).is_ok() {
            break;
        }
    }
    let result = wait_for_task_result(app, &label, 20).await;
    let _ = view.close();
    result
}

async fn wait_for_task_result(app: &AppHandle, label: &str, timeout_secs: u64) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("任务请求超时".into());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let Some(view) = app.get_webview(label) else {
            return Err("任务页面已关闭".into());
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let _ = view.eval_with_callback("window.__devopsTaskResult", move |value| {
            let _ = tx.try_send(value);
        });
        let Ok(Some(raw)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        if value["error"].is_string() {
            return Err(value["error"].as_str().unwrap_or("请求失败").to_string());
        }
        return Ok(value);
    }
}


/// 生成任务执行脚本:解析请求头占位符 → fetch(credentials=include) → 写回 window.__devopsTaskResult。
/// 用字符串拼接而不是 format!,避免 Rust 花括号转义与 JS 正则冲突。
fn build_task_script(config_json: &str) -> String {
    let mut script = String::new();
    script.push_str("(() => { window.__devopsTaskResult = null; const cfg = ");
    script.push_str(config_json);
    script.push_str(r#";
const readLocal = (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } };
const readSession = (key) => { try { return sessionStorage.getItem(key); } catch (e) { return null; } };
const PATTERN = new RegExp('\{\{\s*(localStorage|sessionStorage|storage)\s*:\s*([^}]+?)\s*\}\}', 'g');
const resolve = (value) => {
  const skipped = [];
  const text = String(value).replace(PATTERN, (_m, kind, key) => {
    let found = null;
    if (kind === 'localStorage') found = readLocal(key);
    else if (kind === 'sessionStorage') found = readSession(key);
    else found = readLocal(key) !== null ? readLocal(key) : readSession(key);
    if (found === null || found === undefined) { skipped.push(kind + ':' + key); return ''; }
    return found;
  });
  return { text, skipped };
};
const finalHeaders = {};
const skippedHeaders = [];
Object.entries(cfg.headers || {}).forEach(([name, value]) => {
  const resolved = resolve(value);
  resolved.skipped.forEach((key) => skippedHeaders.push(name + '<-' + key));
  if (resolved.text.trim() === '' && resolved.skipped.length) return;
  finalHeaders[name] = resolved.text;
});
const init = { method: cfg.method, headers: finalHeaders, credentials: 'include' };
if (cfg.body && cfg.method !== 'GET' && cfg.method !== 'HEAD') init.body = cfg.body;
fetch(cfg.url, init).then(async (res) => {
  const text = await res.text();
  window.__devopsTaskResult = { status: res.status, via: 'headless', skipped: skippedHeaders,
    body: text.slice(0, cfg.limit), truncated: text.length > cfg.limit };
}).catch((error) => {
  window.__devopsTaskResult = { error: String(error), via: 'headless', skipped: skippedHeaders };
});
return true; })()"#);
    script
}

#[derive(Default)]
pub struct SchedulerState {
    pub running: Mutex<std::collections::HashSet<String>>,
    pub generation: Mutex<u64>,
}

/// 重新排程序列:递增 generation 让旧循环退出,再为启用任务启动新循环。
pub fn reschedule(app: &AppHandle) {
    let state = app.state::<SchedulerState>();
    let generation = {
        let Ok(mut value) = state.generation.lock() else { return };
        *value += 1;
        *value
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let current = {
                let state = handle.state::<SchedulerState>();
                let Ok(value) = state.generation.lock() else { return };
                *value
            };
            if current != generation {
                return;
            }
            // 找出最早到期的任务
            let now = time::OffsetDateTime::now_utc();
            let mut next_due: Option<(String, time::OffsetDateTime)> = None;
            for task in read_tasks(&handle) {
                if !task["enabled"].as_bool().unwrap_or(true) {
                    continue;
                }
                let Some(expression) = task["cron"].as_str() else { continue };
                let Ok(Some(when)) = cron::next_run(expression, now) else { continue };
                let id = task["id"].as_str().unwrap_or_default().to_string();
                if next_due.as_ref().is_none_or(|(_, existing)| when < *existing) {
                    next_due = Some((id, when));
                }
            }
            let Some((id, when)) = next_due else {
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            };
            let wait = (when - now).unsigned_abs().as_secs().max(1);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            let _ = run(handle.clone(), &id, false).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_dir_is_group_and_site() {
        let root = std::path::Path::new("/tmp/devops");
        assert_eq!(
            task_dir(root, "db", "Example"),
            root.join("tasks").join("db").join("Example")
        );
        assert_eq!(task_dir(root, "../x", "a/b").to_string_lossy().contains(".."), false);
    }

    #[test]
    fn normalize_validates_required_fields_and_cron() {
        let base = json!({"name":"日报","cron":"0 9 * * *","groupKey":"db","siteName":"Example","url":"https://a.test/x"});
        let task = normalize(&base, None).unwrap();
        assert_eq!(task["name"], "日报");
        assert_eq!(task["enabled"], true);
        assert!(task["id"].as_str().unwrap().starts_with("task-"));

        let mut without_name = base.clone();
        without_name["name"] = json!("");
        assert!(normalize(&without_name, None).is_err_and(|e| e.contains("任务名称")));
        assert!(normalize(&json!({"name":"x","cron":"0 25 * * *","groupKey":"g","siteName":"s","url":"https://a.test/"}), None)
            .is_err_and(|e| e.contains("小时超出范围")));
        assert!(normalize(&json!({"name":"x","cron":"0 9 * * *","groupKey":"","siteName":"s","url":"https://a.test/"}), None)
            .is_err_and(|e| e.contains("分组")));
        assert!(normalize(&json!({"name":"x","cron":"0 9 * * *","groupKey":"g","siteName":"","url":"https://a.test/"}), None)
            .is_err_and(|e| e.contains("站点")));
        assert!(normalize(&json!({"name":"x","cron":"0 9 * * *","groupKey":"g","siteName":"s","url":"ftp://a.test/"}), None).is_err());
    }

    #[test]
    fn normalize_keeps_existing_id_and_status() {
        let raw = json!({"name":"任务","cron":"*/30 * * * *","groupKey":"db","siteName":"Example",
            "url":"https://a.test/x","enabled":false,"lastStatus":"200","lastRunAt":1});
        let task = normalize(&raw, Some("task-1")).unwrap();
        assert_eq!(task["id"], "task-1");
        assert_eq!(task["enabled"], false);
        assert_eq!(task["lastStatus"], "200");
    }

    #[test]
    fn normalize_supports_method_headers_and_body() {
        let raw = json!({"name":"任务","cron":"0 9 * * *","groupKey":"db","siteName":"Example",
            "url":"https://a.test/x","method":"post","headers":"{\"X-Trace\":\"1\"}","body":"{\"a\":1}"});
        let task = normalize(&raw, None).unwrap();
        assert_eq!(task["method"], "POST");
        assert_eq!(task["headers"]["X-Trace"], "1");
        assert_eq!(task["body"], "{\"a\":1}");

        let mut bad_method = raw.clone();
        bad_method["method"] = json!("TRACE");
        assert!(normalize(&bad_method, None).unwrap_err().contains("不支持的请求方法"));

        let mut bad_headers = raw.clone();
        bad_headers["headers"] = json!("{bad");
        assert!(normalize(&bad_headers, None).unwrap_err().contains("请求头"));

        let mut array_headers = raw.clone();
        array_headers["headers"] = json!("[1,2]");
        assert!(normalize(&array_headers, None).unwrap_err().contains("请求头必须是 JSON 对象"));

        // 占位符原样保存,执行时解析
        let mut placeholder = raw.clone();
        placeholder["headers"] = json!("{\"Authorization\":\"Bearer {{localStorage:token}}\"}");
        let saved = normalize(&placeholder, None).unwrap();
        assert_eq!(saved["headers"]["Authorization"], "Bearer {{localStorage:token}}");
    }
}
