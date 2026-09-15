/* ============================================================
   放养区的天空 —— 围栏的背景跟着「天气 + 时间」变
   ------------------------------------------------------------
   晴天：蓝天 + 白云慢慢飘；阴天：天上一整片云；小雨 / 雨 / 雷雨：
   天上往下掉雨丝（雷雨会闪一下）；下雪：飘雪花；起雾：一层灰白的雾。
   夜里换深蓝的调子，天上挂月亮和星星；早上和傍晚是暖色的。

   为什么用画布画，而不是备几张背景图：
     1. **锐利**。整片天画在一张「美术像素」分辨率的小画布上
        （围栏 276 CSS px、dpr=2 时就是 276×150 个美术像素），
        最后整张按**整数倍**（2 设备像素 = 1 美术像素）贴到可见画布上 ——
        一个美术像素永远正好是 2×2 个同色设备像素，和草地贴图、
        点阵字体是同一条规矩（见 retro.css 第 27 节）。
        云、雨、雪都是「一格一格」挪的，不会出现半个像素的模糊边。
     2. 云要飘、雨要落、雪要飘、雷要闪，图片做不出循环。
     3. 不用多发一个请求，也不用往仓库里塞一堆 PNG（这个文件 10 KB 出头）。

   想改颜色，直接改下面 SKY / TIME 两张表里的数字就行，都是 RGB 三元组：
     SKY[天气].sky   从上到下 4 条天空色带
     SKY[天气].cloud 云的颜色（底下那条阴影由 TIME 的 sh 压出来）
     SKY[天气].wash  阴天那层「整片灰」的薄纱（0 = 没有）
     TIME[时间]      色调（tint / k = 往那个颜色混多少）、云影深浅 sh、日月
   ============================================================ */
(function () {
  'use strict';

  var ART = 2;                 // 1 美术像素 = 2 设备像素（草地贴图也是 32 美术像素 = 64 设备像素）
  var TILE = 32, TILE_H = 28;  // 草地贴图 32×28 美术像素，横向平铺
  var STAR_DENSITY = 0.0022;   // 星星密度（颗 / 美术像素²，夜里、晴天最密）
  var FLASH_DUR = 0.5;         // 一次雷电（三下连闪）的时长（秒）

  // ---------------- 天气（白天那套颜色） ----------------
  // front / back 是前排 / 后排云的数量；后排小、慢、偏淡（空气透视）。
  // rain / snow 里的 sp 是「每秒钟掉多少个天空高度」，所以屏幕大小无关。
  var SKY = {
    clear: {
      sky: [[72, 146, 222], [108, 178, 238], [150, 210, 248], [196, 232, 252]],
      cloud: [238, 244, 252], top: [255, 255, 255], front: 3, back: 3, wash: 0, star: 1, gTint: null
    },
    cloudy: {
      sky: [[124, 142, 164], [150, 166, 186], [178, 192, 208], [202, 212, 224]],
      cloud: [212, 220, 230], top: [244, 248, 252], front: 6, back: 4, wash: 0.30, star: 0,
      gTint: 'rgba(40,54,74,.10)'
    },
    fog: {
      sky: [[150, 158, 170], [172, 180, 192], [192, 198, 208], [210, 215, 222]],
      cloud: [200, 207, 216], top: [230, 234, 240], front: 2, back: 2, wash: 0.22, fog: 1, star: 0,
      gTint: 'rgba(200,208,216,.16)'
    },
    drizzle: {
      sky: [[112, 130, 154], [138, 154, 176], [166, 180, 198], [192, 202, 216]],
      cloud: [196, 206, 220], top: [228, 236, 246], front: 5, back: 4, wash: 0.26, star: 0,
      rain: { n: 24, a: 0.46, len: [3, 4], sp: [0.9, 1.4], col: [206, 228, 250] },
      gTint: 'rgba(30,44,66,.14)'
    },
    rain: {
      sky: [[86, 102, 124], [112, 128, 150], [142, 156, 176], [170, 182, 198]],
      cloud: [180, 191, 207], top: [212, 222, 236], front: 6, back: 4, wash: 0.30, star: 0,
      rain: { n: 66, a: 0.74, len: [4, 6], sp: [1.1, 1.7], col: [210, 232, 252] },
      gTint: 'rgba(20,34,54,.18)'
    },
    snow: {
      sky: [[152, 166, 188], [178, 190, 208], [200, 210, 224], [220, 228, 238]],
      cloud: [226, 234, 244], top: [250, 253, 255], front: 4, back: 3, wash: 0.24, star: 0,
      snow: { n: 58 }, gTint: 'rgba(230,238,250,.50)'
    },
    thunder: {
      sky: [[56, 66, 86], [80, 92, 114], [104, 118, 140], [130, 142, 164]],
      cloud: [130, 142, 164], top: [162, 174, 196], front: 7, back: 4, wash: 0.34, star: 0, bolt: true,
      rain: { n: 88, a: 0.80, len: [4, 7], sp: [1.3, 2.0], col: [214, 232, 252] },
      gTint: 'rgba(14,24,44,.26)'
    }
  };

  // ---------------- 时间（叠在天气上的色调） ----------------
  // tint / k：往这个颜色混这么多（夜的 k 很大 = 直接压成深蓝）
  // dark：再往深蓝黑压一点；sh：云底阴影的深浅（夜里要给足，不然云看不见）
  // sun：太阳的位置（占天空宽 / 高的比例）和两种颜色；moon：挂月亮
  var TIME = {
    dawn: {
      tint: [255, 186, 140], k: 0.30, dark: 0, sh: 0.20, star: 0, gNight: null,
      sun: { x: 0.17, y: 0.62, c1: [255, 204, 118], c2: [255, 240, 186] }
    },
    day: {
      tint: null, k: 0, dark: 0, sh: 0.16, star: 0, gNight: null,
      sun: { x: 0.20, y: 0.14, c1: [255, 212, 92], c2: [255, 244, 178] }
    },
    dusk: {
      tint: [255, 146, 102], k: 0.38, dark: 0.05, sh: 0.22, star: 0,
      gNight: 'rgba(30,40,70,.10)',
      sun: { x: 0.18, y: 0.58, c1: [255, 162, 88], c2: [255, 214, 150] }
    },
    night: {
      tint: [26, 42, 86], k: 0.82, dark: 0.16, sh: 0.40, star: 1,
      gNight: 'rgba(22,34,62,.52)', moon: true
    }
  };

  var SEED = { clear: 11, cloudy: 23, fog: 37, drizzle: 41, rain: 53, snow: 67, thunder: 79,
               dawn: 3, day: 5, dusk: 7, night: 9 };

  // ---------------- 小工具 ----------------
  function mix(a, b, k) {
    return [Math.round(a[0] + (b[0] - a[0]) * k),
            Math.round(a[1] + (b[1] - a[1]) * k),
            Math.round(a[2] + (b[2] - a[2]) * k)];
  }
  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // 固定种子的随机数（mulberry32）：同一种天气每次打开长同一片云，
  // 不会刷一下就变个样 —— 看起来像「画好的背景」，而不是随机噪点。
  function rnd(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function discFill(c, cx, cy, r, color) {
    c.fillStyle = color;
    for (var dy = -r; dy <= r; dy++) {
      var hw = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      c.fillRect(cx - hw, cy + dy, hw * 2 + 1, 1);
    }
  }

  // ---------------- 云 ----------------
  // 云 = 一条平底 + 上面几个**扁的**鼓包（椭圆，不是正圆），画在 1:1 的美术像素
  // 小画布上（一次生成，之后每帧只贴图）。每个像素列的最下面那一格压深色 = 云底阴影。
  //
  // 用扁椭圆是有讲究的：正圆的鼓包排一排会像「一串泡泡」，压得再深也能看出圆边；
  // 把横向拉长 1.4~1.8 倍就变成一个个矮胖的圆顶，接缝浅、轮廓连成一片，才像云。
  function ellipseMask(m, w, h, base, cx, cy, rx, ry) {
    for (var dy = -ry; dy <= ry; dy++) {
      var yy = cy + dy;
      if (yy < 0 || yy > base) continue;          // 底边削平
      var k = 1 - (dy * dy) / (ry * ry);
      if (k <= 0) continue;
      var hw = Math.floor(rx * Math.sqrt(k));
      for (var dx = -hw; dx <= hw; dx++) {
        var xx = cx + dx;
        if (xx >= 0 && xx < w) m[yy * w + xx] = 1;
      }
    }
  }

  function makeCloud(rand, w, light, dark, hi) {
    var h = Math.max(9, Math.round(w * 0.44));
    var m = new Uint8Array(w * h);
    var base = h - 2;                       // 最后一行留给云底阴影
    var x0 = Math.round(w * 0.10), x1 = Math.round(w * 0.90);
    // 1) 云底那条平板（两端内缩，让两头的鼓包自己收圆）
    for (var y = base - 1; y <= base; y++) {
      for (var x = x0; x <= x1; x++) m[y * w + x] = 1;
    }
    // 2) 上面几个圆顶：横向只拉长一点点（拉太扁会变成「面包」），
    //    互相压掉一大半、两头矮中间高
    var n = Math.max(3, Math.round(w / 26));
    var ryMax = Math.max(2, Math.floor((base - 3) / 2));
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n;
      var arch = 0.50 + 0.50 * Math.sin(Math.PI * t);
      var ry = Math.max(2, Math.round(ryMax * arch * (0.82 + rand() * 0.3)));
      var rx = Math.round(ry * (1.05 + rand() * 0.30));
      ellipseMask(m, w, h, base, Math.round(x0 + t * (x1 - x0)), base - ry, rx, ry);
    }
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var c = cv.getContext('2d');
    // 三档颜色：顶上 1 像素是亮边、中间是云身、最下面 1 像素是云底阴影
    for (var x2 = 0; x2 < w; x2++) {
      var top = -1, bot = -1;
      for (var y2 = 0; y2 < h; y2++) {
        if (m[y2 * w + x2]) { if (top < 0) top = y2; bot = y2; }
      }
      if (top < 0) continue;
      c.fillStyle = rgb(light);
      c.fillRect(x2, top, 1, bot - top + 1);
      c.fillStyle = rgb(hi);
      c.fillRect(x2, top, 1, 1);
      c.fillStyle = rgb(dark);
      c.fillRect(x2, bot, 1, 1);
    }
    return cv;
  }

  // ============================================================
  function create(cv, base) {
    var vis = cv.getContext('2d');
    var off = document.createElement('canvas');
    var octx = off.getContext('2d');

    var aw = 0, ah = 0, skyH = 0;
    var weather = 'clear', part = 'day', pal = null;
    var clouds = [[], []], drops = [], flakes = [], stars = [];
    var bolt = false, flash = 0, nextFlash = 8;
    var t = 0, dirty = true;
    var reduced = false;
    try {
      reduced = !!(window.matchMedia &&
                   window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { reduced = false; }

    // 草地还是用那条老贴图（它在画布的草地区域里重画一遍，
    // 位置和 pen 自己的 CSS 兜底背景完全对齐）
    var tile = null, tileReady = false;
    if (base) {
      tile = new Image();
      tile.onload = function () { tileReady = true; dirty = true; };
      tile.src = base + 'pen-tile.png';
    }

    // ---------------- 按天气 / 时间算出这一套颜色 ----------------
    function resolve() {
      var sk = SKY[weather], tt = TIME[part];
      function tone(c) {
        var x = tt.tint ? mix(c, tt.tint, tt.k) : c.slice();
        return tt.dark ? mix(x, [16, 24, 46], tt.dark) : x;
      }
      var bands = [], i;
      for (i = 0; i < sk.sky.length; i++) bands.push(tone(sk.sky[i]));
      var cl = tone(sk.cloud);
      var ch = tone(sk.top || mix(sk.cloud, [255, 255, 255], 0.6));   // 云顶那道亮边
      // 云底阴影：夜里要多压一点，否则云和天一个色、看不出形状
      var cd = mix(cl, [10, 18, 38], tt.sh);
      var clB = mix(cl, bands[1], 0.42);              // 后排云偏天空色一点 = 空气透视
      var chB = mix(ch, bands[1], 0.45);
      var cdB = mix(clB, [10, 18, 38], tt.sh * 0.85);
      // 4 条色带的分界（越靠下越厚）
      var wt = [0.30, 0.26, 0.24, 0.20], edges = [], acc = 0;
      for (i = 0; i < bands.length; i++) { acc += wt[i]; edges.push(Math.round(skyH * acc)); }
      var rBase = (sk.rain && sk.rain.col) || [206, 228, 250];
      return {
        bands: bands, edges: edges,
        cl: cl, cd: cd, ch: ch, clB: clB, cdB: cdB, chB: chB,
        rain: tt.tint ? mix(rBase, tt.tint, tt.k * 0.5) : rBase,
        fog: tt.tint ? mix([224, 231, 240], tt.tint, tt.k * 0.6) : [224, 231, 240],
        gNight: tt.gNight, gTint: sk.gTint
      };
    }

    // 云站在哪条带里
    function skyAt(y) {
      var i = 0;
      while (i < pal.edges.length - 1 && y >= pal.edges[i]) i++;
      return pal.bands[i];
    }

    // ---------------- 生成云 / 雨 / 雪 / 星星 ----------------
    function buildClouds(r, skyH2, count, sizeK, layer, cols) {
      var out = [], slot = aw / count;
      for (var i = 0; i < count; i++) {
        var cw = Math.max(8, Math.round(aw * sizeK * (0.75 + r() * 0.5)));
        var img = makeCloud(r, cw, cols[0], cols[1], cols[2]);
        var room = Math.max(1, skyH2 - img.height);
        out.push({
          img: img,
          // 均分到宽度上再加点抖动，保证整片天铺得比较匀（循环之后不会留空档）
          x: i * slot + r() * slot * 0.9 - img.width * 0.5,
          y: Math.round((layer ? 0.20 + r() * 0.45 : 0.02 + r() * 0.30) * room),
          sp: (layer ? 0.016 : 0.008) * aw * (0.6 + r() * 0.8)
        });
      }
      return out;
    }

    function buildRain(r, skyH2, cfg) {
      var out = [];
      for (var i = 0; i < cfg.n; i++) {
        out.push({
          x: Math.floor(r() * aw),
          y: r() * skyH2,
          sp: (cfg.sp[0] + r() * (cfg.sp[1] - cfg.sp[0])) * skyH2,
          len: cfg.len[0] + Math.floor(r() * (cfg.len[1] - cfg.len[0] + 1))
        });
      }
      return out;
    }

    function buildSnow(r, skyH2, cfg) {
      var out = [];
      for (var i = 0; i < cfg.n; i++) {
        out.push({
          x: Math.floor(r() * aw),
          y: r() * skyH2,
          sp: (0.08 + r() * 0.09) * skyH2,
          ph: r() * 6.283,
          big: r() < 0.30
        });
      }
      return out;
    }

    function buildStars(r, skyH2, factor) {
      var out = [];
      var n = Math.round(aw * skyH2 * STAR_DENSITY * factor);
      for (var i = 0; i < n; i++) {
        out.push({ x: Math.floor(r() * aw), y: 1 + Math.floor(r() * skyH2 * 0.62), ph: r() * 6.283 });
      }
      return out;
    }

    function rebuild() {
      if (!aw || !ah) return;
      skyH = ah - TILE_H;
      pal = resolve();
      var sk = SKY[weather];
      var r = rnd(SEED[weather] * 131 + SEED[part] * 17 + aw);
      clouds = [[], []];
      if (sk.back) clouds[0] = buildClouds(r, skyH, sk.back, 0.17, 0, [pal.clB, pal.cdB, pal.chB]);
      if (sk.front) clouds[1] = buildClouds(r, skyH, sk.front, 0.30, 1, [pal.cl, pal.cd, pal.ch]);
      drops = sk.rain ? buildRain(r, skyH, sk.rain) : [];
      flakes = sk.snow ? buildSnow(r, skyH, sk.snow) : [];
      stars = (sk.star && TIME[part].star) ? buildStars(r, skyH, sk.star * TIME[part].star) : [];
      bolt = !!sk.bolt;
      flash = 0;
      nextFlash = 5 + r() * 8;
      dirty = true;
    }

    // ---------------- 动 ----------------
    function moveClouds(dt) {
      for (var layer = 0; layer < 2; layer++) {
        var list = clouds[layer];
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          c.x += c.sp * dt;
          if (c.x > aw) c.x -= aw + c.img.width;   // 飘出右边就从左边回来
        }
      }
    }

    function movePrecip(dt) {
      var i;
      for (i = 0; i < drops.length; i++) {
        var d = drops[i];
        d.y += d.sp * dt;
        if (d.y > skyH + 3) d.y -= skyH + 12;      // 落到草地就回到天上
      }
      for (i = 0; i < flakes.length; i++) {
        var f = flakes[i];
        f.y += f.sp * dt;
        if (f.y > skyH + 2) f.y -= skyH + 10;
      }
    }

    function tickBolt(dt) {
      if (!bolt) return;
      if (flash > 0) { flash -= dt; return; }
      nextFlash -= dt;
      if (nextFlash <= 0) { flash = FLASH_DUR; nextFlash = 6 + Math.random() * 10; }
    }

    // 一次雷电 = 三下连闪（正片里就是这么闪的）
    function boltAlpha() {
      if (flash <= 0) return 0;
      var p = 1 - flash / FLASH_DUR;
      if (p < 0.15) return 0.62;
      if (p < 0.28) return 0.10;
      if (p < 0.45) return 0.72;
      if (p < 0.60) return 0.14;
      return 0.34;
    }

    // ---------------- 画 ----------------
    function dither(y0, y1, ca, cb) {
      octx.fillStyle = rgb(cb);
      octx.fillRect(0, y0, aw, y1 - y0);
      octx.fillStyle = rgb(ca);
      for (var y = y0; y < y1; y++) {
        for (var x = (y - y0) % 2 ? 0 : 1; x < aw; x += 2) octx.fillRect(x, y, 1, 1);
      }
    }

    function drawCelestial() {
      var tt = TIME[part], sk = SKY[weather];
      if (sk.bolt) return;              // 雷雨天整片乌云压着，日月直接不画
      // 阴天 / 下雪 / 起雾 / 下雨时日月被云挡住，只剩个影子：
      // 往云色里混掉一大半，后面那层灰纱再盖一下，就不会出现「乌云密布还挂着大太阳」
      var dim = Math.min(0.72, (sk.wash || 0) * 2.2);
      var r = Math.max(3, Math.round(skyH * 0.062));
      if (tt.moon) {
        var mx = Math.round(aw * 0.17), my = Math.round(skyH * 0.22);
        discFill(octx, mx, my, r, rgb(mix([236, 242, 252], pal.cl, dim)));
        // 缺角：拿这一带的天空色再画一个圆盖上去，剩下的就是月牙
        discFill(octx, mx + Math.max(2, Math.round(r * 0.5)),
                 my - Math.max(1, Math.round(r * 0.35)), r, rgb(skyAt(my)));
      } else {
        var x = Math.round(aw * tt.sun.x), y = Math.round(skyH * tt.sun.y);
        discFill(octx, x, y, r, rgb(mix(tt.sun.c1, pal.cl, dim)));
        discFill(octx, x, y, Math.max(1, Math.round(r * 0.55)), rgb(mix(tt.sun.c2, pal.cl, dim)));
      }
    }

    function drawClouds(layer) {
      var list = clouds[layer];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        octx.drawImage(c.img, Math.round(c.x), c.y);
      }
    }

    function drawGround() {
      if (tileReady) {
        for (var x = 0; x < aw; x += TILE) octx.drawImage(tile, x, skyH);
      } else {
        octx.fillStyle = 'rgb(124,192,92)';
        octx.fillRect(0, skyH, aw, TILE_H);
      }
      if (pal.gTint) { octx.fillStyle = pal.gTint; octx.fillRect(0, skyH, aw, TILE_H); }
      if (pal.gNight) { octx.fillStyle = pal.gNight; octx.fillRect(0, skyH, aw, TILE_H); }
    }

    function drawFog() {
      // 三条横着的雾带，越靠近地面越厚，慢慢左右晃（位置吸到整美术像素）
      for (var i = 0; i < 3; i++) {
        var y = Math.round((0.22 + i * 0.26) * ah + Math.sin(t * 0.25 + i * 2.1) * 2);
        octx.fillStyle = rgba(pal.fog, 0.30 - i * 0.05);
        octx.fillRect(0, y, aw, Math.max(4, Math.round(ah * 0.12)));
      }
    }

    function drawRain() {
      var cfg = SKY[weather].rain;
      octx.fillStyle = rgba(pal.rain, cfg.a);
      for (var i = 0; i < drops.length; i++) {
        var d = drops[i];
        octx.fillRect(Math.round(d.x), Math.round(d.y), 1, d.len);
      }
    }

    function drawSnow() {
      octx.fillStyle = 'rgba(244,250,255,.95)';
      for (var i = 0; i < flakes.length; i++) {
        var f = flakes[i];
        var x = Math.round(f.x + Math.sin(t * 0.9 + f.ph) * 2);
        var y = Math.round(f.y);
        if (f.big) {                       // 大雪花画成一个小十字（5 个像素），一眼认得出是雪
          octx.fillRect(x, y, 3, 1);
          octx.fillRect(x + 1, y - 1, 1, 3);
        } else {
          octx.fillRect(x, y, 1, 1);
        }
      }
    }

    function render() {
      var sk = SKY[weather], i;
      octx.imageSmoothingEnabled = false;
      // 1) 天空：4 条色带，两两之间用两行棋盘点阵过渡（点阵天空的老画法）
      var y = 0;
      for (i = 0; i < pal.bands.length; i++) {
        var y2 = pal.edges[i];
        octx.fillStyle = rgb(pal.bands[i]);
        octx.fillRect(0, y, aw, y2 - y);
        if (i + 1 < pal.bands.length) dither(y2 - 1, y2, pal.bands[i], pal.bands[i + 1]);
        y = y2;
      }
      // 2) 星星（只有夜里才有，一闪一闪分三档）
      for (i = 0; i < stars.length; i++) {
        var s = stars[i], sv = Math.sin(t * 1.6 + s.ph);
        var a = 0.35 + 0.65 * (sv > 0.55 ? 1 : (sv > -0.2 ? 0.55 : 0.15));
        octx.fillStyle = 'rgba(238,244,255,' + a.toFixed(2) + ')';
        octx.fillRect(s.x, s.y, 1, 1);
      }
      // 3) 太阳 / 月亮（先画，等下云会盖在它前面）
      drawCelestial();
      // 4) 阴天那层薄纱：盖在日月和星星上，天就「一整片都是云」了
      if (sk.wash) {
        octx.fillStyle = rgba(pal.cl, sk.wash);
        octx.fillRect(0, 0, aw, skyH);
      }
      // 5) 云：后排 → 前排
      drawClouds(0);
      drawClouds(1);
      // 6) 草地（在画布上重画一遍，免得被天空盖掉）+ 天气 / 夜里压暗
      drawGround();
      // 7) 雾 → 8) 雨 / 雪 → 9) 打雷
      if (sk.fog) drawFog();
      if (drops.length) drawRain();
      if (flakes.length) drawSnow();
      var fa = boltAlpha();
      if (fa > 0) {
        octx.fillStyle = 'rgba(246,250,255,' + fa + ')';
        octx.fillRect(0, 0, aw, ah);
      }
      // 整张贴到可见画布上：ART 倍最近邻放大 = 一个美术像素 = ART×ART 个同色设备像素
      vis.imageSmoothingEnabled = false;
      vis.clearRect(0, 0, cv.width, cv.height);
      vis.drawImage(off, 0, 0, aw, ah, 0, 0, aw * ART, ah * ART);
    }

    // ---------------- 对外的三件事 ----------------
    function resize() {
      var host = cv.parentNode;
      var wCss = (host && host.clientWidth) || 276;
      var hCss = (host && host.clientHeight) || 150;
      var d = window.devicePixelRatio || 1;
      aw = Math.max(8, Math.ceil(wCss * d / ART));
      ah = Math.max(8, Math.ceil(hCss * d / ART));
      cv.width = aw * ART;                    // 设备像素
      cv.height = ah * ART;
      cv.style.width = (aw * ART / d) + 'px'; // CSS 尺寸 = 设备像素 ÷ dpr → 1:1 贴上去
      cv.style.height = (ah * ART / d) + 'px';
      off.width = aw;
      off.height = ah;
      vis.imageSmoothingEnabled = false;
      rebuild();
    }

    function set(w, p) {
      var nw = (w && SKY[w]) ? w : 'clear';
      var np = (p && TIME[p]) ? p : 'day';
      if (nw === weather && np === part && pal) return;
      weather = nw;
      part = np;
      rebuild();
    }

    function tick(dt) {
      if (!aw || !pal) return;
      if (reduced) {
        if (!dirty) return;          // 「减少动态效果」= 一张静止的天，只画一次
      } else {
        t += dt;
        moveClouds(dt);
        movePrecip(dt);
        tickBolt(dt);
      }
      render();
      dirty = false;
    }

    function state() {
      return {
        weather: weather, part: part, art: ART, aw: aw, ah: ah, skyH: skyH,
        clouds: clouds[0].length + clouds[1].length,
        drops: drops.length, flakes: flakes.length, stars: stars.length,
        bolt: bolt, reduced: reduced,
        // 这一套实际算出来的颜色（调色板叠完时间色调之后），方便核对
        pal: pal ? { bands: pal.bands, cl: pal.cl, cd: pal.cd, clB: pal.clB,
                     cdB: pal.cdB, rain: pal.rain, fog: pal.fog } : null
      };
    }

    return { resize: resize, set: set, tick: tick, state: state };
  }

  window.PkmnSky = {
    create: create,
    WEATHERS: Object.keys(SKY),
    TIMES: Object.keys(TIME)
  };
})();
