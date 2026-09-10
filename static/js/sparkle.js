/* ============================================================
   sparkle.js —— 鼠标跟随的小星星
   这是 2010 年代个人主页的招牌特效，关掉它在 hugo.toml 里
   把 cursorSparkle 设成 false 即可。
   ============================================================ */
(function () {
  'use strict';

  // 尊重系统的"减少动态效果"设置
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  // 触屏设备就免了
  if ('ontouchstart' in window) { return; }

  var CHARS = ['★', '☆', '·', '✿', '＊', '❀'];
  var COLORS = ['#ffd700', '#ff85c1', '#7ec8ff', '#a6ff8f', '#ffb066', '#ffffff'];
  var last = 0;

  document.addEventListener('mousemove', function (e) {
    var now = new Date().getTime();
    if (now - last < 55) { return; }        // 节流，别把 CPU 烧了
    last = now;

    var el = document.createElement('span');
    el.className = 'sparkle';
    el.textContent = CHARS[Math.floor(Math.random() * CHARS.length)];
    el.style.left = e.clientX + 'px';
    el.style.top = e.clientY + 'px';
    el.style.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    el.style.fontSize = (9 + Math.random() * 10).toFixed(1) + 'px';

    document.body.appendChild(el);

    window.setTimeout(function () {
      if (el.parentNode) { el.parentNode.removeChild(el); }
    }, 900);
  }, false);
})();
