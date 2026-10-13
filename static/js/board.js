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
  /* 时间要写成人话：`2026-10-13 02:17` 这种一看就是机器生成的。
     今年不写年份，往年才写： 10月13日 02:17 / 2025年9月1日 12:00 */
  function fmtTime(v) {
    if (!v) { return ''; }
    var s = String(v);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) {
      var y = +m[1], mo = +m[2], d = +m[3];
      var sameYear = (y === new Date().getFullYear());
      return (sameYear ? '' : y + '年') + mo + '月' + d + '日 ' + m[4] + ':' + m[5];
    }
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

  /* ---------------- 我在这个浏览器里贴过哪些 ----------------
     贴上去之后把便签 id 记下来，这样自己那张能自己撤掉（后端只认这个随机串）。 */
  var TOKEN_KEY = 'nijiboshi.board.token';
  var MINE_KEY = 'nijiboshi.board.mine';

  function myToken() {
    var t = '';
    try { t = window.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    if (!t) {
      t = '';
      for (var i = 0; i < 4; i++) { t += Math.random().toString(36).slice(2, 10); }
      try { window.localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
    }
    return t;
  }

  function myNotes() {
    try {
      var raw = window.localStorage.getItem(MINE_KEY);
      var o = raw ? JSON.parse(raw) : {};
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }

  function rememberMine(id) {
    var m = myNotes();
    m[String(id)] = 1;
    try { window.localStorage.setItem(MINE_KEY, JSON.stringify(m)); } catch (e) {}
  }

  function isMine(id) { return !!myNotes()[String(id)]; }

  /* ---------------- 取数据 ---------------- */

  /* data-bd-live 写「根地址」（https://xxx.pages.dev）或者「完整接口地址」
     （https://xxx.pages.dev/api/notes）都行 —— 两种写法都有人写，
     这里统一推成接口地址，省得以后换一种写法就 404。 */
  function apiNotes(live) {
    var base = String(live || '').replace(/\/+$/, '');
    return /\/api\/notes$/.test(base) ? base : base + '/api/notes';
  }

  /* ⚠️ 回调**必须只调一次**。
     原来 getJSON / postJSON 里是裸的 cb：
         xhr.onerror = function () { cb(new Error('network')); };
         try { xhr.send(); } catch (e) { cb(e); }
     请求被拦下来 / 网络抖动时（后端不通本来就是常态），**两条路都会走到** ——
     onerror 调一次，send() 同步抛错又调一次。于是 loadNotes 里
     `if (err) { fromStatic(); }` 会跑两遍：notes.json 拉两次，
     第二次 `cork.removeChild(loading)` 时那个 loading 已经不在树里，
     抛 NotFoundError（实测：只断后端时 1 次、后端+静态都断时 3 次）。
     包一层 once，从根上保证只有第一次有效。 */
  function once(cb) {
    var used = false;
    return function () {
      if (used) { return; }
      used = true;
      cb.apply(null, arguments);
    };
  }

  function getJSON(url, cb) {
    cb = once(cb);
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

  /* 写接口（贴便签 / 撤下来）。后端约定返回 {"ok":true,...} 或 {"ok":false,"error":"…"} */
  function postJSON(url, method, payload, cb) {
    cb = once(cb);
    var xhr = new XMLHttpRequest();
    xhr.open(method || 'POST', url, true);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) { return; }
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok !== false) {
        cb(null, data);
      } else {
        cb(new Error((data && data.error) || ('HTTP ' + xhr.status)));
      }
    };
    xhr.onerror = function () { cb(new Error('连不上服务器')); };
    try { xhr.send(JSON.stringify(payload)); } catch (e) { cb(e); }
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
      var merged = mine.concat(notes);      // 本机自己写的排最前
      if (want === 'recent') { merged = merged.slice(0, 3); }   // 取最新的三张
      if (want === 'random') {                                    // 首页：随机抽 1~3 张
        for (var k = merged.length - 1; k > 0; k--) {              // Fisher–Yates
          var j = Math.floor(Math.random() * (k + 1));
          var t = merged[k]; merged[k] = merged[j]; merged[j] = t;
        }
        merged = merged.slice(0, 1 + Math.floor(Math.random() * 3));
      }
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
      getJSON(apiNotes(live), function (err, data) {
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

    /* onOpen 给了就接上点击 —— 缩略版也算：站长要求首页那块点开就地看详情，
       不用非得跳到 /board/。 */
    if (opt.onOpen) {
      box.setAttribute('tabindex', '0');
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', '放大看这张便签');
      var open = function () { opt.onOpen(n); };
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

    /* 自己贴的那张：给一个撤下来的按钮（后端只认本机这个随机串） */
    if (opt.onDelete && isMine(n.id)) {
      var del = el('button', 'bd-btn bd-btn-del', '撤下来');
      del.type = 'button';
      del.title = '把你自己贴的这一张拿下来';
      del.addEventListener('click', function () {
        del.disabled = true;
        del.textContent = '正在拿下来…';
        opt.onDelete(n, function (err) {
          del.disabled = false;
          del.textContent = err ? '没拿下来，再试一次' : '撤下来';
        });
      });
      var acts = el('div', 'bd-actions');
      acts.appendChild(del);
      modal.body.appendChild(acts);
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

    var t0 = new Date().getTime();          // 打开表单的时刻，太快提交的当脚本

    /* 名字 */
    var fName = el('label', 'bd-field');
    fName.appendChild(el('span', null, '你的名字（留空就是匿名）'));
    var name = el('input');
    name.type = 'text';
    name.maxLength = 24;
    name.setAttribute('autocomplete', 'nickname');
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

    /* 蜜罐：正常人看不见也填不到；填了就说明是脚本。
       **必须放在正文后面**：它要是排在第一个 input，浏览器的自动填充
       很可能正好填到它，真人写的便签就会被静默拒掉（E2E 测试抓到过）。 */
    var hp = el('input', 'bd-hp');
    hp.type = 'text';
    hp.name = 'hp';
    hp.tabIndex = -1;
    hp.setAttribute('autocomplete', 'off');
    hp.setAttribute('aria-hidden', 'true');
    form.appendChild(hp);

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
      var who = String(name.value).replace(/^\s+|\s+$/g, '').slice(0, 24);

      /* 没接后端：还是老样子，贴在本机浏览器里，页面上会标出来 */
      if (!opt.live) {
        var local = { id: 'local-' + (new Date().getTime()), name: who, color: color,
                      body: text, at: nowCN(), local: true };
        if (opt.onSubmit) { opt.onSubmit(local); }
        modal.close();
        onPosted && onPosted(local);
        return;
      }

      /* 接了后端：真发出去。发失败就把表单留着，别让人白写一遍 */
      ok.disabled = true;
      ok.textContent = '正在贴…';
      err.hidden = true;
      postJSON(apiNotes(opt.live), 'POST', {
        name: who, color: color, body: text, token: myToken(), hp: hp.value, t0: t0
      }, function (e2, res) {
        ok.disabled = false;
        ok.textContent = '贴上去';
        if (e2) {
          err.hidden = false;
          err.textContent = '没贴上：' + (e2.message || '不知道哪儿出错了') + '。内容还在，可以再试一次。';
          return;
        }
        if (res && res.note) { rememberMine(res.note.id); }
        modal.close();
        onPosted && onPosted((res && res.note) || null);
      });
    });

    modal.body.appendChild(form);
    try { body.focus(); } catch (e) {}
    return modal.note;
  }

  /* ---------------- 整页 ---------------- */

  function bootBoard(host) {
    var img = attr(host, 'data-bd-img') || '/images/board';
    var live = attr(host, 'data-bd-live');
    var list = host.querySelector('.bd-notes');
    var cork = host.querySelector('.bd-cork');
    var tip = host.querySelector('.bd-tip');
    var write = host.querySelector('.bd-write');
    var modalRoot = document.getElementById('bd-modal');
    if (!list) { return; }

    /* 加载提示：拉鲁瓦在板子上空飞来飞去 + 「正在联系拉鲁瓦…」。
       动的是站上那套 PMD 精灵表（pkmn/sprite/329.png，每格 40x40、每行 9 格），
       用 CSS steps() 逐格播 —— 和拉鲁瓦本体（board-keeper.js 里 canvas 画的）
       同一张图，所以loading 里飞的和待会儿停在角落的是同一只，不会两只不一样。 */
    var loading = el('div', 'bd-loading');
    /* 首页那块（.bd-mini）只有 500px 宽，飞一只 40px 的拉鲁瓦太挤，
       而且它一进来就固定三张便签、加载很快 —— 那边只留一行字。 */
    var isMini = /(^|\s)bd-mini(\s|$)/.test(host.className || '');
    if (isMini) { loading.className = 'bd-loading bd-loading-simple'; }
    var flybox = el('div', 'bd-loading-fly');
    var sprite = el('div', 'bd-loading-sprite');
    flybox.appendChild(sprite);
    var msg = el('p', 'bd-loading-msg', '正在联系拉鲁瓦…');
    if (!isMini) { loading.appendChild(flybox); }
    loading.appendChild(msg);
    /* 精灵表的真实地址：模板在 .bd 上留了 data-bd-sheet（没有就退回拉鲁瓦那只的默认路径）。
       用 walkL 那一行（第 2 行）当飞 —— 翅膀在扑。 */
    var sheetUrl = attr(host, 'data-bd-sheet') || '/pkmn/sprite/329.png';
    sprite.style.backgroundImage = 'url(' + sheetUrl + ')';
    cork.appendChild(loading);

    /* 摘掉加载提示：淡出再删。
       做成幂等的 —— loadNotes 万一回调两次也不会抛 NotFoundError。 */
    var loadingGone = false;
    function dropLoading() {
      if (loadingGone || !loading.parentNode) { return; }
      loadingGone = true;
      loading.classList.add('bd-loading-out');
      setTimeout(function () {
        if (loading.parentNode === cork) { cork.removeChild(loading); }
      }, 320);
    }

    var modal = modalRoot ? new Modal(modalRoot) : null;
    var notes = [];

    function render() {
      while (list.firstChild) { list.removeChild(list.firstChild); }
      /* notes 是「新 → 旧」：后端的 id DESC、静态那份样例也是这个顺序。
         顺着插，新的自然在最上面。**别再倒着插** —— 那样刚贴完新的是第一张，
         一刷新就翻成最旧的在最上面（只有连着真后端刷新才看得出来）。 */
      /* 通知一声：板子上有哪些便签（拉鲁瓦要拿"上次有人贴便签是什么时候"来说话）。
         window 上也挂一份，万一监听器注册得比这次渲染晚，还能补上。 */
      try {
        window.__boardNotes = notes;
        document.dispatchEvent(new CustomEvent('board:notes', { detail: { notes: notes } }));
      } catch (e) {}

      for (var i = 0; i < notes.length; i++) {
        list.appendChild(makeNote(notes[i], {
          img: img,
          onOpen: function (n) {
            if (!modal) { return; }
            showNote(modal, n, { img: img, onDelete: live ? removeMine : null });
          }
        }));
      }
      var empty = host.querySelector('.bd-empty');
      if (empty) { empty.hidden = notes.length > 0; }
    }

    /* 自己撤掉自己贴的那张（软删：后端只是把它藏起来） */
    function removeMine(note, done) {
      postJSON(apiNotes(live), 'DELETE', { id: note.id, token: myToken() },
        function (e2) {
          if (e2) { done && done(e2); return; }
          for (var i = 0; i < notes.length; i++) {
            if (String(notes[i].id) === String(note.id)) { notes.splice(i, 1); break; }
          }
          render();
          modal && modal.close();
          done && done(null);
        });
    }

    loadNotes(host, function (err, data, offline) {
      /* "正在联系拉鲁瓦…" 那个加载提示：淡出再摘。
         做成幂等的 —— 万一以后又有人在别处把回调调两遍，也不会再抛 NotFoundError。 */
      dropLoading();
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
          live: live,
          color: 'white',
          onSubmit: function (note) { addLocal(note); }
        }, function (note) {
          if (note) { notes.unshift(note); }     // 新 → 旧，所以插在头
          render();
          if (tip) {
            while (tip.firstChild) { tip.removeChild(tip.firstChild); }
            if (live) {
              tip.appendChild(el('span', null, '贴好了。板子上现在能看到你那一张。'));
            } else {
              tip.appendChild(el('span', 'bd-warn',
                '这张便签现在只贴在你自己的浏览器里 —— 布告栏还没接到服务器。'));
            }
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
    var modalRoot = document.getElementById('bd-modal');   // 首页也有这个弹层
    if (!list) { return; }
    var modal = modalRoot ? new Modal(modalRoot) : null;
    loadNotes(host, function (err, data) {
      while (list.firstChild) { list.removeChild(list.firstChild); }
      var n = Math.min(data.length, 3);
      for (var i = 0; i < n; i++) {           // 随机抽出来的 1~3 张
        list.appendChild(makeNote(data[i], {
          img: img,
          mini: true,
          onOpen: function (note) { modal && showNote(modal, note, { img: img }); }
        }));
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
