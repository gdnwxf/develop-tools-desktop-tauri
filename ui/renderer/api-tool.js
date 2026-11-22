// api-tool.js -- 接口调试弹窗:左侧请求/返回,右侧当前视图日志里的请求列表(不含 OPTIONS)
// 列表来自该视图的请求日志;点选回填方法/地址/请求头(日志抓到的头可复用);
// 发送由 Rust 侧在页面内 fetch(复用登录态),结果单独写 logs/api-tool/<group>/<site>/requests.log。

let apiToolLabel = '';
let apiToolKeywordTimer = null;
const DEFAULT_HEADERS_TEXT = '{\n  "Content-Type": "application/json"\n}';

function prettyJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (error) { return String(text || ''); }
}

function setApiToolStatus(text, kind) {
  apiToolStatus.textContent = text || '';
  apiToolStatus.className = 'apitool-status' + (kind ? ' ' + kind : '');
}

function setApiToolResponse(text) {
  apiToolResponse.textContent = text || '';
}

/* 清空容器(真实 DOM 与测试替身都支持:逐个移除子节点) */
function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  if (!node.firstChild) node.innerHTML = '';
}

function showApiToolMessage(text) {
  clearNode(apiToolList);
  const box = document.createElement('div');
  box.className = 'apitool-empty';
  box.textContent = text;
  apiToolList.appendChild(box);
}

function showApiToolDialog(site) {
  if (!site) return;
  const view = webviews[site.id];
  apiToolLabel = view && view.label ? view.label : (window.desktopApp.currentViewLabel ? window.desktopApp.currentViewLabel() : '');
  if (!apiToolLabel) {
    log('[api-tool] 打开失败:', site.name, '没有已打开的视图');
    return;
  }
  apiToolTag.textContent = site.name + ' · ' + apiToolLabel;
  setApiToolStatus('');
  setApiToolResponse('');
  if (!apiToolHeaders.value.trim()) apiToolHeaders.value = DEFAULT_HEADERS_TEXT;
  apiToolDialog.hidden = false;
  loadApiToolRequests();
}

function hideApiToolDialog() {
  apiToolDialog.hidden = true;
  if (apiToolKeywordTimer) { clearTimeout(apiToolKeywordTimer); apiToolKeywordTimer = null; }
}

async function loadApiToolRequests() {
  if (!apiToolLabel) return;
  showApiToolMessage('加载中…');
  try {
    const res = await window.desktopApp.apiToolList(apiToolLabel, apiToolKeyword.value.trim());
    if (!res || !res.ok) { showApiToolMessage((res && res.error) || '读取日志失败'); apiToolCount.textContent = ''; return; }
    renderApiToolList(res.items || [], res.total || 0, res.dir || '');
  } catch (error) {
    showApiToolMessage('读取日志异常: ' + error.message);
  }
}

function renderApiToolList(items, total, dir) {
  clearNode(apiToolList);
  apiToolCount.textContent = '(' + items.length + (total > items.length ? '/' + total : '') + ')';
  apiToolDir.textContent = dir ? '日志目录: ' + dir : '';
  if (!items.length) { showApiToolMessage('日志里还没有可用的请求(不含 OPTIONS)'); return; }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'apitool-item';
    const head = document.createElement('div');
    head.className = 'apitool-item-head';
    const method = document.createElement('span');
    method.className = 'apitool-method method-' + String(item.method || '').toLowerCase();
    method.textContent = item.method;
    const code = document.createElement('span');
    code.className = 'apitool-code' + (item.error || (item.statusCode && item.statusCode >= 400) ? ' bad' : '');
    code.textContent = item.error ? 'ERR' : (item.statusCode === null || item.statusCode === undefined ? '-' : String(item.statusCode));
    head.append(method, code);
    const url = document.createElement('div');
    url.className = 'apitool-item-url';
    url.textContent = item.url;
    url.title = item.url;
    const meta = document.createElement('div');
    meta.className = 'apitool-item-meta';
    const time = item.time ? new Date(item.time).toLocaleString() : '';
    meta.textContent = time + (item.durationMs === null || item.durationMs === undefined ? '' : ' · ' + item.durationMs + 'ms');
    row.append(head, url, meta);
    row.addEventListener('click', () => applyApiToolItem(item, row));
    apiToolList.appendChild(row);
  });
}

function applyApiToolItem(item, row) {
  Array.from(apiToolList.querySelectorAll('.apitool-item.active')).forEach((el) => el.classList.remove('active'));
  if (row) row.classList.add('active');
  if (item.method) apiToolMethod.value = item.method;
  apiToolUrl.value = item.url || '';
  if (item.requestHeaders && typeof item.requestHeaders === 'object' && Object.keys(item.requestHeaders).length) {
    apiToolHeaders.value = JSON.stringify(item.requestHeaders, null, 2);
  }
  setApiToolStatus('已填入请求,点击“发送”重新请求');
  setApiToolResponse('已填入请求,点击“发送”重新请求');
}

function parseHeaders() {
  const text = apiToolHeaders.value.trim();
  if (!text) return { ok: true, headers: {} };
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { return { ok: false, error: '请求头不是合法 JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: '请求头必须是 JSON 对象' };
  return { ok: true, headers: parsed };
}

async function sendApiToolRequest() {
  if (!apiToolLabel) { setApiToolStatus('没有绑定视图', 'bad'); return; }
  const url = apiToolUrl.value.trim();
  if (!url) { setApiToolStatus('请填写请求地址', 'bad'); return; }
  const parsed = parseHeaders();
  if (!parsed.ok) { setApiToolStatus(parsed.error, 'bad'); return; }
  const headers = { ...parsed.headers };
  const body = apiToolBody.value;
  if (body.trim() && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  apiToolSendBtn.disabled = true;
  setApiToolStatus('请求中…');
  setApiToolResponse('');
  try {
    const res = await window.desktopApp.apiToolSend({
      label: apiToolLabel, method: apiToolMethod.value, url, headers, body,
    });
    if (!res || !res.ok) {
      setApiToolStatus((res && res.error) || '请求失败', 'bad');
      setApiToolResponse('请求失败: ' + ((res && res.error) || '未知错误'));
      return;
    }
    setApiToolStatus(res.status + ' ' + (res.statusText || '') + ' · ' + res.durationMs + 'ms' +
      (res.truncated ? ' · 已截断' : '') + (res.logPath ? ' · 日志: ' + res.logPath : ''), res.status >= 400 ? 'bad' : 'ok');
    const headerText = Object.entries(res.headers || {}).map(([key, value]) => key + ': ' + value).join('\n');
    setApiToolResponse((headerText ? headerText + '\n\n' : '') + (prettyJson(res.body) || '(空响应体)'));
    log('[api-tool] 请求完成:', res.status, url);
    loadApiToolRequests();
  } catch (error) {
    setApiToolStatus('请求异常: ' + error.message, 'bad');
    setApiToolResponse('请求异常: ' + error.message);
  } finally {
    apiToolSendBtn.disabled = false;
  }
}

function bindApiToolActions() {
  if (!apiToolDialog) return;
  apiToolCloseBtn.addEventListener('click', hideApiToolDialog);
  apiToolDialog.addEventListener('mousedown', (event) => { if (event.target === apiToolDialog) hideApiToolDialog(); });
  apiToolDialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideApiToolDialog(); });
  apiToolSendBtn.addEventListener('click', sendApiToolRequest);
  apiToolRefreshBtn.addEventListener('click', loadApiToolRequests);
  apiToolClearBtn.addEventListener('click', () => {
    apiToolBody.value = '';
    apiToolHeaders.value = DEFAULT_HEADERS_TEXT;
    setApiToolStatus('');
    setApiToolResponse('');
  });
  apiToolKeyword.addEventListener('input', () => {
    if (apiToolKeywordTimer) clearTimeout(apiToolKeywordTimer);
    apiToolKeywordTimer = setTimeout(() => { apiToolKeywordTimer = null; loadApiToolRequests(); }, 300);
  });
}
