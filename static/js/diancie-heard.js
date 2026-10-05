/* ============================================================
   蒂安希听到了（文集侧栏挂件）
   ------------------------------------------------------------
   蒂安希站在矿洞里，隔一会儿抬头听一下，然后把小碎钻告诉它的话
   转述出来。话写在 data/diancie-heard.toml，由写手在编辑器里改。

   和三处已有东西的关系：
     · 版式的类名沿用「宝可梦放养区」那套（.pkmn-pasture / .pasture-*），
       CSS 在 retro.css 第 27 节，这里不重复一份。
     · 精灵表沿用同一份 static/pkmn/index.json（蒂安希 / 小碎钻在那份名单里
       标了 hide = true，所以不会跑进侧栏那个放养区的随机池）。
     · **刻意不接 pkmn-sky.js / pkmn-weather.js**：那两样是露天的天空与天气，
       矿洞里不该下雨、也不该有云。洞壁在这里自己画在背景画布上。

   表情：写手在编辑器里选的那一个优先（emotion 字段）；留空就按文本关键词
   自动判断。关键词表见下 —— 它和 .editor/emotion-words.mjs、
   .editor/ui.html 里那份必须**逐条一致**（顺序就是优先级），改一处要改三处。
   ============================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------
     关键词 -> 表情。顺序即优先级：从最具体/最强烈到最中性。
     ⚠️ 三份要同步：这里 / .editor/emotion-words.mjs / .editor/ui.html 内联那份。
     ------------------------------------------------------------ */
  var EMOTION_WORDS = [
    ['Crying',      ['哭', '泪', '呜呜', '抽泣', '哽咽']],
    ['Sad',         ['难过', '伤心', '低落', '失落', '寂寞', '孤单', '遗憾', '舍不得', '断了']],
    ['Angry',       ['生气', '气死', '愤怒', '讨厌', '可恶', '烦人']],
    ['Surprised',   ['吃惊', '惊讶', '居然', '竟然', '没想到', '吓了一跳', '有人来']],
    ['Worried',     ['担心', '不安', '放心不下', '有事', '危险', '等它', '一直在等']],
    ['Sigh',        ['叹气', '叹了', '唉', '无奈', '算了']],
    ['Teary-Eyed',  ['眼眶', '含泪', '差点掉下']],
    ['Shouting',    ['大声', '喊', '吼', '叫了']],
    ['Pain',        ['疼', '痛', '受伤']],
    ['Dizzy',       ['晕', '天旋地转', '晃']],
    ['Stunned',     ['愣', '呆住', '说不出话']],
    ['Joyous',      ['雀跃', '跳起来', '太好了', '真好', '欢呼']],
    ['Happy',       ['开心', '高兴', '愉快', '笑', '喜欢', '好看', '温柔', '暖']],
    ['Inspired',    ['想法', '灵感', '启发', '有意思', '像一小片', '很像']],
    ['Determined',  ['一定', '决定', '坚持', '继续', '不会停']]
  ];
  var DEFAULT_EMOTION = 'Normal';

  function classifyEmotion(text) {
    var s = String(text || '');
    for (var i = 0; i < EMOTION_WORDS.length; i++) {
      var words = EMOTION_WORDS[i][1];
      for (var j = 0; j < words.length; j++) {
        if (s.indexOf(words[j]) >= 0) return EMOTION_WORDS[i][0];
      }
    }
    return DEFAULT_EMOTION;
  }

  var widget = document.getElementById('diancie-heard');
  if (!widget) return;

  var pen = document.getElementById('diancie-pen');
  var bgCv = document.getElementById('diancie-bg');
  var gemLayer = document.getElementById('diancie-gems');
  var spriteCv = document.getElementById('diancie-sprite');
  var shadowCv = document.getElementById('diancie-shadow');
  var faceCv = document.getElementById('diancie-face');
  var lineEl = document.getElementById('diancie-line');
  var moodEl = document.getElementById('diancie-mood');
  var titleEl = document.getElementById('diancie-title');
  if (!pen || !bgCv || !gemLayer || !spriteCv || !shadowCv || !faceCv || !lineEl) return;

  var ASSET = widget.getAttribute('data-base') || 'pkmn/';
  var DIANCIE = widget.getAttribute('data-diancie') || '719';
  var CARBINK = widget.getAttribute('data-carbink') || '703';

  var INDEX = null;
  var idxEl = document.getElementById('diancie-index');
  try { INDEX = JSON.parse(idxEl.textContent || '{}'); } catch (e) { return; }
  var SHEET = (INDEX && INDEX.sheet) || {};
  var D_META = SHEET[DIANCIE], G_META = SHEET[CARBINK];
  if (!D_META || !G_META) {
    lineEl.textContent = '……素材还没生成。跑一下 python tools/build-pkmn.py。';
    return;
  }

  var MSGS = [];
  var dataEl = document.getElementById('diancie-heard-data');
  try {
    var parsed = JSON.parse(dataEl.textContent || '{}');
    MSGS = (parsed && parsed.items) || [];
  } catch (e) { MSGS = []; }

  /* 思考中那一档。开场语就是挂件标题本身（「蒂安希听到了」），
     所以这里只随机抽一句「嗯...」。 */
  var THINKING = ['嗯...', '我想想...', '等一下...'];

  /* 时序（毫秒）：听 -> 想 -> 说，然后停一会儿再来一轮。 */
  var T_LISTEN = 2200;
  var T_THINK = 1700;
  var T_HOLD_MIN = 9000;
  var T_HOLD_MAX = 16000;

  var ROW = { i: 0, wl: 1, wr: 2, face: 3, sh: 4, sl: 5 };

  /* 小碎钻比蒂安希小一圈。按「美术像素 = 几个格子」算太绕，直接给相对系数：
     0.5 -> 蒂安希 40 美术像素变成 20。侧栏矿洞只有 180 来像素宽，
     除掉蒂安希之后要能并排放下 4 只，所以取得比较小。 */
  var GEM_SCALE = 0.5;

  var dpr = window.devicePixelRatio || 1;
  var penW = 0, penH = 0;
  var art2css = 1;
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

  /* 只在尺寸真的变了才重设 —— 重设 canvas.width 会**清空画布**。
     小碎钻是每帧重画的，如果每帧都重设尺寸，画完立刻就被抹掉了。 */
  function fitCanvas(cv, wDev, hDev) {
    if (cv.width === wDev && cv.height === hDev) {
      var c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      return c;
    }
    return setupCanvas(cv, wDev, hDev);
  }

  var bgCtx = null, spriteCtx = null, shadowCtx = null, faceCtx = null;

  // ---------------- 矿洞背景 ----------------
  /* 画在背景画布上（而不是用 CSS 底图）：能按实际尺寸铺砖、做纵深，
     而且只在排版时画一次，不占每帧开销。
     这里刻意不接 pkmn-sky.js —— 矿洞里不该有云和天气。 */
  var seed = 20261002;
  function rnd() {
    // 固定种子的伪随机：同样尺寸每次画出来的砖块位置一致
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  function paintCave() {
    if (!bgCtx) return;
    var W = bgCtx.canvas.width, H = bgCtx.canvas.height;
    bgCtx.clearRect(0, 0, W, H);
    bgCtx.imageSmoothingEnabled = false;

    var BW = 34 * Math.max(1, Math.round(dpr));    // 砖宽（设备像素，按 dpr 放大）
    var BH = 17 * Math.max(1, Math.round(dpr));
    seed = 20261002;

    // 一层层砖：越靠下越暗，做出「往洞里走」的纵深
    var row = 0;
    for (var y = 0; y < H; y += BH, row++) {
      var offset = (row % 2) ? Math.round(BW / 2) : 0;
      var depth = y / Math.max(1, H);
      var base = 76 - Math.round(depth * 32);
      for (var x = -offset; x < W; x += BW) {
        var lum = Math.max(20, Math.min(98, base + Math.round((rnd() - 0.5) * 16)));
        bgCtx.fillStyle = 'rgb(' + lum + ',' + Math.round(lum * 0.93) + ',' + Math.round(lum * 0.8) + ')';
        bgCtx.fillRect(x + 1, y + 1, BW - 2, BH - 2);
      }
    }

    // 砖缝：压在砖块之上，边缘才清楚
    bgCtx.fillStyle = 'rgba(10,8,6,.55)';
    for (var yy = 0; yy < H; yy += BH) bgCtx.fillRect(0, yy, W, 1);
    row = 0;
    for (var y2 = 0; y2 < H; y2 += BH, row++) {
      var off2 = (row % 2) ? Math.round(BW / 2) : 0;
      for (var xx = -off2; xx < W; xx += BW) bgCtx.fillRect(xx, y2, 1, BH);
    }

    // 顶部一点微光（像洞口漏下来），底部压暗
    var g1 = bgCtx.createLinearGradient(0, 0, 0, H * 0.5);
    g1.addColorStop(0, 'rgba(214,204,172,.22)');
    g1.addColorStop(1, 'rgba(214,204,172,0)');
    bgCtx.fillStyle = g1;
    bgCtx.fillRect(0, 0, W, H * 0.5);

    var g2 = bgCtx.createLinearGradient(0, H * 0.5, 0, H);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(1, 'rgba(0,0,0,.46)');
    bgCtx.fillStyle = g2;
    bgCtx.fillRect(0, H * 0.5, W, H * 0.5);

    // 岩壁上嵌着的碎晶：几处亮点，让画面不那么平
    seed = 77113;
    var px = Math.max(1, Math.round(dpr));
    for (var i = 0; i < 10; i++) {
      var cx = Math.round(rnd() * (W - 8)) + 4;
      var cy = Math.round(rnd() * (H * 0.78)) + 4;
      var big = rnd() < 0.35;
      bgCtx.fillStyle = 'rgba(178,214,255,.55)';
      bgCtx.fillRect(cx, cy, big ? px * 2 : px, big ? px * 2 : px);
      if (big) {
        bgCtx.fillStyle = 'rgba(255,255,255,.75)';
        bgCtx.fillRect(cx, cy, px, px);
      }
    }
  }

  // ---------------- 角色 ----------------
  var diancie = { img: new Image(), ready: false, t: 0, x: 0, y: 0, wCss: 0, hCss: 0 };
  var gems = [];

  function makeGem() {
    var g = { x: 0, y: 0, dir: 1, speed: 0, t: 0, wCss: 0, hCss: 0,
              cv: document.createElement('canvas'), ctx: null, placed: false };
    gemLayer.appendChild(g.cv);
    return g;
  }

  function pickGemCount() { return 2 + Math.floor(Math.random() * 3); }   // 2~4 只

  function computeScale() {
    var base = Math.min(4, Math.max(2, Math.round(dpr * 1.5)));
    var maxDev = (penH - 26) * dpr;
    S = base;
    while (S > 1 && D_META.ch * S > maxDev) S -= 1;
    art2css = S / dpr;
  }

  function layout() {
    var r = pen.getBoundingClientRect();
    penW = Math.max(60, Math.round(r.width));
    penH = Math.max(60, Math.round(r.height));
    computeScale();

    var dw = Math.round(D_META.cw * art2css), dh = Math.round(D_META.ch * art2css);
    diancie.wCss = dw; diancie.hCss = dh;
    // 蒂安希靠左站，把右边整片留给小碎钻走
    diancie.x = 4;
    diancie.y = penH - 13 - dh;

    var W = Math.ceil(penW * dpr), H = Math.ceil(penH * dpr);
    bgCtx = fitCanvas(bgCv, W, H);
    paintCave();
    spriteCtx = fitCanvas(spriteCv, W, H);
    shadowCtx = fitCanvas(shadowCv, W, H);
    faceCtx = fitCanvas(faceCv, D_META.f.w * 2, D_META.f.h * 2);

    /* 小碎钻的尺寸要同时满足两件事，所以是反推出来的：
         ① 每只分到的格子宽度 >= 身位的 2 倍 —— 否则它只能钉在原地
            （格子刚好等于身位时，可走范围是 0，实测就是三只一动都不动）
         ② 身位又不能太大 —— DPR 低的时候格子会被放大到 40px，和蒂安希一样大
       于是：格子宽 = 可走宽度 / 只数，身位 = 格子宽 / 2，再和 GEM_SCALE 取小的。 */
    var nGems = Math.max(1, gems.length || 3);
    var freeW = Math.max(36, penW - dw - 12);
    var byScale = G_META.cw * art2css * GEM_SCALE;
    var byFit = (freeW / nGems) / 2;
    var gw = Math.max(12, Math.round(Math.min(byScale, byFit)));
    var gh = Math.max(12, Math.round(G_META.ch * gw / G_META.cw));

    // 蒂安希右边到围栏右边，整片给小碎钻
    var lo = Math.min(penW - gw - 2, diancie.x + dw + 6);
    var hi = Math.max(lo, penW - gw - 2);

    /* 每只小碎钻分到自己的**一格子**，只在这一格里来回走。
       为什么不给整片自由走：这样两只的活动区间一交叉就会撞到一起
       （实测 24 次采样里 20 次有两只重叠），而「挤成一坨」正是要避免的。
       分格的代价是它们不会彼此穿插 —— 但看起来仍然是各自在洞里溜达。 */
    var cell = (hi - lo) / nGems;

    gems.forEach(function (g, i) {
      g.wCss = gw; g.hCss = gh;
      g.ctx = fitCanvas(g.cv, Math.ceil(gw * dpr), Math.ceil(gh * dpr));
      g.y = penH - 11 - gh;
      // 这一格里的可走范围（右边留出自身宽度，别贴出格子）
      var cl = lo + cell * i;
      var ch2 = cl + Math.max(0, cell - gw);
      g.lo = cl; g.hi = ch2;
      if (!g.placed) {
        g.x = cl + (ch2 - cl) * Math.random();
        g.dir = Math.random() < 0.5 ? -1 : 1;
        g.speed = 3 + Math.random() * 5;      // CSS px / 秒
        g.t = Math.random() * 600;
        g.placed = true;
      } else {
        g.x = Math.max(cl, Math.min(ch2, g.x));
      }
    });

    // 给主循环：每只用自己的格子边界
    walkLo = lo;
    walkHi = hi;
  }
  var walkLo = 0, walkHi = 0;

  // ---------------- 画 ----------------
  function frameAt(anim, tMs) {
    var frames = anim.n || 1;
    var durs = anim.d || [];
    var total = 0, i;
    for (i = 0; i < frames; i++) total += (durs[i] || 400);
    if (total <= 0) return 0;
    var t = ((tMs % total) + total) % total;
    var acc = 0;
    for (i = 0; i < frames; i++) { acc += (durs[i] || 400); if (t < acc) return i; }
    return 0;
  }

  function drawDiancie() {
    if (!spriteCtx) return;
    var f = frameAt(D_META.i || { n: 1, d: [400] }, diancie.t);
    spriteCtx.clearRect(0, 0, spriteCtx.canvas.width, spriteCtx.canvas.height);
    spriteCtx.drawImage(diancie.img,
      f * D_META.cw, ROW.i * D_META.ch, D_META.cw, D_META.ch,
      Math.round(diancie.x * dpr), Math.round(diancie.y * dpr),
      Math.round(diancie.wCss * dpr), Math.round(diancie.hCss * dpr));
  }

  function drawGem(g) {
    if (!g.ctx) return;
    var row = g.dir > 0 ? ROW.wr : ROW.wl;
    var f = frameAt(G_META[g.dir > 0 ? 'wr' : 'wl'] || G_META.i, g.t);
    g.ctx.clearRect(0, 0, g.ctx.canvas.width, g.ctx.canvas.height);
    g.ctx.drawImage(diancie.img,
      f * G_META.cw, row * G_META.ch, G_META.cw, G_META.ch,
      0, 0, Math.round(g.wCss * dpr), Math.round(g.hCss * dpr));
    g.cv.style.left = Math.round(g.x) + 'px';
    g.cv.style.top = Math.round(g.y) + 'px';
  }

  function drawShadows() {
    if (!shadowCtx) return;
    shadowCtx.clearRect(0, 0, shadowCtx.canvas.width, shadowCtx.canvas.height);
    var s = D_META.s;
    if (!s) return;
    shadowCtx.globalAlpha = 0.4;
    shadowCtx.drawImage(diancie.img, s.x, ROW.sh * D_META.ch, s.w, s.h,
      Math.round(diancie.x * dpr),
      Math.round((diancie.y + diancie.hCss) * dpr) - Math.round(2 * dpr),
      Math.round(s.w * art2css * dpr), Math.round(s.h * art2css * dpr));
    shadowCtx.globalAlpha = 1;
  }

  /* 表情：写手选的那一张（按名字在 e.r 里找行号），找不到退回四槽里的 Normal。
     这样即便以后素材里少了某个表情，也只是退回普通脸，不会报错。 */
  function faceSpec(emotion) {
    var e = D_META.e;
    if (e && e.r && e.r[emotion] != null) {
      return { row: e.r[emotion], col: 0, x: e.x, y: e.y, w: e.w, h: e.h };
    }
    var f = D_META.f;
    return { row: ROW.face, col: (f.c && f.c[0]) || 0, x: f.x, y: f.y, w: f.w, h: f.h };
  }

  function drawFace(emotion) {
    if (!faceCtx) return;
    var spec = faceSpec(emotion);
    faceCtx.clearRect(0, 0, faceCtx.canvas.width, faceCtx.canvas.height);
    faceCtx.drawImage(diancie.img,
      spec.col * D_META.cw + spec.x, spec.row * D_META.ch + spec.y, spec.w, spec.h,
      0, 0, spec.w * 2, spec.h * 2);
  }

  // ---------------- 对话框三段式 ----------------
  var lastIdx = -1;
  function pickMessage() {
    if (!MSGS.length) return null;
    if (MSGS.length === 1) return MSGS[0];
    var i;
    for (var guard = 0; guard < 24; guard++) {
      i = Math.floor(Math.random() * MSGS.length);
      if (i !== lastIdx) break;
    }
    lastIdx = i;
    return MSGS[i];
  }

  function say(text, mood) {
    lineEl.textContent = text;
    if (moodEl && mood) moodEl.textContent = mood;
  }

  var stage = 'idle';
  var stageUntil = 0;
  var current = null;

  function beginCycle() {
    if (!MSGS.length) {
      say('……我还没听到什么。', '正在听');
      stage = 'idle';
      stageUntil = performance.now() + 12000;
      return;
    }
    current = pickMessage();
    stage = 'listen';
    stageUntil = performance.now() + T_LISTEN;
    if (moodEl) moodEl.textContent = '正在听';
    if (titleEl) titleEl.classList.add('is-listening');
  }

  function enterThink() {
    stage = 'think';
    stageUntil = performance.now() + T_THINK;
    say(THINKING[Math.floor(Math.random() * THINKING.length)], '想了想');
  }

  function enterSpeak() {
    stage = 'speak';
    var emo = (current && current.emotion) ? current.emotion : classifyEmotion(current ? current.text : '');
    drawFace(emo);
    say(current ? current.text : '……', emo);
    if (titleEl) titleEl.classList.remove('is-listening');
    stageUntil = performance.now() + T_HOLD_MIN + Math.random() * (T_HOLD_MAX - T_HOLD_MIN);
  }

  function tickStage(now) {
    if (now < stageUntil) return;
    if (stage === 'idle') { beginCycle(); return; }
    if (stage === 'listen') { enterThink(); return; }
    if (stage === 'think') { enterSpeak(); return; }
    beginCycle();
  }

  // ---------------- 主循环 ----------------
  var last = 0;
  function loop(now) {
    if (!last) last = now;
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    diancie.t += dt * 1000;
    drawDiancie();

    gems.forEach(function (g) {
      g.t += dt * 1000;
      g.x += g.dir * g.speed * dt;
      // 每只只在自己的格子里来回走（见 layout 里那段注释）
      var l = (g.lo != null) ? g.lo : walkLo;
      var h2 = (g.hi != null) ? g.hi : walkHi;
      if (g.x <= l) { g.x = l; g.dir = 1; }
      else if (g.x >= h2) { g.x = h2; g.dir = -1; }
      drawGem(g);
    });

    drawShadows();
    tickStage(now);
    requestAnimationFrame(loop);
  }

  // ---------------- 点一下就再听一条 ----------------
  function poke() {
    if (!diancie.ready) return;
    last = 0;
    current = pickMessage();
    if (!current) { say('……我还没听到什么。', '正在听'); return; }
    stage = 'listen';
    stageUntil = performance.now() + 250;
    if (titleEl) titleEl.classList.add('is-listening');
  }
  pen.addEventListener('click', poke);
  if (titleEl) titleEl.addEventListener('click', poke);

  var rt = null;
  window.addEventListener('resize', function () {
    if (rt) clearTimeout(rt);
    rt = setTimeout(layout, 160);
  });

  // ---------------- 启动 ----------------
  diancie.img.onload = function () {
    diancie.ready = true;
    var n = pickGemCount();
    for (var i = 0; i < n; i++) gems.push(makeGem());
    layout();
    drawFace('Normal');
    say('……', '正在听');
    stage = 'idle';
    stageUntil = performance.now() + 1200;   // 进页面先静一小会儿再开口
    requestAnimationFrame(loop);
  };
  diancie.img.onerror = function () {
    lineEl.textContent = '……它好像没下来。';
  };
  diancie.img.src = ASSET + 'sprite/' + DIANCIE + '.png';

  // 给测试用（不影响功能）
  window.DiancieHeard = {
    classifyEmotion: classifyEmotion,
    emotions: EMOTION_WORDS.map(function (x) { return x[0]; }).concat([DEFAULT_EMOTION]),
    messageCount: MSGS.length,
    gemCount: function () { return gems.length; },
    /* 把内部尺寸摊出来：测试要按「画布里的图形尺寸」判断，
       不能拿占位画布的 getBoundingClientRect（它铺满整个围栏）。 */
    layout: function () {
      return {
        dpr: dpr, S: S, art2css: art2css, penW: penW, penH: penH,
        diancie: { x: diancie.x, y: diancie.y, w: diancie.wCss, h: diancie.hCss },
        gems: gems.map(function (g) { return { x: g.x, y: g.y, w: g.wCss, h: g.hCss, dir: g.dir, lo: g.lo, hi: g.hi }; }),
        walkLo: walkLo, walkHi: walkHi
      };
    },
    state: function () {
      return { stage: stage, mood: moodEl ? moodEl.textContent : '', line: lineEl.textContent };
    }
  };
})();
