/*
 * Lampa EPG — companion plugin that makes the TV guide work.
 *
 * WHAT IT DOES
 * ------------
 * Reads `url-tvg` (or `x-tvg-url`) from the first line of an IPTV playlist —
 * exactly like VLC and OwnTV do — downloads that XMLTV file, and patches the
 * now/next panel that the IPTV Custom plugin already renders.
 *
 * WHY IT EXISTS
 * -------------
 * IPTV Custom routes its guide through epg.rootu.top, which (measured
 * 2026-10-25) returns an empty `epgPath` and empty arrays for every
 * `/epg/<id>/day/N` request — no guide data at all. It also matches on exact
 * `tvg-id` strings, and its channel map uses bare lowercase ids (`ntv`)
 * while playlists use `.ru` ids (`NTV.ru`), so 0 of 53 channels resolved.
 *
 * This plugin sidesteps that entirely: it never talks to epg.rootu.top. It
 * reads YOUR file, indexes programmes by YOUR tvg-ids, and therefore matches
 * whatever your playlist declares.
 *
 * It is purely additive: IPTV Custom keeps doing the channel grid, playback,
 * favourites and catch-up. We only fill in the guide text.
 *
 * INSTALL
 *   Settings -> Extensions -> add plugin:
 *   https://raw.githubusercontent.com/<user>/<repo>/main/epg.js
 */

(function () {
  'use strict';

  var PLUGIN = 'lampa_epg';
  var VERSION = '1.0.0';

  /* ---------- storage ---------- */

  var S = {
    get: function (k, d) {
      try { var v = Lampa.Storage.get(PLUGIN + '_' + k, null); return (v === null || v === undefined || v === '') ? d : v; }
      catch (e) { return d; }
    },
    set: function (k, v) { try { Lampa.Storage.set(PLUGIN + '_' + k, v); } catch (e) {} }
  };

  /* ---------- tiny helpers ---------- */

  function log() {
    if (S.get('debug', 'true') === 'true' && window.console) {
      console.log.apply(console, ['[EPG]'].concat([].slice.call(arguments)));
    }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function hhmm(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ---------- XMLTV parsing ---------- */

  /**
   * Parse "20261025002000 +0300" into a JS timestamp (UTC ms).
   * XMLTV times are local to the declared offset; we convert to true UTC so
   * the browser's own timezone handling renders them correctly.
   */
  function parseXmltvTime(str, fallbackOffset) {
    if (!str) return null;
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(\s*([+-]\d{4}))?/.exec(str.trim());
    if (!m) return null;
    var Y = +m[1], Mo = +m[2], D = +m[3], H = +m[4], Mi = +m[5], Se = +(m[6] || 0);
    var off = m[8] || fallbackOffset || '+0000';
    var sign = off.charAt(0) === '-' ? -1 : 1;
    var offMin = sign * (+off.substr(1, 2) * 60 + +off.substr(3, 2));
    // Treat the components as UTC, then subtract the offset to get true UTC.
    return Date.UTC(Y, Mo - 1, D, H, Mi, Se) - offMin * 60000;
  }

  function decodeEntities(s) {
    if (!s) return '';
    return s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  /**
   * Build: { tvgId: [ {s, e, t, d}, ... ] } sorted by start.
   * Uses regex scanning (no DOMParser dependency, works in older webviews on
   * a 2-3 MB file without choking).
   */
  function parseXmltv(xml) {
    var guide = Object.create(null);
    var rootOffset = (/(<tv[^>]*\bsource-info[^>]*>)/.exec(xml) || [])[1] || '';
    var defaultOff = (/([+-]\d{4})/.exec(rootOffset) || [])[1] || null;

    var re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
    var m;
    while ((m = re.exec(xml))) {
      var attrs = m[1];
      var body = m[2];
      var ch = /channel="([^"]*)"/.exec(attrs);
      var st = /\bstart="([^"]*)"/.exec(attrs);
      if (!ch || !st) continue;
      var chan = decodeEntities(ch[1]);
      var startMs = parseXmltvTime(st[1], defaultOff);
      if (startMs === null) continue;
      var sp = /\bstop="([^"]*)"/.exec(attrs);
      var stopMs = sp ? parseXmltvTime(sp[1], defaultOff) : null;

      var t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(body);
      var d = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(body);
      var t2 = /<sub-title[^>]*>([\s\S]*?)<\/sub-title>/.exec(body);

      var title = stripTags(t ? t[1] : '');
      var sub = stripTags(t2 ? t2[1] : '');
      if (sub && title.indexOf(sub) === -1) title = title + ' · ' + sub;

      (guide[chan] || (guide[chan] = [])).push({
        s: startMs,
        e: stopMs,
        t: title,
        d: stripTags(d ? d[1] : '')
      });
    }

    // Fill missing stop times from the next programme on the same channel.
    for (var k in guide) {
      var list = guide[k];
      list.sort(function (a, b) { return a.s - b.s; });
      for (var i = 0; i < list.length; i++) {
        if (!list[i].e) {
          list[i].e = (i + 1 < list.length) ? list[i + 1].s : list[i].s + 30 * 60000;
        }
      }
    }
    return guide;
  }

  /* ---------- network ---------- */

  function fetchText(url, cb, timeoutMs) {
    var done = false, xhr;
    var finish = function (err, text) {
      if (done) return;
      done = true;
      clearTimeout(to);
      cb(err, text);
    };
    var to = setTimeout(function () {
      try { xhr && xhr.abort(); } catch (e) {}
      finish('timeout');
    }, timeoutMs || 30000);

    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs || 30000;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) finish(null, xhr.responseText);
        else finish('http ' + xhr.status);
      };
      xhr.onerror = function () { finish('network'); };
      xhr.ontimeout = function () { finish('timeout'); };
      xhr.send();
    } catch (e) { finish('exception'); }
  }

  /* ---------- playlist header discovery ---------- */

  var cachedEpgUrl = null;
  var guide = null;        // { tvgId: [...] }
  var guideState = 'idle'; // idle | loading | ready | error
  var waiters = [];

  function findListUrls() {
    // IPTV Custom stores playlists under its own keys. We support both the
    // plugin's storage and a manual override, so this works regardless of
    // which IPTV plugin is installed.
    var urls = [];
    var manual = S.get('epg_url', '');
    if (manual) urls.push(manual);

    try {
      var raw = Lampa.Storage.get('my_iptv_lists', '[]');
      var lists = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (lists && lists.length) {
        for (var i = 0; i < lists.length; i++) {
          if (lists[i] && lists[i].url) urls.push(lists[i].url);
        }
      }
    } catch (e) {}

    // Also accept a local playlist URL the user saved for this plugin.
    var listUrl = S.get('list_url', '');
    if (listUrl) urls.push(listUrl);

    return urls;
  }

  /** Read first line of the (first) playlist and pull url-tvg out of it. */
  function discoverEpgUrl(cb) {
    if (cachedEpgUrl) return cb(null, cachedEpgUrl);

    var manual = S.get('epg_url', '');
    if (manual) { cachedEpgUrl = manual; return cb(null, cachedEpgUrl); }

    var urls = findListUrls();
    if (!urls.length) return cb('no playlist url');

    var i = 0;
    (function next() {
      if (i >= urls.length) return cb('no url-tvg in playlist');
      var u = urls[i++];
      fetchText(u, function (err, text) {
        if (err || !text) return next();
        var first = text.split(/\r?\n/, 1)[0] || '';
        if (first.slice(0, 7).toUpperCase() !== '#EXTM3U') return next();
        var m = /url-tvg="([^"]+)"/i.exec(first) || /x-tvg-url="([^"]+)"/i.exec(first);
        if (!m) return next();
        // url-tvg may list several comma-separated guides; take the first.
        cachedEpgUrl = m[1].split(',')[0].trim();
        cb(null, cachedEpgUrl);
      }, 15000);
    })();
  }

  /* ---------- guide access ---------- */

  function loadGuide(cb) {
    if (guideState === 'ready' && guide) return cb(null, guide);
    waiters.push(cb);
    if (guideState === 'loading') return;

    guideState = 'loading';
    discoverEpgUrl(function (err, epgUrl) {
      if (err) return fail(err);
      log('epg url', epgUrl);
      fetchText(epgUrl, function (e2, xml) {
        if (e2 || !xml) return fail(e2 || 'empty');
        if (xml.indexOf('<tv') === -1) return fail('not xmltv');
        try {
          guide = parseXmltv(xml);
        } catch (ex) { return fail('parse'); }
        var n = 0;
        for (var k in guide) n += guide[k].length;
        log('parsed', n, 'programmes for', Object.keys(guide).length, 'channels');
        guideState = 'ready';
        drain(null, guide);
      }, 45000);
    });

    function fail(reason) {
      log('guide load failed:', reason);
      guideState = 'error';
      drain(reason, null);
    }
    function drain(err, g) {
      var w = waiters; waiters = [];
      for (var i = 0; i < w.length; i++) { try { w[i](err, g); } catch (e) {} }
    }
  }

  function programmesFor(tvgId) {
    if (!guide || !tvgId) return null;
    if (guide[tvgId]) return guide[tvgId];
    // fallback: case-insensitive
    var low = String(tvgId).toLowerCase();
    for (var k in guide) if (k.toLowerCase() === low) return guide[k];
    return null;
  }

  function nowNext(tvgId, atMs) {
    var list = programmesFor(tvgId);
    if (!list || !list.length) return null;
    var now = atMs || Date.now();
    for (var i = 0; i < list.length; i++) {
      if (now >= list[i].s && now < list[i].e) {
        return { cur: list[i], next: list[i + 1] || null };
      }
    }
    // Between programmes: show the next upcoming one.
    for (var j = 0; j < list.length; j++) {
      if (list[j].s > now) return { cur: null, next: list[j] };
    }
    return null;
  }

  /* ---------- DOM patching ---------- */

  /**
   * IPTV Custom's detail card shows now/next in these elements:
   *   #<component>_epg           container (id like "my_iptv_epg")
   *   .js-epgChannel             channel name heading
   *   .js-epgNow                 current programme block
   *       .js-epgTime .js-epgTitle .js-epgProgress .js-epgDesc
   *   .js-epgAfter .js-epgList   upcoming list
   * When its own EPG fails, these stay empty or hidden. We refill them.
   */
  function currentTvgId() {
    // The card title in IPTV Custom is "N. <channel name>"; the reliable
    // source is the active activity's item, or a data attribute we set.
    var el = document.querySelector('[data-lampa-epg-id]');
    if (el) return el.getAttribute('data-lampa-epg-id');
    return S.get('last_tvg', '') || null;
  }

  function patchPanel() {
    var panel = document.querySelector('#my_iptv_epg, [id$="_epg"]');
    if (!panel) return;
    var tvgId = currentTvgId();
    if (!tvgId) return;

    var nn = nowNext(tvgId);
    if (!nn) return;

    var q = function (sel) { return panel.querySelector(sel); };

    var nowBox = q('.js-epgNow');
    if (nowBox && nn.cur) {
      var total = Math.max(1, nn.cur.e - nn.cur.s);
      var pct = Math.round((Date.now() - nn.cur.s) * 100 / total);
      var timeEl = nowBox.querySelector('.js-epgTime');
      var titleEl = nowBox.querySelector('.js-epgTitle');
      var progEl = nowBox.querySelector('.js-epgProgress');
      var descEl = nowBox.querySelector('.js-epgDesc');
      if (timeEl) timeEl.textContent = hhmm(nn.cur.s);
      if (titleEl) titleEl.textContent = nn.cur.t;
      if (progEl) progEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
      if (descEl && nn.cur.d) descEl.textContent = nn.cur.d;
      nowBox.style.display = '';
    }

    var afterBox = q('.js-epgAfter');
    var listEl = afterBox && afterBox.querySelector('.js-epgList');
    if (listEl) {
      var list = programmesFor(tvgId) || [];
      var nowMs = Date.now();
      var upcoming = list.filter(function (p) { return p.s > nowMs; }).slice(0, 8);
      if (upcoming.length) {
        var html = '';
        for (var i = 0; i < upcoming.length; i++) {
          var p = upcoming[i];
          html += '<div class="lampa-epg-item">'
            + '<div class="lampa-epg-time">' + hhmm(p.s) + '</div>'
            + '<div class="lampa-epg-title">' + escapeHtml(p.t) + '</div>'
            + '</div>';
        }
        listEl.innerHTML = html;
        if (afterBox) afterBox.style.display = '';
      }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- channel id capture ---------- */

  /**
   * IPTV Custom doesn't expose the tvg-id of the focused channel globally, so
   * we learn it from the card title and a tvg-id index built from the playlist.
   */
  var titleToId = null;

  function buildTitleIndex(cb) {
    if (titleToId) return cb(titleToId);
    var urls = findListUrls();
    if (!urls.length) return cb(null);

    fetchText(urls[0], function (err, text) {
      if (err || !text) return cb(null);
      var map = Object.create(null);
      var lines = text.split(/\r?\n/);
      var pendingId = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('#EXTINF') === 0) {
          var idm = /tvg-id="([^"]*)"/.exec(line);
          pendingId = idm ? idm[1] : null;
          var nm = line.indexOf(',') >= 0 ? line.slice(line.lastIndexOf(',') + 1) : '';
          if (pendingId && nm) {
            // strip the leading "12. " numbering and quality suffixes
            var clean = nm.replace(/^\s*\d+\.\s*/, '')
              .replace(/\s*\[[^\]]*\]/g, '')
              .replace(/\s*·\s*server\s*\d+\s*$/i, '')
              .trim().toLowerCase();
            if (clean && !map[clean]) map[clean] = pendingId;
          }
        }
      }
      titleToId = map;
      log('title index', Object.keys(map).length, 'names');
      cb(map);
    }, 15000);
  }

  function learnChannel() {
    // Look for the detail card's title element and map it back to a tvg-id.
    var titleEl = document.querySelector('.info__title');
    if (!titleEl) return;
    var raw = (titleEl.textContent || '').replace(/^\s*\d+\.\s*/, '').trim();
    var norm = raw.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*·\s*server\s*\d+\s*$/i, '').trim().toLowerCase();
    if (!norm) return;
    buildTitleIndex(function (map) {
      if (!map) return;
      var id = map[norm];
      if (id) {
        S.set('last_tvg', id);
        log('channel ->', raw, '=>', id);
        patchPanel();
      }
    });
  }

  /* ---------- observe UI ---------- */

  function startObserver() {
    var obs = new MutationObserver(function () {
      try {
        learnChannel();
        patchPanel();
      } catch (e) {}
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Periodic refresh keeps the progress bar honest.
    setInterval(function () {
      try { patchPanel(); } catch (e) {}
    }, 30000);
  }

  /* ---------- settings ---------- */

  function addSettings() {
    if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;

    Lampa.SettingsApi.addComponent({
      component: PLUGIN,
      name: 'Lampa EPG',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v2H3V5zm0 4h18v2H3V9zm0 4h12v2H3v-2zm0 4h18v2H3v-2z"/></svg>'
    });

    Lampa.SettingsApi.addParam({
      component: PLUGIN,
      param: { name: 'epg_url', type: 'input', default: '' },
      field: {
        name: 'EPG URL (пусто = из url-tvg)',
        description: 'Оставьте пустым, чтобы брать адрес из заголовка плейлиста.'
      }
    });

    Lampa.SettingsApi.addParam({
      component: PLUGIN,
      param: { name: 'list_url', type: 'input', default: '' },
      field: {
        name: 'Плейлист (необязательно)',
        description: 'Нужен только если url-tvg не читается автоматически.'
      }
    });

    Lampa.SettingsApi.addParam({
      component: PLUGIN,
      param: { name: 'debug', type: 'trigger', default: true },
      field: { name: 'Debug в консоль' }
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    if (window['__' + PLUGIN + '_ready']) return;
    window['__' + PLUGIN + '_ready'] = true;

    log('v' + VERSION + ' start');
    addSettings();
    startObserver();

    // Warm the guide in the background so the first card is instant.
    setTimeout(function () { loadGuide(function () {}); }, 3000);
  }

  if (window.appready) boot();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') boot(); });
})();
