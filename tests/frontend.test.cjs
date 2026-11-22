const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const source = (name) => fs.readFileSync(path.join(__dirname, '../ui/renderer', name), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function bridge(invoke, clipboard) {
  const context = {
    window: { __TAURI__: { core: { invoke } } },
    navigator: { clipboard }, console,
    document: { addEventListener() {} },
  };
  vm.runInNewContext(source('bridge.js'), context);
  return context.window.desktopApp;
}
function native(invoke) {
  let callback;
  let View;
  let blocked = false;
  class Element extends EventTarget {
    constructor() { super(); this.dataset = {}; }
    getBoundingClientRect() { return { left: 20, top: 100, right: 820, bottom: 700, width: 800, height: 600 }; }
  }
  const context = {
    window: {
      innerWidth: 1000, innerHeight: 800,
      desktopApp: { invoke },
      __TAURI__: { event: { listen: async (name, fn) => { assert.equal(name, 'native-view'); callback = fn; return () => {}; } } },
      nativeViewLayout: { observe() {}, unobserve() {}, schedule() {}, isBlocked: () => blocked },
    },
    HTMLElement: Element, Event, Uint32Array, crypto: webcrypto,
    customElements: { define: (name, type) => { assert.equal(name, 'tauri-webview'); View = type; } },
    console: { error() {} },
  };
  vm.runInNewContext(source('native-webview.js'), context);
  return { View, event: (payload) => callback({ payload }), block: (value) => { blocked = value; } };
}
test('bootstrap is shared and state copies cannot mutate bootstrap or config', async () => {
  const calls = [];
  const data = { groups: [], state: { lastUrls: { one: { url: 'https://one.test' } } }, defaultExpand: 'all' };
  const app = bridge(async (...args) => { calls.push(args); return data; });
  const [groups, settings, state] = await Promise.all([app.getGroups(), app.getSettings(), app.getState()]);
  assert.deepEqual(groups, []);
  assert.equal(settings.defaultExpand, 'all');
  state.lastUrls.one.url = 'changed';
  assert.equal((await app.getState()).lastUrls.one.url, 'https://one.test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'desktop');
  assert.equal(calls[0][1].op, 'bootstrap');
});
test('state patches serialize and preserve concurrent per-site URL saves', async () => {
  const calls = [];
  const pending = deferred();
  const app = bridge(async (command, request) => {
    if (request.op === 'bootstrap') return { groups: [], state: { lastUrls: { old: { url: 'https://old.test' } } } };
    calls.push(JSON.parse(JSON.stringify(request)));
    if (calls.length === 1) await pending.promise;
    return { ok: true };
  });
  await app.getState();
  const first = app.saveLastUrl('one', 'https://one.test');
  const second = app.saveLastUrl('two', 'https://two.test');
  await tick();
  assert.equal(calls.length, 1);
  pending.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(Object.keys(calls[1].args.patch.lastUrls), ['old', 'one', 'two']);
  assert.equal(calls[0].op, 'state_patch');
});
test('clipboard uses browser API and unsupported API fails explicitly', async () => {
  const calls = [];
  const app = bridge(async (...args) => calls.push(args), { writeText: async (text) => { calls.push(text); } });
  await app.copyText('copied');
  assert.deepEqual(calls, ['copied']);
  await assert.rejects(app.debugCookies(), /unsupported/);
  await assert.rejects(app.openContextMenu(), /unsupported/);
  await assert.rejects(bridge(async () => {}).copyText('x'), /Clipboard API/);
});
test('bootstrap failure is shared rather than masquerading as empty config', async () => {
  let calls = 0;
  const app = bridge(async () => { calls++; throw new Error('invalid config'); });
  await assert.rejects(app.getGroups(), /invalid config/);
  await assert.rejects(app.getState(), /invalid config/);
  assert.equal(calls, 1);
});
test('native view waits for create, caches redirect URL and converts eval failures', async () => {
  const calls = [];
  const pending = deferred();
  const env = native(async (op, args) => {
    calls.push({ op, args });
    if (op === 'create_view') await pending.promise;
    if (op === 'eval_view') return args.script === 'broken' ? { ok: false, error: 'denied' } : { ok: true, value: 42 };
  });
  const view = new env.View();
  view.dataset.siteId = 'sensitive-site';
  view.dataset.sourceId = 'original-site';
  assert.match(view.label, /^view-\d+$/);
  assert.ok(!view.label.includes('sensitive'));
  assert.notEqual(view.label, new env.View().label);
  const load = view.loadURL('https://site.test');
  assert.equal(view.getURL(), 'https://site.test');
  const evaluate = view.executeJavaScript('6 * 7');
  await tick();
  assert.deepEqual(calls.map((call) => call.op), ['create_view']);
  assert.equal(calls[0].args.sourceId, 'original-site');
  env.event({ label: view.label, event: 'did-navigate', url: 'https://site.test/redirect' });
  pending.resolve();
  await load;
  await view.ready;
  assert.equal(view.getURL(), 'https://site.test/redirect');
  assert.equal(await evaluate, 42);
  await assert.rejects(view.executeJavaScript('broken'), /denied/);
});
test('close during create closes native child once and rejects queued navigation', async () => {
  const calls = [];
  const pending = deferred();
  const env = native(async (op, args) => { calls.push({ op, args }); if (op === 'create_view') await pending.promise; });
  const view = new env.View();
  const load = view.loadURL('https://site.test');
  await tick();
  const next = view.loadURL('https://site.test/next');
  const rejected = assert.rejects(next, /已关闭/);
  const close = view.close();
  assert.equal(view.close(), close);
  pending.resolve();
  await Promise.all([load, close, rejected]);
  assert.deepEqual(calls.map((call) => call.op), ['create_view', 'view_action']);
  assert.equal(calls[1].args.action, 'close');
  await assert.rejects(view.executeJavaScript('1'), /已关闭/);
});
test('close before queued create does not leak a native child', async () => {
  const calls = [];
  const env = native(async (...args) => calls.push(args));
  const view = new env.View();
  const load = view.loadURL('https://site.test');
  const rejected = assert.rejects(load, /已关闭/);
  await view.close();
  await rejected;
  await assert.rejects(view.ready, /已关闭/);
  assert.equal(calls.length, 0);
});
test('events filter labels, preserve URL synchronously and retain native focus', async () => {
  const env = native(async () => {});
  const view = new env.View();
  await view.loadURL('https://site.test');
  let focus = 0;
  let navigations = 0;
  view.addEventListener('focus', () => focus++);
  view.addEventListener('did-navigate-in-page', () => navigations++);
  env.event({ label: 'other', event: 'focus' });
  env.block(true);
  env.event({ label: view.label, event: 'focus' });
  assert.equal(focus, 1);
  env.block(false);
  env.event({ label: view.label, event: 'focus' });
  env.event({ label: view.label, event: 'did-navigate-in-page', url: 'https://site.test/#spa' });
  assert.equal(focus, 2);
  assert.equal(navigations, 1);
  assert.equal(view.getURL(), 'https://site.test/#spa');
});
test('creation failure rejects ready and dispatches visible load failure', async () => {
  const env = native(async () => { throw new Error('create denied'); });
  const view = new env.View();
  let failure;
  view.addEventListener('did-fail-load', (event) => { failure = event; });
  await assert.rejects(view.loadURL('https://site.test'), /create denied/);
  await assert.rejects(view.ready, /create denied/);
  assert.equal(failure.isMainFrame, true);
  assert.equal(failure.errorDescription, 'create denied');
});
function layout(invoke) {
  let mutation;
  let resize;
  let blocked = false;
  const frames = [];
  const context = {
    window: { desktopApp: { invoke }, addEventListener() {} },
    document: { hidden: false, body: {}, querySelector: () => blocked ? {} : null, getElementById: () => ({}), addEventListener() {} },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} unobserve() {} },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    console: { error() {} },
  };
  vm.runInNewContext(source('native-layout.js'), context);
  return {
    api: context.window.nativeViewLayout,
    block: (value) => { blocked = value; mutation(); },
    resize: () => resize(),
    hostHidden: (value) => { context.document.hidden = value; resize(); },
    frame: async () => { assert.ok(frames.length); await frames.shift()(); },
    hasFrame: () => frames.length > 0,
  };
}
test('layout serializes IPC, coalesces resize and keeps view visible during menus and toasts', async () => {
  const calls = [];
  const pending = deferred();
  const env = layout(async (op, args) => {
    assert.equal(op, 'layout_views');
    calls.push(JSON.parse(JSON.stringify(args)));
    if (calls.length === 1) await pending.promise;
  });
  let width = 800;
  let active = true;
  const view = { label: 'view-1', _created: true, _closed: false, isConnected: true,
    classList: { contains: () => active },
    getBoundingClientRect: () => ({ width, height: 600 }),
    getBounds: () => ({ x: 20, y: 100, width, height: 600 }),
  };
  env.api.observe(view);
  const frame = env.frame();
  env.block(true);
  width = 650;
  env.resize();
  env.resize();
  assert.equal(env.hasFrame(), false);
  assert.equal(calls.length, 1);
  pending.resolve();
  await frame;
  await env.frame();
  assert.equal(calls[1].views[0].visible, true, '菜单或提示不能隐藏当前站点页面');
  assert.equal(calls[1].views[0].bounds.width, 650);
  env.hostHidden(true);
  await env.frame();
  assert.equal(calls.length, 2, '宿主被遮挡不能隐藏独立站点 WebView');
  env.block(false);
  await env.frame();
  assert.equal(calls.length, 2, '提示关闭不应额外隐藏或重建原生页面');
  active = false;
  env.resize();
  await env.frame();
  assert.equal(calls[2].views[0].visible, false);
  env.resize();
  await env.frame();
  assert.equal(calls.length, 3);
});

function bootPage(result) {
  const card = { children: [], replaceChildren() { this.children = []; }, appendChild(node) { this.children.push(node); }, append(...nodes) { this.children.push(...nodes); } };
  const links = [];
  const context = {
    content: { classList: { remove() {} } }, groups: [],
    document: {
      querySelector: () => card,
      createElement: (tag) => ({ tag, textContent: '', addEventListener(name, action) { this[name] = action; } }),
    },
    window: { desktopApp: {
      getBootstrap: async () => { if (result instanceof Error) throw result; return result; },
      getGroups: async () => result.groups,
      openLink: async (url) => { links.push(url); },
      invoke: async (op) => { links.push(op); },
    } },
    location: { reload() {} },
  };
  vm.runInNewContext(source('main.js'), context);
  return { card, links };
}
test('config errors and empty groups show configuration action; IPC failures show boot error', async () => {
  const invalid = bootPage({ configError: 'bad yaml', configPath: 'C:/config.yml', groups: [] });
  await tick();
  assert.match(invalid.card.children[0].textContent, /bad yaml/);
  const open = invalid.card.children.find((node) => node.textContent === '打开配置文件');
  assert.ok(open);
  await open.click();
  assert.deepEqual(invalid.links, ['C:/config.yml']);
  const restart = invalid.card.children.find((node) => node.textContent === '重启应用');
  assert.ok(restart);
  await restart.click();
  assert.deepEqual(invalid.links, ['C:/config.yml', 'restart']);
  const empty = bootPage({ groups: [], configPath: 'C:/config.yml' });
  await tick();
  assert.match(empty.card.children[0].textContent, /还没有站点/);
  const failed = bootPage(new Error('IPC unavailable'));
  await tick();
  assert.match(failed.card.children[0].textContent, /启动失败：IPC unavailable/);
});
test('state write failure reaches caller and does not poison later writes', async () => {
  let attempts = 0;
  const app = bridge(async () => { attempts++; if (attempts === 1) throw new Error('disk full'); return { ok: true }; });
  await assert.rejects(app.saveLastTab('one'), /disk full/);
  await app.saveLastTab('two');
  assert.equal(attempts, 2);
});

test('native warnings are visible without consuming login-failure deduplication; load fields survive', () => {
  const env = native(async () => {});
  const view = new env.View();
  const notices = [];
  const context = {
    currentSiteId: 'site', getStrategy: () => 'web', log() {}, loginFailedNotified: new Set(),
  };
  vm.runInNewContext(source('webview.js'), context);
  context.showSiteToast = (site, opts) => notices.push({ site, ...opts });
  context.bindWebviewEvents(view, { id: 'site', name: '站点', type: 'web' });
  for (const event of ['hook-error', 'auth-error', 'auth-fallback']) {
    view.receiveNativeEvent({ event, error: 'visible ' + event });
    view.receiveNativeEvent({ event, error: 'visible ' + event });
  }
  assert.equal(notices.length, 3);
  assert.match(notices[0].title, /浏览器能力不可用/);
  assert.match(notices[1].title, /自动认证失败/);
  assert.match(notices[2].title, /需要手动认证/);
  assert.equal(context.loginFailedNotified.size, 0);
  let failure;
  const cleanView = new env.View();
  cleanView.addEventListener('did-fail-load', (event) => { failure = event; });
  cleanView.receiveNativeEvent({ event: 'did-fail-load', isMainFrame: false, errorCode: -1234, errorDescription: 'native details', error: 'fallback' });
  assert.equal(failure.isMainFrame, false);
  assert.equal(failure.errorCode, -1234);
  assert.equal(failure.errorDescription, 'native details');
});
test('restoring ordinary and source-deleted clone tabs persists one complete snapshot', async () => {
  const snapshots = [];
  const ordinary = { id: 'web-0', name: 'ordinary', type: 'web', url: 'https://ordinary.test' };
  const orphan = { id: 'copy-1', name: 'orphan', type: 'web', url: 'https://orphan.test', sourceId: 'deleted-0' };
  const boot = { groups: [{ key: 'web', sites: [ordinary] }] };
  const app = {
    log() {}, getBootstrap: async () => boot, getGroups: async () => boot.groups,
    getSettings: async () => ({}),
    getState: async () => ({ openTabs: ['web-0', 'copy-1'], clonedSites: [orphan], expandedGroups: [], lastTab: 'copy-1' }),
    saveOpenTabs: async (ids, clones) => snapshots.push(JSON.parse(JSON.stringify({ ids, clones }))),
  };
  const node = { appendChild() {}, classList: { remove() {} } };
  const context = {
    window: { desktopApp: app },
    document: { getElementById: () => node, createElement: () => ({ dataset: {}, loadURL: async () => {}, addEventListener() {} }) },
    renderSidebar() {}, bindActions() {}, renderTabs() {},
  };
  vm.runInNewContext(source('state.js'), context);
  vm.runInNewContext(source('webview.js'), context);
  context.bindWebviewEvents = () => {};
  context.selectSite = () => {};
  vm.runInNewContext(source('main.js'), context);
  await tick();
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].ids, ['web-0', 'copy-1']);
  assert.equal(snapshots[0].clones.length, 1);
  assert.equal(snapshots[0].clones[0].url, 'https://orphan.test');
  assert.equal(snapshots[0].clones[0].id, 'copy-1');
});

// ===== 接口调试 / 定时任务(阶段 C、D) =====
/* 通用弹窗 DOM 替身:支持 children/firstChild/removeChild/className→classList/innerHTML 清空 */
function dialogContext(bridgeOps, scripts) {
  const nodes = new Map();
  const calls = [];
  const makeNode = (id) => {
    const node = {
      id, value: '', hidden: true, textContent: '', checked: false, style: {}, dataset: {}, children: [],
      classList: {
        _set: new Set(),
        add(name) { this._set.add(name); },
        remove(name) { this._set.delete(name); },
        toggle(name, force) {
          if (force === undefined) { this._set.has(name) ? this._set.delete(name) : this._set.add(name); }
          else if (force) this._set.add(name); else this._set.delete(name);
        },
        contains(name) { return this._set.has(name); },
      },
      addEventListener(name, fn) {
        if (!this.listeners) this.listeners = new Map();
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(fn);
      },
      dispatch(name, event) { (this.listeners && this.listeners.get(name) || []).forEach((fn) => fn(event || { target: this, preventDefault() {}, stopPropagation() {} })); },
      append(...items) { items.forEach((item) => this.appendChild(item)); },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      get firstChild() { return this.children[0] || null; },
      removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); return child; },
      remove() {},
      querySelectorAll(selector) {
        const acc = [];
        const walk = (node) => node.children.forEach((child) => {
          if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) acc.push(child);
          walk(child);
        });
        walk(this);
        return acc;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      focus() {},
    };
    let classNameValue = '';
    Object.defineProperty(node, 'className', {
      get() { return classNameValue; },
      set(value) { classNameValue = String(value || ''); node.classList._set = new Set(classNameValue.split(/\s+/).filter(Boolean)); },
    });
    let ownText = String(node.textContent || '');
    Object.defineProperty(node, 'textContent', {
      get() { return node.children.length ? node.children.map((child) => child.textContent).join('') : ownText; },
      set(value) { ownText = String(value === undefined || value === null ? '' : value); node.children.length = 0; },
    });
    let inner = '';
    Object.defineProperty(node, 'innerHTML', {
      get() { return inner; },
      set(value) { inner = String(value || ''); node.children.length = 0; },
    });
    return node;
  };
  const getNode = (id) => {
    if (!nodes.has(id)) {
      const node = makeNode(id);
      if (id === 'apiToolMethod') node.value = 'GET';
      if (id === 'schedEnabled') node.checked = true;
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const context = {
    window: { desktopApp: bridgeOps(calls), addEventListener() {} },
    document: { getElementById: getNode, createElement: () => makeNode('created'), querySelectorAll: () => [], addEventListener() {} },
    console, URL, JSON, Math, Object, Array, String, Number, RegExp, Set, Map, Promise, setTimeout, clearTimeout, Date,
  };
  vm.runInNewContext(source('state.js'), context);
  (scripts || []).forEach((name) => vm.runInNewContext(source(name), context));
  return { context, getNode, calls };
}

test('api tool: opens with view label, lists requests and refills headers', async () => {
  const listResult = {
    ok: true, dir: '/tmp/logs/db/Example', total: 2,
    items: [
      { time: 1, method: 'GET', url: 'https://a.test/api/one', statusCode: 200, durationMs: 5, requestHeaders: { Authorization: 'Bearer t' } },
      { time: 2, method: 'POST', url: 'https://a.test/api/login', statusCode: 200, durationMs: 9, requestHeaders: { 'X-Trace': '1' } },
    ],
  };
  const { context, getNode, calls } = dialogContext((calls) => ({
    log: () => {},
    currentViewLabel: () => 'view-current',
    apiToolList: async (label, keyword) => { calls.push(['list', label, keyword]); return listResult; },
    apiToolSend: async (payload) => { calls.push(['send', payload]); return { ok: true, status: 200 }; },
  }), ['api-tool.js']);
  vm.runInNewContext("webviews['g-0'] = { label: 'view-current' }; bindApiToolActions();", context);
  vm.runInNewContext("showApiToolDialog({ id: 'g-0', name: 'Example' })", context);
  await tick();
  assert.deepEqual(calls[0], ['list', 'view-current', '']);
  assert.equal(getNode('apiToolTag').textContent, 'Example · view-current');
  assert.equal(getNode('apiToolList').children.length, 2, '渲染两条请求');

  const rows = getNode('apiToolList').children;
  rows[1].dispatch('click', { target: rows[1], preventDefault() {} });
  assert.equal(getNode('apiToolMethod').value, 'POST');
  assert.equal(getNode('apiToolUrl').value, 'https://a.test/api/login');
  assert.match(getNode('apiToolHeaders').value, /X-Trace/);
});

test('api tool: sends payload and renders response, invalid headers blocked', async () => {
  const { context, getNode, calls } = dialogContext((calls) => ({
    log: () => {},
    currentViewLabel: () => 'view-current',
    apiToolList: async () => ({ ok: true, items: [], total: 0, dir: '' }),
    apiToolSend: async (payload) => {
      calls.push(['send', payload]);
      return { ok: true, status: 200, statusText: 'OK', durationMs: 12, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', logPath: '/tmp/a.log' };
    },
  }), ['api-tool.js']);
  vm.runInNewContext("webviews['g-0'] = { label: 'view-current' }; bindApiToolActions();", context);
  vm.runInNewContext("showApiToolDialog({ id: 'g-0', name: 'Example' })", context);
  await tick();

  getNode('apiToolUrl').value = 'https://a.test/api/login';
  getNode('apiToolHeaders').value = '{bad';
  getNode('apiToolSendBtn').dispatch('click');
  await tick();
  assert.equal(calls.filter((call) => call[0] === 'send').length, 0, '非法请求头不得发送');
  assert.match(getNode('apiToolStatus').textContent, /请求头/);

  getNode('apiToolHeaders').value = '{"X-Trace":"1"}';
  getNode('apiToolBody').value = '{"user":"u"}';
  getNode('apiToolSendBtn').dispatch('click');
  await tick();
  const sends = calls.filter((call) => call[0] === 'send');
  assert.equal(sends.length, 1);
  const payload = JSON.parse(JSON.stringify(sends[0][1]));
  assert.equal(payload.headers['X-Trace'], '1');
  assert.equal(payload.headers['Content-Type'], 'application/json');
  assert.match(getNode('apiToolStatus').textContent, /200/);
  assert.match(getNode('apiToolResponse').textContent, /"ok": true/);
});

test('scheduler: opens with defaults from current page and lists tasks', async () => {
  const tasks = [{
    id: 'task-9', name: '旧任务', cron: '*/30 * * * *', groupKey: 'g1', siteName: 'A',
    url: 'https://a.test/api/x', enabled: true, lastRunAt: 1, lastStatus: '200', nextRunAt: 2, running: false,
  }];
  const { context, getNode, calls } = dialogContext((calls) => ({
    log: () => {},
    schedulerList: async () => { calls.push(['list']); return { ok: true, tasks, dir: '/tmp/tasks' }; },
    schedulerSave: async (task) => { calls.push(['save', task]); return { ok: true, task: { ...task, id: 'task-1' } }; },
    schedulerRun: async (id) => { calls.push(['run', id]); return { ok: true, statusCode: 200, durationMs: 7 }; },
    schedulerToggle: async (id, enabled) => { calls.push(['toggle', id, enabled]); return { ok: true }; },
    schedulerRemove: async (id) => { calls.push(['remove', id]); return { ok: true }; },
  }), ['scheduler.js']);
  vm.runInNewContext(`
    groups = [{ key: 'g1', label: 'G1', icon: '', color: '#111111', type: 'web', sites: [
      { id: 'g1-0', groupKey: 'g1', type: 'web', name: 'A', url: 'https://a.test/' },
      { id: 'g1-1', groupKey: 'g1', type: 'web', name: 'B', url: 'https://b.test/' },
    ] }, { key: 'g2', label: 'G2', icon: '', color: '#222', type: 'web', sites: [
      { id: 'g2-0', groupKey: 'g2', type: 'web', name: 'C', url: 'https://c.test/' },
    ] }];
    currentSiteId = 'g2-0';
    bindSchedulerActions();
  `, context);
  getNode('schedulerBtn').dispatch('click');
  await tick();
  assert.deepEqual(calls[0], ['list']);
  assert.equal(getNode('schedGroup').value, 'g2', '默认分组跟随当前页面');
  assert.equal(getNode('schedSite').value, 'C');
  assert.equal(getNode('schedList').children.length, 1);
  assert.match(getNode('schedDir').textContent, /输出目录/);

  getNode('schedGroup').value = 'g1';
  getNode('schedGroup').dispatch('change');
  assert.deepEqual(getNode('schedSite').children.map((option) => option.value), ['A', 'B']);
});

test('scheduler: validates input, saves payload and runs row actions', async () => {
  const { context, getNode, calls } = dialogContext((calls) => ({
    log: () => {},
    schedulerList: async () => ({ ok: true, tasks: [], dir: '/tmp/tasks' }),
    schedulerSave: async (task) => { calls.push(['save', task]); return { ok: true, task: { ...task, id: 'task-1' } }; },
    schedulerRun: async (id) => { calls.push(['run', id]); return { ok: true, statusCode: 200, durationMs: 7 }; },
    schedulerToggle: async (id, enabled) => { calls.push(['toggle', id, enabled]); return { ok: true }; },
    schedulerRemove: async (id) => { calls.push(['remove', id]); return { ok: true }; },
  }), ['scheduler.js']);
  vm.runInNewContext(`
    groups = [{ key: 'g1', label: 'G1', icon: '', color: '#111111', type: 'web', sites: [
      { id: 'g1-0', groupKey: 'g1', type: 'web', name: 'A', url: 'https://a.test/' },
      { id: 'g1-1', groupKey: 'g1', type: 'web', name: 'B', url: 'https://b.test/' },
    ] }];
    currentSiteId = 'g1-0';
    bindSchedulerActions();
  `, context);
  getNode('schedulerBtn').dispatch('click');
  await tick();

  getNode('schedSaveBtn').dispatch('click');
  await tick();
  assert.match(getNode('schedStatus').textContent, /任务名称/);
  assert.equal(calls.filter((call) => call[0] === 'save').length, 0);

  getNode('schedName').value = '日报';
  getNode('schedCron').value = '0 9 * * *';
  getNode('schedSite').value = 'B';
  getNode('schedUrl').value = 'https://a.test/api/report';
  getNode('schedSaveBtn').dispatch('click');
  await tick();
  const saves = calls.filter((call) => call[0] === 'save');
  assert.equal(saves.length, 1);
  const payload = JSON.parse(JSON.stringify(saves[0][1]));
  assert.deepEqual(payload, {
    id: '', name: '日报', cron: '0 9 * * *', groupKey: 'g1', siteName: 'B',
    method: 'GET', url: 'https://a.test/api/report', headers: '', body: '', enabled: true,
  });
  assert.match(getNode('schedStatus').textContent, /已保存/);

  const rows = [{
    id: 'task-1', name: '日报', cron: '0 9 * * *', groupKey: 'g1', siteName: 'B',
    url: 'https://a.test/x', enabled: true,
  }];
  vm.runInNewContext('renderSchedulerTasks(' + JSON.stringify(rows) + ", '/tmp/tasks')\n", context);
  const row = getNode('schedList').children[0];
  const buttons = row.querySelectorAll('.sched-action');
  assert.deepEqual(buttons.map((button) => button.textContent), ['编辑', '立即执行', '停用', '删除']);
  buttons[1].dispatch('click', { stopPropagation() {} });
  await tick();
  assert.deepEqual(calls.filter((call) => call[0] === 'run'), [['run', 'task-1']]);
  buttons[2].dispatch('click', { stopPropagation() {} });
  await tick();
  assert.deepEqual(calls.filter((call) => call[0] === 'toggle'), [['toggle', 'task-1', false]]);
  buttons[3].dispatch('click', { stopPropagation() {} });
  await tick();
  assert.deepEqual(calls.filter((call) => call[0] === 'remove'), [['remove', 'task-1']]);
});


// ===== 树形分屏 + 每格标题条(tauri) =====
function splitContext() {
  const children = [];
  const calls = [];
  const makeEl = (className) => {
    const el = {
      children: [], dataset: {}, textContent: '', isConnected: true,
      style: {
        _map: new Map(),
        setProperty(name, value) { this._map.set(name, String(value)); },
        removeProperty(name) { this._map.delete(name); },
        getPropertyValue(name) { return this._map.has(name) ? this._map.get(name) : ''; },
      },
      classList: {
        _set: new Set(String(className || '').split(/\s+/).filter(Boolean)),
        add(name) { this._set.add(name); },
        remove(name) { this._set.delete(name); },
        toggle(name, force) { if (force === undefined) { this._set.has(name) ? this._set.delete(name) : this._set.add(name); } else if (force) this._set.add(name); else this._set.delete(name); },
        contains(name) { return this._set.has(name); },
      },
      get className() { return [...this.classList._set].join(' '); },
      set className(value) { this.classList._set = new Set(String(value || '').split(/\s+/).filter(Boolean)); },
      addEventListener() {}, removeEventListener() {},
      addEventListener(name, fn) {
        if (!this.listeners) this.listeners = new Map();
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(fn);
      },
      dispatch(name, event) {
        (this.listeners && this.listeners.get(name) || []).forEach((fn) => fn(event || { target: this, preventDefault() {}, stopPropagation() {} }));
      },
      append(...nodes) { nodes.forEach((node) => this.appendChild(node)); },
      appendChild(node) { node.parent = this; this.children.push(node); children.push(node); return node; },
      remove() {
        const local = this.parent ? this.parent.children.indexOf(this) : -1;
        if (local >= 0) this.parent.children.splice(local, 1);
        const global = children.indexOf(this);
        if (global >= 0) children.splice(global, 1);
      },
      querySelectorAll(selector) {
        const acc = [];
        const walk = (node) => node.children.forEach((child) => {
          if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) acc.push(child);
          walk(child);
        });
        walk(this);
        return acc;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 }; },
    };
    // textContent:有子节点时聚合(与真实 DOM 一致),否则用自身文本
    let ownText = '';
    Object.defineProperty(el, 'textContent', {
      get() {
        if (el.children.length) return el.children.map((child) => child.textContent).join('');
        return ownText;
      },
      set(value) { ownText = String(value === undefined || value === null ? '' : value); el.children.length = 0; },
    });
    // addEventListener 已在对象里定义,这里覆盖为带 listeners 的版本(上面已实现,保留)
    return el;
  };
  const makeWebview = (id) => {
    const el = makeEl('active');
    el.dataset = { siteId: id };
    el.id = 'wv-' + id;
    return el;
  };
  const container = makeEl('webviewContainer');
  const windowListeners = new Map();
  const windowStub = {
    desktopApp: { log: () => {}, saveLastTab: () => {}, saveOpenTabs: () => Promise.resolve(true) },
    addEventListener(name, fn) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(fn);
    },
    removeEventListener(name, fn) {
      const list = windowListeners.get(name);
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(name, event) {
      const payload = event || {};
      if (typeof payload.preventDefault !== 'function') payload.preventDefault = () => {};
      (windowListeners.get(name) || []).forEach((fn) => fn(payload));
    },
    nativeViewLayout: { schedule() { calls.push('layout'); } },
  };
  const context = {
    window: windowStub,
    document: {
      getElementById: (id) => (id === 'webviewContainer' ? container : makeEl(id)),
      createElement: () => makeEl('created'),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    ResizeObserver: class { observe() {} unobserve() {} },
    console, URL, JSON, Math, Object, Array, String, Number, RegExp, Set, Map, Promise,
    setTimeout, clearTimeout,
    __calls: calls,
  };
  vm.runInNewContext(source('state.js'), context);
  vm.runInNewContext(`
    groups = [{ key: 'g1', label: 'G1', icon: '', color: '#111111', type: 'web', sites: [
      { id: 'g1-0', groupKey: 'g1', type: 'web', name: 'A', url: 'https://a.test/' },
      { id: 'g1-1', groupKey: 'g1', type: 'web', name: 'B', url: 'https://b.test/' },
      { id: 'g1-2', groupKey: 'g1', type: 'web', name: 'C', url: 'https://c.test/' },
    ] }];
    currentSiteId = 'g1-0';
    state.lastUrls = { 'g1-2': { url: 'x', ts: 9 }, 'g1-1': { url: 'x', ts: 5 } };
    tabOrder.length = 0;
    groups[0].sites.forEach((site) => {
      tabOrder.push(site.id);
      webviews[site.id] = __makeWebview(site.id);
    });
    function getOpenedSitesInOrder() { return tabOrder.map((id) => findSiteById(id)).filter((site) => site && webviews[site.id]); }
    function createWebview(site) { __calls.push('createWebview:' + site.id); if (!webviews[site.id]) { webviews[site.id] = __makeWebview(site.id); tabOrder.push(site.id); } }
    function renderTabs() { __calls.push('renderTabs'); }
    function expandGroup(group) { __calls.push('expandGroup:' + group.key); }
    function applyAppBackground() {}
    function cloneSite(site, options) {
      __calls.push('cloneSite:' + site.id);
      const clone = { id: 'copy-1', name: 'copy-A', type: site.type, url: site.url, isClone: true, sourceId: site.id };
      clonedSites.push(clone);
      webviews[clone.id] = __makeWebview(clone.id);
      tabOrder.push(clone.id);
      if (!options || options.select !== false) selectSite(clone);
      return clone;
    }
    function selectSite(site) { __calls.push('selectSite:' + site.id); currentSiteId = site.id; }
  `, Object.assign(context, { __makeWebview: makeWebview }));
  vm.runInNewContext(source('split.js'), context);
  return { context, container, children, calls };
}

const splitLeaves = (context) => JSON.parse(vm.runInNewContext(
  'JSON.stringify(splitLeaves(splitTree).map((leaf) => ({ id: leaf.id, siteId: leaf.siteId })))', context));

test('split: right/down subdivide indefinitely with non-overlapping geometry', () => {
  const { context, container } = splitContext();
  assert.equal(vm.runInNewContext('splitIsActive()', context), false);

  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  assert.equal(container.classList.contains('split'), true);
  const first = splitLeaves(context);
  assert.equal(first.length, 2);
  assert.equal(first[0].siteId, 'g1-0');
  assert.equal(first[1].siteId, null, '新格默认空白');

  // 容器 1000x600,pad 4, gap 4 -> 每格 494 宽;页面区再减去 18px 标题条
  const rects = JSON.parse(vm.runInNewContext('JSON.stringify(splitComputeRects(splitTree, splitContainerArea()))', context));
  const r0 = rects[first[0].id];
  assert.deepEqual([r0.left, r0.width, r0.height], [4, 494, 592], '叶子矩形含标题条');
  assert.equal(vm.runInNewContext("webviews['g1-0'].style.height", context), '574px', '页面区 = 叶子 - 18px 标题条');
  assert.equal(vm.runInNewContext("webviews['g1-0'].style.top", context), '22px');

  vm.runInNewContext("splitSiteDown(findSiteById('g1-1'))", context);
  assert.equal(splitLeaves(context).length, 3);
  const all = JSON.parse(vm.runInNewContext('JSON.stringify(splitComputeRects(splitTree, splitContainerArea()))', context));
  Object.values(all).forEach((rect) => {
    assert.equal(rect.left >= 4 && rect.top >= 4, true);
    assert.equal(rect.left + rect.width <= 996, true);
    assert.equal(rect.top + rect.height <= 596, true);
  });
});

test('split: clone pane duplicates the current site into a new right pane', () => {
  const { context, calls } = splitContext();
  vm.runInNewContext("splitClonePane(findSiteById('g1-0'))", context);
  assert.equal(calls.includes('cloneSite:g1-0'), true);
  const panes = splitLeaves(context);
  assert.equal(panes.length, 2);
  assert.equal(panes[1].siteId, 'copy-1');
});

test('split: closing a pane keeps tabs, collapses the layout and returns to single', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  vm.runInNewContext("splitFocusedPane('column')", context);
  assert.equal(splitLeaves(context).length, 3);

  // 关掉最后一格(空白):只移格子,不动 tab
  const closeLeaf = splitLeaves(context).slice(-1)[0];
  vm.runInNewContext(`splitClosePane('${closeLeaf.id}')`, context);
  assert.equal(splitLeaves(context).length, 2, '关闭一格后剩两格');
  assert.equal(vm.runInNewContext("tabOrder.length", context), 3, 'tab 数量不受影响');

  // 再关一格 -> 只剩一格回单窗
  const nextLeaf = splitLeaves(context).slice(-1)[0];
  vm.runInNewContext(`splitClosePane('${nextLeaf.id}')`, context);
  assert.equal(vm.runInNewContext('splitIsActive()', context), false, '只剩一格回单窗');
  assert.equal(container.classList.contains('split'), false);
  assert.equal(vm.runInNewContext("tabOrder.length", context), 3, 'tab 仍然保留');
});

test('split: blank pane lists recent pages and can be filled', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitLeaf('', 'row', null)", context);
  const empties = container.querySelectorAll('.split-empty');
  assert.equal(empties.length, 1, '空白格');
  const names = empties[0].querySelectorAll('.split-empty-name').map((node) => node.textContent);
  assert.deepEqual(names.slice(0, 2), ['A', 'B'], '允许重复打开:按树顺序列出全部站点');
  const items = empties[0].querySelectorAll('.split-empty-item');
  items[0].dispatch('click', { preventDefault() {} });
  // A 已在第一格:重复点选会创建面板副本(copy-1),不共用同一个视图
  assert.equal(splitLeaves(context)[1].siteId, 'copy-1', '同一页面重复打开时使用面板副本');
});

test('split: each pane shows its own title bar inside the pane', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  const titles = container.querySelectorAll('.pane-title');
  assert.equal(titles.length, 2, '每格一个标题条');
  const nameOf = (title) => {
    const node = title.querySelector('.pane-title-name');
    return node ? node.textContent : title.textContent;
  };
  assert.deepEqual(titles.map(nameOf), ['A', '空白'], '第一格是站点,新格默认空白');
  assert.equal(titles[0].classList.contains('focus'), true, '焦点格高亮');
  assert.equal(titles[1].classList.contains('focus'), false);
  assert.equal(titles[0].style.top, '4px');
  assert.equal(titles[0].style.height, '18px');
  assert.equal(titles[0].style.width, vm.runInNewContext("webviews['g1-0'].style.width", context), '标题与页面区同宽');
});

test('split: blank pane title shows 空白, titles follow geometry and are cleaned on exit', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitLeaf('', 'row', null)", context);
  const titles = container.querySelectorAll('.pane-title');
  const nameOf2 = (title) => {
    const node = title.querySelector('.pane-title-name');
    return node ? node.textContent : title.textContent;
  };
  assert.deepEqual(titles.map(nameOf2), ['A', '空白'], '空白格标题为"空白"');

  vm.runInNewContext(`
    splitStartDrag(splitTree, 'row', { clientX: 502, clientY: 200, pointerId: 1, cancelable: true, preventDefault() {} });
    window.dispatch('pointermove', { clientX: 300, clientY: 200, cancelable: true, preventDefault() {} });
    splitPaintGeometryOnly();
    window.dispatch('pointerup', {});
  `, context);
  const moved = container.querySelectorAll('.pane-title');
  assert.equal(moved.length, 2);
  assert.equal(Number(moved[0].style.width.replace('px', '')) < 494, true, '标题随格子变窄');
  assert.equal(moved[0].style.width, vm.runInNewContext("webviews['g1-0'].style.width", context));

  vm.runInNewContext("splitExit('g1-0')", context);
  assert.equal(container.querySelectorAll('.pane-title').length, 0);
});

test('split: divider menu exposes only the three pane actions', () => {
  const { context, calls } = splitContext();
  const invocations = [];
  vm.runInNewContext(`
    window.desktopApp.invoke = (op, args) => { __invocations.push([op, args]); return Promise.resolve(true); };
    splitSiteRight(findSiteById('g1-0'));
  `, Object.assign(context, { __invocations: invocations }));
  const bar = context.window.webviewContainer ? null : null;
  // 触发分隔条右键
  vm.runInNewContext(`(() => {
    const bar = webviewContainer.querySelectorAll('.split-bar')[0];
    bar.dispatch('contextmenu', { clientX: 300, clientY: 200, preventDefault() {} });
  })()`, context);
  assert.equal(invocations.length, 1, '右键分隔条应请求原生菜单');
  assert.equal(invocations[0][0], 'context_menu');
  assert.equal(invocations[0][1].kind, 'pane', '分隔条与标题条共用面板菜单');
  assert.match(invocations[0][1].siteId, /^pane-/, 'payload 用面板 id 承载目标');
  void calls; void bar;
});

test('split: close pane removes the pane and collapses its sibling', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  vm.runInNewContext("splitSiteDown(findSiteById('g1-1'))", context);
  assert.equal(splitLeaves(context).length, 3);

  // 关闭焦点面板对应的站点视图:走 destroyWebview 替身
  vm.runInNewContext(`
    function destroyWebview(site) {
      delete webviews[site.id];
      const index = tabOrder.indexOf(site.id);
      if (index >= 0) tabOrder.splice(index, 1);
      splitHandleSiteClosed(site.id);
    }
  `, context);
  const focusedPane = vm.runInNewContext('splitFindLeaf(splitTree, splitFocusLeafId)', context);
  vm.runInNewContext(`splitClosePane('${focusedPane.id}')`, context);
  assert.equal(splitLeaves(context).length, 2, '关闭后剩两格');

  // 空白格关闭
  vm.runInNewContext("splitLeaf('', 'column', null)", context);
  const blank = JSON.parse(vm.runInNewContext('JSON.stringify(splitLeaves(splitTree).find((leaf) => !leaf.siteId))', context));
  assert.ok(blank, '存在空白格');
  const before = splitLeaves(context).length;
  vm.runInNewContext(`splitClosePane('${blank.id}')`, context);
  assert.equal(splitLeaves(context).length, before - 1, '空白格被移除');

  // 关到只剩一格回单窗
  const remaining = splitLeaves(context);
  const victim = remaining.find((leaf) => leaf.siteId) || remaining[0];
  vm.runInNewContext(`splitClosePane('${victim.id}')`, context);
  if (vm.runInNewContext('splitIsActive()', context)) {
    const left = splitLeaves(context);
    assert.equal(left.length, 1);
  } else {
    assert.equal(container.classList.contains('split'), false);
  }
});

test('split: focused pane border follows the group theme color', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  // g1 分组色 #111(测试替身里配置),焦点在该分组的站点上
  assert.equal(container.style.getPropertyValue('--pane-focus'), '#111111',
    '焦点描边色应取当前分组色(与菜单/tab 主题同源)');

  // 切到另一分组的站点后颜色跟随
  vm.runInNewContext(`
    groups.push({ key: 'g2', label: 'G2', icon: '', color: '#22c55e', type: 'web', sites: [
      { id: 'g2-0', groupKey: 'g2', type: 'web', name: 'D', url: 'https://d.test/' },
    ] });
    webviews['g2-0'] = __makeWebview('g2-0');
    tabOrder.push('g2-0');
    splitOpenInLeaf(splitLeaves(splitTree)[1].id, findSiteById('g2-0'));
  `, context);
  assert.equal(container.style.getPropertyValue('--pane-focus'), '#22c55e');

  // 退出分屏清掉变量
  vm.runInNewContext("splitExit('g1-0')", context);
  assert.equal(container.style.getPropertyValue('--pane-focus'), '');
});

test('split: divider bar has no buttons; buttons live on pane title bars', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  assert.equal(container.querySelectorAll('.split-bar-btn').length, 0, '分隔条内不应有按钮');
  const titleButtons = container.querySelectorAll('.pane-title-btn');
  assert.equal(titleButtons.length, 6, '两个面板各三个按钮');
  const namesInTitle = Array.from(container.querySelectorAll('.pane-title-name')).map((el) => el.textContent);
  assert.deepEqual(namesInTitle, ['A', '空白'], '第二格默认空白');
  assert.deepEqual(titleButtons.slice(0, 3).map((b) => b.dataset.action), ['split-right', 'split-down', 'close-pane']);

  // 标题条按钮「左右分」:根层加列,竖线仍贯穿整高
  titleButtons[0].dispatch('click', { stopPropagation() {} });
  const colBars = container.querySelectorAll('.split-bar').filter((bar) => bar.classList.contains('col'));
  assert.equal(colBars.length, 2);
  colBars.forEach((bar) => assert.equal(bar.style.height, '592px'));

  // 「上下分」:横线只在列内
  container.querySelectorAll('.pane-title')[0].querySelectorAll('.pane-title-btn')[1]
    .dispatch('click', { stopPropagation() {} });
  const rowBars = container.querySelectorAll('.split-bar').filter((bar) => bar.classList.contains('row'));
  assert.equal(rowBars.length, 1);
  assert.equal(Number(rowBars[0].style.width.replace('px', '')) < 992, true);
});

test('split: pane title bar buttons act on their own pane', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  const titles = container.querySelectorAll('.pane-title');
  const actions = titles[0].querySelectorAll('.pane-title-btn');
  assert.deepEqual(actions.map((b) => b.dataset.action), ['split-right', 'split-down', 'close-pane']);

  // 左右分:插入新列 -> 两条竖线都贯穿整高
  actions[0].dispatch('click', { stopPropagation() {} });
  const colBars = container.querySelectorAll('.split-bar').filter((bar) => bar.classList.contains('col'));
  assert.equal(colBars.length, 2);
  colBars.forEach((bar) => assert.equal(bar.style.height, '592px'));

  // 上下分:横线只在所在列
  const downBtn = container.querySelectorAll('.pane-title')[0]
    .querySelectorAll('.pane-title-btn').find((b) => b.dataset.action === 'split-down');
  downBtn.dispatch('click', { stopPropagation() {} });
  const rowBars = container.querySelectorAll('.split-bar').filter((bar) => bar.classList.contains('row'));
  assert.equal(rowBars.length, 1);
  assert.equal(Number(rowBars[0].style.width.replace('px', '')) < 992, true);

  // 关闭:只关自己那一格
  const before = splitLeaves(context).length;
  const closeBtn = container.querySelectorAll('.pane-title')[0]
    .querySelectorAll('.pane-title-btn').find((b) => b.dataset.action === 'close-pane');
  closeBtn.dispatch('click', { stopPropagation() {} });
  assert.equal(splitLeaves(context).length, before - 1);
});

test('split: pane title bar right click opens the shared pane menu', () => {
  const { context, container } = splitContext();
  const invocations = [];
  vm.runInNewContext(`
    window.desktopApp.invoke = (op, args) => { __invocations.push([op, args]); return Promise.resolve(true); };
    splitSiteRight(findSiteById('g1-0'));
  `, Object.assign(context, { __invocations: invocations }));
  vm.runInNewContext(`(() => {
    const title = webviewContainer.querySelectorAll('.pane-title')[1];
    title.dispatch('contextmenu', { clientX: 400, clientY: 120, preventDefault() {}, stopPropagation() {} });
  })()`, context);
  assert.equal(invocations.length, 1, '标题条右键应请求原生菜单');
  assert.equal(invocations[0][1].kind, 'pane');
  assert.match(invocations[0][1].siteId, /^pane-/, '目标为该标题条所属面板');
});

test('split: layout snapshot persists structure and restores with missing sites blank', () => {
  const { context, container } = splitContext();
  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  const snapshot = JSON.parse(vm.runInNewContext('JSON.stringify(splitSnapshot())', context));
  assert.equal(snapshot.layout.startsWith('row') || snapshot.tree.type === 'split', true);
  assert.equal(typeof snapshot.focusIndex, 'number');
  assert.equal(JSON.stringify(snapshot.tree).includes('g1-0'), true);

  // 动态页面不入快照
  vm.runInNewContext(`
    groups.push({ key: 'page', label: 'Page', icon: '', color: '#64748b', type: 'web', sites: [
      { id: 'page-dyn-1', groupKey: 'page', type: 'web', name: 'x', url: 'https://x.test/', isDynamic: true }] });
    webviews['page-dyn-1'] = __makeWebview('page-dyn-1');
    splitOpenInLeaf(splitLeaves(splitTree)[1].id, findSiteById('page-dyn-1'));
  `, context);
  const withDynamic = JSON.parse(vm.runInNewContext('JSON.stringify(splitSnapshot())', context));
  assert.equal(JSON.stringify(withDynamic.tree).includes('page-dyn-1'), false);

  // 恢复:缺失站点 -> 空白
  const restore = {
    layout: 'custom',
    tree: {
      type: 'split', direction: 'row', ratio: 0.35,
      first: { type: 'leaf', siteId: 'g1-0' },
      second: { type: 'leaf', siteId: 'ghost-site' },
    },
    focusIndex: 0,
  };
  vm.runInNewContext('splitExit(null)', context);
  const ok = vm.runInNewContext('splitRestore(' + JSON.stringify(restore) + ')', context);
  assert.equal(ok, true);
  assert.equal(vm.runInNewContext('splitTree.ratio', context), 0.35);
  assert.deepEqual(JSON.parse(vm.runInNewContext('JSON.stringify(splitLeaves(splitTree).map((leaf) => leaf.siteId))', context)),
    ['g1-0', null]);
  assert.equal(container.classList.contains('split'), true);
});

test('split: only persists when the snapshot actually changes', () => {
  const { context } = splitContext();
  vm.runInNewContext(`
    window.__saved = [];
    window.desktopApp.saveSplitLayout = (snapshot) => { window.__saved.push(snapshot); return Promise.resolve(true); };
    splitLastSaved = '';
  `, context);
  vm.runInNewContext("splitSiteRight(findSiteById('g1-0'))", context);
  const first = vm.runInNewContext('window.__saved.length', context);
  assert.equal(first, 1, '首次布局写一次');
  vm.runInNewContext('splitSyncPanes()', context);
  assert.equal(vm.runInNewContext('window.__saved.length', context), first, '状态未变不重复写');
  vm.runInNewContext("splitClosePane(splitLeaves(splitTree)[0].id)", context);
  assert.ok(vm.runInNewContext('window.__saved.length', context) > first, '关闭面板后再次写盘');
});

test('scheduler: renders run logs and filters by keyword', async () => {
  const runs = [
    { time: 1700000000, taskName: '日报', method: 'GET', url: 'https://a.test/one', statusCode: 200, durationMs: 5, via: 'headless', skippedHeaders: [], error: '' },
    { time: 1700000100, taskName: '周报', method: 'POST', url: 'https://a.test/two', statusCode: 500, durationMs: 9, via: 'session', skippedHeaders: ['Authorization<-localStorage:token'], error: 'boom' },
  ];
  const { context, getNode, calls } = dialogContext((calls) => ({
    log: () => {},
    schedulerList: async () => ({ ok: true, tasks: [], dir: '/tmp/tasks' }),
    schedulerRuns: async (keyword) => {
      calls.push(['runs', keyword]);
      const items = keyword ? runs.filter((r) => (r.taskName + r.url + r.statusCode + r.error).includes(keyword)) : runs;
      return { ok: true, items, total: runs.length };
    },
  }), ['scheduler.js']);
  vm.runInNewContext("groups = []; currentSiteId = null; bindSchedulerActions();", context);
  getNode('schedulerBtn').dispatch('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'runs'), [['runs', '']], '打开弹窗会拉执行日志');
  const rows = getNode('schedRunsList').children;
  assert.equal(rows.length, 2);
  assert.match(rows[1].textContent, /周报/);
  assert.match(rows[1].textContent, /跳过头/);
  assert.match(getNode('schedRunsCount').textContent, /\(2\)/);

  // 关键字筛选(防抖 300ms)
  getNode('schedRunsKeyword').value = '周报';
  getNode('schedRunsKeyword').dispatch('input');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(calls.filter((c) => c[0] === 'runs').at(-1), ['runs', '周报']);
  assert.equal(getNode('schedRunsList').children.length, 1);
});

test('open page: repeated same URL gets numbered titles (web / web-1 / web-2)', async () => {
  const { context, getNode } = (() => {
    // 复用 pageContext 的构造方式:直接在本用例内建最小上下文
    const nodes = new Map();
    const makeNode = (id) => ({
      id, value: '', hidden: true, textContent: '', style: {}, dataset: {}, children: [],
      classList: { _set: new Set(), add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(name, fn) { if (!this.listeners) this.listeners = new Map(); if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); },
      dispatch(name, event) { (this.listeners && this.listeners.get(name) || []).forEach((fn) => fn(event || { target: this, preventDefault() {} })); },
      append(...items) { items.forEach((item) => this.appendChild(item)); },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      get firstChild() { return this.children[0] || null; },
      removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); return child; },
      remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
    });
    const getNode = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };
    const context = {
      window: { desktopApp: { log: () => {}, ensureGroup: async () => ({ key: 'page', label: 'Page', icon: '', color: '#123456', type: 'web' }) } },
      document: { getElementById: getNode, createElement: () => makeNode('created'), addEventListener() {} },
      console, URL, JSON, Math, Object, Array, String, Number, RegExp, Set, Map, Promise,
    };
    vm.runInNewContext(source('state.js'), context);
    vm.runInNewContext(`
      groups = [];
      function renderSidebar() {}
      function expandGroup() {}
      function selectSite(site) { currentSiteId = site.id; }
    `, context);
    vm.runInNewContext(source('page.js'), context);
    vm.runInNewContext('bindPageActions()', context);
    return { context, getNode };
  })();

  const submit = async (input) => {
    getNode('openPageBtn').dispatch('click');
    getNode('pageUrlInput').value = input;
    getNode('pageForm').dispatch('submit', { preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await submit('web.test/a');
  await submit('web.test/a');
  await submit('web.test/a');
  const names = JSON.parse(vm.runInNewContext('JSON.stringify(groups[0].sites.map((site) => site.name))', context));
  assert.deepEqual(names, ['web.test', 'web.test-1', 'web.test-2']);
  await submit('other.test/');
  assert.equal(vm.runInNewContext('groups[0].sites[groups[0].sites.length - 1].name', context), 'other.test');
});

test('scheduler: hides the current-page request list when no page is open', async () => {
  const calls = [];
  const { context, getNode } = dialogContext(() => ({
    log: () => {},
    schedulerList: async () => ({ ok: true, tasks: [], dir: '/tmp/tasks' }),
    schedulerRuns: async () => ({ ok: true, items: [], total: 0 }),
    apiToolList: async (label, keyword) => { calls.push([label, keyword]); return { ok: true, items: [], total: 0 }; },
  }), ['scheduler.js']);
  vm.runInNewContext('groups = []; currentSiteId = null; bindSchedulerActions();', context);
  getNode('schedulerBtn').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getNode('schedPageLogSection').hidden, true, '没有打开的页面时隐藏整块');
  assert.equal(calls.length, 0, '不发起请求');

  // 有页面时展示并拉列表
  vm.runInNewContext(`
    groups = [{ key: 'g1', label: 'G1', icon: '', color: '#111111', type: 'web', sites: [
      { id: 'g1-0', groupKey: 'g1', type: 'web', name: 'A', url: 'https://a.test/' }] }];
    currentSiteId = 'g1-0';
    webviews['g1-0'] = { label: 'view-1' };
  `, context);
  getNode('schedulerBtn').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getNode('schedPageLogSection').hidden, false);
  assert.deepEqual(calls[0], ['view-1', '']);
});

test('scheduler: page-group (dynamic) tab also loads its request list', async () => {
  const pageLog = { ok: true, total: 2, dir: '/home/u/.my_devops/logs/page/admin.test',
    items: [
      { time: 1, method: 'GET', url: 'https://admin.test/api/list', statusCode: 200, requestHeaders: { Authorization: 'Bearer t' }, requestBody: '' },
      { time: 2, method: 'POST', url: 'https://admin.test/api/report', statusCode: 200, requestHeaders: {}, requestBody: '{}' },
    ] };
  const calls = [];
  const { context, getNode } = dialogContext(() => ({
    log: () => {},
    schedulerList: async () => ({ ok: true, tasks: [], dir: '/tmp/tasks' }),
    schedulerRuns: async () => ({ ok: true, items: [], total: 0 }),
    apiToolList: async (label, keyword) => { calls.push([label, keyword]); return pageLog; },
  }), ['scheduler.js']);
  vm.runInNewContext(`
    groups = [{ key: 'page', label: 'Page', icon: '', color: '#64748b', type: 'web', sites: [
      { id: 'page-dyn-1', groupKey: 'page', type: 'web', name: 'admin.test', url: 'https://admin.test/', isDynamic: true }] }];
    currentSiteId = 'page-dyn-1';
    webviews['page-dyn-1'] = { label: 'view-dyn-1' };
    bindSchedulerActions();
  `, context);
  getNode('schedulerDialog').hidden = true;
  getNode('schedulerBtn').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(getNode('schedPageLogSection').hidden, false);
  assert.deepEqual(calls[0], ['view-dyn-1', '']);
  const rows = getNode('schedPageLogList').children;
  assert.equal(rows.length, 2);
  rows[0].dispatch('click', {});
  assert.equal(getNode('schedUrl').value, 'https://admin.test/api/list');
  assert.match(getNode('schedHeaders').value, /Authorization/);
});

test('scheduler: shows the backend reason when the tab has no log file yet', async () => {
  const { context, getNode } = dialogContext(() => ({
    log: () => {},
    schedulerList: async () => ({ ok: true, tasks: [], dir: '/tmp/tasks' }),
    schedulerRuns: async () => ({ ok: true, items: [], total: 0 }),
    apiToolList: async () => ({ ok: false, error: '当前标签没有可用的日志文件' }),
  }), ['scheduler.js']);
  vm.runInNewContext(`
    groups = [{ key: 'g1', label: 'G1', icon: '', color: '#111111', type: 'web', sites: [
      { id: 'g1-0', groupKey: 'g1', type: 'web', name: 'A', url: 'https://a.test/' }] }];
    currentSiteId = 'g1-0';
    webviews['g1-0'] = { label: 'view-1' };
    bindSchedulerActions();
  `, context);
  getNode('schedulerDialog').hidden = true;
  getNode('schedulerBtn').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(getNode('schedPageLogList').textContent, /没有可用的日志文件/);
});
