use crate::{
    config::{http_url, Config},
    request_log, totp, views,
};
use serde_json::{json, Value};
use tauri::Manager;

// 命令参数永不作为日志载荷；远程站点不能借宿主能力读取配置或执行本机操作。
fn authorize(caller: &tauri::Webview) -> Result<(), String> {
    let url = caller.url().map_err(|e| e.to_string())?;
    if caller.label() != "shell" || !crate::config::is_host_page(caller.app_handle(), &url) {
        return Err("该命令只允许本地宿主页面调用".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    op: String,
    args: Value,
) -> Result<Value, String> {
    authorize(&webview)?;
    let result = dispatch(&app, &op, args).await;
    if let Err(e) = &result {
        eprintln!("[desktop] op={op} failed={e}");
    }
    result
}

async fn dispatch(app: &tauri::AppHandle, op: &str, args: Value) -> Result<Value, String> {
    match op {
        "bootstrap" => {
            let cfg = app.state::<Config>();
            Ok(
                json!({"groups":cfg.groups,"defaultExpand":cfg.default_expand,"state":*cfg.state.lock().map_err(|_|"状态锁不可用")?,"configPath":cfg.config_path.to_string_lossy(),"configError":cfg.error}),
            )
        }
        "state_patch" => Ok(json!(app.state::<Config>().patch(args["patch"].clone())?)),
        "create_view" => views::create(app.clone(), args).await,
        "eval_view" => {
            views::evaluate(
                app,
                args["label"].as_str().ok_or("缺少标签")?,
                args["script"].as_str().ok_or("缺少脚本")?,
            )
            .await
        }
        "inspect_view" => views::inspect(app, args["label"].as_str().ok_or("缺少标签")?).await,
        "context_menu" => crate::context_menu::show(app, &args),
        "view_action" => views::action(app, &args),
        "layout_views" => views::layout(app, args),
        "restart" => {
            app.restart();
        }
        "is_dev" => Ok(json!(cfg!(debug_assertions))),
        "otp" => {
            let time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs();
            match totp::generate(args["secret"].as_str().ok_or("缺少 TOTP 密钥")?, time) {
                Ok(code) => Ok(json!({"ok":true,"code":code})),
                Err(e) => Ok(json!({"ok":false,"error":e})),
            }
        }
        "open_link" => {
            let url = args["url"].as_str().ok_or("缺少链接")?;
            let cfg = app.state::<Config>();
            if url == cfg.config_path.to_string_lossy() {
                open::that(&cfg.config_path).map_err(|e| e.to_string())?;
            } else {
                http_url(url)?;
                open::that(url).map_err(|e| e.to_string())?;
            }
            Ok(json!(true))
        }
        "api_tool_list" => {
            let label = args["label"].as_str().ok_or("缺少标签")?;
            let info = views::info(app, label)?;
            let dir = info.log_path.parent().ok_or("日志目录缺失")?;
            let list = request_log::list_requests(dir, args["keyword"].as_str().unwrap_or_default(), 300);
            Ok(json!({"ok": true, "items": list["items"], "total": list["total"], "dir": dir.to_string_lossy()}))
        }
        "api_tool_send" => {
            let label = args["label"].as_str().ok_or("缺少标签")?;
            let url = args["url"].as_str().ok_or("缺少请求地址")?;
            http_url(url)?;
            let info = views::info(app, label)?;
            if !crate::config::same_origin(&info.site.url, url) {
                return Ok(json!({"ok": false, "error": "跨源请求暂不支持：请在页面内发起同源请求"}));
            }
            let method = args["method"].as_str().unwrap_or("GET").to_ascii_uppercase();
            if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].contains(&method.as_str()) {
                return Ok(json!({"ok": false, "error": "不支持的请求方法"}));
            }
            let headers = args["headers"].clone();
            let body = args["body"].as_str().unwrap_or_default();
            let cfg = json!({"url": url, "method": method, "headers": headers, "body": body, "limit": 262144});
            let start = format!(
                "(() => {{ window.__devopsApiToolResult = null; const cfg = {cfg}; \
                 const init = {{ method: cfg.method, headers: cfg.headers }}; \
                 if (cfg.body && cfg.method !== 'GET' && cfg.method !== 'HEAD') init.body = cfg.body; \
                 fetch(cfg.url, init).then(async (res) => {{ \
                   const text = await res.text(); const out = {{}}; \
                   res.headers.forEach((value, key) => {{ out[key] = value; }}); \
                   window.__devopsApiToolResult = {{ status: res.status, statusText: res.statusText, headers: out, \
                     body: text.slice(0, cfg.limit), truncated: text.length > cfg.limit, via: 'page' }}; \
                 }}).catch((error) => {{ window.__devopsApiToolResult = {{ error: String(error) }}; }}); return true; }})()"
            );
            let started = std::time::Instant::now();
            let result = views::evaluate_async(app, label, &start, 15000).await;
            let duration = started.elapsed().as_millis() as u64;
            let cfg_app = app.state::<Config>();
            let log_path = request_log::tool_session_path(&cfg_app.data_dir, &info.site.group_key, &info.site.name);
            if let Ok(path) = &log_path {
                let record = match &result {
                    Ok(value) => json!({"event": "api-tool", "method": method, "url": url,
                        "statusCode": value["status"], "responseBody": value["body"], "durationMs": duration,
                        "error": value["error"]}),
                    Err(error) => json!({"event": "api-tool", "method": method, "url": url,
                        "error": error, "durationMs": duration}),
                };
                let _ = request_log::append(path, record);
            }
            match result {
                Ok(value) => {
                    let mut payload = value;
                    payload["ok"] = json!(payload.get("error").is_none());
                    payload["durationMs"] = json!(duration);
                    payload["logPath"] = json!(log_path.map(|p| p.to_string_lossy().to_string()).unwrap_or_default());
                    Ok(payload)
                }
                Err(error) => Ok(json!({"ok": false, "error": error, "durationMs": duration})),
            }
        }
        "recent_list" => Ok(json!({
            "ok": true,
            "items": crate::recent_store::read(&app.state::<Config>().data_dir),
        })),
        "recent_touch" => Ok(json!({
            "ok": true,
            "items": crate::recent_store::touch(
                &app.state::<Config>().data_dir,
                args["siteId"].as_str().unwrap_or_default(),
                args["name"].as_str().unwrap_or_default(),
                args["url"].as_str().unwrap_or_default(),
                args["groupKey"].as_str().unwrap_or_default(),
            ),
        })),
        "scheduler_list" => Ok(crate::scheduler::list(app)),
        "scheduler_save" => crate::scheduler::save(app, &args["task"]),
        "scheduler_remove" => crate::scheduler::remove(app, args["id"].as_str().ok_or("缺少任务 ID")?),
        "scheduler_toggle" => crate::scheduler::toggle(
            app,
            args["id"].as_str().ok_or("缺少任务 ID")?,
            args["enabled"].as_bool().unwrap_or(false),
        ),
        "scheduler_runs" => Ok(crate::scheduler::list_runs(app, args["keyword"].as_str().unwrap_or_default())),
        "scheduler_run" => {
            crate::scheduler::run(app.clone(), args["id"].as_str().ok_or("缺少任务 ID")?, true).await
        }
        "log_action" => log_action(app, &args),
        "renderer_log" => {
            // 原界面日志可能带完整 URL；这里只保留不含参数/凭据的诊断条目。
            if let Some(items) = args["args"].as_array() {
                let safe: Vec<String> = items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| {
                        if s.contains("http://") || s.contains("https://") {
                            "[url omitted]".into()
                        } else {
                            s.chars().take(240).collect()
                        }
                    })
                    .collect();
                eprintln!("[renderer] {}", safe.join(" "));
            }
            Ok(json!(true))
        }
        _ => Err(format!("不支持的宿主操作：{op}")),
    }
}

fn log_action(app: &tauri::AppHandle, args: &Value) -> Result<Value, String> {
    let action = args["action"].as_str().ok_or("缺少日志动作")?;
    let cfg = app.state::<Config>();
    if action == "clear_all" {
        let removed = request_log::clear_all(&cfg.data_dir)?;
        eprintln!("[request-log] clear_all files={removed} ok");
        return Ok(json!({"ok":true,"removed":removed}));
    }
    let label = args["label"].as_str().ok_or("缺少标签")?;
    let info = views::info(app, label)?;
    match action {
        "register" => {
            // 文件由写入线程异步创建，不能再用 exists() 判断首次注册；渲染层已保证每视图只注册一次。
            request_log::append(&info.log_path, json!({"kind":"session","label":label}))?;
        }
        "open" => {
            open::that(&info.log_path).map_err(|e| e.to_string())?;
        }
        "folder" => {
            open::that(info.log_path.parent().ok_or("日志目录不存在")?)
                .map_err(|e| e.to_string())?;
        }
        "clear" => {
            request_log::clear_path(&info.log_path)?;
        }
        // 复制日志文件:返回内容(超过 2MB 只给尾部)
        "read" => {
            if !info.log_path.exists() {
                return Ok(json!({"ok":false,"error":"当前页面还没有日志文件"}));
            }
            let (text, truncated, size) = request_log::read_tail(&info.log_path, 2 * 1024 * 1024)?;
            if text.is_empty() {
                return Ok(json!({"ok":false,"error":"日志文件还是空的"}));
            }
            return Ok(json!({
                "ok": true,
                "path": info.log_path.to_string_lossy(),
                "size": size,
                "truncated": truncated,
                "text": text,
            }));
        }
        _ => return Err("不支持的日志动作".into()),
    }
    Ok(json!({"ok":true,"path":info.log_path.to_string_lossy()}))
}
