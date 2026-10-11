// ============================================================
//  hdfilmcehennemi — Nuvio scraper (hdfilmcehennemi.nl)            v1.1.0
//  Akış: TMDB -> site araması (IMDb no ile; /search/?q=) -> film/bölüm sayfası
//        -> oynatıcı iframe (Close / Rapid ...) -> m3u8 (+ altyazı)
//  Film ve dizi. Varsayılan: sadece DUAL (Türkçe Dublaj) sekmesi.
//  Her oynatıcı AYRI kart: "hdfilmcehennemi - DUAL Close", "hdfilmcehennemi - DUAL Rapid" ...
//
//  v1.1.0 düzeltmeleri:
//   * "access denied": www.hdfilmcehennemi.nl engelli, hdfilmcehennemi.nl (www'suz) açık -> ikisi de denenir,
//     çalışan adres hatırlanır; engel sayfası ("access denied") yanıt sayılmaz, başka adres / başka UA denenir
//   * Arama: sitenin aramasındaki gibi IMDb numarasıyla aranır (kesin sonuç), olmazsa ad ile
//   * Her akış oynatılmadan önce m3u8 olarak DOĞRULANIR; "Source error" veren (404 / yanlış başlık) bağlantılar elenir,
//     çalışan Referer/Origin başlığı bulunup akışa yazılır
//   * Close ve Rapid ayrı kart (eskiden hepsi "hdfilmcehennemi Auto" idi)
// ============================================================

var AYAR = {
  // Sırayla denenir (aynı anda). www'lu adres tarayıcıda "access denied" verdi, www'suz açıldı.
  HOSTLAR: ['https://hdfilmcehennemi.nl', 'https://www.hdfilmcehennemi.nl'],
  SITE: 'https://hdfilmcehennemi.nl',
  EKLENTI_ADI: 'hdfilmcehennemi',
  // true iken akış çıkmazsa (ve akışların altında) neden çıkmadığını yazan "DEBUG" satırları görünür. Çalışınca false yap.
  DEBUG_MODU: true,
  ALTYAZILI_GOSTER: false,  // true: "Altyazılı" sekmesindeki oynatıcılar da eklenir
  MAX_ALTERNATIF: 4,        // en fazla kaç oynatıcı (Rapid, Close ...) denensin
  DOGRULA: true,            // m3u8 bağlantılarını oynatmadan önce kontrol et (Source error'u önler)
  ISTEK_SURESI: 7000,       // ms: tek istek üst sınırı
  GENEL_SURE: 25000         // ms: toplam üst sınır; dolunca o ana kadar bulunan akışlar VERİLİR
};

var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';
var PROVIDER_ID = 'hdfilmcehennemi';
var UA = 'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';
var UA_D = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

var dbg = [];
var GOOD = null;   // { host, v }: çalışan adres + başlık biçimi (sonraki isteklerde ilk o denenir)
function note(m) { dbg.push(String(m).slice(0, 90)); }

// ---------------- Yardımcılar ----------------

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function hostShort(u) { return String(u || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, 'w.').slice(0, 24); }

function rawGet(url, headers, label, tmo) {
  tmo = tmo || AYAR.ISTEK_SURESI;
  return withTimeout(fetch(url, { headers: headers }), tmo).then(function (res) {
    return withTimeout(res.text(), tmo).then(
      function (t) { return { status: res.status, ok: res.ok, text: t || '', url: res.url || url }; },
      function () { return { status: res.status, ok: false, text: '', url: res.url || url }; }
    );
  }).catch(function (e) {
    return { status: 0, ok: false, text: '', err: (e && e.message) || 'hata', url: url };
  }).then(function (r) {
    if (label) note(label + ' ' + (r.status || r.err || '?') + '/' + r.text.length);
    return r;
  });
}

function getJson(url) {
  return withTimeout(fetch(url), 10000).then(function (res) { return res.json(); });
}

// Engel sayfası mı? ("access denied", Cloudflare bekleme sayfası ...)
function denied(r) {
  if (!r || !r.ok) return true;
  var t = r.text || '';
  return t.length < 700 && /access denied|forbidden|attention required|just a moment|you have been blocked/i.test(t);
}

function siteHeaders(v, host, extra) {
  var h = {
    'User-Agent': v === 1 ? UA_D : UA,
    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7',
    'Referer': host + '/'
  };
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}

// İlk kabul edilen sonucu döndür; hiçbiri kabul edilmezse sonuncuyu
function firstOk(tasks, accept) {
  return new Promise(function (resolve) {
    var left = tasks.length, done = false, last = { status: 0, ok: false, text: '' };
    if (!left) { resolve(last); return; }
    tasks.forEach(function (t) {
      var p; try { p = t(); } catch (e) { p = Promise.resolve(last); }
      p.then(function (r) { return r; }, function () { return last; }).then(function (r) {
        last = r || last;
        left--;
        if (done) return;
        if (accept(r)) { done = true; resolve(r); }
        else if (left === 0) { done = true; resolve(last); }
      });
    });
  });
}

// Site isteği: çalışan adres önce; olmazsa tüm adresler x iki başlık biçimi aynı anda
function siteGet(path, extra, label) {
  var hosts = [], seenH = {};
  [AYAR.SITE].concat(AYAR.HOSTLAR).forEach(function (h) { if (h && !seenH[h]) { seenH[h] = 1; hosts.push(h); } });
  function attempt(host, v) {
    return function () {
      return rawGet(host + path, siteHeaders(v, host, extra), label ? label + '@' + hostShort(host) + v : '').then(function (r) { r.host = host; r.v = v; return r; });
    };
  }
  function good(r) {
    if (denied(r)) return false;
    return true;
  }
  var first = GOOD ? [attempt(GOOD.host, GOOD.v)] : [], rest = [];
  hosts.forEach(function (h) { [0, 1].forEach(function (v) { if (!(GOOD && GOOD.host === h && GOOD.v === v)) rest.push(attempt(h, v)); }); });
  return firstOk(first, good).then(function (r) {
    if (first.length && good(r)) return r;
    return firstOk(rest, good);
  }).then(function (r) {
    if (good(r) && r.host) { GOOD = { host: r.host, v: r.v }; AYAR.SITE = r.host; }
    else note('ENGEL: ' + (r.status || r.err || '?') + ' ' + String(r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 40));
    return r;
  });
}

function pathOf(u) { return String(u || '').replace(/^https?:\/\/[^\/]+/i, '') || '/'; }

function decodeHtml(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

var TR_MAP = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
function asciiLower(s) {
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase()
    .replace(/[çğıöşüâîû]/g, function (c) { return TR_MAP[c]; });
}
function norm(s) { return asciiLower(s).replace(/[^a-z0-9]/g, ''); }
function slugify(s) { return asciiLower(s).replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

function uniq(list) {
  var out = [];
  list.forEach(function (x) { if (x && out.indexOf(x) === -1) out.push(x); });
  return out;
}

// Site içi bağlantıyı çalışan adrese çevir (sonuçlarda www'lu adres gelse bile)
function abs(u, base) {
  u = decodeHtml(String(u || '')).replace(/\\\//g, '/');
  if (/^https?:\/\//i.test(u)) return u.replace(/^https?:\/\/(?:www\.)?hdfilmcehennemi\.[a-z]+/i, AYAR.SITE);
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
// Sitenin arama kutusu (ortada açılan pencere) /search/?q= adresine fetch ile gider; IMDb no, Türkçe/orijinal ad kabul eder.
// Yanıt: { results: ["<a href=... >...</a>", ...] }  (HTML parçaları)

function parseResults(src) {
  var out = [], seen = {};
  String(src || '').split(/<a\s/i).slice(1).forEach(function (c) {
    var href = (c.match(/href="([^"]+)"/i) || [])[1];
    if (!href || /^#|javascript:/i.test(href)) return;
    var title = (c.match(/class="[^"]*(?:poster-title|title)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]+)/i) || [])[1] ||
                (c.match(/\btitle="([^"]+)"/i) || [])[1] || (c.match(/\balt="([^"]+)"/i) || [])[1] ||
                String(c.replace(/^[^>]*>/, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    var year = (c.match(/class="[^"]*year[^"]*"[^>]*>\s*(\d{4})/i) || c.match(/>\s*((?:19|20)\d{2})\s*</) || [])[1];
    var type = (c.match(/class="[^"]*type[^"]*"[^>]*>\s*([^<]+)/i) || [])[1] || '';
    title = decodeHtml(title).trim();
    var url = abs(href);
    if (!title || seen[url]) return;
    seen[url] = 1;
    out.push({ url: url, title: title, year: parseInt(year, 10) || 0, type: String(type).trim() });
  });
  return out;
}

function searchSite(q) {
  return siteGet('/search/?q=' + encodeURIComponent(q), { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'fetch' }, 'S').then(function (r) {
    var htmls;
    try {
      var j = JSON.parse(r.text);
      htmls = j.results || j.data || j.html || [];
      if (typeof htmls === 'string') htmls = [htmls];
      htmls = htmls.join ? htmls.join('\n') : String(htmls);
    } catch (e) { htmls = r.text; }
    return parseResults(htmls);
  });
}

function isSeriesItem(it) { return /dizi/i.test(it.type) || it.url.indexOf('/dizi/') > -1; }

function titleParts(t) { return String(t || '').split(/\s+[-–—]\s+/).concat([t]); }

function pickBest(list, wants, year, isTv) {
  var best = null, bs = -1;
  list.forEach(function (it) {
    if (isSeriesItem(it) !== isTv) return;
    var n = norm(it.title), parts = titleParts(it.title).map(norm), s = 0;
    wants.forEach(function (w) {
      var wn = norm(w);
      if (!wn) return;
      if (n === wn || parts.indexOf(wn) > -1) s = Math.max(s, 100);
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
  var re = new RegExp('href="((?:https?:\\/\\/[^"\\/]+)?\\/dizi\\/[^"]*?\\/sezon-' + s + '\\/bolum-' + e + '(?:-[a-z0-9-]+)?\\/)"', 'i');
  var m = String(html || '').match(re);
  return m ? abs(m[1]) : '';
}

// ---------------- Film / bölüm sayfası ----------------

// <div class="alternative-links" data-active="1" data-lang="dual"> <button class="alternative-link" data-video="123">Close</button> ...
function parseAlts(html) {
  var out = [], h = String(html || ''), re = /<div[^>]*alternative-links[^>]*>/gi, m, starts = [];
  while ((m = re.exec(h)) !== null) starts.push({ tag: m[0], at: m.index + m[0].length });
  starts.forEach(function (st, i) {
    var end = i + 1 < starts.length ? starts[i + 1].at - starts[i + 1].tag.length : Math.min(h.length, st.at + 2500);
    var blk = h.slice(st.at, end);
    var lang = (st.tag.match(/data-lang="([^"]+)"/) || [])[1] || '';
    var bre = /<button([^>]*)>([\s\S]*?)<\/button>/gi, b;
    while ((b = bre.exec(blk)) !== null) {
      var id = (b[1].match(/data-video="(\d+)"/) || [])[1];
      if (!id) continue;
      var nm = decodeHtml(b[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      out.push({ id: id, name: nm || 'Player', lang: lang || (b[1].match(/data-lang="([^"]+)"/) || [])[1] || '', active: /data-active="1"|\bactive\b/.test(st.tag + b[1]) });
    }
  });
  return out;
}

function pageIframe(html) {
  var m = String(html || '').match(/<iframe[^>]*?\s(?:data-src|src)="(https?:[^"]+|\/\/[^"]+)"/i);
  return m ? abs(m[1]) : '';
}

function iframeFromAjax(text) {
  var t = String(text || '');
  try {
    var j = JSON.parse(t), h = (j && j.data && (j.data.html || j.data)) || (j && j.html) || '';
    if (typeof h === 'string' && h) t = h;
  } catch (e) {}
  t = t.replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\u0026/g, '&');
  var m = t.match(/(?:data-src|src)="((?:https?:)?\/\/[^"]+)"/i);
  return m ? abs(m[1]) : '';
}

function playerLabel(job) {
  var n = /rapid/i.test(job.name) ? 'Rapid' : /close/i.test(job.name) ? 'Close' : (job.name || 'Player');
  return (job.lang === 'dual' ? 'DUAL' : (job.lang ? 'Altyazılı' : 'TR')) + ' ' + n;
}

// ---------------- Oynatıcı çözümleme ----------------

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
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
function unesc(s) {
  return String(s || '').replace(/\\x([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
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

// dc_xxxx(["parça1","parça2",...]) biçimi: bilinen dönüşümlerin tüm kombinasyonları denenir
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

// İç içe base64 (dc_hello("...") = base64 -> ters çevir -> base64): bağlantı çıkana kadar en çok 3 kat
function deepB64(s, depth, out) {
  if (depth > 3 || out.length > 40) return;
  [s, rev(s)].forEach(function (p) {
    var d = b64(p);
    if (!d) return;
    [d, rev(d)].forEach(function (c) {
      if (/https?:\/\/|\.m3u8|\.mp4/.test(c)) { out.push(c); return; }
      var t = c.replace(/\s+/g, '');
      if (t.length >= 24 && /^[A-Za-z0-9+\/=_-]+$/.test(t)) deepB64(t, depth + 1, out);
    });
  });
}
function b64Strings(html) {
  var out = [], seen = {}, m, re = /["'`]([A-Za-z0-9+\/=_-]{40,})["'`]/g;
  while ((m = re.exec(html)) !== null && out.length < 40) { if (!seen[m[1]]) { seen[m[1]] = 1; deepB64(m[1], 0, out); } }
  // dc_xxx("...") tek parametreli biçim (uzun dizeler regex ile yukarıda zaten yakalanır)
  return out;
}

function extractMedia(blob) {
  var t = String(blob || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/\\x2F/gi, '/').replace(/&amp;/g, '&');
  var urls = [], m, re = /https?:\/\/[^"'\s<>\\)]+/g;
  while ((m = re.exec(t)) !== null) {
    var u = m[0];
    if (/\.(vtt|srt|jpe?g|png|webp|gif|css|js|ico|svg|woff2?)(\?|\/?$)/i.test(u)) continue;
    if (/\.m3u8|\.mp4|sublist|\/hls\d?\/|\/(?:master|playlist|index)[^\/"']*\.txt/i.test(u)) urls.push(u);
  }
  var re2 = /["'](\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*)["']/g;
  while ((m = re2.exec(t)) !== null) urls.push('https:' + m[1]);
  return urls;
}

function extractSubs(blob, base) {
  var t = String(blob || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  var out = [], m, re = /["'(]((?:https?:\/\/|\/)[^"'\s\\)]*?(?:\.vtt|\/srt\/)[^"'\s\\)]*)["')]/g;
  while ((m = re.exec(t)) !== null) {
    var u = /^https?:/.test(m[1]) ? m[1] : (base + m[1]), low = u.toLowerCase();
    var lang = /tur|turk/.test(low) ? 'tr' : (/eng|english/.test(low) ? 'en' : '');
    if (lang) out.push({ url: u, lang: lang, label: lang === 'tr' ? 'Türkçe' : 'English' });
  }
  return out;
}

function collectBlobs(html) {
  var blobs = [html, unesc(html)];
  unpackAll(html).forEach(function (u) { blobs.push(u); });
  blobs.slice().forEach(function (b) { dcDecode(b).forEach(function (d) { blobs.push(d); }); });
  b64Strings(html).forEach(function (d) { blobs.push(d); });
  return blobs;
}

function embedHeaders(embedUrl, ref) {
  return { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7', 'Referer': ref };
}

// Gömülü sayfayı çöz; iç içe iframe varsa bir kat daha
function resolveEmbed(embedUrl, pageUrl, depth) {
  depth = depth || 0;
  var refs = uniq([AYAR.SITE + '/', pageUrl]);
  function tryRef(i) {
    if (i >= refs.length) return Promise.resolve({ urls: [], subs: [], html: '' });
    return rawGet(embedUrl, embedHeaders(embedUrl, refs[i]), 'EMB' + (depth ? 'i' : '')).then(function (r) {
      var html = r.text || '', urls = [], subs = [], seenS = {};
      collectBlobs(html).forEach(function (b) {
        extractMedia(b).forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
        extractSubs(b, originOf(embedUrl)).forEach(function (s) { if (!seenS[s.url]) { seenS[s.url] = 1; subs.push(s); } });
      });
      note('blob url ' + urls.length + ' sub ' + subs.length);
      if (urls.length) return { urls: urls, subs: subs, html: html };
      // iç iframe
      var inner = html.match(/<iframe[^>]*?\s(?:data-src|src)="((?:https?:)?\/\/[^"]+)"/i);
      if (inner && depth < 1) {
        var iu = inner[1].indexOf('//') === 0 ? 'https:' + inner[1] : inner[1];
        note('ic iframe ' + hostShort(iu));
        return resolveEmbed(iu, embedUrl, depth + 1).then(function (rr) { return rr.urls.length ? rr : tryRef(i + 1); });
      }
      return tryRef(i + 1);
    });
  }
  return tryRef(0);
}

// ---------------- Doğrulama ----------------
// "Source error"ın en sık nedeni: bağlantı 404/403 ya da yanlış Referer/Origin. Her aday m3u8 gerçekten açılıyor mu bakılır;
// çalışan başlık takımı akışa yazılır.

function streamHeaderSets(embedUrl) {
  var org = originOf(embedUrl);
  return [
    { 'User-Agent': UA, 'Referer': org + '/', 'Origin': org },
    { 'User-Agent': UA, 'Referer': embedUrl },
    { 'User-Agent': UA, 'Referer': AYAR.SITE + '/', 'Origin': AYAR.SITE },
    { 'User-Agent': UA }
  ];
}

function isPlaylist(r) { return (r.status === 200 || r.status === 206) && /^\s*#EXTM3U/.test(r.text || ''); }

function verifyUrl(u, sets) {
  if (!AYAR.DOGRULA || /\.mp4(\?|$)/i.test(u)) return Promise.resolve({ ok: true, headers: sets[0], kind: 'mp4' });
  function next(i) {
    if (i >= sets.length) return Promise.resolve({ ok: false, headers: sets[0], kind: 'x' });
    return rawGet(u, sets[i], '', 6000).then(function (r) {
      if (isPlaylist(r)) {
        var master = /#EXT-X-STREAM-INF/.test(r.text);
        return { ok: true, headers: sets[i], kind: master ? 'master' : 'media' };
      }
      note('dogrula ' + hostShort(u) + ' h' + i + ' ' + (r.status || r.err || '?'));
      return next(i + 1);
    });
  }
  return next(0);
}

function rank(u) { return /master/i.test(u) ? 0 : /\.m3u8/i.test(u) ? 1 : 2; }

// ---------------- Akış üretimi ----------------

function makeStream(job, embedUrl, u, v, subs, idx) {
  var label = playerLabel(job) + (idx > 0 ? ' #' + (idx + 1) : '');
  var s = {
    name: AYAR.EKLENTI_ADI + ' - ' + label,
    title: [AYAR.EKLENTI_ADI, job.lang === 'dual' ? 'TR Dual' : 'Altyazılı', job.name, 'Auto'].join(' | '),
    url: u,
    quality: 'Auto',
    headers: v.headers,
    provider: PROVIDER_ID
  };
  if (/\.mp4(\?|$)/i.test(u)) s.type = 'mp4';
  else if (!/\.m3u8/i.test(u)) s.type = 'hls';      // master.txt gibi uzantısız listeler: oynatıcıya HLS olduğunu söyle
  if (subs && subs.length) s.subtitles = subs;
  return s;
}

function debugStream(msg) {
  if (!AYAR.DEBUG_MODU) return [];
  return [msg].concat(dbg.slice(0, 45)).map(function (r) {
    return { name: 'DEBUG ' + r, title: 'DEBUG ' + r, url: 'https://debug.invalid/', quality: 'Auto', provider: PROVIDER_ID };
  });
}

// ---------------- Sayfa bulma ----------------

function pageOk(r) { return r && r.ok && !denied(r) && /alternative-link|<iframe|data-video=/i.test(r.text || ''); }

function slugGuess(titles, isTv) {
  var out = [];
  titles.slice(0, 3).forEach(function (t) {
    var s = slugify(t);
    if (!s) return;
    if (isTv) out.push('/dizi/' + s + '/');
    else { out.push('/' + s + '-izle/'); out.push('/' + s + '/'); }
  });
  return uniq(out);
}

function getEpisodeUrl(seriesUrl, season, episode) {
  return siteGet(pathOf(seriesUrl), null, 'SER').then(function (r) {
    var u = findEpisode(r.text, season, episode);
    if (u) { note('bolum ' + pathOf(u).slice(0, 50)); return u; }
    var g = abs(seriesUrl.replace(/\/+$/, '') + '/sezon-' + season + '/bolum-' + episode + '/');
    note('bolum tahmin ' + pathOf(g).slice(-30));
    return g;
  });
}

function findPage(imdb, titles, year, isTv, season, episode) {
  var queries = uniq([imdb].concat(titles.slice(0, 3)));
  return Promise.all(queries.map(function (q) { return searchSite(q).catch(function () { return []; }); })).then(function (lists) {
    var all = [], seen = {}, byImdb = [];
    lists.forEach(function (l, i) {
      l.forEach(function (it) {
        if (queries[i] === imdb && isSeriesItem(it) === isTv) byImdb.push(it);
        if (!seen[it.url]) { seen[it.url] = 1; all.push(it); }
      });
    });
    note('arama ' + all.length + ' imdb:' + byImdb.length);
    var best = null;
    if (byImdb.length) {                                    // IMDb numarasıyla gelen sonuç kesindir
      best = byImdb[0];
      if (year) byImdb.forEach(function (it) { if (it.year === year) best = it; });
    }
    if (!best) best = pickBest(all, titles, year, isTv);
    if (best) {
      note('bulundu ' + pathOf(best.url).slice(0, 50));
      return isTv ? getEpisodeUrl(best.url, season, episode) : best.url;
    }
    // arama boş: adresi tahmin et ve sayfa gerçekten var mı bak
    var guesses = slugGuess(titles, isTv);
    note('tahmin ' + guesses.length);
    return Promise.all(guesses.map(function (g) { return siteGet(g, null, '').then(function (r) { return pageOk(r) ? g : ''; }); })).then(function (oks) {
      var g = oks.filter(Boolean)[0];
      if (!g) { note('sitede bulunamadi'); return null; }
      note('tahminle bulundu ' + g.slice(0, 40));
      return isTv ? getEpisodeUrl(abs(g), season, episode) : abs(g);
    });
  });
}

// ---------------- Ana akış ----------------

function getStreamsInner(tmdbId, mediaType, season, episode, holder) {
  var isTv = (mediaType === 'tv' || mediaType === 'series');
  dbg = ['v1.1.0'];
  var base = 'https://api.themoviedb.org/3/' + (isTv ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_KEY;
  return Promise.all([
    getJson(base + '&language=tr-TR' + (isTv ? '&append_to_response=external_ids' : '')),
    getJson(base + '&language=en-US').catch(function () { return {}; })
  ]).then(function (both) {
    var tr = both[0] || {}, en = both[1] || {};
    var titles = uniq([tr.title || tr.name, en.title || en.name, tr.original_title || tr.original_name]);
    var year = parseInt((tr.release_date || tr.first_air_date || '').slice(0, 4), 10) || 0;
    var imdb = tr.imdb_id || (tr.external_ids && tr.external_ids.imdb_id) || '';
    if (!titles.length) return debugStream('TMDB bilgisi eksik');
    note('film ' + titles[0] + ' ' + year + ' ' + (imdb || '-'));

    return findPage(imdb, titles, year, isTv, season, episode).then(function (pageUrl) {
      if (!pageUrl) return debugStream('sayfa bulunamadi');
      return siteGet(pathOf(pageUrl), null, 'PAGE').then(function (r) {
        var html = r.text, alts = parseAlts(html), ifr = pageIframe(html), jobs = [];
        note('alt ' + alts.map(function (a) { return a.lang + ':' + a.name + (a.active ? '*' : ''); }).join(','));
        note('iframe ' + (ifr ? hostShort(ifr) : '-'));
        alts.forEach(function (a) {
          var okLang = a.lang === 'dual' || !a.lang || (AYAR.ALTYAZILI_GOSTER && a.lang);
          if (okLang) jobs.push({ name: a.name, lang: a.lang || 'dual', id: a.id });
        });
        if (!jobs.length && ifr) jobs.push({ name: 'Player', lang: 'dual', embed: ifr });
        jobs = jobs.slice(0, AYAR.MAX_ALTERNATIF);
        if (!jobs.length) return debugStream('oynatici yok');
        var firstDual = jobs[0];

        var seenUrl = {}, seenEmb = {};
        var tasks = jobs.map(function (job) {
          var embedP = job.embed ? Promise.resolve(job.embed)
            : siteGet('/video/' + job.id + '/', { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'fetch', 'Referer': pageUrl }, 'V' + job.id.slice(-3))
              .then(function (rr) { return iframeFromAjax(rr.text) || (job === firstDual ? ifr : ''); });
          return embedP.then(function (embedUrl) {
            if (!embedUrl) { note('embed yok ' + job.name); return; }
            if (seenEmb[embedUrl]) { note('ayni embed ' + job.name); return; }
            seenEmb[embedUrl] = 1;
            return resolveEmbed(embedUrl, pageUrl).then(function (res) {
              var sets = streamHeaderSets(embedUrl);
              var cands = res.urls.slice().sort(function (a, b) { return rank(a) - rank(b); }).slice(0, 4);
              return Promise.all(cands.map(function (u) { return verifyUrl(u, sets).then(function (v) { return { u: u, v: v }; }); })).then(function (vs) {
                var good = vs.filter(function (x) { return x.v.ok; });
                if (!good.length && vs.length) { note('dogrulanamadi ' + job.name + ' (yine de eklendi)'); good = vs.slice(0, 1); }
                good.forEach(function (x, i) {
                  if (seenUrl[x.u]) return;
                  seenUrl[x.u] = 1;
                  holder.streams.push(makeStream(job, embedUrl, x.u, x.v, res.subs, i));
                });
              });
            });
          });
        });
        return waitWithin(tasks, 20000).then(function () {
          if (!holder.streams.length) return debugStream('kaynak cikmadi');
          return holder.streams;
        });
      });
    });
  }).catch(function (e) { return holder.streams.length ? holder.streams : debugStream('hata ' + (e && e.message)); });
}

function finalize(streams) {
  var real = (streams || []).filter(function (s) { return s && s.url !== 'https://debug.invalid/'; });
  if (real.length && AYAR.DEBUG_MODU) return real.concat(debugStream('akis: ' + real.length));   // debug açıkken satırlar akışların altında da görünür
  return real.length ? real : (streams || []);
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function (resolve) {
    var done = false, holder = { streams: [] };
    var timer = setTimeout(function () {
      if (!done) { done = true; resolve(holder.streams.length ? finalize(holder.streams) : debugStream('zaman asimi ' + AYAR.GENEL_SURE + 'ms')); }
    }, AYAR.GENEL_SURE);
    getStreamsInner(tmdbId, mediaType, season, episode, holder).then(function (r) {
      if (!done) { done = true; clearTimeout(timer); resolve(finalize(r)); }
    }, function () {
      if (!done) { done = true; clearTimeout(timer); resolve(finalize(holder.streams)); }
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams, _t: { unpack: unpack, dcDecode: dcDecode, b64: b64, deepB64: deepB64, parseAlts: parseAlts, pageIframe: pageIframe, findEpisode: findEpisode, pickBest: pickBest, extractMedia: extractMedia, parseResults: parseResults, iframeFromAjax: iframeFromAjax, denied: denied } };
} else {
  global.getStreams = getStreams;
}
