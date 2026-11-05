/* ============================================================
   resources.js —— 素材分发页的交互
   ------------------------------------------------------------
   · 分类筛选（按钮 + URL hash，便于直接分享某一类）
   · 宝可梦图鉴：按世代 / 全国图鉴编号筛选（#gen3 / #dex393 可分享）
   · 行走图预览：把 3 列 × 4 行（下 / 左 / 右 / 上）的精灵表当背景，
     四个方向各 pingpong 两遍循环播；点开看大图才是整张表
   · 「下载这只」：把这只宝可梦的行走图 + 脸图打成一个 zip（纯前端打包）
   · 「复制署名」按 CC BY 4.0 的格式生成一条可直接粘的署名
   · 图片加载失败时在卡片里写清楚原因（多数是新文件还没被 CDN 缓存）

   数据全在 DOM 的 data-* 上（模板 layouts/_shortcodes/resources.html 填的），
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

  function srcAt(i, file) { return (SOURCES[i] || '') + file; }

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
  Array.prototype.forEach.call(root.querySelectorAll('img[data-res-img]'), function (img) {
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

  /* ---------- 世代表（全国图鉴编号区间） ---------- */
  var GENS = [
    [1, '第一世代', 1, 151],
    [2, '第二世代', 152, 251],
    [3, '第三世代', 252, 386],
    [4, '第四世代', 387, 493],
    [5, '第五世代', 494, 649],
    [6, '第六世代', 650, 721],
    [7, '第七世代', 722, 809],
    [8, '第八世代', 810, 905],
    [9, '第九世代', 906, 1025],
  ];
  function genOf(dex) {
    for (var i = 0; i < GENS.length; i += 1) {
      if (dex >= GENS[i][2] && dex <= GENS[i][3]) return GENS[i];
    }
    return null;
  }
  function pad3(n) { n = String(n); while (n.length < 3) n = '0' + n; return n; }

  /* ---------- 宝可梦卡片索引 ---------- */
  var pkCards = Array.prototype.slice.call(root.querySelectorAll('.res-pk'));
  var pk = pkCards.map(function (card) {
    var dex = Number(card.getAttribute('data-dex')) || 0;
    return {
      card: card,
      dex: dex,
      gen: genOf(dex),
      title: card.getAttribute('data-title') || '',
      file: card.getAttribute('data-file') || '',
      face: card.getAttribute('data-face') || '',
    };
  });
  pk.sort(function (a, b) { return a.dex - b.dex; });

  /* ---------- 分类筛选（大分类 tab） ---------- */
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.res-tab'));
  var secs = Array.prototype.slice.call(root.querySelectorAll('.res-sec'));
  var curTab = 'all';
  var deck = { gen: 'all', dex: 'all' };

  function setHash(h) {
    history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  }
  function syncHash() {
    if (deck.dex !== 'all') return setHash('dex' + deck.dex);
    if (deck.gen !== 'all') return setHash('gen' + deck.gen);
    setHash(curTab === 'all' ? '' : curTab);
  }

  function applyTab(sec, updateHash) {
    curTab = sec;
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-sec') === sec;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    secs.forEach(function (s) {
      s.hidden = sec !== 'all' && s.getAttribute('data-sec') !== sec;
    });
    if (updateHash) syncHash();
  }
  /* ---------- 图鉴导航 ---------- */
  var gensBox = root.querySelector('[data-res-gens]');
  var numsBox = root.querySelector('[data-res-nums]');
  var countEl = root.querySelector('[data-res-count]');
  var emptyEl = root.querySelector('[data-res-pk-empty]');

  /* 只列真有素材的世代和编号 —— 空号不占地方 */
  var genList = [];
  (function () {
    var seen = {};
    pk.forEach(function (p) {
      if (!p.gen) return;
      var g = p.gen[0];
      if (!seen[g]) { seen[g] = { gen: p.gen, items: [] }; genList.push(seen[g]); }
      seen[g].items.push(p);
    });
    genList.sort(function (a, b) { return a.gen[0] - b.gen[0]; });
  })();

  function mkBtn(cls, text, attrs) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    Object.keys(attrs || {}).forEach(function (k) { b.setAttribute(k, attrs[k]); });
    return b;
  }

  function renderGens() {
    if (!gensBox) return;
    gensBox.innerHTML = '';
    var all = mkBtn('res-gpill', '全部世代', { 'data-gen': 'all' });
    gensBox.appendChild(all);
    genList.forEach(function (g) {
      var b = mkBtn('res-gpill', g.gen[1], { 'data-gen': String(g.gen[0]) });
      var em = document.createElement('em');
      em.textContent = g.items.length;
      b.appendChild(em);
      gensBox.appendChild(b);
    });
  }

  function renderNums() {
    if (!numsBox) return;
    numsBox.innerHTML = '';
    var list = pk.filter(function (p) { return deck.gen === 'all' || (p.gen && p.gen[0] === deck.gen); });
    numsBox.appendChild(mkBtn('res-nchip is-all', '全部编号', { 'data-dex': 'all' }));
    var seen = {};
    list.forEach(function (p) {
      if (!p.dex) return;
      if (seen[p.dex]) {
        /* 同一编号有好几只（版本差异之类）：一个编号一个按钮就够了，点开都会出来 */
        seen[p.dex].names.push(p.title);
        seen[p.dex].name.textContent = seen[p.dex].names[0] + ' ×' + seen[p.dex].names.length;
        return;
      }
      /* 编号 + 名字：光看 025 不知道是哪只，名字得跟着 */
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'res-nchip';
      b.setAttribute('data-dex', String(p.dex));
      b.title = 'No.' + pad3(p.dex) + ' ' + p.title;
      var num = document.createElement('span');
      num.className = 'res-nnum';
      num.textContent = pad3(p.dex);
      var name = document.createElement('span');
      name.className = 'res-nname';
      name.textContent = p.title;
      b.appendChild(num);
      b.appendChild(name);
      seen[p.dex] = { el: b, name: name, names: [p.title] };
      numsBox.appendChild(b);
    });
    syncNav();
  }

  function syncNav() {
    if (gensBox) {
      Array.prototype.forEach.call(gensBox.children, function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-gen') === String(deck.gen));
      });
    }
    if (numsBox) {
      Array.prototype.forEach.call(numsBox.children, function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-dex') === String(deck.dex));
      });
    }
  }

  /* 世代 / 编号 → 只留对应的卡片 */
  function applyDeck() {
    var shown = 0;
    pk.forEach(function (p) {
      var okGen = deck.gen === 'all' || (p.gen && p.gen[0] === deck.gen);
      var okDex = deck.dex === 'all' || p.dex === deck.dex;
      var on = okGen && okDex;
      p.card.hidden = !on;
      if (on) shown += 1;
    });
    if (countEl) countEl.textContent = '显示 ' + shown + ' / ' + pk.length + ' 只';
    if (emptyEl) emptyEl.hidden = shown > 0;
    syncNav();
  }

  /* 图鉴筛选只在「点阵图 · 脸图」这一页里算数：
     动世代/编号就把那一页切过来，点别的分类就退回「没筛」。 */
  function resetDeck() {
    deck.gen = 'all';
    deck.dex = 'all';
    renderNums();
    applyDeck();
  }

  function pickGen(g, updateHash) {
    applyTab('pokemon', false);
    deck.gen = g;
    deck.dex = 'all';
    renderNums();
    applyDeck();
    if (updateHash) syncHash();
  }
  function pickDex(d, updateHash) {
    applyTab('pokemon', false);
    deck.dex = d;
    if (d !== 'all') {
      /* 点编号时把世代也对上，编号条里那一串才是同一代里的号 */
      var p = pk.filter(function (x) { return x.dex === d; })[0];
      if (p && p.gen && deck.gen !== p.gen[0]) { deck.gen = p.gen[0]; renderNums(); }
    }
    applyDeck();
    if (updateHash) syncHash();
  }

  renderGens();
  renderNums();
  applyDeck();

  if (gensBox) {
    gensBox.addEventListener('click', function (e) {
      var b = e.target.closest('.res-gpill');
      if (b) pickGen(b.getAttribute('data-gen') === 'all' ? 'all' : Number(b.getAttribute('data-gen')), true);
    });
  }
  if (numsBox) {
    numsBox.addEventListener('click', function (e) {
      var b = e.target.closest('.res-nchip');
      if (b) pickDex(b.getAttribute('data-dex') === 'all' ? 'all' : Number(b.getAttribute('data-dex')), true);
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var sec = t.getAttribute('data-sec');
      /* 换到别的分类 = 离开图鉴，把世代/编号筛选清掉，别让「全部」里留着上一个筛选 */
      if (sec !== 'pokemon') resetDeck();
      applyTab(sec, true);
    });
  });

  /* 直接带 hash 进来（#ui / #dex393 / #gen3）就先筛好；
     页面开着的时候改 hash（粘贴链接、手改地址栏）也跟着切，不用刷新。 */
  function applyHash() {
    var hash = (location.hash || '').replace('#', '');
    var m;
    if ((m = /^dex(\d+)$/.exec(hash))) {
      deck.gen = 'all';
      pickDex(Number(m[1]), false);
      return;
    }
    if ((m = /^gen(\d)$/.exec(hash))) {
      pickGen(Number(m[1]), false);
      return;
    }
    if (!hash) {
      pickGen('all', false);
      applyTab('all', false);
      return;
    }
    if (tabs.some(function (t) { return t.getAttribute('data-sec') === hash; })) {
      if (hash !== 'pokemon') resetDeck();
      applyTab(hash, false);
    }
  }
  applyHash();
  window.addEventListener('hashchange', applyHash);

  /* ---------- 行走图预览：四个方向 pingpong 循环 ----------
     精灵表是 3 列 × 4 行（下 / 左 / 右 / 上），一格大小 = 图宽/3 × 图高/4。
     量出来以后把整张表当 background-size:300% 400% 的背景，
     background-position 的百分比正好对应第几列 / 第几行（0/50/100% 和 0/33/66/100%）。
     格子大小不一（比如 32×32 和 32×45），所以宽高用 JS 按量到的比例设。 */
  var walkBoxes = Array.prototype.slice.call(root.querySelectorAll('.res-walk[data-file]'));
  var walkLoaded = [];

  function enhanceWalk(box) {
    if (box.getAttribute('data-walk-done')) return;
    box.setAttribute('data-walk-done', '1');
    var file = box.getAttribute('data-file') || '';
    if (!file) return;
    var idx = 0;
    var probe = new Image();
    probe.onload = function () {
      var w = probe.naturalWidth, h = probe.naturalHeight;
      /* 不是 3 列 × 4 行的整数格子就别硬套动画，留着整张缩略图 */
      if (!w || !h || w % 3 !== 0 || h % 4 !== 0) return;
      var fw = w / 3, fh = h / 4;
      var boxH = parseFloat(getComputedStyle(box).height) || 110;
      box.style.width = Math.round(boxH * (fw / fh)) + 'px';
      box.style.backgroundImage = 'url("' + srcAt(idx, file) + '")';
      box.classList.add('is-anim');
    };
    probe.onerror = function () {
      if (idx < SOURCES.length - 1) { idx += 1; probe.src = srcAt(idx, file); }
    };
    probe.src = srcAt(0, file);
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var box = en.target;
        if (en.isIntersecting) {
          box.classList.add('is-live');
          if (walkLoaded.indexOf(box) < 0) { walkLoaded.push(box); enhanceWalk(box); }
        } else {
          box.classList.remove('is-live');
        }
      });
    }, { rootMargin: '150px 0px' });
    walkBoxes.forEach(function (b) { io.observe(b); });
  } else {
    walkBoxes.forEach(enhanceWalk);
  }

  /* ---------- 卡片上的「格式 · 尺寸 · 大小」 ----------
     这两个数字**不由站长维护**：
       · 尺寸：图片加载完，浏览器自己知道 naturalWidth / naturalHeight；
       · 大小：把当前页面所有文件一次性 POST 给 Worker（/cdn/meta），
         Cloudflare 那边读 GitHub 原始文件的 content-length。
     拿不到就只显示格式，不影响任何操作。 */
  var META_URL = CDN.replace(/\/+$/, '') + '/meta';

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  var cards = Array.prototype.slice.call(root.querySelectorAll('.res-card'));
  var dims = {};    // file -> {w,h}
  var bytes = {};   // file -> number

  function paintMeta(card) {
    var el = card.querySelector('.res-meta');
    if (!el) return;
    var file = card.getAttribute('data-file') || '';
    var parts = [];
    var fmt = el.getAttribute('data-fmt');
    if (fmt) parts.push(fmt);
    var d = dims[file];
    if (d && d.w && d.h) {
      parts.push(d.w + '×' + d.h);
      /* 行走图再报一格多大：做游戏的人要的是这个数 */
      if (card.classList.contains('res-pk') && d.w % 3 === 0 && d.h % 4 === 0) {
        parts.push('一格 ' + (d.w / 3) + '×' + (d.h / 4));
      }
    }
    var b = fmtSize(bytes[file]);
    if (b) parts.push(b);
    el.textContent = parts.join(' · ');
    /* 灯箱读的是 data-meta，这里同步过去，点开就能看到同样的信息 */
    card.setAttribute('data-meta', el.textContent);
  }

  var sizeFiles = [];
  cards.forEach(function (card) {
    var file = card.getAttribute('data-file') || '';
    if (file && sizeFiles.indexOf(file) < 0) sizeFiles.push(file);
    var face = card.getAttribute('data-face') || '';
    if (face && sizeFiles.indexOf(face) < 0) sizeFiles.push(face);

    var img = card.querySelector('.res-walk-sheet') || card.querySelector('[data-res-img]');
    if (img && file) {
      var take = function () {
        if (!img.naturalWidth) return;
        dims[file] = { w: img.naturalWidth, h: img.naturalHeight };
        paintMeta(card);
      };
      if (img.complete && img.naturalWidth) take();
      else img.addEventListener('load', take);
    }
    paintMeta(card);
  });

  if (sizeFiles.length && typeof fetch === 'function') {
    fetch(META_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: sizeFiles }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.bytes) return;
        bytes = d.bytes;
        cards.forEach(paintMeta);
      })
      .catch(function () { /* 大小拿不到就不显示，不影响别的 */ });
  }

  /* ---------- 纯前端打包 zip（store，不压缩：PNG 本来就压过了） ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(entries) {
    var enc = new TextEncoder();
    var local = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var name = enc.encode(e.name);
      var crc = crc32(e.bytes);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 0x0800, true);    // bit 11：文件名是 UTF-8
      h.setUint16(8, 0, true);         // 存储，不压缩
      h.setUint16(10, 0, true);        // 时间 00:00
      h.setUint16(12, 0x21, true);     // 日期 1980-01-01
      h.setUint32(14, crc, true);
      h.setUint32(18, e.bytes.length, true);
      h.setUint32(22, e.bytes.length, true);
      h.setUint16(26, name.length, true);
      h.setUint16(28, 0, true);
      local.push(new Uint8Array(h.buffer), name, e.bytes);

      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, 0, true);
      c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, e.bytes.length, true);
      c.setUint32(24, e.bytes.length, true);
      c.setUint16(28, name.length, true);
      c.setUint16(30, 0, true);
      c.setUint16(32, 0, true);
      c.setUint16(34, 0, true);
      c.setUint16(36, 0, true);
      c.setUint32(38, 0, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);

      offset += 30 + name.length + e.bytes.length;
    });

    var cSize = central.reduce(function (n, p) { return n + p.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cSize, true);
    end.setUint32(16, offset, true);

    var parts = local.concat(central, [new Uint8Array(end.buffer)]);
    var total = parts.reduce(function (n, p) { return n + p.length; }, 0);
    var out = new Uint8Array(total);
    var at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  /* 取一个文件的原始字节：从主 CDN 开始，失败依次换镜像。
     只认 image/* 的响应 —— 有的代理出错时也回 200，回的是 HTML。 */
  function fetchBytes(file) {
    var idx = 0;
    function next() {
      if (idx >= SOURCES.length) return Promise.resolve(null);
      var url = srcAt(idx, file);
      idx += 1;
      return fetch(url).then(function (r) {
        var type = (r.headers.get('content-type') || '').toLowerCase();
        if (!r.ok || (type && type.indexOf('image/') !== 0)) return next();
        return r.arrayBuffer().then(function (b) { return new Uint8Array(b); });
      }).catch(next);
    }
    return next();
  }

  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '-').trim() || 'pokemon';
  }

  function downloadBlob(bytesArr, filename) {
    var blob = new Blob([bytesArr], { type: 'application/zip' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function packPokemon(card, btn) {
    var file = card.getAttribute('data-file') || '';
    var face = card.getAttribute('data-face') || '';
    var title = card.getAttribute('data-title') || 'pokemon';
    var dex = Number(card.getAttribute('data-dex')) || 0;
    var list = [file, face].filter(Boolean);
    if (!list.length) return;

    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '打包中…';

    var jobs = list.map(function (f) { return fetchBytes(f); });
    Promise.all(jobs).then(function (bufs) {
      var entries = [];
      list.forEach(function (f, i) {
        if (bufs[i]) entries.push({ name: safeName(f.split('/').pop()), bytes: bufs[i] });
      });
      if (!entries.length) throw new Error('文件都取不到');
      /* 附一张署名条：CC BY 要求署名，包里带着就不用别人再回来找 */
      var credit = '素材：' + title + '（No.' + pad3(dex) + '）\n' +
        '作者：' + AUTHOR + '\n' +
        '来源：' + REPO + '\n' +
        '许可：' + LICENSE + '（https://creativecommons.org/licenses/by/4.0/）\n' +
        '文件：' + entries.map(function (e) { return e.name; }).join('、') + '\n';
      entries.push({ name: '署名.txt', bytes: new TextEncoder().encode(credit) });
      downloadBlob(makeZip(entries), 'No.' + pad3(dex) + '-' + safeName(title) + '.zip');
      btn.textContent = '已下载 ✓';
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1500);
    }).catch(function (e) {
      btn.textContent = old;
      btn.disabled = false;
      alert('打包失败：' + (e && e.message ? e.message : '文件取不到') + '\n可以直接点文件名一个一个下载。');
    });
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

  /* 像素图放大要按整数倍，不然插值糊掉；96×128 的精灵表按原始大小看又太小。
     能整倍放开就整倍放开，放不下就退回 max-width / max-height 等比缩。 */
  function zoomLb() {
    var w = lbImg.naturalWidth, h = lbImg.naturalHeight;
    if (!w || !h) return;
    var availW = Math.max(160, Math.min(760, window.innerWidth - 40) - 28);
    var availH = Math.max(160, Math.round(window.innerHeight * 0.52));
    if (w <= availW && h <= availH) {
      var k = Math.floor(Math.min(availW / w, availH / h));
      if (k < 1) k = 1;
      if (k > 8) k = 8;
      lbImg.style.width = (w * k) + 'px';
      lbImg.style.height = (h * k) + 'px';
      lbImg.style.maxWidth = 'none';
      lbImg.style.maxHeight = 'none';
    } else {
      resetLbZoom();
    }
  }
  function resetLbZoom() {
    lbImg.style.width = '';
    lbImg.style.height = '';
    lbImg.style.maxWidth = '';
    lbImg.style.maxHeight = '';
  }

  function openLb(o) {
    current = o;
    lastFocus = document.activeElement;
    var kind = o.kind || 'image';
    var file = o.file || '';

    lbTitle.textContent = o.title || '';
    lbMeta.textContent = o.meta || '';
    var note = o.note || '';
    lbNote.textContent = note;
    lbNote.hidden = !note;
    lbDl.setAttribute('href', o.dl || (CDN + file));

    if (kind === 'audio') {
      lbImg.removeAttribute('src');
      lbImg.hidden = true;
      lbAudio.hidden = false;
      resetLbZoom();
    } else {
      lbImg.hidden = false;
      lbAudio.hidden = true;
      resetLbZoom();
      lbImg.setAttribute('src', CDN + file);
      var mi = 0;
      lbImg.onload = zoomLb;
      lbImg.onerror = function () {
        if (mi < SOURCES.length - 1) { mi += 1; lbImg.src = srcAt(mi, file); }
      };
      lbImg.setAttribute('alt', o.title || '');
    }

    lbCredit.textContent = creditFor(file, o.title || '');
    lb.hidden = false;
    document.body.classList.add('res-lb-open');
    lb.querySelector('[data-res-close]').focus();
  }

  function closeLb() {
    lb.hidden = true;
    document.body.classList.remove('res-lb-open');
    lbImg.removeAttribute('src');
    resetLbZoom();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function cardToLb(card) {
    return {
      kind: card.getAttribute('data-kind') || 'image',
      file: card.getAttribute('data-file') || '',
      title: card.getAttribute('data-title') || '',
      meta: card.getAttribute('data-meta') || '',
      note: card.getAttribute('data-note') || '',
      dl: card.getAttribute('data-dl') || '',
    };
  }

  root.addEventListener('click', function (e) {
    var zipBtn = e.target.closest('[data-res-zip]');
    if (zipBtn) {
      var zipCard = zipBtn.closest('.res-pk');
      if (zipCard) packPokemon(zipCard, zipBtn);
      return;
    }
    var faceBtn = e.target.closest('[data-res-face]');
    if (faceBtn) {
      var fCard = faceBtn.closest('.res-pk');
      var face = faceBtn.getAttribute('data-file') || '';
      var fImg = faceBtn.querySelector('img');
      var n = fImg && fImg.naturalWidth ? Math.round(fImg.naturalWidth / 96) : 0;
      openLb({
        file: face,
        title: faceBtn.getAttribute('data-title') || (fCard ? fCard.getAttribute('data-title') + ' 脸图' : '脸图'),
        meta: (fImg && fImg.naturalWidth ? fImg.naturalWidth + '×' + fImg.naturalHeight : '') +
          (n > 1 ? ' · ' + n + ' 个表情' : ''),
        note: fCard ? (fCard.getAttribute('data-note') || '') : '',
        dl: CDN + face,
      });
      return;
    }
    var card = e.target.closest('.res-card');
    if (!card) return;
    /* 卡片里的按钮/下载链接点自己就好，别顺手开灯箱 */
    if (e.target.closest('a[download], .res-btn, .res-face-btn')) return;
    openLb(cardToLb(card));
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
      copyText(creditFor(current.file || '', current.title || ''));
      var old = copyBtn.textContent;
      copyBtn.textContent = '已复制 ✓';
      setTimeout(function () { copyBtn.textContent = old; }, 1600);
    });
  }
})();
