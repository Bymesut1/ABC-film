// ============================================================
//  hdfilmcehennemi — Nuvio scraper (www.hdfilmcehennemi.nl)
//  Akış: TMDB -> site araması (/search/?q=) -> film/bölüm sayfası
//        -> oynatıcı iframe (Rapidrame / Close) -> m3u8 (+ altyazı)
//  Film ve dizi. Varsayılan: sadece DUAL (Türkçe Dublaj) sekmesi.
// ============================================================

var AYAR = {
  SITE: 'https://www.hdfilmcehennemi.nl',
  EKLENTI_ADI: 'hdfilmcehennemi',
  // true iken akış çıkmazsa neden çıkmadığını yazan "DEBUG" satırları görünür. Çalışınca false yap.
  DEBUG_MODU: true,
  ALTYAZILI_GOSTER: false,  // true: "Altyazılı" sekmesindeki oynatıcılar da eklenir
  MAX_ALTERNATIF: 4,        // en fazla kaç oynatıcı (Rapidrame, Close ...) denensin
  ISTEK_SURESI: 8000,       // ms: tek istek üst sınırı
  GENEL_SURE: 30000         // ms: toplam üst sınır
};

var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';
var PROVIDER_ID = 'hdfilmcehennemi';
var UA = 'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';

var dbg = [];
function note(m) { dbg.push(String(m).slice(0, 90)); }

// ---------------- Yardımcılar ----------------

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function pageHeaders(ref, extra) {
  var h = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7',
    'Referer': ref || (AYAR.SITE + '/')
  };
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}

function getRaw(url, headers, label) {
  return withTimeout(fetch(url, { headers: headers || pageHeaders() }), AYAR.ISTEK_SURESI).then(function (res) {
    return withTimeout(res.text(), AYAR.ISTEK_SURESI).then(
      function (t) { return { status: res.status, ok: res.ok, text: t || '' }; },
      function () { return { status: res.status, ok: false, text: '' }; }
    );
  }).catch(function (e) {
    return { status: 0, ok: false, text: '', err: (e && e.message) || 'hata' };
  }).then(function (r) {
    if (label) note(label + ' ' + (r.status || r.err || '?') + '/' + r.text.length);
    return r;
  });
}

function getJson(url) {
  return withTimeout(fetch(url), 10000).then(function (res) { return res.json(); });
}

function decodeHtml(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

var TR_MAP = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
function asciiLower(s) {
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase()
    .replace(/[çğıöşüâîû]/g, function (c) { return TR_MAP[c]; });
}
function norm(s) { return asciiLower(s).replace(/[^a-z0-9]/g, ''); }

function uniq(list) {
  var out = [];
  list.forEach(function (x) { if (x && out.indexOf(x) === -1) out.push(x); });
  return out;
}

function abs(u, base) {
  u = decodeHtml(String(u || '')).replace(/\\\//g, '/');
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf('//') === 0) return 'https:' + u;
  var b = base || AYAR.SITE;
  return b.replace(/\/+$/, '') + (u.charAt(0) === '/' ? '' : '/') + u;
}

function originOf(u) {
  var m = String(u || '').match(/^(https?:\/\/[^\/]+)/i);
  return m ? m[1] : AYAR.SITE;
}

function waitWithin(promises, ms) {
  return new Promise(function (resolve) {
    var left = promises.length, done = false;
    if (!left) { resolve(); return; }
    var t = setTimeout(function () { if (!done) { done = true; resolve(); } }, ms);
    promises.forEach(function (p) {
      p.then(function () {}, function () {}).then(function () {
        left--;
        if (left === 0 && !done) { done = true; clearTimeout(t); resolve(); }
      });
    });
  });
}

// ---------------- Site araması ----------------
// Site araması JSON döndürür: { results: ["<a href=... class=search-result>..."] }  (HTML parçaları)

function searchSite(q) {
  var h = pageHeaders(AYAR.SITE + '/', { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'fetch' });
  return getRaw(AYAR.SITE + '/search/?q=' + encodeURIComponent(q), h, 'S').then(function (r) {
    var htmls = [];
    try {
      var j = JSON.parse(r.text);
      htmls = j.results || j.data || [];
      if (typeof htmls === 'string') htmls = [htmls];
    } catch (e) { htmls = [r.text]; }
    var out = [];
    String(htmls.join ? htmls.join('\n') : htmls).split(/<a\s/).slice(1).forEach(function (c) {
      var href = (c.match(/href="([^"]+)"/) || [])[1];
      var title = (c.match(/class="title">\s*([^<]+)/) || [])[1];
      var year = (c.match(/class="year">\s*(\d{4})/) || [])[1];
      var type = (c.match(/class="type">\s*([^<]+)/) || [])[1];
      if (href && title) out.push({ url: abs(href), title: decodeHtml(title).trim(), year: parseInt(year, 10) || 0, type: (type || '').trim() });
    });
    return out;
  });
}

function pickBest(list, wants, year, isTv) {
  var best = null, bs = -1;
  list.forEach(function (it) {
    var isSeries = /dizi/i.test(it.type) || it.url.indexOf('/dizi/') > -1;
    if (isSeries !== isTv) return;
    var n = norm(it.title), s = 0;
    wants.forEach(function (w) {
      var wn = norm(w);
      if (!wn) return;
      if (n === wn) s = Math.max(s, 100);
      else if (wn.length >= 6 && n.indexOf(wn) > -1) s = Math.max(s, 60);
      else if (n.length >= 6 && wn.indexOf(n) > -1) s = Math.max(s, 55);
    });
    if (!s) return;
    if (year && it.year) {
      var d = Math.abs(it.year - year);
      if (!isTv) { if (d === 0) s += 30; else if (d === 1) s += 15; else s -= 60; }
      else if (d === 0) s += 10;
    }
    if (s > bs) { bs = s; best = it; }
  });
  return bs >= 50 ? best : null;
}

function findEpisode(html, s, e) {
  var re = new RegExp('href="((?:https?:\\/\\/[^"\\/]+)?\\/dizi\\/[^"]*?\\/sezon-' + s + '\\/bolum-' + e + '(?:-[a-z0-9]+)?\\/)"', 'i');
  var m = String(html || '').match(re);
  return m ? abs(m[1]) : '';
}

// ---------------- Film / bölüm sayfası ----------------

// <div class="alternative-links" data-active="1" data-lang="dual"> <button class="alternative-link" data-video="123">Close</button> ...
function parseAlts(html) {
  var out = [];
  String(html || '').split('class="alternative-links"').slice(1).forEach(function (b) {
    var end = b.indexOf('</div>');
    var blk = end > 0 ? b.slice(0, end) : b;
    var lang = (blk.match(/data-lang="([^"]+)"/) || [])[1] || '';
    var re = /<button class="alternative-link"([^>]*)>\s*([^<]*?)\s*<\/button>/g, m;
    while ((m = re.exec(blk)) !== null) {
      var id = (m[1].match(/data-video="(\d+)"/) || [])[1];
      if (id) out.push({ id: id, name: decodeHtml(m[2]).trim() || 'Player', lang: lang, active: /data-active="1"/.test(m[1]) });
    }
  });
  return out;
}

function pageIframe(html) {
  var m = String(html || '').match(/<iframe[^>]*?\s(?:data-src|src)="([^"]+)"/i);
  return m ? abs(m[1]) : '';
}

function iframeFromAjax(text) {
  var t = String(text || '').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\u0026/g, '&');
  var m = t.match(/(?:data-src|src)="(https?:[^"]+)"/i);
  return m ? m[1] : '';
}

// ---------------- Oynatıcı çözümleme ----------------

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(s) {
  s = String(s || '').replace(/[^A-Za-z0-9+\/]/g, '');
  if (s.length < 8) return '';
  var o = '', buf = 0, bits = 0, i, v;
  for (i = 0; i < s.length; i++) {
    v = B64.indexOf(s.charAt(i));
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; o += String.fromCharCode((buf >> bits) & 255); buf &= (1 << bits) - 1; }
  }
  return o;
}
function rev(s) { return s.split('').reverse().join(''); }
function rot13(s) {
  return s.replace(/[a-zA-Z]/g, function (c) {
    var b = c <= 'Z' ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b);
  });
}
function unmix(s, salt) {
  var o = '', i;
  for (i = 0; i < s.length; i++) o += String.fromCharCode((s.charCodeAt(i) - (salt % (i + 5)) + 256) % 256);
  return o;
}

// Dean Edwards p,a,c,k,e,d
function unpack(p, a, c, k) {
  function e(n) { return (n < a ? '' : e(parseInt(n / a, 10))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36)); }
  var d = {};
  while (c--) { d[e(c)] = k[c] || e(c); }
  return p.replace(/\b\w+\b/g, function (w) { return d[w] || w; });
}
function unpackAll(html) {
  var out = [], m, re = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  while ((m = re.exec(html)) !== null) {
    try { out.push(unpack(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'), parseInt(m[2], 10), parseInt(m[3], 10), m[4].split('|'))); } catch (e) {}
  }
  return out;
}

// dc_xxxx(["parça1","parça2",...]) biçimindeki gizlenmiş bağlantılar: bilinen dönüşümlerin tüm kombinasyonları denenir
function dcDecode(blob) {
  var out = [], m, re = /dc_\w+\s*\(\s*\[([^\]]*)\]\s*\)/g;
  var salts = uniq([(String(blob).match(/(\d{6,12})\s*%\s*\(\s*\w+\s*\+\s*\d+\s*\)/) || [])[1], '399756995'])
    .map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x; });
  while ((m = re.exec(blob)) !== null) {
    var parts = [];
    m[1].replace(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g, function (_, x, y) { parts.push(x !== undefined ? x : y); return ''; });
    var s = parts.join('');
    [s, rev(s), rot13(s), rot13(rev(s))].forEach(function (p) {
      var d = b64(p);
      if (!d) return;
      var cands = [d, rev(d)];
      salts.forEach(function (sl) { cands.push(unmix(d, sl)); cands.push(rev(unmix(d, sl))); cands.push(unmix(rev(d), sl)); });
      cands.forEach(function (c) { if (/https?:\/\//.test(c)) out.push(c); });
    });
  }
  return out;
}

function extractMedia(blob) {
  var t = String(blob || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/\\x2F/gi, '/').replace(/&amp;/g, '&');
  var urls = [], m, re = /https?:\/\/[^"'\s<>\\)]+/g;
  while ((m = re.exec(t)) !== null) {
    var u = m[0];
    if (/\.(vtt|srt|jpe?g|png|webp|gif|css|js|ico|svg|woff2?)(\?|\/?$)/i.test(u)) continue;
    if (/\.m3u8|\.mp4|sublist|\/hls\d?\//i.test(u)) urls.push(u);
  }
  return urls;
}

function extractSubs(blob, base) {
  var t = String(blob || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  var out = [], m, re = /["'(]((?:https?:\/\/|\/)[^"'\s\\)]*?(?:\.vtt|\/srt\/)[^"'\s\\)]*)["')]/g;
  while ((m = re.exec(t)) !== null) {
    var u = abs(m[1], base), low = u.toLowerCase();
    var lang = /tur|turk/.test(low) ? 'tr' : (/eng|english/.test(low) ? 'en' : '');
    if (lang) out.push({ url: u, lang: lang, label: lang === 'tr' ? 'Türkçe' : 'English' });
  }
  return out;
}

function resolveEmbed(embedUrl, pageUrl) {
  return getRaw(embedUrl, pageHeaders(pageUrl), 'EMB').then(function (r) {
    var html = r.text || '';
    var blobs = [html];
    unpackAll(html).forEach(function (u) { blobs.push(u); });
    blobs.slice().forEach(function (b) { dcDecode(b).forEach(function (d) { blobs.push(d); }); });
    // tırnak içindeki düz base64 dizileri (atob('...')) bağlantı içeriyorsa onları da tara
    var m, re = /["']([A-Za-z0-9+\/=]{40,})["']/g, extra = [];
    while ((m = re.exec(html)) !== null) {
      var d = b64(m[1]);
      if (/https?:\/\//.test(d)) extra.push(d);
    }
    extra.forEach(function (d) { blobs.push(d); });
    var urls = [], subs = [], seenS = {};
    blobs.forEach(function (b) {
      extractMedia(b).forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
      extractSubs(b, originOf(embedUrl)).forEach(function (s) { if (!seenS[s.url]) { seenS[s.url] = 1; subs.push(s); } });
    });
    note('blob ' + blobs.length + ' url ' + urls.length + ' sub ' + subs.length);
    return { urls: urls, subs: subs };
  });
}

// ---------------- Akış üretimi ----------------

function makeStreams(job, res, embedUrl) {
  var org = originOf(embedUrl);
  return res.urls.map(function (u) {
    var hls = /m3u8|sublist|\/hls\d?\//i.test(u);
    var s = {
      name: AYAR.EKLENTI_ADI,
      title: [AYAR.EKLENTI_ADI, job.lang === 'dual' ? 'TR Dual' : 'Altyazılı', job.name, 'Auto'].join(' | '),
      url: u,
      quality: 'Auto',
      type: hls ? 'hls' : 'mp4',
      headers: { 'User-Agent': UA, 'Referer': org + '/', 'Origin': org },
      provider: PROVIDER_ID
    };
    if (res.subs.length) s.subtitles = res.subs;
    return s;
  });
}

function debugStream(msg) {
  if (!AYAR.DEBUG_MODU) return [];
  return [msg].concat(dbg.slice(0, 40)).map(function (r) {
    return { name: 'DEBUG ' + r, title: 'DEBUG ' + r, url: 'https://debug.invalid/', quality: 'Auto', provider: PROVIDER_ID };
  });
}

function findPage(titles, year, isTv, season, episode) {
  return Promise.all(titles.slice(0, 3).map(function (t) { return searchSite(t).catch(function () { return []; }); })).then(function (lists) {
    var all = [], seen = {};
    lists.forEach(function (l) { l.forEach(function (it) { if (!seen[it.url]) { seen[it.url] = 1; all.push(it); } }); });
    note('arama ' + all.length);
    var best = pickBest(all, titles, year, isTv);
    if (!best) { note('sitede bulunamadi'); return null; }
    note('bulundu ' + best.url.replace(AYAR.SITE, ''));
    if (!isTv) return best.url;
    return getRaw(best.url, pageHeaders(), 'SER').then(function (r) {
      var u = findEpisode(r.text, season, episode);
      if (!u) { note('bolum linki yok s' + season + 'e' + episode); return null; }
      note('bolum ' + u.replace(AYAR.SITE, ''));
      return u;
    });
  });
}

function getStreamsInner(tmdbId, mediaType, season, episode) {
  var isTv = (mediaType === 'tv' || mediaType === 'series');
  dbg = ['v1.0.0'];
  var base = 'https://api.themoviedb.org/3/' + (isTv ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_KEY;
  return Promise.all([
    getJson(base + '&language=tr-TR'),
    getJson(base + '&language=en-US').catch(function () { return {}; })
  ]).then(function (both) {
    var tr = both[0] || {}, en = both[1] || {};
    var titles = uniq([tr.title || tr.name, en.title || en.name, tr.original_title || tr.original_name]);
    var year = parseInt((tr.release_date || tr.first_air_date || '').slice(0, 4), 10) || 0;
    if (!titles.length) return debugStream('TMDB bilgisi eksik');
    note('film ' + titles[0] + ' ' + year);

    return findPage(titles, year, isTv, season, episode).then(function (pageUrl) {
      if (!pageUrl) return debugStream('sayfa bulunamadi');
      return getRaw(pageUrl, pageHeaders(), 'PAGE').then(function (r) {
        var html = r.text, alts = parseAlts(html), ifr = pageIframe(html), jobs = [];
        note('alt ' + alts.map(function (a) { return a.lang + ':' + a.name + (a.active ? '*' : ''); }).join(','));
        note('iframe ' + (ifr ? ifr.replace(/^https?:\/\//, '') : '-'));
        var activeAlt = alts.filter(function (a) { return a.active && a.lang === 'dual'; })[0];
        if (ifr) jobs.push({ name: activeAlt ? activeAlt.name : 'Player', lang: 'dual', embed: ifr });
        alts.forEach(function (a) {
          var okLang = a.lang === 'dual' || (AYAR.ALTYAZILI_GOSTER && a.lang);
          if (!okLang) return;
          if (ifr && a.active && a.lang === 'dual') return;      // sayfadaki hazır iframe zaten eklendi
          jobs.push({ name: a.name, lang: a.lang, id: a.id });
        });
        jobs = jobs.slice(0, AYAR.MAX_ALTERNATIF);
        if (!jobs.length) return debugStream('oynatici yok');

        var streams = [], seenUrl = {};
        var tasks = jobs.map(function (job) {
          var embedP = job.embed ? Promise.resolve(job.embed)
            : getRaw(AYAR.SITE + '/video/' + job.id + '/', pageHeaders(pageUrl, { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'fetch' }), 'V' + job.id.slice(-3))
              .then(function (rr) { return iframeFromAjax(rr.text); });
          return embedP.then(function (embedUrl) {
            if (!embedUrl) { note('embed yok ' + job.name); return; }
            return resolveEmbed(embedUrl, pageUrl).then(function (res) {
              makeStreams(job, res, embedUrl).forEach(function (s) { if (!seenUrl[s.url]) { seenUrl[s.url] = 1; streams.push(s); } });
            });
          });
        });
        return waitWithin(tasks, 20000).then(function () {
          if (!streams.length) return debugStream('kaynak cikmadi');
          return streams;
        });
      });
    });
  }).catch(function (e) { return debugStream('hata ' + (e && e.message)); });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (!done) { done = true; resolve(debugStream('zaman asimi ' + AYAR.GENEL_SURE + 'ms')); }
    }, AYAR.GENEL_SURE);
    getStreamsInner(tmdbId, mediaType, season, episode).then(function (r) {
      if (!done) { done = true; clearTimeout(timer); resolve(r); }
    }, function () {
      if (!done) { done = true; clearTimeout(timer); resolve([]); }
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams, _t: { unpack: unpack, dcDecode: dcDecode, b64: b64, parseAlts: parseAlts, pageIframe: pageIframe, findEpisode: findEpisode, pickBest: pickBest, extractMedia: extractMedia } };
} else {
  global.getStreams = getStreams;
}
