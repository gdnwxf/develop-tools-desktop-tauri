use crate::{
    config::{http_url, Config},
    request_log, totp, views,
};
use serde_json::{json, Value};
use tauri::Manager;

// 命令参数永不作为日志载荷；远程站点不能借宿主能力读取配置或执行本机操作。
fn authorize(caller: &tauri::Webview) -> Result<(), String> {
    let url = caller.url().map_err(|e| e.to_string())?;
    if caller.label() != "shell"
        || !((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")))
    {
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
            if !info.log_path.exists() {
                request_log::append(&info.log_path, json!({"kind":"session","label":label}))?;
            }
        }
        "open" => {
            open::that(&info.log_path).map_err(|e| e.to_string())?;
        }
        "folder" => {
            open::that(info.log_path.parent().ok_or("日志目录不存在")?)
                .map_err(|e| e.to_string())?;
        }
        "clear" => {
            std::fs::write(&info.log_path, []).map_err(|e| e.to_string())?;
        }
        _ => return Err("不支持的日志动作".into()),
    }
    Ok(json!({"ok":true,"path":info.log_path.to_string_lossy()}))
}
