/* ============================================================
   访客当地的天气 + 本地时间
   ------------------------------------------------------------
   两个放养区都要用：侧栏那只（js/pkmn.js）和始祖小鸟页面那只
   （js/tbtak-pasture.js）。所以抽出来一份，免得两处各写一遍。

   天气链路（任何一个链接掉都当作「不知道天气」，不会卡页面）：
     1) ipwho.is 拿一个大概的城市坐标（等于把访客 IP 交给这个第三方）；
        它限流（429）时退到 get.geojs.io；
     2) 拿坐标问 open-meteo 要一个 WMO 天气码，映射成 7 个桶。
   结果存在 sessionStorage 里 30 分钟 —— 同一个标签页里翻页、或者从侧栏那只
   换到始祖小鸟页面，都只查一次。

   开关是 hugo.toml 的 pkmnWeather：页面那边不写 data-weather="1" 的话，
   连这两个请求都不会发（调用 load() 之前自己先判断）。
   ============================================================ */
(function () {
  'use strict';

  var NIGHT_FROM = 22, NIGHT_TO = 6;

  var WEATHER_LABEL = { clear: '晴', cloudy: '阴', fog: '雾', drizzle: '小雨',
                        rain: '雨', snow: '雪', thunder: '雷雨' };
  var TIME_LABEL = { dawn: '早上', day: '白天', dusk: '傍晚', night: '深夜' };
  // 台词池 / 图标对不上时的退路（drizzle 缺就退到 rain、fog 缺就退到 cloudy）
  var W_ALIAS = { drizzle: 'rain', fog: 'cloudy' };

  // 定位服务排了两家：ipwho.is 偶尔限流，失败就换 geojs。
  // 两家字段名一样，但 geojs 的经纬度是字符串，所以统一 parseFloat。
  var GEO = [
    { url: 'https://ipwho.is/',
      pick: function (j) { return j && j.success !== false ? [j.latitude, j.longitude] : null; } },
    { url: 'https://get.geojs.io/v1/ip/geo.json',
      pick: function (j) { return j ? [parseFloat(j.latitude), parseFloat(j.longitude)] : null; } }
  ];

  var KEY = 'pkmn.weather';
  var ttl = 30 * 60 * 1000;

  var SS = null;
  try { SS = window.sessionStorage; } catch (e) { SS = null; }

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

  function remember(w) {
    if (SS) { try { SS.setItem(KEY, JSON.stringify({ t: Date.now(), w: w })); } catch (e) {} }
  }

  function cached() {
    if (!SS) return null;
    try {
      var c = JSON.parse(SS.getItem(KEY) || 'null');
      if (c && Date.now() - c.t < ttl) return c.w || null;
    } catch (e) {}
    return null;
  }

  /* load(onDone)：先看缓存，没有就问接口；onDone(天气桶 或 null)。
     失败不写缓存，下次打开还会再试一次。 */
  function load(onDone) {
    var hit = cached();
    if (hit) { onDone(hit); return; }
    geoAt(0)
      .then(function (ll) {
        return timedFetch('https://api.open-meteo.com/v1/forecast?latitude=' + ll[0] +
                          '&longitude=' + ll[1] + '&current=weather_code', 6000);
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var w = wmo(j && j.current && j.current.weather_code);
        if (!w) throw new Error('no weather');
        remember(w);
        onDone(w);
      })
      .catch(function () { onDone(null); });
  }

  function hour() { return (new Date()).getHours(); }

  // 带分钟的时刻（13.75 = 下午 1:45）—— 天空按它连续变化：
  // 「早/中/晚/夜」四个桶是给图标和台词用的，17:00–22:00 那五个小时
  // 不能共用一套「傍晚」配色（不然 21:00 天还跟正午一样亮）。
  function hourFloat() {
    var d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  }

  function timePart(h, forced) {
    if (h == null && forced) return forced;      // 调试开关 ?pkmn-time=
    h = (h == null) ? hour() : h;
    if (h >= 5 && h < 11) return 'dawn';
    if (h >= 11 && h < 17) return 'day';
    if (h >= 17 && h < NIGHT_FROM) return 'dusk';
    return 'night';
  }

  function isNight(h) {
    if (h == null) h = hour();
    return h >= NIGHT_FROM || h < NIGHT_TO;
  }

  window.PkmnWeather = {
    NIGHT_FROM: NIGHT_FROM, NIGHT_TO: NIGHT_TO,
    WEATHER_LABEL: WEATHER_LABEL, TIME_LABEL: TIME_LABEL, W_ALIAS: W_ALIAS,
    wmo: wmo, load: load, cached: cached,
    hour: hour, hourFloat: hourFloat, timePart: timePart, isNight: isNight
  };
})();
