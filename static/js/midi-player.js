/* ============================================================
   点阵站 · MIDI 在线播放器
   ------------------------------------------------------------
   浏览器**没有**内建的 MIDI 支持：<audio src="x.mid"> 在所有主流浏览器里
   都是「格式不支持」。所以这个文件自己做三件事：

     1. 解析标准 MIDI 文件（SMF format 0 / 1）
        —— 头块 MThd、轨块 MTrk、变长数(VLQ)、running status、元事件（速度）。
     2. 把「tick + 速度表」换算成秒（每首曲子中途可能变速）。
     3. 用 Web Audio 现场合成：GM 音色按类别映射到几种波形 + ADSR 包络。
        不加载任何 soundfont —— 既没有几 MB 的下载，音色也是干净的
        「芯片音乐」味道，和这个点阵站的调子正好合。

   为什么不用现成的库（spessasynth / MIDI.js 之类）：
     它们要么要外链，要么要拖一份几 MB 的 SF2 进来。这个站的音乐页只有
     一首两首 mid，自己写反而更小、更可控、离线可用。

   用法：
     var p = new MidiPlayer(url, { onState, onTick, onEnd, onError });
     p.play(); p.pause(); p.stop(); p.seek(秒); p.duration; p.currentTime;

   ⚠️ 调度策略：**滚动窗口**，不是一次性排完。
      整首一次性建几百上千个 Oscillator 会把内存和主线程压爆（实测长曲会卡）；
      这里每 100ms 往前看 0.6s，只把窗口内的音符排进去。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 1. SMF 解析 ---------------- */

  function Reader(buf) {
    this.d = new Uint8Array(buf);
    this.p = 0;
  }
  Reader.prototype.u8 = function () { return this.d[this.p++]; };
  Reader.prototype.u16 = function () { var v = (this.d[this.p] << 8) | this.d[this.p + 1]; this.p += 2; return v; };
  Reader.prototype.u32 = function () {
    var v = ((this.d[this.p] << 24) >>> 0) + (this.d[this.p + 1] << 16) + (this.d[this.p + 2] << 8) + this.d[this.p + 3];
    this.p += 4; return v;
  };
  Reader.prototype.str4 = function () {
    var s = String.fromCharCode(this.d[this.p], this.d[this.p + 1], this.d[this.p + 2], this.d[this.p + 3]);
    this.p += 4; return s;
  };
  Reader.prototype.skip = function (n) { this.p += n; };
  /* 变长数：最多 4 字节，每字节低 7 位，最高位表示「还有」 */
  Reader.prototype.vlq = function () {
    var v = 0, n = 0, b;
    do { b = this.d[this.p++]; v = (v << 7) | (b & 0x7f); n++; } while ((b & 0x80) && n < 5);
    return v;
  };

  function parseMidi(buf) {
    var r = new Reader(buf);
    if (r.str4() !== 'MThd') throw new Error('不是 MIDI 文件（缺少 MThd）');
    var hlen = r.u32();
    var fmt = r.u16();
    var ntrk = r.u16();
    var div = r.u16();
    r.skip(Math.max(0, hlen - 6));

    /* division 为负 = SMPTE 时基（这里少见，做个兜底换算） */
    var ticksPerQuarter = div > 0 ? div : 480;
    var smpte = div & 0x8000 ? Math.max(1, (256 - (div >> 8)) * (div & 0xff)) : 0;

    var notes = [];        // {tick, dur, note, vel, ch, prog}
    var tempos = [];       // {tick, usPerQuarter}
    tempos.push({ tick: 0, us: 500000 });   // 默认 120 BPM
    /* 每个通道当前的音色号（0xCn program change）。
       ⚠️ 真实曲子里这条**必须有**：站长的 mid 有 12~15 个通道（鼓、贝斯、弦乐、主音…），
          如果所有通道都按同一个预设合成，听起来就是一片糊。 */
    var programs = {};

    for (var ti = 0; ti < ntrk; ti++) {
      if (r.p + 8 > r.d.length) break;
      var id = r.str4();
      var len = r.u32();
      var end = r.p + len;
      if (id !== 'MTrk') { r.p = end; continue; }

      var tick = 0;
      var status = 0;
      var active = {};   // key: ch*128+note -> {tick, vel}
      while (r.p < end) {
        tick += r.vlq();
        var b = r.d[r.p];
        if (b & 0x80) { status = b; r.p++; } else { /* running status：沿用上一个 status */ }

        if (status === 0xff) {
          var type = r.u8();
          var mlen = r.vlq();
          if (type === 0x51 && mlen >= 3) {
            var us = (r.d[r.p] << 16) | (r.d[r.p + 1] << 8) | r.d[r.p + 2];
            if (ticksPerQuarter) tempos.push({ tick: tick, us: us });
            r.skip(mlen);
          } else {
            r.skip(mlen);
          }
          status = 0;   // meta 之后不能跑 running status
        } else if (status === 0xf0 || status === 0xf7) {
          var slen = r.vlq();
          r.skip(slen);
          status = 0;
        } else {
          var cmd = status & 0xf0, ch = status & 0x0f;
          if (cmd === 0x90) {              // note on
            var note = r.u8(), vel = r.u8();
            if (vel === 0) {
              end_note(ch, note, tick);
            } else {
              var k = ch * 128 + note;
              if (active[k]) end_note(ch, note, tick);   // 同音重复：先收掉前一个
              active[k] = { tick: tick, vel: vel, prog: programs[ch] | 0 };
            }
          } else if (cmd === 0x80) {        // note off
            end_note(ch, r.u8(), tick);
            r.u8();
          } else if (cmd === 0xa0 || cmd === 0xb0 || cmd === 0xe0) {
            r.skip(2);
          } else if (cmd === 0xc0) {        // program change：记下来，合成时选音色用
            programs[ch] = r.u8();
          } else if (cmd === 0xd0) {
            r.skip(1);
          } else {
            /* 认不出来：别死循环，跳过这一字节 */
            r.p++;
          }
        }
      }
      /* 轨道结束时还没松开的音，收在最后一个 tick */
      for (var key in active) {
        var c2 = Math.floor(key / 128), n2 = key % 128;
        var st = active[key];
        notes.push({ tick: st.tick, dur: Math.max(1, tick - st.tick), note: n2, vel: st.vel, ch: c2, prog: st.prog | 0 });
      }
      r.p = end;
    }

    function end_note(ch, note, tick) {
      var k = ch * 128 + note;
      var st = active[k];
      if (!st) return;
      delete active[k];
      notes.push({ tick: st.tick, dur: Math.max(1, tick - st.tick), note: note, vel: st.vel, ch: ch, prog: st.prog | 0 });
    }

    /* tick -> 秒：按速度表分段积分 */
    tempos.sort(function (a, b) { return a.tick - b.tick; });
    var uniq = [];
    for (var i = 0; i < tempos.length; i++) {
      if (!uniq.length || uniq[uniq.length - 1].tick !== tempos[i].tick) uniq.push(tempos[i]);
      else uniq[uniq.length - 1].us = tempos[i].us;
    }
    function tickToSec(t) {
      var sec = 0, last = 0, us = uniq[0].us;
      for (var i = 0; i < uniq.length; i++) {
        var seg = uniq[i];
        if (seg.tick >= t) break;
        sec += (seg.tick - last) / ticksPerQuarter * (us / 1000000);
        last = seg.tick; us = seg.us;
      }
      sec += (t - last) / ticksPerQuarter * (us / 1000000);
      return sec;
    }

    notes.sort(function (a, b) { return a.tick - b.tick; });
    var out = [];
    var maxT = 0;
    var drums = 0;
    for (var j = 0; j < notes.length; j++) {
      var n = notes[j];
      var s = tickToSec(n.tick);
      var e = tickToSec(n.tick + n.dur);
      if (n.ch === 9) { drums++; continue; }   // 打击乐：先不合成（没有鼓采样，硬合成只会是噪音）
      out.push({ t: s, d: Math.max(0.03, e - s), note: n.note, vel: n.vel, ch: n.ch, prog: n.prog | 0 });
      if (e > maxT) maxT = e;
    }
    return { notes: out, duration: maxT, format: fmt, tracks: ntrk, smpte: smpte, drums: drums };
  }

  /* ---------------- 2. 合成 ---------------- */

  /* GM 音色 -> 波形/包络。不追求还原，只要「不同曲子听得出区别」。 */
  function voiceFor(program) {
    var p = program | 0;
    if (p < 8) return { wave: 'triangle', a: 0.005, d: 0.12, s: 0.28, r: 0.18, detune: 0 };   // 钢琴
    if (p < 16) return { wave: 'sine', a: 0.002, d: 0.18, s: 0.05, r: 0.25, detune: 0 };      // 钢片琴
    if (p < 24) return { wave: 'square', a: 0.01, d: 0.08, s: 0.55, r: 0.12, detune: 0 };      // 风琴
    if (p < 32) return { wave: 'square', a: 0.01, d: 0.10, s: 0.42, r: 0.12, detune: 0 };      // 吉他
    if (p < 40) return { wave: 'sawtooth', a: 0.01, d: 0.14, s: 0.30, r: 0.18, detune: 0 };    // 贝斯
    if (p < 48) return { wave: 'sawtooth', a: 0.06, d: 0.20, s: 0.45, r: 0.30, detune: 6 };    // 弦乐
    if (p < 56) return { wave: 'sawtooth', a: 0.05, d: 0.18, s: 0.50, r: 0.28, detune: 4 };    // 合奏
    if (p < 64) return { wave: 'square', a: 0.03, d: 0.14, s: 0.50, r: 0.20, detune: 0 };      // 铜管
    if (p < 72) return { wave: 'sine', a: 0.02, d: 0.12, s: 0.45, r: 0.20, detune: 0 };        // 簧管
    if (p < 80) return { wave: 'sine', a: 0.02, d: 0.10, s: 0.55, r: 0.16, detune: 0 };        // 管乐
    if (p < 88) return { wave: 'square', a: 0.005, d: 0.10, s: 0.40, r: 0.14, detune: 6 };     // 合成主音
    if (p < 96) return { wave: 'sine', a: 0.12, d: 0.25, s: 0.60, r: 0.40, detune: 8 };        // 合成铺底
    return { wave: 'triangle', a: 0.01, d: 0.12, s: 0.40, r: 0.18, detune: 0 };
  }

  function freqOf(note) { return 440 * Math.pow(2, (note - 69) / 12); }

  /* ---------------- 3. 播放器 ---------------- */

  function MidiPlayer(url, opts) {
    opts = opts || {};
    this.url = url;
    this.opts = opts;
    this.ctx = null;
    this.data = null;
    this.state = 'idle';          // idle | loading | playing | paused | ended | error
    this.offset = 0;              // 已播放秒数（暂停时记住）
    this.startCtxTime = 0;        // 本次 play 的 ctx.currentTime 起点
    this.nextIdx = 0;             // 下一个要排的音符下标
    this.timer = 0;
    this.active = [];             // 正在响的节点（停/跳转时要能立刻掐掉）
    this.master = null;
  }

  MidiPlayer.prototype._setState = function (s) {
    this.state = s;
    if (this.opts.onState) try { this.opts.onState(s); } catch (e) {}
  };

  MidiPlayer.prototype.load = function () {
    var self = this;
    if (this.data) return Promise.resolve(this.data);
    this._setState('loading');
    return fetch(this.url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        self.data = parseMidi(buf);
        if (!self.data.notes.length) throw new Error('这个 mid 里没有可播放的音符');
        self._setState('idle');
        return self.data;
      })
      .catch(function (e) {
        self._setState('error');
        if (self.opts.onError) try { self.opts.onError(e); } catch (x) {}
        throw e;
      });
  };

  MidiPlayer.prototype._ensureCtx = function () {
    if (this.ctx) return this.ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) throw new Error('浏览器不支持 Web Audio');
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    /* 留一点余量防削波：合奏区本来就容易堆得很响 */
    var comp = this.ctx.createDynamicsCompressor ? this.ctx.createDynamicsCompressor() : null;
    if (comp) { this.master.connect(comp); comp.connect(this.ctx.destination); }
    else this.master.connect(this.ctx.destination);
    return this.ctx;
  };

  MidiPlayer.prototype.duration = function () { return this.data ? this.data.duration : 0; };

  MidiPlayer.prototype.currentTime = function () {
    if (!this.data) return 0;
    if (this.state !== 'playing') return Math.min(this.offset, this.data.duration);
    return Math.min(this.offset + (this.ctx.currentTime - this.startCtxTime), this.data.duration);
  };

  MidiPlayer.prototype._scheduleWindow = function () {
    var self = this;
    var data = this.data;
    var now = this.ctx.currentTime;
    var elapsed = now - this.startCtxTime;
    var base = this.offset;                 // 本次播放从第几秒开始
    var lookahead = 0.6;
    var until = elapsed + lookahead;

    while (this.nextIdx < data.notes.length) {
      var n = data.notes[this.nextIdx];
      if (n.t - base > until) break;
      var when = this.startCtxTime + (n.t - base);
      if (when < now - 0.05) { this.nextIdx++; continue; }   // 落在过去（seek 之后）就跳过
      this._fire(n, when);
      this.nextIdx++;
    }
    if (this.opts.onTick) {
      try { self.opts.onTick(self.currentTime(), data.duration); } catch (e) {}
    }
    /* 结束判定 */
    if (this.nextIdx >= data.notes.length && elapsed >= data.duration - base + 0.25) {
      if (self.active.length === 0 || elapsed > data.duration - base + 2.5) {
        self._stopTimer();
        self.offset = data.duration;
        self._setState('ended');
        if (self.opts.onEnd) try { self.opts.onEnd(); } catch (e) {}
      }
    }
  };

  MidiPlayer.prototype._fire = function (n, when) {
    var self = this;
    var ctx = this.ctx;
    var v = voiceFor(n.prog || 0);   // 按该音符所在通道的音色号选波形/包络
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = v.wave;
    osc.frequency.value = freqOf(n.note);
    if (v.detune) osc.detune.value = v.detune;
    var peak = Math.max(0.02, Math.min(0.5, (n.vel / 127) * 0.42));
    var t0 = Math.max(when, ctx.currentTime);
    var end = t0 + n.d;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(v.a + 0.01, n.d * 0.3));
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * v.s), t0 + Math.min(v.a + v.d, n.d * 0.6));
    g.gain.exponentialRampToValueAtTime(0.0001, end + v.r);
    osc.connect(g); g.connect(this.master);
    osc.start(t0);
    osc.stop(end + v.r + 0.02);
    var rec = { osc: osc, g: g };
    this.active.push(rec);
    osc.onended = function () {
      var i = self.active.indexOf(rec);
      if (i >= 0) self.active.splice(i, 1);
      try { g.disconnect(); } catch (e) {}
    };
  };

  MidiPlayer.prototype._killActive = function () {
    var now = this.ctx ? this.ctx.currentTime : 0;
    for (var i = 0; i < this.active.length; i++) {
      var r = this.active[i];
      try { r.g.gain.cancelScheduledValues(now); r.g.gain.setValueAtTime(0.0001, now); } catch (e) {}
      try { r.osc.stop(now + 0.02); } catch (e) {}
    }
    this.active = [];
  };

  MidiPlayer.prototype._stopTimer = function () {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  };

  MidiPlayer.prototype.play = function () {
    var self = this;
    var kick = function () {
      self._ensureCtx();
      if (self.ctx.state === 'suspended') self.ctx.resume();
      if (self.state === 'ended') self.offset = 0;
      self.startCtxTime = self.ctx.currentTime;
      /* 从 offset 之后第一个音符开始 */
      self.nextIdx = 0;
      while (self.nextIdx < self.data.notes.length && self.data.notes[self.nextIdx].t < self.offset) self.nextIdx++;
      self._setState('playing');
      self._scheduleWindow();
      self.timer = setInterval(function () { self._scheduleWindow(); }, 100);
    };
    if (this.data) { kick(); return Promise.resolve(); }
    return this.load().then(kick);
  };

  MidiPlayer.prototype._pauseAt = function () {
    var t = this.currentTime();
    this._stopTimer();
    this._killActive();
    this.offset = t;
    this._setState('paused');
  };

  MidiPlayer.prototype.pause = function () {
    if (this.state !== 'playing') return;
    this._pauseAt();
  };

  MidiPlayer.prototype.toggle = function () {
    if (this.state === 'playing') this.pause();
    else return this.play();
  };

  MidiPlayer.prototype.stop = function () {
    this._stopTimer();
    this._killActive();
    this.offset = 0;
    this._setState('idle');
    if (this.opts.onTick && this.data) try { this.opts.onTick(0, this.data.duration); } catch (e) {}
  };

  MidiPlayer.prototype.seek = function (sec) {
    if (!this.data) return;
    var wasPlaying = this.state === 'playing';
    sec = Math.max(0, Math.min(sec, this.data.duration));
    this._stopTimer();
    this._killActive();
    this.offset = sec;
    this._setState(wasPlaying ? 'paused' : this.state);
    if (wasPlaying) this.play();
    else if (this.opts.onTick) try { this.opts.onTick(sec, this.data.duration); } catch (e) {}
  };

  MidiPlayer.prototype.destroy = function () {
    this._stopTimer();
    this._killActive();
    try { if (this.ctx) this.ctx.close(); } catch (e) {}
    this.ctx = null;
  };

  global.MidiPlayer = MidiPlayer;
  global.MidiPlayer.parse = function (buf) { return parseMidi(buf); };
})(window);
