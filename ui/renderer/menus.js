// 原生菜单覆盖 WebView，打开和关闭菜单均不改变站点页面的可见性。
let contextMenuEvents;

async function openSiteMenu(kind, site, x, y) {
  try {
    if (!contextMenuEvents) {
      contextMenuEvents = window.__TAURI__.event.listen('context-action', ({ payload }) => {
        const target = payload.siteId ? findSiteById(payload.siteId) : null;
        if (payload.action === 'close-all') { closeAllTabs(); return; }
        if (!target) return;
        switch (payload.action) {
          case 'reload': reloadSite(target); break;
          case 'close-right': closeRightTabs(target); break;
          case 'close-left': closeLeftTabs(target); break;
          case 'close-other': closeOtherTabs(target); break;
          case 'clone': cloneSite(target); break;
          case 'copy-link': copySiteLink(target, '[context-menu]'); break;
          case 'open-log': openSiteLog(target); break;
          case 'open-log-folder': openSiteLogFolder(target); break;
          case 'clear-log': clearSiteLog(target); break;
        }
      }).catch((error) => {
        contextMenuEvents = null;
        throw error;
      });
    }
    await contextMenuEvents;
    return await window.desktopApp.invoke('context_menu', { kind, siteId: site ? site.id : '', x, y });
  } catch (error) {
    log('[context-menu]', '打开菜单失败:', error.message);
  }
}

function showTabContextMenu(x, y, site) {
  return openSiteMenu('tab', site, x, y);
}

function showSiteContextMenu(x, y, site) {
  return openSiteMenu('site', site, x, y);
}

function bindActions() {
  reloadBtn.addEventListener('click', () => reloadSite(findSiteById(currentSiteId)));
  collapseBtn.addEventListener('click', () => sidebar.classList.toggle('collapsed'));
  expandAllBtn.addEventListener('click', expandAllGroups);
  collapseAllBtn.addEventListener('click', collapseAllGroups);
  clearLogsBtn.addEventListener('click', () => {
    window.desktopApp.clearAllRequestLogs().then((res) => {
      if (!res || !res.ok) log('[request-log] 清空全部日志失败:', res && res.error ? res.error : '未知错误');
      else log('[request-log] 已清空全部日志:', res.removed, '个文件');
    }).catch((error) => log('[request-log] 清空全部日志异常:', error.message));
  });
  tabBar.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const tab = event.target.closest('.tab');
    showTabContextMenu(event.clientX, event.clientY, tab ? findSiteById(tab.dataset.id) : null);
  });
}
