const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../ui/renderer/menus.js'),'utf8');

function fixture(invoke = async () => true) {
  const calls = [];
  const sites = [{id:'one'},{id:'two'}];
  let listener;
  let subscriptions = 0;
  const context = {
    window: {desktopApp:{invoke},__TAURI__:{event:{listen:async (event,handler) => {
      assert.equal(event,'context-action'); subscriptions++; listener = handler; return () => {};
    }}}},
    findSiteById: (id) => sites.find((site) => site.id===id),
    log: (...args) => calls.push(['log',...args]),
  };
  for (const name of ['closeAllTabs','reloadSite','closeRightTabs','closeLeftTabs','closeOtherTabs','cloneSite','copySiteLink','openSiteLog','openSiteLogFolder','clearSiteLog']) {
    context[name] = (...args) => calls.push([name,...args]);
  }
  vm.runInNewContext(source,context);
  return {context,calls,sites,subscriptions:()=>subscriptions,event:(payload)=>listener({payload})};
}

test('native menu keeps the original target and registers one listener',async()=>{
  const requests = [];
  const env = fixture(async(op,args)=>requests.push(JSON.parse(JSON.stringify({op,args}))));
  await env.context.showTabContextMenu(30,40,env.sites[0]);
  await env.context.showSiteContextMenu(10,20,env.sites[1]);
  await env.context.showTabContextMenu(50,60,null);
  assert.equal(env.subscriptions(),1);
  assert.deepEqual(requests.map(r=>r.args.kind),['tab','site','tab']);
  assert.deepEqual(requests.map(r=>r.args.siteId),['one','two','']);
  assert.ok(requests.every(r=>r.op==='context_menu'));
  env.event({siteId:'one',action:'reload'});
  env.event({siteId:'two',action:'clone'});
  env.event({siteId:'deleted',action:'reload'});
  env.event({siteId:'',action:'close-all'});
  assert.deepEqual(env.calls,[['reloadSite',env.sites[0]],['cloneSite',env.sites[1]],['closeAllTabs']]);
});

test('native menu preserves close, copy and log actions',async()=>{
  const env = fixture();
  await env.context.showTabContextMenu(0,0,env.sites[0]);
  const actions = {'close-right':'closeRightTabs','close-left':'closeLeftTabs','close-other':'closeOtherTabs','copy-link':'copySiteLink','open-log':'openSiteLog','open-log-folder':'openSiteLogFolder','clear-log':'clearSiteLog'};
  for (const action of Object.keys(actions)) env.event({siteId:'two',action});
  assert.deepEqual(env.calls.map(call=>call[0]),Object.values(actions));
  assert.ok(env.calls.every(call=>call[1]===env.sites[1]));
});

test('menu open failure is reported without changing any view',async()=>{
  const env = fixture(async()=>{throw new Error('popup failed')});
  await env.context.showTabContextMenu(0,0,env.sites[0]);
  assert.equal(env.calls.length,1);
  assert.equal(env.calls[0][0],'log');
  assert.match(env.calls[0].join(' '),/popup failed/);
});
