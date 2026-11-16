use crate::{
    config::{self, Config, Site},
    request_log,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager, Webview, WebviewUrl};

#[derive(Clone)]
pub struct ViewInfo {
    pub site: Site,
    pub log_path: PathBuf,
}
#[derive(Default)]
pub struct Views(pub Mutex<HashMap<String, ViewInfo>>);

#[derive(Deserialize, Clone)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Bounds {
    fn rect(&self) -> Result<tauri::Rect, String> {
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            || self.width < 1.
            || self.height < 1.
            || self.x < 0.
            || self.y < 0.
        {
            return Err("WebView 布局参数无效".into());
        }
        Ok(tauri::Rect {
            position: tauri::LogicalPosition::new(self.x, self.y).into(),
            size: tauri::LogicalSize::new(self.width, self.height).into(),
        })
    }
}

pub fn get(app: &tauri::AppHandle, label: &str) -> Result<Webview, String> {
    if !app
        .state::<Views>()
        .0
        .lock()
        .map_err(|_| "视图锁不可用")?
        .contains_key(label)
    {
        return Err("站点 WebView 不存在".into());
    }
    app.get_webview(label).ok_or("原生 WebView 不存在".into())
}

pub fn info(app: &tauri::AppHandle, label: &str) -> Result<ViewInfo, String> {
    app.state::<Views>()
        .0
        .lock()
        .map_err(|_| "视图锁不可用")?
        .get(label)
        .cloned()
        .ok_or("站点 WebView 不存在".into())
}

pub fn event(app: &tauri::AppHandle, label: &str, event: &str, url: &str) {
    if let Err(e) = app.emit_to(
        "shell",
        "native-view",
        json!({"label":label,"event":event,"url":url}),
    ) {
        eprintln!("[webview] event={event} label={label} failed={e}");
    }
}

pub async fn create(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    let label = args["label"]
        .as_str()
        .ok_or("缺少 WebView 标签")?
        .to_string();
    if !label.starts_with("view-")
        || label.len() > 100
        || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("WebView 标签无效".into());
    }
    let id = args["siteId"].as_str().ok_or("缺少站点 ID")?;
    let cfg = app.state::<Config>();
    let site = if let Some(site) = cfg.site(id) {
        site
    } else if let Some(mut source) = args["sourceId"].as_str().and_then(|s| cfg.site(s)) {
        if !id.starts_with("copy-") {
            return Err("克隆 ID 无效".into());
        }
        source.id = id.into();
        source
    } else {
        // 重启后源配置已删除的克隆只恢复页面，不恢复凭据。
        let state = cfg.state.lock().map_err(|_| "状态锁不可用")?;
        let clone = state["clonedSites"]
            .as_array()
            .and_then(|a| a.iter().find(|c| c["id"].as_str() == Some(id)))
            .ok_or("克隆站点不存在，请先保存标签状态")?;
        let source = clone["sourceId"].as_str().and_then(|s| cfg.site(s));
        match source {
            Some(mut s) => {
                s.id = id.into();
                s
            }
            None => Site {
                id: id.into(),
                group_key: String::new(),
                kind: clone["type"].as_str().unwrap_or_default().into(),
                name: clone["name"].as_str().unwrap_or_default().into(),
                url: clone["url"].as_str().ok_or("克隆 URL 缺失")?.into(),
                user: String::new(),
                password: String::new(),
                first_open_url: String::new(),
                login_path: String::new(),
                optsecret: String::new(),
            },
        }
    };
    let url = args["url"].as_str().ok_or("缺少 URL")?;
    config::http_url(url)?;
    if !config::same_origin(&site.url, url) {
        return Err("初始页面必须与配置站点同源".into());
    }
    let url = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    let bounds: Bounds =
        serde_json::from_value(args["bounds"].clone()).map_err(|e| e.to_string())?;
    let rect = bounds.rect()?;
    let log_path = request_log::session_path(&cfg.data_dir, &label)?;
    let profile = cfg.data_dir.join("webview-profile");
    let view_info = ViewInfo {
        site: site.clone(),
        log_path: log_path.clone(),
    };
    {
        let view_state = app.state::<Views>();
        let mut views = view_state.0.lock().map_err(|_| "视图锁不可用")?;
        if views.contains_key(&label) {
            return Err("WebView 标签重复".into());
        }
        views.insert(label.clone(), view_info);
    }
    let app_nav = app.clone();
    let app_page = app.clone();
    let app_popup = app.clone();
    let popup_label = label.clone();
    let popup_site = site.clone();
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(tauri::Url::parse("about:blank").map_err(|e| e.to_string())?))
        .data_directory(profile)
        .additional_browser_args("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows")
        .on_navigation(move |url| {
            let allowed = matches!(url.scheme(), "http" | "https" | "about");
            if !allowed { eprintln!("[webview] blocked navigation scheme={}", url.scheme()); }
            let _ = &app_nav;
            allowed
        })
        .on_page_load(move |view, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished && matches!(payload.url().scheme(), "http" | "https") {
                event(&app_page, view.label(), "did-navigate", payload.url().as_str());
                event(&app_page, view.label(), "dom-ready", payload.url().as_str());
            }
        })
        .on_new_window(move |url, features| {
            if !matches!(url.scheme(), "http" | "https" | "about") { return tauri::webview::NewWindowResponse::Deny; }
            if popup_site.kind == "bytebase" && config::same_origin(&popup_site.url, url.as_str()) {
                if let Some(view) = app_popup.get_webview(&popup_label) { let _ = view.navigate(url); }
                return tauri::webview::NewWindowResponse::Deny;
            }
            static POPUP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let number = POPUP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let popup = tauri::WebviewWindowBuilder::new(&app_popup, format!("popup-{number}"), WebviewUrl::External(url))
                .window_features(features).title("DevOps 工具集 Tauri").inner_size(1200.,800.)
                .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"));
            match popup.build() {
                Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                Err(error) => { eprintln!("[popup] create failed={error}"); tauri::webview::NewWindowResponse::Deny }
            }
        });
    let result = app
        .get_window("shell")
        .ok_or("宿主窗口不存在".to_string())?
        .add_child(builder, rect.position, rect.size)
        .map_err(|e| e.to_string());
    let view = match result {
        Ok(view) => view,
        Err(e) => {
            app.state::<Views>()
                .0
                .lock()
                .map_err(|_| "视图锁不可用")?
                .remove(&label);
            return Err(e);
        }
    };
    let initialized = (|| -> Result<(), String> {
        view.hide().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        crate::windows_webview::attach(
            &view,
            site,
            log_path,
            url.clone(),
            cfg.max_log_response_size,
        )?;
        #[cfg(not(windows))]
        view.navigate(url).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = initialized {
        let _ = view.close();
        app.state::<Views>()
            .0
            .lock()
            .map_err(|_| "视图锁不可用")?
            .remove(&label);
        return Err(error);
    }
    eprintln!("[webview] create label={label} ok");
    Ok(json!(true))
}

pub async fn evaluate(app: &tauri::AppHandle, label: &str, script: &str) -> Result<Value, String> {
    let view = get(app, label)?;
    let info = info(app, label)?;
    let current = view.url().map_err(|e| e.to_string())?;
    if !config::same_origin(&info.site.url, current.as_str()) {
        return Err("跨域页面禁止执行自动登录脚本".into());
    }
    let script = script.trim().trim_end_matches(';');
    let origin = serde_json::to_string(
        &config::http_url(&info.site.url)?
            .origin()
            .ascii_serialization(),
    )
    .map_err(|e| e.to_string())?;
    let wrapped = format!("(()=>{{try{{if(location.origin!=={origin})return {{ok:false,error:'跨域页面禁止执行脚本'}};const value=({script});if(value&&typeof value.then==='function')return {{ok:false,error:'仅支持同步脚本表达式'}};return {{ok:true,value}}}}catch(e){{return {{ok:false,error:String(e)}}}}}})()");
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    view.eval_with_callback(wrapped, move |result| {
        let _ = tx.try_send(result);
    })
    .map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
        .await
        .map_err(|_| "页面脚本执行超时")?
        .ok_or("页面已关闭")?;
    serde_json::from_str(&result).map_err(|e| format!("脚本返回格式无效：{e}"))
}

pub fn action(app: &tauri::AppHandle, args: &Value) -> Result<Value, String> {
    let label = args["label"].as_str().ok_or("缺少标签")?;
    let view = get(app, label)?;
    match args["action"].as_str().ok_or("缺少动作")? {
        "close" => {
            view.close().map_err(|e| e.to_string())?;
            app.state::<Views>()
                .0
                .lock()
                .map_err(|_| "视图锁不可用")?
                .remove(label);
        }
        "reload" => view.reload().map_err(|e| e.to_string())?,
        "stop" => view.eval("window.stop()").map_err(|e| e.to_string())?,
        "devtools" => view.open_devtools(),
        "focus" => view.set_focus().map_err(|e| e.to_string())?,
        "navigate" => view
            .navigate(config::http_url(args["url"].as_str().ok_or("缺少URL")?)?)
            .map_err(|e| e.to_string())?,
        _ => return Err("不支持的 WebView 动作".into()),
    }
    Ok(json!(true))
}

pub fn layout(app: &tauri::AppHandle, args: Value) -> Result<Value, String> {
    let rows = args["views"].as_array().ok_or("缺少视图布局")?;
    for row in rows {
        let label = row["label"].as_str().ok_or("缺少视图标签")?;
        // 关闭标签后的最后一帧布局可能晚到；已移除视图无需再布局。
        let view = match get(app, label) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if row["visible"] == true {
            let bounds: Bounds =
                serde_json::from_value(row["bounds"].clone()).map_err(|e| e.to_string())?;
            view.set_bounds(bounds.rect()?).map_err(|e| e.to_string())?;
            view.show().map_err(|e| e.to_string())?;
        } else {
            view.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(json!(true))
}

pub fn start_navigation_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut urls = HashMap::<String, String>::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            if app.get_window("shell").is_none() {
                break;
            }
            let labels: Vec<_> = match app.state::<Views>().0.lock() {
                Ok(v) => v.keys().cloned().collect(),
                Err(_) => break,
            };
            urls.retain(|key, _| labels.contains(key));
            for label in labels {
                let Some(view) = app.get_webview(&label) else {
                    continue;
                };
                if let Ok(url) = view.url() {
                    let url = url.to_string();
                    if urls.get(&label).is_some_and(|old| old != &url) {
                        event(&app, &label, "did-navigate-in-page", &url);
                    }
                    urls.insert(label, url);
                }
            }
        }
    });
}

// 诊断命令沿用宿主来源校验，不向远程页面开放。
pub async fn inspect(app: &tauri::AppHandle, label: &str) -> Result<Value, String> {
    let view = get(app, label)?;
    let bounds = view.bounds().map_err(|e| e.to_string())?;
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    #[cfg(windows)]
    view.with_webview(move |native| {
        let mut visible = windows::core::BOOL::default();
        let result = unsafe { native.controller().IsVisible(&mut visible) }
            .map(|_| visible.as_bool())
            .map_err(|e| e.to_string());
        let _ = sender.try_send(result);
    })
    .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = sender.try_send(Err::<bool, String>("原生可见性检查仅支持 Windows".into()));
    }
    let visible = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .map_err(|_| "原生可见性检查超时")?
        .ok_or("原生视图已关闭")??;
    Ok(json!({"visible":visible,"bounds":bounds}))
}
