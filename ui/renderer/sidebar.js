// sidebar.js -- 站点类型配置与左侧分组列表渲染/展开收起

/* ===== 各类型站点配置(复用各原始工程) =====
 * isLoginPage:suptools 类型用 URL 正则;redisinsight/etcd/grafana/yapi 由 DOM 探测决定(返回 true)
 * getStrategy:spr/bytebase->superset 策略;redisinsight->redisinsight;yapi->yapi;其余->grafana
 * bg:tab 头背景(与图标方块同色系的淡色渐变);accent:主题色(active 边框/文字)
 */
const LOGIN_PROFILES = {
  web: { icon: '🌐', bg: 'linear-gradient(135deg, #e0f2fe, #bae6fd)', accent: '#0284c7', isLoginPage: () => false },
  sprt: { icon: '🟫', bg: 'linear-gradient(135deg, #f2e4d8, #e6cdbc)', accent: '#925a38', isLoginPage: (url) => /\/login\/?(?:$|\?)/.test(url) },
  // bytebase 图标用黑方块(⬛️:带 VS16 强制 emoji 渲染,与七彩方块同款圆角风格;
  // 缺 VS16 会走文本渲染显示为直角小方块;黑色与七彩互不重复)
  bytebase: { icon: '⬛️', bg: 'linear-gradient(135deg, #ececec, #dcdcdc)', accent: '#4b5563', isLoginPage: (url) => /\/auth(?:\/?(?:$|\?))/.test(url) || /\/auth$/.test(url) },
  redisinsight: { icon: '🟥', bg: 'linear-gradient(135deg, #fee2e2, #fecaca)', accent: '#dc2626', isLoginPage: () => true },
  etcd: { icon: '🟩', bg: 'linear-gradient(135deg, #dcfce7, #bbf7d0)', accent: '#16a34a', isLoginPage: () => true },
  ckv: { icon: '🟦', bg: 'linear-gradient(135deg, #dbeafe, #bfdbfe)', accent: '#2563eb', isLoginPage: () => true },
  rancher: { icon: '🟪', bg: 'linear-gradient(135deg, #f3e8ff, #e9d5ff)', accent: '#9333ea', isLoginPage: () => true },
  grafana: { icon: '🟧', bg: 'linear-gradient(135deg, #ffedd5, #fed7aa)', accent: '#ea580c', isLoginPage: () => true },
  yapi:    { icon: '🟨', bg: 'linear-gradient(135deg, #fef9c3, #fef08a)', accent: '#ca8a04', isLoginPage: () => true },
  // quanyou-admin:teal 纯色 CSS 方块(七色 emoji 方块已用尽,与主进程 groupProfile 同款)
  'quanyou-admin': { icon: '<span style="display:inline-block;width:1em;height:1em;border-radius:18%;background:#0d9488;vertical-align:-0.15em;margin-left:2px"></span>', bg: 'linear-gradient(135deg, #ccfbf1, #99f6e4)', accent: '#0d9488', isLoginPage: () => true },
  // jenkins:Jenkins 品牌红 CSS 方块(与主进程 groupProfile 同款);bg 用 rose 系淡色渐变,与 redisinsight 的红(#fee2e2/#fecaca)区分;
  // 服务端渲染表单(j_username/j_password + j_security_check),与 superset 同类,isLoginPage 按 /login 路径判定(含 ?from= 参数)
  jenkins: { icon: '<span style="display:inline-block;width:1em;height:1em;border-radius:18%;background:#d33833;vertical-align:-0.15em;margin-left:2px"></span>', bg: 'linear-gradient(135deg, #ffe4e6, #fecdd3)', accent: '#d33833', isLoginPage: (url) => /\/login(?:[/?#]|$)/.test(url) },
};
function getProfile(type) {
  return LOGIN_PROFILES[type] || LOGIN_PROFILES.grafana;
}
function getStrategy(type) {
  if (type === 'web') return 'web';
  if (type === 'sprt') return 'superset';
  // jenkins 走 superset 策略:同为服务端渲染表单,URL 正则判登录页,填表复用通用分支(可见 text/password + submit 按钮)
  if (type === 'jenkins') return 'superset';
  // bytebase 走 DOM 探测状态机(同 grafana/redisinsight):填表后 8s 仍登录页才判失败,避免 SPA 跳转期间 URL 暂停 /auth 误报
  if (type === 'bytebase') return 'probe';
  if (type === 'redisinsight') return 'redisinsight';
  // yapi 走独立 DOM 探测(antd 表单,user 优先填 email 框)
  if (type === 'yapi') return 'yapi';
  // quanyou-admin 走独立两阶段探测:账密 + Google TOTP 验证码(同页/两步自适应)
  if (type === 'quanyou-admin') return 'quanyou';
  return 'grafana';
}

/* ===== 渲染左侧分组列表 ===== */
function renderSidebar() {
  siteList.innerHTML = '';
  groups.forEach((g) => {
    const grp = document.createElement('li');
    grp.className = 'group' + (expandedGroups.has(g.key) ? ' expanded' : '');
    grp.dataset.key = g.key;

    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML =
      '<span class="group-arrow">' + (expandedGroups.has(g.key) ? '▾' : '▸') + '</span>' +
      '<span class="group-icon">' + g.icon + '</span>' +
      '<span class="group-label"></span>' +
      '<span class="group-count">' + g.sites.length + '</span>';
    head.querySelector('.group-label').textContent = g.label;
    head.addEventListener('click', () => toggleGroup(g));
    grp.appendChild(head);

    const ul = document.createElement('ul');
    ul.className = 'group-sites';
    g.sites.forEach((site) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'site-btn';
      btn.dataset.id = site.id;
      btn.innerHTML =
        '<span class="site-icon">' + g.icon + '</span>' +
        '<span class="site-name"></span>';
      btn.querySelector('.site-name').textContent = site.name;
      // hover 提示完整菜单名称(名称过长被截断时可见)
      btn.title = site.name;
      // 只提供分组色值(--site-accent 由 CSS 在 hover/active 时取用);普通项不写 inline 背景:
      // 切换站点只切 active class 不重绘侧栏,inline 底色会压住 .site-btn.active / :hover 的分组色
      const prof = getProfile(site.type);
      const groupColor = g.color || prof.accent;
      btn.style.setProperty('--site-accent', groupColor);
      btn.addEventListener('click', () => selectSite(site));
      // 右键站点:弹菜单提供复制链接(已打开则复制当前访问地址,否则复制配置中的 url)
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showSiteContextMenu(e.clientX, e.clientY, site);
      });
      li.appendChild(btn);
      ul.appendChild(li);
    });
    grp.appendChild(ul);
    siteList.appendChild(grp);
  });
}

/* ===== 展开/收起分组 =====
 * 展开:为该分组下所有站点创建 webview 并并行登录
 * 收起:销毁该分组下所有 webview(停止登录/探测)
 * 支持多个分组同时展开;展开状态与最后打开 tab 持久化,下次启动恢复
 */
function toggleGroup(g) {
  if (expandedGroups.has(g.key)) {
    collapseGroup(g);
  } else {
    expandGroup(g);
    // 仅展开侧栏显示站点列表,不自动打开 tab(点击站点才打开)
  }
}

/* 分组收起的内部实现:更新展开集合/DOM/销毁 webview,不触发重绘/重选/持久化(供批量操作用) */
function collapseGroupInternal(g) {
  if (!expandedGroups.has(g.key)) return;
  expandedGroups.delete(g.key);
  const grp = document.querySelector('.group[data-key="' + g.key + '"]');
  if (grp) {
    grp.classList.remove('expanded');
    const arrow = grp.querySelector('.group-arrow');
    if (arrow) arrow.textContent = '▸';
  }
  // 仅收起侧栏,不销毁已打开的 webview/tab(重新展开或点击 tab 仍可用)
}

function expandGroup(g) {
  if (expandedGroups.has(g.key)) return;
  expandedGroups.add(g.key);
  const grp = document.querySelector('.group[data-key="' + g.key + '"]');
  if (grp) {
    grp.classList.add('expanded');
    const arrow = grp.querySelector('.group-arrow');
    if (arrow) arrow.textContent = '▾';
  }
  renderTabs();
  saveExpanded();
  log('[group] 展开', g.label, '-> 显示', g.sites.length, '个站点(点击站点才打开)');
}

function collapseGroup(g) {
  if (!expandedGroups.has(g.key)) return;
  collapseGroupInternal(g);
  // 仅收起侧栏,不关闭 tab/不切换当前站点(webview 保留,内容区保持显示)
  saveExpanded();
  log('[group] 收起', g.label);
}

/* ===== 全部展开/全部折叠 ===== */
function expandAllGroups() {
  groups.forEach((g) => {
    if (expandedGroups.has(g.key)) return;
    expandedGroups.add(g.key);
    const grp = document.querySelector('.group[data-key="' + g.key + '"]');
    if (grp) {
      grp.classList.add('expanded');
      const arrow = grp.querySelector('.group-arrow');
      if (arrow) arrow.textContent = '▾';
    }
  });
  renderTabs();
  saveExpanded();
  // 仅展开侧栏,不自动打开 tab;当前 tab 保持不变
  log('[group] 全部展开(仅侧栏)');
}

function collapseAllGroups() {
  groups.forEach((g) => { if (expandedGroups.has(g.key)) collapseGroupInternal(g); });
  // 仅收起侧栏,不关闭 tab/不改变当前站点
  saveExpanded();
  log('[group] 全部折叠');
}
