//! logging.rs -- 主进程日志落盘
//! 启动、清理、托盘、定时任务等排障信息同时输出到 stderr 和 `~/.my_devops/app.log`，
//! 应用"打不开/白屏"时可直接查看该文件；超过上限自动滚动为 `app.old.log`。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn timestamp() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

/// 初始化日志文件；已存在且超过上限时先滚动，避免无限增长。
pub fn init(data_dir: &Path) -> Result<PathBuf, String> {
    let path = data_dir.join("app.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = fs::rename(&path, data_dir.join("app.old.log"));
        }
    }
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let _ = LOG_PATH.set(path.clone());
    write("info", &format!("===== 应用启动 ===== pid={}", std::process::id()));
    Ok(path)
}

/// 当前日志文件路径（未初始化时返回 None）。
pub fn path() -> Option<&'static Path> {
    LOG_PATH.get().map(|path| path.as_path())
}

/// 追加一行日志；未初始化时只输出到 stderr。
pub fn write(level: &str, message: &str) {
    let Some(path) = LOG_PATH.get() else {
        eprintln!("[{level}] {message}");
        return;
    };
    let _guard = WRITE_LOCK.lock();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} [{level}] {message}", timestamp());
    }
}

#[macro_export]
macro_rules! app_log {
    ($level:expr, $($arg:tt)*) => {{
        let message = format!($($arg)*);
        eprintln!("[{}] {}", $level, message);
        $crate::logging::write($level, &message);
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_lines_and_rolls_oversized_file() {
        let dir = std::env::temp_dir().join(format!("devops-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 先放一个超大旧文件，init 时应滚动
        let existing = dir.join("app.log");
        fs::write(&existing, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        let log_path = init(&dir).unwrap();
        assert!(dir.join("app.old.log").exists(), "超限日志应被滚动");
        write("info", "hello-log");
        let text = fs::read_to_string(&log_path).unwrap();
        assert!(text.contains("[info] hello-log"));
        assert!(text.contains("===== 应用启动 ====="));
        assert!(path().is_some());
        let _ = fs::remove_dir_all(&dir);
    }
}
