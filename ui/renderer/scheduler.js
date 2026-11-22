// scheduler.js -- 定时任务弹窗:左栏表单(名称/cron/分组/站点/地址),右栏任务列表
// 任务由 Rust 侧按 cron 触发 GET 请求,输出写 ~/.my_devops/tasks/<group>/<site>/requests.log。
// 分组/站点下拉取自配置的 groups;默认选中当前打开页面所属分组与站点。

let schedulerTasks = [];
let schedEditingId = '';

function schedStatus(text, kind) {
  schedStatusEl.textContent = text || '';
  schedStatusEl.className = 'apitool-status' + (kind ? ' ' + kind : '');
}

function currentSiteDefaults() {
  const site = currentSiteId ? findSiteById(currentSiteId) : null;
  if (!site) return { groupKey: '', siteName: '' };
  const group = groups.find((item) => item.sites.some((s) => s.id === site.id));
  return { groupKey: group ? group.key : (site.groupKey || ''), siteName: site.name || '' };
}

function fillSchedGroups(preferredKey, preferredSite) {
  const current = preferredKey || schedGroup.value;
  schedGroup.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = groups.length ? '选择分组' : '暂无分组';
  schedGroup.appendChild(placeholder);
  groups.forEach((group) => {
    const option = document.createElement('option');
    option.value = group.key;
    option.textContent = group.label || group.key;
    schedGroup.appendChild(option);
  });
  if (current && groups.some((group) => group.key === current)) schedGroup.value = current;
  else if (groups.length) schedGroup.value = groups[0].key;
  fillSchedSites(schedGroup.value, preferredSite);
}

function fillSchedSites(groupKey, preferredName) {
  const current = preferredName || schedSite.value;
  schedSite.innerHTML = '';
  const group = groups.find((item) => item.key === groupKey);
  const names = group ? [...new Set(group.sites.map((site) => site.name))] : [];
  if (!names.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = groupKey ? '该分组下没有站点' : '先选择分组';
    schedSite.appendChild(option);
    return;
  }
  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    schedSite.appendChild(option);
  });
  schedSite.value = current && names.includes(current) ? current : names[0];
}

function resetSchedForm() {
  schedEditingId = '';
  schedName.value = '';
  schedCron.value = '';
  schedUrl.value = '';
  schedMethod.value = 'GET';
  schedHeaders.value = '';
  schedBody.value = '';
  schedEnabled.checked = true;
  schedStatus('');
  const defaults = currentSiteDefaults();
  fillSchedGroups(defaults.groupKey, defaults.siteName);
}

function showSchedulerDialog() {
  resetSchedForm();
  schedulerDialog.hidden = false;
  loadSchedulerTasks();
  loadSchedulerRuns();
  loadPageLogRequests();
}

function hideSchedulerDialog() {
  schedulerDialog.hidden = true;
}

function formatSchedTime(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
    pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  if (!node.firstChild) node.innerHTML = '';
}

function renderSchedulerTasks(tasks, dir) {
  clearNode(schedList);
  schedCount.textContent = '(' + tasks.length + ')';
  schedDir.textContent = dir ? '输出目录: ' + dir : '';
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'apitool-empty';
    empty.textContent = '还没有定时任务,左侧填写后点“保存任务”';
    schedList.appendChild(empty);
    return;
  }
  tasks.forEach((task) => {
    const row = document.createElement('div');
    row.className = 'apitool-item sched-item' + (task.enabled ? '' : ' disabled') + (task.id === schedEditingId ? ' active' : '');
    const head = document.createElement('div');
    head.className = 'apitool-item-head';
    const name = document.createElement('span');
    name.className = 'sched-name';
    name.textContent = task.name;
    const state = document.createElement('span');
    state.className = 'apitool-code' + (task.lastStatus === 'error' ? ' bad' : '');
    state.textContent = task.running ? '运行中' : (task.enabled ? (task.lastStatus || '待运行') : '已停用');
    head.append(name, state);
    const cron = document.createElement('div');
    cron.className = 'apitool-item-url';
    cron.textContent = task.cron + ' · ' + task.groupKey + ' / ' + task.siteName;
    const url = document.createElement('div');
    url.className = 'apitool-item-url';
    url.textContent = task.url;
    const meta = document.createElement('div');
    meta.className = 'apitool-item-meta';
    const next = task.nextRunAt ? ('下次 ' + formatSchedTime(task.nextRunAt)) : (task.enabled ? '下次:暂无' : '未启用');
    const last = task.lastRunAt ? (' · 上次 ' + formatSchedTime(task.lastRunAt)) : '';
    meta.textContent = next + last;
    const actions = document.createElement('div');
    actions.className = 'sched-actions';
    const makeButton = (text, handler, className) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sched-action' + (className ? ' ' + className : '');
      button.textContent = text;
      button.addEventListener('click', (event) => { if (event && event.stopPropagation) event.stopPropagation(); handler(); });
      return button;
    };
    actions.append(
      makeButton('编辑', () => editSchedulerTask(task)),
      makeButton('立即执行', () => runSchedulerTask(task)),
      makeButton(task.enabled ? '停用' : '启用', () => toggleSchedulerTask(task)),
      makeButton('删除', () => removeSchedulerTask(task), 'danger'),
    );
    row.append(head, cron, url, meta, actions);
    row.addEventListener('click', () => editSchedulerTask(task));
    schedList.appendChild(row);
  });
}

async function loadSchedulerTasks() {
  try {
    const res = await window.desktopApp.schedulerList();
    if (!res || !res.ok) { schedStatus((res && res.error) || '读取任务失败', 'bad'); return; }
    schedulerTasks = res.tasks || [];
    renderSchedulerTasks(schedulerTasks, res.dir || '');
  } catch (error) {
    schedStatus('读取任务异常: ' + error.message, 'bad');
  }
}

function editSchedulerTask(task) {
  schedEditingId = task.id;
  schedName.value = task.name || '';
  schedCron.value = task.cron || '';
  schedEnabled.checked = task.enabled !== false;
  schedUrl.value = task.url || '';
  schedStatus('编辑中: ' + (task.name || ''));
  fillSchedGroups(task.groupKey, task.siteName);
  schedUrl.value = task.url || '';
  schedMethod.value = task.method || 'GET';
  schedHeaders.value = task.headers && Object.keys(task.headers).length ? JSON.stringify(task.headers, null, 2) : '';
  schedBody.value = task.body || '';
  renderSchedulerTasks(schedulerTasks, '');
}

async function saveSchedulerTask() {
  const payload = {
    id: schedEditingId,
    name: schedName.value.trim(),
    cron: schedCron.value.trim(),
    groupKey: schedGroup.value,
    siteName: schedSite.value,
    method: schedMethod.value,
    url: schedUrl.value.trim(),
    headers: schedHeaders.value.trim(),
    body: schedBody.value,
    enabled: schedEnabled.checked,
  };
  if (!payload.name) return schedStatus('请填写任务名称', 'bad');
  if (!payload.cron) return schedStatus('请填写 cron 表达式', 'bad');
  if (!payload.groupKey) return schedStatus('请选择分组', 'bad');
  if (!payload.siteName) return schedStatus('请选择站点', 'bad');
  if (!payload.url) return schedStatus('请填写请求地址', 'bad');
  if (payload.headers) {
    let parsed;
    try { parsed = JSON.parse(payload.headers); } catch (e) { return schedStatus('请求头不是合法 JSON', 'bad'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return schedStatus('请求头必须是 JSON 对象', 'bad');
    }
  }
  schedStatus('保存中…');
  try {
    const res = await window.desktopApp.schedulerSave(payload);
    if (!res || !res.ok) { schedStatus((res && res.error) || '保存失败', 'bad'); return; }
    schedEditingId = res.task.id;
    schedStatus('已保存:' + res.task.name, 'ok');
    log('[scheduler] 保存任务:', res.task.name, res.task.cron);
    await loadSchedulerTasks();
  } catch (error) {
    schedStatus('保存异常: ' + error.message, 'bad');
  }
}

async function runSchedulerTask(task) {
  schedStatus('执行中: ' + task.name);
  try {
    const res = await window.desktopApp.schedulerRun(task.id);
    if (!res || !res.ok) { schedStatus((res && res.error) || '执行失败', 'bad'); return; }
    schedStatus('执行完成:' + (res.statusCode === undefined ? '' : res.statusCode) + ' · ' + res.durationMs + 'ms', 'ok');
    await loadSchedulerTasks();
    await loadSchedulerRuns();
  } catch (error) {
    schedStatus('执行异常: ' + error.message, 'bad');
  }
}

async function toggleSchedulerTask(task) {
  try {
    const res = await window.desktopApp.schedulerToggle(task.id, !task.enabled);
    if (!res || !res.ok) { schedStatus((res && res.error) || '操作失败', 'bad'); return; }
    schedStatus((task.enabled ? '已停用:' : '已启用:') + task.name, 'ok');
    await loadSchedulerTasks();
  } catch (error) {
    schedStatus('操作异常: ' + error.message, 'bad');
  }
}

async function removeSchedulerTask(task) {
  try {
    const res = await window.desktopApp.schedulerRemove(task.id);
    if (!res || !res.ok) { schedStatus((res && res.error) || '删除失败', 'bad'); return; }
    if (schedEditingId === task.id) {
      schedEditingId = '';
      schedName.value = '';
      schedCron.value = '';
      schedUrl.value = '';
    }
    schedStatus('已删除:' + task.name, 'ok');
    await loadSchedulerTasks();
  } catch (error) {
    schedStatus('删除异常: ' + error.message, 'bad');
  }
}


/* ===== 当前页面请求列表(当前 tab 的日志请求,默认加载) ===== */
function currentTabLabel() {
  if (!currentSiteId) return '';
  const wv = webviews[currentSiteId];
  if (!wv) return '';
  try { return typeof wv.label === 'string' ? wv.label : ''; } catch (error) { return ''; }
}

function renderPageLogRequests(items, total) {
  if (!schedPageLogList) return;
  clearNode(schedPageLogList);
  if (schedPageLogCount) schedPageLogCount.textContent = '(' + items.length + (total > items.length ? '/' + total : '') + ')';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'apitool-empty';
    empty.textContent = currentSiteId ? '当前页面还没有可用的请求(不含 OPTIONS)' : '先打开一个站点页面';
    schedPageLogList.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'apitool-item';
    const head = document.createElement('div');
    head.className = 'apitool-item-head';
    const method = document.createElement('span');
    method.className = 'apitool-method';
    method.textContent = item.method;
    const code = document.createElement('span');
    code.className = 'apitool-code' + (item.statusCode >= 400 || item.error ? ' bad' : '');
    code.textContent = item.error ? 'ERR' : (item.statusCode === null || item.statusCode === undefined ? '-' : String(item.statusCode));
    head.append(method, code);
    const url = document.createElement('div');
    url.className = 'apitool-item-url';
    url.textContent = item.url;
    row.append(head, url);
    row.addEventListener('click', () => {
      schedUrl.value = item.url || '';
      if (item.method) schedMethod.value = item.method;
      schedHeaders.value = item.requestHeaders && Object.keys(item.requestHeaders).length
        ? JSON.stringify(item.requestHeaders, null, 2) : '';
      schedBody.value = item.requestBody || '';
      schedStatus('已填入请求: ' + (item.method || 'GET') + ' ' + (item.url || ''), 'ok');
    });
    schedPageLogList.appendChild(row);
  });
}

/* 当前没有打开的页面时,整块“当前页面请求列表”不展示 */
function setPageLogSectionVisible(visible) {
  if (schedPageLogSection) schedPageLogSection.hidden = !visible;
}

async function loadPageLogRequests() {
  if (!schedPageLogList) return;
  const label = currentTabLabel();
  if (!label) {
    setPageLogSectionVisible(false);
    clearNode(schedPageLogList);
    if (schedPageLogCount) schedPageLogCount.textContent = '';
    return;
  }
  setPageLogSectionVisible(true);
  try {
    const res = await window.desktopApp.apiToolList(label, schedPageLogKeyword.value.trim());
    if (!res || !res.ok) {
      clearNode(schedPageLogList);
      const tip = document.createElement('div');
      tip.className = 'apitool-empty';
      tip.textContent = (res && res.error) || '读取日志失败';
      schedPageLogList.appendChild(tip);
      if (schedPageLogCount) schedPageLogCount.textContent = '';
      return;
    }
    renderPageLogRequests(res.items || [], res.total || 0);
  } catch (error) {
    log('[scheduler] 读取当前页面请求失败:', error.message);
    renderPageLogRequests([], 0);
  }
}

let schedPageLogTimer = null;

/* 执行日志列表 + 关键字筛选 */
function renderSchedulerRuns(items, total) {
  if (!schedRunsList) return;
  clearNode(schedRunsList);
  schedRunsCount.textContent = '(' + items.length + (total > items.length ? '/' + total : '') + ')';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'apitool-empty';
    empty.textContent = '还没有执行记录';
    schedRunsList.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'apitool-item';
    const head = document.createElement('div');
    head.className = 'apitool-item-head';
    const name = document.createElement('span');
    name.className = 'sched-name';
    name.textContent = item.taskName || '(未命名任务)';
    const code = document.createElement('span');
    const failed = item.error || (typeof item.statusCode === 'number' && item.statusCode >= 400);
    code.className = 'apitool-code' + (failed ? ' bad' : '');
    code.textContent = item.error ? 'ERR' : (item.statusCode === null || item.statusCode === undefined ? '-' : String(item.statusCode));
    head.append(name, code);
    const url = document.createElement('div');
    url.className = 'apitool-item-url';
    url.textContent = (item.method || 'GET') + ' ' + (item.url || '');
    const meta = document.createElement('div');
    meta.className = 'apitool-item-meta';
    const time = item.time ? new Date(Number(item.time) * 1000).toLocaleString() : '';
    meta.textContent = time
      + (item.durationMs === null || item.durationMs === undefined ? '' : ' · ' + item.durationMs + 'ms')
      + (item.via ? ' · ' + item.via : '')
      + (Array.isArray(item.skippedHeaders) && item.skippedHeaders.length ? ' · 跳过头: ' + item.skippedHeaders.join(',') : '')
      + (item.error ? ' · ' + item.error : '');
    row.append(head, url, meta);
    schedRunsList.appendChild(row);
  });
}

async function loadSchedulerRuns() {
  if (!schedRunsList) return;
  try {
    const res = await window.desktopApp.schedulerRuns(schedRunsKeyword.value.trim());
    if (!res || !res.ok) { renderSchedulerRuns([], 0); return; }
    renderSchedulerRuns(res.items || [], res.total || 0);
  } catch (error) {
    log('[scheduler] 读取执行日志失败:', error.message);
  }
}

let schedRunsTimer = null;

function bindSchedulerActions() {
  if (!schedulerBtn || !schedulerDialog) return;
  schedulerBtn.addEventListener('click', showSchedulerDialog);
  schedulerCloseBtn.addEventListener('click', hideSchedulerDialog);
  schedulerDialog.addEventListener('mousedown', (event) => { if (event.target === schedulerDialog) hideSchedulerDialog(); });
  schedulerDialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideSchedulerDialog(); });
  schedGroup.addEventListener('change', () => fillSchedSites(schedGroup.value));
  schedSaveBtn.addEventListener('click', saveSchedulerTask);
  schedResetBtn.addEventListener('click', resetSchedForm);
  schedRefreshBtn.addEventListener('click', () => { loadSchedulerTasks(); loadSchedulerRuns(); });
  if (schedRunsRefreshBtn) schedRunsRefreshBtn.addEventListener('click', loadSchedulerRuns);
  if (schedPageLogRefreshBtn) schedPageLogRefreshBtn.addEventListener('click', loadPageLogRequests);
  if (schedPageLogKeyword) {
    schedPageLogKeyword.addEventListener('input', () => {
      if (schedPageLogTimer) clearTimeout(schedPageLogTimer);
      schedPageLogTimer = setTimeout(() => { schedPageLogTimer = null; loadPageLogRequests(); }, 300);
    });
  }
  if (schedRunsKeyword) {
    schedRunsKeyword.addEventListener('input', () => {
      if (schedRunsTimer) clearTimeout(schedRunsTimer);
      schedRunsTimer = setTimeout(() => { schedRunsTimer = null; loadSchedulerRuns(); }, 300);
    });
  }
}
