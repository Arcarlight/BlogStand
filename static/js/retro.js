/* ============================================================
   retro.js —— 页面上的各种小玩意儿
   站点运行天数 / 时钟 / 一言 / 站内搜索 / 计数器兜底
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 1. 站点已运行天数 ---------- */
  var up = document.getElementById('site-uptime');
  if (up && up.getAttribute('data-since')) {
    var since = new Date(up.getAttribute('data-since') + 'T00:00:00');
    if (!isNaN(since.getTime())) {
      var days = Math.floor((Date.now() - since.getTime()) / 86400000);
      if (days < 0) { days = 0; }
      up.textContent = String(days);
    }
  }

  /* ---------- 2. 实时时钟 ---------- */
  var clockEl = document.getElementById('retro-clock');
  var dateEl = document.getElementById('retro-date');
  var WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function tick() {
    var d = new Date();
    if (clockEl) {
      clockEl.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    if (dateEl) {
      dateEl.textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()];
    }
  }
  if (clockEl || dateEl) { tick(); setInterval(tick, 1000); }

  /* ---------- 3. 一言 ---------- */
  var hk = document.getElementById('hitokoto-text');
  if (hk) {
    fetch('https://v1.hitokoto.cn/?c=i&c=k')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        hk.textContent = '「' + data.hitokoto + '」';
        var from = document.getElementById('hitokoto-from');
        if (from) { from.textContent = '—— ' + (data.from || '佚名'); }
      })
      .catch(function () { hk.textContent = '一言服务器好像挂掉了……'; });
  }

  /* ---------- 4. 站内搜索：自动补 site: 前缀 ---------- */
  var form = document.getElementById('site-search-form');
  var input = document.getElementById('site-search-input');
  if (form && input) {
    form.addEventListener('submit', function () {
      var q = input.value.replace(/^\s+|\s+$/g, '');
      if (q && q.indexOf('site:') !== 0) {
        input.value = 'site:' + location.host + ' ' + q;
      }
    });
  }

  /* ---------- 5. 访客计数器兜底（不蒜子挂了也别显示一横杠） ---------- */
  setTimeout(function () {
    var ids = ['busuanzi_value_site_uv', 'busuanzi_value_site_pv', 'busuanzi_value_page_pv'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && /^-*$/.test(el.textContent.replace(/\s/g, ''))) {
        el.textContent = '离线';
      }
    }
  }, 6000);

  /* ---------- 6. 正文里的外部链接自动在新窗口打开 ---------- */
  var links = document.querySelectorAll('.entry-content a[href^="http"]');
  for (var j = 0; j < links.length; j++) {
    var a = links[j];
    if (a.hostname && a.hostname !== location.hostname) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    }
  }

  /* ---------- 7. 日记：给「每一天」挂一个独立的回复区 ----------
     评论系统（utterances）一个页面只能挂一个实例，
     所以每天用一个 iframe 指向 /reply/?t=… 来拿到独立留言板。
     默认收起，点了才加载，免得一页塞十几个 iframe。 */
  (function dayReplies() {
    var cfg = window.SITE_REPLY;
    if (!cfg || !cfg.repo || !cfg.base) { return; }
    if (document.body.getAttribute('data-day-replies') !== '1') { return; }

    var content = document.querySelector('.entry-content');
    if (!content) { return; }

    var titleEl = document.querySelector('.entry-title');
    var pageTitle = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';

    // 找出所有「日期锚点」标题（span id 是四位数字，比如 0206）
    var heads = [];
    var h2s = content.querySelectorAll('h2');
    for (var i = 0; i < h2s.length; i++) {
      var sp = h2s[i].querySelector('span[id]');
      if (sp && /^\d{4}$/.test(sp.id)) {
        heads.push({ el: h2s[i], day: sp.textContent.replace(/\s+/g, ' ').trim() });
      }
    }
    if (!heads.length) { return; }

    function build(cur, next) {
      var term = pageTitle + ' · ' + cur.day;

      var box = document.createElement('div');
      box.className = 'day-reply';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day-reply-btn';
      btn.textContent = '💬 回复 ' + cur.day;

      var body = document.createElement('div');
      body.className = 'day-reply-body';
      body.hidden = true;

      btn.addEventListener('click', function () {
        if (body.getAttribute('data-loaded')) {
          body.hidden = !body.hidden;
          btn.textContent = body.hidden ? ('💬 回复 ' + cur.day) : '✕ 收起回复';
          return;
        }
        body.setAttribute('data-loaded', '1');
        body.hidden = false;
        btn.disabled = true;
        btn.textContent = '✕ 收起回复';

        var f = document.createElement('iframe');
        f.className = 'day-reply-frame';
        f.setAttribute('title', '回复：' + term);
        f.src = cfg.base + '?t=' + encodeURIComponent(term) + '&repo=' + encodeURIComponent(cfg.repo);
        f.onload = function () { btn.disabled = false; };
        body.appendChild(f);
      });

      box.appendChild(btn);
      box.appendChild(body);

      // 插到「下一天」的标题之前；最后一天就放到正文末尾
      if (next) { content.insertBefore(box, next.el); }
      else { content.appendChild(box); }
    }

    for (var k = 0; k < heads.length; k++) {
      build(heads[k], heads[k + 1]);
    }
  })();
})();
