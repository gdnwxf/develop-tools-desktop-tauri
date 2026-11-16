// main.js -- renderer 入口:初始化与状态恢复
// 左侧分组(可折叠)+ 右侧多 webview(每站点独立,切换秒切)。
// 整合 Superset/Redis/Grafana/YApi 等类型:仅配置结构变为分组,各类型登录逻辑
// 完全复用对应原始工程(supert=URL正则+form.submit;redisinsight=DOM探测+form.submit兜底;
// grafana=DOM探测+requestSubmit;yapi=DOM探测+antd表单,user优先填email框),按 site.type 分派。
// 展开分组仅显示站点列表;点击站点才创建 webview 并自动登录;收起则销毁 webview。
//
// 模块加载顺序(index.html 按序引入,共享全局作用域):
//   state.js -> sidebar.js -> webview.js -> navigation.js -> tabs.js -> menus.js -> main.js

init().catch((error) => showBootStatus('启动失败：' + error.message));

function showBootStatus(message, configPath) {
  content.classList.remove('loaded');
  const card = document.querySelector('.placeholder-card');
  card.replaceChildren();
  const text = document.createElement('p');
  text.textContent = message;
  card.appendChild(text);
  if (configPath) {
    const path = document.createElement('p');
    path.className = 'placeholder-sub';
    path.textContent = configPath;
    const open = document.createElement('button');
    open.textContent = '打开配置文件';
    open.addEventListener('click', () => window.desktopApp.openLink(configPath).catch((error) => {
      text.textContent = '打开配置失败：' + error.message;
    }));
    card.append(path, open);
  }
  const retry = document.createElement('button');
  retry.textContent = '重启应用';
  retry.addEventListener('click', () => window.desktopApp.invoke('restart').catch((error) => {
    text.textContent = '重启失败：' + error.message;
  }));
  card.appendChild(retry);
}

async function init() {
  const boot = await window.desktopApp.getBootstrap();
  if (boot.configError) {
    showBootStatus('配置加载失败：' + boot.configError, boot.configPath);
    return;
  }
  groups = await window.desktopApp.getGroups();
  if (!groups.some((group) => group.sites && group.sites.length)) {
    showBootStatus('配置中还没有站点，请打开配置文件添加站点后重启应用。', boot.configPath);
    return;
  }
  settings = await window.desktopApp.getSettings();
  state = await window.desktopApp.getState();
  state.lastUrls = state.lastUrls || {};
  // 恢复 tab 顺序(拖动排序结果随 openTabs 持久化);未打开的 id 由 syncTabOrder 惰性剔除
  tabOrder.length = 0;
  if (Array.isArray(state.openTabs)) tabOrder.push(...state.openTabs);

  // 恢复持久化的克隆 tab(站点定义随 openTabs 一并保存);计数器续接已有序号,避免新克隆 id 碰撞。
  // 持久化中只有 sourceId 引用、不含账密:此处按源配置回填 user/password/optsecret,源配置已删则不回填
  if (Array.isArray(state.clonedSites)) {
    state.clonedSites.forEach((c) => {
      if (!c || !c.id || !c.url) return;
      const clone = { id: c.id, name: c.name, type: c.type, url: c.url, isClone: true };
      if (c.sourceId) {
        const src = groups.flatMap((g) => g.sites).find((s) => s.id === c.sourceId);
        if (src) {
          clone.sourceId = src.id;
          ['user', 'password', 'optsecret'].forEach((k) => { if (src[k]) clone[k] = src[k]; });
        } else {
          // cookie 仍有效时克隆 tab 可直接使用;仅当掉到登录页才会因无账密跳过自动登录
          log('[init] 克隆 tab 的源站点已删除,不恢复自动登录凭据:', c.name);
        }
      }
      clonedSites.push(clone);
    });
    const maxClone = clonedSites.reduce((m, s) => Math.max(m, parseInt(s.id.slice('copy-'.length), 10) || 0), 0);
    if (cloneCounter < maxClone) cloneCounter = maxClone;
    if (clonedSites.length) log('[init] 恢复克隆 tab:', clonedSites.map((s) => s.name).join(', '));
  }

  // 启动展开:有已保存状态(数组)则恢复(同最后一次),否则用 default_expand 作为首次默认;lastTab 所属分组由后续 selectSite 追加(并集)
  if (Array.isArray(state.expandedGroups)) {
    state.expandedGroups.forEach((k) => { if (groups.some((g) => g.key === k)) expandedGroups.add(k); });
  } else {
    const dc = settings.defaultExpand;
    if (dc === 'all') {
      groups.forEach((g) => expandedGroups.add(g.key));
    } else {
      // 支持逗号分隔字符串("db,redis")或数组(["db","redis"]); 空串/缺省/无效值=全折叠
      const keys = Array.isArray(dc) ? dc : String(dc || '').split(',').map((s) => s.trim()).filter(Boolean);
      keys.forEach((k) => { if (groups.some((g) => g.key === k)) expandedGroups.add(k); });
    }
  }

  log('[init] 分组:', groups.map((g) => g.key + '(' + g.sites.length + ')').join(', '), '| 展开:', [...expandedGroups].join(',') || '(无)', '| lastTab:', state.lastTab || '(无)');

  renderSidebar();
  bindActions();

  renderTabs();

  // 恢复上次打开的所有 tab(并行创建 webview + 登录,含克隆 tab),选中 lastTab;无则显示占位
  const allSites = groups.flatMap((g) => g.sites);
  const openIds = Array.isArray(state.openTabs) ? state.openTabs.filter((id) => findSiteById(id)) : [];
  if (openIds.length > 0) {
    openIds.forEach((id) => {
      const s = findSiteById(id);
      if (s && !webviews[s.id]) createWebview(s, false);
    });
    // 全部 handle 建好后再保存，避免暂时移除尚未创建的无源克隆定义。
    saveOpenTabs();
    renderTabs();
    const restoreSite = (state.lastTab && openIds.includes(state.lastTab)) ? findSiteById(state.lastTab) : allSites.find((s) => webviews[s.id]);
    if (restoreSite) selectSite(restoreSite);
    else { currentSiteId = null; content.classList.remove('loaded'); applyAppBackground(null); }
  } else {
    currentSiteId = null;
    content.classList.remove('loaded');
    applyAppBackground(null);
  }
}
