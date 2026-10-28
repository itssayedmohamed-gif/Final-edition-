/* QR Extractor tab.
   Everything runs on this device: pdf.js renders the pages and reads the embedded images,
   a small built-in locator finds QR codes (finder patterns + timing pattern), and the codes are
   saved as PNG files. No PDF is uploaded anywhere. This file only adds the tab; it does not
   touch the Watermark tab. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };

  /* ================= QR locator (finds the code, does not decode it) ================= */
  var Locator = (function () {
    function otsu(gray) {
      var hist = new Uint32Array(256), n = gray.length, i;
      for (i = 0; i < n; i++) hist[gray[i]]++;
      var sum = 0; for (i = 0; i < 256; i++) sum += i * hist[i];
      var sumB = 0, wB = 0, best = -1, thr = 128;
      for (i = 0; i < 256; i++) {
        wB += hist[i]; if (!wB) continue;
        var wF = n - wB; if (!wF) break;
        sumB += i * hist[i];
        var mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; thr = i; }
      }
      return thr + 1;
    }
    function binGlobal(gray) {
      var t = otsu(gray), n = gray.length, bin = new Uint8Array(n);
      for (var i = 0; i < n; i++) bin[i] = gray[i] < t ? 1 : 0;
      return bin;
    }
    function binAdaptive(gray, w, h) {
      var r = clamp(Math.round(Math.min(w, h) / 10), 16, 90), W1 = w + 1, I = new Uint32Array(W1 * (h + 1)), x, y;
      for (y = 0; y < h; y++) {
        var rs = 0, row = y * w, o = (y + 1) * W1, p = y * W1;
        for (x = 0; x < w; x++) { rs += gray[row + x]; I[o + x + 1] = I[p + x + 1] + rs; }
      }
      var bin = new Uint8Array(w * h);
      for (y = 0; y < h; y++) {
        var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        for (x = 0; x < w; x++) {
          var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
          var area = (x1 - x0) * (y1 - y0), s = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
          bin[y * w + x] = gray[y * w + x] * area < s * 0.86 ? 1 : 0;
        }
      }
      return bin;
    }

    /* 1:1:3:1:1 finder pattern search (rows, cross-checked up/down and left/right) */
    function findFinders(bin, w, h) {
      var cx = [], cy = [], cm = [], cc = [];
      function cross(c) {
        var total = c[0] + c[1] + c[2] + c[3] + c[4];
        if (total < 7) return false;
        var m = total / 7, mv = m * 0.62;
        return Math.abs(m - c[0]) < mv && Math.abs(m - c[1]) < mv && Math.abs(3 * m - c[2]) < 3 * mv && Math.abs(m - c[3]) < mv && Math.abs(m - c[4]) < mv;
      }
      function check(vertical, col, row, maxc, orig) {
        var c = [0, 0, 0, 0, 0], n = vertical ? h : w, i = vertical ? row : col;
        var at = function (k) { return vertical ? bin[k * w + col] : bin[row * w + k]; };
        var start = i;
        while (i >= 0 && at(i) === 1) { c[2]++; i--; }
        if (i < 0) return -1;
        while (i >= 0 && at(i) === 0 && c[1] <= maxc) { c[1]++; i--; }
        if (i < 0 || c[1] > maxc) return -1;
        while (i >= 0 && at(i) === 1 && c[0] <= maxc) { c[0]++; i--; }
        if (c[0] > maxc) return -1;
        i = start + 1;
        while (i < n && at(i) === 1) { c[2]++; i++; }
        if (i === n) return -1;
        while (i < n && at(i) === 0 && c[3] < maxc) { c[3]++; i++; }
        if (i === n || c[3] >= maxc) return -1;
        while (i < n && at(i) === 1 && c[4] < maxc) { c[4]++; i++; }
        if (c[4] >= maxc) return -1;
        var total = c[0] + c[1] + c[2] + c[3] + c[4];
        if (5 * Math.abs(total - orig) >= 2 * orig) return -1;
        return cross(c) ? i - c[4] - c[3] - c[2] / 2 : -1;
      }
      function handle(y, endX, c) {
        var total = c[0] + c[1] + c[2] + c[3] + c[4], x = endX - c[4] - c[3] - c[2] / 2;
        var yy = check(true, Math.floor(x), y, c[2], total); if (yy < 0) return false;
        var xx = check(false, Math.floor(x), Math.floor(yy), c[2], total); if (xx < 0) return false;
        var m = total / 7;
        for (var k = 0; k < cx.length; k++) {
          var lim = Math.max(m, cm[k]) * 1.3;
          if (Math.abs(cx[k] - xx) <= lim && Math.abs(cy[k] - yy) <= lim && Math.max(m, cm[k]) / Math.min(m, cm[k]) < 1.5) {
            var n = cc[k]; cx[k] = (cx[k] * n + xx) / (n + 1); cy[k] = (cy[k] * n + yy) / (n + 1); cm[k] = (cm[k] * n + m) / (n + 1); cc[k] = n + 1;
            return true;
          }
        }
        cx.push(xx); cy.push(yy); cm.push(m); cc.push(1);
        return true;
      }
      for (var y = 0; y < h; y++) {
        var c = [0, 0, 0, 0, 0], state = 0, base = y * w;
        for (var x = 0; x < w; x++) {
          if (bin[base + x] === 1) {
            if (state & 1) state++;
            c[state]++;
          } else if ((state & 1) === 0) {
            if (state === 4) {
              if (cross(c) && handle(y, x, c)) { c[0] = c[1] = c[2] = c[3] = c[4] = 0; state = 0; }
              else { c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0; state = 3; }
            } else c[++state]++;
          } else c[state]++;
        }
        if (state === 4 && cross(c)) handle(y, w, c);
      }
      var out = [];
      for (var k = 0; k < cx.length; k++) if (cc[k] >= 2) out.push({ x: cx[k], y: cy[k], m: cm[k], n: cc[k] });
      out.sort(function (a, b) { return b.n - a.n; });
      return out.slice(0, 80);
    }

    /* Samples the timing pattern (alternating modules between the finders) to confirm it is a real QR code */
    function timingScore(bin, w, h, A, e1, e2, S) {
      var ok = 0, tot = 0;
      function black(px, py) {
        var ix = Math.round(px), iy = Math.round(py);
        return ix >= 0 && iy >= 0 && ix < w && iy < h ? bin[iy * w + ix] : -1;
      }
      function vote(px, py) {
        var v = 0, k, offs = [[0, 0], [0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]];
        for (k = 0; k < 5; k++) {
          var b = black(px + offs[k][0] * e1.x + offs[k][1] * e2.x, py + offs[k][0] * e1.y + offs[k][1] * e2.y);
          if (b < 0) return -1; v += b;
        }
        return v >= 3 ? 1 : 0;
      }
      for (var i = 8; i <= S - 9; i++) {
        var want = i % 2 === 0 ? 1 : 0;
        var p1 = vote(A.x + (i + 0.5 - 3.5) * e1.x + 3 * e2.x, A.y + (i + 0.5 - 3.5) * e1.y + 3 * e2.y);
        var p2 = vote(A.x + 3 * e1.x + (i + 0.5 - 3.5) * e2.x, A.y + 3 * e1.y + (i + 0.5 - 3.5) * e2.y);
        if (p1 >= 0) { tot++; if (p1 === want) ok++; }
        if (p2 >= 0) { tot++; if (p2 === want) ok++; }
      }
      return tot >= 4 ? ok / tot : 0;
    }

    /* module bits of the code (S x S), sampled from the located grid: used to recognise the same code twice */
    function sampleBits(bin, w, h, A, e1, e2, S) {
      var bits = new Uint8Array(S * S), offs = [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]];
      for (var r = 0; r < S; r++) for (var c = 0; c < S; c++) {
        var px = A.x + (c - 3) * e1.x + (r - 3) * e2.x, py = A.y + (c - 3) * e1.y + (r - 3) * e2.y, v = 0;
        for (var k = 0; k < 5; k++) {
          var ix = Math.round(px + offs[k][0] * e1.x + offs[k][1] * e2.x), iy = Math.round(py + offs[k][0] * e1.y + offs[k][1] * e2.y);
          if (ix >= 0 && iy >= 0 && ix < w && iy < h) v += bin[iy * w + ix];
        }
        bits[r * S + c] = v >= 3 ? 1 : 0;
      }
      return bits;
    }

    function assemble(f, bin, w, h) {
      var found = [], i, j, k, N = f.length;
      for (i = 0; i < N - 2; i++) for (j = i + 1; j < N - 1; j++) for (k = j + 1; k < N; k++) {
        var P = [f[i], f[j], f[k]], idx = [i, j, k];
        var mn = Math.min(P[0].m, P[1].m, P[2].m), mx = Math.max(P[0].m, P[1].m, P[2].m);
        if (mx / mn > 1.7) continue;
        var d01 = Math.hypot(P[0].x - P[1].x, P[0].y - P[1].y), d02 = Math.hypot(P[0].x - P[2].x, P[0].y - P[2].y), d12 = Math.hypot(P[1].x - P[2].x, P[1].y - P[2].y);
        var a, b, c, hyp, l1, l2;
        if (d12 >= d01 && d12 >= d02) { a = 0; b = 1; c = 2; hyp = d12; l1 = d01; l2 = d02; }
        else if (d02 >= d01 && d02 >= d12) { a = 1; b = 0; c = 2; hyp = d02; l1 = d01; l2 = d12; }
        else { a = 2; b = 0; c = 1; hyp = d01; l1 = d02; l2 = d12; }
        if (Math.min(l1, l2) / Math.max(l1, l2) < 0.68) continue;
        var leg = (l1 + l2) / 2, hr = hyp / leg;
        if (hr < 1.25 || hr > 1.6) continue;
        var A = P[a], B = P[b], C = P[c];
        var dot = ((B.x - A.x) * (C.x - A.x) + (B.y - A.y) * (C.y - A.y)) / (l1 * l2 || 1);
        if (Math.abs(dot) > 0.4) continue;
        /* The module size measured along image rows is too large when the code is rotated (up to x1.41),
           so every plausible version between the measured one and 1.5x of it is tried; the timing pattern picks the right one. */
        var m = (A.m + B.m + C.m) / 3, legMods = leg / m;
        if (legMods < 9.5 || legMods > 175) continue;
        var vlo = clamp(Math.floor((legMods - 10) / 4) - 1, 1, 40), vhi = clamp(Math.ceil((legMods * 1.5 - 10) / 4) + 1, 1, 40), best = null;
        for (var ver = vlo; ver <= vhi; ver++) {
          var S = 4 * ver + 17, e1 = { x: (B.x - A.x) / (S - 7), y: (B.y - A.y) / (S - 7) }, e2 = { x: (C.x - A.x) / (S - 7), y: (C.y - A.y) / (S - 7) };
          var sc = timingScore(bin, w, h, A, e1, e2, S);
          if (!best || sc > best.score + 0.02) best = { score: sc, S: S, e1: e1, e2: e2 };
        }
        if (!best || best.score < 0.72) continue;
        var e1v = best.e1, e2v = best.e2, q = 3.5;
        var pts = [
          { x: A.x - q * (e1v.x + e2v.x), y: A.y - q * (e1v.y + e2v.y) },
          { x: B.x + q * e1v.x - q * e2v.x, y: B.y + q * e1v.y - q * e2v.y },
          { x: C.x - q * e1v.x + q * e2v.x, y: C.y - q * e1v.y + q * e2v.y },
          { x: B.x + C.x - A.x + q * (e1v.x + e2v.x), y: B.y + C.y - A.y + q * (e1v.y + e2v.y) }
        ];
        var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
        found.push({ score: best.score, idx: idx, module: Math.hypot(e1v.x, e1v.y), size: best.S, corners: pts, bits: sampleBits(bin, w, h, A, e1v, e2v, best.S),
          bbox: { x1: Math.min.apply(null, xs), y1: Math.min.apply(null, ys), x2: Math.max.apply(null, xs), y2: Math.max.apply(null, ys) } });
      }
      found.sort(function (p, q2) { return q2.score - p.score; });
      var used = {}, out = [];
      found.forEach(function (c) {
        if (c.idx.some(function (n) { return used[n]; })) return;
        c.idx.forEach(function (n) { used[n] = 1; });
        out.push(c);
      });
      return out;
    }

    /* gray: Uint8Array(w*h). opts.adaptive adds a second pass with local thresholding. */
    function locate(gray, w, h, opts) {
      opts = opts || {};
      var bin = binGlobal(gray), res = assemble(findFinders(bin, w, h), bin, w, h);
      if (!res.length && opts.adaptive) { bin = binAdaptive(gray, w, h); res = assemble(findFinders(bin, w, h), bin, w, h); }
      return res;
    }
    return { locate: locate };
  })();
  window.WMQRLocator = Locator;

  /* ================= helpers: gray conversion, crops, PNG ================= */
  function grayFromRGBA(d, n) {
    var g = new Uint8Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) g[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    return g;
  }
  function newCanvas(w, h) { var c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }
  function canvasToBlob(c) {
    return new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error("PNG encode failed")); }, "image/png"); });
  }
  /* Two detections are the same code if their module grids match in any of the 8 orientations */
  function sameCode(a, b) {
    if (a.size !== b.size) return false;
    var S = a.size, limit = Math.floor(S * S * 0.14), t, r, c;
    for (t = 0; t < 8; t++) {
      var d = 0, x, y;
      for (r = 0; r < S && d <= limit; r++) for (c = 0; c < S; c++) {
        x = c; y = r;
        if (t & 1) { var tmp = x; x = y; y = tmp; }                       /* transpose */
        for (var k = 0; k < (t >> 1); k++) { var nx = S - 1 - y; y = x; x = nx; }   /* rotate 90 degrees k times */
        if (a.bits[r * S + c] !== b.bits[y * S + x]) d++;
      }
      if (d <= limit) return true;
    }
    return false;
  }
  function upscaleIfSmall(src) {
    var m = Math.max(src.width, src.height);
    if (m >= 400) return src;
    var k = Math.min(8, Math.ceil(400 / m)), c = newCanvas(src.width * k, src.height * k), g = c.getContext("2d");
    g.imageSmoothingEnabled = false; g.drawImage(src, 0, 0, c.width, c.height);
    freeCanvas(src); return c;
  }

  /* ================= embedded image access (pdf.js) ================= */
  function fingerprint(img) {
    var d = img.data, h = 2166136261 >>> 0, w = img.width | 0, ht = img.height | 0;
    h = Math.imul(h ^ w, 16777619); h = Math.imul(h ^ ht, 16777619);
    if (d && d.length) {
      var step = Math.max(1, Math.floor(d.length / 3000));
      for (var i = 0; i < d.length; i += step) h = Math.imul(h ^ d[i], 16777619);
      h = Math.imul(h ^ d.length, 16777619);
    } else if (img.bitmap) h = Math.imul(h ^ 7, 16777619);
    return (h >>> 0).toString(36) + "_" + w + "x" + ht;
  }
  /* gray version of the image, reduced by an integer factor f (keeps memory low for big scans) */
  function grayFromImage(img, f) {
    var w = img.width, h = img.height, gw = Math.max(1, Math.ceil(w / f)), gh = Math.max(1, Math.ceil(h / f));
    if (img.bitmap && !img.data) {
      var c = newCanvas(gw, gh), g = c.getContext("2d", { willReadFrequently: true });
      g.fillStyle = "#fff"; g.fillRect(0, 0, gw, gh); g.drawImage(img.bitmap, 0, 0, gw, gh);
      var gr = grayFromRGBA(g.getImageData(0, 0, gw, gh).data, gw * gh); freeCanvas(c);
      return { gray: gr, w: gw, h: gh };
    }
    var d = img.data, kind = img.kind, out = new Uint8Array(gw * gh), x, y, xx, yy, n, s, p;
    var rowBytes1 = (w + 7) >> 3;
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
      s = 0; n = 0;
      for (yy = y * f; yy < Math.min(h, y * f + f); yy++) for (xx = x * f; xx < Math.min(w, x * f + f); xx++) {
        if (kind === 2) { p = (yy * w + xx) * 3; s += (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8; }
        else if (kind === 3) { p = (yy * w + xx) * 4; s += (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8; }
        else if (kind === 1) { s += (d[yy * rowBytes1 + (xx >> 3)] >> (7 - (xx & 7))) & 1 ? 255 : 0; }
        else { s += d[yy * w + xx] || 0; }
        n++;
      }
      out[y * gw + x] = n ? Math.round(s / n) : 255;
    }
    return { gray: out, w: gw, h: gh };
  }
  /* exact pixels of a rectangle of the original image -> canvas */
  function cropImage(img, r) {
    var x1 = clamp(Math.floor(r.x1), 0, img.width - 1), y1 = clamp(Math.floor(r.y1), 0, img.height - 1);
    var x2 = clamp(Math.ceil(r.x2), x1 + 1, img.width), y2 = clamp(Math.ceil(r.y2), y1 + 1, img.height), w = x2 - x1, h = y2 - y1;
    var c = newCanvas(w, h), g = c.getContext("2d");
    if (img.bitmap && !img.data) { g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(img.bitmap, x1, y1, w, h, 0, 0, w, h); return c; }
    var id = g.createImageData(w, h), o = id.data, d = img.data, kind = img.kind, x, y, p, q, rb = (img.width + 7) >> 3;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      q = (y * w + x) * 4;
      if (kind === 2) { p = ((y1 + y) * img.width + x1 + x) * 3; o[q] = d[p]; o[q + 1] = d[p + 1]; o[q + 2] = d[p + 2]; o[q + 3] = 255; }
      else if (kind === 3) { p = ((y1 + y) * img.width + x1 + x) * 4; o[q] = d[p]; o[q + 1] = d[p + 1]; o[q + 2] = d[p + 2]; o[q + 3] = 255; }
      else if (kind === 1) { var bit = (d[(y1 + y) * rb + ((x1 + x) >> 3)] >> (7 - ((x1 + x) & 7))) & 1 ? 255 : 0; o[q] = o[q + 1] = o[q + 2] = bit; o[q + 3] = 255; }
      else { var gv = d[(y1 + y) * img.width + x1 + x] || 0; o[q] = o[q + 1] = o[q + 2] = gv; o[q + 3] = 255; }
    }
    g.putImageData(id, 0, 0);
    return c;
  }
  function getPdfObj(page, id) {
    return new Promise(function (res) {
      var done = false;
      function fin(v) { if (!done) { done = true; res(v || null); } }
      try { (String(id).indexOf("g_") === 0 ? page.commonObjs : page.objs).get(id, fin); } catch (e) { fin(null); }
      setTimeout(function () { fin(null); }, 4000);
    });
  }

  /* ================= state + UI ================= */
  var S = { results: [], sigs: [], seen: {}, running: false, cancel: false, one: false, stopFound: false, doc: null, task: null, render: null, name: "book", working: false };
  var els = {};
  ["qrFile", "qrInfo", "qrDeep", "qrOne", "qrProgCard", "qrBarFill", "qrProg", "qrCancel", "qrCount", "qrSaveAll", "qrClear", "qrStatus", "qrEmpty", "qrGrid"].forEach(function (id) { els[id] = $(id); });
  if (!els.qrFile) return;

  function setStatus(msg, kind) { els.qrStatus.textContent = msg || ""; els.qrStatus.className = "qr-status" + (kind ? " " + kind : ""); }
  function updateCount() {
    var n = S.results.length;
    els.qrCount.textContent = n + (n === 1 ? " QR code" : " QR codes");
    els.qrSaveAll.disabled = !n || S.working; els.qrClear.disabled = (!n && !S.running) || S.working;
    els.qrEmpty.hidden = !!n;
  }
  function pad4(n) { return ("000" + n).slice(-4); }
  function baseName(n) { return (n || "book").replace(/\.pdf$/i, "") || "book"; }

  function addResult(blob, info) {
    var id = S.results.length + 1, name = baseName(S.name) + " - QR_" + pad4(id) + ".png";
    var rec = { id: id, name: name, blob: blob, page: info.page, source: info.source, w: info.w, h: info.h, url: URL.createObjectURL(blob) };
    S.results.push(rec);
    var card = document.createElement("div"); card.className = "qr-item";
    var img = document.createElement("img"); img.src = rec.url; img.alt = "QR code " + id; img.loading = "lazy";
    var cap = document.createElement("div"); cap.className = "qr-cap";
    cap.textContent = "Page " + rec.page + " \u00B7 " + rec.w + "\u00D7" + rec.h + " \u00B7 " + rec.source;
    var b = document.createElement("button"); b.type = "button"; b.textContent = "Save PNG";
    b.addEventListener("click", function () { saveOne(rec, b); });
    card.appendChild(img); card.appendChild(cap); card.appendChild(b);
    els.qrGrid.appendChild(card);
    updateCount();
  }
  function clearResults() {
    S.results.forEach(function (r) { URL.revokeObjectURL(r.url); });
    S.results = []; S.sigs = []; S.seen = {}; els.qrGrid.textContent = ""; updateCount();
  }

  /* keep a result only if the same code has not been saved already */
  async function emit(canvas, info, hit) {
    var mine = { size: hit.size, bits: hit.bits };
    for (var i = 0; i < S.sigs.length; i++) if (sameCode(S.sigs[i], mine)) { freeCanvas(canvas); return false; }
    S.sigs.push(mine);
    var blob = await canvasToBlob(canvas);
    info.w = canvas.width; info.h = canvas.height; freeCanvas(canvas);
    addResult(blob, info);
    if (S.one) { S.stopFound = true; S.cancel = true; }     /* "first code only": the book repeats the same code, one image is enough */
    return true;
  }

  /* ---- embedded images ---- */
  async function scanEmbedded(page, pageNo, deep) {
    var OPS = window.pdfjsLib.OPS, ops = await page.getOperatorList(), found = 0, handled = {};
    for (var i = 0; i < ops.fnArray.length; i++) {
      if (S.cancel) break;
      var fn = ops.fnArray[i], img = null, key = null;
      if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
        key = ops.argsArray[i][0]; if (handled[key]) continue; handled[key] = 1;
        img = await getPdfObj(page, key);
      } else if (fn === OPS.paintInlineImageXObject) img = ops.argsArray[i][0];
      else continue;
      if (!img || !img.width || !img.height || img.width < 21 || img.height < 21) continue;
      var px = img.width * img.height; if (px > 120e6) continue;
      var fp = fingerprint(img); if (S.seen[fp]) continue; S.seen[fp] = 1;
      var f = Math.max(1, Math.ceil(Math.sqrt(px / 14e6))), g = grayFromImage(img, f);
      var hits = Locator.locate(g.gray, g.w, g.h, { adaptive: deep });
      for (var k = 0; k < hits.length && !S.cancel; k++) {
        var hh = hits[k], pad = Math.max(3, Math.round(hh.module * 4));
        var full = { x1: hh.bbox.x1 * f, y1: hh.bbox.y1 * f, x2: hh.bbox.x2 * f, y2: hh.bbox.y2 * f };
        var covers = ((full.x2 - full.x1) * (full.y2 - full.y1)) / px >= 0.5 && px <= 36e6;
        var canvas;
        if (covers) canvas = cropImage(img, { x1: 0, y1: 0, x2: img.width, y2: img.height });                 /* the original image itself */
        else canvas = upscaleIfSmall(cropImage(img, { x1: full.x1 - pad * f, y1: full.y1 - pad * f, x2: full.x2 + pad * f, y2: full.y2 + pad * f }));
        if (await emit(canvas, { page: pageNo, source: covers ? "original image" : "embedded image" }, hh)) found++;
      }
      await tick();
    }
    return found;
  }

  /* ---- page render (vector codes, or anything the image pass did not catch) ---- */
  async function renderPage(page, scale, region) {
    var vp = page.getViewport({ scale: scale, offsetX: region ? -region.x : 0, offsetY: region ? -region.y : 0 });
    var w = region ? Math.ceil(region.w) : Math.ceil(vp.width), h = region ? Math.ceil(region.h) : Math.ceil(vp.height);
    var c = newCanvas(Math.max(1, w), Math.max(1, h)), g = c.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    S.render = page.render({ canvasContext: g, canvas: c, viewport: vp, background: "#ffffff" });
    try { await S.render.promise; } finally { S.render = null; }
    return c;
  }
  async function scanRender(page, pageNo, deep) {
    var v1 = page.getViewport({ scale: 1 }), maxPx = deep ? 14e6 : 9e6;
    var scale = clamp(Math.min(deep ? 4 : 3, Math.sqrt(maxPx / (v1.width * v1.height))), 0.6, 4), found = 0;
    var c = await renderPage(page, scale), g = c.getContext("2d", { willReadFrequently: true });
    var gray = grayFromRGBA(g.getImageData(0, 0, c.width, c.height).data, c.width * c.height), gw = c.width, gh = c.height;
    var hits = Locator.locate(gray, gw, gh, { adaptive: deep });
    for (var k = 0; k < hits.length && !S.cancel; k++) {
      var hh = hits[k], pad = Math.max(3, hh.module * 4);
      var x1 = Math.max(0, hh.bbox.x1 - pad), y1 = Math.max(0, hh.bbox.y1 - pad), x2 = Math.min(gw, hh.bbox.x2 + pad), y2 = Math.min(gh, hh.bbox.y2 + pad);
      var sidePt = Math.max(x2 - x1, y2 - y1) / scale, out = clamp(Math.min(560 / sidePt, 1800 / sidePt), scale, 12), canvas;
      if (out > scale * 1.05) {
        try { canvas = await renderPage(page, out, { x: x1 / scale * out, y: y1 / scale * out, w: (x2 - x1) / scale * out, h: (y2 - y1) / scale * out }); }
        catch (e) { canvas = null; }
      }
      if (!canvas) {
        canvas = newCanvas(Math.round(x2 - x1), Math.round(y2 - y1));
        canvas.getContext("2d").drawImage(c, x1, y1, x2 - x1, y2 - y1, 0, 0, canvas.width, canvas.height);
        canvas = upscaleIfSmall(canvas);
      }
      if (await emit(canvas, { page: pageNo, source: "page" }, hh)) found++;
    }
    freeCanvas(c);
    return found;
  }

  /* ---- run ---- */
  function fmtTime(ms) { var s = Math.round(ms / 1000), m = Math.floor(s / 60); return m + ":" + ("0" + (s % 60)).slice(-2); }
  function setBusy(on) {
    S.running = on; els.qrProgCard.hidden = !on; els.qrFile.disabled = on; els.qrDeep.disabled = on; if (els.qrOne) els.qrOne.disabled = on; updateCount();
  }
  function friendly(e) {
    var n = e && (e.name || ""), m = String(e && e.message || e);
    if (n === "PasswordException") return "الملف محمي بكلمة مرور.";
    if (n === "InvalidPDFException") return "الملف تالف أو ليس PDF صالحًا.";
    return "تعذّر فتح الملف: " + m;
  }
  async function waitPdfjs() {
    for (var i = 0; i < 40 && !window.pdfjsLib; i++) await new Promise(function (r) { setTimeout(r, 100); });
    if (!window.pdfjsLib) throw new Error("مكتبة PDF غير متاحة.");
    var go = window.pdfjsLib.GlobalWorkerOptions;
    if (go && !go.workerSrc) go.workerSrc = "./vendor/pdf.worker.min.js";
  }

  async function run(file) {
    if (S.running) return;
    clearResults(); S.name = file.name; S.cancel = false; S.stopFound = false; S.one = !!(els.qrOne && els.qrOne.checked);
    els.qrInfo.textContent = file.name + " (" + (file.size >= 1048576 ? (file.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(file.size / 1024)) + " KB") + ")";
    setBusy(true); setStatus("جارٍ فتح الملف…"); els.qrBarFill.style.width = "0%"; els.qrProg.textContent = "Opening PDF…";
    var wake = null, t0 = Date.now(), skipped = 0, done = 0, deep = els.qrDeep.checked;
    try { if (navigator.wakeLock && navigator.wakeLock.request) wake = await navigator.wakeLock.request("screen"); } catch (e) {}
    try {
      await waitPdfjs();
      var buf = await file.arrayBuffer();
      S.task = window.pdfjsLib.getDocument({ data: new Uint8Array(buf) });
      S.task.onProgress = function (p) { if (p && p.total) els.qrProg.textContent = "Opening PDF… " + Math.round(p.loaded / p.total * 100) + "%"; };
      buf = null;
      S.doc = await S.task.promise;
      var total = S.doc.numPages;
      for (var p = 1; p <= total; p++) {
        if (S.cancel) break;
        els.qrBarFill.style.width = Math.round((p - 1) / total * 100) + "%";
        els.qrProg.textContent = "Page " + p + " of " + total + " \u00B7 " + S.results.length + " found \u00B7 " + fmtTime(Date.now() - t0);
        try {
          var page = await S.doc.getPage(p);
          try { await scanEmbedded(page, p, deep); } catch (e1) { if (S.cancel) break; if (window.console) console.warn("QR Extractor: image scan failed on page " + p + ":", e1); }
          if (!S.cancel) await scanRender(page, p, deep);
          page.cleanup();
        } catch (e2) { if (!S.cancel) { skipped++; if (window.console) console.warn("QR Extractor: page " + p + " skipped:", e2); } }
        done = p; await tick();
      }
      els.qrBarFill.style.width = S.cancel ? els.qrBarFill.style.width : "100%";
      var n = S.results.length;
      if (S.stopFound) setStatus("تم العثور على الكود في الصفحة " + S.results[0].page + " وتوقف الفحص. احفظ الصورة بزر Save PNG.", "ok");
      else if (S.cancel) setStatus("أُلغي الفحص عند الصفحة " + done + ". الأكواد المكتشفة: " + n + ".", n ? "ok" : "err");
      else if (n) setStatus("تم الفحص. عدد الأكواد المكتشفة: " + n + (skipped ? " (تعذّر فحص " + skipped + " صفحة)" : "") + ".", "ok");
      else setStatus("لم يُعثر على أي كود QR" + (deep ? "." : ". جرّب Deep scan إن كانت الصفحات ممسوحة ضوئيًا.") + (skipped ? " تعذّر فحص " + skipped + " صفحة." : ""), "err");
    } catch (e) {
      setStatus(S.stopFound ? "تم العثور على الكود وتوقف الفحص." : S.cancel ? "أُلغي الفحص." : friendly(e), S.stopFound ? "ok" : "err");
    } finally {
      try { if (S.doc) await S.doc.destroy(); } catch (e) {}
      try { if (S.task) await S.task.destroy(); } catch (e) {}
      S.doc = null; S.task = null; S.render = null;
      try { if (wake) await wake.release(); } catch (e) {}
      setBusy(false); els.qrFile.value = "";
    }
  }
  function cancelRun() {
    if (!S.running) return;
    S.cancel = true; setStatus("جارٍ الإلغاء…");
    try { if (S.render && S.render.cancel) S.render.cancel(); } catch (e) {}
  }

  /* ---- saving ---- */
  async function bytesOf(rec) { return new Uint8Array(await rec.blob.arrayBuffer()); }
  async function saveOne(rec, btn) {
    if (S.working || (window.WMNative && WMNative.isSaving())) return;
    S.working = true; btn.disabled = true; updateCount();
    try {
      var r = await WMNative.saveParts([await bytesOf(rec)], rec.name, "image/png");
      if (r.ok) setStatus("تم حفظ " + rec.name, "ok"); else if (r.cancelled) setStatus("أُلغي الحفظ.", "err"); else setStatus("تعذّر الحفظ: " + r.error, "err");
    } finally { S.working = false; btn.disabled = false; updateCount(); }
  }
  function joinPath(dir, name) {
    var sep = dir.indexOf("\\") >= 0 && dir.indexOf("/") < 0 ? "\\" : "/";
    return dir.replace(/[\\/]+$/, "") + sep + name;
  }
  async function saveAll() {
    if (S.working || !S.results.length || (window.WMNative && WMNative.isSaving())) return;
    S.working = true; els.qrSaveAll.disabled = true; els.qrClear.disabled = true;
    var list = S.results.slice(), saved = 0, T = window.__TAURI__, dir = null, i;
    try {
      if (T && T.dialog && T.dialog.open && T.fs && T.fs.writeFile) {
        try {
          dir = await T.dialog.open({ directory: true, multiple: false, recursive: true, title: "Choose a folder for the QR images" });
          if (Array.isArray(dir)) dir = dir[0];
        } catch (e) { dir = undefined; }                           /* folder picking not available on this device */
        if (dir === null) { setStatus("أُلغي الحفظ.", "err"); return; }
        if (typeof dir === "string" && dir) {
          for (i = 0; i < list.length; i++) {
            setStatus("جارٍ الحفظ… " + (i + 1) + " / " + list.length);
            try { await T.fs.writeFile(joinPath(dir, list[i].name), await bytesOf(list[i])); saved++; }
            catch (e) { break; }                                   /* cannot write into this folder: continue with save dialogs */
            await tick();
          }
          if (saved === list.length) { setStatus("تم حفظ " + saved + " صورة PNG في المجلد المختار.", "ok"); return; }
        }
      }
      for (i = saved; i < list.length; i++) {
        setStatus("جارٍ الحفظ… " + (i + 1) + " / " + list.length + (saved === 0 && i === 0 && T && T.dialog ? " — اختر نفس المجلد في كل مرة." : ""));
        var r = await WMNative.saveParts([await bytesOf(list[i])], list[i].name, "image/png");
        if (r.cancelled) { setStatus("توقف الحفظ. تم حفظ " + saved + " من " + list.length + ".", "err"); return; }
        if (!r.ok) { setStatus("تعذّر الحفظ: " + r.error + " (تم حفظ " + saved + " من " + list.length + ")", "err"); return; }
        saved++;
      }
      setStatus("تم حفظ " + saved + " صورة PNG.", "ok");
    } finally { S.working = false; updateCount(); }
  }

  els.qrFile.addEventListener("change", function () {
    var f = els.qrFile.files && els.qrFile.files[0]; if (f) run(f);
  });
  els.qrCancel.addEventListener("click", cancelRun);
  els.qrSaveAll.addEventListener("click", saveAll);
  els.qrClear.addEventListener("click", function () { if (!S.running && !S.working) { clearResults(); setStatus(""); els.qrInfo.textContent = "No file selected."; } });
  window.WMQR = { state: S, run: run };
  updateCount();
})();
