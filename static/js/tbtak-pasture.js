/* ============================================================
   始祖小鸟页面（/tobitaiaaken/）的放养区
   ------------------------------------------------------------
   页面最底下、留言板上面那一格：从繁盛之森里随机来 1~2 位，
   在草皮上来回走、时不时蹦一下；点一下可以摸摸他，会说一句话。
   背景沿用侧栏那只放养区的天空（js/pkmn-sky.js），天气和时间走
   js/pkmn-weather.js 那一份。

   和侧栏那只的三处不同：
     1. 一次出现 1~2 位，不是一位；庞特斯 / 德蕊艾德 / 以格尼斯是
        幼驯染三人组（名单里的 group = "trio"），**一次最多出现其中一位**
        —— 抽签抽的是「名额」，抽中三人组再从三只里随机挑一只。
     2. 素材是本站游戏工程里的 RPG Maker 走图（一行 3 帧 × 4 行 = 下/左/右/上）
        和 96×96 的半身像，由 tools/build-tbtak.py 拼成精灵表。
     3. 没有睡觉那套（没写这个需求），晚上只会说 night 那几句。

   点阵锐利的老规矩还是两条：画布 width/height 用设备像素、CSS 尺寸 = 设备像素 ÷ dpr；
   元素位置吸到整设备像素（snap）。走图里的 1 个像素是美术像素，按整数倍放大。

   调试开关：
     ?tbtak=fliegen,hoshi   强制上场的是谁（逗号分隔的 id）
     ?tbtak=random          强制重抽（无视这一标签页里记住的那份）
     ?tbtak-debug=1         暴露 window.__tbtak
     ?pkmn-weather= / ?pkmn-time=   只看背景（和侧栏那只共用同一套开关）
   ============================================================ */
(function () {
  'use strict';

  var host = document.getElementById('tbtak-pasture');
  if (!host) return;
  var idxEl = document.getElementById('tbtak-index');
  if (!idxEl) return;

  var CAST = {};
  try { CAST = (JSON.parse(idxEl.textContent || '{}').cast) || {}; } catch (e) { return; }
  var IDS = Object.keys(CAST);
  if (!IDS.length) return;

  var pen = document.getElementById('tbtak-pen');
  var skyCv = document.getElementById('tbtak-sky');
  var faceCv = document.getElementById('tbtak-face');
  var nameEl = document.getElementById('tbtak-name');
  var kindEl = document.getElementById('tbtak-kind');
  var lineEl = document.getElementById('tbtak-line');
  var hintEl = document.getElementById('tbtak-hint');
  var iconWeatherCv = document.getElementById('tbtak-icon-weather');
  var iconTimeCv = document.getElementById('tbtak-icon-time');
  if (!pen || !faceCv || !lineEl) return;

  var ASSET = host.getAttribute('data-base') || 'tbtak/';
  // 天气 / 时间图标用的还是侧栏那只那张表（画一次两边共用，见 build-pkmn.py）
  var ICON_SHEET = host.getAttribute('data-icons') || '';

  // 精灵表的行号（和 tools/build-tbtak.py 里写死的一致）
  var ROW = { down: 0, left: 1, right: 2, sh: 3, face: 4 };
  var WALK = [0, 1, 2, 1];          // 走路的帧循环：左步 → 站住 → 右步 → 站住
  var SLOT = { normal: 0, smile: 1, nag: 2, wake: 3 };
  var FACE_S = 1;                   // 脸图 96×96：1 设备像素 = 1 美术像素
  var ICON_S = 2;                   // 图标 24×24 → 48 设备像素（和侧栏那只一样）
  var ICON_SIZE = 24;
  var ICON_KEYS = ['clear', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'thunder',
                   'dawn', 'day', 'dusk', 'night'];

  var SPEED_ART = 22;               // 走动速度（美术像素/秒）
  var HOP_ART = 5;                  // 跳跃高度（美术像素）
  var GROUND_DEV = 40;              // 脚底线距围栏底部多少设备像素（草地 56 设备像素高）
  var DEPTH_DEV = 9;                // 后排那位站得高一点，看起来有前后
  var MAX_LINE_HIT = 120;           // 点围栏时，只摸这个范围内最近的那位（CSS px）

  var dpr = window.devicePixelRatio || 1;
  var SS = null;
  try { SS = window.sessionStorage; } catch (e) { SS = null; }

  // ---------------- 天气 / 时间（共用 pkmn-weather.js + pkmn-sky.js） ----------------
  var WX = window.PkmnWeather || null;
  function query(name) {
    var m = location.search.match(new RegExp('[?&]' + name + '=([^&]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  var forcedWeather = query('pkmn-weather');
  var forcedTime = query('pkmn-time');
  var forcedHour = null;      // 调试时点名的时刻（__tbtak.sky 的第三个参数）
  var weather = null;
  var sky = (skyCv && window.PkmnSky) ? window.PkmnSky.create(skyCv, ASSET) : null;
  var iconImg = null;

  function timePart() { return WX ? WX.timePart(null, forcedTime) : 'day'; }
  function isNight() { return WX ? WX.isNight() : false; }

  function syncSky() {
    if (!sky) return;
    // 第三个参数是带分钟的真实时刻：天空按它连续变化（傍晚一点点暗下去）；
    // 用 ?pkmn-time= 固定时段时用 forcedHour（调试点名的时刻），没有就让天空
    // 用那一桶的代表时刻。
    sky.set(forcedWeather || weather || 'clear', timePart(),
            forcedTime ? forcedHour : (WX ? WX.hourFloat() : null));
  }

  function drawIcon(cv, key) {
    if (!cv || !iconImg) return;
    var col = ICON_KEYS.indexOf(key);
    if (col < 0) { cv.style.display = 'none'; return; }
    var dev = ICON_SIZE * ICON_S;
    if (cv.width !== dev) setupCanvas(cv, dev, dev);
    if (cv.style.display === 'none') cv.style.display = '';
    var c = cv.getContext('2d');
    c.clearRect(0, 0, dev, dev);
    c.drawImage(iconImg, col * ICON_SIZE, (isNight() ? 1 : 0) * ICON_SIZE,
                ICON_SIZE, ICON_SIZE, 0, 0, dev, dev);
  }

  function refreshIcons() {
    var w = forcedWeather || weather;
    if (weatherIconKey(w)) {
      drawIcon(iconWeatherCv, WX && WX.W_ALIAS[w] ? WX.W_ALIAS[w] : w);
      if (iconWeatherCv) iconWeatherCv.title = '外面：' + ((WX && WX.WEATHER_LABEL[w]) || w);
    } else if (iconWeatherCv) {
      iconWeatherCv.style.display = 'none';
    }
    if (iconTimeCv) {
      var p = timePart();
      drawIcon(iconTimeCv, p);
      iconTimeCv.title = '现在：' + ((WX && WX.TIME_LABEL[p]) || p);
    }
  }

  function weatherIconKey(w) {
    if (!w) return null;
    return ICON_KEYS.indexOf(w) >= 0 ? w : (WX && WX.W_ALIAS[w]) || null;
  }

  // ---------------- 选谁上场 ----------------
  // 抽的是「名额」：符利根 / 虹星 / 桃桃加 各占一个名额，三人组占一个名额
  // （抽中之后从三只里随机挑一位）。一次上 1~2 位。
  var KEY = 'tbtak.pasture.v1';
  var forced = query('tbtak');

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function drawCast() {
    var solo = [], trio = [];
    for (var i = 0; i < IDS.length; i++) {
      (CAST[IDS[i]].g === 'trio' ? trio : solo).push(IDS[i]);
    }
    var slots = solo.slice();
    if (trio.length) slots.push('@trio');
    shuffle(slots);
    var want = Math.random() < 0.5 ? 1 : 2;      // 一次 1 位或 2 位
    var out = [];
    for (var k = 0; k < slots.length && out.length < want; k++) {
      if (slots[k] === '@trio') out.push(trio[Math.floor(Math.random() * trio.length)]);
      else out.push(slots[k]);
    }
    return out;
  }

  function pickCast() {
    if (forced && forced !== 'random') {
      var want = forced.split(',').map(function (s) { return s.trim(); })
                       .filter(function (id) { return CAST[id]; });
      if (want.length) return want.slice(0, 2);
    }
    if (forced !== 'random' && SS) {
      try {
        var sv = JSON.parse(SS.getItem(KEY) || 'null');
        if (sv && sv.length && sv.every(function (id) { return CAST[id]; })) return sv;
      } catch (e) {}
    }
    var out = drawCast();
    if (SS) { try { SS.setItem(KEY, JSON.stringify(out)); } catch (e) {} }
    return out;
  }

  // ---------------- 尺寸 / 缩放 ----------------
  var penW = pen.clientWidth || 780;
  var penH = pen.clientHeight || 180;
  var S = 2;

  function setupCanvas(cv, wDev, hDev) {
    cv.width = wDev;
    cv.height = hDev;
    cv.style.width = (wDev / dpr) + 'px';
    cv.style.height = (hDev / dpr) + 'px';
    var c = cv.getContext('2d');
    c.imageSmoothingEnabled = false;
    return c;
  }

  // 位置吸到整设备像素（和侧栏那只同一个理由：半像素会让整张图被重采样）
  function snap(v) { return Math.round(v * dpr) / dpr; }

  function reduceMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  var REDUCED = reduceMotion();

  // ---------------- 每一位 ----------------
  var chars = [];
  var speakers = [];
  var current = null;

  function loadCast() {
    var ids = pickCast();
    for (var i = 0; i < ids.length; i++) {
      var c = {
        id: ids[i], meta: CAST[ids[i]],
        img: new Image(), ready: false,
        cv: null, ctx: null, shCv: null, shCtx: null,
        x: 0, hop: 0, dir: 1, task: null, t: 0,
        anim: 'down', frame: 1, frameT: 0, lastKind: null,
        petN: 0, petT: 0, faceTimer: null,
        talk: null, recent: [], slot: 0
      };
      c.cv = document.createElement('canvas');
      c.shCv = document.createElement('canvas');
      c.cv.className = 'tbtak-sprite';
      c.shCv.className = 'tbtak-shadow';
      pen.appendChild(c.shCv);
      pen.appendChild(c.cv);
      c.img.onload = (function (cc) {
        return function () { cc.ready = true; layoutChar(cc); place(cc); drawChar(cc, 1); };
      })(c);
      c.img.onerror = (function (cc) {
        return function () { if (cc.cv && cc.cv.parentNode) cc.cv.parentNode.removeChild(cc.cv); };
      })(c);
      c.img.src = ASSET + 'sprite/' + c.id + '.png';
      chars.push(c);
    }
    layout();
  }

  function layoutChar(c) {
    var m = c.meta;
    c.devW = m.cw * S;
    c.devH = m.ch * S;
    c.cssW = c.devW / dpr;
    c.cssH = c.devH / dpr;
    c.ctx = setupCanvas(c.cv, c.devW, c.devH);
    c.shDevW = m.sh.w * S;
    c.shDevH = m.sh.h * S;
    c.shCssW = c.shDevW / dpr;
    c.shCssH = c.shDevH / dpr;
    c.shCtx = setupCanvas(c.shCv, c.shDevW, c.shDevH);
    // 脚底线：草地有 56 设备像素高，站位在里面。后排那位站高一点 = 有前后。
    c.ground = (GROUND_DEV + (chars.length - 1 - chars.indexOf(c)) * DEPTH_DEV) / dpr;
    c.cv.style.zIndex = String(10 + chars.indexOf(c) * 2);
    c.shCv.style.zIndex = String(9 + chars.indexOf(c) * 2);
    c.art2css = S / dpr;
  }

  function drawChar(c, col) {
    var row = c.anim === 'left' ? ROW.left : (c.anim === 'right' ? ROW.right : ROW.down);
    var m = c.meta;
    if (!c.ready) return;
    c.ctx.clearRect(0, 0, c.devW, c.devH);
    c.ctx.drawImage(c.img, col * m.cw, row * m.ch, m.cw, m.ch,
                    0, 0, m.cw * S, m.ch * S);
  }

  function drawShadow(c) {
    var m = c.meta;
    c.shCtx.clearRect(0, 0, c.shDevW, c.shDevH);
    c.shCtx.globalAlpha = Math.max(0.4, 1 - 0.5 * (c.hop / (HOP_ART * c.art2css)));
    c.shCtx.drawImage(c.img, m.sh.x, ROW.sh * m.ch + m.sh.y, m.sh.w, m.sh.h,
                      0, 0, c.shDevW, c.shDevH);
    c.shCtx.globalAlpha = 1;
  }

  function place(c) {
    c.cv.style.left = snap(c.x - c.cssW / 2) + 'px';
    c.cv.style.top = snap(penH - c.ground - c.cssH - c.hop) + 'px';
    c.shCv.style.left = snap(c.x - c.shCssW / 2) + 'px';
    c.shCv.style.top = snap(penH - c.ground - c.shCssH) + 'px';
  }

  function band(c) {
    var i = chars.indexOf(c), half = c.cssW / 2;
    var lo = Math.min(half + 6, penW / 2), hi = Math.max(penW - half - 6, penW / 2);
    // 一位的时候整条草皮都是他的；两位的时候各占一半、中间不重叠 ——
    // 不然两张画布叠在一起看着就像只有一位（后排那位还容易被挡住）
    if (chars.length < 2) return [lo, hi];
    if (i === 0) return [lo, Math.max(lo, penW * 0.44)];
    return [Math.min(hi, penW * 0.56), hi];
  }

  // ---------------- 走 / 跳 ----------------
  function hopArc(t, period, air) {
    air = air || period * 0.62;
    var ph = t % period;
    if (ph > air) return 0;
    return Math.sin(Math.PI * ph / air) * (HOP_ART * (S / dpr));
  }

  function setAnim(c, key) {
    if (c.anim === key) return;
    c.anim = key;
    c.frame = 1;            // WALK[1] 就是「站住」那一帧，三个方向都先摆这一帧
    c.frameT = 0;
    drawChar(c, WALK[1]);
  }

  function pickTask(c) {
    c.t = 0;
    if (REDUCED) { c.task = { kind: 'idle', dur: 3 }; return; }
    if (c.lastKind && c.lastKind !== 'idle' && Math.random() < 0.7) {
      c.lastKind = 'idle';
      c.task = { kind: 'idle', dur: 0.8 + Math.random() * 2.4 };
      return;
    }
    var r = Math.random();
    var b = band(c), half = c.cssW / 2;
    if (r < 0.5) {
      var dist = (30 + Math.random() * 180) * (S / dpr);
      var dir = Math.random() < 0.5 ? -1 : 1;
      var to = c.x + dir * dist;
      if (to < b[0] || to > b[1]) to = c.x - dir * dist;
      to = Math.max(b[0], Math.min(b[1], to));
      c.dir = to >= c.x ? 1 : -1;
      c.lastKind = 'walk';
      c.task = { kind: 'walk', from: c.x, to: to,
                 dur: Math.max(0.6, Math.abs(to - c.x) / (SPEED_ART * (S / dpr))),
                 hopP: Math.random() < 0.5 ? (0.44 + Math.random() * 0.2) : 0 };
    } else if (r < 0.68) {
      c.lastKind = 'jump';
      c.task = { kind: 'jump', dur: 0.8 + Math.random() * 0.6, n: 1 + Math.floor(Math.random() * 3) };
    } else {
      c.lastKind = 'idle';
      c.task = { kind: 'idle', dur: 1.2 + Math.random() * 2.6 };
    }
  }

  function step(c, dt) {
    if (!c.ready) return;
    if (!c.task) pickTask(c);
    c.t += dt;
    var task = c.task;
    if (task.kind === 'walk') {
      var p = Math.min(1, c.t / task.dur);
      c.x = task.from + (task.to - task.from) * p;
      setAnim(c, c.dir < 0 ? 'left' : 'right');
      c.hop = task.hopP ? hopArc(c.t, task.hopP) : 0;
      if (c.t >= task.dur) { c.task = null; c.hop = 0; }
    } else if (task.kind === 'jump') {
      setAnim(c, 'down');
      var hp = task.dur / task.n;
      c.hop = hopArc(c.t, hp, hp * 0.78);
      if (c.t >= task.dur) { c.task = null; c.hop = 0; }
    } else {
      setAnim(c, 'down');
      c.hop = 0;
      if (c.t >= task.dur) c.task = null;
    }
    // 走图一格 frame_ms 毫秒；站着不动就停在中间那帧
    var d = c.meta.d || [190, 190, 190];
    c.frameT += dt * 1000;
    while (c.frameT >= d[c.frame % d.length] && c.anim !== 'down') {
      c.frameT -= d[c.frame % d.length];
      c.frame = (c.frame + 1) % WALK.length;
      drawChar(c, WALK[c.frame]);
    }
    place(c);
    drawShadow(c);
  }

  // ============================================================
  //  说话
  // ============================================================
  function typeLine(text) {
    if (typer) { clearInterval(typer); typer = null; }
    if (REDUCED) { lineEl.textContent = text; return; }
    lineEl.textContent = '';
    var i = 0, n = text.length;
    typer = setInterval(function () {
      i += 1;
      lineEl.textContent = text.slice(0, i);
      if (i >= n) { clearInterval(typer); typer = null; }
    }, 34);
  }
  var typer = null;

  function drawFace(c, slot) {
    var f = c.meta.f, col = f.c[slot] == null ? 0 : f.c[slot];
    var dev = f.w * FACE_S;
    if (faceCv.width !== dev || faceCv.height !== dev) setupCanvas(faceCv, dev, dev);
    var ctx = faceCv.getContext('2d');
    ctx.clearRect(0, 0, dev, dev);
    if (!c.ready) return;
    ctx.drawImage(c.img, col * c.meta.cw + f.x, ROW.face * c.meta.ch + f.y, f.w, f.h,
                  0, 0, f.w * FACE_S, f.h * FACE_S);
  }

  function showFace(c, slot) {
    c.slot = slot;
    if (current !== c) return;
    drawFace(c, slot);
    if (c.faceTimer) clearTimeout(c.faceTimer);
    c.faceTimer = setTimeout(function () {
      c.faceTimer = null;
      if (current === c) drawFace(c, SLOT.normal);
    }, 2000);
  }

  function speak(c, text, slot) {
    if (!text) return;
    current = c;
    if (nameEl) nameEl.textContent = c.meta.n;
    if (kindEl) kindEl.textContent = (c.meta.kind ? c.meta.kind + '・' : '') + (c.meta.en || '');
    drawFace(c, slot == null ? SLOT.normal : slot);
    if (hintEl && hintEl.parentNode && chars.length) {
      hintEl.parentNode.removeChild(hintEl);
      hintEl = null;
    }
    typeLine(text);
  }

  function pickLine(c, arr) {
    if (!arr || !arr.length) return null;
    if (arr.length === 1) return arr[0];
    for (var i = 0; i < 8; i++) {
      var s = arr[Math.floor(Math.random() * arr.length)];
      if (c.recent.indexOf(s) < 0) {
        c.recent.push(s);
        if (c.recent.length > 8) c.recent.shift();
        return s;
      }
    }
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function poolOf(c) {
    if (!c.talk) return null;
    var p = [];
    if (isNight() && c.talk.night && c.talk.night.length) p = p.concat(c.talk.night, c.talk.night);
    if (c.talk.idle && c.talk.idle.length) p = p.concat(c.talk.idle);
    return p;
  }

  var talkIn = 22;
  function tickTalk(dt) {
    talkIn -= dt;
    if (talkIn > 0) return;
    var ready = chars.filter(function (c) { return c.talk; });
    talkIn = 18 + Math.random() * 26;
    if (!ready.length) return;
    var c = ready[Math.floor(Math.random() * ready.length)];
    var line = pickLine(c, poolOf(c));
    if (line) speak(c, line);
  }

  // ---------------- 摸他 ----------------
  function pet(c) {
    if (!c.ready) return;
    var now = Date.now();
    if (now - c.petT < 3000) c.petN += 1; else c.petN = 1;
    c.petT = now;
    var over = c.petN >= 4;
    if (c.talk) {
      var arr = (over && c.talk.pet_more && c.talk.pet_more.length) ? c.talk.pet_more : c.talk.pet;
      speak(c, pickLine(c, arr), over ? SLOT.nag : SLOT.smile);
    } else {
      speak(c, '……', over ? SLOT.nag : SLOT.smile);
    }
    showFace(c, over ? SLOT.nag : SLOT.smile);
    c.task = { kind: 'jump', dur: over ? 0.6 : 1.0, n: over ? 1 : 2 };
    c.lastKind = 'jump';
    c.t = 0;
    // 摸到谁，谁就往中间挪一点，免得躲在边角
    var b = band(c);
    c.x = Math.max(b[0], Math.min(b[1], c.x));
  }

  pen.addEventListener('click', function (ev) {
    if (!chars.length) return;
    var r = pen.getBoundingClientRect();
    var x = ev.clientX - r.left;
    var best = null, bd = 1e9;
    for (var i = 0; i < chars.length; i++) {
      var d = Math.abs(x - chars[i].x);
      if (d < bd) { bd = d; best = chars[i]; }
    }
    if (best && bd <= MAX_LINE_HIT) pet(best);
  });

  // ---------------- 布局 / 启动 ----------------
  function layout() {
    penW = pen.clientWidth || penW;
    penH = pen.clientHeight || penH;
    S = Math.max(1, Math.round(dpr * 1.5));
    if (sky) sky.resize();
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      layoutChar(c);
      var b = band(c);
      if (!c.x) c.x = b[0] + (b[1] - b[0]) * (chars.length > 1 ? (0.3 + 0.4 * i) : 0.5);
      c.x = Math.max(b[0], Math.min(b[1], c.x));
      if (c.ready) { drawChar(c, c.anim === 'down' ? 1 : WALK[c.frame]); place(c); drawShadow(c); }
    }
  }

  function start() {
    layout();
    syncSky();
    if (isNight()) document.documentElement.className += ' tbtak-night';
    if (ICON_SHEET && (iconWeatherCv || iconTimeCv)) {
      iconImg = new Image();
      iconImg.onload = function () { refreshIcons(); };
      iconImg.src = ICON_SHEET;
    }
    if (!forcedWeather && host.getAttribute('data-weather') && WX) {
      WX.load(function (w) {
        weather = w;
        syncSky();
        refreshIcons();
      });
    } else {
      refreshIcons();
    }

    // 台词按需下载（一人一个文件）
    for (var i = 0; i < chars.length; i++) {
      (function (c) {
        if (!window.fetch) return;
        fetch(ASSET + 'talk/' + c.id + '.json')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (d) c.talk = d; })
          .catch(function () {});
      })(chars[i]);
    }

    // 开场：先说一句招呼
    setTimeout(function () {
      var c = chars[0];
      if (c && c.talk && c.talk.greet && c.talk.greet.length) {
        speak(c, pickLine(c, c.talk.greet));
      }
    }, 1400);

    if (/[?&]tbtak-debug=1/.test(location.search)) {
      window.__tbtak = {
        cast: function () { return chars.map(function (c) { return c.id; }); },
        // 抽签本身是纯函数，单独暴露出来方便验证「三人组不会同时出现」
        pick: function () { return drawCast(); },
        chars: chars,
        state: function () {
          return chars.map(function (c) {
            return { id: c.id, x: Math.round(c.x), anim: c.anim, hop: +c.hop.toFixed(1),
                     task: c.task && c.task.kind, ready: c.ready, talk: !!c.talk };
          });
        },
        weather: function () { return forcedWeather || weather; },
        timePart: timePart,
        sky: function (w, p, h) {
          if (!sky) return null;
          if (w) {
            forcedWeather = w;
            if (p) forcedTime = p;
            forcedHour = (typeof h === 'number') ? h : null;
            syncSky();
            refreshIcons();
          }
          return sky.state();
        },
        say: function (id, text) {
          for (var k = 0; k < chars.length; k++) {
            if (chars[k].id === id) { speak(chars[k], text || '（测试）'); return true; }
          }
          return false;
        },
        pet: function (i) { pet(chars[i || 0]); }
      };
    }

    var last = 0;
    function loop(ts) {
      requestAnimationFrame(loop);
      if (document.hidden) { last = 0; return; }
      if (!last) { last = ts; return; }
      var dt = (ts - last) / 1000;
      last = ts;
      if (dt > 0.12) dt = 0.12;
      for (var i = 0; i < chars.length; i++) step(chars[i], dt);
      tickTalk(dt);
      if (sky) sky.tick(dt);
      // 天色是连续变的：每 60 秒同步一次真实时刻；
      // 时段图标（早/中/晚/夜）每 4 秒查一次，换了才重画
      skyT += dt;
      if (skyT >= 60) { skyT = 0; syncSky(); }
      clockT += dt;
      if (clockT > 4) {
        clockT = 0;
        var p = timePart();
        if (p !== lastPart) {
          lastPart = p;
          syncSky();
          refreshIcons();
        }
      }
    }
    var clockT = 0, skyT = 0, lastPart = timePart();
    if (REDUCED) for (var k = 0; k < chars.length; k++) { place(chars[k]); drawShadow(chars[k]); }
    requestAnimationFrame(loop);

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { layout(); }, 200);
    });
  }

  loadCast();
  start();
})();
