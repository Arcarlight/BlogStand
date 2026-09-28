/* ============================================================
   侧栏音乐播放器 —— 播放逻辑

   设计要点（都是这个站上踩过的坑，别顺手改掉）：

   1) 音频对象用 new Audio() 建，**不往 DOM 里放 <audio>**。
      因为要支持「切页面继续放」：DOM 每次导航都重建，如果播放器挂在
      DOM 上，切页时会被连根拔掉（在途的播放请求会中断）。独立的
      Audio 对象活过导航，接得干净。

   2) 状态存 localStorage（不是 sessionStorage）：站点内每次跳转都是
      新文档，localStorage 才跨文档、跨标签页、跨重启都在。
      离开页面时只存「第几首 + 播到第几秒 + 音量 + 随机/循环」，
      下一页加载后恢复并尝试接着放。

   3) 自动播放在浏览器里是被限制的：首次访问（这个 origin 还没有过
      用户交互）play() 会被拒。这时**不静音硬凑**，只把进度摆回去、
      按钮显示成暂停态，等访客自己点一下。反正播放器第一屏就在侧栏顶上。

   4) 给站长的兜底：文件写错、文件不存在、格式不支持，都只把原因写进
      播放器下方那行小字，不弹窗、不报错到控制台污染。
   ============================================================ */
(function () {
  'use strict';

  var TRACKS = Array.isArray(window.SITE_MUSIC) ? window.SITE_MUSIC.slice() : [];
  var root = document.getElementById('mp-root');
  if (!root || !TRACKS.length) return;

  var KEY = 'nijiboshi.music.v1';

  // ---- 元素 ----
  var el = {
    play: document.getElementById('mp-play'),
    prev: document.getElementById('mp-prev'),
    next: document.getElementById('mp-next'),
    shuffle: document.getElementById('mp-shuffle'),
    repeat: document.getElementById('mp-repeat'),
    mute: document.getElementById('mp-mute'),
    title: document.getElementById('mp-title'),
    artist: document.getElementById('mp-artist'),
    cur: document.getElementById('mp-cur'),
    dur: document.getElementById('mp-dur'),
    seek: document.getElementById('mp-seek'),
    seekFill: document.getElementById('mp-seek-fill'),
    vol: document.getElementById('mp-vol'),
    volFill: document.getElementById('mp-vol-fill'),
    count: document.getElementById('mp-count'),
    hint: document.getElementById('mp-hint')
  };

  // ---- 状态 ----
  var st = {
    i: 0,
    playing: false,
    shuffle: false,
    repeat: false,
    muted: false,
    vol: 0.8,
    lastVol: 0.8,
    ready: false      // 这一首的元数据是否已经拿到（决定进度条能不能拖）
  };
  var order = null;                 // 随机播放时的顺序表
  var audio = new Audio();
  audio.preload = 'none';

  // ---- 小工具 ----
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        i: st.i,
        t: audio.currentTime || 0,
        playing: st.playing,
        shuffle: st.shuffle,
        repeat: st.repeat,
        vol: st.vol,
        muted: st.muted
      }));
    } catch (e) { /* 隐私模式下写不进去就算了 */ }
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
  }
  function hint(msg) {
    if (!el.hint) return;
    if (!msg) { el.hint.hidden = true; el.hint.textContent = ''; return; }
    el.hint.hidden = false;
    el.hint.textContent = msg;
  }

  // ---- 渲染 ----
  function paintTrack() {
    var t = TRACKS[st.i] || {};
    if (el.title) {
      el.title.textContent = t.title || t.file || '——';
      el.title.href = t.url || '#';
    }
    if (el.artist) el.artist.textContent = t.artist || '';
    if (el.count) el.count.textContent = (st.i + 1) + '/' + TRACKS.length;
  }
  function paintPlay() {
    if (!el.play) return;
    el.play.innerHTML = st.playing ? '&#10074;&#10074;' : '&#9654;';
    el.play.title = st.playing ? '暂停' : '播放';
    el.play.setAttribute('aria-label', st.playing ? '暂停' : '播放');
    el.play.classList.toggle('is-playing', st.playing);
  }
  function paintToggles() {
    if (el.shuffle) {
      el.shuffle.setAttribute('aria-pressed', st.shuffle ? 'true' : 'false');
      el.shuffle.classList.toggle('is-on', st.shuffle);
    }
    if (el.repeat) {
      el.repeat.setAttribute('aria-pressed', st.repeat ? 'true' : 'false');
      el.repeat.classList.toggle('is-on', st.repeat);
    }
    if (el.mute) {
      el.mute.setAttribute('aria-pressed', st.muted ? 'true' : 'false');
      el.mute.innerHTML = st.muted ? '&#128263;' : '&#128266;';
      el.mute.classList.toggle('is-on', st.muted);
    }
    paintVol();
  }
  function paintVol() {
    var v = st.muted ? 0 : st.vol;
    if (el.volFill) el.volFill.style.width = (v * 100).toFixed(1) + '%';
    if (el.vol) el.vol.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }
  function paintTime() {
    var d = audio.duration;
    var p = (isFinite(d) && d > 0) ? clamp01(audio.currentTime / d) : 0;
    if (el.seekFill) el.seekFill.style.width = (p * 100).toFixed(2) + '%';
    if (el.cur) el.cur.textContent = fmt(audio.currentTime);
    if (el.dur) el.dur.textContent = (isFinite(d) && d > 0) ? fmt(d) : '0:00';
    if (el.seek) {
      el.seek.setAttribute('aria-valuemax', String(Math.round(isFinite(d) ? d : 0)));
      el.seek.setAttribute('aria-valuenow', String(Math.round(audio.currentTime || 0)));
    }
  }

  // ---- 播放控制 ----
  function playIndex(i, at) {
    if (!TRACKS.length) return;
    st.i = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    st.ready = false;
    paintTrack();
    hint('');
    audio.src = TRACKS[st.i].url;
    try { audio.load(); } catch (e) {}
    if (at && at > 0) {
      var seeked = false;
      var apply = function () {
        if (seeked) return;
        seeked = true;
        try { audio.currentTime = at; } catch (e) {}
        paintTime();
      };
      audio.addEventListener('loadedmetadata', apply, { once: true });
      setTimeout(apply, 1500);   // 元数据迟迟不来（外链慢）也要把进度摆回去
    }
    attempt();
  }

  function attempt() {
    var p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(function () {
        st.playing = true; paintPlay(); save();
      }).catch(function () {
        // 多半是自动播放被拦 / 或文件有问题；先按暂停态显示，等用户点
        st.playing = false; paintPlay();
      });
    } else {
      st.playing = true; paintPlay();
    }
  }

  function toggle() {
    if (st.playing) {
      audio.pause();
      st.playing = false;
      paintPlay(); save();
    } else {
      if (!audio.src) { playIndex(st.i, 0); return; }
      if (audio.ended) { try { audio.currentTime = 0; } catch (e) {} }
      attempt();
    }
  }

  function next(auto) {
    if (st.repeat && auto) { try { audio.currentTime = 0; } catch (e) {} attempt(); return; }
    if (st.shuffle) { playIndex(pickShuffle(), 0); return; }
    playIndex(st.i + 1, 0);
  }
  function prev() {
    if (audio.currentTime > 3) { try { audio.currentTime = 0; } catch (e) {} paintTime(); return; }
    if (st.shuffle) { playIndex(pickShuffle(), 0); return; }
    playIndex(st.i - 1, 0);
  }
  function pickShuffle() {
    if (!order || order.length !== TRACKS.length) {
      order = TRACKS.map(function (_, k) { return k; });
    }
    var pool = order.filter(function (k) { return k !== st.i; });
    if (!pool.length) return st.i;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---- 拖动进度条 / 音量条 ----
  function bindBar(bar, onRatio, fill) {
    if (!bar) return null;
    var active = false;
    function ratio(ev) {
      var r = bar.getBoundingClientRect();
      if (!r.width) return 0;
      var x = (ev.touches && ev.touches[0] ? ev.touches[0].clientX : ev.clientX) - r.left;
      return clamp01(x / r.width);
    }
    function down(ev) {
      active = true;
      bar.classList.add('is-drag');
      onRatio(ratio(ev));
      ev.preventDefault();
    }
    function move(ev) { if (active) onRatio(ratio(ev)); }
    function up() { if (!active) return; active = false; bar.classList.remove('is-drag'); save(); }
    bar.addEventListener('mousedown', down);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    bar.addEventListener('touchstart', down, { passive: false });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', up);
    // 键盘可达性：左右箭头微调
    bar.addEventListener('keydown', function (ev) {
      var d = ev.key === 'ArrowRight' ? 0.05 : ev.key === 'ArrowLeft' ? -0.05 : 0;
      if (!d) return;
      onRatio(clamp01(currentRatio() + d));
      save();
      ev.preventDefault();
    });
    function currentRatio() {
      if (bar === el.seek) {
        var dur = audio.duration;
        return (isFinite(dur) && dur > 0) ? clamp01(audio.currentTime / dur) : 0;
      }
      return st.muted ? 0 : st.vol;
    }
    return { currentRatio: currentRatio };
  }

  function seekTo(r) {
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return;
    try { audio.currentTime = clamp01(r) * d; } catch (e) {}
    paintTime();
  }
  function volTo(r) {
    st.vol = clamp01(r);
    st.muted = st.vol === 0;
    if (st.vol > 0) st.lastVol = st.vol;
    audio.volume = st.vol;
    audio.muted = st.muted;
    paintVol();
  }

  // ---- 事件 ----
  if (el.play) el.play.addEventListener('click', toggle);
  if (el.next) el.next.addEventListener('click', function () { next(false); });
  if (el.prev) el.prev.addEventListener('click', prev);
  if (el.shuffle) el.shuffle.addEventListener('click', function () {
    st.shuffle = !st.shuffle; order = null; paintToggles(); save();
  });
  if (el.repeat) el.repeat.addEventListener('click', function () {
    st.repeat = !st.repeat; paintToggles(); save();
  });
  if (el.mute) el.mute.addEventListener('click', function () {
    st.muted = !st.muted;
    if (!st.muted && st.vol === 0) st.vol = st.lastVol || 0.8;
    if (!st.muted) st.vol = st.vol || 0.8;
    audio.volume = st.vol; audio.muted = st.muted;
    paintToggles(); save();
  });
  bindBar(el.seek, seekTo, el.seekFill);
  bindBar(el.vol, volTo, el.volFill);

  audio.addEventListener('loadedmetadata', function () { st.ready = true; paintTime(); });
  audio.addEventListener('durationchange', paintTime);
  audio.addEventListener('timeupdate', paintTime);
  audio.addEventListener('progress', paintTime);
  audio.addEventListener('play', function () { st.playing = true; paintPlay(); save(); });
  audio.addEventListener('pause', function () { st.playing = false; paintPlay(); save(); });
  audio.addEventListener('ended', function () { st.playing = false; next(true); });
  audio.addEventListener('error', function () {
    st.playing = false;
    paintPlay();
    var t = TRACKS[st.i] || {};
    hint('放不了「' + (t.title || t.file || '这首') + '」—— 检查文件在不在 static/music/，或换成 mp3/ogg。');
  });

  // 时钟：进度条靠 timeupdate 更新就够了，但暂停后拖动需要再刷一次
  setInterval(function () { if (st.playing) paintTime(); }, 500);

  // 离开页面：把「正放到第几秒」记下来，下一页接着来
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', save);

  // 别的标签页在同站改了音量/曲目，这边跟上（开着两个标签页时不打架）
  window.addEventListener('storage', function (ev) {
    if (ev.key !== KEY || !ev.newValue) return;
    try {
      var o = JSON.parse(ev.newValue);
      if (typeof o.vol === 'number') { st.vol = o.vol; audio.volume = st.vol; }
      st.muted = !!o.muted; audio.muted = st.muted;
      st.shuffle = !!o.shuffle; st.repeat = !!o.repeat;
      paintToggles();
    } catch (e) {}
  });

  // ---- 启动：恢复上次位置 ----
  var prevState = load();
  audio.volume = st.vol;
  if (prevState) {
    if (typeof prevState.vol === 'number') st.vol = clamp01(prevState.vol);
    st.muted = !!prevState.muted;
    st.shuffle = !!prevState.shuffle;
    st.repeat = !!prevState.repeat;
    audio.volume = st.vol;
    audio.muted = st.muted;
    var idx = (typeof prevState.i === 'number' && prevState.i >= 0 && prevState.i < TRACKS.length) ? prevState.i : 0;
    var at = (typeof prevState.t === 'number' && prevState.t > 0) ? prevState.t : 0;
    paintToggles();
    if (prevState.playing) {
      playIndex(idx, at);          // 接着放；被浏览器拦了就退回暂停态
    } else {
      st.i = idx;
      paintTrack();
      // 不播也要把曲目地址摆好，这样用户点一下就是接着上次那首
      audio.src = TRACKS[idx].url;
      if (at > 0) {
        audio.addEventListener('loadedmetadata', function () {
          try { audio.currentTime = at; } catch (e) {}
          paintTime();
        }, { once: true });
      }
      paintPlay();
      paintTime();
    }
  } else {
    paintToggles();
    paintTrack();
    audio.src = TRACKS[0].url;
    paintPlay();
    paintTime();
  }
})();
