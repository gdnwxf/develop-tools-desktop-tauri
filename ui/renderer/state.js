// state.js -- 共享状态、DOM 引用与持久化/查找辅助(全局作用域,供各 renderer 模块共用)

const log = (...args) => window.desktopApp.log(...args);

let groups = [];                  // [{ key, label, icon, type, sites: [...] }]
let settings = { defaultExpand: '' };
let state = { expandedGroups: [], lastUrls: {} };
let currentSiteId = null;
const expandedGroups = new Set(); // 当前展开的分组 key
const webviews = {};              // { [siteId]: webviewElement }(懒创建)
const loginAttempted = new Set(); // 已尝试过自动登录的站点(防重复填表)
const loginFailedNotified = new Set(); // 已提示过登录失败的站点(防重复 toast)
const firstOpenPending = new Set(); // 登录成功后待跳转 first_open_url 的站点
const firstOpenDone = new Set();    // 本会话已跳转过 first_open_url 的站点(防重复/防循环)
const probeTimers = {};           // { [siteId]: timerHandle } 连续探测(redisinsight/grafana)
const probeState = {};            // { [siteId]: { phase, fillAt } } 探测状态机
const lastProbeState = {};        // { [siteId]: state } 上次探测态(仅状态变化时记日志)
const bytebaseTimers = {};        // { [siteId]: timerHandle } bytebase 一次性探测
const fillTimers = {};            // { [siteId]: timerHandle } startAutoFill 重试循环
const saveUrlTimers = {};         // { [siteId]: timerHandle } 每站点独立防抖
const siteStatus = {};            // { [siteId]: 'ok'|'skip'|'current'|null } 站点登录状态(供 tab 重建时恢复)
const dynamicPages = [];           // 打开新页面产生的动态站点(仅当前会话,不随 openTabs 持久化)
const clonedSites = [];           // 右键"复制"产生的克隆站点(定义随 openTabs 持久化,账密/optsecret 仅内存继承;关闭即销毁 webview 并移除)
let cloneCounter = 0;             // 克隆序号(本会话内自增,用于 tab 名 复制-N-原名称)
let recentSites = [];             // “最近打开”独立存储(recent_sites.json)的镜像
const tabOrder = [];              // tab 栏显式顺序(siteId 列表):拖动排序的数据源,随 openTabs 持久化

const siteList = document.getElementById('siteList');
const content = document.getElementById('content');
const webviewContainer = document.getElementById('webviewContainer');
const tabBar = document.getElementById('tabBar');
const reloadBtn = document.getElementById('reloadBtn');
const sidebar = document.getElementById('sidebar');
const collapseBtn = document.getElementById('collapseBtn');
const expandAllBtn = document.getElementById('expandAllBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const toastContainer = document.getElementById('toastContainer');
const sidebarFilter = document.getElementById('sidebarFilter');
const sidebarFilterClear = document.getElementById('sidebarFilterClear');
let sidebarFilterText = '';
// 接口调试弹窗
const apiToolDialog = document.getElementById('apiToolDialog');
const apiToolTag = document.getElementById('apiToolTag');
const apiToolCloseBtn = document.getElementById('apiToolCloseBtn');
const apiToolMethod = document.getElementById('apiToolMethod');
const apiToolUrl = document.getElementById('apiToolUrl');
const apiToolHeaders = document.getElementById('apiToolHeaders');
const apiToolBody = document.getElementById('apiToolBody');
const apiToolSendBtn = document.getElementById('apiToolSendBtn');
const apiToolClearBtn = document.getElementById('apiToolClearBtn');
const apiToolStatus = document.getElementById('apiToolStatus');
const apiToolResponse = document.getElementById('apiToolResponse');
const apiToolList = document.getElementById('apiToolList');
const apiToolCount = document.getElementById('apiToolCount');
const apiToolKeyword = document.getElementById('apiToolKeyword');
const apiToolRefreshBtn = document.getElementById('apiToolRefreshBtn');
const apiToolDir = document.getElementById('apiToolDir');
// 定时任务弹窗
const schedulerBtn = document.getElementById('schedulerBtn');
const schedulerDialog = document.getElementById('schedulerDialog');
const schedulerTag = document.getElementById('schedulerTag');
const schedulerCloseBtn = document.getElementById('schedulerCloseBtn');
const schedName = document.getElementById('schedName');
const schedCron = document.getElementById('schedCron');
const schedGroup = document.getElementById('schedGroup');
const schedSite = document.getElementById('schedSite');
const schedUrl = document.getElementById('schedUrl');
const schedEnabled = document.getElementById('schedEnabled');
const schedSaveBtn = document.getElementById('schedSaveBtn');
const schedResetBtn = document.getElementById('schedResetBtn');
const schedStatusEl = document.getElementById('schedStatus');
const schedList = document.getElementById('schedList');
const schedCount = document.getElementById('schedCount');
const schedRefreshBtn = document.getElementById('schedRefreshBtn');
const schedDir = document.getElementById('schedDir');
const schedMethod = document.getElementById('schedMethod');
const schedHeaders = document.getElementById('schedHeaders');
const schedBody = document.getElementById('schedBody');
const schedRunsList = document.getElementById('schedRunsList');
const schedRunsCount = document.getElementById('schedRunsCount');
const schedRunsKeyword = document.getElementById('schedRunsKeyword');
const schedRunsRefreshBtn = document.getElementById('schedRunsRefreshBtn');
const schedPageLogSection = document.getElementById('schedPageLogSection');
const schedPageLogList = document.getElementById('schedPageLogList');
const schedPageLogCount = document.getElementById('schedPageLogCount');
const schedPageLogKeyword = document.getElementById('schedPageLogKeyword');
const schedPageLogRefreshBtn = document.getElementById('schedPageLogRefreshBtn');
// 打开新页面弹窗
const openPageBtn = document.getElementById('openPageBtn');
const pageDialog = document.getElementById('pageDialog');
const pageForm = document.getElementById('pageForm');
const pageUrlInput = document.getElementById('pageUrlInput');
const pageDialogError = document.getElementById('pageDialogError');
const pageCancelBtn = document.getElementById('pageCancelBtn');

function saveExpanded() {
  window.desktopApp.saveExpandedGroups([...expandedGroups]).catch((error) => log('[state]', '保存分组失败:', error.message));
}
function saveLastTab() {
  window.desktopApp.saveLastTab(currentSiteId).catch((error) => log('[state]', '保存当前标签失败:', error.message));
}
function saveOpenTabs() {
  syncTabOrder();
  const openedIds = tabOrder.filter((id) => {
    const s = findSiteById(id);
    // 动态页面(打开新页面)不被持久化:重启后无法从配置重建
    return s && webviews[id] && !s.isDynamic;
  });
  // 克隆 tab 的站点定义随 openTabs 一并持久化,重启后按序重建;只存 sourceId 引用,
  // user/password/optsecret 不写入磁盘,重启后由 renderer/main.js 按源配置回填
  const clones = openedIds
    .filter((id) => { const s = findSiteById(id); return s && s.isClone; })
    .map((id) => {
      const { id: cid, name, type, url, sourceId } = findSiteById(id);
      return { id: cid, name, type, url, sourceId: sourceId || '', isClone: true };
    });
  window.desktopApp.saveOpenTabs(openedIds, clones).catch((error) => log('[state]', '保存标签失败:', error.message));
}

/* 按 id 查找站点(含克隆 tab);找不到返回 null */
function findSiteById(id) {
  return groups.flatMap((g) => g.sites).find((s) => s.id === id)
    || clonedSites.find((s) => s.id === id)
    || dynamicPages.find((s) => s.id === id)
    || null;
}

/* 同步 tabOrder 与实际打开的 tab:已关闭的剔除,新打开的追加到末尾(含克隆 tab) */
function syncTabOrder() {
  const opened = groups.flatMap((g) => g.sites).filter((s) => webviews[s.id] && !s.paneOnly);
  clonedSites.forEach((s) => { if (webviews[s.id] && !s.paneOnly) opened.push(s); });
  dynamicPages.forEach((s) => { if (webviews[s.id] && !s.paneOnly) opened.push(s); });
  for (let i = tabOrder.length - 1; i >= 0; i--) {
    if (!opened.some((s) => s.id === tabOrder[i])) tabOrder.splice(i, 1);
  }
  opened.forEach((s) => { if (!tabOrder.includes(s.id)) tabOrder.push(s.id); });
}
