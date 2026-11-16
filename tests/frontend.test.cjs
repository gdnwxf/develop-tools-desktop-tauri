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
