/* ============================================================
   board.js —— 布告栏（/board/ 整页 + 首页那块缩小版）
   ------------------------------------------------------------
   两块界面共用这一个文件：

     .bd（整页）  列出全部便签，点开可以放大看全文；
                  页面下方那张"空白便签"点一下就是"写下便签"。
     .bd-mini（首页）只列最近几张，整块是一个通往 /board/ 的链接。

   数据来源在 HTML 上，不写死在这里：
     data-bd-src  便签 JSON 的地址（模板用 relURL 生成，子目录部署也对）
     data-bd-img  图钉图片目录
     data-bd-live 第二步接上的后端地址；填了就优先用它，
                  拿不到再回落到 data-bd-src 的静态 JSON——
                  静态那份永远在 github.io 上，所以后端就算连不上，
                  至少"看"这件事不会坏。
     data-bd-list 整页用 all，首页缩略用 recent

   安全：便签正文是**别人写的字**，一律走 textContent / 属性赋值，
   不拼 innerHTML。这条比好看重要，谁改这个文件都别破坏它。
   ============================================================ */
(function () {
  'use strict';

  /* 纸色。前两个是"做旧纸"，占绝大多数；后四个是淡彩，偶尔出现一张。
     发帖人自己挑了颜色就用他挑的，没挑（或后端没给）就按 id 定。 */
  var COLORS = ['white', 'cream', 'yellow', 'pink', 'green', 'blue'];
  var ACCENTS = ['yellow', 'pink', 'green', 'blue'];
  var PINS = ['red', 'blue', 'yellow'];
  var BODY_MAX = 300;                 // 单张便签的字数上限（后端还会再卡一次）
  var LOCAL_KEY = 'nijiboshi.board.local';

  /* ---------------- 小工具 ---------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = String(text); }
    return n;
  }

  function attr(host, name) { return (host && host.getAttribute(name)) || ''; }

  /* 由便签 id 决定倾斜角与图钉颜色：同一个 id 每次渲染结果一样，
     刷新不会满板子乱跳，也不需要后端存这些。 */
  function hash(s) {
    s = String(s || '');
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /* 一个定死的伪随机（mulberry32）：同样的种子永远给同一串数 */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* 手撕的毛边。
     要点两条，都是站长看过之后定的：
       1. 四个角**显式写进 polygon**，形状才是个长方形 —— 不写角点的话，
          polygon 会把角直接连成斜边，整张便签看着像六边形。
       2. 只有上边缘撕得明显（≤1.7%），左右几乎平、下边轻一点，
          撕得过头就不像便签、像破布了。
     采样点按 id 定，同一张永远是同一道撕口，刷新不会变。 */
  function tearPath(id) {
    var rnd = mulberry32(hash(id));
    var pts = [];
    var i, t;
    var TOP = 6;
    pts.push([0.4, 0.5]);                                    // 左上角
    for (i = 1; i <= TOP; i++) {                             // 上边：撕
      t = 6 + (88 * i / (TOP + 1));
      pts.push([t, 0.3 + rnd() * 1.7]);
    }
    pts.push([99.6, 0.6]);                                   // 右上角
    for (i = 1; i <= 3; i++) {                               // 右边：只毛一点
      pts.push([99.6 - rnd() * 0.5, 8 + (84 * i / 4)]);
    }
    pts.push([99.6, 99.4]);                                  // 右下角
    for (i = TOP; i >= 1; i--) {                             // 下边：轻微
      t = 6 + (88 * i / (TOP + 1));
      pts.push([t, 99.6 - rnd() * 0.9]);
    }
    pts.push([0.4, 99.5]);                                   // 左下角
    for (i = 3; i >= 1; i--) {                               // 左边
      pts.push([0.4 + rnd() * 0.5, 8 + (84 * i / 4)]);
    }
    var out = [];
    for (i = 0; i < pts.length; i++) {
      out.push(pts[i][0].toFixed(2) + '% ' + pts[i][1].toFixed(2) + '%');
    }
    return 'polygon(' + out.join(', ') + ')';
  }

  function rotOf(id) {
    var h = hash(id);
    return (h % 1000) / 100 - 5.0;     // -5° ~ +5°
  }

  /* 上下位移：让便签不排在一条水平线上，相邻的会轻微搭上一点。
     注意必须用 >>>（无符号右移）：hash 是 32 位无符号数，用 >> 会得到负数，
     dy/z 就会跑出范围 —— z-index 一旦变成负数，便签会被塞到板面背景后面看不见
     （踩过：板子上只剩四张便签，其它全"消失"了）。 */
  function dyOf(id) {
    var h = hash(id);
    return ((h >>> 7) % 17) - 8;       // -8px ~ +8px
  }

  /* 层级：谁压谁也是按 id 定死的，同一张永远一样 */
  function zOf(id) {
    return (hash(id) >>> 3) % 4 + 1;   // 1 ~ 4
  }

  function pinOf(id) { return PINS[hash(id) % PINS.length]; }

  /* 现在几点（北京时间）。便签的时间一律按 +08:00 记，不看访客的时区——
     和站点 hugo.toml 里 timeZone = "Asia/Shanghai" 是一个口径。 */
  function nowCN() {
    var d = new Date(new Date().getTime() + 8 * 3600 * 1000);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
      + 'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + '+08:00';
  }

  /* 时间：后端给 ISO 串，这里只负责显示成"2026-10-12 21:07"。
     已经是这种格式（假数据）就原样用。 */
  function fmtTime(v) {
    if (!v) { return ''; }
    var s = String(v);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) { return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]; }
    return s;
  }

  function makePin(base, id) {
    var img = el('img', 'bd-pin');
    img.alt = '';
    img.setAttribute('draggable', 'false');
    img.src = base + '/pin-' + pinOf(id) + '.png';
    return img;
  }

  /* ---------------- 本机暂存的便签（还没接后端的阶段用） ---------------- */

  function readLocal() {
    try {
      var raw = window.localStorage.getItem(LOCAL_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function writeLocal(arr) {
    try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  function addLocal(note) {
    var arr = readLocal();
    arr.push(note);
    while (arr.length > 50) { arr.shift(); }
    writeLocal(arr);
    return arr;
  }

  /* ---------------- 取数据 ---------------- */

  function getJSON(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) { return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cb(null, JSON.parse(xhr.responseText)); }
        catch (e) { cb(e); }
      } else {
        cb(new Error('HTTP ' + xhr.status));
      }
    };
    xhr.onerror = function () { cb(new Error('network')); };
    try { xhr.send(); } catch (e) { cb(e); }
  }

  function normalize(data) {
    var list = (data && data.notes) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n || typeof n.body !== 'string') { continue; }
      out.push(n);
    }
    return out;
  }

  function loadNotes(host, cb) {
    var live = attr(host, 'data-bd-live');
    var stat = attr(host, 'data-bd-src');
    var want = attr(host, 'data-bd-list') || 'all';

    var done = function (err, notes) {
      // 本机暂存的排在最后（自己刚写的，看得到就行）
      var mine = readLocal();
      var merged = notes.concat(mine);
      if (want === 'recent') { merged = merged.slice(-3); }
      cb(err, merged, !!err);
    };

    var fromStatic = function () {
      if (!stat) { return done(new Error('no source'), []); }
      getJSON(stat, function (err, data) {
        if (err) { return done(err, []); }
        done(null, normalize(data));
      });
    };

    if (live) {
      getJSON(live, function (err, data) {
        if (err) { fromStatic(); return; }   // 后端不通就吃静态那份
        done(null, normalize(data));
      });
    } else {
      fromStatic();
    }
  }

  /* ---------------- 便签 ---------------- */

  /* 这张便签用什么纸：发帖人挑过就用他挑的；没挑就按 id 决定 ——
     大约八成是米白/奶白，剩下两成随机一种淡彩。 */
  function paperOf(n) {
    if (n && COLORS.indexOf(n.color) >= 0) { return n.color; }
    var h = hash(n && n.id);
    if (h % 100 < 20) { return ACCENTS[(h >> 5) % ACCENTS.length]; }
    return (h % 3 === 0) ? 'cream' : 'white';
  }

  function noteClass(n, mini) {
    var cls = 'bd-note bd-c-' + paperOf(n);
    if (n.reply) { cls += ' has-reply'; }
    if (n.local) { cls += ' local-only'; }
    if (mini) { cls += ' bd-note-mini'; }
    return cls;
  }

  function makeNote(n, opt) {
    opt = opt || {};
    var box = el('div', noteClass(n, opt.mini));
    box.style.setProperty('--bd-rot', rotOf(n.id).toFixed(2) + 'deg');
    box.style.setProperty('--bd-dy', dyOf(n.id) + 'px');
    box.style.setProperty('--bd-z', String(zOf(n.id)));
    /* 撕口按 id 生成，页面和缩略版都用同一道 */
    box.style.setProperty('--bd-tear', tearPath(n.id));

    var shadow = el('div', 'bd-paper-shadow');
    var paper = el('div', 'bd-paper');
    paper.appendChild(el('div', 'bd-note-body', n.body));

    var foot = el('div', 'bd-note-foot');
    var who = el('span', 'bd-note-name', (n.name && String(n.name).replace(/^\s+|\s+$/g, '')) || '匿名');
    foot.appendChild(who);
    if (!opt.mini) {
      if (n.reply) { foot.appendChild(el('span', 'bd-note-badge', '回复')); }
      foot.appendChild(el('span', 'bd-note-more', n.local ? '仅本机 »' : '整张看 »'));
    }
    paper.appendChild(foot);
    shadow.appendChild(paper);
    box.appendChild(shadow);
    /* 图钉是纸的兄弟节点，不能放进纸里 —— 纸被 clip-path 裁过，钉帽会一起没掉 */
    box.appendChild(makePin(opt.img, n.id));

    if (!opt.mini) {
      box.setAttribute('tabindex', '0');
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', '放大看这张便签');
      var open = function () { opt.onOpen && opt.onOpen(n); };
      box.addEventListener('click', open);
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
          e.preventDefault();
          open();
        }
      });
    }
    return box;
  }

  /* ---------------- 弹层（放大 / 写便签共用） ---------------- */

  function Modal(root) {
    this.root = root;
    this.note = root.querySelector('.bd-modal-note');
    this.paper = root.querySelector('.bd-modal-paper');   // 带撕边那一层
    this.body = root.querySelector('.bd-modal-scroll');   // 会滚动的内层   // 会滚动的内层
    this.bg = root.querySelector('.bd-modal-bg');
    var self = this;
    this.bg.addEventListener('click', function () { self.close(); });
    document.addEventListener('keydown', function (e) {
      if (!self.root.hidden && (e.key === 'Escape' || e.keyCode === 27)) { self.close(); }
    });
  }

  /* 清空内容：外层留那张带撕边的纸（它里面才是滚动层），别的都清掉。
     这里要留住的是 .bd-modal-paper，不是 .bd-modal-scroll —— 
     滚动层是纸的孙子，留错了会把纸本身删掉（弹层就塌成 0 高，踩过一次）。 */
  Modal.prototype.empty = function () {
    var k = this.note.firstChild;
    while (k) {
      var next = k.nextSibling;
      if (k !== this.paper) { this.note.removeChild(k); }
      k = next;
    }
    while (this.body.firstChild) { this.body.removeChild(this.body.firstChild); }
  };

  /* 打开并清空（每次开都从一张白纸开始） */
  Modal.prototype.clear = function () {
    this.empty();
    this.root.hidden = false;
  };

  Modal.prototype.setPaper = function (color) {
    var c = COLORS.indexOf(color) >= 0 ? color : 'white';
    this.paper.className = 'bd-modal-paper bd-c-' + c;
  };

  Modal.prototype.close = function () {
    this.root.hidden = true;
    this.empty();
  };

  Modal.prototype.closeBtn = function () {
    var self = this;
    var b = el('button', 'bd-modal-close', '×');
    b.type = 'button';
    b.setAttribute('aria-label', '关掉');
    b.addEventListener('click', function () { self.close(); });
    return b;
  };

  /* ---------------- 放大看一张 ---------------- */

  function showNote(modal, n, opt) {
    modal.setPaper(n.color);
    modal.clear();

    modal.note.appendChild(makePin(opt.img, n.id));      // 钉在纸外面，不进滚动区
    modal.note.appendChild(modal.closeBtn());            // × 也不跟着内容滚
    modal.body.appendChild(el('div', 'bd-modal-body', n.body));

    var foot = el('div', 'bd-modal-foot');
    foot.appendChild(el('span', null, ((n.name && String(n.name).replace(/^\s+|\s+$/g, '')) || '匿名')
      + (n.local ? '（只贴在你自己的浏览器里）' : '')));
    foot.appendChild(el('span', null, fmtTime(n.at)));
    modal.body.appendChild(foot);

    if (n.reply && n.reply.body) {
      var r = el('div', 'bd-reply');
      var img = el('img', 'bd-pin');
      img.alt = '';
      img.src = opt.img + '/pin-' + (opt.replyPin || 'red') + '.png';
      r.appendChild(img);
      r.appendChild(el('div', 'bd-reply-head', '站长回复' + (n.reply.at ? ' · ' + fmtTime(n.reply.at) : '')));
      r.appendChild(el('div', 'bd-reply-body', n.reply.body));
      modal.body.appendChild(r);
    }
    return modal.note;
  }

  /* ---------------- 写下便签 ---------------- */

  function showCompose(modal, opt, onPosted) {
    modal.setPaper(opt.color || 'yellow');
    modal.clear();

    modal.note.appendChild(modal.closeBtn());
    var form = el('div', 'bd-note-form');
    form.appendChild(el('div', 'bd-form-hint', opt.hint || '在这儿写下你想贴的话'));

    /* 名字 */
    var fName = el('label', 'bd-field');
    fName.appendChild(el('span', null, '你的名字（留空就是匿名）'));
    var name = el('input');
    name.type = 'text';
    name.maxLength = 24;
    name.setAttribute('placeholder', '匿名');
    fName.appendChild(name);
    form.appendChild(fName);

    /* 纸色 */
    var fColor = el('div', 'bd-field');
    fColor.appendChild(el('span', null, '便签的颜色'));
    var sw = el('div', 'bd-swatches');
    var color = COLORS.indexOf(opt.color) >= 0 ? opt.color : 'white';
    for (var i = 0; i < COLORS.length; i++) {
      (function (c) {
        var b = el('button', 'bd-c-' + c + (c === color ? ' on' : ''));
        b.type = 'button';
        b.setAttribute('aria-label', c);
        b.addEventListener('click', function () {
          color = c;
          modal.setPaper(c);
          var bs = sw.getElementsByTagName('button');
          for (var k = 0; k < bs.length; k++) {
            bs[k].className = 'bd-c-' + COLORS[k] + (COLORS[k] === c ? ' on' : '');
          }
        });
        sw.appendChild(b);
      })(COLORS[i]);
    }
    fColor.appendChild(sw);
    form.appendChild(fColor);

    /* 正文 */
    var fBody = el('label', 'bd-field');
    var head = el('span');
    head.appendChild(document.createTextNode('便签上写什么'));
    var count = el('span', 'bd-count', '0 / ' + BODY_MAX);
    head.appendChild(count);
    fBody.appendChild(head);
    var body = el('textarea');
    body.maxLength = BODY_MAX + 40;      // 留点余量，好让人看见自己超了多少
    body.setAttribute('placeholder', '最多 ' + BODY_MAX + ' 字。别人的便签也会贴在旁边，别写让人不舒服的话。');
    fBody.appendChild(body);
    form.appendChild(fBody);

    var err = el('p', 'bd-err');
    err.hidden = true;
    form.appendChild(err);

    /* 按钮 */
    var acts = el('div', 'bd-actions');
    var ok = el('button', 'bd-btn primary', '贴上去');
    ok.type = 'button';
    var cancel = el('button', 'bd-btn', '算了');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { modal.close(); });
    acts.appendChild(ok);
    acts.appendChild(cancel);
    form.appendChild(acts);

    body.addEventListener('input', function () {
      var n = body.value.length;
      count.textContent = n + ' / ' + BODY_MAX;
      count.className = 'bd-count' + (n > BODY_MAX ? ' over' : '');
    });

    ok.addEventListener('click', function () {
      var text = String(body.value).replace(/\s+$/, '').replace(/^\s+/, '');
      if (!text) { err.hidden = false; err.textContent = '便签是空的。'; body.focus(); return; }
      if (text.length > BODY_MAX) {
        err.hidden = false;
        err.textContent = '太长了，超了 ' + (text.length - BODY_MAX) + ' 个字。';
        return;
      }
      var note = {
        id: 'local-' + (new Date().getTime()),
        name: String(name.value).replace(/^\s+|\s+$/g, '').slice(0, 24),
        color: color,
        body: text,
        at: nowCN(),
        local: true
      };
      if (opt.onSubmit) { opt.onSubmit(note); }
      modal.close();
      onPosted && onPosted(note);
    });

    modal.body.appendChild(form);
    try { body.focus(); } catch (e) {}
    return modal.note;
  }

  /* ---------------- 整页 ---------------- */

  function bootBoard(host) {
    var img = attr(host, 'data-bd-img') || '/images/board';
    var list = host.querySelector('.bd-notes');
    var cork = host.querySelector('.bd-cork');
    var tip = host.querySelector('.bd-tip');
    var write = host.querySelector('.bd-write');
    var modalRoot = document.getElementById('bd-modal');
    if (!list) { return; }

    var loading = el('p', 'bd-loading', '正在看板子上有什么…');
    cork.appendChild(loading);

    var modal = modalRoot ? new Modal(modalRoot) : null;
    var notes = [];

    function render() {
      while (list.firstChild) { list.removeChild(list.firstChild); }
      for (var i = notes.length - 1; i >= 0; i--) {           // 新的贴前面
        list.appendChild(makeNote(notes[i], {
          img: img,
          onOpen: function (n) { modal && showNote(modal, n, { img: img }); }
        }));
      }
      var empty = host.querySelector('.bd-empty');
      if (empty) { empty.hidden = notes.length > 0; }
    }

    loadNotes(host, function (err, data, offline) {
      cork.removeChild(loading);
      notes = data;
      render();
      if (tip) {
        while (tip.firstChild) { tip.removeChild(tip.firstChild); }
        if (offline) {
          tip.appendChild(el('span', 'bd-warn', '（没能读到服务器上的便签，你现在看到的是本地缓存的那一份。）'));
        }
      }
    });

    if (write && modal) {
      var openCompose = function () {
        showCompose(modal, {
          img: img,
          color: 'white',
          onSubmit: function (note) { addLocal(note); }
        }, function (note) {
          notes.push(note);
          render();
          if (tip) {
            while (tip.firstChild) { tip.removeChild(tip.firstChild); }
            tip.appendChild(el('span', 'bd-warn',
              '这张便签现在只贴在你自己的浏览器里 —— 布告栏还没接到服务器。'));
          }
        });
      };
      write.addEventListener('click', openCompose);
      write.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
          e.preventDefault();
          openCompose();
        }
      });
    }
  }

  /* ---------------- 首页那块 ---------------- */

  function bootMini(host) {
    var img = attr(host, 'data-bd-img') || '/images/board';
    var list = host.querySelector('.bd-notes');
    if (!list) { return; }
    loadNotes(host, function (err, data) {
      while (list.firstChild) { list.removeChild(list.firstChild); }
      var n = Math.min(data.length, 3);
      for (var i = data.length - 1; i >= data.length - n; i--) {
        list.appendChild(makeNote(data[i], { img: img, mini: true }));
      }
      if (!n) {
        list.appendChild(el('p', 'bd-empty', '布告栏还空着，进去贴第一张？'));
      }
    });
  }

  /* ---------------- 页面下方那叠空白便签 ----------------
     它们不是便签数据，是静态画出来的三张纸；这里只补一件事：
     按 data-blank 生成撕口（和板上的便签共用同一套算法）。 */
  function bootBlanks() {
    var list = document.querySelectorAll('.bd-blank[data-blank]');
    for (var i = 0; i < list.length; i++) {
      var paper = list[i].querySelector('.bd-paper');
      if (!paper) { continue; }
      paper.style.setProperty('--bd-tear', tearPath('blank-' + list[i].getAttribute('data-blank')));
    }
  }

  /* ---------------- 入口 ---------------- */

  function boot() {
    bootBlanks();
    var hosts = document.querySelectorAll('.bd[data-bd-src]');
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (h.className.indexOf('bd-mini') >= 0) { bootMini(h); }
      else { bootBoard(h); }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
