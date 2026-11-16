#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
mod config;
mod context_menu;
mod log_writer;
mod request_log;
mod session;
mod totp;
mod views;
#[cfg(windows)]
mod windows_webview;

use tauri::Manager;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = config::Config::load().map_err(std::io::Error::other)?;
    if let Err(e) = request_log::cleanup(&config.data_dir, config.retention_days) {
        eprintln!("[request-log] cleanup failed={e}");
    }
    // 过期文件清理完成后再启动写入线程，避免清理与写入并发操作同一批文件。
    log_writer::start(4096);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_window("shell") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(config)
        .manage(views::Views::default())
        .on_menu_event(context_menu::handle)
        .invoke_handler(tauri::generate_handler![commands::desktop])
        .setup(|app| {
            let profile = app.state::<config::Config>().data_dir.join("shell-profile");
            let window_config = app.config().app.windows.first().ok_or("宿主窗口配置缺失")?;
            tauri::WebviewWindowBuilder::from_config(app, window_config)?
                .data_directory(profile)
                .on_navigation(|url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost"))
                })
                .build()?;
            views::start_navigation_monitor(app.handle().clone());
            session::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(|_, event| {
        // 退出前关闭写入线程，确保缓冲日志落盘。
        if let tauri::RunEvent::Exit = event {
            request_log::shutdown();
        }
    });
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("[app] 启动失败：{e}");
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("powershell.exe").args(["-NoProfile", "-Command", "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Tauri 启动失败，请检查配置、状态文件及 WebView2 环境。','DevOps 工具集 Tauri')"]).spawn();
        }
        std::process::exit(1);
    }
}
