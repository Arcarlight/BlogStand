/* ============================================================
   画廊的「点开看大图」弹层

   设计取舍（都是这个站上的老规矩）：
   1) 不引任何库。几十行原生 JS，断网也能用。
   2) 大图是**点开那一刻才加载**的：缩略图上不让 <img> 指向原图，
      否则浏览器可能顺手把几十 MB 原图也拉下来，缩略图就白做了。
   3) 关掉时把 <img> 的 src 清掉，避免退回页面后还在后台占内存。
   4) 键盘可用：Esc 关、← → 翻页；焦点落在弹层上，Tab 不会跑到后面去。
   ============================================================ */
(function () {
  'use strict';

  var overlay = null;
  var items = [];
  var idx = 0;
  var lastFocus = null;

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'gal-lb';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '画作大图');
    overlay.innerHTML =
      '<div class="gal-lb-inner">' +
      '  <button type="button" class="gal-lb-close" aria-label="关闭">×</button>' +
      '  <button type="button" class="gal-lb-prev" aria-label="上一张">‹</button>' +
      '  <button type="button" class="gal-lb-next" aria-label="下一张">›</button>' +
      '  <figure class="gal-lb-fig">' +
      '    <img class="gal-lb-img" alt="">' +
      '    <figcaption class="gal-lb-cap"><span class="gal-lb-title"></span>' +
      '      <span class="gal-lb-date"></span>' +
      '      <span class="gal-lb-count"></span></figcaption>' +
      '  </figure>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) {
      var t = e.target;
      if (t === overlay || t.classList.contains('gal-lb-inner') || t.classList.contains('gal-lb-close')) {
        close();
      } else if (t.classList.contains('gal-lb-prev')) {
        step(-1);
      } else if (t.classList.contains('gal-lb-next')) {
        step(1);
      }
    });
    // 点图片本身不关（很多人就是想再仔细看看）
    document.addEventListener('keydown', function (e) {
      if (overlay.hidden) return;
      if (e.key === 'Escape') { close(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
      else if (e.key === 'Tab') { keepFocusIn(e); }
    });
  }

  function keepFocusIn(e) {
    var focusables = overlay.querySelectorAll('button');
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }

  function show(i) {
    if (!items.length) return;
    idx = (i + items.length) % items.length;
    var it = items[idx];
    var img = overlay.querySelector('.gal-lb-img');
    img.src = it.full;                       // 到这一刻才请求原图
    img.alt = it.title || '';
    overlay.querySelector('.gal-lb-title').textContent = it.title || '';
    var d = overlay.querySelector('.gal-lb-date');
    d.textContent = it.date ? '（' + it.date + '）' : '';
    overlay.querySelector('.gal-lb-count').textContent =
      items.length > 1 ? (idx + 1) + ' / ' + items.length : '';
    overlay.querySelector('.gal-lb-prev').hidden = items.length < 2;
    overlay.querySelector('.gal-lb-next').hidden = items.length < 2;
  }

  function step(d) { show(idx + d); }

  function open(list, i) {
    items = list;
    if (!overlay) build();
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.documentElement.classList.add('gal-lb-open');
    show(i);
    overlay.querySelector('.gal-lb-close').focus();
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.documentElement.classList.remove('gal-lb-open');
    var img = overlay.querySelector('.gal-lb-img');
    img.removeAttribute('src');               // 放掉大图
    img.alt = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function init() {
    var links = [].slice.call(document.querySelectorAll('.gal-link'));
    if (!links.length) return;
    var list = links.map(function (a) {
      return {
        full: a.getAttribute('data-full') || a.getAttribute('href'),
        title: a.getAttribute('data-title') || '',
        date: a.getAttribute('data-date') || ''
      };
    });
    links.forEach(function (a, i) {
      a.addEventListener('click', function (e) {
        // 中键 / Ctrl 点击还是按老规矩开新标签页，别抢用户的选择
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(list, i);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
