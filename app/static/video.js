// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Daniel Attinger
// Video voice review — front end. The microphone is on only while the video is paused:
// pausing creates a comment at that moment and starts listening; Play stops and queues it.
"use strict";

const $ = (id) => document.getElementById(id);
const V = $("video");
const S = {
  doc: null, annots: [], active: null, rec: null, recFor: null, recStart: 0,
  pending: [], ack: 0, failedSeen: 0, silent: false, saveTimer: null, saving: false, resave: false,
};
const MIN_BLOB = 1500; // bytes; shorter clips are a pause with nothing said

const uid = () => "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const byId = (id) => S.annots.find((a) => a.id === id);
const ordered = () => [...S.annots].sort((a, b) => a.t - b.t);
const numberOf = (id) => ordered().findIndex((a) => a.id === id) + 1;
const isPending = (a) => a && S.pending.includes(a.id);
function clock(t) {
  t = Math.round(t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
function toast(msg, ms = 4000) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- rendering ----------
function render() {
  const order = ordered(), show = showDone();
  const seen = (a) => !a.done || show || a.id === S.active;  // ticked Done: hidden unless "Show done" (2026-10-28)
  $("count").textContent = order.filter((a) => !a.done).length;
  // timeline markers
  const tl = $("timeline"), dur = V.duration || 0;
  tl.innerHTML = '<div id="playhead"></div>';
  if (dur) order.forEach((a, n) => {
    if (!seen(a)) return;
    const m = document.createElement("div");
    m.className = "mark" + (S.recFor === a.id ? " rec" : isPending(a) ? " pending" : a.done ? " done" : a.comment ? "" : " empty") + (a.id === S.active ? " active" : "");
    m.style.left = (a.t / dur) * 100 + "%";
    m.textContent = n + 1;
    m.title = `${clock(a.t)}  ${a.comment || ""}`;
    m.onclick = () => goTo(a.id);
    tl.appendChild(m);
  });
  playhead();
  // list
  const L = $("list");
  if (!order.length) { L.innerHTML = `<div class="empty-list">No comments yet. Pause the video and speak.</div>`; }
  else {
    L.innerHTML = "";
    L.appendChild(listHead(order, render, deleteAll));
    order.forEach((a, n) => {
      if (!seen(a)) return;
      const it = document.createElement("div");
      it.className = "item" + (a.id === S.active ? " active" : "") + (a.done ? " done" : "");
      const st = S.recFor === a.id ? " · ● listening…" : isPending(a) ? " · queued for transcription…" : "";
      it.innerHTML = `<div class="meta">#${n + 1}${st}</div><div class="c"><span class="t"></span><span class="txt"></span></div>`;
      it.querySelector(".t").textContent = clock(a.t);
      it.querySelector(".txt").textContent = a.comment || (isPending(a) || S.recFor === a.id ? "" : "(no comment)");
      it.querySelector(".meta").appendChild(doneTick(a, (on) => setDone(a, on)));
      it.onclick = () => goTo(a.id);
      L.appendChild(it);
    });
    if (!order.some(seen)) L.insertAdjacentHTML("beforeend", `<div class="empty-list">All ${order.length} comments are ticked Done.</div>`);
  }
  panel();
}
function playhead() {
  const ph = $("playhead");
  if (ph && V.duration) ph.style.left = (V.currentTime / V.duration) * 100 + "%";
}
function panel() {
  const a = byId(S.active), head = $("panelHead"), txt = $("panelText");
  const listening = S.recFor && S.recFor === S.active;
  head.classList.toggle("listening", !!listening);
  $("stopBtn").hidden = !listening;
  $("deleteBtn").hidden = !a;
  // not while it is being dictated or transcribed: "Done" there read as "I am done speaking" (Daniel, 2026-10-28)
  $("doneBtn").hidden = !a || !!listening || isPending(a);
  $("doneBtn").textContent = a && a.done ? "Not done" : "Mark as done";
  txt.disabled = !a;
  txt.classList.toggle("pending", isPending(a));
  if (!a) {
    $("panelWhere").textContent = V.paused ? "Paused. Press Play (Space) to continue." : "Playing. Pause (Space) to comment.";
    txt.value = ""; txt.placeholder = "Pause the video and speak, or type here.";
    return;
  }
  const n = numberOf(a.id);
  $("panelWhere").textContent = listening
    ? `● Listening at ${clock(a.t)}, ${Math.round((Date.now() - S.recStart) / 1000)}s. Press Play (Space) to continue.`
    : `#${n} at ${clock(a.t)}` + (isPending(a) ? ": queued, the text will appear by itself" : "");
  if (document.activeElement !== txt) txt.value = a.comment;
  txt.placeholder = isPending(a) ? "Your recording is queued; the text will appear here by itself." : "Type a comment…";
}
setInterval(() => { if (S.recFor) panel(); }, 1000);

// ---------- pause = listen, play = stop ----------
V.addEventListener("pause", () => {
  if (S.silent) { S.silent = false; return; }       // paused by a jump to a comment
  if (V.ended || !$("listenOnPause").checked) { render(); return; }
  const a = { id: uid(), t: Math.round(V.currentTime * 100) / 100, comment: "" };
  S.annots.push(a); S.active = a.id;
  startDictation(a.id);
});
V.addEventListener("play", () => {
  // A recorded comment is kept until its transcription says nothing was said (applyResults).
  if (S.recFor) stopDictation(); else dropIfEmpty(S.active);
  S.active = null; render();
});
V.addEventListener("timeupdate", playhead);
V.addEventListener("loadedmetadata", render);

function dropIfEmpty(id) {
  const a = byId(id);
  if (a && !a.comment && !isPending(a) && S.recFor !== id) { S.annots = S.annots.filter((x) => x !== a); changed(); }
}
function goTo(id) {
  const a = byId(id); if (!a) return;
  if (S.recFor) stopDictation(); else if (S.active !== id) dropIfEmpty(S.active);
  if (!V.paused) { S.silent = true; V.pause(); }
  V.currentTime = a.t;
  S.active = id; render();
}

async function startDictation(id) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: window.micAudio ? await window.micAudio() : { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { toast("Microphone unavailable: " + e.message); render(); return; }
  if (S.active !== id || !V.paused) { stream.getTracks().forEach((t) => t.stop()); return; } // played again meanwhile
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); upload(new Blob(chunks, { type: "audio/webm" }), id); };
  rec.start(250);
  S.rec = rec; S.recFor = id; S.recStart = Date.now();
  changed(); render();
}
function stopDictation() {
  if (S.rec && S.rec.state !== "inactive") S.rec.stop();
  S.rec = null; S.recFor = null; render();
}
async function upload(blob, id) {
  if (!byId(id)) return;
  if (blob.size < MIN_BLOB) { dropIfEmpty(id); render(); return; }
  S.pending.push(id); render();
  try {
    const r = await fetch(`/api/transcribe?id=${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: blob });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
  } catch (e) {
    S.pending.splice(S.pending.indexOf(id), 1); render();
    toast("Could not queue the recording: " + e.message, 8000);
  }
}
function applyResults(results) {
  let any = false;
  for (const r of results) {
    if (r.seq <= S.ack) continue;
    S.ack = r.seq;
    const a = byId(r.id); if (!a) continue;
    if (r.text) a.comment = a.comment ? a.comment.replace(/\s+$/, "") + " " + r.text : r.text;
    else if (!a.comment && S.active !== a.id) S.annots = S.annots.filter((x) => x !== a); // nothing was said
    any = true;
  }
  if (any) changed();
}
async function pollQueue() {
  try {
    const j = await (await fetch(`/api/ping?since=${S.ack}`, { method: "POST" })).json();
    S.pending = j.pending; applyResults(j.results); sttPill(j.stt, j.error);
    if (j.failed.length > S.failedSeen) {
      const f = j.failed[j.failed.length - 1]; S.failedSeen = j.failed.length;
      toast(`A recording for comment #${numberOf(f.id)} could not be transcribed (${f.error}). The audio is kept in %LOCALAPPDATA%\\VoiceReview\\failed.`, 15000);
    }
    const n = S.pending.length;
    $("busy").hidden = !n; $("busy").textContent = `⏳ ${n} left`;
    $("busy").title = `${n} recording${n > 1 ? "s" : ""} still being transcribed; the text fills in by itself.`;
    render();
  } catch { setStatus("App server stopped: reopen the video", "error"); }
  setTimeout(pollQueue, S.pending.length ? 2000 : 5000);
}
function sttPill(s, err) { S.stt = s; S.sttErr = err; if (window.micPill) window.micPill(); }  // the 🎤 is drawn by settings.js

// ---------- saving ----------
// Only a mark on the top bar (Daniel, 2026-10-27), as in the PDF window: ✓ saved, ● about to save, words on error.
function setStatus(txt, cls = "") {
  const s = $("status");
  s.textContent = cls === "error" ? "⚠ " + txt : cls === "dirty" ? "●" : "✓";
  s.title = txt + (cls === "error" ? "" : "\n(click to save now)"); s.className = cls;
}
function changed() {
  setStatus("Unsaved changes…", "dirty");
  clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 1000);
}
const payload = () => JSON.stringify({ ack: S.ack, annots: S.annots.map(({ id, t, comment, done }) => ({ id, t, comment, done })) });
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
$("panelText").addEventListener("input", () => { const a = byId(S.active); if (a) { a.comment = $("panelText").value; changed(); render(); } });
$("stopBtn").onclick = stopDictation;
$("deleteBtn").onclick = () => {
  const id = S.active; if (S.recFor === id) stopDictation(); // upload() finds no comment and drops the clip
  S.annots = S.annots.filter((a) => a.id !== id); S.active = null; changed(); render();
};
function setDone(a, on) {
  a.done = on;
  if (on && S.active === a.id) S.active = null;
  changed(); render();
  if (on && !showDone()) toast(`#${numberOf(a.id)} is done and hidden. "Show done" at the top of the list brings it back.`, 4000);
}
function deleteAll() {
  if (S.recFor) stopDictation();  // its text finds no comment and is dropped
  S.annots = []; S.active = null; changed(); render();
  toast("All comments deleted.", 4000);
}
$("doneBtn").onclick = () => { const a = byId(S.active); if (a) setDone(a, !a.done); };
$("toggleList").onclick = () => $("list").classList.toggle("hidden");
$("helpBtn").onclick = () => ($("help").hidden = !$("help").hidden);
$("helpClose").onclick = () => { $("help").hidden = true; localStorage.seenVideoHelp = 1; };
$("status").onclick = save;
// On by default, kept with the other settings on the server (2026-10-28: the browser's memory is per port)
$("listenOnPause").checked = true;
$("listenOnPause").onchange = () => fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ listen_on_pause: $("listenOnPause").checked }) });
// Playback speed (Daniel, 2026-10-27): 7 / 10 / 20 % slower or faster, voice pitch kept, remembered.
// The buttons sit in the ⚙ panel (settings.js moves them there; 2026-10-27, no Advanced row any more).
const RATES = [0.8, 0.9, 0.93, 1, 1.07, 1.1, 1.2];
const rateName = (r) => r === 1 ? "Normal" : (r > 1 ? "+" : "−") + Math.round(Math.abs(r - 1) * 100) + "%";
window.speedTag = () => V.playbackRate === 1 ? "" : rateName(V.playbackRate);
function setRate(r) {
  r = RATES.includes(r) ? r : 1;
  V.preservesPitch = true;
  V.defaultPlaybackRate = r; V.playbackRate = r;
  for (const b of $("speedBtns").children) b.classList.toggle("on", parseFloat(b.dataset.r) === r);
  localStorage.videoRate = String(r);
}
function stepRate(d) {
  const i = RATES.indexOf(V.playbackRate);
  const j = Math.max(0, Math.min(RATES.length - 1, (i < 0 ? RATES.indexOf(1) : i) + d));
  setRate(RATES[j]);
  toast("Speed: " + rateName(RATES[j]), 1500);
}
$("speedBtns").onclick = (e) => { const b = e.target.closest("button"); if (b) { setRate(parseFloat(b.dataset.r)); b.blur(); } };
V.addEventListener("loadedmetadata", () => setRate(parseFloat(localStorage.videoRate || "1")));
setRate(parseFloat(localStorage.videoRate || "1"));
document.addEventListener("keydown", (ev) => {
  const typing = document.activeElement && ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName) && !document.activeElement.disabled;
  if (typing) {
    if (ev.key === "Escape") document.activeElement.blur();
    return;
  }
  if (ev.key === " " || ev.key === "k") { V.paused ? V.play() : V.pause(); ev.preventDefault(); }
  else if (ev.key === "ArrowLeft") { V.currentTime = Math.max(0, V.currentTime - 5); ev.preventDefault(); }
  else if (ev.key === "ArrowRight") { V.currentTime = Math.min(V.duration || 0, V.currentTime + 5); ev.preventDefault(); }
  else if (ev.key === "Enter" && ev.ctrlKey && S.recFor) { stopDictation(); ev.preventDefault(); }
  else if (ev.key === "s" && ev.ctrlKey) { save(); ev.preventDefault(); }
  else if (ev.key === "[") { stepRate(-1); ev.preventDefault(); }
  else if (ev.key === "]") { stepRate(+1); ev.preventDefault(); }
});
// The native player grabs Space when it has focus; keep focus off it.
V.addEventListener("focus", () => V.blur());
window.addEventListener("beforeunload", (ev) => { if (S.recFor) { ev.preventDefault(); ev.returnValue = ""; } });
window.addEventListener("pagehide", () => {
  if (S.recFor) stopDictation();
  navigator.sendBeacon("/api/annotations", new Blob([payload()], { type: "application/json" }));
  navigator.sendBeacon("/api/bye");
});

(async function init() {
  S.doc = await (await fetch("/api/doc")).json();
  $("listenOnPause").checked = S.doc.settings.listen_on_pause !== false;
  document.title = S.doc.name + " · voice review";
  $("title").textContent = S.doc.name;
  $("title").title = S.doc.src;
  S.annots = S.doc.annots;
  S.ack = S.doc.seq; S.pending = S.doc.pending; S.failedSeen = S.doc.failed.length;
  setStatus(`Comments save to ${S.doc.out}`);
  sttPill(S.doc.stt, S.doc.error);
  V.src = "/media";
  render();
  if (!localStorage.seenVideoHelp) $("help").hidden = false;
  pollQueue();
})();
