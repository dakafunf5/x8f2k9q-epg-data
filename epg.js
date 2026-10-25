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

    // IPTV Custom (component "my_iptv") stores each playlist slot as
    //   my_iptv_list_url_<n>   — verified against plugin source lines 1819/1843.
    try {
      for (var n = 0; n < 10; n++) {
        var v = Lampa.Storage.get('my_iptv_list_url_' + n, '');
        if (v && typeof v === 'string' && /^https?:\/\//i.test(v)) urls.push(v);
      }
    } catch (e) {}

    // Older / alternative key shapes, just in case.
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
        try { preferChannelsWithGuide(); } catch (e) {}
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
            var clean = normTitle(nm);
            if (clean && !map[clean]) map[clean] = pendingId;
          }
        }
      }
      titleToId = map;
      log('title index', Object.keys(map).length, 'names');
      cb(map);
    }, 15000);
  }

  /**
   * Normalise a channel title for matching.
   * IPTV Custom shows `channel.Title` verbatim from #EXTINF — no "3. " prefix
   * (verified: plugin line 958 `info.find('.info__title').text(channel.Title)`),
   * so we must match the raw name, minus quality/server suffixes.
   */
  function normTitle(s) {
    return String(s || '')
      .replace(/^\s*\d+\.\s*/, '')          // leading "3. " numbering, if present
      .replace(/\[[^\]]*\]/g, '')           // [1920x1080]
      .replace(/·\s*server\s*\d+\s*/gi, '') // · server 2
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Re-point the index at whichever tvg-id actually has guide data.
   * Playlists often list one channel 3x ("· server 1/2/3") with the same
   * display name but different quality variants; the first mapping wins, which
   * may be a variant whose tvg-id has no programmes. Rebuild once the guide is
   * loaded so matching prefers channels we can actually describe.
   */
  function preferChannelsWithGuide() {
    if (!titleToId || !guide) return;
    // Re-scan the playlist, collecting ALL ids per normalised title.
    var urls = findListUrls();
    if (!urls.length) return;
    fetchText(urls[0], function (err, text) {
      if (err || !text) return;
      var byTitle = Object.create(null);
      var lines = text.split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('#EXTINF') !== 0) continue;
        var idm = /tvg-id="([^"]*)"/.exec(line);
        if (!idm) continue;
        var nm = line.indexOf(',') >= 0 ? line.slice(line.lastIndexOf(',') + 1) : '';
        var key = normTitle(nm);
        if (!key) continue;
        (byTitle[key] || (byTitle[key] = [])).push(idm[1]);
      }
      var improved = 0;
      for (var k in byTitle) {
        var ids = byTitle[k];
        if (ids.length < 2) continue;
        var withData = ids.filter(function (x) { return guide[x] && guide[x].length; });
        if (withData.length && titleToId[k] !== withData[0]) {
          titleToId[k] = withData[0];
          improved++;
        }
      }
      log('index re-pointed to guide-bearing ids:', improved);
    }, 15000);
  }

  /* ---------- observe UI ---------- */

  /**
   * Cheap, event-driven patching.
   *
   * The old version observed the whole document and ran learnChannel() +
   * patchPanel() on EVERY mutation. IPTV Custom renders channels in batches
   * (bulkWrapper), so entering the TV section fires hundreds of mutations;
   * patchPanel() itself mutates the DOM, which re-triggered the observer —
   * a feedback loop that froze the app.
   *
   * Now: mutations only schedule a debounced check, the check is O(1) when the
   * panel isn't present, and we never write to the DOM unless a value actually
   * changes.
   */

  var scheduled = false;
  var lastSig = '';

  function schedule(delay) {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      tick();
    }, delay || 250);
  }

  function tick() {
    var panel = document.querySelector('#my_iptv_epg, [id$="_epg"]');
    if (!panel) return;                       // not on a channel detail screen
    var infoEl = document.querySelector('.info__title');
    if (!infoEl) return;

    // Lazily load only once the panel truly exists — never during card
    // rendering, which is where the freeze happened.
    if (!guide) {
      ensureTitleIndex();
      if (guideState === 'idle') loadGuide(function () { schedule(0); });
      return;
    }

    var raw = infoEl.textContent || '';
    var id = resolveId(raw);
    if (!id) return;

    var nn = nowNext(id);
    if (!nn) return;

    // Only touch the DOM when the displayed programme identity changes.
    var sig = id + '|' + (nn.cur ? nn.cur.s : 0);
    if (sig === lastSig) return;
    lastSig = sig;

    paint(panel, nn, id);
  }

  var idCache = Object.create(null);
  function resolveId(raw) {
    var norm = normTitle(raw);
    if (!norm) return null;
    if (idCache[norm] !== undefined) return idCache[norm];
    if (!titleToId) { ensureTitleIndex(); return null; }
    var id = titleToId[norm];
    if (!id) {
      var loose = norm.replace(/\b(hd|fhd|uhd|4k|sd)\b/g, '').replace(/\s+/g, ' ').trim();
      id = titleToId[loose] || null;
    }
    idCache[norm] = id;
    if (id) log('channel ->', raw, '=>', id);
    else log('channel unresolved:', raw);
    return id;
  }

  var indexRequested = false;
  function ensureTitleIndex() {
    if (indexRequested) return;
    indexRequested = true;
    buildTitleIndex(function (map) {
      if (map) { idCache = Object.create(null); schedule(100); }
    });
  }

  function paint(panel, nn, tvgId) {
    var q = function (sel) { return panel.querySelector(sel); };

    if (nn.cur) {
      var nowBox = q('.js-epgNow');
      if (nowBox) {
        var total = Math.max(1, nn.cur.e - nn.cur.s);
        var pct = Math.max(0, Math.min(100, Math.round((Date.now() - nn.cur.s) * 100 / total)));
        var tEl = nowBox.querySelector('.js-epgTime');
        var tiEl = nowBox.querySelector('.js-epgTitle');
        var prEl = nowBox.querySelector('.js-epgProgress');
        var deEl = nowBox.querySelector('.js-epgDesc');
        if (tEl) tEl.textContent = hhmm(nn.cur.s);
        if (tiEl) tiEl.textContent = nn.cur.t;
        if (prEl) prEl.style.width = pct + '%';
        if (deEl && nn.cur.d) deEl.textContent = nn.cur.d;
        if (nowBox.style.display === 'none') nowBox.style.display = '';
      }
    }

    var listEl = panel.querySelector('.js-epgList');
    if (listEl) {
      var list = programmesFor(tvgId) || [];
      var nowMs = Date.now();
      var upcoming = [];
      for (var i = 0; i < list.length && upcoming.length < 8; i++) {
        if (list[i].s > nowMs) upcoming.push(list[i]);
      }
      if (upcoming.length) {
        listEl.innerHTML = upcoming.map(function (p) {
          return '<div style="display:flex;gap:1em;padding:.15em 0">'
            + '<span class="js-epgTime">' + hhmm(p.s) + '</span>'
            + '<span>' + escapeHtml(p.t) + '</span></div>';
        }).join('');
      }
    }
    log('painted', tvgId, nn.cur ? nn.cur.t : '(no current)');
  }

  function startObserver() {
    var obs = new MutationObserver(function () { schedule(300); });
    // Observe only childList at the top of body: cheap, and enough to notice
    // a screen change. Never observe attributes or characterData.
    obs.observe(document.body, { childList: true, subtree: true });

    // Refresh progress occasionally; also re-paint when the programme changes.
    setInterval(function () { lastSig = ''; schedule(0); }, 60000);

    // Nothing is fetched until a channel panel actually opens (see tick()).
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
  }

  if (window.appready) boot();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') boot(); });
})();
