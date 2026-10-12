/* ============================================================
   拉鲁瓦 —— 布告栏的管理员（超音波幼虫）
   ------------------------------------------------------------
   只跑在 /board/ 那一页（模板里带了 #bd-keeper 才会启动）。

   它做三件事：
     1. 页面打开后从右边飞进来，停在右下角的草地上，然后动翅膀歇着；
     2. 点它 → 弹出对话框（头图 + 一句闲聊）；
     3. 闲聊里那几条"带数据"的：便签多久没人贴了、有多少人来过、
        虹星上次更新是什么时候 —— 全部来自真实数据，不编。

   数据从哪来：
     · 便签：board.js 加载完会抛出 'board:notes' 事件（也挂在 window 上）
     · 访客：不蒜子写在 #busuanzi_value_site_uv / _site_pv 里的数字
     · 更新日志 / 日记：页面里那份 JSON（构建时就算好了）
     · 手写台词：data/board-keeper.toml
   ============================================================ */
(function () {
  'use strict';

  var root = document.getElementById('bd-keeper');
  if (!root) { return; }

  var metaEl = document.getElementById('bd-keeper-meta');
  var M = {};
  try { M = JSON.parse(metaEl.textContent || '{}'); } catch (e) { return; }
  if (!M.sheet) { return; }

  var SCALE = 2;                       /* 和站上其它 PMD 精灵一样，2 倍大小（整数倍，像素不糊） */
  var FLY_PX = 190;                    /* 从右边多远的地方飞进来 */
  var FLY_SPEED = 210;                 /* px/秒 */

  var btn = root.querySelector('.bd-keeper-btn');
  var cv = root.querySelector('.bd-keeper-canvas');
  var faceCv = root.querySelector('.bd-keeper-face-canvas');
  var say = document.getElementById('bd-keeper-say');
  var textEl = document.getElementById('bd-keeper-text');
  var ctx = cv.getContext('2d');
  var faceCtx = faceCv.getContext('2d');
  var dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));

  var sheet = new Image();
  var sheetReady = false;
  sheet.onload = function () { sheetReady = true; };

  function fitCanvas(c, wCss, hCss) {
    c.width = Math.round(wCss * dpr);
    c.height = Math.round(hCss * dpr);
    c.style.width = wCss + 'px';
    c.style.height = hCss + 'px';
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    return g;
  }

  var artW = M.cw || 40, artH = M.ch || 40;
  var cw2 = artW * SCALE, ch2 = artH * SCALE;
  ctx = fitCanvas(cv, cw2, ch2);
  faceCtx = fitCanvas(faceCv, cw2, ch2);

  /* ---------------- 动画 ---------------- */
  var st = {
    phase: 'fly',        /* fly → idle */
    x: FLY_PX,           /* 离落脚点还有多远（px），右为正 */
    t: 0,                /* 飞行/浮动计时 */
    frame: 0,
    frameT: 0
  };

  function animOf(name) {
    var a = M[name] || {};
    var n = Math.max(1, a.n || 1);
    var d = (a.d && a.d.length >= n) ? a.d : null;
    return { n: n, d: d };
  }
  var IDLE = animOf('idle'), WALK = animOf('walk');

  function step(anim, dt) {
    st.frameT += dt;
    var guard = 0;
    while (guard++ < 6) {
      var ms = anim.d ? anim.d[st.frame % anim.n] : 150;
      if (st.frameT < ms) { break; }
      st.frameT -= ms;
      st.frame = (st.frame + 1) % anim.n;
    }
  }

  function draw(c, img, row, frame, n) {
    if (!img || !c) { return; }
    var f = frame % Math.max(1, n);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.drawImage(img, f * artW, row * artH, artW, artH, 0, 0, c.canvas.width, c.canvas.height);
  }

  var faceFrame = (M.face && M.face.d && M.face.d[0]) || M.faceCol || 0;

  var last = 0;
  function loop(ts) {
    var dt = last ? Math.min(80, ts - last) : 16;
    last = ts;

    if (st.phase === 'fly') {
      st.x -= FLY_SPEED * dt / 1000;
      if (st.x <= 0) { st.x = 0; st.phase = 'idle'; st.frame = 0; st.frameT = 0; }
      step(WALK, dt);
    } else {
      st.t += dt;
      step(IDLE, dt);
    }
    /* 飞行时朝左（从右边过来），歇着的时候原地上下浮动一点点 */
    var bob = st.phase === 'idle' ? Math.round(Math.sin(st.t / 620) * 3) : 0;
    btn.style.transform = 'translate(' + Math.round(st.x) + 'px,' + bob + 'px)';
    draw(ctx, sheet, st.phase === 'fly' ? M.rows.walkL : M.rows.idle, st.frame,
         st.phase === 'fly' ? WALK.n : IDLE.n);

    if (!say.hidden) {
      /* 头图那 4 格其实是**四种天气/场景**的同一张脸（背景各不一样），
         连着播会一直在闪，所以固定画第一格。
         **别加"只画一次"的开关**：对话框可能在精灵图下载完之前就打开，
         那一次画的是空画布 —— 之后就再也不画了，头图永远是白的
         （本地快、线上慢，所以只在线上看得出来）。每帧重画一下最省心。 */
      draw(faceCtx, sheet, M.rows.face, faceFrame, 1);
    }
    requestAnimationFrame(loop);
  }

  /* ---------------- 时间怎么说 ---------------- */
  function ago(iso) {
    if (!iso) { return ''; }
    var t = Date.parse(iso);
    if (isNaN(t)) { return ''; }
    var s = (Date.now() - t) / 1000;
    if (s < 0) { return '刚刚'; }
    if (s < 90) { return '刚刚'; }
    var m = s / 60;
    if (m < 60) { return Math.round(m) + ' 分钟前'; }
    var h = m / 60;
    if (h < 24) { return Math.round(h) + ' 小时前'; }
    var d = h / 24;
    if (d < 2) { return '昨天'; }
    if (d < 30) { return Math.round(d) + ' 天前'; }
    /* 再往前就别用"几个月前"糊过去了，直接报日期 ——
       但必须是中文写法（2026年9月1日），别把 ISO 原样甩出来，看着是机器在说话。 */
    return cnDate(iso) || '很久很久以前';
  }

  function cnDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) { return ''; }
    return (+m[1]) + '年' + (+m[2]) + '月' + (+m[3]) + '日';
  }

  var state = { lastNoteAt: '', noteCount: 0, sawNotes: false };

  document.addEventListener('board:notes', function (e) {
    var d = (e && e.detail) || {};
    state.sawNotes = true;
    state.noteCount = (d.notes || []).length;
    state.lastNoteAt = d.notes && d.notes[0] ? (d.notes[0].at || '') : '';
  });

  function num(sel) {
    var el = document.querySelector(sel);
    var v = el ? parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10) : 0;
    return isNaN(v) ? 0 : v;
  }

  /* ---------------- 说哪一句 ---------------- */
  var pool = [];

  function build() {
    pool = [];

    if (state.lastNoteAt) {
      pool.push('上一次有人贴便签，是在 ' + ago(state.lastNoteAt) + '那一会哦！');
    } else if (state.sawNotes) {
      pool.push('板子上还一张便签都没有呢……你要不要当第一个？');
    }

    /* 访客数读侧栏「访客统计」挂件里不蒜子填好的那两个数（页面上只有这一份）。
       它还没填完时是 "------"，num() 会算成 0，那就干脆不说这条。 */
    var uv = num('#busuanzi_value_site_uv');
    var pv = num('#busuanzi_value_site_pv');
    if (uv > 0) {
      var s = '最近，有 ' + uv.toLocaleString('zh-CN') + ' 人来过星虹巢呢。';
      if (pv > 0 && pv >= uv) {
        var avg = pv / uv;
        s += avg >= 1.5 ? '算下来平均每人来了 ' + avg.toFixed(1) + ' 次哦！' : '大家看一眼就走了，多坐一会儿嘛。';
      }
      pool.push(s);
    }

    if (M.lastUp && M.lastUp.date) {
      pool.push('听说了吗？虹星在 ' + ago(M.lastUp.date) + '更新了「' + M.lastUp.title + '」哦！');
    }
    if (M.lastPost && M.lastPost.date) {
      pool.push('日记那边，虹星 ' + ago(M.lastPost.date) + '写了《' + M.lastPost.title + '》，你看了没有？');
    }

    (M.lines || []).forEach(function (t) { if (t) { pool.push(t); } });

    if (!pool.length) { pool.push('……唔，今天没什么可说的。你就当我在这儿看门吧。'); }
  }

  var lastSaid = '';
  function sayOne() {
    build();
    var t = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && t === lastSaid) {
      t = pool[(pool.indexOf(t) + 1) % pool.length];
    }
    lastSaid = t;
    textEl.textContent = t;
  }

  function close() { say.hidden = true; }
  function toggle() {
    if (say.hidden) { sayOne(); say.hidden = false; } else { close(); }
  }

  btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
  document.addEventListener('click', function (e) {
    if (!say.hidden && !root.contains(e.target)) { close(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.keyCode === 27) { close(); }
  });

  /* ---------------- 起飞 ---------------- */
  sheet.src = M.sheet;
  requestAnimationFrame(loop);

  /* 不蒜子的数字是异步填的，头几秒可能还是 0 —— 等它几轮再定稿 */
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (num('#busuanzi_value_site_uv') > 0 || tries > 20) { clearInterval(timer); }
  }, 500);
})();
