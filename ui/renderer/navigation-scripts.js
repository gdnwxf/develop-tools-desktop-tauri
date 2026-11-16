function buildQuanyouFillScript(creds) {
  return `
    (function () {
      const isOtpField = ${buildQuanyouIsOtpExpr()};
      const inputs = Array.from(document.querySelectorAll('input'));
      const isVisible = (el) => el.offsetParent !== null && !el.disabled && !el.readOnly && el.type !== 'hidden';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const typeInto = (el, val) => {
        el.focus();
        setter.call(el, val);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      };
      // 提交按钮识别(评分制):原生 submit/form 内/primary 样式/提交动词短文本加分;
      // 「获取验证码」「取消」「注册」等非登录按钮强扣分,避免裸“验证”二字按 DOM 顺序误点
      const btnText = (b) => String(b.textContent || b.value || '').replace(/\s+/g, '');
      const NEG_BTN = /获取|发\s*送|重[新发]|resend|send|get\s*code|倒计时|秒后|语音|短信|邮箱|换一?张|看不清|取\s*消|cancel|返\s*回|back|忘\s*记|重置|reset|注\s*册|register|游客|免登/i;
      const POS_BTN = /登\s*录|登\s*入|验\s*证|确\s*认|确\s*定|提\s*交|sign\s*in|log\s*in|verif|confirm|submit|continue|next|继\s*续|立\s*即/i;
      const CLICKABLE = 'button, input[type="submit"], [role="button"], a[class*="btn" i], span[class*="btn" i], div[class*="btn" i], a[class*="button" i], div[class*="button" i], [class*="login-btn" i], [class*="submit" i]';
      const findSubmitBtn = (form) => {
        const all = Array.from(document.querySelectorAll(CLICKABLE)).filter(b => b.offsetParent !== null);
        let best = null; let bestScore = 0;
        const dbg = [];
        all.slice(0, 10).forEach((b) => dbg.push(btnText(b).slice(0, 10) + ':' + (b.getAttribute('type') || ((b.tagName === 'BUTTON') ? 'submit' : '') || b.type || '') + (form && form.contains(b) ? '@f' : '')));
        all.forEach((b) => {
          const tag = b.tagName.toLowerCase();
          const semantic = tag === 'button' || tag === 'input' || b.getAttribute('role') === 'button' || tag === 'a';
          const text = btnText(b);
          let type = String(b.getAttribute('type') || '').toLowerCase();
          if (!type && tag === 'button') type = 'submit'; // <button> 未写 type 默认为 submit
          const cls = String(b.className || '').toLowerCase();
          let score = 0;
          if (form && form.contains(b)) score += 20;
          if (semantic && type === 'submit') score += 30;
          if (semantic && /primary|submit|login|confirm|verify|major|main-btn|btn-main|solid|block/i.test(cls)) score += 15;
          if (POS_BTN.test(text)) score += 10;
          if (text.length >= 1 && text.length <= 4 && POS_BTN.test(text)) score += 20;
          if (NEG_BTN.test(text)) score -= 60;
          if (score > bestScore) { bestScore = score; best = b; }
        });
        return { best, bestScore, dbg, count: all.length };
      };
      const submitForm = (form) => {
        const found = findSubmitBtn(form);
        if (found.best && found.bestScore >= 25) {
          const btn = found.best;
          if (btn.disabled) { btn.disabled = false; btn.removeAttribute('disabled'); }
          btn.classList.remove('is-disabled', 'disabled');
          try { btn.scrollIntoView({ block: 'center' }); } catch (e) {}
          btn.click();
          return { via: 'btn.click', dbg: found.dbg, btnCount: found.count, hasForm: !!form };
        }
        if (form) {
          // 找不到合适按钮:requestSubmit 可触发框架 onSubmit;form.submit() 会绕过框架处理器(保底,可能无效)
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return { via: 'form.requestSubmit', dbg: found.dbg, btnCount: found.count, hasForm: true };
          }
          form.submit();
          return { via: 'form.submit', dbg: found.dbg, btnCount: found.count, hasForm: true };
        }
        return { via: 'pending', dbg: found.dbg, btnCount: found.count, hasForm: false };
      };

      const otpEl = inputs.find(i => isVisible(i) && isOtpField(i));
      const hasOtpCode = ${creds.otp ? 'true' : 'false'};

      // 两步式第二步:仅填验证码;无码(未配置/取码失败)时不提交,等下一轮
      if (${creds.mode === 'otp' ? 'true' : 'false'}) {
        if (!otpEl) return { ok: false, reason: 'no-otp', inputCount: inputs.length };
        if (!hasOtpCode) return { ok: false, reason: 'otp-unavailable' };
        typeInto(otpEl, ${JSON.stringify(creds.otp)});
        const sub = submitForm(otpEl.closest('form'));
        return { ok: sub.via !== 'pending', via: sub.via, otpOk: otpEl.value === ${JSON.stringify(creds.otp)}, btns: sub.dbg, btnCount: sub.btnCount, hasForm: sub.hasForm };
      }

      // 同页模式探测时确认有验证码框,此轮若消失(页面已跳转)不勉强提交,交状态机继续判定
      if (${creds.mode === 'all' ? 'true' : 'false'} && !otpEl) return { ok: false, reason: 'no-otp', inputCount: inputs.length };

      const passEl = inputs.find(i => i.type === 'password' && isVisible(i));
      const userEl =
        inputs.find(i => i.type !== 'password' && isVisible(i) && !isOtpField(i) && /user|账号|用户名|account|name|email|邮箱/i.test([i.name, i.id, i.placeholder, i.getAttribute('aria-label')].join(' '))) ||
        inputs.find(i => isVisible(i) && !isOtpField(i) && ['text','email',''].indexOf((i.type || '').toLowerCase()) >= 0);
      if (!userEl || !passEl) return { ok: false, reason: 'no-form', inputCount: inputs.length };
      typeInto(userEl, ${JSON.stringify(creds.user)});
      typeInto(passEl, ${JSON.stringify(creds.password)});
      let otpOk = null;
      if (otpEl) {
        // 同页验证码框:取不到码时不提交,等下一轮取码(避免无验证码空提交)
        if (!hasOtpCode) return { ok: false, reason: 'otp-unavailable' };
        typeInto(otpEl, ${JSON.stringify(creds.otp)});
        otpOk = otpEl.value === ${JSON.stringify(creds.otp)};
      }
      const sub = submitForm(userEl.closest('form'));
      return { ok: sub.via !== 'pending', via: sub.via, needOtp: !otpEl, userOk: userEl.value === ${JSON.stringify(creds.user)}, passOk: passEl.value === ${JSON.stringify(creds.password)}, otpOk, btns: sub.dbg, btnCount: sub.btnCount, hasForm: sub.hasForm };
    })();
  `;
}

/* ===== 构造填表脚本:按 type 分派,复用各原始工程 ===== */
function buildFillScript(creds) {
  if (creds.type === 'bytebase') {
    // ---- Bytebase:通用可见输入框 + InputEvent + 按钮点击(复用 superset-desktop) ----
    return `
      (function () {
        const inputs = Array.from(document.querySelectorAll('input'));
        const userEl = inputs.find(i => (i.type === 'email' || i.type === 'text' || i.type === '') && i.offsetParent !== null && !i.disabled && !i.readOnly);
        const passEl = inputs.find(i => i.type === 'password' && i.offsetParent !== null && !i.disabled);
        if (!userEl || !passEl) return { ok: false, reason: 'no-form', inputCount: inputs.length };
        const typeInto = (el, val) => {
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, val);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
        };
        typeInto(userEl, ${JSON.stringify(creds.user)});
        typeInto(passEl, ${JSON.stringify(creds.password)});
        const allBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
        const findBtn = () => allBtns.find(b => b.type === 'submit') || allBtns.find(b => /sign\\s*in|登录|log\\s*in|next|继续/i.test(b.textContent));
        let clicked = false;
        [100, 400, 800, 1500].forEach((delay) => {
          setTimeout(() => {
            if (clicked) return;
            const btn = findBtn();
            if (btn && !btn.disabled) { clicked = true; btn.click(); }
            else if (delay === 1500 && btn) { btn.disabled = false; btn.removeAttribute('disabled'); btn.click(); }
          }, delay);
        });
        return { ok: true, via: 'typed-and-pending', userOk: userEl.value === ${JSON.stringify(creds.user)}, passOk: passEl.value === ${JSON.stringify(creds.password)} };
      })();
    `;
  }
  if (creds.type === 'sprt') {
    // ---- Superset:#username/#password + form.submit() 优先(复用 superset-desktop) ----
    return `
      (function () {
        const userEl = document.querySelector('#username') || document.querySelector('input[name="username"]') || document.querySelector('input[type="text"]');
        const passEl = document.querySelector('#password') || document.querySelector('input[name="password"]') || document.querySelector('input[type="password"]');
        if (!userEl || !passEl) return { ok: false, reason: 'no-form' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const setVal = (el, val) => { setter.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        setVal(userEl, ${JSON.stringify(creds.user)});
        setVal(passEl, ${JSON.stringify(creds.password)});
        const form = userEl.closest('form');
        if (form) { form.submit(); return { ok: true, via: 'form.submit' }; }
        const btn = document.querySelector('input[type="submit"], button[type="submit"]');
        if (btn) { btn.click(); return { ok: true, via: 'btn.click' }; }
        return { ok: false, reason: 'no-submit' };
      })();
    `;
  }
  if (creds.type === 'redisinsight') {
    // ---- RedisInsight:通用可见输入框 + InputEvent + 按钮点击 + form.submit 兜底(复用 redisinsight-desktop) ----
    return `
      (function () {
        const inputs = Array.from(document.querySelectorAll('input'));
        const isVisible = (el) => el.offsetParent !== null && !el.disabled && !el.readOnly;
        const isUserField = (i) => {
          const t = (i.type || '').toLowerCase();
          return ['text','email',''].includes(t) && isVisible(i);
        };
        const userEl = inputs.find(isUserField);
        const passEl = inputs.find(i => i.type === 'password' && i.offsetParent !== null && !i.disabled);
        if (!userEl || !passEl) return { ok: false, reason: 'no-form', inputCount: inputs.length };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const typeInto = (el, val) => {
          el.focus();
          setter.call(el, val);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
        };
        typeInto(userEl, ${JSON.stringify(creds.user)});
        typeInto(passEl, ${JSON.stringify(creds.password)});
        const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(b => b.offsetParent !== null);
        const findBtn = () =>
          allBtns.find(b => b.type === 'submit') ||
          allBtns.find(b => /sign\\s*in|登录|log\\s*in|next|继续|submit|确认/i.test(b.textContent || b.value || ''));
        let clicked = false;
        [100, 400, 800, 1500].forEach((delay) => {
          setTimeout(() => {
            if (clicked) return;
            const btn = findBtn();
            if (btn && !btn.disabled) { clicked = true; btn.click(); }
            else if (delay === 1500 && btn) { btn.disabled = false; btn.removeAttribute('disabled'); btn.click(); }
          }, delay);
        });
        const form = userEl.closest('form');
        if (form) { try { form.submit(); } catch (e) {} }
        return { ok: true, via: clicked ? 'btn.click' : (form ? 'form.submit' : 'pending'), userOk: userEl.value === ${JSON.stringify(creds.user)}, passOk: passEl.value === ${JSON.stringify(creds.password)} };
      })();
    `;
  }
  if (creds.type === 'yapi') {
    // ---- YApi:antd Form,user 优先填 email 框 + 密码框 + "登录"按钮 click(React+antd) ----
    return `
      (function () {
        const inputs = Array.from(document.querySelectorAll('input'));
        const isVisible = (el) => el.offsetParent !== null && !el.disabled && !el.readOnly;
        // user 优先级:type=email > placeholder/name 含 email/邮箱 > 含 用户名/username > 通用可见 text
        const userEl =
          inputs.find(i => i.type === 'email' && isVisible(i)) ||
          inputs.find(i => isVisible(i) && /email|邮箱/i.test(i.placeholder || i.name || '')) ||
          inputs.find(i => isVisible(i) && /用户名|username/i.test(i.placeholder || i.name || '')) ||
          inputs.find(i => isVisible(i) && ['text',''].includes((i.type || '').toLowerCase()));
        const passEl = inputs.find(i => i.type === 'password' && isVisible(i));
        if (!userEl || !passEl) return { ok: false, reason: 'no-form', inputCount: inputs.length };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const typeInto = (el, val) => {
          el.focus();
          setter.call(el, val);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
        };
        typeInto(userEl, ${JSON.stringify(creds.user)});
        typeInto(passEl, ${JSON.stringify(creds.password)});
        const allBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
        const findBtn = () =>
          allBtns.find(b => b.type === 'submit') ||
          allBtns.find(b => /^登录$|^log\\s*in$|^sign\\s*in$/i.test((b.textContent || '').trim()));
        const form = userEl.closest('form');
        let submitted = false;
        let via = 'pending';
        const trySubmit = () => {
          if (submitted) return false;
          const btn = findBtn();
          if (btn) {
            if (btn.disabled) { btn.disabled = false; btn.removeAttribute('disabled'); }
            submitted = true; via = 'btn.click'; btn.click(); return true;
          }
          if (form && typeof form.requestSubmit === 'function') {
            submitted = true; via = 'form.requestSubmit'; form.requestSubmit(); return true;
          }
          return false;
        };
        [200, 600, 1200, 2000, 3000].forEach((delay) => { setTimeout(() => { trySubmit(); }, delay); });
        return { ok: true, via, userOk: userEl.value === ${JSON.stringify(creds.user)}, passOk: passEl.value === ${JSON.stringify(creds.password)} };
      })();
    `;
  }
  // ---- Grafana:通用可见输入框 + InputEvent + 按钮点击 + requestSubmit(禁 form.submit)(复用 grafana-desktop) ----
  return `
    (function () {
      const inputs = Array.from(document.querySelectorAll('input'));
      const isVisible = (el) => el.offsetParent !== null && !el.disabled && !el.readOnly;
      const isUserField = (i) => {
        const t = (i.type || '').toLowerCase();
        return ['text','email',''].includes(t) && isVisible(i);
      };
      const userEl = inputs.find(isUserField);
      const passEl = inputs.find(i => i.type === 'password' && i.offsetParent !== null && !i.disabled);
      if (!userEl || !passEl) return { ok: false, reason: 'no-form', inputCount: inputs.length };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const typeInto = (el, val) => {
        el.focus();
        setter.call(el, val);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      };
      typeInto(userEl, ${JSON.stringify(creds.user)});
      typeInto(passEl, ${JSON.stringify(creds.password)});
      const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(b => b.offsetParent !== null);
      const findBtn = () =>
        allBtns.find(b => b.type === 'submit') ||
        allBtns.find(b => /sign\\s*in|登录|log\\s*in|next|继续|submit|确认/i.test(b.textContent || b.value || ''));
      const form = userEl.closest('form');
      let submitted = false;
      let via = 'pending';
      const trySubmit = () => {
        if (submitted) return false;
        const btn = findBtn();
        if (btn) {
          if (btn.disabled) { btn.disabled = false; btn.removeAttribute('disabled'); }
          submitted = true; via = 'btn.click'; btn.click(); return true;
        }
        if (form && typeof form.requestSubmit === 'function') {
          submitted = true; via = 'form.requestSubmit'; form.requestSubmit(); return true;
        }
        return false;
      };
      [200, 600, 1200, 2000, 3000].forEach((delay) => {
        setTimeout(() => { trySubmit(); }, delay);
      });
      return { ok: true, via, userOk: userEl.value === ${JSON.stringify(creds.user)}, passOk: passEl.value === ${JSON.stringify(creds.password)} };
    })();
  `;
}

/* ===== 构造探测脚本:判断页面状态(bytebase 一次性探测 + redisinsight/grafana 连续探测共用) ===== */
function buildProbeScript() {
  return `
    (function () {
      const inputs = Array.from(document.querySelectorAll('input'));
      const hasPwd = inputs.some(i => i.type === 'password' && i.offsetParent !== null);
      if (hasPwd) return { state: 'login' };
      const bodyText = document.body ? document.body.innerText : '';
      const visibleEls = document.querySelectorAll('div, nav, main, section, aside').length;
      if (bodyText.length > 100 && visibleEls > 10) return { state: 'logged-in' };
      return { state: 'loading' };
    })();
  `;
}

/* ===== 解析 first_open_url:支持绝对 URL 或相对 site.url 的路径 ===== */
function resolveFirstUrl(site) {
  const f = (site.first_open_url || '').trim();
  if (!f) return '';
  if (/^https?:\/\//i.test(f)) return f;
  try { return new URL(f, site.url).href; } catch { return f; }
}
