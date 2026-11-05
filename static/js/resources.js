/* ============================================================
   resources.js —— 素材分发页的交互
   ------------------------------------------------------------
   · 分类筛选（按钮 + URL hash，便于直接分享某一类）
   · 点卡片开灯箱看大图 / 听不出声音的 MIDI 看详情
   · 「复制署名」按 CC BY 4.0 的格式生成一条可直接粘的署名
   · 图片加载失败时在卡片里写清楚原因（多数是新文件还没被 CDN 缓存）

   数据全在 DOM 的 data-* 上（模板 templates/_shortcodes/resources.html 填的），
   这里不硬编码任何素材信息。
   ============================================================ */
(function () {
  'use strict';

  var root = document.querySelector('.res');
  if (!root) return;

  var CDN = root.getAttribute('data-cdn') || '';
  /* 备用镜像（data-mirrors 是 | 分隔的一串根地址）：主 CDN 取不到时按顺序试。
     换 CDN 的原因见 data/resources.toml 的注释。 */
  var SOURCES = [CDN].concat((root.getAttribute('data-mirrors') || '').split('|')).filter(Boolean);
  var REPO = root.getAttribute('data-repo') || '';
  var AUTHOR = root.getAttribute('data-author') || '';
  var LICENSE = root.getAttribute('data-license') || '';

  /* ---------- 复制 ---------- */
  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallback(text); });
    } else {
      fallback(text);
    }
    function fallback(t) {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  function creditFor(file, title) {
    var name = String(file || '').split('/').pop();
    return '素材：' + (name || title) + ' — ' + AUTHOR + '\n' +
      '来源：' + REPO + '\n' +
      '许可：' + LICENSE + '（https://creativecommons.org/licenses/by/4.0/）';
  }

  /* 顶部那张「署名条子」：点了复制通用模板 */
  var creditBtn = root.querySelector('[data-res-credit]');
  if (creditBtn) {
    creditBtn.addEventListener('click', function () {
      copyText(creditFor('<文件名>', ''));
      creditBtn.classList.add('is-copied');
      var old = creditBtn.textContent;
      creditBtn.textContent = '已复制 ✓';
      setTimeout(function () { creditBtn.textContent = old; creditBtn.classList.remove('is-copied'); }, 1600);
    });
  }

  /* ---------- 图片加载失败：写清楚原因，别只留一片空白 ---------- */
  function srcAt(i, file) { return (SOURCES[i] || '') + file; }

  Array.prototype.forEach.call(root.querySelectorAll('[data-res-img]'), function (img) {
    var file = img.getAttribute('data-file') || '';
    var i = 0;
    img.addEventListener('error', function () {
      /* 依次换镜像；全试完了才认输 */
      if (i < SOURCES.length - 1) {
        i += 1;
        img.src = srcAt(i, file);
        return;
      }
      var box = img.parentNode;
      if (!box || box.querySelector('.res-broken')) return;
      img.style.display = 'none';
      var tip = document.createElement('span');
      tip.className = 'res-broken';
      tip.textContent = '预览加载失败';
      tip.title = '几个镜像都取不到。可能是文件刚上传、CDN 还没缓存；过几分钟刷新，或者直接点「下载」。';
      box.appendChild(tip);
    });
  });

  /* ---------- 分类筛选 ---------- */
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.res-tab'));
  var secs = Array.prototype.slice.call(root.querySelectorAll('.res-sec'));

  function applyFilter(sec, updateHash) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-sec') === sec;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    secs.forEach(function (s) {
      s.hidden = sec !== 'all' && s.getAttribute('data-sec') !== sec;
    });
    if (updateHash) {
      if (sec === 'all') {
        history.replaceState(null, '', location.pathname + location.search);
      } else {
        history.replaceState(null, '', '#' + sec);
      }
    }
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      applyFilter(t.getAttribute('data-sec'), true);
    });
  });

  /* 直接带 #sprite 进来（或者从别处链接过来）就先筛好 */
  var hash = (location.hash || '').replace('#', '');
  if (hash && tabs.some(function (t) { return t.getAttribute('data-sec') === hash; })) {
    applyFilter(hash, false);
  }

  /* ---------- 灯箱 ---------- */
  var lb = document.getElementById('resLb');
  if (!lb) return;
  var lbImg = lb.querySelector('[data-res-lb-img]');
  var lbAudio = lb.querySelector('.res-lb-audio');
  var lbTitle = lb.querySelector('[data-res-lb-title]');
  var lbMeta = lb.querySelector('[data-res-lb-meta]');
  var lbNote = lb.querySelector('[data-res-lb-note]');
  var lbDl = lb.querySelector('[data-res-lb-dl]');
  var lbCredit = lb.querySelector('[data-res-lb-credit]');
  var lastFocus = null;
  var current = null;

  function openLb(card) {
    current = card;
    lastFocus = document.activeElement;
    var kind = card.getAttribute('data-kind') || 'image';
    var file = card.getAttribute('data-file') || '';
    var dl = card.getAttribute('data-dl') || '';

    lbTitle.textContent = card.getAttribute('data-title') || '';
    lbMeta.textContent = card.getAttribute('data-meta') || '';
    var note = card.getAttribute('data-note') || '';
    lbNote.textContent = note;
    lbNote.hidden = !note;
    lbDl.setAttribute('href', dl);

    if (kind === 'audio') {
      lbImg.removeAttribute('src');
      lbImg.hidden = true;
      lbAudio.hidden = false;
    } else {
      lbImg.hidden = false;
      lbAudio.hidden = true;
      lbImg.setAttribute('src', CDN + file);
      var mi = 0;
      lbImg.onerror = function () {
        if (mi < SOURCES.length - 1) { mi += 1; lbImg.src = srcAt(mi, file); }
      };
      lbImg.setAttribute('alt', card.getAttribute('data-title') || '');
    }

    lbCredit.textContent = creditFor(file, card.getAttribute('data-title') || '');
    lb.hidden = false;
    document.body.classList.add('res-lb-open');
    lb.querySelector('[data-res-close]').focus();
  }

  function closeLb() {
    lb.hidden = true;
    document.body.classList.remove('res-lb-open');
    lbImg.removeAttribute('src');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  Array.prototype.forEach.call(root.querySelectorAll('.res-card'), function (card) {
    card.addEventListener('click', function (e) {
      /* 卡片里的「下载」按钮点自己就好，别顺手开灯箱 */
      if (e.target.closest('a[download], .res-btn')) return;
      openLb(card);
    });
  });

  Array.prototype.forEach.call(lb.querySelectorAll('[data-res-close]'), function (b) {
    b.addEventListener('click', closeLb);
  });
  lb.addEventListener('click', function (e) {
    if (e.target === lb) closeLb();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !lb.hidden) closeLb();
  });

  var copyBtn = lb.querySelector('[data-res-copy]');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      if (!current) return;
      copyText(creditFor(current.getAttribute('data-file') || '', current.getAttribute('data-title') || ''));
      var old = copyBtn.textContent;
      copyBtn.textContent = '已复制 ✓';
      setTimeout(function () { copyBtn.textContent = old; }, 1600);
    });
  }
})();
