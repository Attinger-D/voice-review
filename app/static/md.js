// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Daniel Attinger
// Voice Review: the Markdown window (Daniel, 2026-10-29: "accept markdown files as inputs and outputs").
// Loaded after app.js and settings.js, it replaces the PDF's page images with the rendered Markdown and its word
// boxes with the browser's own text selection; dictation, the queue, flags, Done and Finish are app.js's.
// A comment is a span of the Markdown source, a.start..a.end; the server writes it into the file as CriticMarkup.
// The rendered text and the source are matched on their letters and digits only: everything else (**, links'
// addresses, list numbers) may differ between the two, letters and digits do not.
"use strict";
(function () {
  const isAl = (c) => /[\p{L}\p{N}]/u.test(c);
  let body = null, paper = null;
  const drawn = new Map(); // id -> {segs, badge}

  // ---------- source side ----------
  let lineStarts = null;
  function lineAt(n) {
    if (!lineStarts) { lineStarts = [0]; const md = S.doc.md; for (let i = 0; i < md.length; i++) if (md[i] === "\n") lineStarts.push(i + 1); }
    return n < lineStarts.length ? lineStarts[n] : S.doc.md.length;
  }
  const blockSpan = (el) => [lineAt(+el.dataset.line), lineAt(+el.dataset.end)];
  // Parts of the source that never show as text: hidden before letters are counted.
  const HIDE = [
    [/<!--[\s\S]*?-->/g, null], [/!\[[^\]\n]*\]\([^)\n]*\)/g, null], [/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/g, null],
    [/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, null], [/^[ \t]*(?:```|~~~)[^\n]*$/gm, null],
    [/^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/gm, null],
    [/\[([^\]\n]*)\]\(([^)\n]*)\)/g, "link"], [/<(https?:\/\/[^>\s]+)>/g, "auto"],
  ];
  function srcLetters(bs, be) {
    const src = S.doc.md.slice(bs, be), hide = new Uint8Array(src.length);
    for (const [re, how] of HIDE) {
      for (const m of src.matchAll(re)) {
        const i = m.index, n = m[0].length;
        if (how === "link") { hide[i] = 1; hide.fill(1, i + 1 + m[1].length, i + n); }
        else if (how === "auto") { hide[i] = 1; hide[i + n - 1] = 1; }
        else hide.fill(1, i, i + n);
      }
    }
    const pos = []; let str = "";
    for (let i = 0; i < src.length; i++) if (!hide[i] && isAl(src[i])) { str += src[i]; pos.push(bs + i); }
    return { str, pos };
  }
  // the images of the source, in order, outside fenced code (the k-th <img> on screen is the k-th here)
  function srcImages() {
    const md = S.doc.md, fences = [], out = [];
    for (const m of md.matchAll(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[^\n]*$/gm)) fences.push([m.index, m.index + m[0].length]);
    for (const m of md.matchAll(/!\[[^\]\n]*\]\([^)\n]*\)|<img\b[^>]*>/gi))
      if (!fences.some(([a, b]) => m.index >= a && m.index < b)) out.push([m.index, m.index + m[0].length, m[0]]);
    return out;
  }

  // ---------- screen side ----------
  function domLetters(el) {  // letters and digits shown in el, each with its text node and offset; badges skipped
    const nodes = []; let str = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => (n.parentElement.closest(".mdbadge") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.data;
      for (let i = 0; i < t.length; i++) if (isAl(t[i])) { str += t[i]; nodes.push([n, i]); }
    }
    return { str, nodes };
  }
  function nearest(hay, needle, k) {
    let best = -1, bd = Infinity;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) { const d = Math.abs(i - k); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  const elOf = (n) => (n.nodeType === 1 ? n : n.parentElement);
  function rangeText(r) {
    const f = r.cloneContents(); f.querySelectorAll(".mdbadge").forEach((b) => b.remove());
    return f.textContent;
  }

  // ---------- a selection becomes a comment ----------
  function fromSelection(r) {
    const startEl = elOf(r.startContainer);
    const block = startEl.closest("[data-line]");
    if (!block || !body.contains(block)) return null;
    const cell = startEl.closest("td,th"), lim = cell && block.contains(cell) ? cell : block;
    let clamped = false;
    if (!lim.contains(r.endContainer)) { r.setEnd(lim, lim.childNodes.length); clamped = true; }
    const d = domLetters(block);
    let i0 = -1, i1 = -1;
    d.nodes.forEach(([n, o], k) => { if (r.comparePoint(n, o) === 0) { if (i0 < 0) i0 = k; i1 = k; } });
    if (i0 < 0) return null;
    const A = d.str.slice(i0, i1 + 1), [bs, be] = blockSpan(block), sl = srcLetters(bs, be);
    const j = nearest(sl.str, A, i0);
    if (j < 0) { toast("These words could not be found in the Markdown source. Try a shorter selection.", 6000); return null; }
    const md = S.doc.md, txt = rangeText(r);
    let s = sl.pos[j], e = sl.pos[j + A.length - 1] + 1;
    // punctuation selected around the words, when the source has it there too ("quoted", the final period)
    const lead = (txt.match(/^[^\p{L}\p{N}]*/u) || [""])[0].trim(), tail = (txt.match(/[^\p{L}\p{N}]*$/u) || [""])[0].trim();
    if (lead && md.slice(s - lead.length, s) === lead) s -= lead.length;
    if (tail && md.slice(e, e + tail.length) === tail) e += tail.length;
    [s, e] = balance(md, s, e);
    if (clamped) toast("A highlight stays within one paragraph (or one table cell): it ends here.", 4000);
    return { start: s, end: e, text: txt.replace(/\s+/g, " ").trim() };
  }
  // Whole **bold**, `code` or [link](...) runs are taken in with their marks, so the file stays valid Markdown.
  function balance(md, s, e) {
    while (s > 0 && md[s - 1] === md[e] && "*_~`".includes(md[e])) { s--; e++; }
    const ls = md.lastIndexOf("\n", s - 1) + 1, le = (md.indexOf("\n", e) + 1 || md.length + 1) - 1;
    if ((md.slice(ls, s).match(/`/g) || []).length % 2) {  // inside a code span: the whole span
      let a = md.lastIndexOf("`", s - 1), b = md.indexOf("`", e);
      if (a >= ls && b >= 0 && b < le) { while (md[a - 1] === "`") a--; while (md[b + 1] === "`") b++; s = a; e = b + 1; }
    }
    if (md[s - 1] === "[" && md.slice(e, e + 2) === "](") { const c = md.indexOf(")", e); if (c > 0 && c < le) { s--; e = c + 1; } }
    return [s, e];
  }
  function fromImage(img) {
    const k = [...body.querySelectorAll("img")].indexOf(img), im = srcImages()[k];
    if (!im) return null;
    return { start: im[0], end: im[1], text: "[picture: " + (img.getAttribute("alt") || decodeURIComponent(img.src.split("/").pop())) + "]" };
  }
  function add(where, kind) {
    const a = { id: uid(), page: 0, kind, rects: [[0, 0, 0, 0]], start: where.start, end: where.end, text: where.text, comment: "" };
    S.annots.push(a);
    S.justMade = Date.now();
    changed();
    if ($("autoDictate").checked) openPopup(a.id, true);
    else renderAll();
  }

  // ---------- drawing the comments ----------
  function blockFor(pos, point) {
    let best = null, bl = Infinity;
    for (const el of body.querySelectorAll("[data-line]")) {
      const [bs, be] = blockSpan(el);
      if (bs <= pos && (pos < be || (point && pos === be))) { if (be - bs <= bl) { bl = be - bs; best = el; } }
    }
    return best;
  }
  function wrap(r, a) {  // the range's text, as one span per text node
    const segs = [], w = document.createTreeWalker(r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    const list = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) if (r.intersectsNode(n) && !n.parentElement.closest(".mdbadge")) list.push(n);
    for (let n of list) {
      const s0 = n === r.startContainer ? r.startOffset : 0, e0 = n === r.endContainer ? r.endOffset : n.data.length;
      if (e0 <= s0 || !n.data.slice(s0, e0).trim() && list.length > 1) continue;
      if (s0 > 0) n = n.splitText(s0);
      if (e0 - s0 < n.data.length) n.splitText(e0 - s0);
      const sp = document.createElement("span"); sp.className = "mdhl";
      n.parentNode.insertBefore(sp, n); sp.appendChild(n);
      sp.addEventListener("click", (ev) => { if (Date.now() - (S.justMade || 0) < 400 || String(getSelection())) return; ev.stopPropagation(); openPopup(a.id, false); });
      sp.addEventListener("dblclick", (ev) => { ev.stopPropagation(); getSelection().removeAllRanges(); openPopup(a.id, true); });
      segs.push(sp);
    }
    return segs;
  }
  function badgeFor(a) {
    const b = document.createElement("sup"); b.className = "mdbadge";
    b.addEventListener("mousedown", (ev) => { ev.stopPropagation(); ev.preventDefault(); });
    b.addEventListener("click", (ev) => { ev.stopPropagation(); openPopup(a.id, false); });
    b.addEventListener("dblclick", (ev) => { ev.stopPropagation(); openPopup(a.id, true); });
    return b;
  }
  function placeOne(a, imgs, srcImgs) {
    if (a.kind === "area") {
      const k = srcImgs.findIndex((m) => m[0] === a.start), img = imgs[k];
      if (!img) return null;
      const b = badgeFor(a); img.parentNode.insertBefore(b, img);
      img.addEventListener("dblclick", (ev) => { ev.stopPropagation(); openPopup(a.id, true); });
      return { segs: [img], badge: b, img: true };
    }
    const point = a.end <= a.start, block = blockFor(a.start, point);
    if (!block) return null;
    const [bs, be] = blockSpan(block), sl = srcLetters(bs, be);
    const k0 = sl.pos.filter((p) => p < a.start).length, k1 = sl.pos.filter((p) => p < a.end).length;
    const A = sl.str.slice(k0, k1), d = domLetters(block);
    const b = badgeFor(a);
    if (!A) {  // a comment with no words highlighted: just its number, where it sits in the text
      const at = d.nodes[k0];
      if (at) { const t = at[0].splitText(at[1]); t.parentNode.insertBefore(b, t); }
      else block.appendChild(b);
      return { segs: [], badge: b };
    }
    const j = nearest(d.str, A, k0);
    if (j < 0) return null;
    const r = document.createRange(), [n0, o0] = d.nodes[j], [n1, o1] = d.nodes[j + A.length - 1];
    r.setStart(n0, o0); r.setEnd(n1, o1 + 1);
    const segs = wrap(r, a);
    if (segs[0]) segs[0].parentNode.insertBefore(b, segs[0]);
    return { segs, badge: b };
  }
  function paint(order) {
    body.innerHTML = S.doc.html;
    drawn.clear();
    const imgs = [...body.querySelectorAll("img")], srcImgs = srcImages();
    // Chrome selects no words in a link, even made undraggable: a link is shown as link-coloured text instead,
    // and Shift + click still opens it
    body.querySelectorAll("a[href]").forEach((l) => {
      const t = document.createElement("span"); t.className = "mdlink"; t.dataset.href = l.getAttribute("href");
      t.title = l.getAttribute("href") + "  (Shift + click opens it)"; t.append(...l.childNodes); l.replaceWith(t);
    });
    imgs.forEach((img) => { img.draggable = false; });
    // later comments first: wrapping never splits a text node an earlier comment still has to find
    for (const a of [...order].reverse()) { const g = placeOne(a, imgs, srcImgs); if (g) drawn.set(a.id, g); }
    if (S.lastQuery) setTimeout(() => runSearch(S.lastQuery), 0);
  }

  window.renderAll = function () {
    if (!body) return;
    const order = ordered(), key = order.map((a) => `${a.id}:${a.start}:${a.end}`).join("|");
    if (key !== S.mdKey) { S.mdKey = key; paint(order); }
    order.forEach((a, n) => {
      const g = drawn.get(a.id); if (!g) return;
      const hide = a.done && !showDone() && a.id !== S.popupId;
      for (const el of g.segs) {
        el.classList.toggle(g.img ? "mdarea" : "mdhl", !hide);
        el.classList.toggle("active", a.id === S.popupId);
        el.classList.toggle("done", !!a.done);
        el.title = hide ? "" : a.comment || "(no comment yet: double-click to dictate)";
      }
      g.badge.style.display = hide ? "none" : "";
      g.badge.className = "mdbadge" + (S.recFor === a.id ? " rec" : pendingOf(a) ? " pending" : a.flag ? " flag" : a.done ? " done" : a.comment ? "" : " empty");
      g.badge.textContent = a.flag ? `⚠ ${n + 1}` : a.done ? `✓ ${n + 1}` : n + 1;
      g.badge.title = a.flag ? "May not be courteous: open it to decide" : a.comment || "";
    });
    renderList(order);
  };

  // "#3 · 2. The job on the key": the section the comment is in
  window.whereOf = function (a, n) {
    let h = "";
    for (const m of S.doc.md.slice(0, a.start + 1).matchAll(/^#{1,6}[ \t]+(.+)$/gm)) h = m[1];
    h = h.replace(/[*_`]/g, "").trim();
    return `#${n}` + (h ? ` · ${h.length > 48 ? h.slice(0, 47) + "…" : h}` : "");
  };
  window.scrollTo = function (a) {
    const g = drawn.get(a.id), el = g && (g.segs[0] || g.badge);
    if (!el) return;
    const box = $("pages"), r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
    box.scrollTop += r.top - br.top - box.clientHeight / 3;
  };
  window.placePopup = function (scroll) {
    const a = byId(S.popupId); if (!a) return;
    const pos = savedPos();
    if (pos) { floatAt(pos.x, pos.y); return; }
    const g = drawn.get(a.id), pop = $("popup");
    pop.classList.remove("floating");
    if (pop.parentNode !== paper) reparent(pop, paper);
    const els = g ? (g.segs.length ? g.segs : [g.badge]) : [];
    const pr = paper.getBoundingClientRect();
    const first = els[0] ? els[0].getBoundingClientRect() : pr, last = els.length ? els[els.length - 1].getBoundingClientRect() : pr;
    pop.style.left = Math.min(Math.max(first.left - pr.left, 0), Math.max(paper.clientWidth - 430, 0)) + "px";
    pop.style.top = last.bottom - pr.top + 8 + "px";
    if (!scroll) return;
    const r = pop.getBoundingClientRect(), box = $("pages").getBoundingClientRect();
    if (r.bottom > box.bottom) $("pages").scrollTop += r.bottom - box.bottom + 12;
  };

  // ---------- layout: one page of text; zoom is the font size ----------
  window.fitScale = function () { try { return +localStorage.mdScale || 1; } catch { return 1; } };
  window.applyScale = function () {
    S.scale = Math.min(Math.max(S.scale, 0.5), 3);
    if (paper) paper.style.fontSize = 16 * S.scale + "px";
    $("zoomLabel").textContent = Math.round(S.scale * 100) + "%";
    try { localStorage.mdScale = S.scale; } catch { /* private window */ }
    if (S.popupId) placePopup(false);
  };
  window.buildPages = function () {
    const box = $("pages"); box.innerHTML = "";
    box.classList.add("mdpages");
    paper = document.createElement("article"); paper.className = "mdpaper";
    body = document.createElement("div"); body.className = "markdown-body";
    paper.appendChild(body); box.appendChild(paper);
    applyScale();
    S.mdKey = null; renderAll();
    body.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (S.popupId && !ev.target.closest(".mdhl, .mdbadge")) closePopup();
      if (document.activeElement === $("searchInput")) { if ($("searchInput").value.trim()) $("searchInput").blur(); else closeSearch(); }
      S.down = [ev.clientX, ev.clientY];
    });
    body.addEventListener("mouseup", (ev) => {
      if (ev.button !== 0) return;
      const sel = getSelection(), moved = S.down && Math.abs(ev.clientX - S.down[0]) + Math.abs(ev.clientY - S.down[1]) > 3;
      S.down = null;
      setTimeout(() => {  // let the browser finish the selection
        if (!sel.rangeCount || sel.isCollapsed) {
          const img = ev.target.closest && ev.target.closest("img");
          if (img && !moved && !S.copyMode) {
            const g = [...drawn.entries()].find(([, v]) => v.img && v.segs[0] === img);
            if (g) openPopup(g[0], false);
            else { const w = fromImage(img); if (w) add(w, "area"); }
          }
          return;
        }
        const r = sel.getRangeAt(0);
        if (!body.contains(r.commonAncestorContainer)) return;
        if (ev.ctrlKey || ev.metaKey || S.copyMode) {  // copy, no highlight (the selection stays blue)
          S.copyText = rangeText(r); copyToClipboard(S.copyText); copyMode(false); return;
        }
        const w = fromSelection(r);
        sel.removeAllRanges();
        if (w && w.end > w.start) add(w, "text");
      }, 0);
    });
    body.addEventListener("click", (ev) => {  // a link must not take the window away from the review
      const l = ev.target.closest(".mdlink"); if (!l || !ev.shiftKey || String(getSelection())) return;
      const href = l.dataset.href;
      if (href.startsWith("#")) { const t = document.getElementById(href.slice(1)); if (t) t.scrollIntoView(); return; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) window.open(href, "_blank", "noopener");
      else toast(`Link to ${href}: open it from its folder.`, 4000);
    });
  };
  window.fsLayout = function (on) {
    if (on === !!S.fs) return;
    S.fs = on;
    document.body.classList.toggle("fs", on);
    $("fsbar").hidden = !on;
    requestAnimationFrame(() => { if (S.popupId) placePopup(false); busyUI(); });
  };
  window.pageStep = function (dir) { const box = $("pages"); box.scrollTop += dir * box.clientHeight * 0.9; };

  // ---------- search: the text's own letters (the browser's highlight API, nothing inserted) ----------
  window.runSearch = async function (q) {
    const seq = ++S.searchSeq, qn = normText(q).replace(/\s+/g, " ").trim();
    S.lastQuery = q;
    if (qn.length < 2) { setHits([], -1); $("searchCount").textContent = ""; return; }
    let str = "", map = [];
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => (n.parentElement.closest(".mdbadge") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      for (let i = 0; i < n.data.length; i++) {
        let c = normText(n.data[i]);
        if (/\s/.test(n.data[i])) { if (str.endsWith(" ")) continue; c = " "; }
        for (const ch of c) { str += ch; map.push([n, i]); }
      }
    }
    if (seq !== S.searchSeq) return;
    const hits = [];
    for (let s = str.indexOf(qn); s >= 0; s = str.indexOf(qn, s + 1)) {
      const r = document.createRange(), [a, ao] = map[s], [b, bo] = map[s + qn.length - 1];
      r.setStart(a, ao); r.setEnd(b, bo + 1); hits.push({ range: r });
    }
    const top = $("pages").getBoundingClientRect().top;
    const first = hits.findIndex((h) => h.range.getBoundingClientRect().top >= top);
    setHits(hits, hits.length ? (first < 0 ? 0 : first) : -1);
  };
  const HL = window.CSS && CSS.highlights;
  window.drawHits = function () {
    if (!HL) return;
    HL.set("vrhit", new Highlight(...S.hits.slice(0, 3000).map((h) => h.range)));
    HL.delete("vrcur");
  };
  window.showHit = function () {
    const h = S.hits[S.hitCur]; if (!h) return;
    if (HL) HL.set("vrcur", new Highlight(h.range));
    const box = $("pages"), r = h.range.getBoundingClientRect(), br = box.getBoundingClientRect();
    box.scrollTop += r.top - br.top - box.clientHeight / 3;
    countUI();
  };

  window.mdTest = { fromSelection, srcLetters, domLetters, blockSpan };  // for the automated tests

  // ---------- words in the panels ----------
  const help = $("help").querySelector("ul");
  help.innerHTML = `
    <li><b>Select words</b> with the mouse to highlight them (yellow). <b>Click a picture</b> to comment on it (orange frame).</li>
    <li>Comments are written <b>into the Markdown</b>, in a copy named <i>name</i>_review.md (or the file itself, if you
      chose it in <b>⚙</b>), as <code>{==highlighted words==}{&gt;&gt;your comment&lt;&lt;}</code>: plain text that any editor
      shows, so anyone can read your comments, answer them and update the file. In VS Code, Markdown Preview Enhanced
      shows them as highlights when its "Enable Critic Markup Syntax" setting is on.</li>
    <li><b>📋 Copy</b>, then select, or <b>Ctrl + select</b> at any time, to <b>copy</b> words without making a highlight.</li>
    <li><b>Prefer to type, or need to fix a word?</b> Click the highlight and type in its box. Typed text is saved as it is.</li>
    <li><b>Double-click a highlight</b> (or its number) and speak. Click <b>Stop</b>, press <b>Ctrl+Enter</b>, or close the box to finish. The text fills in by itself later.</li>
    <li>Links do not open by a click (it would leave the review): <b>Shift + click</b> opens one.</li>
    <li><b>Drag the comment box by its title bar</b> to see the text underneath, even while you speak. <b>Double-click the title bar</b> to put it back under the highlight.</li>
    <li><b>Ctrl+F</b> (or <b>🔍</b>) searches the text. <b>Zoom</b> with − / + or Ctrl + mouse wheel: the text gets bigger and reflows.</li>
    <li><b>⛶ Full screen</b> (or <b>F</b>); <b>Page Down / Page Up</b> scroll a screen at a time; <b>Esc</b> or <b>F</b> to leave.</li>
    <li><b>Before you send the file</b>, wait until nothing is queued (the window title shows "⏳ 3 left" until then); <b>✓ Finish</b> waits for you. An unfinished comment says in the file itself that it is still being transcribed.</li>
    <li><b>⚙ Settings</b>: languages, microphone, safe mode and its rules, your initials, and where comments are saved.</li>
    <li>Speech is transcribed on this computer. Nothing is sent to the cloud.</li>`;
  const sp = $("savePdf");
  if (sp) {
    sp.querySelector("b").textContent = "Save Markdown comments";
    const labs = sp.querySelectorAll("label");
    const relabel = (lab, html) => { const i = lab.querySelector("input"); lab.innerHTML = html; lab.prepend(i); };
    relabel(labs[0], " in a copy, <i>name</i>_review.md; the original stays untouched");
    relabel(labs[1], " in the Markdown file itself");
  }
  $("autoDictate").parentElement.title = "Start listening as soon as you finish a selection";
})();
