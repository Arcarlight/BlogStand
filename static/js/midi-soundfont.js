/* ============================================================
   真实音源（可选）—— SpessaSynth + FluidR3Mono_GM.sf3
   ------------------------------------------------------------
   为什么需要它：
     浏览器**没有**原生 MIDI 支持。默认方案（midi-player.js）是零下载的
     Web Audio 现场合成——三角/方波 + ADSR，能听出旋律，但音色是芯片味的。
     想要「像 MIDI 播放器那样」的声音，必须给它一套采样音源（SoundFont）。

   这里用的一套：
     · SpessaSynth（Apache-2.0）—— SF2/SF3 解析 + 合成，跑在 AudioWorklet 里
       static/js/vendor/spessasynth/
         spessasynth.min.js            244 KB 左右，esbuild 打的单文件 ESM
         spessasynth_processor.min.js  403 KB，AudioWorklet 处理器（必须同源单独加载）
     · FluidR3Mono_GM.sf3（MIT）—— 通用 MIDI 音源，23.6 MB
       static/soundfont/FluidR3Mono_GM.sf3

   为什么不默认开：
     23.6 MB。默认打开等于每个访客先吃 24 MB 才听到第一个音。
     所以这里的策略是「点了才下载」+ Cache Storage 落盘（第二次几乎瞬开），
     并且**失败就静默退回**内置合成，绝不让播放器变哑巴。

   对外接口（window.MidiSF）：
     supported()            浏览器行不行
     enabled() / setEnabled(bool)   用户的选择（存 localStorage，跨页面记住）
     ensure(onProgress)     下载并初始化，返回 Promise；已就绪直接 resolve
     ready()                是否已就绪
     createPlayer(url,opts) 造一个和 MidiPlayer **接口一致**的播放器
     volume(v)              0..1
     size()                 缓存文件字节数（就绪后）

   播放器接口和 midi-player.js 对齐：state / play / pause / toggle / stop /
   seek / duration() / currentTime() / destroy() / master(GainNode)。
   这样 music-page.js 只多一个分支，其余逻辑两边共用。
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.__MUS_SF || {};
  var BASE = CFG.base || '';   // .../js/vendor/spessasynth/（模板 relURL 算好的）
  var BANK = CFG.bank || '';   // .../soundfont/FluidR3Mono_GM.sf3
  var LS_PREF = 'mus-sf';
  var CACHE_NAME = 'mus-sf3-v1';
  var UID = 0;

  var S = {
    pref: readPref(),        // 用户是否想要真实音源
    phase: 'idle',           // idle | loading | ready | error
    p: 0, got: 0, total: 0, cached: false,
    bankBytes: 0,            // 音源解压后的真实大小（GitHub Pages 会 gzip，Content-Length 偏小）
    err: '',
    ctx: null, synth: null, gain: null, mod: null,
    loadPromise: null,
    volume: 0.8,
    listeners: [],
  };

  /* ---------- 小工具 ---------- */
  function readPref() {
    try { return localStorage.getItem(LS_PREF) === '1'; } catch (e) { return false; }
  }
  function writePref(v) {
    try { localStorage.setItem(LS_PREF, v ? '1' : '0'); } catch (e) {}
  }
  function mb(n) { return (n / 1e6).toFixed(1) + ' MB'; }
  function emit() {
    var ls = S.listeners.slice();
    for (var i = 0; i < ls.length; i++) {
      try { ls[i](S.p, S.got, S.total, S.cached); } catch (e) {}
    }
  }
  function onProgress(fn) {
    if (typeof fn !== 'function') return function () {};
    S.listeners.push(fn);
    return function () {
      var i = S.listeners.indexOf(fn);
      if (i >= 0) S.listeners.splice(i, 1);
    };
  }

  /* ---------- 能力检测 ---------- */
  function supported() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    /* AudioWorklet 是硬条件：SpessaSynth 的处理器必须跑在 worklet 线程里。
       注意别去读 AudioContext.prototype.audioWorklet —— 它是个 getter，
       在原型上访问拿不到值（第一版就是这么误判成「不支持」的）。 */
    return typeof window.AudioWorkletNode === 'function';
  }

  /* ---------- 下载音源（带进度 + 落盘缓存） ---------- */
  function fetchBank() {
    var url = BANK;
    S.got = 0; S.total = 0; S.p = 0; S.cached = false;

    /* 先看 Cache Storage：第二次进来就不用再下 24 MB 了。
       （普通 HTTP 缓存对 GitHub Pages 只有 10 分钟，指望不上。） */
    var cacheRead = (window.caches && url)
      ? caches.open(CACHE_NAME).then(function (c) {
          return c.match(url).then(function (hit) {
            if (!hit) return null;
            S.cached = true;
            S.p = 1;
            emit();
            return hit.arrayBuffer();
          });
        }).catch(function () { return null; })
      : Promise.resolve(null);

    return cacheRead.then(function (cachedBuf) {
      if (cachedBuf) return cachedBuf;

      return fetch(url, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) throw new Error('音源下载失败 HTTP ' + res.status);
        var total = +res.headers.get('content-length') || 0;
        S.total = total;

        /* 没有流式读取（老浏览器）就直接整个拿，进度条退化成「转圈」 */
        if (!res.body || !res.body.getReader) {
          return res.arrayBuffer().then(function (ab) {
            S.got = ab.byteLength; S.total = ab.byteLength; S.p = 1; emit();
            putCache(url, new Blob([ab]));
            return ab;
          });
        }

        var reader = res.body.getReader();
        var parts = [];
        function step() {
          return reader.read().then(function (r) {
            if (r.done) {
              var blob = new Blob(parts);
              putCache(url, blob);
              return blob.arrayBuffer();
            }
            parts.push(r.value);
            S.got += r.value.length;
            S.p = S.total ? Math.min(1, S.got / S.total) : 0;
            emit();
            return step();
          });
        }
        return step();
      });
    });
  }

  function putCache(url, blob) {
    if (!window.caches || !url) return;
    /* 放缓存是锦上添花，失败（配额、隐私模式）不算错 */
    caches.open(CACHE_NAME).then(function (c) {
      return c.put(url, new Response(blob, {
        headers: { 'content-type': 'application/octet-stream' },
      }));
    }).catch(function () {});
  }

  /* ---------- 初始化（只做一次） ---------- */
  function ensure() {
    if (S.phase === 'ready') return Promise.resolve(S);
    if (S.loadPromise && S.phase !== 'error') return S.loadPromise;
    /* 上一次失败过：清掉现场，让「点一下重试」能重来（不然会一直拿到那个失败的 promise） */
    if (S.phase === 'error') {
      S.phase = 'idle';
      S.loadPromise = null;
      S.ctx = null;
      S.synth = null;
      S.gain = null;
    }
    if (!BASE || !BANK) {
      S.phase = 'error';
      S.err = '缺 __MUS_SF 配置（模板没给 base/bank 路径）';
      return Promise.reject(new Error(S.err));
    }

    S.phase = 'loading';
    S.err = '';
    emit();

    S.loadPromise = (function () {
      var AC = window.AudioContext || window.webkitAudioContext;
      S.ctx = new AC();

      /* 1) 先注册 worklet 处理器 —— 必须同源、必须早于 new WorkletSynthesizer */
      return S.ctx.audioWorklet.addModule(BASE + 'spessasynth_processor.min.js')
        .then(function () {
          /* 2) 再拉库本体（动态 import，不点「真实音源」这条 244 KB 也不会下） */
          return import(BASE + 'spessasynth.min.js');
        })
        .then(function (mod) {
          S.mod = mod;
          /* 3) 音源采样 */
          return fetchBank();
        })
        .then(function (buf) {
          if (!buf || buf.byteLength < 1024) throw new Error('音源文件是空的');
          S.bankBytes = buf.byteLength;
          /* 4) 装载。顺序照官方 README：先 addSoundBank 再等 isReady */
          S.synth = new S.mod.WorkletSynthesizer(S.ctx);
          return S.synth.soundBankManager
            .addSoundBank(buf, 'main')
            .then(function () { return S.synth.isReady; });
        })
        .then(function () {
          /* 5) 输出：synth → gain（音量）→ destination
                所有 MIDI 播放器共用这一个合成器和这一个音量节点。 */
          S.gain = S.ctx.createGain();
          S.gain.gain.value = S.volume;
          S.gain.connect(S.ctx.destination);
          S.synth.connect(S.gain);
          S.phase = 'ready';
          S.p = 1;
          emit();
          return S;
        })
        .catch(function (e) {
          S.phase = 'error';
          S.err = (e && e.message) || String(e);
          emit();
          throw e;
        });
    })();

    return S.loadPromise;
  }

  /* ---------- 播放器（接口对齐 midi-player.js） ---------- */
  function createPlayer(url, opts) {
    opts = opts || {};
    var seq = null;
    var cur = 0;                 // 最近一次已知位置（seq 不可用时兜底）
    var tick = null;
    var dead = false;
    var evId = 'sf' + (++UID);
    var api = {
      state: 'loading',
      master: S.gain,
      isSoundfont: true,
    };

    function setState(s) {
      if (api.state === s) return;
      api.state = s;
      if (opts.onState) opts.onState(s);
    }

    function startTick() {
      if (tick) return;
      tick = setInterval(function () {
        if (dead || !seq) return;
        cur = seq.currentTime;
        if (opts.onTick) opts.onTick(cur, seq.duration || 0);
      }, 100);
    }
    function stopTick() {
      if (!tick) return;
      clearInterval(tick);
      tick = null;
    }

    /* 读 MIDI 字节 → 建一个专属 sequencer（每首一个：
       同一合成器上可以并存多个 sequencer，互不干扰） */
    var readyP = fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        if (dead) return;
        seq = new S.mod.Sequencer(S.synth);
        seq.eventHandler.addEvent('songEnded', evId, function () {
          if (dead) return;
          setState('ended');
          stopTick();
          if (opts.onEnd) opts.onEnd();
        });
        seq.loadNewSongList([{ binary: buf }]);
        setState('idle');
      })
      .catch(function (e) {
        setState('error');
        if (opts.onError) opts.onError(e);
        throw e;
      });

    readyP.catch(function () {});   // 不让它变成 unhandledrejection

    api.play = function () {
      return readyP.then(function () {
        return S.ctx.resume();
      }).then(function () {
        if (dead || !seq) return;
        seq.play();
        setState('playing');
        startTick();
      });
    };
    api.pause = function () {
      if (seq) seq.pause();
      stopTick();
      setState('paused');
    };
    api.toggle = function () {
      return api.state === 'playing' ? (api.pause(), Promise.resolve()) : api.play();
    };
    api.stop = function () {
      if (seq) { seq.pause(); seq.currentTime = 0; }
      cur = 0;
      stopTick();
      setState('idle');
    };
    api.seek = function (sec) {
      if (!seq) return;
      sec = Math.max(0, Math.min(sec, seq.duration || 0));
      seq.currentTime = sec;
      cur = sec;
      if (opts.onTick) opts.onTick(cur, seq.duration || 0);
    };
    api.duration = function () { return (seq && isFinite(seq.duration)) ? seq.duration : 0; };
    api.currentTime = function () { return cur; };
    api.load = function () { return readyP; };
    api.destroy = function () {
      dead = true;
      stopTick();
      if (seq) {
        try { seq.pause(); } catch (e) {}
        try { seq.eventHandler.removeEvent('songEnded', evId); } catch (e) {}
        seq = null;
      }
      api.master = null;
      setState('idle');
    };

    return api;
  }

  /* ---------- 音量 ---------- */
  function volume(v) {
    S.volume = Math.max(0, Math.min(1, +v || 0));
    if (S.gain) {
      try { S.gain.gain.value = S.volume; } catch (e) {}
    }
  }

  window.MidiSF = {
    supported: supported,
    enabled: function () { return S.pref; },
    setEnabled: function (v) { S.pref = !!v; writePref(S.pref); },
    ensure: ensure,
    ready: function () { return S.phase === 'ready'; },
    phase: function () { return S.phase; },
    error: function () { return S.err; },
    progress: function () { return S.p; },
    bytes: function () { return S.bankBytes || S.total || S.got || 0; },
    fromCache: function () { return S.cached; },
    onProgress: onProgress,
    createPlayer: createPlayer,
    volume: volume,
    fmtMB: mb,
    /* 只给自动化测试用：挂个 AnalyserNode 到合成器输出，验「真的出声了」 */
    _debug: function () { return { ctx: S.ctx, synth: S.synth, gain: S.gain }; },
  };
})();
