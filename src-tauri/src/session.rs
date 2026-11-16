use crate::{config::Config, views::Views};
use std::time::Duration;
use tauri::Manager;

// WebView2 与 Electron 使用独立存储，只延长本站新产生且未设过期时间的 Cookie。
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if app.get_window("shell").is_none() {
                break;
            }
            let label = match app.state::<Views>().0.lock() {
                Ok(views) => views.keys().next().cloned(),
                Err(_) => break,
            };
            let Some(view) = label.and_then(|label| app.get_webview(&label)) else {
                continue;
            };
            let cookies = match view.cookies() {
                Ok(cookies) => cookies,
                Err(error) => {
                    eprintln!("[session] read cookies failed={error}");
                    continue;
                }
            };
            let cfg = app.state::<Config>();
            for mut cookie in cookies {
                if cookie.expires().is_some() {
                    continue;
                }
                let domain = cookie.domain().unwrap_or_default().trim_start_matches('.');
                let configured = cfg
                    .groups
                    .iter()
                    .flat_map(|group| &group.sites)
                    .any(|site| {
                        crate::config::http_url(&site.url)
                            .ok()
                            .and_then(|u| u.host_str().map(str::to_owned))
                            .is_some_and(|host| {
                                host == domain || host.ends_with(&format!(".{domain}"))
                            })
                    });
                if !configured {
                    continue;
                }
                cookie.set_expires(time::OffsetDateTime::now_utc() + time::Duration::days(30));
                if let Err(error) = view.set_cookie(cookie) {
                    eprintln!("[session] persist cookie failed={error}");
                }
            }
        }
    });
}
