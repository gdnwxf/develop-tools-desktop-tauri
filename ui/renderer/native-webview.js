(function () {
  'use strict';
  const handles = new Map();
  const random = new Uint32Array(4);
  crypto.getRandomValues(random);
  const sessionId = Array.from(random).map((part) => String(part).padStart(10, '0')).join('');
  let sequence = 0;
  let eventsReady;
  const listen = () => {
    if (!eventsReady) {
      eventsReady = Promise.resolve().then(() => {
        if (!window.__TAURI__ || !window.__TAURI__.event) throw new Error('Tauri native-view event API 不可用');
        return window.__TAURI__.event.listen('native-view', ({ payload }) => {
          const handle = payload && handles.get(payload.label);
          if (handle) handle.receiveNativeEvent(payload);
        });
      });
    }
    return eventsReady;
  };
  class TauriWebview extends HTMLElement {
    constructor() {
      super();
      this.label = 'view-' + sessionId + (++sequence);
      this._url = '';
      this._created = false;
      this._closed = false;
      this._queue = Promise.resolve();
      this.ready = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
      this.ready.catch(() => {});
      handles.set(this.label, this);
    }
    connectedCallback() {
      if (this._closed) return;
      if (window.nativeViewLayout) window.nativeViewLayout.observe(this);
    }
    disconnectedCallback() { this.close().catch((error) => this.reportError(error)); }
    enqueue(action) {
      const result = this._queue.then(action);
      this._queue = result.catch(() => {});
      return result;
    }
    getURL() { return this._url; }
    getWebContentsId() { return this.label; }
    getBounds() {
      const rect = this.getBoundingClientRect();
      const x = Math.max(0, rect.left);
      const y = Math.max(0, rect.top);
      return { x, y, width: Math.max(1, Math.min(rect.right, window.innerWidth) - x), height: Math.max(1, Math.min(rect.bottom, window.innerHeight) - y) };
    }
    loadURL(url) {
      if (this._closed) return Promise.reject(new Error('视图已关闭'));
      this._url = url;
      return this.enqueue(async () => {
        if (this._closed) throw new Error('视图已关闭');
        try {
          await listen();
          if (this._closed) throw new Error('视图已关闭');
          if (!this._created) {
            this._url = url;
            await window.desktopApp.invoke('create_view', { label: this.label, siteId: this.dataset.siteId, sourceId: this.dataset.sourceId || '', url, bounds: this.getBounds() });
            this._created = true;
            this._resolveReady(this);
            if (window.nativeViewLayout) window.nativeViewLayout.schedule();
          } else {
            this._url = url;
            await window.desktopApp.invoke('view_action', { label: this.label, action: 'navigate', url });
          }
        } catch (error) {
          if (!this._created) this._rejectReady(error);
          if (!this._closed) this.reportError(error);
          throw error;
        }
      });
    }
    action(action) {
      return this.enqueue(async () => {
        if (this._closed) throw new Error('视图已关闭');
        await this.ready;
        return window.desktopApp.invoke('view_action', { label: this.label, action });
      });
    }
    reload() { return this.action('reload'); }
    stop() { return this.action('stop'); }
    focus() { return this.action('focus'); }
    openDevTools() { return this.action('devtools'); }
    executeJavaScript(script) {
      return this.enqueue(async () => {
        if (this._closed) throw new Error('视图已关闭');
        await this.ready;
        const result = await window.desktopApp.invoke('eval_view', { label: this.label, script });
        if (!result || !result.ok) throw new Error(result && result.error || 'eval_view 执行失败');
        return result.value;
      });
    }
    close() {
      if (this._closePromise) return this._closePromise;
      this._closed = true;
      handles.delete(this.label);
      if (window.nativeViewLayout) window.nativeViewLayout.unobserve(this);
      this._closePromise = this.enqueue(async () => {
        if (this._created) {
          await window.desktopApp.invoke('view_action', { label: this.label, action: 'close' });
          this._created = false;
        } else this._rejectReady(new Error('视图已关闭'));
      });
      return this._closePromise;
    }
    receiveNativeEvent(payload) {
      if (this._closed) return;
      if (payload.url) this._url = payload.url;
      const allowed = ['did-navigate', 'did-navigate-in-page', 'dom-ready', 'focus', 'did-fail-load', 'hook-error', 'auth-error', 'auth-fallback'];
      if (!allowed.includes(payload.event)) return;
      const event = new Event(payload.event);
      if (payload.url) event.url = payload.url;
      event.errorDescription = payload.errorDescription || payload.error || '原生浏览器操作失败';
      if (payload.event === 'did-fail-load') {
        event.isMainFrame = payload.isMainFrame !== false;
        event.errorCode = typeof payload.errorCode === 'number' ? payload.errorCode : -1;
      }
      this.dispatchEvent(event);
    }
    reportError(error) {
      this.receiveNativeEvent({ event: 'did-fail-load', error: error.message });
      console.error('native-view:', this.label, error.message);
    }
  }
  customElements.define('tauri-webview', TauriWebview);
})();
