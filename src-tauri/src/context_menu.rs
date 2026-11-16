use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    Emitter, Manager,
};

fn entries(kind: &str, has_site: bool) -> Result<Vec<(&'static str, &'static str)>, String> {
    match (kind, has_site) {
        ("site", true) => Ok(vec![("clone", "复制"), ("copy-link", "复制链接")]),
        ("tab", true) => Ok(vec![
            ("reload", "刷新"),
            ("close-right", "关闭右侧标签"),
            ("close-left", "关闭左侧标签"),
            ("close-other", "关闭其他标签"),
            ("close-all", "关闭全部标签"),
            ("clone", "复制"),
            ("copy-link", "复制链接"),
            ("open-log", "日志文件"),
            ("open-log-folder", "日志文件夹"),
            ("clear-log", "清空日志"),
        ]),
        ("tab", false) => Ok(vec![("close-all", "关闭全部标签")]),
        _ => Err("右键菜单类型无效".into()),
    }
}

pub fn show(app: &tauri::AppHandle, args: &Value) -> Result<Value, String> {
    let kind = args["kind"].as_str().ok_or("缺少菜单类型")?;
    let site_id = args["siteId"].as_str().unwrap_or_default();
    let x = args["x"].as_f64().ok_or("缺少菜单横坐标")?;
    let y = args["y"].as_f64().ok_or("缺少菜单纵坐标")?;
    if !x.is_finite() || !y.is_finite() || x < 0. || y < 0. {
        return Err("菜单坐标无效".into());
    }
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    for (action, text) in entries(kind, !site_id.is_empty())? {
        // 事件携带原始目标，避免菜单打开后切换标签导致动作作用于错误站点。
        let id = format!("context:{}", json!({"action":action,"siteId":site_id}));
        let item =
            MenuItem::with_id(app, id, text, true, None::<&str>).map_err(|e| e.to_string())?;
        menu.append(&item).map_err(|e| e.to_string())?;
    }
    app.get_window("shell")
        .ok_or("宿主窗口不存在")?
        .popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(json!(true))
}

pub fn handle(app: &tauri::AppHandle, event: MenuEvent) {
    let Some(value) = event.id().as_ref().strip_prefix("context:") else {
        return;
    };
    let Ok(payload) = serde_json::from_str::<Value>(value) else {
        return;
    };
    if let Err(error) = app.emit_to("shell", "context-action", payload) {
        eprintln!("[context-menu] action delivery failed={error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn menus_preserve_site_actions_and_blank_tab_behavior() {
        assert_eq!(entries("site", true).unwrap().len(), 2);
        assert_eq!(entries("tab", true).unwrap().len(), 10);
        assert_eq!(
            entries("tab", false).unwrap(),
            vec![("close-all", "关闭全部标签")]
        );
        assert!(entries("site", false).is_err());
        assert!(entries("unknown", true).is_err());
    }
}
