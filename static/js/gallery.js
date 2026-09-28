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

  /* 按钮里的符号用**内联 SVG**，不用 ‹ › × 这些字符。
     为什么：站上开了点阵字体，而 ‹(U+2039) ›(U+203A) ×(U+00D7) 这几个字符
     在点阵字库里没有字形 —— 结果按钮只剩一个空框（站长截图报的就是这个）。
     图标取自 HackerNoon Pixel Icon Library 的 regular 系列（CC BY 4.0）：
     angle-left / angle-right，关闭用的是 window-close 中间那个叉。 */
  var ICON = {
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="11 13 12 13 12 14 13 14 13 15 14 15 14 16 15 16 15 17 16 17 16 18 17 18 17 19 16 19 16 20 15 20 15 19 14 19 14 18 13 18 13 17 12 17 12 16 11 16 11 15 10 15 10 14 9 14 9 13 8 13 8 11 9 11 9 10 10 10 10 9 11 9 11 8 12 8 12 7 13 7 13 6 14 6 14 5 15 5 15 4 16 4 16 5 17 5 17 6 16 6 16 7 15 7 15 8 14 8 14 9 13 9 13 10 12 10 12 11 11 11 11 13"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="16 11 16 13 15 13 15 14 14 14 14 15 13 15 13 16 12 16 12 17 11 17 11 18 10 18 10 19 9 19 9 20 8 20 8 19 7 19 7 18 8 18 8 17 9 17 9 16 10 16 10 15 11 15 11 14 12 14 12 13 13 13 13 11 12 11 12 10 11 10 11 9 10 9 10 8 9 8 9 7 8 7 8 6 7 6 7 5 8 5 8 4 9 4 9 5 10 5 10 6 11 6 11 7 12 7 12 8 13 8 13 9 14 9 14 10 15 10 15 11 16 11"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="15 13 16 13 16 14 17 14 17 15 18 15 18 16 17 16 17 17 16 17 16 18 15 18 15 17 14 17 14 16 13 16 13 15 11 15 11 16 10 16 10 17 9 17 9 18 8 18 8 17 7 17 7 16 6 16 6 15 7 15 7 14 8 14 8 13 9 13 9 11 8 11 8 10 7 10 7 9 6 9 6 8 7 8 7 7 8 7 8 6 9 6 9 7 10 7 10 8 11 8 11 9 13 9 13 8 14 8 14 7 15 7 15 6 16 6 16 7 17 7 17 8 18 8 18 9 17 9 17 10 16 10 16 11 15 11 15 13"/></svg>'
  };

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'gal-lb';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '画作大图');
    overlay.innerHTML =
      '<div class="gal-lb-inner">' +
      '  <button type="button" class="gal-lb-close" aria-label="关闭">' + ICON.close + '</button>' +
      '  <button type="button" class="gal-lb-prev" aria-label="上一张" title="上一张（←）">' + ICON.prev + '</button>' +
      '  <button type="button" class="gal-lb-next" aria-label="下一张" title="下一张（→）">' + ICON.next + '</button>' +
      '  <figure class="gal-lb-fig">' +
      '    <img class="gal-lb-img" alt="">' +
      '    <figcaption class="gal-lb-cap"><span class="gal-lb-title"></span>' +
      '      <span class="gal-lb-date"></span>' +
      '      <span class="gal-lb-count"></span></figcaption>' +
      '    <p class="gal-lb-desc" hidden></p>' +
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
    var ds = overlay.querySelector('.gal-lb-desc');
    ds.textContent = it.desc || '';
    ds.hidden = !it.desc;
    overlay.querySelector('.gal-lb-count').textContent =
      items.length > 1 ? (idx + 1) + ' / ' + items.length : '';
    overlay.querySelector('.gal-lb-prev').hidden = items.length < 2;
    overlay.querySelector('.gal-lb-next').hidden = items.length < 2;
  }

  function step(d) { show(idx + d); }

  function open(list, i) {
    items = list;
    if (!overlay) build();
    hideCard();                              // 悬浮卡别挡着弹层
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
    var ds = overlay.querySelector('.gal-lb-desc');
    ds.textContent = '';
    ds.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function init() {
    var links = [].slice.call(document.querySelectorAll('.gal-link'));
    if (!links.length) return;
    var list = links.map(function (a) {
      return {
        full: a.getAttribute('data-full') || a.getAttribute('href'),
        title: a.getAttribute('data-title') || '',
        date: a.getAttribute('data-date') || '',
        desc: a.getAttribute('data-desc') || ''
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

    /* ---- 悬浮预览：鼠标停在缩略图上，旁边浮出「大一点的图 + 简介」 ----
       用缩略图而不是原图：缩略图早就在缓存里了，悬浮是即时反应；
       真想看原图点一下（弹层那一刻才拉原图）。
       触屏没有 hover，那边走点击弹层，不受影响。 */
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
      links.forEach(function (a) {
        a.addEventListener('mouseenter', function (e) { showCard(a, e); });
        a.addEventListener('mousemove', moveCard);
        a.addEventListener('mouseleave', hideCard);
        a.addEventListener('click', hideCard);
      });
      window.addEventListener('scroll', hideCard, { passive: true });
    }
  }

  var card = null, cardImg = null, cardTitle = null, cardDesc = null;

  function buildCard() {
    card = document.createElement('div');
    card.className = 'gal-card';
    card.hidden = true;
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML = '<img class="gal-card-img" alt="">' +
      '<div class="gal-card-tx"><b class="gal-card-title"></b>' +
      '<span class="gal-card-desc"></span><i class="gal-card-hint">点一下看原图</i></div>';
    document.body.appendChild(card);
    cardImg = card.querySelector('.gal-card-img');
    cardTitle = card.querySelector('.gal-card-title');
    cardDesc = card.querySelector('.gal-card-desc');
  }

  function showCard(a, e) {
    if (!card) buildCard();
    var t = a.getAttribute('data-title') || '';
    var d = a.getAttribute('data-desc') || '';
    var dt = a.getAttribute('data-date') || '';
    var thumb = a.getAttribute('data-thumb') || (a.querySelector('img') || {}).src || '';
    if (cardImg.getAttribute('src') !== thumb) cardImg.setAttribute('src', thumb);
    cardTitle.textContent = t + (dt ? '（' + dt + '）' : '');
    cardDesc.textContent = d;
    cardDesc.hidden = !d;                 // 没有简介就不占位
    card.hidden = false;
    moveCard(e);
  }

  function moveCard(e) {
    if (!card || card.hidden) return;
    var w = card.offsetWidth, h = card.offsetHeight;
    var pad = 14, gap = 18;
    var x = e.clientX + gap, y = e.clientY + gap;
    // 贴到右/下边缘就翻到另一边，别被裁掉
    if (x + w + pad > window.innerWidth) x = e.clientX - w - gap;
    if (y + h + pad > window.innerHeight) y = e.clientY - h - gap;
    card.style.left = Math.max(pad, x) + 'px';
    card.style.top = Math.max(pad, y) + 'px';
  }

  function hideCard() {
    if (card) card.hidden = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
