// tabs.js -- 右侧标签栏渲染、拖动排序与 tab 关闭/复制操作

/* 查找站点所属分组对象;找不到返回 null
 * 克隆 tab 不在任何 groups 内:先按 sourceId 回溯源站点取其所属分组(保证 tab 缺口/图标与目录树一致),
 * 源配置已删再按 type 兜底匹配 */
function findGroupOf(site) {
  const g = groups.find((g) => g.sites.some((s) => s.id === site.id));
  if (g) return g;
  if (site.isClone && site.sourceId) {
    const src = groups.flatMap((grp) => grp.sites).find((s) => s.id === site.sourceId);
    const sg = src && groups.find((grp) => grp.sites.some((s) => s.id === src.id));
    if (sg) return sg;
  }
  return groups.find((g) => g.type === site.type) || null;
}

/* 站点所属分组的名称;找不到返回空串 */
function getGroupLabel(site) {
  const g = findGroupOf(site);
  return g ? g.label : '';
}

/* 站点所属分组的图标(state.groupColors 分配的色块,与左侧目录树同源);找不到回退类型 emoji 图标 */
function getGroupIcon(site) {
  const g = findGroupOf(site);
  return g ? g.icon : getProfile(site.type).icon;
}


/* ===== tab 上按钮(关闭/刷新)的自定义提示气泡:四边闭合 ===== */
let tabButtonTipTimer = null;

function tabButtonTipElement() {
  let tip = document.getElementById('tabButtonTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tabButtonTip';
    tip.className = 'tab-button-tip';
    document.body.appendChild(tip);
  }
  return tip;
}

function hideTabButtonTip() {
  if (tabButtonTipTimer) { clearTimeout(tabButtonTipTimer); tabButtonTipTimer = null; }
  const tip = document.getElementById('tabButtonTip');
  if (tip) tip.classList.remove('visible');
}

function showTabButtonTip(target) {
  const text = target && target.dataset ? target.dataset.tip : '';
  if (!text) return;
  const tip = tabButtonTipElement();
  tip.textContent = text;
  tip.classList.add('visible');
  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
  let top = rect.top - tipRect.height - 6;
  if (top < 4) top = rect.bottom + 6;
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}

function bindTabButtonTip(target) {
  if (!target) return;
  target.addEventListener('mouseenter', () => {
    if (tabButtonTipTimer) clearTimeout(tabButtonTipTimer);
    tabButtonTipTimer = setTimeout(() => { tabButtonTipTimer = null; showTabButtonTip(target); }, 120);
  });
  target.addEventListener('mouseleave', hideTabButtonTip);
  target.addEventListener('mousedown', hideTabButtonTip);
}

/* ===== 右侧标签栏:每个已展开(有 webview)的站点一个 tab ===== */
function renderTabs() {
  tabBar.innerHTML = '';
  const openSites = [];
  groups.forEach((g) => g.sites.forEach((s) => { if (webviews[s.id] && !s.paneOnly) openSites.push(s); }));
  // 克隆 tab 追加在最后(与打开顺序一致)
  clonedSites.forEach((s) => { if (webviews[s.id] && !s.paneOnly) openSites.push(s); });
  // 动态页面(打开新页面)追加在最后
  dynamicPages.forEach((s) => { if (webviews[s.id] && !s.paneOnly) openSites.push(s); });
  if (!openSites.length) { tabBar.classList.add('empty'); return; }
  tabBar.classList.remove('empty');
  // 按 tabOrder(拖动排序结果)排列;syncTabOrder 已保证全部命中
  syncTabOrder();
  const orderIdx = new Map(tabOrder.map((id, i) => [id, i]));
  openSites.sort((a, b) => (orderIdx.get(a.id) || 0) - (orderIdx.get(b.id) || 0));
  openSites.forEach((site) => {
    const tab = document.createElement('div');
    const profile = getProfile(site.type);
    tab.className = 'tab' + (site.id === currentSiteId ? ' active' : '');
    tab.dataset.id = site.id;
    const grp = findGroupOf(site);
    // tab 头主题色:统一取分组色(与目录树/分组图标同源,消除同分组内不同 type 的背景色差异);
    // 分组缺失时回退类型 accent。此处只提供色值,普通态不展示分组色(纯白),
    // 由 CSS 在 hover/active 时按 --tab-accent 着色:active 整块填充分组色并统一用白字
    const groupColor = (grp && grp.color) || profile.accent;
    tab.style.setProperty('--tab-accent', groupColor);
    // 左上角凸出的分组名称(.tab::before);hover 气泡内容 data-tip(.tab::after,代替原生 title)
    const groupLabel = grp ? grp.label : '';
    tab.dataset.group = groupLabel;
    tab.dataset.tip = groupLabel ? groupLabel + ' · ' + site.name : site.name;
    tab.innerHTML =
      '<span class="tab-icon">' + getGroupIcon(site) + '</span>' +
      '<span class="tab-name"></span>' +
      // 刷新图标用字符画:两个 ↻ 叠放(其中一个旋转 180°),形成首尾相接的圆形双箭头
      '<span class="tab-reload" data-tip="刷新">' + '<span class="tab-reload-glyph">↻</span>' + '<span class="tab-reload-glyph tab-reload-glyph-flip">↻</span>' + '</span>' +
      '<span class="tab-close" data-tip="关闭">×</span>';
    tab.querySelector('.tab-name').textContent = site.name;
    tab.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.tab-close, .tab-reload')) return;
      selectSite(site);
    });
    // hover 进入时决定气泡方向:默认展示在左侧;左侧空间不足且右侧足够时翻到右侧,
    // 右侧也靠边时保持左侧(避免两侧都被 #content overflow:hidden 裁剪)
    tab.addEventListener('mouseenter', () => {
      const barRect = tabBar.getBoundingClientRect();
      const rect = tab.getBoundingClientRect();
      // 气泡最大宽度约 240px(分组名 · 完整站点名,nowrap)
      const NEED = 240;
      const spaceLeft = rect.left - barRect.left;
      const spaceRight = barRect.right - rect.right;
      tab.classList.toggle('tip-right', spaceLeft < NEED && spaceRight >= NEED);
    });
    // 右上角关闭;原来关闭的位置改放刷新
    tab.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(site); });
    tab.querySelector('.tab-reload').addEventListener('click', (e) => { e.stopPropagation(); reloadSite(site); });
    // 关闭/刷新用自定义气泡(原生 title 无法带完整边框)
    bindTabButtonTip(tab.querySelector('.tab-close'));
    bindTabButtonTip(tab.querySelector('.tab-reload'));
    // 恢复登录状态标记
    const st = siteStatus[site.id];
    if (st === 'ok') tab.classList.add('batch-ok');
    else if (st === 'skip') tab.classList.add('batch-skip');
    else if (st === 'current') tab.classList.add('batch-current');
    // 拖动排序:dragover 时实时移动 DOM,dragend 按 DOM 顺序回写 tabOrder 并持久化
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', site.id); } catch (err) {}
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      applyTabDomOrder();
    });
    tabBar.appendChild(tab);
  });
}

/* 拖动中的 tab 实时插入到目标位置(按目标 tab 行内中点判断插入前/后,兼容 flex-wrap 多行) */
tabBar.addEventListener('dragover', (e) => {
  const dragging = tabBar.querySelector('.tab.dragging');
  if (!dragging) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.target.closest('.tab');
  if (!target || target === dragging) return;
  const rect = target.getBoundingClientRect();
  if (e.clientX < rect.left + rect.width / 2) tabBar.insertBefore(dragging, target);
  else tabBar.insertBefore(dragging, target.nextSibling);
});
tabBar.addEventListener('drop', (e) => { if (tabBar.querySelector('.tab.dragging')) e.preventDefault(); });

/* 拖动结束:按 tab 栏 DOM 顺序回写 tabOrder,并持久化打开顺序 */
function applyTabDomOrder() {
  const ordered = [...tabBar.querySelectorAll('.tab')].map((t) => findSiteById(t.dataset.id)).filter((s) => s && webviews[s.id]);
  tabOrder.length = 0;
  ordered.forEach((s) => tabOrder.push(s.id));
  saveOpenTabs();
  log('[tab] 拖动排序 ->', tabOrder.join(','));
}

/* ===== 关闭单个 tab:销毁该站点 webview,切到下一个仍打开的站点 ===== */
function closeTab(site) {
  const wasActive = site.id === currentSiteId;
  destroyWebview(site);
  if (wasActive) {
    const next = getOpenedSitesInOrder()[0];
    if (next) selectSite(next);
    else { currentSiteId = null; content.classList.remove('loaded'); applyAppBackground(null); saveLastTab(); }
  }
  renderTabs();
}

/* ===== 关闭全部 tab:销毁所有 webview(分组保持展开,可重新点击站点打开) ===== */
function closeAllTabs() {
  groups.forEach((g) => g.sites.forEach((s) => { if (webviews[s.id]) destroyWebview(s); }));
  clonedSites.slice().forEach((s) => { if (webviews[s.id]) destroyWebview(s); });
  dynamicPages.slice().forEach((s) => { if (webviews[s.id]) destroyWebview(s); });
  renderTabs();
  currentSiteId = null;
  content.classList.remove('loaded');
  document.querySelectorAll('.site-btn').forEach((b) => b.classList.remove('active'));
  applyAppBackground(null);
  saveLastTab();
  log('[tab] 关闭全部标签页');
}

/* 按打开顺序(tab 栏顺序,含拖动排序结果)返回当前已创建 webview 的站点(含克隆 tab) */
function getOpenedSitesInOrder() {
  syncTabOrder();
  return tabOrder.map((id) => findSiteById(id)).filter((s) => s && webviews[s.id]);
}

/* 关闭后收尾:重绘 tab;若当前站点被关闭,切到 refSite 或第一个打开的,否则占位 */
function finalizeClose(refSite) {
  renderTabs();
  if (currentSiteId && !webviews[currentSiteId]) {
    const target = (refSite && webviews[refSite.id]) ? refSite : getOpenedSitesInOrder()[0];
    if (target) selectSite(target);
    else { currentSiteId = null; content.classList.remove('loaded'); applyAppBackground(null); saveLastTab(); }
  }
}

/* 关闭指定站点左侧的标签 */
function closeLeftTabs(refSite) {
  const opened = getOpenedSitesInOrder();
  const idx = opened.findIndex((s) => s.id === refSite.id);
  if (idx <= 0) return;
  opened.slice(0, idx).forEach((s) => destroyWebview(s));
  finalizeClose(refSite);
  log('[tab] 关闭左侧标签');
}

/* 关闭指定站点右侧的标签 */
function closeRightTabs(refSite) {
  const opened = getOpenedSitesInOrder();
  const idx = opened.findIndex((s) => s.id === refSite.id);
  if (idx < 0) return;
  opened.slice(idx + 1).forEach((s) => destroyWebview(s));
  finalizeClose(refSite);
  log('[tab] 关闭右侧标签');
}

/* 关闭除指定站点外的其他标签 */
function closeOtherTabs(refSite) {
  getOpenedSitesInOrder().forEach((s) => { if (s.id !== refSite.id) destroyWebview(s); });
  finalizeClose(refSite);
  log('[tab] 关闭其他标签');
}
