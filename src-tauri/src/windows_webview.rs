use crate::{config::Site, request_log};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use webview2_com::{
    take_pwstr, BasicAuthenticationRequestedEventHandler,
    CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler,
    Microsoft::Web::WebView2::Win32::*, NavigationCompletedEventHandler,
    NavigationStartingEventHandler,
};
use windows::core::{Interface, HSTRING, PWSTR};

struct Request {
    url: String,
    method: String,
    resource_type: String,
    started: Instant,
    encoded_length: Option<u64>,
}

// 单次响应体抓取的决策：只在完成时发起，且提前排除过大响应。
#[derive(Debug, PartialEq)]
enum BodyCapture {
    Fetch,
    Skip(String),
}

// 超过该倍数上限的响应不取回正文，仅记录跳过原因；取回动作是整包解码，代价随体积线性增长。
const BODY_FETCH_SAFETY_FACTOR: usize = 64;
const MAX_PENDING_BODY_CAPTURES: usize = 32;

fn truncate_response_text(body: &str, base64: bool, max_bytes: usize) -> String {
    if base64 {
        // 只需前若干个 base64 字符即可解出上限字节，避免解码整包。
        let take = max_bytes.div_ceil(3) * 4;
        let slice = body.get(..take.min(body.len())).unwrap_or("");
        let bytes = base64_decode_prefix(slice);
        let clipped = body.len() > slice.len() || bytes.len() > max_bytes;
        let out = bytes
            .get(..max_bytes.min(bytes.len()))
            .unwrap_or(&bytes)
            .to_vec();
        let encoded = base64_encode(&out);
        return if clipped {
            format!("base64:{encoded}...[truncated]")
        } else {
            format!("base64:{encoded}")
        };
    }
    let mut end = max_bytes.min(body.len());
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    let clipped = body.len() > end;
    let mut text = body.get(..end).unwrap_or("").to_string();
    if clipped {
        text.push_str("...[truncated]");
    }
    text
}

fn base64_decode_prefix(text: &str) -> Vec<u8> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (index, byte) in TABLE.iter().enumerate() {
        lookup[*byte as usize] = index as u8;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let value = lookup[byte as usize];
        if value == 255 {
            return out;
        }
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let value = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(value >> 18) as usize & 63] as char);
        out.push(TABLE[(value >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(value >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[value as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

struct NetworkLog {
    path: PathBuf,
    label: String,
    pending: HashMap<String, Request>,
    max_response_size: usize,
    write_failed: bool,
}

impl NetworkLog {
    fn write(&mut self, record: Value) {
        if request_log::append(&self.path, record).is_err() && !self.write_failed {
            self.write_failed = true;
            eprintln!(
                "[request-log] native metadata write failed: label={}",
                self.label
            );
        }
    }

    fn terminal(&mut self, id: &str, event: &str, error: Option<&str>) {
        if let Some(request) = self.pending.remove(id) {
            self.write(json!({
                "event": event, "label": self.label, "requestId": id,
                "method": request.method, "url": request.url,
                "resourceType": request.resource_type,
                "durationMs": request.started.elapsed().as_millis(), "error": error,
            }));
        }
    }

    // 提前用响应长度判断是否值得取回正文；取回是整包解码，超大响应直接跳过。
    fn body_capture_decision(&self, encoded_length: Option<u64>) -> BodyCapture {
        let safety = self
            .max_response_size
            .saturating_mul(BODY_FETCH_SAFETY_FACTOR)
            .max(1024 * 1024);
        match encoded_length {
            Some(length) if length as usize > safety => {
                BodyCapture::Skip(format!("response body too large ({length} bytes)"))
            }
            _ => BodyCapture::Fetch,
        }
    }

    // 返回需要异步抓取响应体的决策；方法本身不等待 IO，保证网络事件回调快速返回。
    fn receive(&mut self, event: &str, params: &Value) -> Option<BodyCapture> {
        let id = params["requestId"].as_str().filter(|id| id.len() <= 128)?;
        match event {
            "Network.requestWillBeSent" => {
                if !matches!(params["type"].as_str(), Some("XHR" | "Fetch")) {
                    return None;
                }
                let url = params["request"]["url"].as_str()?;
                let expired: Vec<_> = self
                    .pending
                    .iter()
                    .filter(|(_, r)| r.started.elapsed() >= Duration::from_secs(60))
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in expired {
                    self.terminal(&id, "timeout", Some("request timeout"));
                }
                if self.pending.contains_key(id) {
                    self.terminal(id, "redirected", None);
                }
                if self.pending.len() >= 4096 {
                    self.write(json!({"event":"backpressure", "label":self.label,
                        "error":"pending metadata limit reached"}));
                    return None;
                }
                let method = params["request"]["method"]
                    .as_str()
                    .filter(|s| s.len() <= 16 && s.chars().all(|c| c.is_ascii_uppercase()))
                    .unwrap_or("OTHER")
                    .to_string();
                let resource_type = if params["type"] == "XHR" {
                    "xhr"
                } else {
                    "fetch"
                }
                .to_string();
                let url = request_log::sanitized_url(url);
                self.write(json!({"event":"request", "label":self.label,
                    "requestId":id, "method":method, "url":url, "resourceType":resource_type}));
                self.pending.insert(
                    id.into(),
                    Request {
                        url,
                        method,
                        resource_type,
                        started: Instant::now(),
                        encoded_length: None,
                    },
                );
                None
            }
            "Network.responseReceived" => {
                let status = params["response"]["status"].as_f64();
                let encoded = params["response"]["encodedDataLength"].as_u64();
                let request = self.pending.get_mut(id)?;
                if encoded.is_some() {
                    request.encoded_length = encoded;
                }
                let record = json!({"event":"response", "label":self.label,
                    "requestId":id, "url":request.url, "method":request.method,
                    "resourceType":request.resource_type, "statusCode":status,
                    "durationMs":request.started.elapsed().as_millis()});
                self.write(record);
                None
            }
            "Network.loadingFinished" => {
                let request = self.pending.get(id)?;
                let decision = self.body_capture_decision(request.encoded_length);
                self.terminal(id, "completed", None);
                Some(decision)
            }
            "Network.loadingFailed" => {
                let error = params["errorText"].as_str().unwrap_or("");
                let safe_error = if error.starts_with("net::ERR_")
                    && error.len() < 100
                    && error[9..]
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c == '_')
                {
                    error
                } else {
                    "request failed"
                };
                let event = if params["canceled"] == true {
                    "cancelled"
                } else {
                    "error"
                };
                self.terminal(id, event, Some(safe_error));
                None
            }
            _ => None,
        }
    }
}

struct BodyCaptureContext {
    core: ICoreWebView2,
    path: PathBuf,
    label: String,
    max_response_size: usize,
    // 按 requestId 记录在途读取及其开始时间：回调未触发的条目超时后可回收，不会永久占满配额。
    inflight: Rc<RefCell<HashMap<String, Instant>>>,
}

const RESPONSE_BODY_INFLIGHT_TIMEOUT: Duration = Duration::from_secs(10);

// 回收超时未回调的在途读取；CDP 回调永不触发时不会永久占用并发配额。
fn prune_inflight(inflight: &mut HashMap<String, Instant>, now: Instant) {
    inflight.retain(|_, started| {
        now.saturating_duration_since(*started) < RESPONSE_BODY_INFLIGHT_TIMEOUT
    });
}

// 响应体只在请求完成后异步读取：读取失败或跳过都写一条可检索记录，不影响页面请求。
fn capture_response_body(
    context: &Rc<BodyCaptureContext>,
    request_id: &str,
    decision: BodyCapture,
) {
    if let BodyCapture::Skip(reason) = decision {
        let _ = request_log::append(
            &context.path,
            json!({"event":"responseBody", "label":context.label,
                "requestId":request_id, "skipped":reason}),
        );
        return;
    }
    let over_limit = {
        let mut inflight = context.inflight.borrow_mut();
        let now = Instant::now();
        prune_inflight(&mut inflight, now);
        if inflight.len() >= MAX_PENDING_BODY_CAPTURES {
            true
        } else {
            inflight.insert(request_id.to_string(), now);
            false
        }
    };
    if over_limit {
        let _ = request_log::append(
            &context.path,
            json!({"event":"responseBody", "label":context.label,
                "requestId":request_id, "skipped":"too many concurrent response body reads"}),
        );
        return;
    }
    let Ok(params) = serde_json::to_string(&json!({"requestId": request_id})) else {
        context.inflight.borrow_mut().remove(request_id);
        return;
    };
    let path = context.path.clone();
    let label = context.label.clone();
    let max_bytes = context.max_response_size;
    let inflight = context.inflight.clone();
    let request = request_id.to_string();
    let handler =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, body| {
            inflight.borrow_mut().remove(&request);
            let record = if result.is_err() {
                json!({"event":"responseBody", "label":label, "requestId":request,
                    "skipped":"response body unavailable"})
            } else {
                match serde_json::from_str::<Value>(&body) {
                    Ok(value) => match value["body"].as_str() {
                        Some(text) => {
                            let base64 = value["base64Encoded"].as_bool().unwrap_or(false);
                            json!({"event":"responseBody", "label":label, "requestId":request,
                                "responseBody":truncate_response_text(text, base64, max_bytes)})
                        }
                        None => json!({"event":"responseBody", "label":label,
                            "requestId":request, "skipped":"response body unavailable"}),
                    },
                    Err(_) => json!({"event":"responseBody", "label":label, "requestId":request,
                        "skipped":"response body decode failed"}),
                }
            };
            let _ = request_log::append(&path, record);
            Ok(())
        }));
    let sent = unsafe {
        context.core.CallDevToolsProtocolMethod(
            &HSTRING::from("Network.getResponseBody"),
            &HSTRING::from(params),
            &handler,
        )
    };
    if sent.is_err() {
        context.inflight.borrow_mut().remove(request_id);
        let _ = request_log::append(
            &context.path,
            json!({"event":"responseBody", "label":context.label,
                "requestId":request_id, "skipped":"response body request failed"}),
        );
    }
}

impl Drop for NetworkLog {
    fn drop(&mut self) {
        let ids: Vec<_> = self.pending.keys().cloned().collect();
        for id in ids {
            self.terminal(&id, "cancelled", Some("webview closed"));
        }
    }
}

fn emit(app: &tauri::AppHandle, label: &str, event: &str, error: &str) {
    if app
        .emit_to(
            "shell",
            "native-view",
            json!({
                "label":label, "event":event, "error":error,
            }),
        )
        .is_err()
    {
        eprintln!("[native-view] event delivery failed: label={label} event={event}");
    }
}

// 在 about:blank 创建后调用；完成 Network.enable 后才导航，避免丢失首屏请求。
pub fn attach(
    view: &tauri::Webview,
    site: Site,
    log_path: PathBuf,
    initial_url: tauri::Url,
    max_response_size: usize,
) -> Result<(), String> {
    let app = view.app_handle().clone();
    let label = view.label().to_string();
    view.with_webview(move |native| {
        let result = unsafe {
            install(
                native.controller().CoreWebView2(),
                site,
                log_path,
                &app,
                &label,
                &initial_url,
                max_response_size,
            )
        };
        if let Err(error) = result {
            let message = format!(
                "Windows browser hook registration failed ({:#x})",
                error.code().0
            );
            eprintln!("[native-view] {message}: label={label}");
            emit(&app, &label, "hook-error", &message);
            navigate(&app, &label, initial_url);
        }
    })
    .map_err(|_| "无法调度 Windows 浏览器 hook 注册".to_string())
}

fn navigate(app: &tauri::AppHandle, label: &str, url: tauri::Url) {
    if let Some(view) = app.get_webview(label) {
        if view.navigate(url).is_err() {
            emit(app, label, "hook-error", "原生浏览器初始导航失败");
        }
    }
}

unsafe fn install(
    core: windows::core::Result<ICoreWebView2>,
    site: Site,
    log_path: PathBuf,
    app: &tauri::AppHandle,
    label: &str,
    initial_url: &tauri::Url,
    max_response_size: usize,
) -> windows::core::Result<()> {
    let core = core?;
    unsafe {
        let settings = core.Settings()?;
        settings.SetAreDevToolsEnabled(true)?;
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(true)?;
    }
    let auth_attempted = Rc::new(Cell::new(false));
    let attempted = auth_attempted.clone();
    let Site {
        url: auth_url,
        user,
        password,
        ..
    } = site;
    let auth_app = app.clone();
    let auth_label = label.to_string();
    let auth = BasicAuthenticationRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut uri = PWSTR::null();
        unsafe {
            args.Uri(&mut uri)?;
        }
        let uri = take_pwstr(uri);
        if user.is_empty() || !crate::config::same_origin(&auth_url, &uri) {
            return Ok(());
        }
        if attempted.replace(true) {
            emit(
                &auth_app,
                &auth_label,
                "auth-fallback",
                "自动认证未通过，请使用原生认证对话框",
            );
            return Ok(());
        }
        let result = unsafe {
            args.Response().and_then(|response| {
                response.SetUserName(&HSTRING::from(user.as_str()))?;
                response.SetPassword(&HSTRING::from(password.as_str()))
            })
        };
        if result.is_err() {
            emit(&auth_app, &auth_label, "auth-error", "无法填入原生认证凭据");
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe {
        core.cast::<ICoreWebView2_10>()?
            .add_BasicAuthenticationRequested(&auth, &mut token)?;
    }

    let navigations = Rc::new(RefCell::new(HashMap::<u64, String>::new()));
    let starts = navigations.clone();
    let starting = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut id = 0;
        let mut uri = PWSTR::null();
        unsafe {
            args.NavigationId(&mut id)?;
            args.Uri(&mut uri)?;
        }
        let url = request_log::sanitized_url(&take_pwstr(uri));
        auth_attempted.set(false);
        let mut starts = starts.borrow_mut();
        if starts.len() >= 64 {
            starts.clear();
        }
        starts.insert(id, url);
        Ok(())
    }));
    unsafe {
        core.add_NavigationStarting(&starting, &mut token)?;
    }

    let network = Rc::new(RefCell::new(NetworkLog {
        path: log_path.clone(),
        label: label.to_string(),
        pending: HashMap::new(),
        max_response_size,
        write_failed: false,
    }));
    // 响应体读取全部走异步 CDP 回调，网络事件线程不等待正文。
    let capture = Rc::new(BodyCaptureContext {
        core: core.clone(),
        path: log_path,
        label: label.to_string(),
        max_response_size,
        inflight: Rc::new(RefCell::new(HashMap::new())),
    });
    let mut receivers = Vec::new();
    for event in [
        "Network.requestWillBeSent",
        "Network.responseReceived",
        "Network.loadingFinished",
        "Network.loadingFailed",
    ] {
        let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event))? };
        let log = network.clone();
        let body_capture = capture.clone();
        let handler =
            DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut raw = PWSTR::null();
                unsafe {
                    args.ParameterObjectAsJson(&mut raw)?;
                }
                // CDP 原始数据可能包含凭据，只输出白名单元数据。
                if let Ok(params) = serde_json::from_str::<Value>(&take_pwstr(raw)) {
                    let request_id = params["requestId"].as_str().unwrap_or_default().to_string();
                    let decision = log.borrow_mut().receive(event, &params);
                    if let Some(decision) = decision {
                        if !request_id.is_empty() {
                            capture_response_body(&body_capture, &request_id, decision);
                        }
                    }
                }
                Ok(())
            }));
        unsafe {
            receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)?;
        }
        receivers.push(receiver);
    }

    let fail_app = app.clone();
    let fail_label = label.to_string();
    let completed = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
        // 接收器随浏览器事件监听存活，避免局部注册结束后丢失 Network 事件。
        let _receivers = &receivers;
        let Some(args) = args else { return Ok(()) };
        let mut success = windows::core::BOOL::default();
        let mut id = 0;
        unsafe {
            args.IsSuccess(&mut success)?;
            args.NavigationId(&mut id)?;
        }
        let saved = navigations.borrow_mut().remove(&id);
        if success.as_bool() {
            return Ok(());
        }
        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
        unsafe {
            args.WebErrorStatus(&mut status)?;
        }
        if status == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED
            || status == COREWEBVIEW2_WEB_ERROR_STATUS_VALID_AUTHENTICATION_CREDENTIALS_REQUIRED
            || status == COREWEBVIEW2_WEB_ERROR_STATUS_VALID_PROXY_AUTHENTICATION_REQUIRED
        {
            return Ok(());
        }
        let url = match saved {
            Some(url) => url,
            None => {
                let mut uri = PWSTR::null();
                if let Some(sender) = sender {
                    unsafe {
                        sender.Source(&mut uri)?;
                    }
                }
                request_log::sanitized_url(&take_pwstr(uri))
            }
        };
        let description = format!("WebView2 navigation failed (status {})", status.0);
        if fail_app
            .emit_to(
                "shell",
                "native-view",
                json!({
                    "label":fail_label, "event":"did-fail-load", "url":url,
                    "error":description, "errorCode":-1000-status.0,
                    "errorDescription":description, "isMainFrame":true,
                }),
            )
            .is_err()
        {
            eprintln!("[native-view] navigation failure delivery failed: label={fail_label}");
        }
        Ok(())
    }));
    unsafe {
        core.add_NavigationCompleted(&completed, &mut token)?;
    }

    let ready_app = app.clone();
    let ready_label = label.to_string();
    let target_url = initial_url.clone();
    let ready = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
        if result.is_ok() {
            emit(&ready_app, &ready_label, "hook-ready", "");
        } else {
            emit(
                &ready_app,
                &ready_label,
                "hook-error",
                "无法启用原生网络元数据采集",
            );
        }
        navigate(&ready_app, &ready_label, target_url);
        Ok(())
    }));
    unsafe {
        core.CallDevToolsProtocolMethod(
            &HSTRING::from("Network.enable"),
            &HSTRING::from("{}"),
            &ready,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_metadata_excludes_payload_and_preserves_terminal_events() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-evidence");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("devops-native-{}-{stamp}.log", std::process::id()));
        let mut log = NetworkLog {
            path: path.clone(),
            label: "native-1".into(),
            pending: HashMap::new(),
            max_response_size: 1024,
            write_failed: false,
        };
        let start = json!({"requestId":"7", "type":"Fetch", "request":{
            "url":"https://user:private@a.test/api?token=private#private",
            "method":"POST", "headers":{"Authorization":"private"}, "postData":"private"}});
        assert_eq!(log.receive("Network.requestWillBeSent", &start), None);
        log.receive(
            "Network.responseReceived",
            &json!({"requestId":"7", "response":{"status":200,"headers":{"Set-Cookie":"private"}}}),
        );
        assert_eq!(
            log.receive("Network.loadingFinished", &json!({"requestId":"7"})),
            Some(BodyCapture::Fetch)
        );
        log.receive("Network.requestWillBeSent", &start);
        let _ = log.receive(
            "Network.loadingFailed",
            &json!({"requestId":"7", "errorText":"failed at https://private"}),
        );
        assert!(log.pending.is_empty());
        let lines = std::fs::read_to_string(&path).unwrap();
        assert!(!lines.contains("private"));
        assert!(!lines.contains("headers"));
        assert!(!lines.contains("postData"));
        let records: Vec<Value> = lines
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let events: Vec<_> = records
            .iter()
            .map(|r| r["event"]["event"].as_str().unwrap())
            .collect();
        assert_eq!(
            events,
            ["request", "response", "completed", "request", "error"]
        );
        assert_eq!(records[0]["event"]["url"], "https://a.test/api");
        assert_eq!(records[1]["event"]["statusCode"], 200.0);
        assert_eq!(records[4]["event"]["error"], "request failed");
        drop(log);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn response_body_is_truncated_at_byte_limit() {
        let text = "abcdefghij";
        assert_eq!(truncate_response_text(text, false, 4), "abcd...[truncated]");
        assert_eq!(truncate_response_text(text, false, 10), "abcdefghij");
        // 中文按 UTF-8 边界截断，不产生半个字符；未完整收录时带截断标记。
        assert_eq!(
            truncate_response_text("中文内容", false, 4),
            "中...[truncated]"
        );
        assert_eq!(
            truncate_response_text("中文内容", false, 9),
            "中文内...[truncated]"
        );
        assert_eq!(truncate_response_text("中文内容", false, 1024), "中文内容");
        // base64 只解码前缀并重新编码，超过上限时带截断标记。
        let decoded = base64_decode_prefix("aGVsbG8gd29ybGQ=");
        assert_eq!(decoded, b"hello world");
        let clipped = truncate_response_text("aGVsbG8gd29ybGQ=", true, 5);
        assert!(clipped.starts_with("base64:"));
        assert!(clipped.ends_with("...[truncated]"));
        let kept = truncate_response_text(&base64_encode(b"ok"), true, 1024);
        assert_eq!(kept, "base64:b2s=");
    }

    #[test]
    fn oversized_response_skips_body_capture() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-evidence");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!(
            "devops-native-skip-{}-{stamp}.log",
            std::process::id()
        ));
        let mut log = NetworkLog {
            path: path.clone(),
            label: "native-2".into(),
            pending: HashMap::new(),
            max_response_size: 1024,
            write_failed: false,
        };
        let start = json!({"requestId":"9", "type":"XHR", "request":{
            "url":"https://a.test/api", "method":"GET"}});
        let _ = log.receive("Network.requestWillBeSent", &start);
        let _ = log.receive(
            "Network.responseReceived",
            &json!({"requestId":"9", "response":{"status":200,"encodedDataLength":900000000}}),
        );
        let decision = log.receive("Network.loadingFinished", &json!({"requestId":"9"}));
        assert!(
            matches!(decision, Some(BodyCapture::Skip(ref reason)) if reason.contains("too large")),
            "unexpected decision: {decision:?}"
        );
        drop(log);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stale_inflight_bodies_are_reclaimed() {
        let now = Instant::now();
        let mut inflight = HashMap::new();
        let stale = now
            .checked_sub(RESPONSE_BODY_INFLIGHT_TIMEOUT + Duration::from_secs(1))
            .expect("time subtraction");
        for index in 0..40 {
            inflight.insert(format!("stale-{index}"), stale);
        }
        inflight.insert("fresh".into(), now);
        prune_inflight(&mut inflight, now);
        // 超时条目全部回收，只保留仍在等待回调的读取。
        assert_eq!(inflight.len(), 1);
        assert!(inflight.contains_key("fresh"));
        // 回收后并发配额重新可用。
        assert!(inflight.len() < MAX_PENDING_BODY_CAPTURES);
    }
}
