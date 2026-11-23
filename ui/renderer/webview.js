// webview.js -- webview 创建/销毁、站点切换、登录状态标记与失败提示

/* ===== 右键"复制":克隆一个 tab =====
 * 新 webview 与原站共用 persist:devops partition,cookie 天然共享;cookie 失效时(如自研站点 token
 * 放在 sessionStorage,不跨 webview 共享),克隆 tab 继承源站点账密/optsecret,走与普通 tab 相同的
 * 自动登录链路(见 bindWebviewEvents)。账密/optsecret 仅内存继承、不落盘;持久化只存 sourceId,
 * 重启后按源配置回填,源配置已删则不自动登录。
 * 克隆 tab 随 openTabs 一并持久化(重启恢复,序号续接防 id 碰撞),关闭即从持久化中移除。
 * 优先复制原 tab 当前访问地址;原 tab 未打开则用配置 url。
 */
function cloneSite(site, options) {
  cloneCounter++;
  // 源为克隆时沿 sourceId 回溯到原始配置站点(克隆链共享同一 sourceId)
  const rootId = site.isClone ? (site.sourceId || site.id) : site.id;
  const origin = groups.flatMap((g) => g.sites).find((s) => s.id === rootId) || site;
  const srcWv = webviews[site.id];
  const cur = srcWv ? srcWv.getURL() : '';
  const url = (cur && cur !== 'about:blank' && cur.startsWith(origin.url)) ? cur : origin.url;
  const clone = {
    id: 'copy-' + cloneCounter,
    name: '复制-' + cloneCounter + '-' + site.name,
    type: origin.type,
    url,
    isClone: true,
    sourceId: rootId,
  };
  // 账密/optsecret 仅内存继承(掉登录页时供自动登录使用),不随持久化写入磁盘
  ['user', 'password', 'optsecret'].forEach((k) => { if (origin[k]) clone[k] = origin[k]; });
  clonedSites.push(clone);
  // 不手动 createWebview:selectSite 内部会在 webview 不存在时创建并 renderTabs,
  // 若此处先创建会导致 selectSite 跳过 renderTabs,tab 不显示
  if (!options || options.select !== false) selectSite(clone);
  log('[clone]', clone.name, '<-', url);
  return clone;
}

function createWebview(site, persist) {
  if (webviews[site.id]) return;
  const wv = document.createElement('tauri-webview');
  wv.dataset.siteId = site.id;
  wv.dataset.sourceId = site.sourceId || '';
  wv.dataset.isClone = site.isClone ? '1' : '';
  // 动态页面(打开新页面)由 Rust 侧按 URL 直接建视图,日志落 logs/page/<host>/
  if (site.isDynamic) {
    wv.dataset.dynamicSite = JSON.stringify({
      name: site.name, url: site.url, type: site.type || 'web', groupKey: site.groupKey || 'page',
    });
  }

  const saved = state.lastUrls[site.id];
  const targetUrl = (saved && saved.url && saved.url.startsWith(site.url)) ? saved.url : site.url;
  log('[load]', site.name, '->', targetUrl);

  webviewContainer.appendChild(wv);
  webviews[site.id] = wv;
  if (typeof splitIsActive === 'function' && splitIsActive()) webviewContainer.classList.add('split');
  bindWebviewEvents(wv, site);
  wv.loadURL(targetUrl).catch(() => {});
  let requestLogRegistered = false;
  wv.addEventListener('dom-ready', () => {
    if (site.id === currentSiteId) markDevToolsTarget(wv);
    if (requestLogRegistered) return;
    requestLogRegistered = true;
    window.desktopApp.registerRequestLog(wv.getWebContentsId()).then((result) => {
      if (!result || !result.ok) log('[request-log] 注册失败:', site.name, result && result.error);
    }).catch((error) => log('[request-log] 注册失败:', site.name, error.message));
  });
  if (persist !== false) saveOpenTabs();
}

/* ===== 销毁 webview:停止探测/登录,移除 DOM ===== */
function destroyWebview(site) {
  if (site.isClone) {
    const i = clonedSites.indexOf(site);
    if (i >= 0) clonedSites.splice(i, 1);
  }
  stopProbe(site.id);
  stopBytebaseProbe(site.id);
  stopFill(site.id);
  loginAttempted.delete(site.id);
  loginFailedNotified.delete(site.id);
  firstOpenPending.delete(site.id);
  delete probeState[site.id];
  delete lastProbeState[site.id];
  if (saveUrlTimers[site.id]) { clearTimeout(saveUrlTimers[site.id]); delete saveUrlTimers[site.id]; }
  const wv = webviews[site.id];
  if (wv) {
    if (site.id === currentSiteId) window.desktopApp.setDevToolsTarget(null);
    wv.close().catch((error) => log('[close]', site.name, error.message));
    wv.remove();
  }
  delete webviews[site.id];
  markSiteStatus(site.id, null);
  // 分屏中关闭页面:该格上收,剩余面板自适应
  if (typeof splitHandleSiteClosed === 'function') splitHandleSiteClosed(site.id);
  saveOpenTabs();
}

/* 刷新站点 webview(未打开则忽略) */
function reloadSite(site) {
  if (!site) return;
  const wv = webviews[site.id];
  if (wv) wv.reload().catch((error) => log('[reload]', site.name, error.message));
}

/* 复制站点链接:优先取 webview 当前访问地址(站点已打开);未打开或地址无效则回退配置文件中的 url 字段 */
function copySiteLink(site, logTag) {
  const wv = webviews[site.id];
  const cur = wv ? wv.getURL() : '';
  const url = (cur && cur !== 'about:blank') ? cur : site.url;
  window.desktopApp.copyText(url).then(() => {
    log(logTag, site.name, '已复制链接:', url);
  }).catch(() => {});
}

/* 通用轻量提示(复制日志等) */
function showAppToast(title, message, kind) {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = 'toast app-toast' + (kind ? ' ' + kind : '');
  toast.innerHTML =
    '<div class="toast-body">' +
      '<div class="toast-title"></div>' +
      '<div class="toast-msg"></div>' +
    '</div>' +
    '<span class="toast-close" title="关闭">×</span>';
  toast.querySelector('.toast-title').textContent = title || '';
  toast.querySelector('.toast-msg').textContent = message || '';
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  toastContainer.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 6000);
  return toast;
}

/* 复制当前站点日志文件到系统剪贴板(系统级“复制文件”,粘贴得到文件本体) */
function copySiteLog(site) {
  const name = site ? site.name : '';
  const wv = site && webviews[site.id];
  if (!wv) {
    log('[request-log] 复制失败:', name, 'tab 未打开');
    showAppToast('复制日志文件失败', '这个标签还没有打开的页面', 'warn');
    return;
  }
  let label;
  try {
    label = wv.getWebContentsId();
  } catch (error) {
    log('[request-log] 复制失败:', name, '页面尚未就绪', error.message);
    showAppToast('复制日志文件失败', '页面还在加载,请稍后再试', 'warn');
    return;
  }
  window.desktopApp.copyRequestLogFile(label).then((res) => {
    if (!res || !res.ok) {
      const reason = (res && res.error) || '未知错误';
      log('[request-log] 复制失败:', name, reason);
      showAppToast('复制日志文件失败', reason, 'warn');
      return;
    }
    log('[request-log] 已复制日志文件:', name, res.path);
    showAppToast('已复制日志文件', name + ' : 可直接粘贴文件', 'ok');
  }).catch((e) => {
    log('[request-log] 复制异常:', name, e.message);
    showAppToast('复制日志文件失败', e.message, 'warn');
  });
}

/* 打开当前站点正在写入的最后一个请求日志文件 */
function openSiteLog(site) {
  const wv = site && webviews[site.id];
  if (!wv) {
    log('[request-log] 打开失败:', site ? site.name : '', 'tab 未打开');
    return;
  }
  window.desktopApp.openRequestLog(wv.getWebContentsId()).then((res) => {
    if (!res || !res.ok) log('[request-log] 打开失败:', site.name, res && res.error ? res.error : '未知错误');
  }).catch((e) => log('[request-log] 打开异常:', site.name, e.message));
}

/* 打开当前站点请求日志所在的文件夹 */
function openSiteLogFolder(site) {
  const wv = site && webviews[site.id];
  if (!wv) {
    log('[request-log] 打开文件夹失败:', site ? site.name : '', 'tab 未打开');
    return;
  }
  window.desktopApp.openRequestLogFolder(wv.getWebContentsId()).then((res) => {
    if (!res || !res.ok) log('[request-log] 打开文件夹失败:', site.name, res && res.error ? res.error : '未知错误');
  }).catch((e) => log('[request-log] 打开文件夹异常:', site.name, e.message));
}

/* 清空当前站点日志目录下的全部请求日志文件 */
function clearSiteLog(site) {
  const wv = site && webviews[site.id];
  if (!wv) {
    log('[request-log] 清空失败:', site ? site.name : '', 'tab 未打开');
    return;
  }
  window.desktopApp.clearRequestLog(wv.getWebContentsId()).then((res) => {
    if (!res || !res.ok) log('[request-log] 清空失败:', site.name, res && res.error ? res.error : '未知错误');
  }).catch((e) => log('[request-log] 清空异常:', site.name, e.message));
}

function markDevToolsTarget(wv) {
  try { window.desktopApp.setDevToolsTarget(wv.getWebContentsId()); } catch (e) {}
}

/* ===== 切换站点:只切显示/隐藏,不重新加载 ===== */
function selectSite(site, persist) {
  // 分屏中:已在该布局里的站点只切换焦点,不重排;布局外的站点先回单窗
  if (typeof splitIsActive === 'function' && splitIsActive()) {
    const leaf = splitLeaves(splitTree).find((item) => item.siteId === site.id);
    if (leaf) {
      splitFocusLeafId = leaf.id;
      splitSyncPanes();
      currentSiteId = site.id;
      document.querySelectorAll('.site-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === site.id));
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.id === site.id));
      if (persist !== false) saveLastTab();
      applyAppBackground(site);
      return;
    }
    splitExit(site.id);
  }
  // 确保所在分组已展开(仅侧栏),再创建本站点 webview(不自动打开整组)
  const g = groups.find((grp) => grp.sites.some((s) => s.id === site.id));
  if (g && !expandedGroups.has(g.key)) expandGroup(g);
  if (!webviews[site.id]) {
    createWebview(site);
    renderTabs();
  }
  currentSiteId = site.id;
  markDevToolsTarget(webviews[site.id]);
  // 记录“最近打开”(独立文件 recent_sites.json)
  if (typeof window.desktopApp.touchRecentSite === 'function') {
    Promise.resolve(window.desktopApp.touchRecentSite(site.id, site.name, site.url, site.groupKey || ''))
      .then((res) => { if (res && Array.isArray(res.items)) recentSites = res.items; })
      .catch(() => {});
  }

  document.querySelectorAll('.site-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === site.id));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.id === site.id));

  content.classList.add('loaded');

  Object.entries(webviews).forEach(([id, wv]) => {
    if (id === site.id) wv.classList.add('active');
    else wv.classList.remove('active');
  });

  // persist !== false 时更新 lastTab(用户主动选中);收起分组内部切换不更新,保持最后选中站点供重启恢复
  if (persist !== false) saveLastTab();
  applyAppBackground(site);
  log('[selectSite]', site.name, '| 切换显示(不重新加载)');
}

/* ===== tab 栏背景:固定白色(仅 tab header 区域) ===== */
function applyAppBackground(site) {
  // tab 栏背景固定白色,不随当前命中 tab 的分组色变化;
  // 仅覆盖/写入白值,保留原有 inline 写入点以便切换站点时清掉历史分组色
  tabBar.style.background = '#fff';
  // 同步更新分组名称底垫色,保证缺口处的底垫与栏背景一致
  tabBar.style.setProperty('--tabbar-bg', '#fff');
  log('[theme]', 'tab 栏背景 -> 白色', site ? '| 当前站点 ' + site.name : '');
}

/* ===== webview 事件 ===== */
function bindWebviewEvents(wv, site) {
  // 原生菜单由系统管理；站点获得焦点只更新 DevTools 目标。
  wv.addEventListener('focus', () => {
    if (site.id === currentSiteId) { markDevToolsTarget(wv); return; }
    // 分屏中点击某个面板:切焦点与 tab 高亮
    if (typeof splitFocusSite === 'function' && typeof splitIsActive === 'function' && splitIsActive()) {
      currentSiteId = site.id;
      splitFocusSite(site);
      saveLastTab();
      markDevToolsTarget(wv);
      return;
    }
    markDevToolsTarget(wv);
  });

  // 克隆 tab 与普通 tab 走同一套导航/自动登录事件链路(cookie 共享失效时用继承的账密自动登录)。
  // 两点差异:日志带 [clone-webview] 前缀;克隆不写 lastUrls(URL 固定为复制时的地址,不覆盖源站点状态)
  const logTag = site.isClone ? '[clone-webview]' : '[webview]';
  const strat = getStrategy(site.type);

  wv.addEventListener('did-navigate', (e) => {
    log(logTag, site.name, 'did-navigate ->', e.url);
    if (!site.isClone) saveCurrentUrl(site, e.url);
    handleNavigation(wv, site, e.url);
  });

  wv.addEventListener('did-navigate-in-page', (e) => {
    if (site.id === currentSiteId) {
      log(logTag, site.name, 'did-navigate-in-page ->', e.url);
    }
    if (!site.isClone) saveCurrentUrl(site, e.url);
    // superset 策略:in-page 导航也重新判断登录页(原始行为);其余策略由持续探测自动适应
    if (strat === 'superset') handleNavigation(wv, site, e.url);
  });

  const nativeNotices = new Set();
  const nativeTitles = { 'hook-error': '浏览器能力不可用', 'auth-error': '自动认证失败', 'auth-fallback': '需要手动认证' };
  Object.entries(nativeTitles).forEach(([eventName, title]) => {
    wv.addEventListener(eventName, (event) => {
      const message = event.errorDescription;
      const key = eventName + ':' + message;
      if (nativeNotices.has(key)) return;
      nativeNotices.add(key);
      log('[native-view]', site.name, eventName, message);
      showSiteToast(site, { title: site.name + ' ' + title, msg: message });
    });
  });

  // 主框架加载失败(DNS 解析失败/连接超时/服务不可达等):停止探测并提示,避免一直 loading
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame) return;
    if (e.errorCode === -3) return; // ERR_ABORTED:导航被中止(重定向/手动跳转),非错误
    log(logTag, site.name, 'did-fail-load', e.errorCode, e.errorDescription);
    stopProbe(site.id);
    stopFill(site.id);
    markSiteStatus(site.id, 'skip');
    notifyLoginFailed(site, { title: site.name + ' 加载失败', msg: '错误 ' + e.errorCode + ': ' + (e.errorDescription || '页面无法加载') });
  });
}

/* ===== 更新站点按钮状态 ===== */
function markSiteStatus(siteId, status) {
  siteStatus[siteId] = status || null;
  ['.site-btn', '.tab'].forEach((sel) => {
    const el = document.querySelector(sel + '[data-id="' + siteId + '"]');
    if (!el) return;
    el.classList.remove('batch-current', 'batch-ok', 'batch-skip');
    if (status === 'ok') el.classList.add('batch-ok');
    else if (status === 'skip') el.classList.add('batch-skip');
    else if (status === 'current') el.classList.add('batch-current');
  });
}

/* ===== 登录失败提示:右上角 toast(账号或密码错误) ===== */
function notifyLoginFailed(site, opts) {
  if (loginFailedNotified.has(site.id)) return;
  loginFailedNotified.add(site.id);
  showSiteToast(site, opts);
}

function showSiteToast(site, opts) {
  opts = opts || {};
  const profile = getProfile(site.type);
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML =
    '<span class="toast-icon">' + profile.icon + '</span>' +
    '<div class="toast-body">' +
      '<div class="toast-title"></div>' +
      '<div class="toast-msg"></div>' +
    '</div>' +
    '<span class="toast-close" title="关闭">×</span>';
  toast.querySelector('.toast-title').textContent = opts.title || (site.name + ' 登录失败');
  toast.querySelector('.toast-msg').textContent = opts.msg || '账号或密码错误,请检查配置文件';
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  toastContainer.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
}

/* ===== 保存最后访问的 URL(每站点独立防抖) =====
 * superset 策略:不保存登录页 URL(复用原始行为);其余策略保存所有非 about:blank
 */
function saveCurrentUrl(site, url) {
  if (url === 'about:blank') return;
  if (getStrategy(site.type) === 'superset') {
    const profile = getProfile(site.type);
    if (profile.isLoginPage(url)) return;
  }
  if (saveUrlTimers[site.id]) clearTimeout(saveUrlTimers[site.id]);
  saveUrlTimers[site.id] = setTimeout(() => {
    window.desktopApp.saveLastUrl(site.id, url).catch((error) => log('[state]', '保存URL失败:', error.message));
    state.lastUrls[site.id] = { url, ts: Date.now() };
    delete saveUrlTimers[site.id];
  }, 1000);
}
