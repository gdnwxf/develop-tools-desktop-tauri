(function () {
  'use strict';
  let bootstrapPromise;
  let lastUrls = {};
  let stateQueue = Promise.resolve();
  let devToolsTarget = null;
  const invoke = (op, args = {}) => {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') return Promise.reject(new Error('Tauri desktop bridge 不可用'));
    return core.invoke('desktop', { op, args });
  };
  const bootstrap = () => {
    if (!bootstrapPromise) bootstrapPromise = invoke('bootstrap').then((data) => {
      if (!data || !Array.isArray(data.groups) || !data.state || typeof data.state !== 'object') {
        throw new Error('bootstrap 返回数据无效');
      }
      lastUrls = { ...(data.state.lastUrls || {}) };
      return data;
    });
    return bootstrapPromise;
  };
  const patch = (changes) => {
    const task = stateQueue.then(() => invoke('state_patch', { patch: changes }));
    stateQueue = task.catch(() => {});
    return task;
  };
  const logAction = (action, label) => invoke('log_action', label ? { action, label } : { action });
  window.desktopApp = {
    invoke,
    getBootstrap: bootstrap,
    getGroups: () => bootstrap().then((data) => data.groups),
    getSettings: () => bootstrap().then((data) => ({ defaultExpand: data.defaultExpand })),
    getState: () => bootstrap().then((data) => JSON.parse(JSON.stringify(data.state))),
    isDev: () => invoke('is_dev'),
    saveLastUrl: (siteId, url) => {
      lastUrls = { ...lastUrls, [siteId]: { url, ts: Date.now() } };
      return patch({ lastUrls });
    },
    saveExpandedGroups: (keys) => patch({ expandedGroups: keys }),
    saveLastTab: (siteId) => patch({ lastTab: siteId }),
    saveOpenTabs: (ids, clones) => patch({ openTabs: ids, clonedSites: clones }),
    // 分屏布局快照(树结构/焦点/布局模式),随状态文件持久化
    saveSplitLayout: (layout) => patch({ splitLayout: layout }),
    // 接口调试:读当前视图日志里的请求列表 / 在页面内重发请求
    currentViewLabel: () => devToolsTarget,
    apiToolList: (label, keyword) => invoke('api_tool_list', { label, keyword: keyword || '' }),
    apiToolSend: (payload) => invoke('api_tool_send', payload),
    // 定时任务
    schedulerList: () => invoke('scheduler_list'),
    schedulerSave: (task) => invoke('scheduler_save', { task }),
    schedulerRemove: (id) => invoke('scheduler_remove', { id }),
    schedulerToggle: (id, enabled) => invoke('scheduler_toggle', { id, enabled }),
    schedulerRun: (id) => invoke('scheduler_run', { id }),
    // 定时任务执行日志列表(关键字筛选)
    schedulerRuns: (keyword) => invoke('scheduler_runs', { keyword: keyword || '' }),
    registerRequestLog: (label) => logAction('register', label),
    openRequestLog: (label) => logAction('open', label),
    openRequestLogFolder: (label) => logAction('folder', label),
    clearRequestLog: (label) => logAction('clear', label),
    clearAllRequestLogs: () => logAction('clear_all'),
    setDevToolsTarget: (label) => { devToolsTarget = label; },
    openCurrentDevTools: () => devToolsTarget
      ? invoke('view_action', { label: devToolsTarget, action: 'devtools' })
      : Promise.reject(new Error('当前没有打开的视图')),
    openLink: (url) => invoke('open_link', { url }),
    openExternal: (url) => invoke('open_link', { url }),
    copyText: (text) => navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('当前环境不支持 Clipboard API')),
    generateOtp: (secret) => invoke('otp', { secret }),
    debugCookies: () => Promise.reject(new Error('unsupported: Tauri 不提供 cookie 调试 API')),
    openContextMenu: () => Promise.reject(new Error('unsupported: 请使用原生 Webview 默认右键菜单')),
    log: (...args) => invoke('renderer_log', { args: args.map((arg) => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)) })
      .catch((error) => console.error('renderer_log:', error.message)),
  };
  document.addEventListener('keydown', (event) => {
    if (event.key === 'F12' || (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'i')) {
      event.preventDefault();
      window.desktopApp.openCurrentDevTools().catch((error) => console.error(error.message));
    }
  });
})();
