/* ============================================================
   音乐页 / 正文内嵌播放器 —— 播放逻辑
   ------------------------------------------------------------
   一套控件，两种引擎：
     · mp3 / ogg / wav  → HTMLAudioElement（浏览器原生解码）
     · mid              → 浏览器**没有**原生 MIDI 支持，交给 midi-player.js
                          用 Web Audio 现场合成（零音源下载；想换真实音源见
                          文件末尾的 ENGINE 说明，接口已经留好）

   和侧栏那个播放器（music.js）的区别：
     侧栏是「背景音乐」，要跨页面继续放，所以状态存 localStorage、音频对象常驻；
     这里是「曲库播放器」，切页就停、以浏览/试听为主，所以状态不持久化。
     两边共用同一份 data/music.toml。

   容错原则（和站上其它脚本一致）：任何一首放不出来，只在提示行写原因，
   不弹窗、不抛到控制台，也不影响其它曲子继续点。
   ============================================================ */
(function () {
  'use strict';

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var r = Math.floor(s - m * 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /* 同一个页面里可能有好几个播放器（正文内嵌多首），
     同一时刻只让一个响 —— 点另一个就先停掉前一个。 */
  var ACTIVE = null;

  /* 曲目行副标题：MIDI 现在有两种音色来源，跟着开关走 */
  function midiLabel() {
    var sf = window.MidiSF;
    return (sf && sf.enabled() && sf.supported() && sf.phase() !== 'error')
      ? 'MIDI · FluidR3 音源' : 'MIDI · 现场合成';
  }

  function createPlayer(root, opts) {
    opts = opts || {};
    var items = Array.prototype.slice.call(root.querySelectorAll('.mus-item'));
    var elBig = root.querySelector('.mus-big');
    var elBigIc = root.querySelector('#mus-big-ic') || root.querySelector('.mus-big span');
    var elTitle = root.querySelector('.mus-title');
    var elSub = root.querySelector('.mus-sub');
    /* 页面播放器用 id，内嵌播放器用 class —— 两处都认（同一套 createPlayer） */
    var elCur = root.querySelector('#mus-cur') || root.querySelector('.mus-cur');
    var elDur = root.querySelector('#mus-dur') || root.querySelector('.mus-dur');
    var elSeek = root.querySelector('.mus-seek');
    var elBar = root.querySelector('.mus-seek-bar');
    var elVol = root.querySelector('#mus-vol');
    var elEngine = root.querySelector('#mus-engine');
    var elNote = root.querySelector('#mus-note');

    var audio = null;      // HTMLAudioElement，懒建
    var midi = null;       // MidiPlayer，懒建
    var cur = -1;          // 当前曲目下标
    var engine = '';       // 'audio' | 'midi'
    var playing = false;
    var wantAuto = false;  // 换曲子时是否自动播（用户点了列表项就该自动播）

    function say(msg, isErr) {
      if (!elNote) return;
      elNote.textContent = msg;
      elNote.classList.toggle('err', !!isErr);
    }

    function setPlayingUI(on) {
      playing = on;
      if (elBig) elBig.classList.toggle('is-playing', on);
      if (elBigIc) elBigIc.textContent = on ? '❚❚' : '▶';
      root.querySelectorAll('.mus-item').forEach(function (it) {
        it.classList.toggle('is-playing', on && +it.dataset.idx === cur);
      });
    }

    function setBar(t, d) {
      var p = (isFinite(d) && d > 0) ? Math.max(0, Math.min(1, t / d)) : 0;
      if (elBar) elBar.style.width = (p * 100).toFixed(2) + '%';
      if (elCur) elCur.textContent = fmtTime(t);
      if (elDur) elDur.textContent = fmtTime(d);
    }

    function highlight(i) {
      root.querySelectorAll('.mus-item').forEach(function (it) {
        it.classList.toggle('is-cur', +it.dataset.idx === i);
      });
    }

    function killAudio() {
      if (!audio) return;
      try { audio.pause(); } catch (e) {}
      audio.removeAttribute('src');
      try { audio.load(); } catch (e) {}
      audio = null;
    }

    function killMidi() {
      if (!midi) return;
      try { midi.destroy(); } catch (e) {}
      midi = null;
    }

    function stopAll() {
      killAudio();
      killMidi();
      setPlayingUI(false);
    }

    function ensureAudio() {
      if (audio) return audio;
      audio = new Audio();
      audio.preload = 'metadata';
      audio.addEventListener('timeupdate', function () {
        if (engine === 'audio') setBar(audio.currentTime, audio.duration);
      });
      audio.addEventListener('loadedmetadata', function () {
        if (engine === 'audio') { setBar(0, audio.duration); paintVol(); }
      });
      audio.addEventListener('ended', function () {
        if (engine !== 'audio') return;
        setPlayingUI(false);
        /* 播完自动跳下一首（最后一首就停） */
        if (cur >= 0 && cur < items.length - 1) pick(cur + 1, true);
      });
      audio.addEventListener('error', function () {
        if (engine !== 'audio') return;
        setPlayingUI(false);
        say('这首放不出来（文件缺失或浏览器不支持这个格式）', true);
      });
      return audio;
    }

    function paintVol() {
      var v = elVol ? (+elVol.value) / 100 : 0.8;
      if (audio) { try { audio.volume = v; } catch (e) {} }
      if (midi && midi.master) { try { midi.master.gain.value = v * 0.9; } catch (e) {} }
    }

    function pick(i, autoplay) {
      if (i < 0 || i >= items.length) return;
      var it = items[i];
      var fmt = (it.dataset.fmt || '').toLowerCase();
      var url = it.dataset.url || '';
      var title = it.dataset.title || '';
      var artist = it.dataset.artist || '';

      /* 点同一个正在放的曲目 = 播放/暂停切换 */
      if (i === cur && (audio || midi)) {
        if (ACTIVE && ACTIVE !== api) ACTIVE.pause();
        toggle();
        return;
      }

      stopAll();
      cur = i;
      wantAuto = !!autoplay;
      highlight(i);
      if (elTitle) elTitle.textContent = title;
      if (elSub) elSub.textContent = artist || (fmt === 'mid' ? midiLabel() : (fmt ? fmt.toUpperCase() : ''));
      setBar(0, 0);
      if (ACTIVE && ACTIVE !== api) { try { ACTIVE.pause(); } catch (e) {} }
      ACTIVE = api;

      if (fmt === 'mid' || fmt === 'midi') { startMidi(url, autoplay); return; }
      /* 其它格式一律交给 <audio>：mp3/ogg/wav/m4a/flac 支持与否由浏览器决定 */
      var a = ensureAudio();
      engine = 'audio';
      if (elEngine) { elEngine.textContent = '音频文件'; elEngine.className = 'mus-badge on'; }
      say('直接播放音频文件（' + (fmt || '?').toUpperCase() + '）');
      a.src = url;
      paintVol();
      if (autoplay) playAudio();
    }

    function playAudio() {
      var a = ensureAudio();
      var p = a.play();
      if (p && p.catch) p.catch(function (e) {
        setPlayingUI(false);
        say('浏览器拒绝了播放（需要先点一下页面）：' + (e && e.name || ''), true);
      });
      setPlayingUI(true);
    }

    /* MIDI 有两个引擎，二选一：
         · 内置（默认）      零下载，三角/方波现场合成
         · 真实音源（点了才开）SpessaSynth + FluidR3Mono，24 MB，采样回放
       真实音源挂了就**静默退回**内置 —— 宁可音色差一点，也不能没声音。 */
    function startMidi(url, autoplay) {
      var sf = window.MidiSF;
      if (!(sf && sf.enabled() && sf.supported() && sf.phase() !== 'error')) { mountBuiltin(url, autoplay); return; }

      var want = cur;
      var off = sf.onProgress(function (p, got, total, cached) {
        if (cur !== want) return;
        if (cached) { say('真实音源已缓存，正在装载…'); return; }
        say('正在下载音源 ' + Math.round(p * 100) + '%' +
            (total ? '（' + (got / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB，只需一次）' : '…'));
      });
      if (elEngine) { elEngine.textContent = '音源装载中'; elEngine.className = 'mus-badge'; }
      say('正在准备真实音源（约 24 MB，只需一次）…');

      sf.ensure().then(function () {
        off();
        if (cur !== want) return;      // 下载期间用户又点了别的曲子
        mountSoundfont(url, autoplay);
      }).catch(function (e) {
        off();
        if (cur !== want) return;
        console.warn('[music] 真实音源加载失败，退回内置合成：', e);
        say('真实音源加载失败，已退回内置合成：' + ((e && e.message) || e), true);
        mountBuiltin(url, autoplay);
      });
    }

    function mountSoundfont(url, autoplay) {
      engine = 'midi';
      if (elEngine) { elEngine.textContent = '真实音源'; elEngine.className = 'mus-badge on'; }
      if (elSub) elSub.textContent = 'MIDI · FluidR3 音源';
      var m = window.MidiSF.createPlayer(url, {
        onState: function (s) {
          setPlayingUI(s === 'playing');
          if (s === 'playing') say('MIDI：FluidR3Mono 采样音源（真实乐器音色）');
          if (s === 'paused') say('已暂停');
          if (s === 'ended') say('放完了');
          if (s === 'error') say('这个 mid 放不出来（文件缺失或解析失败）', true);
        },
        onTick: function (t, d) { setBar(t, d); },
        onEnd: function () {
          setPlayingUI(false);
          if (cur >= 0 && cur < items.length - 1) pick(cur + 1, true);
        },
        onError: function (e) { say('MIDI 读取失败：' + (e && e.message || e), true); }
      });
      midi = m;
      paintVol();
      if (elDur) elDur.textContent = '–:––';
      if (autoplay) {
        m.play().catch(function (e) { say('MIDI 播放失败：' + (e && e.message || e), true); });
      }
    }

    function mountBuiltin(url, autoplay) {
      if (typeof window.MidiPlayer !== 'function') {
        say('MIDI 合成器没加载（midi-player.js 缺失）', true);
        return;
      }
      engine = 'midi';
      if (elEngine) { elEngine.textContent = '合成音源'; elEngine.className = 'mus-badge on'; }
      if (elSub) elSub.textContent = 'MIDI · 现场合成';
      say('MIDI：浏览器现场合成（三角/方波 + ADSR，不下载音源）');
      var m = new window.MidiPlayer(url, {
        onState: function (s) {
          setPlayingUI(s === 'playing');
          if (s === 'loading') say('正在读取 MIDI…');
          /* 读完之后要把提示改回来：不然会一直停在「正在读取」上（实测踩过） */
          if (s === 'playing') say('MIDI：浏览器现场合成（三角/方波 + ADSR，不下载音源）');
          if (s === 'paused') say('已暂停');
          if (s === 'ended') say('放完了');
          if (s === 'error') say('这个 mid 放不出来（文件缺失或解析失败）', true);
        },
        onTick: function (t, d) { setBar(t, d); },
        onEnd: function () {
          setPlayingUI(false);
          if (cur >= 0 && cur < items.length - 1) pick(cur + 1, true);
        },
        onError: function (e) { say('MIDI 读取失败：' + (e && e.message || e), true); }
      });
      midi = m;
      paintVol();
      if (elDur) elDur.textContent = '–:––';
      if (autoplay) {
        m.play().then(function () {
          /* play() 里已经把 state 推到 playing，onState 会更新 UI */
          paintVol();
        }).catch(function (e) { say('MIDI 播放失败：' + (e && e.message || e), true); });
      } else {
        m.load && m.load().catch(function () {});
      }
    }

    function toggle() {
      if (cur < 0) { if (items.length) pick(0, true); return; }
      if (engine === 'audio' && audio) {
        if (audio.paused) playAudio();
        else { audio.pause(); setPlayingUI(false); }
        return;
      }
      if (engine === 'midi' && midi) {
        if (midi.state === 'playing') midi.pause();
        else midi.play().then(paintVol).catch(function (e) { say('MIDI 播放失败：' + (e && e.message || e), true); });
        return;
      }
      /* 还没播过：从头开始 */
      if (cur >= 0) pick(cur, true);
    }

    function duration() {
      if (engine === 'audio' && audio) return audio.duration || 0;
      if (engine === 'midi' && midi) return midi.duration ? midi.duration() : 0;
      return 0;
    }
    function position() {
      if (engine === 'audio' && audio) return audio.currentTime || 0;
      if (engine === 'midi' && midi) return midi.currentTime ? midi.currentTime() : 0;
      return 0;
    }
    function seekTo(sec) {
      sec = Math.max(0, Math.min(sec, duration()));
      if (engine === 'audio' && audio) { try { audio.currentTime = sec; } catch (e) {} setBar(sec, duration()); }
      else if (engine === 'midi' && midi) { midi.seek(sec); setBar(sec, duration()); }
    }

    /* ---- 事件绑定 ---- */
    items.forEach(function (it) {
      it.addEventListener('click', function () { pick(+it.dataset.idx, true); });
    });

    /* 评语展开：按钮在 .mus-item 里，面板是它的**下一个兄弟** <li>。
       必须 stopPropagation —— 否则点「评语」会冒泡到 .mus-item，把曲子也点了。 */
    root.querySelectorAll('.mus-note-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var row = btn.closest('.mus-item');
        var panel = row && row.nextElementSibling;
        if (!panel || !panel.classList.contains('mus-review')) return;
        var willOpen = panel.hasAttribute('hidden');
        if (willOpen) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        btn.classList.toggle('is-open', willOpen);
        btn.textContent = willOpen ? '评语 ▴' : '评语 ▾';
      });
    });

    if (elBig) elBig.addEventListener('click', toggle);

    if (elSeek) {
      var seekFromEvent = function (e) {
        var r = elSeek.getBoundingClientRect();
        var x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
        seekTo(Math.max(0, Math.min(1, x / r.width)) * duration());
      };
      elSeek.addEventListener('click', seekFromEvent);
      /* 拖动：按下后跟着 pointermove 走，松开结束 */
      var dragging = false;
      elSeek.addEventListener('pointerdown', function (e) {
        dragging = true;
        try { elSeek.setPointerCapture(e.pointerId); } catch (x) {}
        seekFromEvent(e);
      });
      elSeek.addEventListener('pointermove', function (e) { if (dragging) seekFromEvent(e); });
      elSeek.addEventListener('pointerup', function () { dragging = false; });
      elSeek.addEventListener('pointercancel', function () { dragging = false; });
    }
    if (elVol) elVol.addEventListener('input', paintVol);

    /* 离开页面时把还在响的掐掉（MIDI 的 AudioContext 不掐会一直响） */
    window.addEventListener('pagehide', function () { try { stopAll(); } catch (e) {} });

    var api = {
      pick: pick, toggle: toggle, pause: function () { if (playing) toggle(); },
      stop: stopAll, seekTo: seekTo,
      get index() { return cur; },
      get fmt() { return cur >= 0 ? (items[cur].dataset.fmt || '').toLowerCase() : ''; },
      get engine() { return engine; },
      get isPlaying() { return playing; },
    };
    return api;
  }

  /* ---- 真实音源开关 ----------------------------------------------------
     只在音乐页有 #mus-sf 按钮；内嵌播放器没有按钮，跟着存下的偏好走。
     切换后如果正在放 MIDI，就按新引擎重放一遍（否则要等下次点曲子才生效）。 */
  function wireSoundfont(api) {
    var btn = document.getElementById('mus-sf');
    var note = document.getElementById('mus-note');
    var sf = window.MidiSF;
    if (!btn) return;
    if (!sf || !sf.supported()) { btn.hidden = true; return; }

    function pageSay(msg, isErr) {
      if (!note) return;
      note.textContent = msg;
      note.classList.toggle('err', !!isErr);
    }

    /* 引擎徽标跟着开关走（正在放 mp3 时别抢它的徽标） */
    function badge(txt) {
      var b = document.getElementById('mus-engine');
      if (!b || api.engine === 'audio') return;
      b.textContent = txt;
      b.className = 'mus-badge on';
    }

    function paint() {
      var ph = sf.phase();
      if (ph === 'loading') {
        btn.className = 'mus-sf is-loading';
        btn.textContent = '音源 ' + Math.round(sf.progress() * 100) + '%';
        btn.setAttribute('aria-pressed', 'true');
        return;
      }
      if (ph === 'error') {
        btn.className = 'mus-sf is-err';
        btn.textContent = '音源失败';
        btn.title = '真实音源加载失败（点一下重试）：' + sf.error();
        return;
      }
      if (sf.enabled()) {
        btn.className = 'mus-sf is-on';
        btn.textContent = '真实音源 ✓';
        btn.setAttribute('aria-pressed', 'true');
        btn.title = '正在用 FluidR3Mono 采样音源（' + sf.fmtMB(sf.bytes()) + '）';
      } else {
        btn.className = 'mus-sf';
        btn.textContent = '真实音源';
        btn.setAttribute('aria-pressed', 'false');
        btn.title = '改用 FluidR3Mono 采样音源（首次约 24 MB，之后走缓存）';
      }
    }

    function remount() {
      var i = api.index;
      if (i < 0 || api.fmt !== 'mid') return;   /* 放的是 mp3 就别去打断它 */
      var was = api.isPlaying;
      api.stop();
      api.pick(i, was);
    }

    btn.addEventListener('click', function () {
      var want = !sf.enabled();
      sf.setEnabled(want);
      if (!want) { paint(); badge('合成音源'); remount(); return; }

      paint();
      badge('音源装载中');
      var off = sf.onProgress(function () { paint(); });
      pageSay('正在下载真实音源…（约 24 MB，只需一次）');
      sf.ensure().then(function () {
        off();
        paint();
        badge('真实音源');
        pageSay('真实音源就绪：' + sf.fmtMB(sf.bytes()) + (sf.fromCache() ? '（取自本地缓存）' : ''));
        remount();
      }).catch(function (e) {
        off();
        paint();
        badge('合成音源');
        pageSay('真实音源加载失败，继续用内置合成：' + ((e && e.message) || e), true);
        remount();   /* 没成也要把当前 MIDI 拉回内置引擎 */
      });
    });

    /* 刷新后偏好还留着：徽标先按偏好显示（真正点开 MIDI 时才去下载音源） */
    if (sf.enabled()) badge('真实音源');
    paint();
  }

  /* ---- 自动初始化 ---- */
  function boot() {
    var page = document.getElementById('mus-root');
    if (page) {
      var api = createPlayer(page, {});
      window.__mus = api;
      wireSoundfont(api);
    }
    /* 正文内嵌的单曲播放器：每个 .mus-inline 自己一个实例。
       内嵌播放器没有开关按钮，跟着音乐页存下的偏好走。 */
    document.querySelectorAll('.mus-inline').forEach(function (root) {
      createPlayer(root, {});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
