use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread,
};

// 日志写入线程：WebView2 回调只做入队，文件 IO 与 flush 全部在后台线程完成。
// 50ms 批量窗口在"减少 write 次数"与"强杀时的丢失窗口"之间取平衡。
const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
const FORCE_FLUSH_BYTES: usize = 64 * 1024;
const FORCE_FLUSH_LINES: usize = 200;
// 同时打开的文件句柄上限，超过时按最近最少使用淘汰单个句柄。
const MAX_OPEN_FILES: usize = 64;
// 写入错误上报的最小间隔，避免刷屏同时不再永久静默。
const ERROR_REPORT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

enum Command {
    Append {
        path: PathBuf,
        line: String,
    },
    // reply 用于把清空结果同步返回给调用方（用户点击操作，允许短暂等待）。
    ClearAll {
        root: PathBuf,
        reply: Option<std::sync::mpsc::Sender<usize>>,
    },
    ClearPath {
        path: PathBuf,
    },
    Shutdown,
}

enum Poll {
    Command(Command),
    Idle,
    Stop,
}

struct State {
    queue: VecDeque<Command>,
    dropped: u64,
    shutting_down: bool,
}

pub struct LogWriter {
    state: Mutex<State>,
    cvar: Condvar,
    limit: usize,
}

static WRITER: OnceLock<Arc<LogWriter>> = OnceLock::new();
// 保存写入线程句柄，退出时等待其完成 flush，避免进程退出丢缓冲。
static WRITER_HANDLE: OnceLock<Mutex<Option<thread::JoinHandle<()>>>> = OnceLock::new();
const SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

impl LogWriter {
    fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                dropped: 0,
                shutting_down: false,
            }),
            cvar: Condvar::new(),
            limit: limit.max(1),
        })
    }

    // 队列满时淘汰最旧的 Append，保留最新现场；控制命令不参与淘汰。
    fn push(&self, command: Command) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "日志写入队列锁不可用".to_string())?;
        if state.shutting_down {
            return Err("日志写入已停止".into());
        }
        if state.queue.len() >= self.limit {
            if matches!(command, Command::Append { .. }) {
                // 常见路径：队首即最旧日志，O(1) 淘汰。
                if matches!(state.queue.front(), Some(Command::Append { .. })) {
                    state.queue.pop_front();
                    state.dropped += 1;
                } else if let Some(index) = state
                    .queue
                    .iter()
                    .position(|entry| matches!(entry, Command::Append { .. }))
                {
                    state.queue.remove(index);
                    state.dropped += 1;
                }
                if state.dropped == 1 || state.dropped % 1000 == 0 {
                    eprintln!(
                        "[request-log] 写入队列达到上限({})，已丢弃最旧日志 累计={}",
                        self.limit, state.dropped
                    );
                }
                // 队列被控制命令占满、没有可淘汰的 Append 时丢弃当前日志，避免无界增长。
                if state.queue.len() >= self.limit {
                    state.dropped += 1;
                    return Ok(());
                }
            } else if state.queue.len() >= self.limit.saturating_mul(2) {
                // 控制命令同样设上限，避免极端情况下队列无界增长。
                return Err("日志写入队列拥塞".into());
            }
        }
        state.queue.push_back(command);
        self.cvar.notify_one();
        Ok(())
    }

    fn next(&self) -> Poll {
        let mut state = match self.state.lock() {
            Ok(guard) => guard,
            Err(_) => return Poll::Stop,
        };
        loop {
            if let Some(command) = state.queue.pop_front() {
                return Poll::Command(command);
            }
            if state.shutting_down {
                return Poll::Stop;
            }
            let (next, timeout) = match self.cvar.wait_timeout(state, FLUSH_INTERVAL) {
                Ok(value) => value,
                Err(_) => return Poll::Stop,
            };
            state = next;
            if timeout.timed_out() && state.queue.is_empty() {
                return Poll::Idle;
            }
        }
    }

    fn begin_shutdown(&self) {
        // 直接操作队列状态，避免持锁再次调用 push 造成重复加锁。
        if let Ok(mut state) = self.state.lock() {
            state.shutting_down = true;
            state.queue.push_back(Command::Shutdown);
        }
        self.cvar.notify_all();
    }
}

// 单个已打开日志文件：记录最近使用序号用于 LRU 淘汰。
struct OpenFile {
    buffer: BufWriter<fs::File>,
    last_used: u64,
}

// 写入错误按时间节流上报，并携带累计次数，避免首次报错后永久静默。
struct ErrorReport {
    last_at: Option<std::time::Instant>,
    total: u64,
}

impl ErrorReport {
    fn new() -> Self {
        Self {
            last_at: None,
            total: 0,
        }
    }

    fn report(&mut self, message: &str) {
        self.total += 1;
        let now = std::time::Instant::now();
        let due = self
            .last_at
            .is_none_or(|last| now.saturating_duration_since(last) >= ERROR_REPORT_INTERVAL);
        if due {
            self.last_at = Some(now);
            eprintln!("[request-log] {message}（累计 {} 次）", self.total);
        }
    }
}

type OpenFiles = HashMap<PathBuf, OpenFile>;

fn flush_all(files: &mut OpenFiles, errors: &mut ErrorReport) {
    for (path, entry) in files.iter_mut() {
        if entry.buffer.flush().is_err() {
            errors.report(&format!("刷新日志失败: {}", path.display()));
        }
    }
}

fn close_all(files: &mut OpenFiles, errors: &mut ErrorReport) {
    flush_all(files, errors);
    files.clear();
}

// 按最近使用时间淘汰单个句柄，避免句柄上限时整体关闭重开导致抖动。
fn evict_lru(files: &mut OpenFiles, errors: &mut ErrorReport) {
    let Some(oldest) = files
        .iter()
        .min_by_key(|(_, entry)| entry.last_used)
        .map(|(path, _)| path.clone())
    else {
        return;
    };
    if let Some(mut entry) = files.remove(&oldest) {
        if entry.buffer.flush().is_err() {
            errors.report(&format!("刷新日志失败: {}", oldest.display()));
        }
    }
}

fn write_line(
    files: &mut OpenFiles,
    path: &Path,
    line: &str,
    seq: &mut u64,
    errors: &mut ErrorReport,
) {
    *seq += 1;
    if let Some(entry) = files.get_mut(path) {
        entry.last_used = *seq;
        if writeln!(entry.buffer, "{line}").is_err() {
            files.remove(path);
            errors.report(&format!("写入日志失败: {}", path.display()));
        }
        return;
    }
    if files.len() >= MAX_OPEN_FILES {
        evict_lru(files, errors);
    }
    match fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => {
            let mut buffer = BufWriter::with_capacity(16 * 1024, file);
            if writeln!(buffer, "{line}").is_err() {
                errors.report(&format!("写入日志失败: {}", path.display()));
                return;
            }
            files.insert(
                path.to_path_buf(),
                OpenFile {
                    buffer,
                    last_used: *seq,
                },
            );
        }
        Err(_) => errors.report(&format!("打开日志文件失败: {}", path.display())),
    }
}

fn truncate_all_under(root: &Path) -> usize {
    let mut removed = 0;
    let Ok(entries) = fs::read_dir(root) else {
        return removed;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let file = entry.path().join("requests.log");
        if file.is_file() && fs::write(&file, []).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn run(writer: Arc<LogWriter>) {
    let mut files: OpenFiles = HashMap::new();
    let mut pending_bytes = 0usize;
    let mut pending_lines = 0usize;
    let mut seq = 0u64;
    let mut errors = ErrorReport::new();
    loop {
        match writer.next() {
            Poll::Command(Command::Append { path, line }) => {
                pending_bytes += line.len();
                pending_lines += 1;
                write_line(&mut files, &path, &line, &mut seq, &mut errors);
                if pending_bytes >= FORCE_FLUSH_BYTES || pending_lines >= FORCE_FLUSH_LINES {
                    flush_all(&mut files, &mut errors);
                    pending_bytes = 0;
                    pending_lines = 0;
                }
            }
            Poll::Command(Command::ClearAll { root, reply }) => {
                close_all(&mut files, &mut errors);
                let removed = truncate_all_under(&root);
                if let Some(sender) = reply {
                    let _ = sender.send(removed);
                } else {
                    eprintln!("[request-log] clear_all files={removed} ok");
                }
                pending_bytes = 0;
                pending_lines = 0;
            }
            Poll::Command(Command::ClearPath { path }) => {
                // 丢弃未写缓冲而不落盘，避免"先 flush 再清空"的无谓写入。
                if let Some(entry) = files.remove(&path) {
                    let (_file, _pending) = entry.buffer.into_parts();
                }
                if fs::write(&path, []).is_err() {
                    errors.report(&format!("清空日志失败: {}", path.display()));
                }
            }
            Poll::Command(Command::Shutdown) => {
                flush_all(&mut files, &mut errors);
                break;
            }
            Poll::Idle => {
                if pending_bytes > 0 || pending_lines > 0 {
                    flush_all(&mut files, &mut errors);
                    pending_bytes = 0;
                    pending_lines = 0;
                }
            }
            Poll::Stop => {
                flush_all(&mut files, &mut errors);
                break;
            }
        }
    }
}

// 启动后台写入线程；重复调用无副作用。
pub fn start(queue_limit: usize) {
    if WRITER.get().is_some() {
        return;
    }
    let writer = LogWriter::new(queue_limit);
    let worker = writer.clone();
    match thread::Builder::new()
        .name("request-log-writer".into())
        .spawn(move || run(worker))
    {
        Ok(handle) => {
            if WRITER.set(writer).is_ok() {
                let _ = WRITER_HANDLE.set(Mutex::new(Some(handle)));
            }
        }
        Err(error) => eprintln!("[request-log] 启动写入线程失败: {error}"),
    }
}

pub fn append(path: &Path, line: String) -> Result<(), String> {
    match WRITER.get() {
        Some(writer) => writer.push(Command::Append {
            path: path.to_path_buf(),
            line,
        }),
        // 未启动写入线程时退化为同步写，保证日志不丢。
        None => {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|e| e.to_string())?;
            writeln!(file, "{line}").map_err(|e| e.to_string())
        }
    }
}

pub fn clear_all(root: &Path) -> Result<usize, String> {
    match WRITER.get() {
        Some(writer) => {
            let (reply, receiver) = std::sync::mpsc::channel();
            writer.push(Command::ClearAll {
                root: root.to_path_buf(),
                reply: Some(reply),
            })?;
            receiver
                .recv_timeout(std::time::Duration::from_secs(2))
                .map_err(|_| "清空日志超时".to_string())
        }
        None => Ok(truncate_all_under(root)),
    }
}

pub fn clear_path(path: &Path) -> Result<(), String> {
    match WRITER.get() {
        Some(writer) => writer.push(Command::ClearPath {
            path: path.to_path_buf(),
        }),
        None => fs::write(path, []).map_err(|e| e.to_string()),
    }
}

pub fn shutdown() {
    if let Some(writer) = WRITER.get() {
        writer.begin_shutdown();
    }
    // 等待写入线程把缓冲落盘；带超时，避免线程异常时卡住退出流程。
    let Some(slot) = WRITER_HANDLE.get() else {
        return;
    };
    // 只在取出句柄时持锁，等待期间不占用锁。
    let handle = {
        let Ok(mut guard) = slot.lock() else {
            return;
        };
        guard.take()
    };
    let Some(handle) = handle else {
        return;
    };
    let deadline = std::time::Instant::now() + SHUTDOWN_WAIT;
    while !handle.is_finished() && std::time::Instant::now() < deadline {
        thread::sleep(std::time::Duration::from_millis(10));
    }
    if handle.is_finished() {
        let _ = handle.join();
    } else {
        eprintln!("[request-log] 写入线程未在超时内结束，可能有日志未落盘");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        // 与既有测试一致，落在项目 target 下，避免系统临时目录权限限制。
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-evidence")
            .join(format!("log-writer-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir.join(name)
    }

    #[test]
    fn lru_eviction_removes_single_oldest_handle() {
        let base = temp_path("lru.log");
        let dir = base.parent().expect("parent").to_path_buf();
        let mut files: OpenFiles = HashMap::new();
        let mut errors = ErrorReport::new();
        for index in 0..3u64 {
            let path = dir.join(format!("f{index}.log"));
            let file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .expect("open");
            files.insert(
                path,
                OpenFile {
                    buffer: BufWriter::new(file),
                    last_used: index,
                },
            );
        }
        evict_lru(&mut files, &mut errors);
        // 只关闭最久未使用的一个句柄，其余保持打开，避免整体抖动。
        assert_eq!(files.len(), 2);
        assert!(!files.contains_key(&dir.join("f0.log")));
        assert!(files.contains_key(&dir.join("f2.log")));
        drop(files);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn queue_overflow_drops_oldest_and_keeps_newest() {
        let writer = LogWriter::new(4);
        for index in 0..6 {
            writer
                .push(Command::Append {
                    path: PathBuf::from(format!("p{index}")),
                    line: format!("line-{index}"),
                })
                .expect("push");
        }
        let state = writer.state.lock().expect("lock");
        let lines: Vec<String> = state
            .queue
            .iter()
            .map(|entry| match entry {
                Command::Append { line, .. } => line.clone(),
                _ => String::new(),
            })
            .collect();
        // 保留最新 4 条，最旧 2 条被淘汰。
        assert_eq!(lines, ["line-2", "line-3", "line-4", "line-5"]);
        assert_eq!(state.dropped, 2);
    }

    #[test]
    fn control_commands_are_not_evicted() {
        let writer = LogWriter::new(2);
        writer
            .push(Command::ClearAll {
                root: PathBuf::from("root"),
                reply: None,
            })
            .expect("push clear");
        for index in 0..4 {
            writer
                .push(Command::Append {
                    path: PathBuf::from("p"),
                    line: format!("line-{index}"),
                })
                .expect("push");
        }
        let state = writer.state.lock().expect("lock");
        assert!(state
            .queue
            .iter()
            .any(|entry| matches!(entry, Command::ClearAll { .. })));
    }

    #[test]
    fn worker_writes_batched_lines_and_flushes_on_shutdown() {
        let path = temp_path("requests.log");
        let writer = LogWriter::new(64);
        let worker = writer.clone();
        let handle = std::thread::spawn(move || run(worker));
        for index in 0..5 {
            writer
                .push(Command::Append {
                    path: path.clone(),
                    line: format!("line-{index}"),
                })
                .expect("push");
        }
        writer.begin_shutdown();
        handle.join().expect("join writer");
        let text = std::fs::read_to_string(&path).expect("read log");
        assert_eq!(text.lines().count(), 5);
        assert!(text.starts_with("line-0"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap_or(Path::new(".")));
    }

    #[test]
    fn clear_path_truncates_existing_file() {
        let path = temp_path("clear.log");
        let writer = LogWriter::new(64);
        let worker = writer.clone();
        let handle = std::thread::spawn(move || run(worker));
        writer
            .push(Command::Append {
                path: path.clone(),
                line: "before".into(),
            })
            .expect("push");
        std::thread::sleep(FLUSH_INTERVAL * 2);
        writer
            .push(Command::ClearPath { path: path.clone() })
            .expect("clear");
        std::thread::sleep(FLUSH_INTERVAL * 2);
        writer.begin_shutdown();
        handle.join().expect("join writer");
        let text = std::fs::read_to_string(&path).expect("read log");
        assert!(!text.contains("before"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap_or(Path::new(".")));
    }
}
