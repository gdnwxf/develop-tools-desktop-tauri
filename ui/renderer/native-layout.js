(function () {
  'use strict';
  const views = new Set();
  let frame = null;
  let inFlight = false;
  let dirty = false;
  let lastLayout = '';
  const resize = new ResizeObserver(() => schedule());
  const mutation = new MutationObserver(() => schedule());
  function schedule() {
    dirty = true;
    if (frame === null && !inFlight) frame = requestAnimationFrame(flush);
  }
  async function flush() {
    frame = null;
    if (inFlight) return;
    dirty = false;
    const layout = Array.from(views).filter((view) => view._created && !view._closed).map((view) => {
      const rect = view.getBoundingClientRect();
      const style = getComputedStyle(view);
      return {
        label: view.label,
        visible: view.isConnected && view.classList.contains('active') && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
        bounds: view.getBounds(),
      };
    });
    const signature = JSON.stringify(layout);
    if (signature === lastLayout) return;
    inFlight = true;
    try {
      await window.desktopApp.invoke('layout_views', { views: layout });
      lastLayout = signature;
    } catch (error) {
      console.error('layout_views:', error.message);
    } finally {
      inFlight = false;
      if (dirty) schedule();
    }
  }
  window.nativeViewLayout = {
    schedule,
    observe(view) { views.add(view); resize.observe(view); schedule(); },
    unobserve(view) { views.delete(view); resize.unobserve(view); schedule(); },
  };
  mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  ['sidebar', 'tabBar', 'toastContainer', 'webviewContainer'].forEach((id) => {
    const node = document.getElementById(id);
    if (node) resize.observe(node);
  });
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
})();
