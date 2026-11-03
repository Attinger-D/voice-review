// Close file, open another, in the same window (version 2026-10-29b). Loaded by the PDF, Markdown and video windows,
// after app.js / video.js and settings.js; uses their globals S, stopDictation, save, closePopup.
// Daniel: "add the possibility to close the file without closing the app. I don't want to have multiple files
// open, but make sure at least we can close the file without having to reopen the app when we want to handle a
// different file."
// Also here: a recording streams its pieces to the app while it runs, so closing the window in the middle of a
// comment keeps what was said (his 9th comment on hungry_fly_status_20261029_v2.mp4 was lost that way).
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const embedded = params.has("duo") || params.has("fit");  // two documents side by side: no Close file there

  // ---------- streaming the recording ----------
  const VR = { n: {}, buf: {}, timer: null };
  window.vrStream = (id, blob) => {
    (VR.buf[id] = VR.buf[id] || []).push(blob);
    if (!VR.timer) VR.timer = setInterval(() => flush(false), 1000);
  };
  function flush(beacon) {
    for (const id of Object.keys(VR.buf)) {
      const parts = VR.buf[id];
      if (!parts.length) continue;
      VR.buf[id] = [];
      const n = VR.n[id] = (VR.n[id] === undefined ? 0 : VR.n[id] + 1);
      const body = new Blob(parts, { type: "audio/webm" });
      const url = `/api/chunk?id=${encodeURIComponent(id)}&n=${n}`;
      if (beacon) navigator.sendBeacon(url, body);
      else fetch(url, { method: "POST", body, keepalive: body.size < 60000 }).catch(() => {});
    }
  }
  window.addEventListener("pagehide", () => flush(true));

  if (embedded) return;

  // ---------- the button ----------
  const btn = document.createElement("button");
  btn.id = "closeFileBtn";
  btn.textContent = "✕ Close file";
  btn.title = "Close this file and open another in the same window. Comments still being transcribed finish by themselves.";
  const header = document.querySelector("header");
  const before = $("finishBtn") || $("helpBtn");
  header.insertBefore(btn, before);
  btn.onclick = (ev) => { ev.currentTarget.blur(); closeFile(); };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function clipQueued(id, ms) {  // resolves when upload() has handed the stopped recording to the app
    return new Promise((resolve) => {
      const done = (ev) => { if (ev.detail === id) { window.removeEventListener("vr-uploaded", done); resolve(); } };
      window.addEventListener("vr-uploaded", done);
      setTimeout(() => { window.removeEventListener("vr-uploaded", done); resolve(); }, ms);
    });
  }

  async function closeFile() {
    btn.disabled = true;
    const recording = S.recFor;
    if (recording) {
      const queued = clipQueued(recording, 6000);
      stopDictation();
      await queued;
    }
    if (typeof closePopup === "function" && S.popupId) closePopup();
    const video = $("video");
    if (video && !video.paused) { S.silent = true; video.pause(); }
    await save();
    S.closing = true;  // no "Leave site?" when the window moves on to the next file
    showClosed();
  }

  // ---------- "No file open" ----------
  function showClosed() {
    const name = S.doc.name, out = S.doc.out || "";
    const left = (S.pending || []).length;
    const flagged = (S.annots || []).filter((a) => a.flag).length;
    document.title = "Voice Review";
    const box = document.createElement("div");
    box.id = "closedScreen";
    box.innerHTML = `
      <div class="cs-card">
        <h2>No file open</h2>
        <p class="cs-done"></p>
        <p class="cs-left" hidden></p>
        <p class="cs-flag" hidden></p>
        <button id="csOpen" class="cs-open">Open a file…</button>
        <div class="cs-recent" hidden><h3>Recent</h3><div id="csList"></div></div>
        <p class="cs-msg" id="csMsg"></p>
        <p class="cs-quit">One file at a time. Close this window to quit Voice Review.</p>
      </div>`;
    document.body.appendChild(box);
    box.querySelector(".cs-done").textContent = `${name} is closed. Its comments are saved in ${out.split(/[\\/]/).pop()}.`;
    if (left) {
      const p = box.querySelector(".cs-left"); p.hidden = false;
      p.textContent = `${left} of its comments ${left > 1 ? "are" : "is"} still being transcribed. ${left > 1 ? "They are" : "It is"} written into that file by ${left > 1 ? "themselves" : "itself"}, even after you open another file.`;
    }
    if (flagged) {
      const p = box.querySelector(".cs-flag"); p.hidden = false;
      p.textContent = `⚠ ${flagged} of its comments may not be courteous. Open ${name} again to rewrite or keep ${flagged > 1 ? "them" : "it"} before you send it.`;
    }
    $("csOpen").onclick = () => openOther(null);
    fetch("/api/recent").then((r) => r.json()).then((j) => {
      const files = (j.files || []).slice(0, 8);
      if (!files.length) return;
      box.querySelector(".cs-recent").hidden = false;
      for (const f of files) {
        const b = document.createElement("button");
        const parts = f.split(/[\\/]/), file = parts.pop();
        b.innerHTML = `<b></b><span></span>`;
        b.querySelector("b").textContent = file;
        b.querySelector("span").textContent = parts.join("\\");
        b.title = f;
        b.onclick = () => openOther(f);
        $("csList").appendChild(b);
      }
    }).catch(() => {});
    $("csOpen").focus();
  }

  async function openOther(path) {
    const msg = $("csMsg");
    const buttons = document.querySelectorAll("#closedScreen button");
    buttons.forEach((b) => (b.disabled = true));
    msg.textContent = path ? "Opening…" : "Choose a file in the dialog (it may be behind this window)…";
    try {
      const r = await fetch("/api/open-other", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      const j = await r.json();
      if (j.url) { msg.textContent = "Opening…"; location.replace(j.url); return; }
      msg.textContent = j.error || "";
    } catch (e) {
      msg.textContent = "Could not open it: " + e.message;
    }
    buttons.forEach((b) => (b.disabled = false));
  }

  // While no file is open, the keys of the closed window (Space = play, F = full screen...) must do nothing.
  window.addEventListener("keydown", (ev) => {
    if (!$("closedScreen")) return;
    ev.stopImmediatePropagation();  // the window's own shortcuts never see it
    if (ev.target && ev.target.tagName === "BUTTON" && (ev.key === "Enter" || ev.key === " ")) return;  // the button still works
    ev.preventDefault();
  }, true);
})();
