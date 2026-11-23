// 原生菜单覆盖 WebView，打开和关闭菜单均不改变站点页面的可见性。
let contextMenuEvents;

async function openSiteMenu(kind, site, x, y) {
  try {
    if (!contextMenuEvents) {
      contextMenuEvents = window.__TAURI__.event.listen('context-action', ({ payload }) => {
        const target = payload.siteId ? findSiteById(payload.siteId) : null;
        // 分隔条菜单(三项):payload.siteId 承载的是面板 id,不是站点 id
        if (typeof splitIsActive === 'function' && splitIsActive() && /^pane-/.test(payload.siteId || '')) {
          const paneId = payload.siteId;
          const leaf = splitFindLeaf(splitTree, paneId);
          const paneSite = leaf && leaf.siteId ? findSiteById(leaf.siteId) : null;
          if (payload.action === 'focus') { if (paneSite) selectSite(paneSite); return; }
          if (payload.action === 'split-right') { splitFocusLeafId = paneId; splitColumnRightOf(paneId, null); return; }
          if (payload.action === 'split-down') { splitFocusLeafId = paneId; splitLeaf(paneId, 'column', null); return; }
          if (payload.action === 'close-pane') { splitClosePane(paneId); return; }
          if (payload.action === 'reload') { if (paneSite) reloadSite(paneSite); return; }
          if (payload.action === 'copy-link') { if (paneSite) copySiteLink(paneSite, '[pane-menu]'); return; }
        }
        if (payload.action === 'close-all') { closeAllTabs(); return; }
        if (!target) return;
        switch (payload.action) {
          case 'reload': reloadSite(target); break;
          case 'close-right': closeRightTabs(target); break;
          case 'close-left': closeLeftTabs(target); break;
          case 'close-other': closeOtherTabs(target); break;
          case 'clone': cloneSite(target); break;
          case 'clone-pane': splitClonePane(target); break;
          case 'split-right': splitSiteRight(target); break;
          case 'split-down': splitSiteDown(target); break;
          case 'copy-link': copySiteLink(target, '[context-menu]'); break;
          case 'copy-log': copySiteLog(target); break;
          case 'open-log': openSiteLog(target); break;
          case 'open-log-folder': openSiteLogFolder(target); break;
          case 'clear-log': clearSiteLog(target); break;
          case 'api-tool': openApiToolDialog(target); break;
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
  // 侧栏顶部筛选:输入即过滤(防抖);右侧 ✕ 清空并恢复全部
  const syncSidebarFilterClear = () => {
    if (!sidebarFilterClear) return;
    sidebarFilterClear.hidden = !(sidebarFilter && sidebarFilter.value.trim());
  };
  if (sidebarFilterClear) {
    sidebarFilterClear.addEventListener('click', () => {
      if (!sidebarFilter) return;
      sidebarFilter.value = '';
      sidebarFilterText = '';
      syncSidebarFilterClear();
      renderSidebar();
      Object.keys(siteStatus).forEach((id) => { if (siteStatus[id]) markSiteStatus(id, siteStatus[id]); });
      sidebarFilter.focus();
    });
  }
  if (sidebarFilter) {
    // 输入 http(s) URL 时回车直接在 page 组打开该页面
    sidebarFilter.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const text = String(sidebarFilter.value || '').trim();
      if (!/^https?:\/\//i.test(text)) return;
      event.preventDefault();
      const parsed = typeof normalizePageUrl === 'function' ? normalizePageUrl(text) : { ok: false };
      if (!parsed.ok) { log('[page] 地址无效:', text, parsed.error || ''); return; }
      sidebarFilter.value = '';
      sidebarFilterText = '';
      syncSidebarFilterClear();
      renderSidebar();
      Promise.resolve(openDynamicPage(parsed.url, parsed.name))
        .then(() => log('[page] 从侧栏筛选框打开页面:', parsed.url))
        .catch((error) => log('[page] 从侧栏筛选框打开失败:', error.message));
    });
    syncSidebarFilterClear();
    let sidebarFilterTimer = null;
    sidebarFilter.addEventListener('input', () => {
      if (sidebarFilterTimer) clearTimeout(sidebarFilterTimer);
      sidebarFilterTimer = setTimeout(() => {
        sidebarFilterTimer = null;
        sidebarFilterText = sidebarFilter.value || '';
        renderSidebar();
        Object.keys(siteStatus).forEach((id) => { if (siteStatus[id]) markSiteStatus(id, siteStatus[id]); });
        const active = currentSiteId ? document.querySelector('.site-btn[data-id="' + currentSiteId + '"]') : null;
        if (active) active.classList.add('active');
        syncSidebarFilterClear();
      }, 120);
    });
  }
  expandAllBtn.addEventListener('click', expandAllGroups);
  collapseAllBtn.addEventListener('click', collapseAllGroups);
  bindPageActions();
  bindApiToolActions();
  bindSchedulerActions();
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
