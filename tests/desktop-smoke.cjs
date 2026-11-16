'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const binary = process.env.DEVOPS_TAURI_BINARY || path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/debug/devops-tools-tauri.exe');
const runDir = path.join(root, 'tests', '.smoke-' + Date.now());
fs.mkdirSync(runDir, { recursive: true });
let child;
const sessions = new Map();
const postCounts = {};
const popupRequests = new Set();
let basicSucceeded = false;
const secret = 'canary-query-secret';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const type = url.pathname.split('/')[1];
  if (url.pathname.endsWith('/popup') && String(req.headers.cookie || '').includes(type + '=ok')) popupRequests.add(type);
  if (type === 'api') {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}'); return;
  }
  if (type === 'basic') {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture:fixture-pass').toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tauri fixture"' }); res.end('Authentication required'); return;
    }
    basicSucceeded = true;
    res.end('<html><body><h1 id="basic-ok">Basic authentication succeeded</h1></body></html>'); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.method === 'POST') {
    const form = new URLSearchParams(body);
    if (form.get('username') !== 'fixture' || form.get('password') !== 'fixture-pass') { res.writeHead(403); res.end('Invalid fixture credentials'); return; }
    postCounts[type] = (postCounts[type] || 0) + 1;
    sessions.set(type, true);
    res.writeHead(303, { location: '/' + type + '/home', 'set-cookie': type + '=ok;' + (type === 'sprt' ? '' : ' Max-Age=3600;') + ' Path=/' + type + '; HttpOnly; SameSite=Lax' }); res.end(); return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'");
  if (!String(req.headers.cookie || '').includes(type + '=ok')) {
    if (!url.pathname.endsWith('/login/')) { res.writeHead(302,{location:'/' + type + '/login/'}); res.end(); return; }
    res.end('<html><body><form method="POST"><label>Username<input id="username" name="username" autocomplete="username"></label><label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label><button type="submit">登录</button></form></body></html>');
  } else {
    res.end('<html><body><nav class="ant-menu">Fixture menu</nav><main class="ant-layout"><h1 id="logged-in">Fixture authenticated ' + type + '</h1>' + '<div>Fixture application content</div>'.repeat(16) + '</main><script>fetch("/api/check?token=' + secret + '");</script></body></html>');
  }
});

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url); this.pending = new Map(); this.counter = 0;
    this.ready = new Promise((resolve,reject) => { this.socket.addEventListener('open',resolve,{once:true}); this.socket.addEventListener('error',reject,{once:true}); });
    this.socket.addEventListener('message', ({data}) => { const message = JSON.parse(String(data)); const p = this.pending.get(message.id); if (p) { this.pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); } });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.counter;
    const promise = new Promise((resolve,reject) => this.pending.set(id,{resolve,reject}));
    this.socket.send(JSON.stringify({id,method,params}));
    return Promise.race([promise, delay(15000).then(() => { throw new Error('CDP timeout: ' + method); })]);
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.result.description);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function until(fn, label, timeout = 25000) {
  const stop = Date.now() + timeout;
  let last;
  while (Date.now() < stop) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(200);
  }
  throw new Error(label + ' timed out' + (last ? ': ' + last.message : ''));
}
async function targets(port) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list');
  return response.json();
}
async function launch(configPath, dataDir, debugPort) {
  const log = fs.openSync(path.join(runDir,'app-' + debugPort + '.log'),'a');
  child = spawn(binary, [], {stdio:['ignore',log,log], env:{...process.env,DEVOPS_CONFIG_PATH:configPath,DEVOPS_TAURI_DATA_DIR:dataDir,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=' + debugPort}});
  fs.closeSync(log);
  child.on('error',(error) => console.error('App spawn:',error.message));
  const target = await until(async () => (await targets(debugPort)).find((t) => /tauri\.localhost|tauri:\/\/localhost/.test(t.url)), 'shell debugger');
  const shell = new CDP(target.webSocketDebuggerUrl);
  await shell.ready;
  return shell;
}
async function stopApp() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit',resolve)),delay(4000)]);
  child = null;
}

(async () => {
  assert.ok(fs.existsSync(binary), 'Build the debug binary before running smoke tests');
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const configPath = path.join(runDir,'config.json');
  const dataDir = path.join(runDir,'data');
  const config = {default_expand:'all', devops_config:[{group:'fixture',items:[
    ...['sprt','grafana','redisinsight','yapi','bytebase'].map((type) => ({name:type,type,url:origin + '/' + type + '/',user:'fixture',password:'fixture-pass'})),
    {name:'basic',type:'web',url:origin + '/basic/',user:'fixture',password:'fixture-pass'},
    {name:'offline',type:'web',url:'http://127.0.0.1:1/'}
  ]}]};
  const configText = JSON.stringify(config,null,2);
  fs.writeFileSync(configPath,configText);
  const debugPort = 19220 + Math.floor(Math.random() * 200);
  let shell = await launch(configPath,dataDir,debugPort);
  await until(() => shell.evaluate('groups.length===1 && document.querySelectorAll(".site-btn").length===7'), 'bootstrap');
  assert.equal(await shell.evaluate('Object.keys(webviews).length'),0);
  console.log('PASS bootstrap, defaults, lazy site opening');
  await shell.evaluate('groups[0].sites.slice(0,6).forEach(s=>selectSite(s)); true');
  await until(() => ['sprt','grafana','redisinsight','yapi','bytebase'].every((key) => sessions.has(key)) && basicSucceeded,'five form login strategies + BasicAuth',40000);
  console.log('PASS Superset/Grafana/RedisInsight/YApi/Bytebase login and HTTP BasicAuth');
  await until(() => shell.evaluate('groups[0].sites.slice(0,5).every(s=>siteStatus[s.id]==="ok")'),'login state');
  const viewLabel = await shell.evaluate('selectSite(groups[0].sites[0]); webviews["fixture-0"].label');
  await until(() => shell.evaluate('webviews["fixture-0"].executeJavaScript(' + JSON.stringify('document.querySelector("#logged-in")?.textContent') + ').then(Boolean)'),'native script result');
  await shell.evaluate('webviews["fixture-0"].executeJavaScript(' + JSON.stringify('(()=>{history.pushState({},"","/sprt/home#spa");return true})()') + ')');
  await until(() => shell.evaluate('webviews["fixture-0"].getURL().includes("#spa")'),'SPA URL event');
  const count = postCounts.sprt;
  await shell.evaluate('selectSite(groups[0].sites[1]); selectSite(groups[0].sites[0]); cloneSite(groups[0].sites[0]); true');
  await until(() => shell.evaluate('clonedSites.length===1 && webviews[clonedSites[0].id]._created'),'clone native view');
  assert.equal(postCounts.sprt,count);
  console.log('PASS switching, same profile, SPA URL, clone creation');
  const originalBounds = await shell.evaluate('webviews[currentSiteId].getBounds()');
  await shell.evaluate('sidebar.classList.add("collapsed"); true');
  await until(() => shell.evaluate('webviews[currentSiteId].getBounds().x < ' + originalBounds.x),'sidebar layout');
  const inspectActive = () => shell.evaluate('window.desktopApp.invoke("inspect_view",{label:webviews[currentSiteId].label})');
  await until(async () => (await inspectActive()).visible, 'active native view visible');
  const beforeMenu = await inspectActive();
  const colorScript = '(()=>{document.documentElement.style.backgroundColor="rgb(18,90,130)";document.body.style.backgroundColor="rgb(18,90,130)";return true})()';
  await shell.evaluate('webviews[currentSiteId].executeJavaScript(' + JSON.stringify(colorScript) + ')');
  let menuCapture = 0;
  const sendMenuKeys = (keys) => {
    const evidence = path.join(runDir,'native-menu-' + (++menuCapture) + '.png');
    const result = spawnSync('pwsh', ['-NoProfile','-File',path.join(__dirname,'windows-menu-input.ps1'),'-ApplicationPid',String(child.pid),'-Keys',keys,'-EvidencePath',evidence], {stdio:'inherit',windowsHide:true});
    assert.equal(result.status,0,'native menu keyboard interaction and visible site pixels');
  };
  sendMenuKeys('FOCUS');
  for (const open of ['showTabContextMenu(300,100,findSiteById(currentSiteId))','showSiteContextMenu(50,200,groups[0].sites[0])','showTabContextMenu(300,100,null)']) {
    await shell.evaluate('window.__menuPending=' + open + ';true');
    await delay(400);
    sendMenuKeys('{ESC}');
    await shell.evaluate('window.__menuPending');
    const afterMenu = await inspectActive();
    assert.equal(afterMenu.visible,true);
    assert.deepEqual(afterMenu.bounds,beforeMenu.bounds,'menu must not resize the site');
    assert.equal(await shell.evaluate('document.querySelector(".ctx-menu")===null'),true);
  }
  console.log('PASS native tab/site/blank menus and cancel keep WebView2 visible');
  const remoteInvoke = '(()=>{window.__hostAccess="pending";window.__TAURI__.core.invoke("desktop",{op:"bootstrap",args:{}}).then(()=>window.__hostAccess="allowed",()=>window.__hostAccess="blocked");return true})()';
  await shell.evaluate('webviews["fixture-0"].executeJavaScript(' + JSON.stringify(remoteInvoke) + ')');
  await until(() => shell.evaluate('webviews["fixture-0"].executeJavaScript("window.__hostAccess").then(x=>x===\"blocked\")'), 'remote invocation rejected');
  console.log('PASS remote guest cannot invoke host command');
  await shell.evaluate('webviews["fixture-0"].executeJavaScript(' + JSON.stringify('(()=>{window.__fixturePopup=window.open("/sprt/popup","_blank");return Boolean(window.__fixturePopup)})()') + ')');
  await until(() => popupRequests.has('sprt'), 'native popup shares cookies');
  assert.equal(await shell.evaluate('webviews["fixture-0"].getURL().includes("#spa")'),true);
  await shell.evaluate('webviews["fixture-0"].executeJavaScript(' + JSON.stringify('(()=>{window.__fixturePopup.close();return true})()') + ')');
  await shell.evaluate('webviews["fixture-4"].executeJavaScript(' + JSON.stringify('(()=>{window.open("/bytebase/popup","_blank");return true})()') + ')');
  await until(() => shell.evaluate('webviews["fixture-4"].getURL().includes("/bytebase/popup")'), 'Bytebase popup navigates existing tab');
  console.log('PASS native popup profile and Bytebase same-tab popup routing');
  await shell.evaluate('selectSite(groups[0].sites[6]); true');
  await until(() => shell.evaluate('document.querySelectorAll(".toast").length>0'),'main-frame failure toast');
  assert.equal((await inspectActive()).visible,true,'toast must not hide the native view');
  assert.equal(await shell.evaluate('document.getElementById("toastContainer").parentElement.id'), 'content');
  await shell.evaluate('closeTab(groups[0].sites[6]); document.querySelectorAll(".toast").forEach(t=>t.remove()); selectSite(groups[0].sites[0]); true');
  await until(() => fs.existsSync(path.join(dataDir,'devops_state.json')),'state persistence');
  await delay(800);
  const saved = fs.readFileSync(path.join(dataDir,'devops_state.json'),'utf8');
  assert.ok(!saved.includes('fixture-pass'));
  assert.equal(fs.readFileSync(configPath,'utf8'),configText);
  const logRoot = path.join(dataDir,'logs');
  const logs = fs.readdirSync(logRoot).map((dir) => path.join(logRoot,dir,'requests.log')).filter(fs.existsSync).map((file) => fs.readFileSync(file,'utf8')).join('\n');
  assert.ok(logs.includes('"event":"request"') && logs.includes('"event":"completed"'));
  // 响应体异步采集应写入独立记录，且不超过配置上限或泄露敏感值。
  assert.ok(logs.includes('"event":"responseBody"') && logs.includes('\\"ok\\":true'), 'response body must be recorded');
  assert.ok(!logs.includes(secret) && !logs.includes('fixture-pass'));
  console.log('PASS load failure, state secrecy, config unchanged, native request lifecycle and URL redaction');
  shell.close(); await stopApp();
  shell = await launch(configPath,dataDir,debugPort+1);
  await until(() => shell.evaluate('Object.keys(webviews).length===7 && clonedSites.length===1'),'restored tabs',30000);
  assert.equal(postCounts.sprt,count);
  console.log('PASS restart restores tabs and persistent WebView2 login cookie');
  await shell.evaluate('closeAllTabs(); true');
  await until(() => shell.evaluate('Object.keys(webviews).length===0'),'close all');
  shell.close(); await stopApp();
  fs.writeFileSync(configPath,'{ invalid json');
  shell = await launch(configPath,path.join(runDir,'invalid-data'),debugPort+2);
  await until(() => shell.evaluate('document.querySelector(".placeholder-card").textContent.includes("配置加载失败")'),'invalid config message');
  shell.close(); await stopApp();
  console.log('PASS malformed config visible error');
  console.log('Smoke evidence: ' + runDir);
})().catch((error) => {console.error(error.stack); process.exitCode=1;}).finally(async () => { await stopApp(); server.close(); });
