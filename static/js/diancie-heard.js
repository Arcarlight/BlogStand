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

  /* 三类消息，各自独立（站长用来当树洞）。
     每次随机挑**一类**，再从那一类里挑一条 —— 不是把三类混成一个大池子，
     否则「小碎钻们说的话」会被「听到的事情」淹掉。 */
  var KINDS = { heard: [], said: [], thought: [] };
  var KIND_ORDER = ['heard', 'said', 'thought'];
  var KIND_LABEL = { heard: '小碎钻们听到的事情', said: '小碎钻们说的话', thought: '蒂安希的感悟' };
  var dataEl = document.getElementById('diancie-heard-data');
  try {
    var parsed = JSON.parse(dataEl.textContent || '{}');
    if (parsed && parsed.kinds) {
      KIND_ORDER.forEach(function (k) { KINDS[k] = parsed.kinds[k] || []; });
      if (parsed.labels) KIND_LABEL = parsed.labels;
    }
  } catch (e) { /* 保持空，下面会提示 */ }

  function kindTotal() {
    var n = 0;
    KIND_ORDER.forEach(function (k) { n += KINDS[k].length; });
    return n;
  }
  var HAS_MSGS = kindTotal() > 0;

  /* 思考中那一档。开场语就是挂件标题本身（「蒂安希听到了」），
     所以这里只随机抽一句「嗯...」。 */
  var THINKING = ['嗯...', '我想想...', '等一下...'];

  /* 时序（毫秒）：听 -> 想 -> 说，然后停一会儿再来一轮。
     站长说「不用切换得这么快」，所以整轮拉长了：
     说完停 14~26 秒（原来 9~16 秒），想那一档也从 1.7 秒放到 2.4 秒。 */
  var T_LISTEN = 2600;
  var T_THINK = 2400;
  var T_HOLD_MIN = 14000;
  var T_HOLD_MAX = 26000;

  var ROW = { i: 0, wl: 1, wr: 2, face: 3, sh: 4, sl: 5 };

  /* 小碎钻的身位 = 蒂安希宽 × 这个比例。
     0.55 = 蒂安希的一半再多一点。站长看过 0.5（40px）那一版仍觉得偏小，
     而现在尺寸已经**不再受可走空间约束**（重叠允许了），所以可以再大一点。 */
  var GEM_RATIO = 0.55;
  /* 抽几只：2 ~ MAX_GEMS。
     3 而不是 4：矿洞横向空间有限，多一只只是多一次重叠，画面更挤。 */
  var MAX_GEMS = 3;

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

  /* 水晶洞穴的背景。
     第一版画成了砖墙 —— 深棕、横平竖直、一排排对齐，站长一眼看出「像地牢」。
     水晶洞穴不是「砌出来的」，是**岩壁上长着晶体**：所以改成
       · 冷色调（深蓝紫岩石，不用棕）
       · 岩石是不规则的多边形块，不是对齐的砖
       · 大大小小的晶体从岩壁和地面长出来，带高光棱边和光晕
       · 整体偏暗，靠晶体的荧光提亮
     固定种子，所以每次刷新画面一致（不会闪）。 */
  function paintCave() {
    if (!bgCtx) return;
    var W = bgCtx.canvas.width, H = bgCtx.canvas.height;
    bgCtx.clearRect(0, 0, W, H);
    bgCtx.imageSmoothingEnabled = false;
    var u = Math.max(1, Math.round(dpr));     // 一个 CSS px = 几个设备像素

    // ---- 洞穴底色：上深下更深的蓝紫，中间偏亮一点（光从洞顶漏下来） ----
    var base = bgCtx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#161a38');
    base.addColorStop(0.45, '#1d2450');
    base.addColorStop(1, '#0e1128');
    bgCtx.fillStyle = base;
    bgCtx.fillRect(0, 0, W, H);

    // ---- 岩石：不规则多边形块，越往下越暗 ----
    // ⚠️ 别用等大的六边形铺满：第一版就是那样，结果像鱼鳞/蜂窝。
    // 这里让每块的半径、顶点角度都随机，并且留出缝隙，看起来才是岩壁。
    seed = 20261002;
    var CELL = 26 * u;
    for (var gy = -CELL; gy < H + CELL; gy += CELL) {
      for (var gx = -CELL; gx < W + CELL; gx += CELL) {
        var cx = gx + (rnd() - 0.5) * CELL;
        var cy = gy + (rnd() - 0.5) * CELL;
        var depth = cy / Math.max(1, H);
        var lum = 44 - Math.round(depth * 14) + Math.round((rnd() - 0.5) * 14);
        lum = Math.max(14, Math.min(60, lum));
        // 冷色：蓝 > 绿 > 红
        bgCtx.fillStyle = 'rgb(' + (lum - 6) + ',' + (lum + 2) + ',' + (lum + 20) + ')';
        var r = CELL * (0.22 + rnd() * 0.34);
        var n = 5 + Math.floor(rnd() * 3);
        bgCtx.beginPath();
        for (var k = 0; k < n; k++) {
          var a = (k / n) * Math.PI * 2 + rnd() * 0.9;
          var rr = r * (0.5 + rnd() * 0.9);
          var px2 = cx + Math.cos(a) * rr, py2 = cy + Math.sin(a) * rr * 0.85;
          if (k === 0) bgCtx.moveTo(px2, py2); else bgCtx.lineTo(px2, py2);
        }
        bgCtx.closePath();
        bgCtx.fill();
        // 少量亮面，做出岩壁的起伏
        if (rnd() < 0.18) {
          bgCtx.fillStyle = 'rgba(120,150,210,.18)';
          bgCtx.fill();
        }
      }
    }

    // 岩缝：随机短线段，破掉「一块块」的规律感
    seed = 5150;
    bgCtx.strokeStyle = 'rgba(8,10,26,.55)';
    bgCtx.lineWidth = u;
    for (var s = 0; s < 26; s++) {
      var sx = rnd() * W, sy = rnd() * H;
      bgCtx.beginPath();
      bgCtx.moveTo(sx, sy);
      for (var seg = 0; seg < 3; seg++) {
        sx += (rnd() - 0.5) * 26 * u;
        sy += (rnd() - 0.5) * 20 * u;
        bgCtx.lineTo(sx, sy);
      }
      bgCtx.stroke();
    }

    // ---- 发光晶体 ----
    // 从岩壁/地面「长」出来：底边贴在洞底或洞壁，尖端朝内。
    // 画法：一个细长的四边形（菱形），中间亮、边缘更亮，底下垫一圈光晕。
    function crystal(cx, cy, len, wid, hue, grow) {
      // hue: 'cyan' | 'violet' | 'white'
      var light = hue === 'cyan' ? ['rgba(150,240,255,.95)', 'rgba(90,200,235,.75)', 'rgba(40,130,180,.55)']
                : hue === 'violet' ? ['rgba(215,180,255,.95)', 'rgba(165,130,235,.75)', 'rgba(95,70,170,.55)']
                : ['rgba(240,250,255,.95)', 'rgba(190,215,240,.75)', 'rgba(120,150,200,.55)'];
      // 光晕
      var gl = bgCtx.createRadialGradient(cx, cy, 0, cx, cy, len * 1.5);
      gl.addColorStop(0, light[2]);
      gl.addColorStop(1, 'rgba(0,0,0,0)');
      bgCtx.fillStyle = gl;
      bgCtx.fillRect(cx - len * 1.5, cy - len * 1.5, len * 3, len * 3);

      // 菱形晶柱：grow = +1 向上长，-1 向下长
      var tipX = cx + (rnd() - 0.5) * wid * 0.5;
      var tipY = cy + grow * len;
      bgCtx.beginPath();
      bgCtx.moveTo(cx - wid / 2, cy);
      bgCtx.lineTo(tipX, tipY);
      bgCtx.lineTo(cx + wid / 2, cy);
      bgCtx.lineTo(cx + wid * 0.18, cy);
      bgCtx.closePath();
      bgCtx.fillStyle = light[1];
      bgCtx.fill();

      // 高光棱边（靠左那条边更亮，做出「透光」的感觉）
      bgCtx.beginPath();
      bgCtx.moveTo(cx - wid / 2, cy);
      bgCtx.lineTo(tipX, tipY);
      bgCtx.strokeStyle = light[0];
      bgCtx.lineWidth = Math.max(1, u * 0.6);
      bgCtx.stroke();
    }

    seed = 90210;
    var hues = ['cyan', 'cyan', 'violet', 'white'];
    // 洞底那一排：从地面往上长
    for (var i = 0; i < 7; i++) {
      var bx = rnd() * W;
      crystal(bx, H - 1, (10 + rnd() * 22) * u, (4 + rnd() * 5) * u,
              hues[Math.floor(rnd() * hues.length)], -1);
    }
    // 洞顶那一排：从顶上往下垂
    for (var j = 0; j < 5; j++) {
      var tx = rnd() * W;
      crystal(tx, 1, (7 + rnd() * 15) * u, (3 + rnd() * 4) * u,
              hues[Math.floor(rnd() * hues.length)], 1);
    }
    // 岩壁零星的碎晶
    seed = 31337;
    for (var k2 = 0; k2 < 14; k2++) {
      var fx = rnd() * W, fy = rnd() * H * 0.85;
      var big = rnd() < 0.4;
      bgCtx.fillStyle = 'rgba(190,230,255,.75)';
      bgCtx.fillRect(fx, fy, big ? u * 2 : u, big ? u * 2 : u);
      if (big) {
        bgCtx.fillStyle = 'rgba(255,255,255,.9)';
        bgCtx.fillRect(fx, fy, u, u);
      }
    }

    // 底部压一层暗，让站在地上的角色有「落地」的感觉
    var g2 = bgCtx.createLinearGradient(0, H * 0.62, 0, H);
    g2.addColorStop(0, 'rgba(4,6,20,0)');
    g2.addColorStop(1, 'rgba(4,6,20,.52)');
    bgCtx.fillStyle = g2;
    bgCtx.fillRect(0, H * 0.62, W, H * 0.38);

    // 顶上再压一点，突出「洞里很暗、只有晶体在发光」
    var g3 = bgCtx.createLinearGradient(0, 0, 0, H * 0.28);
    g3.addColorStop(0, 'rgba(2,4,14,.45)');
    g3.addColorStop(1, 'rgba(2,4,14,0)');
    bgCtx.fillStyle = g3;
    bgCtx.fillRect(0, 0, W, H * 0.28);
  }

  // ---------------- 角色 ----------------
  /* ⚠️ 蒂安希和小碎钻是**两张不同的精灵表**，必须各加载各的。
     一开始图省事让小碎钻也从 diancie.img（719 那张）取像素 —— 元数据
     （格子尺寸、走图行、帧数）用的是 703 的，图片却是 719 的，于是：
       · 小碎钻看起来是蒂安希的样子
       · 719 图里对应位置经常是透明的，画出来时有时无（「突然消失」）
     两张表是独立的资源，不能混用。 */
  var diancie = { img: new Image(), ready: false, t: 0, x: 0, y: 0, wCss: 0, hCss: 0 };
  var carbink = { img: new Image(), ready: false };
  var gems = [];

  function makeGem() {
    var g = { x: 0, y: 0, dir: 1, speed: 0, t: 0, wCss: 0, hCss: 0,
              cv: document.createElement('canvas'), ctx: null, placed: false };
    gemLayer.appendChild(g.cv);
    return g;
  }

  function pickGemCount() { return 2 + Math.floor(Math.random() * (MAX_GEMS - 1)); }   // 2 ~ MAX_GEMS 只

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

    /* 小碎钻的尺寸**只由「蒂安希的一半」决定，不再和可走空间挂钩**。
       ------------------------------------------------------------
       前面几版一直在这个死循环里打转：
         想让它们永不重叠 -> 每只分一格 -> 身位必须小于格子 -> 尺寸被压小
       站长看过三版都说「太小了」，最后明确说「重叠也无所谓」——
       那就把这条约束去掉。尺寸只按比例算：
         gw = 蒂安希宽 × GEM_RATIO
       于是侧栏再窄、抽到几只，它们都一样大，也不必为了腾出格子而缩水。
       重叠交给绘制顺序自然处理（后画的盖住先画的），这在像素风里看着并不怪。 */
    var gw = Math.max(12, Math.round(dw * GEM_RATIO));
    var gh = Math.max(12, Math.round(G_META.ch * gw / G_META.cw));

    // 蒂安希右边到围栏右边，整片给小碎钻自由走（不再分格）
    var lo = Math.min(penW - gw - 2, diancie.x + dw + 6);
    var hi = Math.max(lo, penW - gw - 2);

    gems.forEach(function (g) {
      g.wCss = gw; g.hCss = gh;
      g.ctx = fitCanvas(g.cv, Math.ceil(gw * dpr), Math.ceil(gh * dpr));
      g.y = penH - 11 - gh;
      g.lo = lo; g.hi = hi;
      if (!g.placed) {
        g.x = lo + (hi - lo) * Math.random();
        g.dir = Math.random() < 0.5 ? -1 : 1;
        g.t = Math.random() * 600;
        // 走动 / 停下的节奏都各自随机，看起来才像各自在溜达而不是队列行军
        g.speed = 6 + Math.random() * 7;          // CSS px / 秒
        g.task = 'idle';
        g.until = performance.now() + 400 + Math.random() * 2600;   // 一进来先停一下
        g.placed = true;
      } else {
        g.x = Math.max(lo, Math.min(hi, g.x));
      }
    });

    // 给主循环用（现在三只共用整条带子）
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
    if (!g.ctx || !carbink.ready) return;
    /* 停下的时候用 Idle 帧（原地小幅呼吸），走的时候才用走图。
       两种都用同一套 frameAt 计时，所以切换时不会跳帧。 */
    var walking = (g.task === 'walk');
    var key = walking ? (g.dir > 0 ? 'wr' : 'wl') : 'i';
    var row = ROW[key];
    var anim = G_META[key] || G_META.i;
    if (!anim) { anim = G_META.i; row = ROW.i; }
    var f = frameAt(anim, g.t);
    // 帧号必须夹在实际存在的范围里：万一时长表比帧数长，drawImage 会越界
    // 取到表外面（那片是透明的），看起来就是「小碎钻突然不见了」。
    if (!(f >= 0) || f >= (anim.n || 1)) f = 0;
    g.ctx.clearRect(0, 0, g.ctx.canvas.width, g.ctx.canvas.height);
    g.ctx.drawImage(carbink.img,
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
  /* 先随机挑**一类**（三类各自独立，不混池），再从那类里挑一条。
     记住「这一轮是哪个类别 + 上一条是哪个」，避免连续重复同一类 / 同一条。 */
  var lastKind = null;
  var lastText = null;

  function pickMessage() {
    var pool = [];
    KIND_ORDER.forEach(function (k) {
      if (KINDS[k].length) pool.push(k);
    });
    if (!pool.length) return null;

    // 类别：优先挑和上一轮不同的那一类（只有一类时就只能重复）
    var kind = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && kind === lastKind) {
      var others = pool.filter(function (k) { return k !== lastKind; });
      kind = others[Math.floor(Math.random() * others.length)];
    }

    var arr = KINDS[kind];
    var item = arr.length === 1 ? arr[0] : null;
    for (var guard = 0; !item && guard < 20; guard++) {
      var cand = arr[Math.floor(Math.random() * arr.length)];
      if (cand.text !== lastText) item = cand;
    }
    if (!item) item = arr[Math.floor(Math.random() * arr.length)];

    lastKind = kind;
    lastText = item.text;
    // 把类别也带上：对话框第二行和测试都用得到
    return { text: item.text, emotion: item.emotion, kind: kind, kindLabel: KIND_LABEL[kind] || kind };
  }

  function say(text, mood) {
    lineEl.textContent = text;
    if (moodEl && mood) moodEl.textContent = mood;
  }

  var stage = 'idle';
  var stageUntil = 0;
  var current = null;

  function beginCycle() {
    if (!HAS_MSGS) {
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
    /* 第二行显示**这条属于哪一类**（「小碎钻们听到的事情」等），
       而不是表情名 —— 表情名对访客没意义，类别才让人知道这话从哪来。 */
    say(current ? current.text : '……', current ? current.kindLabel : '');
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

      /* 走走停停，而不是一刻不停地来回走（站长：「一直在走来走去，没有停下过」）。
         两种状态轮换：走一段 -> 停一会儿 -> 换个方向再走。
         停的时候仍然在切 Idle 帧，所以它是站在原地小幅呼吸，不是被冻住。 */
      if (now >= g.until) {
        if (g.task === 'walk') {
          g.task = 'idle';
          g.until = now + 2400 + Math.random() * 3600;      // 停 2.4~6 秒
        } else {
          g.task = 'walk';
          /* 走的时间给够：带子只有 ~130px，走 2 秒才挪十来像素，
             看起来像在原地抖。4 秒上下能明显走一段。
             上限别太长（6 秒），否则抽到长值的那只会长时间不停。 */
          g.until = now + 2600 + Math.random() * 2600;      // 走 2.6~5.2 秒
          if (Math.random() < 0.55) g.dir = -g.dir;         // 多半换个方向
        }
      }

      if (g.task === 'walk') {
        g.x += g.dir * g.speed * dt;
        var l = (g.lo != null) ? g.lo : walkLo;
        var h2 = (g.hi != null) ? g.hi : walkHi;
        if (g.x <= l) { g.x = l; g.dir = 1; }
        else if (g.x >= h2) { g.x = h2; g.dir = -1; }
      }
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
  /* 两张精灵表都到齐了再开始 —— 只等蒂安希那张的话，小碎钻会先画成空的。 */
  var started = false;
  function maybeStart() {
    if (started || !diancie.ready || !carbink.ready) return;
    started = true;
    var n = pickGemCount();
    for (var i = 0; i < n; i++) gems.push(makeGem());
    layout();
    drawFace('Normal');
    say('……', '正在听');
    stage = 'idle';
    stageUntil = performance.now() + 1200;   // 进页面先静一小会儿再开口
    requestAnimationFrame(loop);
  }

  diancie.img.onload = function () { diancie.ready = true; maybeStart(); };
  carbink.img.onload = function () { carbink.ready = true; maybeStart(); };
  function failLoad() { lineEl.textContent = '……它们好像没下来。'; }
  diancie.img.onerror = failLoad;
  carbink.img.onerror = failLoad;
  diancie.img.src = ASSET + 'sprite/' + DIANCIE + '.png';
  carbink.img.src = ASSET + 'sprite/' + CARBINK + '.png';

  // 给测试用（不影响功能）
  window.DiancieHeard = {
    classifyEmotion: classifyEmotion,
    emotions: EMOTION_WORDS.map(function (x) { return x[0]; }).concat([DEFAULT_EMOTION]),
    messageCount: kindTotal(),
    kindCounts: function () {
      var o = {};
      KIND_ORDER.forEach(function (k) { o[k] = KINDS[k].length; });
      return o;
    },
    kindLabels: KIND_LABEL,
    gemCount: function () { return gems.length; },
    /* 把内部尺寸摊出来：测试要按「画布里的图形尺寸」判断，
       不能拿占位画布的 getBoundingClientRect（它铺满整个围栏）。 */
    layout: function () {
      return {
        dpr: dpr, S: S, art2css: art2css, penW: penW, penH: penH,
        diancie: { x: diancie.x, y: diancie.y, w: diancie.wCss, h: diancie.hCss },
        gems: gems.map(function (g) { return { x: g.x, y: g.y, w: g.wCss, h: g.hCss, dir: g.dir,
                                                task: g.task, until: g.until, lo: g.lo, hi: g.hi }; }),
        walkLo: walkLo, walkHi: walkHi
      };
    },
    state: function () {
      return { stage: stage, mood: moodEl ? moodEl.textContent : '', line: lineEl.textContent,
               kind: current ? current.kind : null, kindLabel: current ? current.kindLabel : null };
    }
  };
})();
