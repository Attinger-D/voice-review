// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Daniel Attinger
// Voice Review — front end of the PDF window. Coordinates in annotations are PDF points (PyMuPDF space).
"use strict";

const $ = (id) => document.getElementById(id);
const S = {
  doc: null, scale: 1, annots: [], words: {}, pageEls: [],
  popupId: null, rec: null, recFor: null, saveTimer: null, saving: false, resave: false, drag: null,
  pending: [], ack: 0, failedSeen: 0, // ids of queued clips (from the server); last transcription result applied
};
const MIN_BLOB = 1500; // bytes; shorter clips are accidental clicks

// ---------- helpers ----------
const uid = () => "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const byId = (id) => S.annots.find((a) => a.id === id);
// a Markdown comment (md.js) has no page position: its place in the text is its offset, start
const ordered = () => [...S.annots].sort((a, b) => a.page - b.page || (a.start ?? a.rects[0][1]) - (b.start ?? b.rects[0][1]) || a.rects[0][0] - b.rects[0][0]);
const numberOf = (id) => ordered().findIndex((a) => a.id === id) + 1;
const pendingOf = (a) => (a ? S.pending.filter((x) => x === a.id).length : 0);
function toast(msg, ms = 4000) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
async function getWords(p) {
  if (!S.words[p]) S.words[p] = fetch(`/api/words/${p}`).then((r) => r.json());
  return S.words[p];
}
function pdfPoint(pageEl, ev) {
  const r = pageEl.getBoundingClientRect();
  return [(ev.clientX - r.left) / S.scale, (ev.clientY - r.top) / S.scale];
}
function wordAt(words, x, y, tol = 1.5) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (x >= w[0] - tol && x <= w[2] + tol && y >= w[1] - tol && y <= w[3] + tol) return i;
  }
  return -1;
}
function nearestWord(words, x, y) {
  let best = -1, bd = 1e9;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const dx = x < w[0] ? w[0] - x : x > w[2] ? x - w[2] : 0;
    const dy = y < w[1] ? w[1] - y : y > w[3] ? y - w[3] : 0;
    const d = dx + dy * 4; // prefer the line under the cursor
    if (d < bd) { bd = d; best = i; }
  }
  return bd < 60 ? best : -1;
}
function lineRects(words, i, j) {
  const out = []; let cur = null, key = null;
  for (let k = i; k <= j; k++) {
    const w = words[k], kk = w[5] + ":" + w[6];
    if (kk !== key) { if (cur) out.push(cur); cur = w.slice(0, 4); key = kk; }
    else { cur = [Math.min(cur[0], w[0]), Math.min(cur[1], w[1]), Math.max(cur[2], w[2]), Math.max(cur[3], w[3])]; }
  }
  if (cur) out.push(cur);
  return out.map((r) => r.map((c) => Math.round(c * 100) / 100));
}
function wordsInRect(words, r) {
  return words.filter((w) => { const cx = (w[0] + w[2]) / 2, cy = (w[1] + w[3]) / 2; return cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]; })
    .map((w) => w[4]).join(" ");
}

// ---------- layout ----------
function fitScale() {
  const maxW = Math.max(...S.doc.pages.map((p) => p.w));
  return Math.min(Math.max((($("pages").clientWidth - 110) / maxW), 0.5), 2.5);
}
function buildPages() {
  const box = $("pages"); box.innerHTML = ""; S.pageEls = [];
  S.doc.pages.forEach((p, i) => {
    const el = document.createElement("div"); el.className = "page"; el.dataset.page = i;
    el.innerHTML = `<img loading="lazy" alt=""><div class="pno">${p.label || i + 1}</div><div class="layer"></div>`;
    const layer = el.querySelector(".layer");
    layer.addEventListener("mousedown", (ev) => onDown(ev, i, el));
    el.addEventListener("mouseenter", () => getWords(i), { once: true });
    box.appendChild(el); S.pageEls.push(el);
  });
  applyScale();
}
// Sharpness: each page image is rendered at z = scale × devicePixelRatio, and the page box is
// exactly that image's size in screen pixels, so one image pixel = one screen pixel (no
// resampling blur). The scale is snapped so that z has 2 decimals, as sent to the server.
// The browser's own zoom changes devicePixelRatio; watchDpr() re-renders then.
const dpr = () => window.devicePixelRatio || 1;
const zoomZ = () => Math.round(S.scale * dpr() * 100) / 100;
const px = (pt, z) => Math.ceil(pt * z - 0.001); // PyMuPDF's pixmap size for pt points at zoom z
function applyScale() {
  const d = S.dpr = dpr(), z = zoomZ();
  S.scale = z / d;
  S.doc.pages.forEach((p, i) => {
    const el = S.pageEls[i];
    el.style.width = px(p.w, z) / d + "px"; el.style.height = px(p.h, z) / d + "px";
  });
  $("zoomLabel").textContent = Math.round(S.scale * 100) + "%";
  renderAll();
  if (S.hits && S.hits.length) drawHits(); // search matches follow the zoom
  // First load at once; while zooming (wheel, repeated clicks) wait until it settles.
  clearTimeout(S.imgTimer); S.imgTimer = setTimeout(loadImages, S.pageEls[0].querySelector("img").dataset.url ? 150 : 0);
}
// Pages near the screen keep their current image until the sharper one is decoded (no flicker);
// the others just get the new URL and stay lazy.
// Each page address names the document (2026-10-19): a new PDF on a reused port must never be shown
// the previous one's pages from the browser's cache (the server also forbids caching).
const docTag = () => S.docTag || (S.docTag = [...(S.doc.src + "|" + S.doc.pages.length)]
  .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36));
function loadImages() {
  const z = zoomZ(), H = window.innerHeight;
  S.pageEls.forEach((el, i) => {
    const img = el.querySelector("img"), url = `/api/page/${i}.png?zoom=${z}&d=${docTag()}`;
    if (img.dataset.url === url) return;
    img.dataset.url = url;
    const r = el.getBoundingClientRect();
    if (!img.naturalWidth || r.bottom < -H || r.top > 2 * H) { img.src = url; return; }
    const n = new Image(); n.src = url;
    n.decode().catch(() => {}).then(() => { if (img.dataset.url === url) img.src = url; });
  });
}
function watchDpr() {
  matchMedia(`(resolution: ${dpr()}dppx)`).addEventListener("change", () => { if (S.doc) applyScale(); watchDpr(); }, { once: true });
}
window.addEventListener("resize", () => { if (S.doc && S.dpr !== dpr()) applyScale(); }); // fallback for watchDpr
function zoom(f) {
  const box = $("pages"), rel = box.scrollTop / box.scrollHeight;
  // S.raw keeps the unsnapped value, so many tiny pinch steps still add up.
  const base = S.raw && Math.abs(S.raw - S.scale) < 0.01 ? S.raw : S.scale;
  S.scale = S.raw = Math.min(Math.max(base * f, 0.4), 4);
  applyScale();
  box.scrollTop = rel * box.scrollHeight;
}

// ---------- rendering highlights ----------
// Elements are kept per annotation and updated in place: rebuilding them between the two
// clicks of a double-click would swallow the dblclick event.
const drawn = new Map(); // id -> {els, badge, scale}
function place(el, r) {
  Object.assign(el.style, { left: r[0] * S.scale + "px", top: r[1] * S.scale + "px",
    width: (r[2] - r[0]) * S.scale + "px", height: (r[3] - r[1]) * S.scale + "px" });
}
function renderAll() {
  const order = ordered(), live = new Set(order.map((a) => a.id));
  for (const [id, g] of drawn) if (!live.has(id) || g.scale !== S.scale) { g.els.forEach((e) => e.remove()); g.badge.remove(); drawn.delete(id); }
  order.forEach((a, n) => {
    let g = drawn.get(a.id);
    if (!g) {
      const layer = S.pageEls[a.page].querySelector(".layer");
      const els = a.rects.map((r) => {
        const d = document.createElement("div");
        place(d, r);
        d.addEventListener("mousedown", (ev) => ev.stopPropagation());
        d.addEventListener("click", (ev) => { ev.stopPropagation(); openPopup(a.id, false); });
        d.addEventListener("dblclick", (ev) => { ev.stopPropagation(); openPopup(a.id, true); });
        layer.appendChild(d);
        return d;
      });
      const badge = document.createElement("div");
      Object.assign(badge.style, { left: a.rects[0][0] * S.scale + "px", top: a.rects[0][1] * S.scale + "px" });
      layer.appendChild(badge);
      g = { els, badge, scale: S.scale };
      drawn.set(a.id, g);
    }
    const hide = a.done && !showDone() && a.id !== S.popupId;  // ticked Done: off the page too (2026-10-28)
    g.els.forEach((d) => {
      d.className = `hl ${a.kind}` + (a.id === S.popupId ? " active" : "") + (a.done ? " done" : "");
      d.style.display = hide ? "none" : "";
      d.title = a.comment || "(no comment yet: double-click to dictate)";
    });
    g.badge.style.display = hide ? "none" : "";
    g.badge.className = "badge" + (S.recFor === a.id ? " rec" : pendingOf(a) ? " pending" : a.flag ? " flag" : a.done ? " done" : a.comment ? "" : " empty");
    g.badge.textContent = a.flag ? `⚠ ${n + 1}` : a.done ? `✓ ${n + 1}` : n + 1;
    g.badge.title = a.flag ? "May not be courteous: open it to decide" : "";
  });
  renderList(order);
}
function renderList(order) {
  $("count").textContent = order.filter((a) => !a.done).length;
  const L = $("list");
  if (!order.length) { L.innerHTML = `<div class="empty-list">No comments yet. Drag across text to highlight it.</div>`; return; }
  L.innerHTML = "";
  L.appendChild(listHead(order, renderAll, deleteAll));
  const show = showDone();
  order.forEach((a, n) => {
    if (a.done && !show && a.id !== S.popupId) return;
    const it = document.createElement("div");
    it.className = "item" + (a.id === S.popupId ? " active" : "") + (a.done ? " done" : "");
    const status = S.recFor === a.id ? "● listening…" : pendingOf(a) ? "queued for transcription…" : a.flag ? "⚠ may not be courteous" : "";
    it.innerHTML = `<div class="meta">${whereOf(a, n + 1)} · ${a.kind === "area" ? "region" : "text"} ${status}</div>
      <div class="q"></div><div class="c${a.comment ? "" : " none"}"></div>`;
    it.querySelector(".q").textContent = a.text || (a.kind === "area" ? "[figure / region]" : "");
    it.querySelector(".c").textContent = a.comment || "(no comment)";
    it.querySelector(".meta").appendChild(doneTick(a, (on) => setDone(a, on)));
    it.addEventListener("click", () => { scrollTo(a); openPopup(a.id, false); });
    L.appendChild(it);
  });
  const hidden = order.filter((a) => a.done && !show && a.id !== S.popupId).length;
  if (hidden && hidden === order.length) L.insertAdjacentHTML("beforeend", `<div class="empty-list">All ${hidden} comments are ticked Done.</div>`);
}
function setDone(a, on) {
  a.done = on;
  if (on && S.popupId === a.id) closePopup();
  if (S.popupId === a.id) $("doneBtn").textContent = "Mark as done";
  changed(); renderAll();
  if (on && !showDone()) toast(`#${numberOf(a.id)} is done and hidden. "Show done" at the top of the list brings it back.`, 4000);
}
function deleteAll() {
  if (S.recFor) stopDictation();  // its text finds no comment and is dropped
  closePopup(); S.annots = []; changed(); renderAll();
  toast("All comments deleted.", 4000);
}
function scrollTo(a) {
  const el = S.pageEls[a.page], box = $("pages");
  box.scrollTop = el.offsetTop + a.rects[0][1] * S.scale - box.clientHeight / 3;
}

// ---------- creating highlights ----------
async function onDown(ev, p, pageEl) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  if (S.popupId) closePopup();
  // preventDefault keeps the focus in the search box: hand it back to the page (empty box: close it).
  if (document.activeElement === $("searchInput")) { if ($("searchInput").value.trim()) $("searchInput").blur(); else closeSearch(); }
  const words = await getWords(p);
  const [x, y] = pdfPoint(pageEl, ev);
  const w0 = ev.shiftKey ? -1 : wordAt(words, x, y);
  const layer = pageEl.querySelector(".layer");
  clearCopySel();
  if (S.copyMode && w0 < 0) { toast("Start the drag on a word of the text you want to copy.", 3000); return; }
  // Ctrl + drag (Cmd on a Mac) selects text to copy, without making a highlight (Daniel, 2026-10-24),
  // and so does a drag after 📋 Copy (Daniel, 2026-10-27: "you forgot the button to copy some text")
  const copy = (ev.ctrlKey || ev.metaKey || S.copyMode) && w0 >= 0;
  S.drag = { p, pageEl, layer, words, kind: w0 >= 0 ? "text" : "area", w0, w1: w0, x0: x, y0: y, x1: x, y1: y, moved: false, copy };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp, { once: true });
}
function dragResult(d) {
  if (d.kind === "text") {
    const i = Math.min(d.w0, d.w1), j = Math.max(d.w0, d.w1);
    return { rects: lineRects(d.words, i, j), text: d.words.slice(i, j + 1).map((w) => w[4]).join(" ") };
  }
  const r = [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)].map((c) => Math.round(c * 100) / 100);
  return { rects: [r], text: wordsInRect(d.words, r) };
}
function onMove(ev) {
  const d = S.drag; if (!d) return;
  const [x, y] = pdfPoint(d.pageEl, ev);
  d.x1 = x; d.y1 = y;
  if (Math.abs(x - d.x0) + Math.abs(y - d.y0) > 3) d.moved = true;
  if (d.kind === "text") { const w = nearestWord(d.words, x, y); if (w >= 0) d.w1 = w; }
  d.layer.querySelectorAll(".preview").forEach((e) => e.remove());
  if (!d.moved) return;
  for (const r of dragResult(d).rects) {
    const e = document.createElement("div"); e.className = `hl ${d.copy ? "copysel" : d.kind} preview`;
    Object.assign(e.style, { left: r[0] * S.scale + "px", top: r[1] * S.scale + "px",
      width: (r[2] - r[0]) * S.scale + "px", height: (r[3] - r[1]) * S.scale + "px" });
    d.layer.appendChild(e);
  }
}
function onUp() {
  window.removeEventListener("mousemove", onMove);
  const d = S.drag; S.drag = null; if (!d) return;
  d.layer.querySelectorAll(".preview").forEach((e) => e.remove());
  if (!d.moved) return; // a plain click never creates a highlight
  const res = dragResult(d);
  if (d.copy) {  // keep the blue selection, put its text on the clipboard; Ctrl+C copies it again
    for (const r of res.rects) {
      const e = document.createElement("div"); e.className = "hl copysel";
      Object.assign(e.style, { left: r[0] * S.scale + "px", top: r[1] * S.scale + "px",
        width: (r[2] - r[0]) * S.scale + "px", height: (r[3] - r[1]) * S.scale + "px" });
      d.layer.appendChild(e);
    }
    S.copyText = res.text; copyToClipboard(res.text); copyMode(false);
    return;
  }
  if (d.kind === "area") { const r = res.rects[0]; if (r[2] - r[0] < 6 || r[3] - r[1] < 6) return; }
  const a = { id: uid(), page: d.p, kind: d.kind, rects: res.rects, text: res.text, comment: "" };
  S.annots.push(a);
  changed();
  if ($("autoDictate").checked) openPopup(a.id, true);
  else renderAll();
}

// ---------- copying text (Ctrl + drag, Daniel 2026-10-24; the 📋 Copy button, 2026-10-27) ----------
// 📋 Copy arms one copy: the next drag across text copies it instead of highlighting. Esc or a second click disarms.
function copyMode(on) {
  S.copyMode = on;
  $("copyBtn").classList.toggle("on", on);
  document.body.classList.toggle("copying", on);
  if (on) toast("Drag across the text you want to copy.", 3000);
}
function clearCopySel() {
  document.querySelectorAll(".hl.copysel").forEach((e) => e.remove());
  S.copyText = "";
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {  // an older browser, or no permission: the hidden-textarea way
    const t = Object.assign(document.createElement("textarea"), { value: text });
    t.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(t); t.select();
    document.execCommand("copy"); t.remove();
  }
  toast("Copied. Paste it anywhere with Ctrl+V.", 2500);
}

// ---------- popup ----------
// "#3 · page 2 (iv)"; md.js names the section instead
function whereOf(a, n) {
  const pl = S.doc.pages[a.page].label;
  return `#${n} · page ${a.page + 1}${pl && pl !== String(a.page + 1) ? ` (${pl})` : ""}`;
}
function openPopup(id, dictate) {
  const a = byId(id); if (!a) return;
  if (S.popupId !== id) {
    S.popupId = id;
    $("popup").hidden = false;
    $("popupWhere").textContent = whereOf(a, numberOf(id));
    $("popupQuote").textContent = a.text || (a.kind === "area" ? "[figure / region]" : "");
    $("popupText").value = a.comment;
    placePopup(true);
  }
  $("flagBar").hidden = !a.flag;  // may not be courteous: the reviewer decides (2026-10-22)
  $("doneBtn").textContent = a.done ? "Not done" : "Mark as done";
  if (dictate) { if (S.recFor !== id) startDictation(id); }
  else if (S.recFor !== id) $("popupText").focus();
  renderAll(); micUI();
}
function closePopup() {
  if (S.recFor) stopDictation();
  $("popup").hidden = true; S.popupId = null; renderAll();
}

// ---------- moving the popup (Daniel, 2026-10-01/02: "move the comment box ... in full screen") ----------
// Drag the title bar. The box then floats (position: fixed, child of <body>, so it stays inside
// the full-screen element) and stays where it was left: the spot is remembered per mode (normal /
// full screen) as a viewport position, and the next popup opens there. Double-click the title bar
// to put it back under the highlight. Nothing here touches recording, focus or highlights.
const popKey = () => "popupPos." + (isFull() ? "fs" : "normal");
function savedPos() { try { return JSON.parse(localStorage[popKey()] || "null"); } catch { return null; } }
function clampPos(x, y) {
  const pop = $("popup"), head = pop.querySelector(".popup-head");
  const W = window.innerWidth, H = window.innerHeight, w = pop.offsetWidth, hh = head.offsetHeight + 8;
  return [Math.round(Math.min(Math.max(x, 0), Math.max(W - w, 0))), Math.round(Math.min(Math.max(y, 0), Math.max(H - hh, 0)))];
}
// Moving an element in the DOM blurs whatever is focused inside it: put focus and caret back.
function reparent(pop, parent) {
  const f = pop.contains(document.activeElement) ? document.activeElement : null;
  const sel = f && "selectionStart" in f ? [f.selectionStart, f.selectionEnd] : null;
  parent.appendChild(pop);
  if (f) { f.focus({ preventScroll: true }); if (sel) f.setSelectionRange(...sel); }
}
function floatAt(x, y) {
  const pop = $("popup");
  if (pop.parentNode !== document.body) reparent(pop, document.body);
  pop.classList.add("floating");
  [x, y] = clampPos(x, y);
  pop.style.left = x + "px"; pop.style.top = y + "px";
  return [x, y];
}
// Remembered spot if there is one, else under the highlight (scrolling it into view on opening).
function placePopup(scroll) {
  const a = byId(S.popupId); if (!a) return;
  const pos = savedPos();
  if (pos) { floatAt(pos.x, pos.y); return; }
  const pop = $("popup"), r = a.rects[a.rects.length - 1], pageEl = S.pageEls[a.page];
  pop.classList.remove("floating");
  if (pop.parentNode !== pageEl) reparent(pop, pageEl);
  const left = Math.min(Math.max(a.rects[0][0] * S.scale, 0), Math.max(pageEl.clientWidth - 430, 0));
  pop.style.left = left + "px";
  pop.style.top = r[3] * S.scale + 8 + "px";
  if (!scroll) return;
  const pr = pop.getBoundingClientRect(), box = $("pages").getBoundingClientRect();
  if (pr.bottom > box.bottom) $("pages").scrollTop += pr.bottom - box.bottom + 12;
}
(function popupDrag() {
  const head = document.querySelector("#popup .popup-head"), onBtn = (ev) => !!ev.target.closest("button");
  let d = null;
  // mousedown's default would blur the textarea and start a text selection: block it (not on ×).
  head.addEventListener("mousedown", (ev) => { ev.stopPropagation(); if (!onBtn(ev)) ev.preventDefault(); });
  head.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    if (ev.button !== 0 || onBtn(ev)) return;
    const r = $("popup").getBoundingClientRect();
    d = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, dx: ev.clientX - r.left, dy: ev.clientY - r.top, moved: false };
    head.setPointerCapture(ev.pointerId);
    head.classList.add("dragging");
  });
  head.addEventListener("pointermove", (ev) => {
    if (!d || ev.pointerId !== d.id) return;
    ev.stopPropagation();
    if (!d.moved && Math.abs(ev.clientX - d.x0) + Math.abs(ev.clientY - d.y0) < 4) return; // a click is not a move
    d.moved = true;
    floatAt(ev.clientX - d.dx, ev.clientY - d.dy);
  });
  const end = (ev) => {
    if (!d || ev.pointerId !== d.id) return;
    ev.stopPropagation();
    const moved = d.moved; d = null;
    head.classList.remove("dragging");
    if (!moved) return;
    const pop = $("popup");
    localStorage[popKey()] = JSON.stringify({ x: parseFloat(pop.style.left), y: parseFloat(pop.style.top) });
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
  head.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    if (onBtn(ev)) return;
    localStorage.removeItem(popKey());
    placePopup(true);
  });
  window.addEventListener("resize", () => {
    const pop = $("popup");
    if (!pop.hidden && pop.classList.contains("floating")) floatAt(parseFloat(pop.style.left), parseFloat(pop.style.top));
  });
})();

// ---------- dictation ----------
async function startDictation(id) {
  if (S.rec) stopDictation();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: window.micAudio ? await window.micAudio() : { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { toast("Microphone unavailable: " + e.message); return; }
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); upload(new Blob(chunks, { type: "audio/webm" }), id); };
  rec.start(250);
  S.rec = rec; S.recFor = id; S.recStart = Date.now();
  micUI(); renderAll();
}
function stopDictation() {
  if (S.rec && S.rec.state !== "inactive") S.rec.stop();
  S.rec = null; S.recFor = null; micUI(); renderAll();
}
// The clip goes into the server's queue on disk and the reviewer moves on. The text comes
// back through the ping (pollQueue) whenever the worker gets to it, even much later.
async function upload(blob, id) {
  S.stopping = false;  // Finish waited for this clip to reach the queue
  if (!byId(id) || blob.size < MIN_BLOB) { finishUI(); return; }
  S.pending.push(id); renderAll(); micUI(); finishUI();
  try {
    const r = await fetch(`/api/transcribe?id=${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: blob });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    toast(j.queued > 1 ? `Queued (${j.queued} clips waiting). Keep going; the text fills in by itself.` : "Queued. Keep going; the text fills in by itself.", 2500);
  } catch (e) {
    S.pending.splice(S.pending.indexOf(id), 1); renderAll(); micUI();
    toast("Could not queue the recording: " + e.message, 8000);
  }
}
function applyResults(results) {
  let any = false;
  for (const r of results) {
    if (r.seq <= S.ack) continue;
    S.ack = r.seq;
    const a = byId(r.id); if (!a) continue;
    if (r.recheck) {  // an earlier comment, checked after safe mode was switched on: flagged, text unchanged
      a.flag = true; any = true;
      if (S.popupId === r.id) $("flagBar").hidden = false;
      continue;
    }
    if (!r.text) continue;
    a.comment = a.comment ? a.comment.replace(/\s+$/, "") + " " + r.text : r.text;
    if (r.flag) {  // safe mode off: the check thinks it may not be courteous; the reviewer decides
      a.flag = true;
      toast(`⚠ Comment #${numberOf(a.id)} may not be courteous. Open it to rewrite it politely, or keep it as is.`, 9000);
      if (S.popupId === r.id) $("flagBar").hidden = false;
    }
    if (S.popupId === r.id) $("popupText").value = a.comment;
    any = true;
  }
  if (any) changed();
}
async function pollQueue() {
  try {
    const j = await (await fetch(`/api/ping?since=${S.ack}`, { method: "POST" })).json();
    S.pending = j.pending; applyResults(j.results); recheckUI(j.recheck);
    if (j.failed.length > S.failedSeen) {
      const f = j.failed[j.failed.length - 1]; S.failedSeen = j.failed.length;
      toast(`A recording for comment #${numberOf(f.id)} could not be transcribed (${f.error}). The audio is kept in %LOCALAPPDATA%\VoiceReview\failed.`, 15000);
    } sttPill(j.stt, j.error); renderAll(); micUI();
    if (j.settings) S.doc.settings = j.settings;
    finishUI();
  } catch { setStatus("App server stopped: reopen the PDF", "error"); }
  setTimeout(pollQueue, S.pending.length || S.recheckLeft || S.finishing ? 2000 : 5000);
}
function micUI() {
  const recording = S.recFor && S.recFor === S.popupId, a = byId(S.popupId), pending = !!pendingOf(a);
  $("micBtn").classList.toggle("recording", !!recording);
  $("micBtn").textContent = recording ? "■ Stop" : "● Dictate";
  // not while it is being dictated or transcribed: "Done" there read as "I am done speaking" (Daniel, 2026-10-28)
  $("doneBtn").hidden = !!recording || pending;
  $("micStatus").textContent = recording ? "Listening… (Ctrl+Enter to stop)" + (pending ? " · earlier clip still queued" : "")
    : pending ? "⏳ Queued for transcription: the text will appear here by itself" : "";
  $("micStatus").classList.toggle("pending", pending && !recording);
  $("popupText").classList.toggle("pending", pending);
  $("popupText").placeholder = pending ? "Your recording is queued; the text will appear here by itself." : "Type here, or press Dictate and speak…";
  busyUI();
}
// Safe mode switched on with comments already written (Daniel, 2026-10-28): the server checks them one by
// one and flags the doubtful ones; nothing is rewritten. Say when it is done, and how many were flagged.
function recheckUI(r, quiet) {
  if (!r) return;
  const left = r.left || 0;
  if (quiet && !left) S.recheckRun = r.run;  // a run finished before this window opened: nothing to announce
  if (!left && r.run !== S.recheckRun) {
    // Daniel's test, 2026-10-28: a comment flagged before safe mode was switched on was skipped by the check,
    // so "all are fine" was wrong. Count every flagged comment, and put the first one in front of him now,
    // with Rewrite politely / Keep as is, rather than at closing time (the browser's close box cannot say why).
    S.recheckRun = r.run;
    if (!showFlags() && r.checked) toast(`Safe mode checked your ${r.checked} earlier comments: all are fine.`, 6000);
  }
  S.recheckLeft = left;
}
// Undecided flagged comments are put in front of the reviewer when safe mode is switched on and when the PDF
// opens (Daniel, 2026-10-28: he reopened a PDF with one and saw no sign of it): the first one opens with
// Rewrite politely / Keep as is, and a toast names them all.
function showFlags() {
  const f = flagUI();
  if (!f.length) return false;
  if (S.finishing) return true;  // the Finish box already lists them
  toast(`⚠ ${f.length === 1 ? "Comment" : "Comments"} ${f.map((a) => "#" + numberOf(a.id)).join(", ")} may not be courteous: `
    + "rewrite politely, or keep as is." + (f.length > 1 ? " ⚠ at the top opens the next one." : ""), 9000);
  if (!S.popupId) { scrollTo(f[0]); openPopup(f[0].id, false); }
  return true;
}
// ⚠ n at the top: the undecided flagged comments; each click opens the next one.
function flagUI() {
  const f = ordered().filter((a) => a.flag);  // Done ones too: they are still in the PDF that gets sent
  for (const id of ["flagPill", "fsFlag"]) {
    $(id).hidden = !f.length;
    $(id).textContent = `⚠ ${f.length}`;
    $(id).title = `${f.length} comment${f.length > 1 ? "s" : ""} may not be courteous: click to open the next one, then rewrite it or keep it.`;
  }
  return f;
}
function nextFlag() {
  const f = flagUI(); if (!f.length) return;
  const i = f.findIndex((a) => a.id === S.popupId), a = f[(i + 1) % f.length];
  scrollTo(a); openPopup(a.id, false);
}
function busyUI() {
  const n = S.pending.length, r = S.recheckLeft || 0;
  flagUI();
  $("busy").hidden = !n && !r;
  $("busy").textContent = n ? `⏳ ${n} left` : `⏳ checking ${r}`;
  $("busy").title = n ? `${n} recording${n > 1 ? "s" : ""} still being transcribed; the text fills in by itself. Wait until this goes before you send the PDF.`
    : `Safe mode is checking your earlier comments: ${r} to go. Doubtful ones get a ⚠; none is changed.`;
  // the end of the queue is the moment to say where the file is (Daniel, 2026-10-27: "maybe only at the end")
  if (S.lastPending && !n && S.doc) toast(`All comments are transcribed and saved in ${S.doc.out.split(/[\\/]/).pop()}`, 6000);
  S.lastPending = n;
  // also in the taskbar: not finished = not ready to send (2026-10-21)
  if (S.doc) document.title = (n ? `⏳ ${n} left · ` : "") + S.doc.name + " · voice review";
  $("fsStatus").textContent = n ? `⏳ ${n} left` : $("status").textContent;
  $("fsStatus").classList.toggle("busy", !!n);
  $("fsbar").classList.toggle("busy", !!n || !!S.recFor);
}
setInterval(() => { if (S.recFor && S.recFor === S.popupId) $("micStatus").textContent = `Listening… ${Math.round((Date.now() - S.recStart) / 1000)}s (Ctrl+Enter to stop)`; }, 1000);

// ---------- full screen ----------
// The page is scaled to the screen height; the previous zoom comes back on exit.
// Enter and exit are separate: the Exit button can only ever leave full screen. The layout
// follows document.fullscreenElement, and S.fs makes each switch happen once.
const isFull = () => !!document.fullscreenElement || !!S.fs;
function enterFull() {
  if (document.activeElement) document.activeElement.blur(); // Space must not re-click a button
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch((e) => toast("Full screen refused: " + e.message));
}
function exitFull() {
  if (document.activeElement) document.activeElement.blur();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => fsLayout(false));
  else fsLayout(false); // out of sync (browser already left): just restore the normal view
}
const toggleFull = () => (isFull() ? exitFull() : enterFull());
function fsLayout(on) {
  if (on === !!S.fs) return;
  S.fs = on;
  const box = $("pages");
  const cur = S.pageEls.findIndex((el) => el.offsetTop + el.offsetHeight > box.scrollTop + 10);
  document.body.classList.toggle("fs", on);
  $("fsbar").hidden = !on;
  requestAnimationFrame(() => {
    if (on) {
      S.prevScale = S.scale;
      const maxH = Math.max(...S.doc.pages.map((p) => p.h));
      S.scale = Math.min(Math.max(box.clientHeight / maxH, 0.4), 4);
    } else if (S.prevScale) { S.scale = S.prevScale; S.prevScale = null; }
    applyScale();
    if (cur >= 0) box.scrollTop = S.pageEls[cur].offsetTop;
    if (S.popupId) placePopup(false); // the other mode has its own remembered spot
    busyUI();
  });
}
document.addEventListener("fullscreenchange", () => fsLayout(!!document.fullscreenElement));
// In the fit layout the page follows the window's height when the window is moved or resized.
let refitTimer = null;
window.addEventListener("resize", () => {
  if (!S.fs || !S.doc || S.doc.type === "md") return;  // Markdown: the text reflows by itself
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    const box = $("pages"), maxH = Math.max(...S.doc.pages.map((p) => p.h));
    const cur = S.pageEls.findIndex((el) => el.offsetTop + el.offsetHeight > box.scrollTop + 10);
    S.scale = Math.min(Math.max(box.clientHeight / maxH, 0.4), 4);
    applyScale();
    if (cur >= 0) box.scrollTop = S.pageEls[cur].offsetTop;
  }, 150);
});
function pageStep(dir) {
  const box = $("pages"), tops = S.pageEls.map((el) => el.offsetTop);
  const i = tops.findIndex((t) => t > box.scrollTop + 5);
  const cur = i < 0 ? tops.length - 1 : Math.max(i - 1, 0);
  const onTop = Math.abs(tops[cur] - box.scrollTop) < 5;
  const target = dir > 0 ? Math.min(cur + 1, tops.length - 1) : onTop ? Math.max(cur - 1, 0) : cur;
  box.scrollTop = tops[target];
}

// ---------- search (Daniel, 2026-10-14: "add a search box ... only appears when needed") ----------
// The pages are images, so the browser's own Ctrl+F finds nothing: search the PDF's words instead.
// Hyphens are ignored on both sides, so a word split across a line ("contra- dicted") and a
// hyphenated query both match. Matches are drawn in each page's layer with pointer-events off,
// so highlighting and clicking highlights work as before.
S.hits = []; S.hitCur = -1; S.sidx = {}; S.searchSeq = 0; S.lastQuery = "";
const normText = (s) => s.normalize("NFKC").toLowerCase()
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[-­‐-―−]/g, "");
async function pageIndex(p) {
  if (S.sidx[p]) return S.sidx[p];
  const words = await getWords(p);
  let str = "", map = [];
  words.forEach((w, k) => {
    const prev = words[k - 1];
    const lineBreakHyphen = prev && /[-­‐‑]$/.test(prev[4]) && (prev[5] !== w[5] || prev[6] !== w[6]);
    if (k && !lineBreakHyphen) { str += " "; map.push(-1); }
    for (const ch of normText(w[4])) { str += ch; map.push(k); }
  });
  return (S.sidx[p] = { words, str, map });
}
async function runSearch(q) {
  const seq = ++S.searchSeq, qn = normText(q).replace(/\s+/g, " ").trim();
  S.lastQuery = q;
  if (qn.length < 2) { setHits([], -1); $("searchCount").textContent = ""; return; }
  $("searchCount").textContent = "…";
  const idx = await Promise.all(S.doc.pages.map((_, p) => pageIndex(p)));
  if (seq !== S.searchSeq) return; // a newer query is running
  const hits = [];
  idx.forEach(({ words, str, map }, p) => {
    for (let s = str.indexOf(qn); s >= 0; s = str.indexOf(qn, s + 1)) {
      let i = s, j = s + qn.length - 1;
      while (map[i] < 0) i++;
      while (map[j] < 0) j--;
      hits.push({ p, rects: lineRects(words, map[i], map[j]) });
    }
  });
  // Start at the first match on or after the page being read.
  const box = $("pages"), here = Math.max(S.pageEls.findIndex((el) => el.offsetTop + el.offsetHeight > box.scrollTop + 10), 0);
  const first = hits.findIndex((h) => h.p >= here);
  setHits(hits, hits.length ? (first < 0 ? 0 : first) : -1);
}
function setHits(hits, cur) {
  S.hits = hits; S.hitCur = cur;
  drawHits();
  if (cur >= 0) showHit();
  countUI();
}
function countUI() {
  const c = $("searchCount"), n = S.hits.length;
  c.textContent = n ? `${S.hitCur + 1} / ${n}` : S.lastQuery.trim().length >= 2 ? "no match" : "";
  c.classList.toggle("none", !n && S.lastQuery.trim().length >= 2);
}
function drawHits() {
  document.querySelectorAll(".hit").forEach((e) => e.remove());
  S.hits.slice(0, 3000).forEach((h, k) => {
    const layer = S.pageEls[h.p].querySelector(".layer");
    for (const r of h.rects) {
      const d = document.createElement("div");
      d.className = "hit" + (k === S.hitCur ? " cur" : ""); d.dataset.hit = k;
      place(d, r);
      layer.appendChild(d);
    }
  });
}
function showHit() {
  document.querySelectorAll(".hit.cur").forEach((e) => e.classList.remove("cur"));
  document.querySelectorAll(`.hit[data-hit="${S.hitCur}"]`).forEach((e) => e.classList.add("cur"));
  const h = S.hits[S.hitCur], box = $("pages");
  box.scrollTop = S.pageEls[h.p].offsetTop + h.rects[0][1] * S.scale - box.clientHeight / 3;
  countUI();
}
function stepHit(dir) {
  if (!S.hits.length) return;
  S.hitCur = (S.hitCur + dir + S.hits.length) % S.hits.length;
  showHit();
}
function openSearch() {
  $("searchbar").hidden = false;
  $("searchInput").focus(); $("searchInput").select();
}
function closeSearch() {
  $("searchbar").hidden = true;
  S.searchSeq++; S.lastQuery = ""; $("searchInput").value = "";
  setHits([], -1);
  if (document.activeElement) document.activeElement.blur(); // keys go back to reading (F, Page Down…)
}
(function searchWiring() {
  const inp = $("searchInput");
  let t = null;
  inp.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => runSearch(inp.value), 250); });
  inp.addEventListener("keydown", async (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault(); ev.stopPropagation();
      if (inp.value !== S.lastQuery) { clearTimeout(t); await runSearch(inp.value); }
      else stepHit(ev.shiftKey ? -1 : 1);
    } else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeSearch(); }
  });
  // Nothing typed and the focus goes back to the page: the bar has no reason to stay.
  inp.addEventListener("blur", (ev) => {
    if (!inp.value.trim() && !$("searchbar").contains(ev.relatedTarget)) setTimeout(() => { if (!inp.value.trim() && document.activeElement !== inp) closeSearch(); }, 150);
  });
  $("searchPrev").onclick = () => stepHit(-1);
  $("searchNext").onclick = () => stepHit(1);
  $("searchClose").onclick = closeSearch;
  $("searchBtn").onclick = () => ($("searchbar").hidden ? openSearch() : closeSearch());
  $("searchbar").addEventListener("mousedown", (ev) => { if (ev.target.tagName === "BUTTON") ev.preventDefault(); }); // keep the caret in the box
})();

// ---------- saving ----------
// The top bar shows only a mark (Daniel, 2026-10-27: the file name and "Comments save to ..." took the bar):
// ✓ saved, ● about to save, the words only when something is wrong. The full text is the tooltip.
function setStatus(txt, cls = "") {
  const s = $("status");
  s.textContent = cls === "error" ? "⚠ " + txt : cls === "dirty" ? "●" : "✓";
  s.title = txt + (cls === "error" ? "" : "\n(click to save now)"); s.className = cls; busyUI();
}
function changed() {
  setStatus("Unsaved changes…", "dirty");
  clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 1000);
}
const payload = () => JSON.stringify({ ack: S.ack, annots: S.annots.map(({ id, page, kind, rects, text, comment, author, signed, flag, done, subject, color, start, end }) => ({ id, page, kind, rects, text, comment, author, signed, flag, done, subject, color, start, end })) });
async function save() {
  clearTimeout(S.saveTimer);
  if (S.saving) { S.resave = true; return; }
  S.saving = true;
  try {
    const r = await fetch("/api/annotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    setStatus(`Saved at ${j.saved_at} in ${j.out}`);
  } catch (e) { setStatus("NOT SAVED: " + e.message, "error"); }
  finally { S.saving = false; if (S.resave) { S.resave = false; save(); } }
}

// ---------- wiring ----------
$("popupText").addEventListener("input", () => { const a = byId(S.popupId); if (a) { a.comment = $("popupText").value; changed(); renderAll(); } });
$("popupClose").onclick = closePopup;
$("micBtn").onclick = () => (S.recFor === S.popupId ? stopDictation() : startDictation(S.popupId));
$("doneBtn").onclick = () => { const a = byId(S.popupId); if (a) setDone(a, !a.done); };
$("deleteBtn").onclick = () => {
  const id = S.popupId; // a recording still in flight is discarded: upload() finds no annotation
  closePopup(); S.annots = S.annots.filter((a) => a.id !== id); changed(); renderAll();
};
$("popup").addEventListener("mousedown", (ev) => ev.stopPropagation());
$("zoomIn").onclick = () => zoom(1.2);
$("zoomOut").onclick = () => zoom(1 / 1.2);
$("toggleList").onclick = () => $("list").classList.toggle("hidden");
$("copyBtn").onclick = () => { copyMode(!S.copyMode); $("copyBtn").blur(); };
$("helpBtn").onclick = () => ($("help").hidden = !$("help").hidden);
$("helpClose").onclick = () => { $("help").hidden = true; localStorage.seenHelp = 1; };
$("status").onclick = save;
// On unless he turned it off (Daniel, 2026-10-21: on by default, set in the gear panel). Stored with the other
// settings on the server since 2026-10-28 (the browser's memory is per port, so it differed between windows);
// init() sets the boxes from it.
$("autoDictate").checked = $("fsAutoDictate").checked = true;
for (const id of ["autoDictate", "fsAutoDictate"]) {
  $(id).onchange = () => {
    const on = $(id).checked;
    $("autoDictate").checked = $("fsAutoDictate").checked = on;
    fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auto_dictate: on }) });
  };
}
$("fullBtn").onclick = toggleFull;
$("fsExit").onclick = exitFull;
$("fsHelp").onclick = () => { $("help").hidden = !$("help").hidden; $("fsHelp").blur(); };  // help in full screen too (2026-10-27)
// ?duo=left|right (Daniel, 2026-10-19): this document is one half of a full-screen window holding two
// (duo.html). "Comments" opens this document's comment list in the OTHER half; again, the other PDF
// comes back. The page never moves. The fit layout cannot be left from inside a half.
const DUO = new URLSearchParams(location.search).get("duo");
function duoList(show) {
  $("list").classList.toggle("hidden", !show);
  document.body.classList.toggle("listopen", show);      // the bar stays over this document's pages
  $("fsList").textContent = show ? "Hide comments" : "Comments";
  if (window.parent !== window) window.parent.postMessage({ duoList: show, side: DUO }, "*");
}
if (DUO) {
  document.body.classList.add("duo", "duo-" + DUO);
  $("fsExit").hidden = true;
  $("list").classList.add("hidden");
  window.addEventListener("message", (ev) => { if (ev.data && ev.data.duoClose) duoList(false); });
}
$("fsSearch").onclick = () => openSearch();
$("flagPill").onclick = $("fsFlag").onclick = (ev) => { nextFlag(); ev.currentTarget.blur(); };
// A flagged comment (Daniel, 2026-10-22): rewrite it politely on request, or keep it; either way the flag goes.
async function rewriteOne(a) {  // the popup's button, and the Finish box's
  try {
    const r = await fetch("/api/polish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: a.comment }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    a.comment = j.text; a.flag = false;
    if (S.popupId === a.id) { $("popupText").value = a.comment; $("flagBar").hidden = true; }
    changed(); renderAll();
    return true;
  } catch (e) { toast("Could not rewrite: " + e.message, 8000); return false; }
}
$("flagRewrite").onclick = async () => {
  const a = byId(S.popupId); if (!a) return;
  a.comment = $("popupText").value;
  $("flagRewrite").disabled = true; $("flagRewrite").textContent = "Rewriting…";
  await rewriteOne(a);
  $("flagRewrite").disabled = false; $("flagRewrite").textContent = "Rewrite politely";
};

// ---------- Finish (Daniel, 2026-10-28) ----------
// "When you click close, it should say we close when all comments are transcribed, and show the ones that are
// not courteous before closing, so the reviewer can rewrite them politely, one or all, or turn on safe mode."
// A page cannot put its own box on the window's X (only the browser's "Leave site?"), so this is a button.
// The box stays open and is redrawn by every ping until nothing is left, then the window saves and closes.
function finish() {
  if (S.recFor) {  // its clip joins the queue a moment later (upload): count it as unfinished until then
    S.stopping = true; stopDictation();
    setTimeout(() => { S.stopping = false; finishUI(); }, 3000);  // in case the recorder never delivers
  }
  closePopup();
  S.finishing = true; finishUI();
}
function finishUI() {
  if (!S.finishing) return;
  const box = $("finishBox"), n = S.pending.length + (S.recFor || S.stopping ? 1 : 0), f = flagUI();
  box.hidden = false;
  const list = $("finishList");
  if (n) {
    $("finishTitle").textContent = "Finishing…";
    $("finishMsg").textContent = `${n} comment${n > 1 ? "s are" : " is"} still being transcribed. This box moves on by itself when ${n > 1 ? "they are" : "it is"} done.`;
    list.innerHTML = ""; $("finishAll").hidden = $("finishSafe").hidden = true;
    $("finishClose").textContent = "Close now (they finish in the background)";
    return;
  }
  if (!f.length) {  // nothing left: save, then close
    $("finishTitle").textContent = "All comments are saved."; $("finishMsg").textContent = ""; list.innerHTML = "";
    $("finishAll").hidden = $("finishSafe").hidden = true;
    closeNow();
    return;
  }
  $("finishTitle").textContent = `Before you close: ${f.length} comment${f.length > 1 ? "s" : ""} may not be courteous`;
  $("finishMsg").textContent = "Rewrite each one politely, keep it as you said it, or show it in the document to edit it yourself.";
  $("finishAll").hidden = f.length < 2; $("finishAll").textContent = `Rewrite all ${f.length} politely`;
  $("finishSafe").hidden = !!(S.doc.settings && S.doc.settings.safe) || S.doc.safe_available === false;
  $("finishClose").textContent = "Close anyway";
  if (S.finishBusy) return;  // a rewrite is running: do not redraw under it
  list.innerHTML = "";
  for (const a of f) {
    const row = document.createElement("div"); row.className = "finishRow";
    row.innerHTML = `<div class="fr-text"><b>#${numberOf(a.id)}</b> <span></span></div>
      <div class="fr-btns"><button data-do="rewrite">Rewrite politely</button><button data-do="keep">Keep as is</button><button data-do="show">Show</button></div>`;
    row.querySelector("span").textContent = a.comment;
    row.onclick = async (ev) => {
      const b = ev.target.closest("button"); if (!b) return;
      if (b.dataset.do === "show") { S.finishing = false; $("finishBox").hidden = true; scrollTo(a); openPopup(a.id, false); return; }
      if (b.dataset.do === "keep") { a.flag = false; changed(); renderAll(); finishUI(); return; }
      S.finishBusy = true; b.disabled = true; b.textContent = "Rewriting…";
      await rewriteOne(a);
      S.finishBusy = false; finishUI();
    };
    list.appendChild(row);
  }
}
async function closeNow() {
  S.finishing = false; S.closing = true;
  await save();
  window.close();  // refused for an --app window, so the server asks the window to close (WM_CLOSE)
  try { await fetch("/api/close-window", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: document.title }) }); } catch { /* closing */ }
  setTimeout(() => { $("finishBox").hidden = false; $("finishTitle").textContent = "All comments are saved. You can close this window."; }, 1500);
}
$("finishBtn").onclick = $("fsFinish").onclick = (ev) => { ev.currentTarget.blur(); finish(); };
$("finishBack").onclick = () => { S.finishing = false; $("finishBox").hidden = true; };
$("finishClose").onclick = closeNow;
$("finishAll").onclick = async () => {
  const f = flagUI(); S.finishBusy = true; $("finishAll").disabled = true;
  for (let i = 0; i < f.length; i++) { $("finishAll").textContent = `Rewriting ${i + 1} of ${f.length}…`; await rewriteOne(f[i]); }
  S.finishBusy = false; $("finishAll").disabled = false; finishUI();
};
$("finishSafe").onclick = async () => {
  await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ safe: true }) });
  if (S.doc.settings) S.doc.settings.safe = true;
  toast("Safe mode ON: what you say from now on is rewritten politely. The comments listed here are not changed: rewrite or keep each one.", 7000);
  finishUI();
};
$("flagKeep").onclick = () => { const a = byId(S.popupId); if (!a) return; a.flag = false; $("flagBar").hidden = true; changed(); renderAll(); };  // the magnifier in full screen too (Daniel, 2026-10-22)
$("fsList").onclick = () => (DUO ? duoList($("list").classList.contains("hidden")) : $("list").classList.toggle("hidden"));
document.addEventListener("keydown", (ev) => {
  const typing = ["TEXTAREA", "INPUT"].includes(document.activeElement && document.activeElement.tagName);
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === "c" || ev.key === "C") && S.copyText && !typing) { copyToClipboard(S.copyText); ev.preventDefault(); }
  else if (ev.ctrlKey && !ev.altKey && (ev.key === "f" || ev.key === "F")) { openSearch(); ev.preventDefault(); }
  else if ((ev.key === "F3" || (ev.ctrlKey && (ev.key === "g" || ev.key === "G"))) && !$("searchbar").hidden) { stepHit(ev.shiftKey ? -1 : 1); ev.preventDefault(); }
  else if (ev.key === "Escape" && !$("searchbar").hidden && !S.popupId) { closeSearch(); ev.preventDefault(); }
  else if (!typing && !DUO && !ev.ctrlKey && !ev.altKey && (ev.key === "f" || ev.key === "F")) { toggleFull(); ev.preventDefault(); }
  else if (!typing && isFull() && (ev.key === "PageDown" || ev.key === "PageUp" || ev.key === " ")) {
    pageStep(ev.key === "PageUp" || (ev.key === " " && ev.shiftKey) ? -1 : 1); ev.preventDefault();
  }
  else if (ev.key === "Escape" && S.finishing) { $("finishBack").click(); ev.preventDefault(); }
  else if (ev.key === "Escape" && S.popupId) { closePopup(); ev.preventDefault(); }
  else if (ev.key === "Escape" && S.copyMode) { copyMode(false); ev.preventDefault(); }
  else if (ev.key === "Escape" && DUO && !$("list").classList.contains("hidden")) { duoList(false); ev.preventDefault(); }
  else if (ev.key === "Escape" && isFull() && !DUO) { exitFull(); ev.preventDefault(); }
  else if (ev.key === "0" && ev.ctrlKey) { zoom(fitScale() / S.scale); ev.preventDefault(); }
  else if (ev.key === "Enter" && ev.ctrlKey && S.recFor) { stopDictation(); ev.preventDefault(); }
  else if (ev.key === "s" && ev.ctrlKey) { save(); ev.preventDefault(); }
  else if ((ev.key === "+" || ev.key === "=") && ev.ctrlKey) { zoom(1.2); ev.preventDefault(); }
  else if (ev.key === "-" && ev.ctrlKey) { zoom(1 / 1.2); ev.preventDefault(); }
});
// Ctrl+wheel and touchpad pinch zoom the pages (sharp re-render), not the whole browser page.
window.addEventListener("wheel", (ev) => {
  if (!ev.ctrlKey || !S.doc) return;
  ev.preventDefault(); zoom(Math.exp(-Math.max(Math.min(ev.deltaY, 300), -300) * 0.0015));
}, { passive: false });
window.addEventListener("beforeunload", (ev) => {
  // The window's X with something unfinished: a page can only show the browser's "Leave site?" box, so the Finish
  // box is opened behind it, for when he presses Cancel (Daniel, 2026-10-28). Finish itself never asks this.
  if (S.closing) return;
  if (S.recFor || S.pending.length || flagUI().length) {
    finish();
    ev.preventDefault(); ev.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  navigator.sendBeacon("/api/annotations", new Blob([payload()], { type: "application/json" }));
  navigator.sendBeacon("/api/bye");
});
function sttPill(s, err) { S.stt = s; S.sttErr = err; if (window.micPill) window.micPill(); }  // the 🎤 is drawn by settings.js

(async function init() {
  S.doc = await (await fetch("/api/doc")).json();
  document.title = S.doc.name + " · voice review";
  $("title").textContent = S.doc.name;
  $("title").title = S.doc.src;
  S.annots = S.doc.annots;
  setStatus(`Comments save to ${S.doc.out}`);
  S.ack = S.doc.seq; S.pending = S.doc.pending; S.failedSeen = S.doc.failed.length; recheckUI(S.doc.recheck, true);
  $("autoDictate").checked = $("fsAutoDictate").checked = S.doc.settings.auto_dictate !== false;
  sttPill(S.doc.stt, S.doc.error);
  S.scale = fitScale();
  buildPages(); watchDpr();
  // ?fit=1 (Daniel, 2026-10-19, two documents side by side): the full-screen layout - no header,
  // the page at the window's full height - inside a normal window, so two windows can share the screen.
  const fit = new URLSearchParams(location.search).has("fit");
  if (fit) fsLayout(true);
  if (!localStorage.seenHelp && !fit) $("help").hidden = false;
  else if (!fit) requestAnimationFrame(() => showFlags());  // after the pages are laid out, so it scrolls right
  pollQueue();
})();
