// page.js -- 底部“打开新页面”:弹窗输入地址后,在 page 组下新建动态站点并打开
// 动态页面只存在于当前会话:不写 devops_config.json,也不随 openTabs 持久化。
// 日志由 Rust 侧按 groupKey/name 落到 logs/page/<host>/requests.log。

let dynamicPageCounter = 0;

/* 地址规范化:去空白;缺协议补 https://;只接受 http/https。
 * 返回 { ok:true, url, name } 或 { ok:false, error };name 取 hostname(站点名兼日志目录名) */
function normalizePageUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '请输入页面地址' };
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : 'https://' + text;
  let parsed;
  try { parsed = new URL(withScheme); } catch (error) { return { ok: false, error: '地址格式不正确' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '只支持 http/https 地址' };
  }
  if (!parsed.hostname) return { ok: false, error: '地址缺少主机名' };
  return { ok: true, url: parsed.href, name: parsed.hostname };
}

function showPageDialogError(message) {
  pageDialogError.textContent = message || '';
}

function showPageDialog() {
  pageUrlInput.value = '';
  showPageDialogError('');
  pageDialog.hidden = false;
  pageUrlInput.focus();
}

function hidePageDialog() {
  pageDialog.hidden = true;
}

/* 确保存在 page 组:已有则复用,否则新建(仅内存,不写配置文件) */
function ensurePageGroup() {
  const existed = groups.find((group) => group.key === 'page');
  if (existed) return existed;
  const group = {
    key: 'page',
    label: 'Page',
    icon: '<span style="display:inline-block;width:1em;height:1em;border-radius:18%;background:#64748b;vertical-align:-0.15em;margin-left:2px"></span>',
    color: '#64748b',
    type: 'web',
    sites: [],
  };
  groups.push(group);
  log('[page] 新建分组:', group.label);
  return group;
}

/* 同名页面加序号:base、base-1、base-2…(同一 URL 再次打开时标题可区分) */
function uniquePageName(group, baseName) {
  const name = String(baseName || '').trim() || 'page';
  const used = new Set();
  const collect = (list) => list.forEach((site) => { if (site && site.name) used.add(site.name); });
  collect(group && Array.isArray(group.sites) ? group.sites : []);
  if (typeof dynamicPages !== 'undefined' && Array.isArray(dynamicPages)) collect(dynamicPages);
  if (!used.has(name)) return name;
  let index = 1;
  while (used.has(name + '-' + index)) index += 1;
  return name + '-' + index;
}

/* 在 page 组下创建动态站点并打开 */
function openDynamicPage(url, name) {
  const group = ensurePageGroup();
  dynamicPageCounter += 1;
  const site = {
    id: 'page-dyn-' + dynamicPageCounter,
    groupKey: group.key,
    type: 'web', // web 策略不做自动登录探测
    name: uniquePageName(group, name || url),
    url,
    isDynamic: true,
  };
  group.sites.push(site);
  dynamicPages.push(site);
  renderSidebar();
  expandGroup(group);
  selectSite(site);
  log('[page] 打开新页面:', site.name, '->', url);
}

function submitPageDialog() {
  const result = normalizePageUrl(pageUrlInput.value);
  if (!result.ok) { showPageDialogError(result.error); return; }
  showPageDialogError('');
  try {
    openDynamicPage(result.url, result.name);
    hidePageDialog();
  } catch (error) {
    showPageDialogError('打开失败: ' + error.message);
    log('[page] 打开失败:', result.url, error.message);
  }
}

function bindPageActions() {
  if (!openPageBtn || !pageForm) return;
  openPageBtn.addEventListener('click', showPageDialog);
  pageCancelBtn.addEventListener('click', hidePageDialog);
  pageForm.addEventListener('submit', (event) => { event.preventDefault(); submitPageDialog(); });
  pageDialog.addEventListener('mousedown', (event) => { if (event.target === pageDialog) hidePageDialog(); });
  pageDialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') hidePageDialog(); });
}
