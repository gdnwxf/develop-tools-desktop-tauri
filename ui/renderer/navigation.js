// navigation.js -- 导航分派、自动登录策略(superset/redisinsight/grafana/yapi/bytebase/quanyou-admin)、探测状态机与填表脚本

/* ===== 导航处理:按策略分派 =====
 * superset:URL 正则判登录页(原始 superset-desktop 逻辑)
 * yapi:DOM 探测状态机(YApi 专属探测脚本,判定 /login 路由与 antd 骨架)
 * quanyou-admin:独立两阶段探测(账密 + Google TOTP 验证码,同页/两步自适应)
 * redisinsight/grafana:DOM 探测状态机(仅在探测未运行时启动)
 */
function handleNavigation(wv, site, url) {
  const strat = getStrategy(site.type);
  if (strat === 'web') return;
  if (strat === 'superset') handleNavigationSuperset(wv, site, url);
  else if (strat === 'yapi') handleNavigationYapi(wv, site);
  else if (strat === 'quanyou') handleNavigationQuanyou(wv, site);
  else handleNavigationProbe(wv, site);
}

/* ===== superset 策略:URL 正则判登录页(复用 superset-desktop) ===== */
function handleNavigationSuperset(wv, site, url) {
  const profile = getProfile(site.type);
  if (!profile.isLoginPage(url)) {
    // 非登录页 -> 已登录(cookie 持久化生效)
    loginAttempted.delete(site.id);
    markSiteStatus(site.id, 'ok');
    return;
  }
  // 登录页
  if (loginAttempted.has(site.id)) {
    // 已尝试过登录,仍在登录页 -> 登录失败(密码错误等)
    markSiteStatus(site.id, 'skip');
    notifyLoginFailed(site);
    return;
  }
  if (!site.user || !site.password) {
    markSiteStatus(site.id, 'skip');
    log('[auto-login]', site.name, '未配置账号密码,跳过');
    return;
  }
  // 首次到达登录页 -> 启动自动登录
  loginAttempted.add(site.id);
  markSiteStatus(site.id, 'current');
  log('[auto-login]', site.name, '检测到登录页,开始自动填表');
  // Superset:服务端渲染,表单已就绪,直接填表(bytebase 已改走 probe 策略,不在此处理)
  startAutoFill(wv, site);
}

/* ===== redisinsight/grafana 策略:DOM 探测状态机 ===== */
function handleNavigationProbe(wv, site) {
  if (!probeTimers[site.id]) startProbe(wv, site);
}

/* ===== YApi 策略:React+antd SPA 探测状态机 =====
 * YApi 登录路由固定 /login,登录成功跳 /group 等前端路由(did-navigate-in-page);
 * 复用 startProbe 轮询框架与 handleProbeResult 状态机,仅探测脚本独立:
 *   - /login 路径或可见密码框 -> login
 *   - antd 应用骨架(.ant-layout/.ant-menu)且有内容 -> logged-in
 *   - 否则 -> loading
 */
function handleNavigationYapi(wv, site) {
  if (!probeTimers[site.id]) startProbe(wv, site, buildYapiProbeScript);
}

/* YApi 专属探测脚本:基于路由与 antd 骨架判定页面状态 */
function buildYapiProbeScript() {
  return `
    (function () {
      const path = location.pathname || '';
      const inputs = Array.from(document.querySelectorAll('input'));
      const hasPwd = inputs.some(i => i.type === 'password' && i.offsetParent !== null);
      // 登录页:YApi 登录路由 /login,或有可见密码框
      const isLoginPath = path === '/login' || path.indexOf('/login/') === 0 || path.indexOf('/login?') === 0 || path.indexOf('/login#') === 0;
      if (isLoginPath || hasPwd) return { state: 'login' };
      // 已登录:有 antd 应用骨架且页面有内容
      const hasLayout = !!(document.querySelector('.ant-layout, .ant-menu, .ant-dropdown') || document.querySelector('nav'));
      const bodyText = document.body ? document.body.innerText : '';
      if (hasLayout && bodyText.length > 50) return { state: 'logged-in' };
      if (bodyText.length > 100 && document.querySelectorAll('div, nav, main').length > 10) return { state: 'logged-in' };
      return { state: 'loading' };
    })();
  `;
}

/* ===== quanyou-admin 策略:账密 + Google TOTP 验证码(同页/两步自适应) =====
 * 登录页两种形态都支持:
 *   同页式——用户名/密码/验证码同屏,一次填三项后提交;
 *   两步式——先填账密提交,第二页仅验证码框,探测到后实时取码填入再次提交。
 * 复用 probeTimers/fillTimers/probeState 槽位与 500ms 轮询、30s 总超时框架(关闭 tab/
 * 加载失败的既有清理逻辑自动生效),状态机独立,不影响 grafana/yapi 等既有类型;
 * 验证码每轮填表实时经 IPC 向主进程取,跟随 30s 窗口换码,不缓存。
 */
function handleNavigationQuanyou(wv, site) {
  if (!probeTimers[site.id]) startQuanyouProbe(wv, site);
}

/* quanyou 页面验证码框通用识别:maxlength 4~8 / autocomplete=one-time-code / inputmode=numeric /
 * name·id·placeholder·aria-label 含验证码、谷歌、google、otp 等关键词 */
function buildQuanyouIsOtpExpr() {
  return `
    (i) => {
      if (i.type === 'password') return false;
      const t = (i.type || 'text').toLowerCase();
      if (['text','tel','number',''].indexOf(t) < 0) return false;
      const ml = i.getAttribute('maxlength');
      if (ml && +ml >= 4 && +ml <= 8) return true;
      const ac = (i.getAttribute('autocomplete') || '').toLowerCase();
      if (ac.indexOf('one-time-code') >= 0 || ac === 'otp') return true;
      if ((i.getAttribute('inputmode') || '').toLowerCase().indexOf('numeric') >= 0) return true;
      const hay = [i.name, i.id, i.placeholder, i.getAttribute('aria-label')].join(' ');
      if (/验证码|谷歌|动态码|google|otp|totp|authenticator|\\bcode\\b/i.test(hay)) return true;
      return false;
    }
  `;
}

/* quanyou 探测脚本:返回 login(有可见密码框,hasOtp 标识同页是否已有验证码框)/
 * otp(无密码框且有验证码框,两步式第二页)/ logged-in / loading */
function buildQuanyouProbeScript() {
  return `
    (function () {
      const isOtpField = ${buildQuanyouIsOtpExpr()};
      const inputs = Array.from(document.querySelectorAll('input'));
      const visible = inputs.filter(i => i.offsetParent !== null && !i.disabled && !i.readOnly && i.type !== 'hidden');
      const pwd = visible.find(i => i.type === 'password');
      const otp = visible.find(isOtpField);
      if (otp && !pwd) return { state: 'otp' };
      if (pwd) return { state: 'login', hasOtp: !!otp };
      const bodyText = document.body ? document.body.innerText : '';
      if (bodyText.length > 100 && document.querySelectorAll('div, nav, main, section, aside').length > 10) return { state: 'logged-in' };
      return { state: 'loading' };
    })();
  `;
}

function startQuanyouProbe(wv, site) {
  let count = 0;
  probeState[site.id] = { phase: 'probing', fillAt: 0, otpFilled: false };

  const timer = setInterval(() => {
    count++;
    if (count > 60) { // 30s 总超时:静默标记 skip(加载失败由 did-fail-load 弹 toast,同通用探测)
      stopProbe(site.id);
      stopFill(site.id);
      log('[probe]', site.name, '探测超时,页面长时间无响应,标记 skip');
      markSiteStatus(site.id, 'skip');
      return;
    }
    wv.executeJavaScript(buildQuanyouProbeScript())
      .then((res) => { if (res) handleQuanyouProbeResult(wv, site, res, count); })
      .catch(() => {});
  }, 500);
  probeTimers[site.id] = timer;
}

/* quanyou 状态机:
 * - login 首次:校验账密(同页有验证码框还需 optsecret),按形态发起 'all'/'login' 填表,转 verifying-login
 * - otp 页(两步式第二步):未取过码则取码填提交,转 verifying-otp;同页提交后异常跳到独立验证码页也补一次
 * - 各 verifying 阶段 8s 后仍停留 -> 失败 toast(验证码错误/过期单独文案)
 * - logged-in:收尾标记 ok
 */
function handleQuanyouProbeResult(wv, site, res, count) {
  const st = probeState[site.id] || { phase: 'probing' };

  if (res.state === 'logged-in') {
    log('[probe]', site.name, '-> logged-in #' + count);
    stopProbe(site.id);
    loginAttempted.delete(site.id);
    markSiteStatus(site.id, 'ok');
    return;
  }

  if (res.state === 'login') {
    if (!loginAttempted.has(site.id)) {
      if (!site.user || !site.password) {
        stopProbe(site.id);
        markSiteStatus(site.id, 'skip');
        log('[auto-login]', site.name, '未配置账号密码,跳过');
        return;
      }
      // 同页已带验证码框却无 optsecret:无法完成登录,不提交半截表单
      if (res.hasOtp && !site.optsecret) {
        stopProbe(site.id);
        markSiteStatus(site.id, 'skip');
        log('[auto-login]', site.name, '登录页需谷歌验证码但未配置 optsecret,跳过');
        return;
      }
      loginAttempted.add(site.id);
      st.phase = 'verifying-login';
      st.otpFilled = !!res.hasOtp; // 同页式:验证码随账密一次提交
      st.fillAt = Date.now();
      markSiteStatus(site.id, 'current');
      log('[auto-login]', site.name, '检测到登录页,开始自动填表' + (res.hasOtp ? '(账密+谷歌验证码同页)' : '(仅账密)'));
      startQuanyouFill(wv, site, res.hasOtp ? 'all' : 'login');
    } else if (Date.now() - st.fillAt > 8000) {
      // 账密提交后停留,或验证码提交后被踢回登录页,8s 仍见密码框 -> 失败
      stopProbe(site.id);
      stopFill(site.id);
      markSiteStatus(site.id, 'skip');
      log('[auto-login]', site.name, '填表后仍停留在登录页,判定失败');
      notifyLoginFailed(site, { msg: '账号、密码或谷歌验证码错误,请检查配置文件' });
    }
    return;
  }

  if (res.state === 'otp') {
    if (!loginAttempted.has(site.id)) return; // 未提交账密却出现验证码页(异常态),继续轮询不动作
    if (!st.otpFilled || st.phase === 'verifying-login') {
      if (!site.optsecret) {
        stopProbe(site.id);
        markSiteStatus(site.id, 'skip');
        log('[auto-login]', site.name, '第二步需谷歌验证码但未配置 optsecret,跳过');
        return;
      }
      st.otpFilled = true;
      st.phase = 'verifying-otp';
      st.fillAt = Date.now();
      log('[auto-login]', site.name, '进入谷歌验证码页,实时取码填表');
      startQuanyouFill(wv, site, 'otp');
    } else if (st.phase === 'verifying-otp' && Date.now() - st.fillAt > 8000) {
      stopProbe(site.id);
      stopFill(site.id);
      markSiteStatus(site.id, 'skip');
      log('[auto-login]', site.name, '验证码提交后仍停留在验证码页,判定失败');
      notifyLoginFailed(site, { msg: '谷歌验证码错误或已过期,请检查配置文件中的 optsecret' });
    }
  }
}

/* ===== quanyou 填表重试:250ms 一轮共 4s,每轮实时取 TOTP(跟随 30s 窗口换码) =====
 * mode:'login' 仅账密(两步式第一步);'all' 账密+同页验证码;'otp' 仅验证码(第二步)
 */
function startQuanyouFill(wv, site, mode) {
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    if (tries > 16) {
      clearInterval(timer);
      delete fillTimers[site.id];
      log('[auto-login]', site.name, '填表超时');
      return;
    }
    let otp = '';
    if (site.optsecret) {
      try {
        const r = await window.desktopApp.generateOtp(site.optsecret);
        if (r && r.ok) otp = r.code;
      } catch (e) { /* 取码失败当轮不提交,下轮重试 */ }
    }
    const creds = { user: site.user || '', password: site.password || '', otp, mode };
    try {
      const res = await wv.executeJavaScript(buildQuanyouFillScript(creds));
      // 只记录结果/途径与页面按钮清单(文本无敏感信息),不回显验证码;按钮识别异常时据此精调选择器
      log('[auto-login]', site.name, 'fill #' + tries, res && { ok: res.ok, via: res.via, reason: res.reason, needOtp: res.needOtp, hasForm: res.hasForm, btnCount: res.btnCount, btns: res.btns });
      if (res && res.ok) {
        clearInterval(timer);
        delete fillTimers[site.id]; // 表单已提交,后续由探测状态机判定结果
      }
    } catch (e) { /* 页面跳转瞬间脚本执行失败可忽略,下轮重试 */ }
  }, 250);
  fillTimers[site.id] = timer;
}

/* ===== quanyou 填表脚本:账密 + 可选验证码,自适应同页/两步两种页面 ===== */
/* ===== Bytebase SPA 探测:等待页面渲染完成(复用 superset-desktop) ===== */
function startBytebaseProbe(wv, site) {
  let count = 0;
  const timer = setInterval(() => {
    count++;
    if (count > 30) { // 15s 超时
      clearInterval(timer);
      delete bytebaseTimers[site.id];
      log('[probe]', site.name, '探测超时,判定已登录');
      loginAttempted.delete(site.id);
      markSiteStatus(site.id, 'ok');
      return;
    }
    wv.executeJavaScript(buildProbeScript())
      .then((res) => {
        log('[probe]', site.name, '#' + count, res);
        if (res.state === 'login') {
          clearInterval(timer);
          delete bytebaseTimers[site.id];
          startAutoFill(wv, site);
        } else if (res.state === 'logged-in') {
          clearInterval(timer);
          delete bytebaseTimers[site.id];
          loginAttempted.delete(site.id);
          markSiteStatus(site.id, 'ok');
        }
      }).catch(() => {});
  }, 500);
  bytebaseTimers[site.id] = timer;
}

/* ===== 连续 DOM 探测状态机(redisinsight/grafana/yapi,复用 grafana-desktop) =====
 * buildScript 可选:传入专属探测脚本(yapi),缺省用通用 buildProbeScript(redisinsight/grafana)
 * - probing: 轮询页面状态
 *   - login -> 配置了账号密码则填表并转 verifying,否则 skip
 *   - logged-in -> ok(并按需跳 first_open_url)
 *   - loading -> 继续轮询
 * - verifying: 已填表,等待跳转
 *   - logged-in -> ok
 *   - 8s 后仍 login -> skip(密码错误等)
 */
function startProbe(wv, site, buildScript) {
  const probe = buildScript || buildProbeScript;
  let count = 0;
  probeState[site.id] = { phase: 'probing', fillAt: 0 };

  const timer = setInterval(() => {
    count++;
    if (count > 60) { // 30s 总超时:静默标记 skip(加载失败由 did-fail-load 弹 toast,超时多为站点慢,避免切换时弹 toast 干扰)
      stopProbe(site.id);
      stopFill(site.id);
      log('[probe]', site.name, '探测超时,页面长时间无响应,标记 skip');
      markSiteStatus(site.id, 'skip');
      return;
    }
    wv.executeJavaScript(probe())
      .then((res) => { if (res) handleProbeResult(wv, site, res, count); })
      .catch(() => {});
  }, 500);
  probeTimers[site.id] = timer;
}

function handleProbeResult(wv, site, res, count) {
  const st = probeState[site.id] || { phase: 'probing' };

  // 已登录:任何阶段都立即收尾
  if (res.state === 'logged-in') {
    logProbe(site, res, count);
    stopProbe(site.id);
    loginAttempted.delete(site.id);
    markSiteStatus(site.id, 'ok');
    // 登录成功且配置了 first_open_url:跳转到对应页面(仅 grafana 站点会配置)
    if (firstOpenPending.has(site.id)) {
      firstOpenPending.delete(site.id);
      firstOpenDone.add(site.id);
      const target = resolveFirstUrl(site);
      if (target) {
        log('[first-open]', site.name, '登录成功,跳转 first_open_url:', target);
        wv.loadURL(target).catch((error) => log('[first-open]', site.name, error.message));
      }
    }
    return;
  }

  // 登录页
  if (res.state === 'login') {
    logProbe(site, res, count);
    if (!site.user || !site.password) {
      stopProbe(site.id);
      markSiteStatus(site.id, 'skip');
      log('[auto-login]', site.name, '未配置账号密码,跳过');
      return;
    }
    if (!loginAttempted.has(site.id)) {
      loginAttempted.add(site.id);
      st.phase = 'verifying';
      st.fillAt = Date.now();
      markSiteStatus(site.id, 'current');
      // 标记待跳转 first_open_url(仅本会话首次,防重复)
      if (site.first_open_url && !firstOpenDone.has(site.id)) firstOpenPending.add(site.id);
      log('[auto-login]', site.name, '检测到登录页,开始自动填表');
      startAutoFill(wv, site);
    } else if (st.phase === 'verifying' && Date.now() - st.fillAt > 8000) {
      // 填表后 8s 仍停留在登录页 -> 失败(密码错误等)
      stopProbe(site.id);
      markSiteStatus(site.id, 'skip');
      log('[auto-login]', site.name, '填表后仍停留在登录页,判定失败');
      notifyLoginFailed(site);
    }
    return;
  }

  // loading:继续轮询
  logProbe(site, res, count);
}

function logProbe(site, res, count) {
  const changed = lastProbeState[site.id] !== res.state;
  if (changed) {
    lastProbeState[site.id] = res.state;
    log('[probe]', site.name, '->', res.state, res.title ? '(' + res.title + ')' : '');
  }
  if (site.id === currentSiteId) {
    log('[probe]', site.name, '#' + count, res);
  }
}

function stopProbe(siteId) {
  if (probeTimers[siteId]) {
    clearInterval(probeTimers[siteId]);
    delete probeTimers[siteId];
  }
}
function stopBytebaseProbe(siteId) {
  if (bytebaseTimers[siteId]) {
    clearInterval(bytebaseTimers[siteId]);
    delete bytebaseTimers[siteId];
  }
}
function stopFill(siteId) {
  if (fillTimers[siteId]) {
    clearInterval(fillTimers[siteId]);
    delete fillTimers[siteId];
  }
}

/* ===== 自动填表:重试到成功或超时 =====
 * superset:40 次(10s),超时标记 skip;redisinsight/grafana:16 次(4s),状态由探测管理
 */
function startAutoFill(wv, site) {
  const strat = getStrategy(site.type);
  const maxTries = strat === 'superset' ? 40 : 16;
  let tries = 0;
  const creds = { user: site.user, password: site.password, type: site.type };

  const timer = setInterval(() => {
    tries++;
    if (tries > maxTries) {
      clearInterval(timer);
      delete fillTimers[site.id];
      if (strat === 'superset') {
        log('[auto-login]', site.name, '填表超时');
        markSiteStatus(site.id, 'skip');
      }
      return;
    }
    wv.executeJavaScript(buildFillScript(creds))
      .then((res) => {
        log('[auto-login]', site.name, 'fill #' + tries, res);
        if (res && res.ok) {
          clearInterval(timer);
          delete fillTimers[site.id];
          // 表单已提交,等待 did-navigate / 探测状态机判断结果
        }
      }).catch(() => {});
  }, 250);
  fillTimers[site.id] = timer;
}