(function() {
  const resizer = document.getElementById('sidebar-resizer');
  const sidebar = document.getElementById('sidebar');
  let active = false, startX = 0, startW = 0;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:col-resize;display:none;';
  document.body.appendChild(overlay);
  resizer.addEventListener('mousedown', e => {
    active = true; startX = e.clientX; startW = sidebar.getBoundingClientRect().width;
    overlay.style.display = 'block'; e.preventDefault();
  });
  overlay.addEventListener('mousemove', e => {
    if (!active) return;
    sidebar.style.width = Math.min(600, Math.max(200, startW + e.clientX - startX)) + 'px';
  });
  overlay.addEventListener('mouseup', () => { active = false; overlay.style.display = 'none'; });
  overlay.addEventListener('mouseleave', () => { active = false; overlay.style.display = 'none'; });
})();
