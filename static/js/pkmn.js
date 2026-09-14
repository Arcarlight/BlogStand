/* ============================================================
   宝可梦放养区
   ------------------------------------------------------------
   侧栏挂件：随机放一只宝可梦在栏里走动/跳跃，点一下可以摸它，
   它会换笑脸说一句；平时过一会儿也会自己嘟囔一句，台词按
   「当前页面类型 + 访客当地天气 + 深夜」挑。

   素材是 PMD 精灵表（PMDCollab SpriteCollab，CC BY-NC 4.0），
   已经由 tools/build-pkmn.py 重新拼成「一只一张」的精灵表，
   每张 5 行：0=Idle下 1=Walk左 2=Walk右 3=脸图 4=影子。

   点阵锐利的两条规矩（和站里的点阵字体一样）：
     1. 画布 width/height 用设备像素，CSS 尺寸 = 设备像素 / dpr，
        放大倍数是整数（美术像素 × 2 或 3 = 设备像素）；
     2. 元素位置用 snap() 吸到整设备像素上，否则半像素会让整张图被重采样。

   调试开关（不写进文档也没关系）：
     ?pkmn=445     强制放某一只（图鉴号，方便一只一只看效果）
     ?pkmn=random  强制重抽
   ============================================================ */
(function () {
  'use strict';

  var widget = document.getElementById('pkmn-pasture');
  if (!widget) return;
  var idxEl = document.getElementById('pkmn-index');
  if (!idxEl) return;

  var INDEX;
  try { INDEX = JSON.parse(idxEl.textContent || '{}'); } catch (e) { return; }
  var SHEET = INDEX.sheet || {};
  var allDex = Object.keys(SHEET);
  if (!allDex.length) return;

  var pen = document.getElementById('pasture-pen');
  var spriteCv = document.getElementById('pasture-sprite');
  var shadowCv = document.getElementById('pasture-shadow');
  var faceCv = document.getElementById('pkmn-face');
  var nameEl = document.getElementById('pkmn-name');
  var moodEl = document.getElementById('pkmn-mood');
  var lineEl = document.getElementById('pkmn-line');
  var hintEl = document.getElementById('pasture-hint');
  var creditEl = document.getElementById('pkmn-credit');
  var weatherIconCv = document.getElementById('pkmn-icon-weather');
  var timeIconCv = document.getElementById('pkmn-icon-time');
  var zzzA = document.getElementById('pkmn-zzz-a');
  var zzzB = document.getElementById('pkmn-zzz-b');
  if (!pen || !spriteCv || !shadowCv || !faceCv || !lineEl) return;

  var ASSET = widget.getAttribute('data-base') || 'pkmn/';
  var ROW = { i: 0, wl: 1, wr: 2, face: 3, sh: 4, sl: 5 };
  var FACE_S = 2;          // 脸图固定 2 设备像素 = 1 美术像素（40×40 → 80×80 设备像素）
  var ICON_S = 2;          // 天气 / 时间图标同样整倍放大（24 → 48 设备像素 = 32 CSS px）
  var FACE_NORMAL = 0, FACE_SMILE = 1, FACE_NAG = 2, FACE_WAKE = 3;
  var GROUND = 14;         // 脚底线距围栏底部多少 CSS px
  var SPEED_ART = 18;      // 走动速度（美术像素/秒）
  var HOP_ART = 7;         // 跳跃高度（美术像素）
  // 天气桶对不上时的退路
  var W_ALIAS = { drizzle: 'rain', fog: 'cloudy' };

  // 作息：夜里 = 22:00–06:00。meta.z 是「什么时候睡」：
  //   "night" = 夜里睡（白天活动的普通宝可梦，多数）
  //   "day"   = 白天睡（夜行性那 8 只：勾魂眼、诅咒娃娃、黑夜魔灵、水晶灯火灵、
  //             电灯怪、伊裴尔塔尔、谜拟丘、狙射树枭）
  var NIGHT_FROM = 22, NIGHT_TO = 6;
  // 在同一个页面停留超过这么久也会开始打瞌睡（分钟）
  var DOZE_MINUTES = 10;
  // 被戳醒之后能撑多久（秒）——之后如果还是它的睡觉时段就再睡回去
  var AWAKE_AFTER_WAKE = [120, 360];

  var WEATHER_LABEL = { clear: '晴', cloudy: '阴', fog: '雾', drizzle: '小雨',
                        rain: '雨', snow: '雪', thunder: '雷雨' };
  var TIME_LABEL = { dawn: '早上', day: '白天', dusk: '傍晚', night: '深夜' };

  var dpr = window.devicePixelRatio || 1;
  var SS = null;
  try { SS = window.sessionStorage; } catch (e) { SS = null; }

  // ---------------- 选一只 ----------------
  // 「每次打开网页随机，翻页不变」→ 记在 sessionStorage 里（同一个标签页内翻页不会换，
  // 关掉标签页重新打开才会重抽）。
  var KEY = 'pkmn.pasture.v1';
  var forced = (location.search.match(/[?&]pkmn=([^&]+)/) || [])[1];
  var dex = null;
  if (forced && forced !== 'random' && SHEET[forced]) {
    dex = String(forced);
  } else if (forced !== 'random' && SS) {
    try {
      var sv = JSON.parse(SS.getItem(KEY) || 'null');
      if (sv && SHEET[sv]) dex = String(sv);
    } catch (e) {}
  }
  if (!dex) dex = allDex[Math.floor(Math.random() * allDex.length)];
  if (SS) { try { SS.setItem(KEY, JSON.stringify(dex)); } catch (e) {} }

  var meta = SHEET[dex];
  if (!meta) return;

  // ---------------- 尺寸 / 缩放 ----------------
  var penW = pen.clientWidth || 280;
  var penH = pen.clientHeight || 150;
  var S = 2;               // 默写死 2，马上会被算出来（避免 img 没到时报错）
  var art2css = 1;         // 1 美术像素等于多少 CSS px
  var spriteW = 0, spriteH = 0;
  var spriteCtx = null, faceCtx = null, shadowCtx = null;
  var shK = 0;             // 影子当前的放大倍数，0 = 还没画过
  var shW = 0, shH = 0;

  function setupCanvas(cv, wDev, hDev) {
    cv.width = wDev;
    cv.height = hDev;
    cv.style.width = (wDev / dpr) + 'px';
    cv.style.height = (hDev / dpr) + 'px';
    var c = cv.getContext('2d');
    c.imageSmoothingEnabled = false;
    return c;
  }

  function computeScale() {
    // 基准放大：屏幕越密越放大；再给小个子（格子矮的）多一档，免得小小一只缩在角落
    var base = Math.min(4, Math.max(2, Math.round(dpr * 1.5)));
    var maxDev = (penH - GROUND - 4) * dpr;
    S = base;
    if (meta.ch * (S + 1) <= maxDev) S += 1;
    while (S > 1 && meta.ch * S > maxDev) S -= 1;
    art2css = S / dpr;
  }

  var img = new Image();
  img.onload = function () { start(); };
  img.onerror = function () {
    if (lineEl) lineEl.textContent = '……它好像跑丢了。';
  };
  img.src = ASSET + 'sprite/' + dex + '.png';

  // ---------------- 画 ----------------
  function drawSprite(key, frame) {
    var a = meta[key] || meta.i;
    var n = (a.d && a.d.length) || 1;
    if (frame >= n) frame = 0;
    spriteCtx.clearRect(0, 0, spriteCv.width, spriteCv.height);
    spriteCtx.drawImage(img, frame * meta.cw, ROW[key] * meta.ch, meta.cw, meta.ch,
                        0, 0, meta.cw * S, meta.ch * S);
  }

  function drawFace(slot) {
    var f = meta.f;
    var col = (f.c && f.c[slot] != null) ? f.c[slot] : 0;
    faceCtx.clearRect(0, 0, faceCv.width, faceCv.height);
    faceCtx.drawImage(img, col * meta.cw + f.x, ROW.face * meta.ch + f.y, f.w, f.h,
                      0, 0, f.w * FACE_S, f.h * FACE_S);
  }

  var lastShA = -1, lastShK = -1;
  function drawShadow(alpha, k) {
    alpha = Math.round(alpha * 20) / 20;
    if (alpha === lastShA && k === lastShK) return;
    lastShA = alpha;
    lastShK = k;
    var s = meta.s;
    var wDev = s.w * k, hDev = s.h * k;
    if (shK !== k) {
      shadowCtx = setupCanvas(shadowCv, wDev, hDev);
      shK = k;
      shW = wDev / dpr;
      shH = hDev / dpr;
    }
    shadowCtx.clearRect(0, 0, wDev, hDev);
    shadowCtx.globalAlpha = alpha;
    shadowCtx.drawImage(img, s.x, ROW.sh * meta.ch + s.y, s.w, s.h, 0, 0, wDev, hDev);
    shadowCtx.globalAlpha = 1;
  }

  // 位置必须吸到整设备像素：150% 缩放下 1 CSS px = 1.5 设备像素，
  // 落在小数上的话浏览器会把画布重新采样一遍，点阵立刻发虚。
  function snap(v) { return Math.round(v * dpr) / dpr; }

  // 睡着的时候，Z 飘在它头顶偏右上的位置（位置跟着精灵走，所以写在 place 里）
  function place(x, hop) {
    spriteCv.style.left = snap(x - spriteW / 2) + 'px';
    spriteCv.style.top = snap(penH - GROUND - spriteH - hop) + 'px';
    shadowCv.style.left = snap(x - shW / 2) + 'px';
    shadowCv.style.top = snap(penH - GROUND - shH) + 'px';
    if (asleep) {
      var zx = snap(x + spriteW * 0.2), zy = snap(penH - GROUND - spriteH - hop + 1);
      if (zzzA) { zzzA.style.left = zx + 'px'; zzzA.style.top = zy + 'px'; }
      if (zzzB) { zzzB.style.left = snap(zx + 7) + 'px'; zzzB.style.top = snap(zy + 9) + 'px'; }
    }
  }

  // ---------------- 天气 / 时间图标 ----------------
  // 图标表来自 HackerNoon Pixel Icon Library（MIT / CC BY 4.0），
  // 一格 24×24、两行：第 0 行深色（白天配浅蓝天空）、第 1 行白色（夜里配深蓝天空）。
  var iconImg = null;

  function hourNow() { return (new Date()).getHours(); }

  // 早 / 中 / 晚 / 深夜 —— 也是睡觉时段判断用的同一套时间
  function timePart(h) {
    h = (h == null) ? hourNow() : h;
    if (h >= 5 && h < 11) return 'dawn';
    if (h >= 11 && h < 17) return 'day';
    if (h >= 17 && h < NIGHT_FROM) return 'dusk';
    return 'night';
  }

  function isNightNow() {
    var h = hourNow();
    return h >= NIGHT_FROM || h < NIGHT_TO;
  }

  // 现在是不是它的睡觉时段
  function sleepWindowNow() {
    var night = isNightNow();
    return meta.z === 'day' ? !night : night;
  }

  function drawIcon(cv, key) {
    var icons = INDEX.icons;
    if (!cv || !icons || !iconImg) return;
    var col = icons.keys.indexOf(key);
    if (col < 0) { cv.style.display = 'none'; return; }
    var sz = icons.size, dev = sz * ICON_S;
    if (cv.width !== dev) setupCanvas(cv, dev, dev);
    if (cv.style.display === 'none') cv.style.display = '';
    var c = cv.getContext('2d');
    c.clearRect(0, 0, dev, dev);
    c.drawImage(iconImg, col * sz, (isNightNow() ? 1 : 0) * sz, sz, sz, 0, 0, dev, dev);
  }

  function drawWeatherIcon() {
    if (!weatherIconCv) return;
    if (!weather) { weatherIconCv.style.display = 'none'; return; }
    var key = W_ALIAS[weather] || weather;
    drawIcon(weatherIconCv, key);
    weatherIconCv.title = '外面：' + (WEATHER_LABEL[weather] || weather);
  }

  function drawTimeIcon() {
    if (!timeIconCv) return;
    var key = timePart();
    drawIcon(timeIconCv, key);
    timeIconCv.title = '现在：' + (TIME_LABEL[key] || key);
  }

  function refreshIcons() {
    drawWeatherIcon();
    drawTimeIcon();
  }

  // ---------------- 行为 ----------------
  var st = {
    x: penW / 2, hop: 0, task: null, t: 0, dir: 1,
    animKey: 'i', frame: 0, frameT: 0, lastKind: null
  };

  // ---------------- 睡觉 ----------------
  // 什么时候会睡：
  //   1) 到了它的睡觉时段（meta.z 决定是夜里睡还是白天睡）—— 打开页面时就有 78% 概率
  //      已经在睡，没睡的那次过一会儿也会困；
  //   2) 在同一个页面赖着不走超过 DOZE_MINUTES 分钟，也会打起瞌睡。
  // 戳一下就醒，醒来能撑 2~6 分钟；要是还在它的睡觉时段，过一会儿又睡回去。
  var asleep = false;
  var awakeUntil = 0;            // 被戳醒后醒到什么时候
  var pageSince = Date.now();    // 这一页是什么时候打开的
  var sleepySaid = false;        // 已经说过「困了」了吗
  var sleepyAt = 0;              // 说完「困了」多久之后真睡
  // 刚打开页面先别急着困 —— 让人先看见它醒着、听一句招呼，25 秒后才开始打瞌睡
  var sleepGraceUntil = Date.now() + 25000;

  function setZzz(on) {
    if (zzzA) zzzA.hidden = !on;
    if (zzzB) zzzB.hidden = !on;
  }

  function goSleep() {
    if (asleep) return;
    asleep = true;
    st.task = null;
    st.hop = 0;
    setZzz(true);
    setAnim('sl');
    if (faceTimer) { clearTimeout(faceTimer); faceTimer = null; }
    setFace(FACE_NORMAL, '睡着了');
    if (hintEl) hintEl.textContent = '它睡着了，戳一下叫醒它';
  }

  function wakeUp() {
    if (!asleep) return;
    asleep = false;
    setZzz(false);
    awakeUntil = Date.now() + (AWAKE_AFTER_WAKE[0] + Math.random() * (AWAKE_AFTER_WAKE[1] - AWAKE_AFTER_WAKE[0])) * 1000;
    pageSince = Date.now();          // 醒了就重新计时
    sleepySaid = false;
    // 醒来先蹦两下、一脸惊醒，然后说一句
    st.task = { kind: 'jump', dur: 0.9, n: 2 };
    st.lastKind = 'jump';
    st.t = 0;
    flashFace(FACE_WAKE, '惊醒', 1800);
    if (hintEl) hintEl.textContent = '点一下可以摸摸它';
    say(talk && talk.wake && talk.wake.length ? pickLine(talk.wake) : '……唔？我睡着了？');
  }

  // 每隔几秒看一眼该不该困
  function tickSleep() {
    if (asleep) return;
    var now = Date.now();
    if (now < awakeUntil || now < sleepGraceUntil) return;
    var wantSleep = sleepWindowNow() || (now - pageSince) > DOZE_MINUTES * 60000;
    if (!wantSleep) { sleepySaid = false; return; }
    if (!sleepySaid) {
      sleepySaid = true;
      sleepyAt = now + 4500;
      say(talk && talk.sleepy && talk.sleepy.length ? pickLine(talk.sleepy) : '……有点困了。');
      return;
    }
    if (now >= sleepyAt) { sleepySaid = false; goSleep(); }
  }

  // 时间过了整点（早/中/晚/夜切换）要换图标、顺便把围栏调暗
  var clockT = 0, lastPart = null;
  function tickClock(dt) {
    clockT += dt;
    if (clockT < 4) return;
    clockT = 0;
    var part = timePart();
    if (part === lastPart) return;
    lastPart = part;
    var cls = document.documentElement.className.replace(/\s*pkmn-night/g, '');
    document.documentElement.className = cls + (isNightNow() ? ' pkmn-night' : '');
    refreshIcons();
  }

  // 系统里开了「减少动态效果」的话就别让它满地跑了，站着说话就好
  function reduceMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function hopArc(t, period, air) {
    air = air || period * 0.62;
    var ph = t % period;
    if (ph > air) return 0;
    return Math.sin(Math.PI * ph / air) * (HOP_ART * art2css);
  }

  function pickTask() {
    st.t = 0;
    if (reduceMotion()) { st.task = { kind: 'idle', dur: 3 }; return; }
    // 动完先歇一下，看起来才像在放养而不是跑步机
    if (st.lastKind && st.lastKind !== 'idle' && Math.random() < 0.75) {
      st.lastKind = 'idle';
      st.task = { kind: 'idle', dur: 0.7 + Math.random() * 2.2 };
      return;
    }
    var r = Math.random();
    var half = spriteW / 2;
    var minX = Math.min(half + 3, penW / 2);
    var maxX = Math.max(penW - half - 3, penW / 2);
    if (r < 0.45) {
      var dist = (16 + Math.random() * 80) * art2css;
      var dir = Math.random() < 0.5 ? -1 : 1;
      var to = st.x + dir * dist;
      if (to < minX || to > maxX) to = st.x - dir * dist;   // 撞到边就掉头
      to = Math.max(minX, Math.min(maxX, to));
      var dur = Math.abs(to - st.x) / (SPEED_ART * art2css);
      st.dir = to >= st.x ? 1 : -1;
      st.lastKind = 'walk';
      st.task = {
        kind: 'walk', from: st.x, to: to, dur: Math.max(0.5, dur),
        hopP: Math.random() < 0.55 ? (0.46 + Math.random() * 0.22) : 0
      };
    } else if (r < 0.62) {
      st.lastKind = 'jump';
      st.task = { kind: 'jump', dur: 0.9 + Math.random() * 0.7, n: 2 + Math.floor(Math.random() * 3) };
    } else {
      st.lastKind = 'idle';
      st.task = { kind: 'idle', dur: 1.2 + Math.random() * 2.4 };
    }
  }

  function setAnim(key) {
    if (st.animKey === key) return;
    st.animKey = key;
    st.frame = 0;
    st.frameT = 0;
    drawSprite(key, 0);
  }

  function tickAnim(dt) {
    var a = meta[st.animKey] || meta.i;
    var d = (a.d && a.d.length) ? a.d : [140];
    st.frameT += dt * 1000;
    var guard = 0;
    while (st.frameT >= d[st.frame % d.length] && guard++ < 8) {
      st.frameT -= d[st.frame % d.length];
      st.frame = (st.frame + 1) % d.length;
      drawSprite(st.animKey, st.frame);
    }
  }

  function step(dt) {
    if (asleep) {
      // 睡着了就待在原地喘气，不走路也不蹦
      setAnim('sl');
      st.hop = 0;
      tickAnim(dt);
      place(st.x, 0);
      drawShadow(1, 2);
      return;
    }
    if (!st.task) pickTask();
    st.t += dt;
    var task = st.task;
    if (task.kind === 'walk') {
      var p = Math.min(1, st.t / task.dur);
      st.x = task.from + (task.to - task.from) * p;
      setAnim(st.dir < 0 ? 'wl' : 'wr');
      st.hop = task.hopP ? hopArc(st.t, task.hopP) : 0;
      if (st.t >= task.dur) { st.task = null; st.hop = 0; }
    } else if (task.kind === 'jump') {
      setAnim('i');
      var hp = task.dur / task.n;
      st.hop = hopArc(st.t, hp, hp * 0.78);
      if (st.t >= task.dur) { st.task = null; st.hop = 0; }
    } else {
      setAnim('i');
      st.hop = 0;
      if (st.t >= task.dur) st.task = null;
    }
    tickAnim(dt);
    place(st.x, st.hop);
    drawShadow(Math.max(0.45, 1 - 0.55 * (st.hop / (HOP_ART * art2css))),
               st.hop > 4 * art2css ? 1 : 2);
  }

  // ---------------- 说话 ----------------
  var talk = null;
  var weather = null;
  var recent = [];
  var typer = null;

  function pickLine(arr) {
    if (!arr || !arr.length) return null;
    if (arr.length === 1) return arr[0];
    for (var i = 0; i < 8; i++) {
      var s = arr[Math.floor(Math.random() * arr.length)];
      if (recent.indexOf(s) < 0) {
        recent.push(s);
        if (recent.length > 8) recent.shift();
        return s;
      }
    }
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function say(text) {
    if (!text) return;
    if (typer) { clearInterval(typer); typer = null; }
    if (reduceMotion()) { lineEl.textContent = text; return; }
    lineEl.textContent = '';
    var i = 0, n = text.length;
    typer = setInterval(function () {
      i += 1;
      lineEl.textContent = text.slice(0, i);
      if (i >= n) { clearInterval(typer); typer = null; }
    }, 34);
  }

  function pageCtx() {
    return document.body.getAttribute('data-pkmn-ctx') || 'other';
  }

  // 深夜台词用的判断，和作息共用一套时间（22:00–06:00）
  function isNight() { return isNightNow(); }

  function autoPool() {
    if (!talk) return null;
    // 睡着了就说梦话（台词文件里的 sleep 那一段）
    if (asleep) return (talk.sleep && talk.sleep.length) ? talk.sleep : null;
    var pool = [];
    var page = talk.page || {};
    var mine = page[pageCtx()] || page.other || [];
    // 权重：页面语境 ×3、天气 ×2、深夜 ×2、平常 ×1。
    // 页面语境是这个挂件的主要意思（「它正在陪你看这一页」），所以给得最重；
    // 平常那池是底噪，只在没别的话说时凑数。
    pool = pool.concat(mine, mine, mine);
    if (weather) {
      var wkey = W_ALIAS[weather] || weather;
      var w = (talk.weather || {})[wkey];
      if (w && w.length) pool = pool.concat(w, w);
    }
    if (isNight() && talk.night && talk.night.length) pool = pool.concat(talk.night, talk.night);
    if (talk.idle && talk.idle.length) pool = pool.concat(talk.idle);
    return pool;
  }

  var talkIn = 4;
  function tickTalk(dt) {
    if (!talk) return;
    talkIn -= dt;
    if (talkIn > 0) return;
    var line = pickLine(autoPool());
    if (line) say(line);
    // 睡着的时候梦话少一点、间隔长一点
    talkIn = asleep ? (35 + Math.random() * 45) : (22 + Math.random() * 26);
  }

  // ---------------- 天气（IP 定位 → Open-Meteo） ----------------
  // 只在这个会话里查一次、缓存 30 分钟；任何一步失败就当作不知道天气，
  // 台词自然退回「页面 / 平常」那两池，不会卡页面。
  // 定位服务排了两家：ipwho.is 偶尔会限流（429），失败就换 get.geojs.io。
  // 两家的响应字段名一样，但 geojs 的经纬度是字符串，所以统一 parseFloat。
  var GEO = [
    { url: 'https://ipwho.is/', pick: function (j) { return j && j.success !== false ? [j.latitude, j.longitude] : null; } },
    { url: 'https://get.geojs.io/v1/ip/geo.json',
      pick: function (j) { return j ? [parseFloat(j.latitude), parseFloat(j.longitude)] : null; } }
  ];

  function wmo(code) {
    if (code === 0 || code === 1) return 'clear';
    if (code === 2 || code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return null;
  }

  function timedFetch(url, ms) {
    if (typeof AbortController === 'undefined') return fetch(url);
    var ac = new AbortController();
    setTimeout(function () { ac.abort(); }, ms);
    return fetch(url, { signal: ac.signal });
  }

  function geoAt(i) {
    if (i >= GEO.length) return Promise.reject(new Error('no geo'));
    var p = GEO[i];
    return timedFetch(p.url, 6000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var ll = p.pick(j);
        if (!ll || typeof ll[0] !== 'number' || typeof ll[1] !== 'number' ||
            isNaN(ll[0]) || isNaN(ll[1])) throw new Error('bad geo');
        return ll;
      })
      .catch(function () { return geoAt(i + 1); });
  }

  function loadWeather() {
    if (!widget.getAttribute('data-weather')) return;
    if (SS) {
      try {
        var c = JSON.parse(SS.getItem('pkmn.weather') || 'null');
        if (c && Date.now() - c.t < 30 * 60 * 1000) { weather = c.w; drawWeatherIcon(); return; }
      } catch (e) {}
    }
    geoAt(0)
      .then(function (ll) {
        return timedFetch('https://api.open-meteo.com/v1/forecast?latitude=' + ll[0] +
                          '&longitude=' + ll[1] + '&current=weather_code', 6000);
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var w = wmo(j && j.current && j.current.weather_code);
        if (!w) throw new Error('no weather');
        weather = w;
        drawWeatherIcon();     // 角上的天气图标是后到的，要补画一次
        if (SS) { try { SS.setItem('pkmn.weather', JSON.stringify({ t: Date.now(), w: w })); } catch (e) {} }
      })
      .catch(function () { weather = null; drawWeatherIcon(); });
  }

  // ---------------- 摸它 ----------------
  var petN = 0, petT = 0, faceTimer = null, faceSlot = 0;

  function setFace(slot, mood) {
    faceSlot = slot;
    drawFace(slot);
    if (moodEl) moodEl.textContent = '心情 ' + mood;
  }

  // 换个表情，过一会儿自己变回来
  function flashFace(slot, mood, ms) {
    setFace(slot, mood);
    if (faceTimer) clearTimeout(faceTimer);
    faceTimer = setTimeout(function () {
      faceTimer = null;
      if (!asleep) setFace(FACE_NORMAL, '悠闲');
    }, ms);
  }

  function pet() {
    if (asleep) { wakeUp(); return; }     // 睡着的时候戳一下 = 叫醒它
    var now = Date.now();
    if (now - petT < 3000) petN += 1; else petN = 1;
    petT = now;
    var over = petN >= 4;   // 连着摸第四次开始有点受不了
    if (talk) {
      var arr = (over && talk.pet_more && talk.pet_more.length) ? talk.pet_more : talk.pet;
      say(pickLine(arr));
    }
    // 被摸就把当前的事打断，原地蹦两下
    st.task = { kind: 'jump', dur: over ? 0.7 : 1.15, n: over ? 1 : 2 };
    st.lastKind = 'jump';
    st.t = 0;
    if (hintEl && hintEl.parentNode) {
      hintEl.parentNode.removeChild(hintEl);
      hintEl = null;
    }
    flashFace(over ? FACE_NAG : FACE_SMILE, over ? '别摸了' : '开心', over ? 1400 : 1900);
  }

  pen.addEventListener('click', pet);

  // ---------------- 启动 ----------------
  function layout() {
    penW = pen.clientWidth || penW;
    penH = pen.clientHeight || penH;
    computeScale();
    spriteW = meta.cw * S / dpr;
    spriteH = meta.ch * S / dpr;
    spriteCtx = setupCanvas(spriteCv, meta.cw * S, meta.ch * S);
    faceCtx = setupCanvas(faceCv, meta.f.w * FACE_S, meta.f.h * FACE_S);
    shK = 0;                 // 影子的画布要按新尺寸重建
    lastShA = -1; lastShK = -1;
    shW = meta.s.w * 2 / dpr;
    shH = meta.s.h * 2 / dpr;
    // 草地贴图也必须是整数设备像素：32 美术像素 × 2 = 64 设备像素
    pen.style.backgroundSize = (64 / dpr) + 'px auto';
    var half = spriteW / 2;
    st.x = Math.max(half + 3, Math.min(penW - half - 3, st.x || penW / 2));
  }

  function start() {
    layout();
    if (nameEl) nameEl.textContent = meta.n;
    if (moodEl) moodEl.textContent = '心情 悠闲';
    drawSprite('i', 0);
    drawFace(FACE_NORMAL);
    drawShadow(1, 2);
    place(st.x, 0);

    lastPart = timePart();
    if (isNightNow()) document.documentElement.className += ' pkmn-night';
    loadWeather();

    // 天气 / 时间图标是另一张小图（1.7 KB），到了就画
    var icons = INDEX.icons;
    if (icons && (weatherIconCv || timeIconCv)) {
      iconImg = new Image();
      iconImg.onload = function () { refreshIcons(); };
      iconImg.src = ASSET + 'icon-sheet.png';
    } else {
      if (weatherIconCv) weatherIconCv.style.display = 'none';
      if (timeIconCv) timeIconCv.style.display = 'none';
    }

    // 开场就在它的睡觉时段的话，多半已经在睡了（不然就等会儿自己困）
    if (sleepWindowNow() && Math.random() < 0.78) goSleep();

    // 台词按需下载（35 只全量内联太大，一只一个文件）
    if (window.fetch) {
      fetch(ASSET + 'talk/' + dex + '.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          talk = d;
          if (creditEl && d.credits) {
            var parts = [];
            if (d.credits.sprite && d.credits.sprite.length) parts.push('行走图 ' + d.credits.sprite.join('、'));
            if (d.credits.portrait && d.credits.portrait.length) parts.push('脸图 ' + d.credits.portrait.join('、'));
            if (parts.length) creditEl.title = meta.n + '：' + parts.join('；');
          }
        })
        .catch(function () {});
    }

    // 调试用：加上 ?pkmn-debug=1 就能在控制台里翻内部状态（平常不影响任何东西）
    if (/[?&]pkmn-debug=1/.test(location.search)) {
      window.__pkmn = {
        dex: dex, meta: meta, state: st,
        weather: function () { return weather; },
        talk: function () { return talk; },
        pool: function () { return autoPool(); },
        say: say,
        asleep: function () { return asleep; },
        sleepWindow: sleepWindowNow,
        timePart: timePart,
        goSleep: goSleep,
        wake: wakeUp,
        icons: function () { refreshIcons(); }
      };
    }

    var last = 0;

    function loop(ts) {
      requestAnimationFrame(loop);
      if (document.hidden) { last = 0; return; }
      if (!last) { last = ts; return; }
      var dt = (ts - last) / 1000;
      last = ts;
      if (dt > 0.12) dt = 0.12;      // 切回来 / 卡顿时别一下跳很远
      step(dt);
      tickTalk(dt);
      tickClock(dt);
      tickSleep();
    }
    requestAnimationFrame(loop);

    // 窗口尺寸/侧栏换行变了要重新算（手机上侧栏是全宽的）
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        layout();
        drawSprite(st.animKey, st.frame);
        drawFace(faceSlot);
        drawShadow(Math.max(0.45, 1 - 0.55 * (st.hop / (HOP_ART * art2css))),
                   st.hop > 4 * art2css ? 1 : 2);
        place(st.x, st.hop);
      }, 200);
    });
  }
})();
