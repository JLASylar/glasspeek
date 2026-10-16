'use strict';

(() => {
  const frameKind = window.top === window ? 'top' : 'subframe';
  document.documentElement.dataset.glasspeekAllFramesProbe = 'injected';
  document.documentElement.dataset.glasspeekProbeFrameKind = frameKind;

  function mountVisibleMarker() {
    if (!document.body || document.getElementById('glasspeek-all-frames-probe')) return;
    const marker = document.createElement('div');
    marker.id = 'glasspeek-all-frames-probe';
    marker.textContent = `all_frames probe: ${frameKind}`;
    marker.setAttribute('aria-label', 'GlassPeek all-frames compatibility probe');
    Object.assign(marker.style, {
      position: 'fixed',
      zIndex: '2147483647',
      top: '10px',
      right: '10px',
      padding: '7px 10px',
      border: '2px solid #7c3aed',
      borderRadius: '999px',
      background: '#ffffff',
      color: '#3b0764',
      font: '700 12px/1.2 system-ui, sans-serif',
      boxShadow: '0 4px 14px rgba(59, 7, 100, 0.28)',
      pointerEvents: 'none'
    });
    document.body.append(marker);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountVisibleMarker, { once: true });
  } else {
    mountVisibleMarker();
  }
})();
