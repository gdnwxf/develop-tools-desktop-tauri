#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
mod config;
mod context_menu;
mod cron;
mod logging;
mod log_writer;
mod request_log;
mod scheduler;
mod session;
mod totp;
mod tray;
mod views;
#[cfg(windows)]
mod windows_webview;

use tauri::Manager;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = config::Config::load().map_err(std::io::Error::other)?;
    // 启动日志落盘：应用打不开/白屏时可直接查看 ~/.my_devops/app.log
    match logging::init(&config.data_dir) {
        Ok(path) => eprintln!("[startup] log file={}", path.display()),
        Err(error) => eprintln!("[startup] log file init failed={error}"),
    }
    if let Err(e) = request_log::cleanup(&config.data_dir, config.retention_days) {
        app_log!("warn", "[request-log] cleanup failed={e}");
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
        .manage(scheduler::SchedulerState::default())
        .on_menu_event(context_menu::handle)
        .invoke_handler(tauri::generate_handler![commands::desktop])
        .setup(|app| {
            let profile = app.state::<config::Config>().data_dir.join("shell-profile");
            let window_config = app.config().app.windows.first().ok_or("宿主窗口配置缺失")?;
            let handle = app.handle().clone();
            let window = tauri::WebviewWindowBuilder::from_config(app, window_config)?
                .data_directory(profile)
                .on_navigation(move |url| config::is_host_page(&handle, url))
                .build()?;
            // 托盘:关闭窗口隐藏到托盘(close_to_tray=false 时保持关闭即退出)
            let tray_ready = tray::install(app.handle());
            let close_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if tray::on_close_requested(&close_handle, tray_ready) {
                        api.prevent_close();
                    }
                }
            });
            views::start_navigation_monitor(app.handle().clone());
            scheduler::reschedule(app.handle());
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
        app_log!("error", "[app] 启动失败：{e}");
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("powershell.exe").args(["-NoProfile", "-Command", "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Tauri 启动失败，请检查配置、状态文件及 WebView2 环境。','DevOps 工具集 Tauri')"]).spawn();
        }
        std::process::exit(1);
    }
}
