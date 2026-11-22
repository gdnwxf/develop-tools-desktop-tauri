// split.js -- 右侧多面板:树形无限细分(split right / split down / clone pane)
// 布局树:{type:'split', direction:'row'|'column', ratio, first, second} | {type:'leaf', id, siteId}
// 每个叶子对应一个 webview(或空白格);几何由树递归算出,前端给元素设 left/top/width/height,
// native-layout.js 会按每个视图的矩形同步原生 WebView2 子窗口,拖分隔条即可实时调整比例。
// 关闭某个面板时其叶子被兄弟节点替换(自适应上收),树只剩一个叶子时回到单窗模式。

const SPLIT_MIN_RATIO = 0.15;
const SPLIT_MAX_RATIO = 0.85;
const SPLIT_GAP = 4;
const SPLIT_PAD = 4;
const SPLIT_BAR = 10;
const SPLIT_TITLE_H = 18;      // 每格顶部标题条高度(在面板内部,原生子窗口会盖住浮层所以放内部)
const SPLIT_MIN_PANE_H = 40;   // 页面区最小高度

let splitTree = null;      // null = 单窗模式
let splitLayout = 'single'; // single | preset 名称 | custom(仅用于快照描述与恢复)
let splitFocusLeafId = ''; // 当前焦点叶子
let splitRootTabId = '';   // 分屏根 tab:根 tab 关闭 => 整个分屏关闭
let paneSequence = 0;
const splitPanes = new Map(); // leafId -> { siteId, el } el: webview 元素或空白 div
let splitDragging = null;

function splitIsActive() {
  return splitTree !== null;
}

function nextPaneId() {
  paneSequence += 1;
  return 'pane-' + paneSequence;
}

/* ===== 树操作 ===== */
function splitCreateLeaf(siteId) {
  return { type: 'leaf', id: nextPaneId(), siteId: siteId || null };
}

function splitLeaves(node, acc) {
  const out = acc || [];
  if (!node) return out;
  if (node.type === 'leaf') { out.push(node); return out; }
  splitLeaves(node.first, out);
  splitLeaves(node.second, out);
  return out;
}

function splitFindLeaf(node, leafId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === leafId ? node : null;
  return splitFindLeaf(node.first, leafId) || splitFindLeaf(node.second, leafId);
}

function splitFindParent(node, leafId, parent) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === leafId ? parent : null;
  return splitFindParent(node.first, leafId, node) || splitFindParent(node.second, leafId, node);
}

/* 用新的替换节点替换掉 target 叶子,返回是否替换成功 */
function splitReplaceLeaf(node, leafId, replacement) {
  if (!node) return false;
  if (node.type === 'leaf') return false;
  if (node.first.type === 'leaf' && node.first.id === leafId) { node.first = replacement; return true; }
  if (node.second.type === 'leaf' && node.second.id === leafId) { node.second = replacement; return true; }
  return splitReplaceLeaf(node.first, leafId, replacement) || splitReplaceLeaf(node.second, leafId, replacement);
}

/* 删除叶子:父节点被兄弟节点顶替(自适应),返回新的子树根 */
function splitRemoveLeaf(node, leafId) {
  if (!node || node.type === 'leaf') return node;
  if (node.first.type === 'leaf' && node.first.id === leafId) return node.second;
  if (node.second.type === 'leaf' && node.second.id === leafId) return node.first;
  const first = splitRemoveLeaf(node.first, leafId);
  if (first !== node.first) { node.first = first; return node; }
  const second = splitRemoveLeaf(node.second, leafId);
  if (second !== node.second) { node.second = second; return node; }
  return node;
}



/* ===== 分屏布局持久化(与 Electron 版一致) ===== */
function splitSerializeTree(node) {
  if (!node) return null;
  if (node.type === 'leaf') {
    const siteId = node.siteId && !node.siteId.startsWith('page-dyn-') ? node.siteId : null;
    return { type: 'leaf', siteId };
  }
  return {
    type: 'split',
    direction: node.direction,
    ratio: Math.round(Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, node.ratio)) * 1000) / 1000,
    first: splitSerializeTree(node.first),
    second: splitSerializeTree(node.second),
  };
}

function splitSnapshot() {
  if (!splitTree) return { layout: 'single', tree: null, focusIndex: -1 };
  const leaves = splitLeaves(splitTree);
  const focusIndex = leaves.findIndex((leaf) => leaf.id === splitFocusLeafId);
  return { layout: splitLayout, tree: splitSerializeTree(splitTree), focusIndex: focusIndex < 0 ? 0 : focusIndex };
}

let splitLastSaved = '';

function splitPersist(force) {
  const snapshot = splitSnapshot();
  const signature = JSON.stringify(snapshot);
  if (!force && signature === splitLastSaved) return;
  splitLastSaved = signature;
  if (!window.desktopApp || typeof window.desktopApp.saveSplitLayout !== 'function') return;
  Promise.resolve(window.desktopApp.saveSplitLayout(snapshot))
    .catch((error) => log('[split] 保存布局失败:', error && error.message));
}

function splitDeserializeTree(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'leaf') {
    const siteId = typeof node.siteId === 'string' ? node.siteId : null;
    const usable = siteId && findSiteById(siteId) && webviews[siteId] ? siteId : null;
    return splitCreateLeaf(usable);
  }
  if (node.type !== 'split') return null;
  const ratio = typeof node.ratio === 'number' ? node.ratio : 0.5;
  const first = splitDeserializeTree(node.first);
  const second = splitDeserializeTree(node.second);
  if (!first || !second) return first || second;
  return { type: 'split', direction: node.direction === 'column' ? 'column' : 'row', ratio, first, second };
}

function splitRestore(snapshot) {
  if (!snapshot || !snapshot.tree) return false;
  const tree = splitDeserializeTree(snapshot.tree);
  if (!tree || tree.type !== 'split') return false;
  splitTree = tree;
  splitLayout = typeof snapshot.layout === 'string' ? snapshot.layout : 'custom';
  const leaves = splitLeaves(splitTree);
  const index = Number.isInteger(snapshot.focusIndex) ? snapshot.focusIndex : 0;
  splitFocusLeafId = (leaves[index] || leaves[0]).id;
  const focused = splitFindLeaf(splitTree, splitFocusLeafId);
  if (focused && focused.siteId) currentSiteId = focused.siteId;
  webviewContainer.classList.add('split');
  splitSyncPanes(true);
  splitLastSaved = JSON.stringify(splitSnapshot());
  log('[split] 已恢复分屏布局:', splitLayout, leaves.map((leaf) => leaf.siteId || 'blank').join(','));
  return true;
}

/* ===== 列序列工具(保证"一条整竖线"规则) ===== */
function collectColumns(node) {
  if (!node) return { cols: [], ratios: [] };
  if (node.type === 'split' && node.direction === 'row') {
    const left = collectColumns(node.first);
    const right = collectColumns(node.second);
    return { cols: [...left.cols, ...right.cols], ratios: [...left.ratios, node.ratio, ...right.ratios] };
  }
  return { cols: [node], ratios: [] };
}

function rebuildColumns(cols, ratios) {
  if (!cols.length) return null;
  let tree = cols[cols.length - 1];
  for (let index = cols.length - 2; index >= 0; index -= 1) {
    tree = { type: 'split', direction: 'row', ratio: typeof ratios[index] === 'number' ? ratios[index] : 0.5, first: cols[index], second: tree };
  }
  return tree;
}

function columnIndexOfLeaf(leafId) {
  const { cols } = collectColumns(splitTree);
  return cols.findIndex((col) => !!splitFindLeaf(col, leafId));
}

/* 在指定列右侧插入新列(空白),边界比例对半分以保持既有列宽 */
function insertColumnAfter(colIndex, siteId) {
  const { cols, ratios } = collectColumns(splitTree);
  const newLeaf = splitCreateLeaf(siteId || null);
  const nextCols = [...cols.slice(0, colIndex + 1), newLeaf, ...cols.slice(colIndex + 1)];
  const boundary = ratios[colIndex];
  const nextRatios = typeof boundary === 'number'
    ? [...ratios.slice(0, colIndex), boundary / 2, boundary / 2, ...ratios.slice(colIndex + 1)]
    : [...ratios, 0.5];
  splitTree = rebuildColumns(nextCols, nextRatios);
  return newLeaf;
}

/* 对指定面板左右分屏:在该面板所在列右侧插入新列 */
function splitColumnRightOf(leafId, siteId) {
  if (!splitTree) return splitLeaf(leafId, 'row', siteId || null);
  const colIndex = columnIndexOfLeaf(leafId);
  const total = collectColumns(splitTree).cols.length;
  const newLeaf = insertColumnAfter(colIndex < 0 ? total - 1 : colIndex, siteId || null);
  const focusLeaf = splitLeaves(splitTree).find((item) => item.siteId === currentSiteId);
  splitFocusLeafId = focusLeaf ? focusLeaf.id : (newLeaf ? newLeaf.id : splitLeaves(splitTree)[0].id);
  webviewContainer.classList.add('split');
  splitSyncPanes();
  log('[split] 在列右侧插入新列:', colIndex, '共', collectColumns(splitTree).cols.length, '列');
  return true;
}

/* ===== 几何计算 ===== */
/* 把树映射成每个叶子的矩形(相对 webviewContainer 的像素坐标) */
function splitComputeRects(node, area, out) {
  const rects = out || {};
  if (!node) return rects;
  if (node.type === 'leaf') {
    rects[node.id] = area;
    return rects;
  }
  const gap = SPLIT_GAP;
  const ratio = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, node.ratio));
  if (node.direction === 'row') {
    const usable = Math.max(0, area.width - gap);
    const firstWidth = Math.round(usable * ratio);
    splitComputeRects(node.first, { ...area, width: firstWidth }, rects);
    splitComputeRects(node.second, { ...area, left: area.left + firstWidth + gap, width: Math.max(0, usable - firstWidth) }, rects);
  } else {
    const usable = Math.max(0, area.height - gap);
    const firstHeight = Math.round(usable * ratio);
    splitComputeRects(node.first, { ...area, height: firstHeight }, rects);
    splitComputeRects(node.second, { ...area, top: area.top + firstHeight + gap, height: Math.max(0, usable - firstHeight) }, rects);
  }
  return rects;
}

function splitContainerArea() {
  const rect = webviewContainer.getBoundingClientRect();
  return {
    left: SPLIT_PAD,
    top: SPLIT_PAD,
    width: Math.max(0, rect.width - SPLIT_PAD * 2),
    height: Math.max(0, rect.height - SPLIT_PAD * 2),
  };
}

/* 只在与上次不同的时候写几何,避免每次重排都触发样式重算 */
function splitSetRect(el, rect) {
  if (!el || !el.style || !rect) return;
  const signature = rect.left + ',' + rect.top + ',' + rect.width + ',' + rect.height;
  if (el.__rectSig === signature) return;
  el.__rectSig = signature;
  el.style.position = 'absolute';
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
}

const splitTitleElements = new Map();

function splitApplyRect(el, rect) {
  if (!el || !el.style) return;
  el.style.position = 'absolute';
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
}

/* 空白格:中央列出最近打开过的页面,点击在该格里打开 */
/* 空白格里的“最近打开”:过去打开历史去重(含动态页面)+ 左侧树站点 + 其它已打开 tab。
 * 顺序 = 历史(按时间倒序) → 树顺序 → 其它 tab(按 URL 排序,不随当前 tab 变化)。
 */
function splitRecentEntries(limit) {
  const seen = new Set();
  const entries = [];
  // 去重键 = 规范化 URL(去尾斜杠/统一小写);没有 URL 时退回站点 id
  const keyOf = (url, id) => {
    const text = String(url || '').trim().toLowerCase().replace(/\/+$/, '');
    return text || ('id:' + id);
  };

  (Array.isArray(recentSites) ? recentSites : []).forEach((item) => {
    if (!item) return;
    const site = item.siteId ? findSiteById(item.siteId) : null;
    const url = item.url || (site && site.url) || '';
    const name = item.name || (site && site.name) || url;
    if (!url) return;
    const key = keyOf(url, site ? site.id : name);
    if (seen.has(key)) return;
    seen.add(key);
    const group = site ? groups.find((g) => g.sites.some((s) => s.id === site.id)) : null;
    entries.push({
      site: site || { id: 'url:' + url, name, url, type: 'web', groupKey: item.groupKey || 'page', isDynamic: true },
      groupLabel: group ? group.label : (item.groupKey || 'page'),
    });
  });

  groups.forEach((group) => group.sites.forEach((site) => {
    const key = keyOf(site.url, site.id);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ site, groupLabel: group.label });
  }));

  const extras = [];
  if (typeof getOpenedSitesInOrder === 'function') {
    getOpenedSitesInOrder().forEach((site) => {
      if (!site) return;
      const key = keyOf(site.url, site.id);
      if (seen.has(key)) return;
      seen.add(key);
      const group = groups.find((g) => g.sites.some((s) => s.id === site.id));
      extras.push({ site, groupLabel: group ? group.label : (site.groupKey || '') });
    });
  }
  extras.sort((a, b) => String(a.site.url || '').localeCompare(String(b.site.url || '')));
  extras.forEach((entry) => entries.push(entry));

  return entries.slice(0, limit || 20);
}

/* 点选历史项:已在树里直接填入;历史里的动态页面按 URL 重建后填入 */
function splitOpenEntryInLeaf(leafId, entry) {
  if (!entry || !entry.site) return;
  const site = entry.site;
  const known = site.id && findSiteById(site.id);
  if (known) { splitOpenInLeaf(leafId, known); return; }
  if (!site.url) return;
  const group = (typeof ensurePageGroup === 'function' ? ensurePageGroup() : null)
    || groups.find((item) => item.key === 'page');
  if (!group) return;
  dynamicPageCounter += 1;
  const created = {
    id: 'page-dyn-' + dynamicPageCounter,
    groupKey: group.key,
    type: 'web',
    name: typeof uniquePageName === 'function' ? uniquePageName(group, site.name) : (site.name || site.url),
    url: site.url,
    isDynamic: true,
  };
  group.sites.push(created);
  if (typeof dynamicPages !== 'undefined' && Array.isArray(dynamicPages)) dynamicPages.push(created);
  renderSidebar();
  splitOpenInLeaf(leafId, created);
}

function splitCreateEmptyPane(leafId) {
  const box = document.createElement('div');
  box.className = 'split-empty';
  box.dataset.paneId = leafId;
  const title = document.createElement('div');
  title.className = 'split-empty-title';
  title.textContent = '最近打开';
  // 过滤框:按站点名/分组名简单过滤下面的列表
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'split-empty-filter';
  filter.placeholder = '过滤站点…';
  filter.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'split-empty-list';
  const entries = splitRecentEntries();
  if (!entries.length) {
    const tip = document.createElement('div');
    tip.className = 'split-empty-tip';
    tip.textContent = '没有可打开的页面';
    list.appendChild(tip);
  } else {
    entries.forEach((entryArg) => {
      const { site, groupLabel } = entryArg;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'split-empty-item';
      item.title = (groupLabel ? groupLabel + ' · ' : '') + site.name;
      item.dataset.filterText = (site.name || '') + ' ' + (groupLabel || '');
      const name = document.createElement('span');
      name.className = 'split-empty-name';
      name.textContent = site.name;
      const meta = document.createElement('span');
      meta.className = 'split-empty-meta';
      meta.textContent = groupLabel || '';
      item.append(name, meta);
      item.addEventListener('click', () => splitOpenEntryInLeaf(leafId, entryArg));
      list.appendChild(item);
    });
  }
  box.append(title, filter, list);
  filter.addEventListener('input', () => {
    const needle = filter.value.trim().toLowerCase();
    let visible = 0;
    list.querySelectorAll('.split-empty-item').forEach((item) => {
      const hay = (item.dataset.filterText || item.textContent || '').toLowerCase();
      const matched = !needle || hay.includes(needle);
      item.style.display = matched ? '' : 'none';
      if (matched) visible += 1;
    });
    const tip = list.querySelector('.split-empty-tip');
    if (tip) {
      tip.style.display = visible ? 'none' : '';
      if (visible) tip.textContent = '';
    }
  });
  filter.addEventListener('mousedown', (event) => event.stopPropagation());
  webviewContainer.appendChild(box);
  return box;
}


/* 把叶子矩形拆成"标题条 + 页面区":页面区整体下移,原生 WebView2 子窗口按该矩形同步 */
function splitPaneParts(rect) {
  const titleHeight = Math.min(SPLIT_TITLE_H, Math.max(0, rect.height - SPLIT_MIN_PANE_H));
  return {
    title: { left: rect.left, top: rect.top, width: rect.width, height: titleHeight },
    pane: { left: rect.left, top: rect.top + titleHeight, width: rect.width, height: Math.max(0, rect.height - titleHeight) },
  };
}


/* 焦点面板描边色:跟随菜单主题(当前分组色,与 tab/侧栏激活色同源);取不到回退主题蓝 */
const SPLIT_FOCUS_FALLBACK = '#4f46e5';

function splitFocusColor(site) {
  if (!site) return SPLIT_FOCUS_FALLBACK;
  const group = groups.find((item) => item.sites.some((s) => s.id === site.id))
    || groups.find((item) => item.key === site.groupKey);
  if (group && typeof group.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(group.color)) return group.color;
  return SPLIT_FOCUS_FALLBACK;
}

function splitApplyFocusColor(site) {
  if (!webviewContainer || !webviewContainer.style) return;
  webviewContainer.style.setProperty('--pane-focus', splitFocusColor(site));
}

/* 每格自己的标题条:站点名(空白格为"空白"),焦点格高亮;点击聚焦该格 */
function splitUpdatePaneTitle(leaf, rect, focused) {
  let title = splitTitleElements.get(leaf.id);
  if (title && title.isConnected === false) { splitTitleElements.delete(leaf.id); title = null; }
  if (!title) {
    title = document.createElement('div');
    title.className = 'pane-title';
    title.dataset.paneId = leaf.id;
    const dot = document.createElement('span');
    dot.className = 'pane-title-dot';
    const name = document.createElement('span');
    name.className = 'pane-title-name';
    title.append(dot, name);
    title.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.desktopApp.invoke('context_menu', { kind: 'pane', siteId: leaf.id, x: event.clientX, y: event.clientY })
        .catch((error) => log('[context-menu]', '打开面板菜单失败:', error.message));
    });
    title.addEventListener('mousedown', (event) => {
      if (event.target && event.target.closest && event.target.closest('.pane-title-actions')) return;
      event.preventDefault();
      event.stopPropagation();
      const target = splitFindLeaf(splitTree, leaf.id);
      if (target && target.siteId) {
        const site = findSiteById(target.siteId);
        if (site) selectSite(site);
      }
    });
    // 标题条最右侧三个按钮:左右分 / 上下分 / 关闭(都作用于这个面板)
    const actions = document.createElement('span');
    actions.className = 'pane-title-actions';
    const makeAction = (kind, label, text) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pane-title-btn';
      button.dataset.action = kind;
      button.dataset.paneId = leaf.id;
      button.title = label;
      button.textContent = text;
      button.addEventListener('mousedown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const currentLeaf = splitFindLeaf(splitTree, leaf.id);
        if (!currentLeaf) return;
        if (kind === 'close-pane') { splitClosePane(currentLeaf.id); return; }
        splitFocusLeafId = currentLeaf.id;
        if (kind === 'split-right') splitColumnRightOf(currentLeaf.id, null);
        else splitLeaf(currentLeaf.id, 'column', null);
      });
      return button;
    };
    actions.append(
      makeAction('split-right', '左右分屏', '⇔'),
      makeAction('split-down', '上下分屏', '⇕'),
      makeAction('close-pane', '关闭面板', '✕'),
    );
    title.appendChild(actions);
    splitTitleElements.set(leaf.id, title);
    webviewContainer.appendChild(title);
  }
  const site = leaf.siteId ? findSiteById(leaf.siteId) : null;
  const text = leaf.siteId ? (site ? site.name : leaf.siteId) : '空白';
  const name = title.querySelector('.pane-title-name');
  if (name && name.textContent !== text) name.textContent = text;
  const actionButtons = title.querySelectorAll ? title.querySelectorAll('.pane-title-btn') : [];
  actionButtons.forEach((button) => { button.dataset.paneId = leaf.id; });
  title.title = text;
  title.classList.toggle('focus', focused);
  splitSetRect(title, rect);
  title.style.zIndex = '4';
  return title;
}

/* ===== 渲染 ===== */
let splitLastSignature = '';
let splitLastLogged = '';

function splitSyncPanes(force) {
  const leaves = splitLeaves(splitTree);
  const area = splitContainerArea();
  const signature = [splitFocusLeafId, area.width, area.height,
    leaves.map((leaf) => leaf.id + ':' + (leaf.siteId || '')).join('|')].join('#');
  if (!force && signature === splitLastSignature) return;
  splitLastSignature = signature;
  const wanted = new Set(leaves.map((leaf) => leaf.id));
  // 清理已不存在叶子的空白格
  [...webviewContainer.querySelectorAll('.split-empty')].forEach((box) => {
    if (!wanted.has(box.dataset.paneId)) box.remove();
  });
  const rects = splitComputeRects(splitTree, splitContainerArea());
  const wantedPanes = new Set(leaves.map((leaf) => leaf.id));
  [...webviewContainer.querySelectorAll('.pane-title')].forEach((title) => {
    if (!wantedPanes.has(title.dataset.paneId)) title.remove();
  });
  leaves.forEach((leaf) => {
    let entry = splitPanes.get(leaf.id);
    if (!entry) { entry = { siteId: null, el: null }; splitPanes.set(leaf.id, entry); }
    const parts = splitPaneParts(rects[leaf.id]);
    const focused = leaf.id === splitFocusLeafId;
    if (leaf.siteId) {
      const wv = webviews[leaf.siteId];
      if (entry.el && entry.el.classList.contains('split-empty')) { entry.el.remove(); entry.el = null; }
      if (wv) {
        wv.classList.add('active');
        splitSetRect(wv, parts.pane);
        entry.el = wv;
      }
      entry.siteId = leaf.siteId;
    } else {
      if (!entry.el || !entry.el.classList.contains('split-empty')) {
        if (entry.el && entry.el.classList) entry.el.classList.remove('active');
        entry.el = splitCreateEmptyPane(leaf.id);
      }
      splitSetRect(entry.el, parts.pane);
      entry.siteId = null;
    }
    const el = entry.el;
    if (el) {
      el.classList.toggle('split-focused', focused);
      if (!el.classList.contains('split-empty')) el.classList.add('active');
    }
    splitUpdatePaneTitle(leaf, parts.title, focused);
  });
  splitRenderSplitters();
  splitPersist();
  const focusedLeaf = splitFindLeaf(splitTree, splitFocusLeafId);
  splitApplyFocusColor(focusedLeaf && focusedLeaf.siteId ? findSiteById(focusedLeaf.siteId) : null);
  if (window.nativeViewLayout) window.nativeViewLayout.schedule();
  syncTabActive();
}

/* 每个 split 节点生成一条可拖拽的分隔条 */
function splitRenderSplitters() {
  const wanted = new Map();
  const walk = (node, area) => {
    if (!node || node.type === 'leaf') return;
    const gap = SPLIT_GAP;
    const ratio = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, node.ratio));
    if (node.direction === 'row') {
      const usable = Math.max(0, area.width - gap);
      const firstWidth = Math.round(usable * ratio);
      wanted.set(node, {
        left: area.left + firstWidth + gap / 2 - SPLIT_BAR / 2,
        top: area.top, width: SPLIT_BAR, height: area.height, direction: 'row',
      });
      walk(node.first, { ...area, width: firstWidth });
      walk(node.second, { ...area, left: area.left + firstWidth + gap, width: Math.max(0, usable - firstWidth) });
    } else {
      const usable = Math.max(0, area.height - gap);
      const firstHeight = Math.round(usable * ratio);
      wanted.set(node, {
        left: area.left, top: area.top + firstHeight + gap / 2 - SPLIT_BAR / 2,
        width: area.width, height: SPLIT_BAR, direction: 'column',
      });
      walk(node.first, { ...area, height: firstHeight });
      walk(node.second, { ...area, top: area.top + firstHeight + gap, height: Math.max(0, usable - firstHeight) });
    }
  };
  walk(splitTree, splitContainerArea());

  const existing = [...webviewContainer.querySelectorAll('.split-bar')];
  existing.forEach((bar) => {
    if (![...wanted.keys()].some((node) => node.__barId === bar.dataset.nodeId)) bar.remove();
  });
  wanted.forEach((rect, node) => {
    // 用全局自增 id,避免新节点复用旧节点的 bar id(会少画分隔线)
    if (!node.__barId) node.__barId = 'split-node-' + nextPaneId();
    let bar = existing.find((el) => el.dataset.nodeId === node.__barId);
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'split-bar';
      bar.dataset.nodeId = node.__barId;
      bar.addEventListener('pointerdown', (event) => splitStartDrag(node, rect.direction, event, bar));
      bar.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const leaf = splitFindLeaf(splitTree, splitFocusLeafId) || splitLeaves(splitTree)[0];
        const paneId = leaf ? leaf.id : '';
        window.desktopApp.invoke('context_menu', { kind: 'pane', siteId: paneId, x: event.clientX, y: event.clientY })
          .catch((error) => log('[context-menu]', '打开分隔条菜单失败:', error.message));
      });
      bar.addEventListener('dblclick', () => { node.ratio = 0.5; splitSyncPanes(); });
      webviewContainer.appendChild(bar);
    }
    bar.classList.toggle('col', rect.direction === 'row');
    bar.classList.toggle('row', rect.direction === 'column');
    splitSetRect(bar, rect);
    bar.style.zIndex = '5';
  });
}

let splitDragFrame = null;

/* 拖动中轻量重排:只更新几何,不重建列表/不写提示/不写日志 */
function splitPaintGeometryOnly() {
  if (!splitTree) return;
  const rects = splitComputeRects(splitTree, splitContainerArea());
  splitLeaves(splitTree).forEach((leaf) => {
    const rect = rects[leaf.id];
    if (!rect) return;
    const parts = splitPaneParts(rect);
    const entry = splitPanes.get(leaf.id);
    if (entry && entry.el) splitSetRect(entry.el, parts.pane);
    const title = splitTitleElements.get(leaf.id);
    if (title) splitSetRect(title, parts.title);
  });
  const walk = (current, area) => {
    if (!current || current.type === 'leaf') return;
    const gap = SPLIT_GAP;
    const ratio = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, current.ratio));
    if (current.direction === 'row') {
      const usable = Math.max(0, area.width - gap);
      const firstWidth = Math.round(usable * ratio);
      const bar = [...webviewContainer.querySelectorAll('.split-bar')].find((el) => el.dataset.nodeId === current.__barId);
      if (bar) splitSetRect(bar, { left: area.left + firstWidth + gap / 2 - SPLIT_BAR / 2, top: area.top, width: SPLIT_BAR, height: area.height });
      walk(current.first, { ...area, width: firstWidth });
      walk(current.second, { ...area, left: area.left + firstWidth + gap, width: Math.max(0, usable - firstWidth) });
    } else {
      const usable = Math.max(0, area.height - gap);
      const firstHeight = Math.round(usable * ratio);
      const bar = [...webviewContainer.querySelectorAll('.split-bar')].find((el) => el.dataset.nodeId === current.__barId);
      if (bar) splitSetRect(bar, { left: area.left, top: area.top + firstHeight + gap / 2 - SPLIT_BAR / 2, width: area.width, height: SPLIT_BAR });
      walk(current.first, { ...area, height: firstHeight });
      walk(current.second, { ...area, top: area.top + firstHeight + gap, height: Math.max(0, usable - firstHeight) });
    }
  };
  walk(splitTree, splitContainerArea());
}

function splitScheduleGeometryPaint() {
  if (splitDragFrame !== null) return;
  const run = () => { splitDragFrame = null; splitPaintGeometryOnly(); };
  if (typeof requestAnimationFrame === 'function') splitDragFrame = requestAnimationFrame(run);
  else splitDragFrame = setTimeout(run, 16);
}

function splitStartDrag(node, direction, event, barElement) {
  const bar = barElement || null;
  const area = splitContainerArea();
  const rect = webviewContainer.getBoundingClientRect();
  const pointerId = event.pointerId;
  const ratioFrom = (clientX, clientY) => (direction === 'row'
    ? (clientX - rect.left - SPLIT_PAD - SPLIT_GAP / 2) / Math.max(1, area.width - SPLIT_GAP)
    : (clientY - rect.top - SPLIT_PAD - SPLIT_GAP / 2) / Math.max(1, area.height - SPLIT_GAP));
  // 每次 move 立即重排几何,让分隔线黏住鼠标
  const applyRatio = (clientX, clientY) => {
    const next = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratioFrom(clientX, clientY)));
    if (Math.abs(next - node.ratio) < 0.0005) return;
    node.ratio = next;
    splitPaintGeometryOnly();
  };
  const onMove = (moveEvent) => {
    if (moveEvent.cancelable) moveEvent.preventDefault();
    applyRatio(moveEvent.clientX, moveEvent.clientY);
  };

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    splitDragging = null;
    if (bar) {
      bar.classList.remove('dragging');
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', finish);
      bar.removeEventListener('pointercancel', finish);
      bar.removeEventListener('lostpointercapture', finish);
    }
    if (window && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    }
    if (splitDragFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(splitDragFrame);
      else clearTimeout(splitDragFrame);
      splitDragFrame = null;
    }
    if (bar && bar.releasePointerCapture && pointerId !== undefined) {
      try { bar.releasePointerCapture(pointerId); } catch (error) {}
    }
    splitSyncPanes(true);
  };

  splitDragging = { node, direction };
  if (bar) {
    bar.classList.add('dragging');
    if (bar.setPointerCapture && pointerId !== undefined) {
      try { bar.setPointerCapture(pointerId); } catch (error) {}
    }
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', finish);
    bar.addEventListener('pointercancel', finish);
    bar.addEventListener('lostpointercapture', finish);
  }
  if (window && typeof window.addEventListener === 'function') {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }
  if (event.cancelable) event.preventDefault();
  applyRatio(event.clientX, event.clientY);
  splitPaintGeometryOnly();
}

function syncTabActive() {
  const leaf = splitTree ? splitFindLeaf(splitTree, splitFocusLeafId) : null;
  const siteId = leaf ? leaf.siteId : currentSiteId;
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.id === siteId));
}

/* ===== 对外操作 ===== */
/* 向右(方向 row)或向下(column)细分当前叶子 */
function splitLeaf(leafId, direction, siteId, firstSiteId) {
  if (!splitRootTabId) splitRootTabId = currentSiteId || '';
  // 左右分屏必须落在根层:竖线贯穿整个高度,拖动时左右两列作为整体移动
  if (direction === 'row' && splitTree) {
    const newColumn = splitCreateLeaf(siteId || null);
    splitTree = { type: 'split', direction: 'row', ratio: 0.5, first: splitTree, second: newColumn };
    const focusLeaf = splitLeaves(splitTree).find((item) => item.siteId === currentSiteId);
    splitFocusLeafId = focusLeaf ? focusLeaf.id : splitLeaves(splitTree)[0].id;
    webviewContainer.classList.add('split');
    splitSyncPanes();
    log('[split] 新增列(整条竖线):', splitLeaves(splitTree).length, '格');
    return true;
  }
  if (!splitTree) {
    const first = splitCreateLeaf(firstSiteId || currentSiteId);
    splitTree = null;
    const second = splitCreateLeaf(siteId || null);
    const node = { type: 'split', direction, ratio: 0.5, first, second };
    splitTree = node;
    splitFocusLeafId = first.id;
  } else {
    const leaf = splitFindLeaf(splitTree, leafId) || splitLeaves(splitTree)[0];
    if (!leaf) return false;
    const replacement = {
      type: 'split',
      direction,
      ratio: 0.5,
      first: { type: 'leaf', id: leaf.id, siteId: leaf.siteId },
      second: splitCreateLeaf(siteId || null),
    };
    if (!splitReplaceLeaf(splitTree, leaf.id, replacement)) {
      if (splitTree.type === 'leaf' && splitTree.id === leaf.id) splitTree = replacement;
      else return false;
    }
  }
  // 焦点保持"当前站点所在格",避免标题条高亮与 tab 高亮指向不同面板
  const focusLeaf = splitLeaves(splitTree).find((item) => item.siteId === currentSiteId);
  splitFocusLeafId = focusLeaf ? focusLeaf.id : splitLeaves(splitTree)[0].id;
  webviewContainer.classList.add('split');
  splitSyncPanes();
  log('[split] 细分面板:', direction, '共', splitLeaves(splitTree).length, '格');
  return true;
}

/* 对当前焦点面板再分屏(分隔条按钮使用;新格留空白) */
function splitFocusedPane(direction) {
  const leaf = splitTree
    ? (splitFindLeaf(splitTree, splitFocusLeafId) || splitLeaves(splitTree)[0])
    : null;
  const targetId = leaf ? leaf.id : '';
  const firstSiteId = leaf && leaf.siteId ? leaf.siteId : currentSiteId;
  return splitLeaf(targetId, direction, null, firstSiteId);
}

function splitSiteRight(site) {
  const leaf = splitLeafOfSite(site);
  // 新格默认空白
  return splitLeaf(leaf ? leaf.id : '', 'row', null);
}

function splitSiteDown(site) {
  const leaf = splitLeafOfSite(site);
  return splitLeaf(leaf ? leaf.id : '', 'column', null);
}

/* 克隆面板:在当前面板右侧放同一站点的第二个视图 */
function splitClonePane(site) {
  if (!site) return false;
  // 先克隆站点(不切走当前视图),再在当前面板右侧开一格放这份克隆
  const clone = cloneSite(site, { select: false });
  if (!clone) return false;
  if (!webviews[clone.id]) {
    createWebview(clone);
    renderTabs();
  }
  const leaf = splitLeafOfSite(site);
  const started = splitLeaf(leaf ? leaf.id : '', 'row', clone.id, site.id);
  if (started) {
    webviewContainer.classList.add('split');
    splitFocusLeafId = splitLeaves(splitTree).slice(-1)[0].id;
    splitSyncPanes();
  }
  log('[split] 克隆面板:', site.name, '->', clone.id);
  return started;
}

function splitLeafOfSite(site) {
  if (!site) return null;
  const leaves = splitLeaves(splitTree);
  return leaves.find((leaf) => leaf.siteId === site.id) || leaves[0] || null;
}

/* 空白格里点选页面:把该站点放进这个叶子并打开 */
function splitOpenInLeaf(leafId, site) {
  const leaf = splitFindLeaf(splitTree, leafId);
  if (!leaf || !site) return;
  // 同一页面允许在多个格子重复打开:已被别的格子占用时克隆一个面板副本(共享登录态)
  const occupied = splitLeaves(splitTree).filter((item) => item.id !== leaf.id).map((item) => item.siteId);
  let target = site;
  if (occupied.includes(site.id) && typeof cloneSite === 'function') {
    const copy = cloneSite(site, { select: false });
    if (copy && copy.id) { copy.name = site.name; copy.paneOnly = true; target = copy; }
  }
  // 分屏里新开的页面只作为面板内容,不在 tab 栏出现;原本是 tab 的站点保持为 tab
  if (typeof tabOrder !== 'undefined' && !tabOrder.includes(target.id)) target.paneOnly = true;
  site = target;
  leaf.siteId = site.id;
  splitFocusLeafId = leafId;
  currentSiteId = site.id;
  if (!webviews[site.id]) {
    createWebview(site);
    renderTabs();
  }
  splitSyncPanes();
  const g = groups.find((grp) => grp.sites.some((s) => s.id === site.id));
  if (g && !expandedGroups.has(g.key)) expandGroup(g);
  applyAppBackground(site);
  log('[split] 面板打开页面:', site.name);
}

/* 点击某个面板(webview 获得焦点)时切换焦点叶子与当前站点 */
function splitFocusSite(site) {
  if (!splitTree || !site) return;
  const leaves = splitLeaves(splitTree);
  const leaf = leaves.find((item) => item.siteId === site.id);
  if (!leaf) return;
  splitFocusLeafId = leaf.id;
  splitSyncPanes();
}

/* 关闭指定面板:只从分屏移除这一格,保留 tab 与页面(不销毁视图) */
function splitClosePane(leafId) {
  if (!splitTree) return false;
  const leaf = splitFindLeaf(splitTree, leafId) || splitFindLeaf(splitTree, splitFocusLeafId);
  if (!leaf) return false;
  const entry = splitPanes.get(leaf.id);
  if (entry && entry.el && entry.el.classList && entry.el.classList.contains('split-empty')) entry.el.remove();
  splitPanes.delete(leaf.id);
  splitTree = splitRemoveLeaf(splitTree, leaf.id);
  const remaining = splitLeaves(splitTree);
  if (!splitTree || remaining.length <= 1) {
    splitExit(remaining[0] ? remaining[0].siteId : null);
    return true;
  }
  if (splitFocusLeafId === leaf.id) splitFocusLeafId = remaining[0].id;
  splitSyncPanes();
  log('[split] 关闭面板(保留 tab),剩余', remaining.length, '格');
  return true;
}

/* 关闭了某个站点:移除对应叶子并自适应上收;只剩一格时回单窗 */
function splitHandleSiteClosed(siteId) {
  if (!splitTree) return;
  // 根 tab 关闭 => 整个分屏关闭
  if (splitRootTabId && siteId === splitRootTabId) {
    log('[split] 根 tab 已关闭,整个分屏关闭:', siteId);
    const others = splitLeaves(splitTree).map((leaf) => leaf.siteId).filter((id) => id && id !== siteId);
    splitExit(null);
    others.forEach((id) => {
      const site = findSiteById(id);
      if (site && site.paneOnly && webviews[id] && typeof closeTab === 'function') closeTab(site);
    });
    return;
  }
  const leaf = splitLeaves(splitTree).find((item) => item.siteId === siteId);
  if (!leaf) return;
  const entry = splitPanes.get(leaf.id);
  if (entry && entry.el && entry.el.classList.contains('split-empty')) entry.el.remove();
  splitPanes.delete(leaf.id);
  splitTree = splitRemoveLeaf(splitTree, leaf.id);
  const remaining = splitLeaves(splitTree);
  if (!splitTree || remaining.length <= 1) {
    const last = remaining[0] || null;
    splitExit(last ? last.siteId : null);
    return;
  }
  if (splitFocusLeafId === leaf.id) splitFocusLeafId = remaining[0].id;
  splitSyncPanes();
  log('[split] 面板关闭,剩余', remaining.length, '格');
}

/* 退出分屏,回到单窗并让指定站点铺满 */
function splitExit(siteId) {
  splitTree = null;
  if (webviewContainer) webviewContainer.classList.remove('split');
  splitFocusLeafId = '';
  [...webviewContainer.querySelectorAll('.split-empty')].forEach((box) => box.remove());
  [...webviewContainer.querySelectorAll('.split-bar')].forEach((bar) => bar.remove());
  [...webviewContainer.querySelectorAll('.pane-title')].forEach((title) => title.remove());
  if (webviewContainer.style && webviewContainer.style.removeProperty) {
    webviewContainer.style.removeProperty('--pane-focus');
  }
  splitPanes.clear();
  splitTitleElements.clear();
  [...webviewContainer.querySelectorAll('.pane-title, .split-bar, .split-empty')].forEach((el) => { delete el.__rectSig; });
  splitLastSignature = '';
  splitLastLogged = '';
  Object.entries(webviews).forEach(([id, wv]) => {
    if (!wv.style) return;
    wv.style.position = '';
    wv.style.left = '';
    wv.style.top = '';
    wv.style.width = '';
    wv.style.height = '';
    delete wv.__rectSig;
    wv.classList.remove('split-focused');
  });
  document.querySelectorAll('.site-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.id === siteId));
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.id === siteId));
  if (window.nativeViewLayout) window.nativeViewLayout.schedule();
  splitPersist(true);
  log('[split] 回到单窗:', siteId || '(无)');
  // bytebase 的 SPA 对“面板尺寸突变为整窗”不健壮,回到单窗后主动重载一次
  if (siteId) {
    const site = findSiteById(siteId);
    const view = webviews[siteId];
    if (site && site.type === 'bytebase' && view && typeof view.reload === 'function') {
      try { view.reload(); log('[split] bytebase 回到单窗后重新加载:', site.name); } catch (error) {}
    }
  }
}

/* 容器尺寸变化时重算几何(原生视图跟随) */
if (typeof webviewContainer !== 'undefined' && webviewContainer) splitBindResize();

function splitBindResize() {
  if (typeof ResizeObserver === 'function' && webviewContainer) {
    new ResizeObserver(() => { if (splitTree) splitSyncPanes(); }).observe(webviewContainer);
  } else if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', () => { if (splitTree) splitSyncPanes(); });
  }
}
