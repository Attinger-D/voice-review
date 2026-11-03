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
  if (!t) { t = document.createElement("div"); t.id = "toast"; }
  (document.fullscreenElement || document.body).appendChild(t);  // in full screen only the stage is on screen
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
    m.className = "mark" + (S.recFor === a.id ? " rec" : isPending(a) ? " pending" : a.approve ? " approve" : a.done ? " done" : a.comment ? "" : " empty") + (a.id === S.active ? " active" : "");
    m.style.left = (a.t / dur) * 100 + "%";
    m.textContent = a.approve ? "🛡" : n + 1;
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
      const st = S.recFor === a.id ? " · ● listening…" : isPending(a) ? " · queued for transcription…" : a.approve ? " · 🛡 rewritten: approve it" : "";
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
  recBadge();
  // safe mode's rewrites waiting for approval (2026-10-29): 🛡 n at the top opens the next one
  const p = order.filter((a) => a.approve);
  $("approvePill").hidden = !p.length;
  $("approvePill").textContent = `🛡 ${p.length} to approve`;
  $("approvePill").title = `Safe mode rewrote ${p.length} comment${p.length > 1 ? "s" : ""}: click to open the next one, then approve it or use what you said.`;
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
  approvalBox($("approveBar"), a, (how) => {
    if (how === "said") toast(`Comment #${numberOf(a.id)} now says what you said, word for word.`, 5000);
    txt.value = a.comment; changed(); render();
  });
  if (!a) {
    $("panelWhere").textContent = V.paused ? "Paused. Press Play (Space) to continue." : "Playing. Pause (Space) to comment.";
    txt.value = ""; txt.placeholder = "Pause the video and speak, or type here.";
    return;
  }
  const n = numberOf(a.id);
  $("panelWhere").textContent = listening
    ? `#${n} at ${clock(a.t)} · ● listening ${Math.round((Date.now() - S.recStart) / 1000)} s · Play (Space) to finish`
    : `#${n} at ${clock(a.t)}` + (isPending(a) ? ": queued, the text will appear by itself" : "");
  if (document.activeElement !== txt) txt.value = a.comment;
  txt.placeholder = isPending(a) ? "Your recording is queued; the text will appear here by itself." : "Type a comment…";
}
setInterval(() => { if (S.recFor) { panel(); recBadge(); } }, 1000);

// ---------- Is it listening? (version 2026-10-29c) ----------
// Daniel reviewed in full screen, paused, spoke, and nothing was recorded; in the video's own full screen the
// top bar's red 🎤 is not on screen, so nothing told him. A badge over the video says it at every moment, and
// full screen is now the whole stage (video, timeline, comment panel), so the badge and the panel stay visible.
function recBadge() {
  const b = $("recBadge"); if (!b) return;
  let cls = "", txt = "";
  if (S.recFor) {
    cls = "on"; txt = `● LISTENING, speak now · ${Math.round((Date.now() - S.recStart) / 1000)} s · Play (Space) to finish`;
  } else if (S.queuedFlash && Date.now() < S.queuedFlash) {
    cls = "queued"; txt = "✓ Comment queued; the text fills in by itself";
  } else if (V.paused && S.micStarting) {
    cls = "starting"; txt = "Starting the microphone…";
  } else if (V.paused && V.currentTime > 0) {
    cls = "off";
    txt = "⏸ Paused · NOT listening" + (V.ended ? " (end of the video)" : !$("listenOnPause").checked ? " (Listen when I pause is off, in ⚙)"
      : S.micError ? ` (microphone: ${S.micError})` : "");
  }
  b.className = cls; b.textContent = txt; b.hidden = !cls;
}
function toggleFull() {
  const st = $("stage");
  if (document.fullscreenElement) document.exitFullscreen();
  else st.requestFullscreen().catch((e) => toast("Full screen refused: " + e.message));
}
// The player's own full screen shows the bare video, without the badge: hand it over to the stage.
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === V) document.exitFullscreen().then(() => $("stage").requestFullscreen()).catch(() => {});
  document.body.classList.toggle("stageFull", document.fullscreenElement === $("stage"));
  fit();
});
V.addEventListener("dblclick", (ev) => { ev.preventDefault(); toggleFull(); });

// ---------- Room for the picture (version 2026-11-02a) ----------
// Daniel (2026-11-02): the comment box under the video took the bottom third, normal view and full screen alike,
// and the video was capped at two thirds of the height. Now the comment bar is one thin line under a landscape
// video and a column beside a portrait one (TODO item 5, 2026-10-31), and the video gets every pixel left over.
function fit() {
  const st = $("stage"), bar = $("bar"), vw = V.videoWidth, vh = V.videoHeight;
  const portrait = !!(vw && vh && vw < vh);
  st.classList.toggle("portrait", portrait);
  if (!vw || !vh) return;
  const cs = getComputedStyle(st), gap = parseFloat(cs.columnGap) || 0;
  const W = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const aw = portrait ? W - bar.offsetWidth - gap : W;
  const ah = portrait ? H : H - bar.offsetHeight - (parseFloat(cs.rowGap) || 0);
  const k = Math.max(0, Math.min(aw / vw, ah / vh));
  const w = Math.floor(vw * k) + "px", h = Math.floor(vh * k) + "px";
  if (V.style.width !== w) V.style.width = w;
  if (V.style.height !== h) V.style.height = h;
  // the bar spans the picture's width, so a comment's mark sits above the moment on the player's own scrub bar
  const bw = portrait ? "" : Math.max(Math.floor(vw * k), Math.min(W, 480)) + "px";
  if (bar.style.width !== bw) bar.style.width = bw;
  const b = $("recBadge");  // centred on the picture, not on the stage (a portrait video sits left of its bar)
  b.style.left = V.offsetLeft + V.offsetWidth / 2 + "px"; b.style.top = V.offsetTop + 6 + "px";
}
new ResizeObserver(() => requestAnimationFrame(fit)).observe($("stage"));
new ResizeObserver(() => requestAnimationFrame(fit)).observe($("bar"));
V.addEventListener("loadedmetadata", fit);

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
V.addEventListener("ended", recBadge);
V.controlsList.add("nofullscreen");  // full screen is the stage's (toggleFull), see recBadge
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
  S.micStarting = true; S.micError = ""; recBadge();
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: window.micAudio ? await window.micAudio() : { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { S.micStarting = false; S.micError = e.message; toast("Microphone unavailable: " + e.message); render(); return; }
  S.micStarting = false;
  if (S.active !== id || !V.paused) { stream.getTracks().forEach((t) => t.stop()); recBadge(); return; } // played again meanwhile
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) { chunks.push(e.data); if (window.vrStream) window.vrStream(id, e.data); } };  // pieces also stream to the app (closefile.js)
  rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); upload(new Blob(chunks, { type: "audio/webm" }), id); };
  rec.start(250);
  S.rec = rec; S.recFor = id; S.recStart = Date.now();
  changed(); render();
}
function stopDictation() {
  if (S.rec && S.rec.state !== "inactive") { S.rec.stop(); S.queuedFlash = Date.now() + 2500; setTimeout(recBadge, 2600); }
  S.rec = null; S.recFor = null; render();
}
async function upload(blob, id) {
  if (!byId(id)) { uploaded(id); return; }
  if (blob.size < MIN_BLOB) { dropIfEmpty(id); render(); uploaded(id); return; }
  S.pending.push(id); render();
  try {
    const r = await fetch(`/api/transcribe?id=${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: blob });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
  } catch (e) {
    S.pending.splice(S.pending.indexOf(id), 1); render();
    toast("Could not queue the recording: " + e.message, 8000);
  }
  uploaded(id);
}
// Close file waits for this: the clip of a recording it stopped is in the app's queue (closefile.js)
function uploaded(id) { window.dispatchEvent(new CustomEvent("vr-uploaded", { detail: id })); }
function applyResults(results) {
  let any = false;
  for (const r of results) {
    if (r.seq <= S.ack) continue;
    S.ack = r.seq;
    const a = byId(r.id); if (!a) continue;
    if (r.text) {
      a.comment = a.comment ? a.comment.replace(/\s+$/, "") + " " + r.text : r.text;
      if (r.approve) {  // safe mode rewrote it: it waits for approval, with what he said beside it
        takeRewrite(a, r.said, r.text);
        toast(`🛡 Safe mode rewrote comment #${numberOf(a.id)}. Check that it still says what you meant, then approve it.`, 9000);
      }
    } else if (!a.comment && S.active !== a.id) S.annots = S.annots.filter((x) => x !== a); // nothing was said
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
const payload = () => JSON.stringify({ ack: S.ack, annots: S.annots.map(({ id, t, comment, done, approve }) => ({ id, t, comment, done, approve })) });
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
$("approvePill").onclick = (ev) => {  // the next rewrite waiting for approval
  ev.currentTarget.blur();
  const p = ordered().filter((a) => a.approve); if (!p.length) return;
  goTo(p[(p.findIndex((a) => a.id === S.active) + 1) % p.length].id);
};
$("fullBtn").onclick = (ev) => { ev.currentTarget.blur(); toggleFull(); };
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
// Any speed from 0.5x to 1.5x (2026-10-29d: a slider on the top bar, Daniel: "add the speed of the video on the
// top bar ... maybe a slider"); the ⚙ buttons stay as presets, [ and ] step by 5 %.
function setRate(r) {
  r = Number.isFinite(r) ? Math.min(1.5, Math.max(0.5, Math.round(r * 100) / 100)) : 1;
  V.preservesPitch = true;
  V.defaultPlaybackRate = r; V.playbackRate = r;
  for (const b of $("speedBtns").children) b.classList.toggle("on", Math.abs(parseFloat(b.dataset.r) - r) < 0.001);
  if ($("speedSlider")) { $("speedSlider").value = r; $("speedVal").textContent = r.toFixed(2) + "x"; }
  $("fsSpeedVal").textContent = r.toFixed(2) + "x";
  try { localStorage.videoRate = String(r); } catch {}
}
function stepRate(d) {
  setRate(Math.round((V.playbackRate + d * 0.05) * 20) / 20);
  toast("Speed: " + rateName(V.playbackRate), 1500);
  const f = $("fsSpeed"); f.classList.add("flash"); clearTimeout(stepRate.t); stepRate.t = setTimeout(() => f.classList.remove("flash"), 1500);
}
$("speedSlider").oninput = (e) => setRate(parseFloat(e.target.value));
$("speedSlider").onchange = (e) => e.target.blur();  // back to Space = play/pause
$("speedVal").ondblclick = () => setRate(1);
$("fsSpeedVal").ondblclick = () => setRate(1);
// − and + on the top bar and in the full-screen stage (Daniel, 2026-11-02: "on the top, both in the regular and full
// screen mode, a little plus or minus for the speed of the video"); 5 % a step, like [ and ]
document.querySelectorAll("button.spd").forEach((b) => (b.onclick = (ev) => { ev.currentTarget.blur(); stepRate(+b.dataset.d); }));
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
  else if ((ev.key === "f" || ev.key === "F") && !ev.ctrlKey && !ev.altKey) { toggleFull(); ev.preventDefault(); }
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
  if (S.doc.notice) toast(S.doc.notice, 12000);  // a re-rendered video: the earlier review was set aside (2026-10-30)
  sttPill(S.doc.stt, S.doc.error);
  V.src = "/media";
  render();
  if (!localStorage.seenVideoHelp) $("help").hidden = false;
  const p = ordered().filter((a) => a.approve);
  if (p.length) toast(`🛡 Safe mode rewrote ${p.length === 1 ? "comment" : "comments"} ${p.map((a) => "#" + numberOf(a.id)).join(", ")}: `
    + "open each one to approve it, or use what you said (🛡 at the top).", 9000);
  pollQueue();
})();
