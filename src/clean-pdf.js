/* "Clean Your pdf" tab: removes the QR images, the rotated name stamp and any text you type, from one or many PDFs, on this device.
   QR + name: port of the original script (square images of a set size are taken off every page, and the rotated
   "q ... 0 1 -1 0 ... Q" blocks that contain the stamp characters are dropped).
   Custom text (Advanced): the page text is decoded with each font's own ToUnicode map, the phrases you typed are found
   (ignoring case and spaces, also across words that are placed separately) and exactly those glyphs are cut out.
   Nothing is uploaded. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  if (!$("clFile") || !window.PDFLib) return;
  var L = window.PDFLib, N = function (n) { return L.PDFName.of(n); };

  var S = { busy: false, cancel: false, files: [], results: [], saving: false };
  var el = {};
  ["clFile", "clInfo", "clQr", "clName", "clTxt", "clTxtList", "clMin", "clMax", "clChars", "clRun", "clProgCard", "clBarFill", "clProg", "clCancel", "clResult", "clList", "clSave", "clStatus"].forEach(function (id) { el[id] = $(id); });

  function setStatus(msg, kind) { el.clStatus.textContent = msg || ""; el.clStatus.className = "qr-status" + (kind ? " " + kind : ""); }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function bytesToLatin1(u8) { var out = [], CH = 8192; for (var i = 0; i < u8.length; i += CH) out.push(String.fromCharCode.apply(null, u8.subarray(i, i + CH))); return out.join(""); }
  function latin1ToBytes(s) { var u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }
  function esc(t) { return t.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---- rule 1 + 2 (same logic as the original script) ---- */
  function removeNameBlocks(data, chars) {
    var lines = data.split("\n"), out = [], i = 0, removed = 0;
    while (i < lines.length) {
      if (lines[i].trim() === "q" && i + 1 < lines.length && lines[i + 1].indexOf("0 1 -1 0") >= 0) {
        var end = -1;
        for (var j = i + 1; j < Math.min(i + 15, lines.length); j++) if (lines[j].trim() === "Q") { end = j; break; }
        if (end >= 0) {
          var block = lines.slice(i, end + 1).join("\n"), hit = false;
          for (var k = 0; k < chars.length; k++) if (block.indexOf(chars[k]) >= 0) { hit = true; break; }
          if (hit) { i = end + 1; removed++; continue; }
        }
      }
      out.push(lines[i]); i++;
    }
    return { text: out.join("\n"), removed: removed };
  }
  function removeDoCalls(data, names) {
    var calls = 0;
    names.forEach(function (n) {
      data = data.replace(new RegExp(esc(n) + "\\s+Do\\b", "g"), function () { calls++; return ""; });
    });
    return { text: data, calls: calls };
  }

  function num(obj) { return obj instanceof L.PDFNumber ? obj.asNumber() : NaN; }

  /* ================= rule 3: delete any text the user typed ================= */

  /* ToUnicode CMap -> { map: code -> string, codeLen } */
  function hexToUni(h) {
    if (h.length <= 2) return String.fromCharCode(parseInt(h, 16));
    var s = ""; for (var i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16));
    return s;
  }
  function parseCMap(txt) {
    var map = new Map(), codeLen = 0, m, re;
    re = /begincodespacerange([\s\S]*?)endcodespacerange/g;
    while ((m = re.exec(txt))) { var cs = /<([0-9A-Fa-f]+)>/.exec(m[1]); if (cs && !codeLen) codeLen = Math.ceil(cs[1].length / 2); }
    re = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = re.exec(txt))) {
      var r1 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g, a;
      while ((a = r1.exec(m[1]))) map.set(parseInt(a[1], 16), hexToUni(a[2]));
    }
    re = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = re.exec(txt))) {
      var r2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]*>)/g, b;
      while ((b = r2.exec(m[1]))) {
        var lo = parseInt(b[1], 16), hi = parseInt(b[2], 16), dst = b[3];
        if (hi - lo > 65535) continue;
        if (dst.charAt(0) === "[") {
          var items = dst.match(/<([0-9A-Fa-f]*)>/g) || [];
          for (var k = 0; k < items.length && lo + k <= hi; k++) map.set(lo + k, hexToUni(items[k].slice(1, -1)));
        } else {
          var h = dst.slice(1, -1), base = hexToUni(h), last = base.charCodeAt(base.length - 1);
          for (var c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
        }
      }
    }
    return { map: map, codeLen: codeLen };
  }

  /* one decoder per font dictionary: { codeLen, dec(code) -> string | null } */
  function makeFontResolver(ctx) {
    var cache = new Map();
    function build(fd) {
      var sub = fd.lookup(N("Subtype")), subName = sub instanceof L.PDFName ? sub.asString() : "";
      var type0 = subName === "/Type0", cm = null;
      try {
        var tu = fd.lookup(N("ToUnicode"));
        if (tu instanceof L.PDFRawStream) cm = parseCMap(bytesToLatin1(L.decodePDFRawStream(tu).decode()));
      } catch (e) { cm = null; }
      if (cm && cm.map.size) {
        var len = cm.codeLen || (type0 ? 2 : 1);
        return { codeLen: len, dec: function (c) { var v = cm.map.get(c); return v == null ? null : v; } };
      }
      if (type0) return { codeLen: 2, dec: function () { return null; } };   /* no way to know what the glyphs are */
      return { codeLen: 1, dec: function (c) { return c >= 32 && c < 127 ? String.fromCharCode(c) : (c === 32 ? " " : null); } };
    }
    return function (res, name) {
      if (!res) return null;
      var fonts = res.lookup(N("Font"));
      if (!(fonts instanceof L.PDFDict)) return null;
      var fd = fonts.lookup(N(name.replace(/^\//, "")));
      if (!(fd instanceof L.PDFDict)) return null;
      if (!cache.has(fd)) cache.set(fd, build(fd));
      return cache.get(fd);
    };
  }

  function isWS(c) { return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0; }
  function isDelim(c) { return c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37; }

  /* content stream tokenizer: calls cb(token) with {t:"str"|"hex"|"name"|"num"|"op"|"[", "]", a, b, v}.
     str/hex carry v = the raw bytes (as a latin-1 string). */
  function tokenize(s, cb) {
    var i = 0, n = s.length;
    while (i < n) {
      var c = s.charCodeAt(i);
      if (isWS(c)) { i++; continue; }
      if (c === 37) { while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++; continue; }
      var a = i;
      if (c === 40) {
        var depth = 1, out = []; i++;
        while (i < n && depth > 0) {
          var d = s.charCodeAt(i);
          if (d === 92) {
            var e = s.charAt(i + 1);
            if (/[0-7]/.test(e)) { var o = /^[0-7]{1,3}/.exec(s.substr(i + 1, 3))[0]; out.push(String.fromCharCode(parseInt(o, 8) & 255)); i += 1 + o.length; }
            else if (e === "n") { out.push("\n"); i += 2; } else if (e === "r") { out.push("\r"); i += 2; }
            else if (e === "t") { out.push("\t"); i += 2; } else if (e === "b") { out.push("\b"); i += 2; } else if (e === "f") { out.push("\f"); i += 2; }
            else if (e === "\r") { i += s.charAt(i + 2) === "\n" ? 3 : 2; } else if (e === "\n") { i += 2; }
            else { out.push(e); i += 2; }
          } else if (d === 40) { depth++; out.push("("); i++; }
          else if (d === 41) { depth--; if (depth > 0) out.push(")"); i++; }
          else { out.push(s.charAt(i)); i++; }
        }
        cb({ t: "str", a: a, b: i, v: out.join("") }); continue;
      }
      if (c === 60) {
        if (s.charCodeAt(i + 1) === 60) { i += 2; cb({ t: "op", a: a, b: i, v: "<<" }); continue; }
        var close = s.indexOf(">", i + 1); if (close < 0) close = n;
        var hx = s.slice(i + 1, close).replace(/\s+/g, ""); if (hx.length % 2) hx += "0";
        var raw = ""; for (var h = 0; h + 2 <= hx.length; h += 2) raw += String.fromCharCode(parseInt(hx.substr(h, 2), 16) || 0);
        i = close + 1; cb({ t: "hex", a: a, b: i, v: raw }); continue;
      }
      if (c === 62) { if (s.charCodeAt(i + 1) === 62) { i += 2; cb({ t: "op", a: a, b: i, v: ">>" }); } else i++; continue; }
      if (c === 91) { i++; cb({ t: "[", a: a, b: i }); continue; }
      if (c === 93) { i++; cb({ t: "]", a: a, b: i }); continue; }
      if (c === 123 || c === 125 || c === 41) { i++; continue; }
      if (c === 47) { i++; while (i < n && !isWS(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) i++; cb({ t: "name", a: a, b: i, v: s.slice(a, i) }); continue; }
      while (i < n && !isWS(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) i++;
      var w = s.slice(a, i);
      if (w === "BI") {   /* inline image: skip the binary data up to EI */
        var m = /[\s\)]EI(?=[\s]|$)/.exec(s.slice(i)); i = m ? i + m.index + m[0].length : n; continue;
      }
      cb({ t: /^[+-]?(\d+\.?\d*|\.\d+)$/.test(w) ? "num" : "op", a: a, b: i, v: w });
    }
  }

  function normCh(ch) {
    var x = ch; try { x = ch.normalize("NFKC"); } catch (e) {}
    return x.toLowerCase();
  }
  function compactPhrase(p) {
    var out = ""; for (var i = 0; i < p.length; i++) { var c = normCh(p.charAt(i)); if (!/\s/.test(c)) out += c; }
    return out;
  }

  /* Deletes the phrases from one decoded content stream. Returns { text, hits }. */
  function deleteTextInStream(s, phrases, getFont) {
    var edits = [], hits = 0;
    var fontStack = [], curFont = null, ops = [], block = null;

    function flushBlock() {
      if (!block || !block.glyphs.length) { block = null; return; }
      var g = block.glyphs, compact = "", back = [], i, j;
      for (i = 0; i < g.length; i++) {
        var tx = g[i].text == null ? "￿" : g[i].text;
        for (j = 0; j < tx.length; j++) {
          var ch = normCh(tx.charAt(j));
          for (var q = 0; q < ch.length; q++) { if (!/\s/.test(ch.charAt(q))) { compact += ch.charAt(q); back.push(i); } }
        }
      }
      var kill = {}, any = false;
      phrases.forEach(function (p) {
        [p, p.split("").reverse().join("")].forEach(function (pat, which) {
          if (which === 1 && pat === p) return;
          var from = 0, at;
          while ((at = compact.indexOf(pat, from)) >= 0) {
            var g0 = back[at], g1 = back[at + pat.length - 1];
            for (var k = g0; k <= g1; k++) kill[k] = true;
            hits++; any = true; from = at + pat.length;
          }
        });
      });
      if (any) {
        var byTok = new Map();
        g.forEach(function (gl, idx) {
          var rec = byTok.get(gl.tok); if (!rec) { rec = { tok: gl.tok, parts: [], cut: false }; byTok.set(gl.tok, rec); }
          if (kill[idx]) rec.cut = true; else rec.parts.push(gl.raw);
        });
        byTok.forEach(function (rec) {
          if (!rec.cut) return;
          var hex = ""; rec.parts.forEach(function (raw) { for (var z = 0; z < raw.length; z++) hex += ("0" + raw.charCodeAt(z).toString(16)).slice(-2); });
          edits.push({ a: rec.tok.a, b: rec.tok.b, text: "<" + hex.toUpperCase() + ">" });
        });
      }
      block = null;
    }
    function addStrings(list) {
      if (!block) block = { glyphs: [] };
      list.forEach(function (tok) {
        var f = curFont, len = f ? f.codeLen : 1, v = tok.v;
        for (var p = 0; p + len <= v.length; p += len) {
          var code = 0, raw = v.substr(p, len);
          for (var k = 0; k < len; k++) code = code * 256 + raw.charCodeAt(k);
          block.glyphs.push({ tok: tok, raw: raw, text: f ? f.dec(code) : null });
        }
      });
    }

    tokenize(s, function (t) {
      if (t.t !== "op") { ops.push(t); return; }
      var op = t.v;
      /* the whole stream is one flow of text, so a phrase is also found when its words sit in different BT..ET blocks */
      if (op === "q") fontStack.push(curFont);
      else if (op === "Q") { if (fontStack.length) curFont = fontStack.pop(); }
      else if (op === "Tf") {
        var nm = null; for (var i = ops.length - 1; i >= 0; i--) if (ops[i].t === "name") { nm = ops[i].v; break; }
        curFont = nm ? getFont(nm) : null;
      } else if (op === "Tj" || op === "TJ" || op === "'" || op === "\"") {
        var strs = ops.filter(function (x) { return x.t === "str" || x.t === "hex"; });
        if (strs.length) addStrings(strs);
      }
      ops = [];
    });
    flushBlock();
    if (!edits.length) return { text: s, hits: 0 };
    edits.sort(function (x, y) { return y.a - x.a; });
    edits.forEach(function (e) { s = s.slice(0, e.a) + e.text + s.slice(e.b); });
    return { text: s, hits: hits };
  }

  /* drop every object that is no longer reachable (what qpdf does on save), so the removed images really leave the file */
  function collectGarbage(doc) {
    var ctx = doc.context, seen = new Set(), stack = [];
    function push(o) {
      if (o instanceof L.PDFRef) { if (seen.has(o.tag)) return; seen.add(o.tag); stack.push(ctx.lookup(o)); }
      else if (o) stack.push(o);
    }
    var ti = ctx.trailerInfo; push(ti.Root); push(ti.Info); push(ti.Encrypt);
    while (stack.length) {
      var o = stack.pop();
      if (o instanceof L.PDFDict) o.entries().forEach(function (kv) { push(kv[1]); });
      else if (o instanceof L.PDFArray) for (var i = 0; i < o.size(); i++) push(o.get(i));
      else if (o instanceof L.PDFRawStream) o.dict.entries().forEach(function (kv) { push(kv[1]); });
    }
    var dropped = 0;
    ctx.enumerateIndirectObjects().forEach(function (pair) { if (!seen.has(pair[0].tag)) { ctx.delete(pair[0]); dropped++; } });
    return dropped;
  }

  function readOpts() {
    var minS = Math.max(1, parseInt(el.clMin.value, 10) || 250), maxS = Math.max(minS, parseInt(el.clMax.value, 10) || 300);
    var phrases = (el.clTxtList.value || "").split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    return {
      minS: minS, maxS: maxS, chars: (el.clChars.value || "").split(""),
      doQr: el.clQr.checked, doName: el.clName.checked, doTxt: el.clTxt.checked,
      phrases: phrases.map(compactPhrase).filter(Boolean), rawPhrases: phrases
    };
  }

  /* Cleans ONE file. Resolves to { cancelled } | { nothing } | { out, stats }. Errors are thrown. */
  async function cleanOne(file, o, label) {
    var buf = new Uint8Array(await file.arrayBuffer());
    var doc = await L.PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    if (doc.isEncrypted) throw new Error("ENCRYPTED");
    var ctx = doc.context, pages = doc.getPages(), total = pages.length, getFont = makeFontResolver(ctx);
    var dicts = new Map(), nameBlocks = 0, doCalls = 0, textHits = 0, t0 = Date.now(), seenForms = {}, lastUi = 0, lastYield = Date.now();

    function rewrite(ref, st, text) {
      var ns = ctx.flateStream(latin1ToBytes(text));
      st.dict.entries().forEach(function (kv) { var k = kv[0].asString(); if (k !== "/Filter" && k !== "/DecodeParms" && k !== "/Length") ns.dict.set(kv[0], kv[1]); });
      ctx.assign(ref, ns);
    }
    function textPass(ref, st, res) {
      var data; try { data = L.decodePDFRawStream(st).decode(); } catch (e) { return; }
      var before = bytesToLatin1(data), r = deleteTextInStream(before, o.phrases, function (nm) { return getFont(res, nm); });
      if (r.hits) { textHits += r.hits; rewrite(ref, st, r.text); }
    }
    function walkForms(res, pageRes) {
      if (!res) return;
      var xo = res.lookup(N("XObject")); if (!(xo instanceof L.PDFDict)) return;
      xo.entries().forEach(function (kv) {
        var ref = kv[1]; if (!(ref instanceof L.PDFRef) || seenForms[ref.tag]) return;
        var ob = ctx.lookup(ref); if (!(ob instanceof L.PDFRawStream)) return;
        var sub = ob.dict.lookup(N("Subtype")); if (!(sub instanceof L.PDFName) || sub.asString() !== "/Form") return;
        seenForms[ref.tag] = 1;
        var fres = ob.dict.lookup(N("Resources")); if (!(fres instanceof L.PDFDict)) fres = pageRes;
        textPass(ref, ob, fres); walkForms(fres, pageRes);
      });
    }

    for (var p = 0; p < total; p++) {
      if (S.cancel) return { cancelled: true };
      var nowT = Date.now();
      if (nowT - lastUi > 120 || p === 0) { lastUi = nowT;
      el.clBarFill.style.width = Math.round(p / total * 100) + "%";
      el.clProg.textContent = label + "Page " + (p + 1) + " of " + total + " · " + Math.round((Date.now() - t0) / 1000) + " s"; }
      var node = pages[p].node, qrNames = [];
      var res = node.Resources(), xo = res ? res.lookup(N("XObject")) : null;
      if (o.doQr && xo instanceof L.PDFDict) {
        xo.entries().forEach(function (kv) {
          var obj = ctx.lookup(kv[1]);
          if (!(obj instanceof L.PDFRawStream)) return;
          var sub = obj.dict.lookup(N("Subtype"));
          if (!(sub instanceof L.PDFName) || sub.asString() !== "/Image") return;
          var w = num(obj.dict.lookup(N("Width"))), h = num(obj.dict.lookup(N("Height")));
          if (w === h && w >= o.minS && w <= o.maxS) {
            qrNames.push(kv[0].asString());
            if (!dicts.has(xo)) dicts.set(xo, new Map());
            dicts.get(xo).set(kv[0], true);
          }
        });
      }
      var c = node.get(N("Contents")), refs = [];
      if (c instanceof L.PDFRef) { var cobj = ctx.lookup(c); if (cobj instanceof L.PDFArray) { for (var a = 0; a < cobj.size(); a++) refs.push(cobj.get(a)); } else refs.push(c); }
      else if (c instanceof L.PDFArray) for (var b = 0; b < c.size(); b++) refs.push(c.get(b));
      for (var r = 0; r < refs.length; r++) {
        var ref = refs[r], st = ctx.lookup(ref);
        if (!(ref instanceof L.PDFRef) || !(st instanceof L.PDFRawStream)) continue;
        var original;
        try { original = L.decodePDFRawStream(st).decode(); } catch (e) { continue; }
        var text = bytesToLatin1(original), before = text;
        if (o.doName) { var rn = removeNameBlocks(text, o.chars); text = rn.text; nameBlocks += rn.removed; }
        if (qrNames.length) { var rd = removeDoCalls(text, qrNames); text = rd.text; doCalls += rd.calls; }
        if (o.doTxt && o.phrases.length) {
          var rt = deleteTextInStream(text, o.phrases, function (nm) { return getFont(res, nm); });
          if (rt.hits) { text = rt.text; textHits += rt.hits; }
        }
        if (text !== before) rewrite(ref, st, text);
      }
      if (o.doTxt && o.phrases.length) walkForms(res, res);
      if (Date.now() - lastYield > 30) { await tick(); lastYield = Date.now(); }   /* time-sliced: the UI thread is never blocked for more than ~30 ms */
    }
    var qrImages = 0;
    dicts.forEach(function (names, dict) { names.forEach(function (_, name) { if (dict.has(name)) { dict.delete(name); qrImages++; } }); });
    if (!nameBlocks && !qrImages && !textHits) return { nothing: true };
    el.clProg.textContent = label + "Saving…"; await tick();
    try { collectGarbage(doc); } catch (e) {}
    var out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
    return { out: out, stats: { pages: total, nameBlocks: nameBlocks, qr: qrImages, qrPlaces: doCalls, text: textHits } };
  }

  function outNameOf(f) { return (f.name.replace(/\.pdf$/i, "") || "book") + " - clean.pdf"; }

  function row(k, v) {
    var d = document.createElement("div"); d.className = "cl-row";
    var a = document.createElement("span"); a.textContent = k; var b = document.createElement("b"); b.textContent = v;
    d.appendChild(a); d.appendChild(b); return d;
  }

  function renderResults() {
    el.clList.innerHTML = "";
    S.results.forEach(function (r, i) {
      var card = document.createElement("div"); card.className = "cl-file " + r.state;
      var head = document.createElement("div"); head.className = "cl-fhead";
      var nm = document.createElement("div"); nm.className = "cl-fname";
      var b = document.createElement("b"); b.textContent = r.file.name;
      var chip = document.createElement("span"); chip.className = "cl-chip";
      chip.textContent = r.state === "ok" ? "Cleaned" : r.state === "none" ? "Nothing found" : r.state === "err" ? "Failed" : r.state === "run" ? "Working…" : r.state === "cancel" ? "Cancelled" : "Waiting";
      nm.appendChild(b); nm.appendChild(chip); head.appendChild(nm);
      if (r.state === "ok") {
        var sv = document.createElement("button"); sv.type = "button"; sv.className = "ico cl-one"; sv.title = "Save this PDF"; sv.setAttribute("aria-label", "Save " + r.file.name);
        sv.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>';
        sv.addEventListener("click", function () { saveOne(i); });
        head.appendChild(sv);
      }
      card.appendChild(head);
      if (r.state === "ok") {
        var st = r.stats, box = document.createElement("div"); box.className = "cl-stats";
        box.appendChild(row("Pages", st.pages));
        if (r.opts.doName) box.appendChild(row("Rotated name blocks removed", st.nameBlocks));
        if (r.opts.doQr) box.appendChild(row("QR images removed", st.qr + (st.qrPlaces > st.qr ? " (" + st.qrPlaces + " places)" : "")));
        if (r.opts.doTxt) box.appendChild(row("Custom text removed", st.text));
        box.appendChild(row("Size", fmtSize(r.file.size) + " → " + fmtSize(r.out.length)));
        card.appendChild(box);
      } else if (r.state === "err" && r.msg) {
        var em = document.createElement("div"); em.className = "cl-msg"; em.textContent = r.msg; card.appendChild(em);
      }
      el.clList.appendChild(card);
    });
    var okN = S.results.filter(function (r) { return r.state === "ok"; }).length;
    el.clResult.hidden = !S.results.length;
    el.clSave.hidden = okN === 0;
    el.clSave.textContent = okN > 1 ? "Save all (" + okN + ")" : "Save PDF";
  }

  async function runBatch(files) {
    if (S.busy || !files.length) return;
    var o = readOpts();
    if (!o.doQr && !o.doName && !o.doTxt) { setStatus("اختر ما تريد حذفه أولًا.", "err"); return; }
    if (o.doName && !o.chars.length) { setStatus("اكتب حروف الاسم المائل أو أوقف خيار حذفه.", "err"); return; }
    if (o.doTxt && !o.phrases.length) { setStatus("اكتب النص الذي تريد حذفه (كل عبارة في سطر) أو أوقف هذا الخيار.", "err"); return; }
    S.busy = true; S.cancel = false; setBusy(true);
    S.results = files.map(function (f) { return { file: f, state: "wait", opts: o, out: null, stats: null, msg: "" }; });
    renderResults(); setStatus("جارٍ فتح الملفات…");
    try {
      for (var i = 0; i < S.results.length; i++) {
        var r = S.results[i];
        if (S.cancel) { r.state = "cancel"; continue; }
        r.state = "run"; renderResults();
        var label = files.length > 1 ? "File " + (i + 1) + " of " + files.length + " · " : "";
        el.clBarFill.style.width = "0%"; el.clProg.textContent = label + "Opening PDF…";
        try {
          var res = await cleanOne(r.file, o, label);
          if (res.cancelled) r.state = "cancel";
          else if (res.nothing) r.state = "none";
          else { r.state = "ok"; r.out = res.out; r.stats = res.stats; }
        } catch (e) {
          var m = String(e && e.message || e);
          r.state = "err"; r.msg = m === "ENCRYPTED" ? "Encrypted or password-protected: can't be cleaned." : m;
        }
        renderResults(); await tick();
      }
      el.clBarFill.style.width = "100%";
      var ok = S.results.filter(function (r) { return r.state === "ok"; }).length, none = S.results.filter(function (r) { return r.state === "none"; }).length, bad = S.results.filter(function (r) { return r.state === "err"; }).length;
      if (S.cancel) setStatus("أُلغي التنظيف." + (ok ? " اكتمل " + ok + " ملف ويمكن حفظه." : ""), "err");
      else if (!ok) setStatus(bad ? "تعذّر تنظيف الملفات." : "لم يُعثر على أي شيء مطابق للحذف. الملفات لم تتغير.", "err");
      else setStatus("تم تنظيف " + ok + " من " + S.results.length + " ملف" + (none ? "، وبدون نتيجة في " + none : "") + (bad ? "، وفشل " + bad : "") + ". احفظ بزر Save.", "ok");
    } finally { setBusy(false); }
  }

  /* the size fields only matter for the QR option, the characters only for the name option, the list only for custom text */
  function setBusy(on) {
    S.busy = on; el.clProgCard.hidden = !on;
    el.clFile.disabled = on; el.clRun.disabled = on || !S.files.length;
    el.clQr.disabled = on; el.clName.disabled = on; el.clTxt.disabled = on;
    el.clMin.disabled = on || !el.clQr.checked; el.clMax.disabled = on || !el.clQr.checked;
    el.clChars.disabled = on || !el.clName.checked; el.clTxtList.disabled = on || !el.clTxt.checked;
  }

  async function saveOne(i) {
    var r = S.results[i]; if (!r || !r.out || S.saving || (window.WMNative && WMNative.isSaving())) return;
    S.saving = true; setStatus("جارٍ الحفظ…");
    try {
      var nm = outNameOf(r.file), x = await WMNative.saveParts([r.out], nm, "application/pdf");
      if (x.ok) setStatus("تم حفظ " + nm, "ok"); else if (x.cancelled) setStatus("أُلغي الحفظ.", "err"); else setStatus("تعذّر الحفظ: " + x.error, "err");
    } finally { S.saving = false; }
  }
  async function save() {
    var oks = S.results.filter(function (r) { return r.state === "ok" && r.out; });
    if (!oks.length || S.saving || (window.WMNative && WMNative.isSaving())) return;
    S.saving = true; el.clSave.disabled = true; setStatus("جارٍ الحفظ…");
    try {
      var entries = oks.map(function (r) { return { name: outNameOf(r.file), bytes: r.out }; });
      if (WMBatch && WMBatch.uniqueNames) WMBatch.uniqueNames(entries);
      var x, what;
      if (entries.length === 1) { x = await WMNative.saveParts([entries[0].bytes], entries[0].name, "application/pdf"); what = entries[0].name; }
      else if (WMBatch && WMBatch.mode() === "zip") {
        x = await WMNative.saveParts(await WMBatch.zipParts(entries), "clean_books.zip", "application/zip"); what = "clean_books.zip (" + entries.length + " ملفات)";
      } else {
        var n = 0; x = { ok: true };
        for (var i = 0; i < entries.length; i++) {
          x = await WMNative.saveParts([entries[i].bytes], entries[i].name, "application/pdf");
          if (!x.ok) break; n++;
        }
        what = n + " من " + entries.length + " ملفات PDF";
      }
      if (x.ok) setStatus("تم الحفظ: " + what, "ok"); else if (x.cancelled) setStatus("أُلغي الحفظ.", "err"); else setStatus("تعذّر الحفظ: " + x.error, "err");
    } finally { S.saving = false; el.clSave.disabled = false; }
  }

  function infoText() {
    if (!S.files.length) return "No file selected.";
    if (S.files.length === 1) return S.files[0].name + " (" + fmtSize(S.files[0].size) + ")";
    var t = 0; S.files.forEach(function (f) { t += f.size; });
    return S.files.length + " books · " + fmtSize(t);
  }

  el.clFile.addEventListener("change", function () {
    var fs = Array.prototype.slice.call(el.clFile.files || []); if (!fs.length) return;
    S.files = fs; el.clInfo.textContent = infoText(); el.clFile.value = ""; runBatch(fs);
  });
  [el.clQr, el.clName, el.clTxt].forEach(function (c) { c.addEventListener("change", function () { setBusy(S.busy); lsSet("wm2_cl_txt", el.clTxt.checked ? "1" : "0"); }); });
  var phT = 0;
  el.clTxtList.addEventListener("input", function () { clearTimeout(phT); phT = setTimeout(function () { lsSet("wm2_cl_phrases", el.clTxtList.value); }, 300); });
  el.clRun.addEventListener("click", function () { if (S.files.length && !S.busy) runBatch(S.files); });
  el.clCancel.addEventListener("click", function () { if (S.busy) { S.cancel = true; setStatus("جارٍ الإلغاء…"); } });
  el.clSave.addEventListener("click", save);

  el.clTxtList.value = lsGet("wm2_cl_phrases", "");
  el.clTxt.checked = lsGet("wm2_cl_txt", "0") === "1";
  window.WMClean = { state: S, run: runBatch, deleteText: deleteTextInStream, compact: compactPhrase };
  setBusy(false);
})();
