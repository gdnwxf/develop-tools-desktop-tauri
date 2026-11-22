//! tray.rs -- 系统托盘:关闭窗口默认隐藏到托盘,菜单提供 显示主窗口 / 隐藏到托盘 / 退出。
//! 配置 `close_to_tray: false` 时保持"关闭即退出"的原有行为。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub const MENU_SHOW: &str = "tray:show";
pub const MENU_HIDE: &str = "tray:hide";
pub const MENU_QUIT: &str = "tray:quit";

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_window("shell") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_window("shell") {
        let _ = window.hide();
    }
}

/// 创建托盘并接管关闭按钮(隐藏而非退出)。返回是否创建成功,失败时保持原有退出行为。
pub fn install(app: &AppHandle) -> bool {
    let menu = match Menu::new(app) {
        Ok(menu) => menu,
        Err(error) => {
            eprintln!("[tray] 创建菜单失败: {error}");
            return false;
        }
    };
    let items = [
        (MENU_SHOW, "显示主窗口"),
        (MENU_HIDE, "隐藏到托盘"),
        (MENU_QUIT, "退出"),
    ];
    for (id, text) in items {
        match MenuItem::with_id(app, id, text, true, None::<&str>) {
            Ok(item) => {
                if let Err(error) = menu.append(&item) {
                    eprintln!("[tray] 追加菜单项失败: {error}");
                    return false;
                }
            }
            Err(error) => {
                eprintln!("[tray] 创建菜单项失败: {error}");
                return false;
            }
        }
    }
    let icon = match app.default_window_icon().cloned() {
        Some(icon) => icon,
        None => {
            eprintln!("[tray] 缺少应用图标,跳过托盘");
            return false;
        }
    };
    let builder = TrayIconBuilder::with_id("devops-tray")
        .icon(icon)
        .tooltip("DevOps 工具集 Tauri")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main(app),
            MENU_HIDE => hide_main(app),
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击恢复窗口(Windows 习惯);右键弹出菜单
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    match builder.build(app) {
        Ok(_) => {
            eprintln!("[tray] 托盘已创建");
            true
        }
        Err(error) => {
            eprintln!("[tray] 创建托盘失败: {error}");
            false
        }
    }
}

/// 窗口关闭请求:托盘可用且配置允许时隐藏到托盘。
pub fn on_close_requested(app: &AppHandle, tray_ready: bool) -> bool {
    let close_to_tray = app.state::<crate::config::Config>().close_to_tray;
    if !tray_ready || !close_to_tray {
        return false;
    }
    hide_main(app);
    crate::app_log!("info", "[tray] 关闭窗口 -> 隐藏到托盘");
    true
}
