/* ============================================================
   visitor.js —— 自建访客计数器的前端
   ------------------------------------------------------------
   配合 board-api 的 GET /api/hits（Cloudflare Pages Functions + D1）。
   不再用不蒜子：它的统计接口经常 502，而且数字不在自己手里。

   流程：
     1. 本机（127.0.0.1 / localhost）**只读不写** —— 预览不该污染真实计数；
     2. 真站点：带一个本机随机 id（存 localStorage）请求，后端据此去重算 UV，
        原始 id 不落库，服务端只存 sha256 前 16 位；
     3. 成功 → 填三个数字并缓存一份；失败 → 退到缓存并注明「上次统计」，
        连缓存都没有就写一句说明。**永远不隐藏整块。**
   ============================================================ */
(function () {
  'use strict';

  var widget = document.getElementById('visitor-stats');
  var body = widget && widget.querySelector('.counter-body');
  if (!body) return;
  var API = body.getAttribute('data-hits-api') || '';
  if (!API) return;
  /* 站点可能挂在子路径下（/BlogStand/），计数按去掉前缀的路径记 */
  var BASE = (body.getAttribute('data-hits-base') || '').replace(/\/+$/, '');

  var KEYS = ['site_uv', 'site_pv', 'page_pv'];
  var IDS = ['hc_site_uv', 'hc_site_pv', 'hc_page_pv'];
  var LS_ID = 'visitor.id';
  var LS_CACHE = 'visitor.cache';
  var note = widget.querySelector('.counter-note');
  var TIMEOUT = 9000;

  function el(i) { return document.getElementById(IDS[i]); }

  /* 12 字节随机 → 24 位十六进制，只存在这台浏览器里 */
  function visitorId() {
    try {
      var v = localStorage.getItem(LS_ID);
      if (v && /^[a-f0-9]{24}$/.test(v)) return v;
      var a = new Uint8Array(12);
      crypto.getRandomValues(a);
      v = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      localStorage.setItem(LS_ID, v);
      return v;
    } catch (e) { return ''; }
  }

  /* 页面路径：跟后端的 cleanPath 保持一致（去掉站点子路径、补尾斜杠、去 query） */
  function pagePath() {
    var p = location.pathname.split('?')[0];
    if (p.indexOf('/') !== 0) p = '/' + p;
    if (BASE && p.indexOf(BASE + '/') === 0) p = p.slice(BASE.length);
    else if (BASE && p === BASE) p = '/';
    if (!/\/$/.test(p) && !/\.[a-z0-9]+$/i.test(p)) p += '/';
    return p;
  }

  function paint(d) {
    for (var i = 0; i < KEYS.length; i++) {
      var e = el(i);
      if (e && d[KEYS[i]] != null) e.textContent = String(d[KEYS[i]]);
    }
  }

  function save(d) {
    try { localStorage.setItem(LS_CACHE, JSON.stringify({ d: d, at: Date.now() })); } catch (e) {}
  }

  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
      return (o && o.d) ? o : null;
    } catch (e) { return null; }
  }

  function ok() {
    widget.classList.remove('stale');
    widget.removeAttribute('title');
    if (note) note.hidden = true;
  }

  function stale() {
    var c = load();
    if (c) {
      paint(c.d);
      if (note) {
        var t = new Date(c.at);
        note.textContent = '上次统计 ' + (t.getMonth() + 1) + '月' + t.getDate() + '日 ' +
          ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
        note.hidden = false;
      }
      widget.title = '计数后端暂时读不到，上面显示的是上次成功统计的数字';
    } else {
      if (note) {
        note.textContent = '计数服务暂时读不到';
        note.hidden = false;
      }
      widget.title = '计数后端暂时读不到（board-api）';
    }
    widget.classList.add('stale');
  }

  var local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  var url = API + '?p=' + encodeURIComponent(pagePath()) + (local ? '' : '&v=' + visitorId());

  var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT);

  fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)); })
    .then(function (d) {
      clearTimeout(timer);
      if (!d || !d.ok) throw new Error((d && d.error) || 'bad response');
      ok();
      paint(d);
      save(d);
    })
    .catch(function () {
      clearTimeout(timer);
      stale();
    });
})();
