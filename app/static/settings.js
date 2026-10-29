// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Daniel Attinger
// Safe mode, the ⚙ settings panel and the lab link (Daniel, 2026-10-21). Shared by the PDF and the
// video window. The settings live on the server (%LOCALAPPDATA%\VoiceReview\settings.json), so every
// window and every port sees the same choices.
"use strict";
// The comment list's top row and the Done tick, for both windows (Daniel, 2026-10-28: "most apps that handle
// comments have a way to delete comments, otherwise they become overwhelming"). Comments ticked Done are hidden
// unless "Show done" is on; their numbers do not change. "Delete all…" asks once.
window.showDone = () => { try { return localStorage.showDone === "1"; } catch { return false; } };
window.listHead = function (all, redraw, deleteAll) {
  const done = all.filter((a) => a.done).length, n = all.length;
  const h = document.createElement("div");
  h.className = "listHead";
  h.innerHTML = `<label title="Comments ticked Done are hidden unless this is ticked"><input type="checkbox"> Show done (${done})</label>
    <span class="spacer"></span><button class="danger" title="Delete every comment in this list">Delete all…</button>`;
  const box = h.querySelector("input"), del = h.querySelector("button");
  box.checked = showDone(); box.disabled = !done && !box.checked;
  box.onchange = () => { try { localStorage.showDone = box.checked ? "1" : "0"; } catch { /* private window */ } redraw(); };
  del.onclick = (ev) => {
    ev.stopPropagation(); del.blur();
    if (confirm(`Delete all ${n} comment${n > 1 ? "s" : ""}${done ? `, including the ${done} ticked Done` : ""}? This cannot be undone.`)) deleteAll();
  };
  h.addEventListener("click", (ev) => ev.stopPropagation());
  return h;
};
window.doneTick = function (a, set) {
  const l = document.createElement("label");
  l.className = "doneTick";
  l.title = a.done ? "Untick to bring it back into the list" : "Done: addressed. It is hidden unless Show done is ticked.";
  l.innerHTML = '<input type="checkbox"> Done';
  const b = l.querySelector("input");
  b.checked = !!a.done;
  l.addEventListener("click", (ev) => ev.stopPropagation());
  b.onchange = () => set(b.checked);
  return l;
};
(function () {
  const el = (id) => document.getElementById(id);
  let cur = {};

  const header = document.querySelector("header"), help = el("helpBtn");
  // One top bar (Daniel, 2026-10-21 "cluttered", and again 2026-10-27 "I have three bars, I wanted just one"):
  // every choice lives in the gear panel, including safe mode and the video speed (the Advanced row is gone).
  const gear = Object.assign(document.createElement("button"), { id: "settingsBtn", className: "iconBtn", textContent: "⚙", title: "Settings" });
  const logo = document.createElement("a");
  logo.id = "labLink"; logo.href = "https://attinger-consulting.com"; logo.target = "_blank"; logo.rel = "noopener";
  logo.title = "Attinger Consulting (opens in your browser)";
  logo.innerHTML = '<img src="/static/attinger-consulting.png" alt="Attinger Consulting">';
  header.insertBefore(gear, help);
  header.appendChild(logo);
  for (const id of ["helpBtn", "searchBtn"]) if (el(id)) el(id).classList.add("iconBtn");

  // The 🎤 on the top bar (2026-10-27, replacing "🎤 speech: local, idle"): grey while not listening, red
  // "Listening" while it records. What the speech engine is doing goes in the tooltip; ⏳ counts the queue.
  const STT_SAYS = { idle: "", ready: "", loading: "Loading the speech model…", working: "Transcribing a recording…",
    checking: "Checking that a comment is courteous…", polishing: "Safe mode is rewriting a comment politely…" };
  window.micPill = function () {
    const p = el("stt"); if (!p || typeof S === "undefined") return;
    const listening = !!S.recFor, err = S.stt === "error";
    p.className = "mic" + (listening ? " on" : "") + (err ? " error" : "");
    p.textContent = listening ? "🎤 Listening" : err ? "🎤 ⚠" : "🎤";
    p.title = err ? "The speech model could not start: " + (S.sttErr || "") :
      (listening ? "Listening: speak now." : "Not listening.") + " " + (STT_SAYS[S.stt] || "") +
      "\nSpeech is transcribed on this computer; nothing leaves it.";
  };
  setInterval(window.micPill, 250);

  // The languages he speaks (2026-10-21: French comments came out in English). One language is as fast as
  // English-only; "Automatic" makes the model detect it, which doubles the transcription time. Since
  // 2026-10-27 every language Whisper knows (the list comes from the server), as a tick list: he ticks the
  // few he uses routinely ("en,fr,nl"), and the server finds which of them was spoken. A tick list, not a
  // drop-down menu: in full screen the menu opened empty (Daniel, 2026-10-27).
  const FIRST = ["en", "fr", "de", "es", "it", "nl", "pt"];
  let LANGS = null;
  const langName = (c) => { const [en, own] = LANGS[c]; return own && own !== en ? `${own} (${en})` : en; };
  function langCodes() { return [...el("langList").querySelectorAll("input:checked")].map((i) => i.value); }
  function renderLangs() {  // ticked first, then the usual ones, then A to Z; rebuilt when the panel opens
    if (!LANGS) return;
    const picked = (cur.lang || "en").split(",").filter((c) => LANGS[c]);
    const rest = Object.keys(LANGS).filter((c) => !picked.includes(c) && !FIRST.includes(c))
      .sort((a, b) => LANGS[a][0].localeCompare(LANGS[b][0]));
    const order = [...picked, ...FIRST.filter((c) => LANGS[c] && !picked.includes(c)), ...rest];
    el("langList").innerHTML = order.map((c) => `<label data-k="${(LANGS[c][0] + " " + LANGS[c][1]).toLowerCase()}">` +
      `<input type="checkbox" value="${c}"${picked.includes(c) ? " checked" : ""}> ${langName(c)}</label>`).join("");
    filterLangs();
  }
  function filterLangs() {
    const q = el("langFind").value.trim().toLowerCase();
    for (const l of el("langList").children) l.hidden = !!q && !l.dataset.k.includes(q);
  }
  function showLangs() {
    const auto = cur.lang === "auto", codes = auto ? [] : (cur.lang || "en").split(",");
    el("langAuto").checked = auto;
    el("langList").classList.toggle("off", auto);
    for (const i of el("langList").querySelectorAll("input")) i.checked = codes.includes(i.value);
    el("langPicked").textContent = auto ? "any (automatic)" : codes.filter((c) => LANGS && LANGS[c]).map(langName).join(", ");
    el("langSlow").hidden = !auto && codes.length < 2;
  }

  const fsbar = el("fsbar");  // the PDF window's full-screen mini bar: a gear instead of the tick boxes
  if (fsbar) {
    const fsAuto = el("fsAutoDictate");
    if (fsAuto) fsAuto.closest("label").hidden = true;
    const fsGear = Object.assign(document.createElement("button"), { id: "fsSettingsBtn", className: "iconBtn", textContent: "⚙", title: "Settings" });
    fsbar.insertBefore(fsGear, el("fsList"));
    fsGear.onclick = () => gear.onclick();
  }

  // About (Daniel, 2026-10-24): at the foot of "How it works", which every new user sees once, in both windows.
  // No pop-up of its own, nothing fetched: the link opens only when clicked.
  const helpBox = el("help");
  if (helpBox) {
    // ? opens on the video walkthrough, the first thing offered (Daniel, 2026-10-27). It ships with the app, so it
    // plays offline.
    helpBox.insertAdjacentHTML("afterbegin", '<a id="helpVideo" href="/static/how-to-video.mp4" target="_blank" ' +
      'rel="noopener">▶ Watch the video walkthrough <span>(3 minutes)</span></a>');
    // Questions (Daniel, 2026-10-27): under ?, which full screen has too. Click a question to open its answer.
    const faq = document.createElement("div");
    faq.id = "faq";
    faq.innerHTML = `<h3>Questions</h3>
      <details><summary>Transcription is very slow. How can I speed it up?</summary><ul>
        <li>Keep working: recordings are transcribed in the background, one at a time. You never need to wait.</li>
        <li>In ⚙, tick only the language you are speaking. Two or more, or "Any language", make each recording
          about twice as slow.</li>
        <li>Plug the computer in and choose the best-performance power mode: on battery, Windows slows the processor down.</li>
        <li>Close other heavy programs while you review.</li>
        <li>The courtesy check and safe mode add a few seconds per comment. Installing without them
          (<code>Install.bat --no-safe-mode</code>) removes that time.</li>
        <li>On an older computer, reinstall with a smaller speech model (<code>Install.bat --model small</code>):
          faster, a little less accurate.</li></ul></details>
      <details><summary>How do I know my documents, my voice and my comments are never sent to the cloud?</summary><ul>
        <li>Nothing is sent over the internet: no document, no recording, no comment. Speech recognition and safe
          mode run on this computer; their models are downloaded once, at installation, and never send anything back.</li>
        <li>The app talks only to itself, at the address 127.0.0.1. Other computers cannot reach it.</li>
        <li>Try it: switch off Wi-Fi, or use airplane mode. Everything still works, because nothing needs the internet.</li>
        <li>Each recording is deleted once it is transcribed, unless you tick "Keep my original recordings" in ⚙
          (kept privately, never next to the document).</li>
        <li>PRIVACY.md, in the Voice Review folder, lists every download with its maker and fingerprint, and every
          file the app keeps, so your IT team can check.</li>
        <li>The only links to the internet are the Attinger Consulting logo and the feedback links below. They open
          only if you click them, and send nothing by themselves.</li></ul></details>
      <details><summary>How good is safe mode?</summary><ul>
        <li>It is a small language model running on this computer. It catches most swearing, insults and personal
          remarks, and keeps every technical point. A rewrite that changes a number is refused.</li>
        <li>It has limits: it can miss a rude remark, or soften a comment too much and shift its meaning, more often
          in languages other than English and French. Read every rewritten comment. Use at your own risk.</li>
        <li>With safe mode off, it still checks each comment and marks a doubtful one ⚠ for you to decide.</li>
        <li>Switch safe mode on in the middle of a PDF, and the comments you already made are checked too: a doubtful
          one gets a ⚠ and is not changed. Voice Review opens the first one for you to rewrite politely or keep;
          ⚠ at the top opens the next. If one is still undecided when you close the window, a notification
          reminds you.</li>
        <li>You can also give your comments a tone: in ⚙, add a line such as "Be overly polite and flattering" or
          "Make it short and direct". With safe mode on, every comment is then rewritten in that tone.</li></ul></details>
      <details><summary>Where are my comments saved?</summary><ul>
        <li><b>PDF:</b> in a copy, <i>name</i>_review.pdf, next to the PDF, so the original is never changed; or, if you
          choose it in ⚙, in the PDF itself (for Zotero). Any PDF reader shows the comments.</li>
        <li><b>Video:</b> next to the video, in <i>name</i>_review.md, plain text you can read, print or send. The
          video is never changed. Open the video in Voice Review again to go on with the same comments.</li>
        <li>Saving is automatic. The ✓ on the top bar means everything is saved; point at it to see the file.</li></ul></details>
      <details><summary>How do I finish a review?</summary><ul>
        <li>Click <b>✓ Finish</b> at the top. It waits until every comment you spoke is transcribed, then lists any
          comment that may not be courteous: rewrite it politely, keep it as you said it, or show it in the document.
          "Rewrite all politely" does them all at once. When nothing is left, it saves and closes the window.</li>
        <li>If you close the window with its ✕ instead while something is unfinished, the browser asks "Leave site?".
          Choose Cancel: the same Finish box is waiting. Comments still being transcribed are never lost: they are
          finished and saved even after the window is closed, and a notification tells you when.</li></ul></details>
      <details><summary>How can I work with other people when I use Voice Review?</summary><ul>
        <li><b>What to send:</b> for a PDF, send <i>name</i>_review.pdf. It is an ordinary PDF with standard comments,
          which any PDF reader shows. For a video, send <i>name</i>_review.md.</li>
        <li><b>If they also use Voice Review:</b> they open your <i>name</i>_review.pdf in Voice Review and add their
          comments to the same file. Ask everyone to set their initials in ⚙, so each comment shows who made it.</li>
        <li><b>If they use Acrobat, Foxit or another PDF reader:</b> they can edit your comments, delete some, add
          their own, reply to yours and mark comments as Completed. When the file comes back, open it in Voice
          Review: their changes are there, their highlights appear with their name and keep their colour, and the
          comments they marked Completed are ticked Done. Their replies, sticky notes, strike-outs and drawings are
          kept in the file, but Voice Review does not show them: open the PDF in Acrobat or Foxit to read them.</li>
        <li><b>Comments that have been dealt with:</b> tick Done on them. They are hidden from the page and the list
          but stay in the file; "Show done" at the top of the list brings them back. Acrobat and Foxit show them
          as Completed. "Delete all…" clears the list.</li>
        <li><b>Good habits:</b> one person works on a file at a time; close it in other programs while Voice Review
          is open, because it can only save when the file is free; and keep the name each person adds when they
          send it back (for example <i>name</i>_review_Anna.pdf), so no one's version is overwritten.</li>
        <li><b>Videos:</b> each reviewer's comments are kept on their own computer. If several people review the
          same video in a shared folder, have each of them rename their <i>name</i>_review.md (for example by adding
          their name) before the next person opens the video, or the next person's comments replace it.</li></ul></details>
      <details><summary>Can I type instead of speaking, or correct a word?</summary><ul>
        <li>Yes. Click the highlight (or the comment in the list) and type in its box. Typed text is saved as it is.</li>
        <li>Speech recognition is not always perfect: read every comment before you share your review.</li></ul></details>
      <details><summary>What are the keyboard shortcuts?</summary>
        <p><b>PDF</b></p><ul>
        <li><b>Shift + drag</b>: mark a region (orange box). <b>Ctrl + drag</b>: copy text, as plain text.</li>
        <li><b>Ctrl + Enter</b>: stop dictating. <b>Esc</b>: close the comment box, the search or full screen.</li>
        <li><b>F</b>: full screen on or off. In full screen, <b>Page Down / Page Up</b> or <b>Space / Shift + Space</b>: next or previous page.</li>
        <li><b>Ctrl + F</b>: search. <b>Enter</b> or <b>F3</b>: next match; <b>Shift + Enter</b>: previous.</li>
        <li><b>Ctrl + plus / Ctrl + minus</b> (or Ctrl + mouse wheel): zoom. <b>Ctrl + 0</b>: fit the page.</li>
        <li><b>Ctrl + S</b>: save now (it also saves by itself).</li></ul>
        <p><b>Video</b></p><ul>
        <li><b>Space</b> (or <b>K</b>): pause, which starts listening, or play. <b>← / →</b>: 5 seconds back or forward.</li>
        <li><b>[</b> / <b>]</b>: slower or faster. <b>Ctrl + Enter</b>: stop listening. <b>Ctrl + S</b>: save now.</li></ul></details>
      <details><summary>How can I send feedback?</summary><ul>
        <li>Feedback is welcome, whether a problem, an idea or a language that works badly. Open an issue on
          <a href="https://github.com/Attinger-D/voice-review/issues" target="_blank" rel="noopener">GitHub</a>, or
          write to <a href="mailto:daniel@attinger-consulting.com">daniel@attinger-consulting.com</a>.</li>
        <li>Please never attach a confidential document: describe the problem instead.</li></ul></details>`;
    helpBox.insertBefore(faq, el("helpClose"));
    const about = document.createElement("div");
    about.id = "about";
    about.innerHTML = `<h3>About Voice Review</h3>
      <a href="https://attinger-consulting.com" target="_blank" rel="noopener" title="Attinger Consulting (opens in your browser)">
      <img src="/static/attinger-consulting.png" alt="Attinger Consulting"></a>
      <p>Voice Review is made by Attinger Consulting. We built it to speed up our work on making forensic science
      more reliable.</p>
      <p class="warn"><b>Speech recognition can make mistakes.</b> Read every comment before you share your review:
      you are the author of what it says. If you receive a review and a comment seems odd, ask the reviewer.
      Use at your own risk.</p>
      <p class="note" id="aboutVer"></p>`;
    helpBox.insertBefore(about, el("helpClose"));
  }

  // The panel (2026-10-27, Daniel: "when we click the gear icon, we have a nice view of all the options"):
  // one card per topic, the explanation in small grey under each choice.
  const panel = document.createElement("div");
  panel.id = "settings"; panel.hidden = true;
  panel.innerHTML = `
    <div class="setHead"><h3>Settings</h3><button id="settingsX" title="Close (Esc)">×</button></div>
    <section><h4>🎤 Speaking</h4>
      <div class="setRow" id="langRow"><b>Languages you speak:</b> <span id="langPicked"></span>
        <div class="note">Tick the ones you use routinely. One language is the fastest. With two or more, each
        recording takes about twice as long to transcribe, because the app first works out which of them you spoke
        (measured: 16 s instead of 8 s for a short sentence; ticking five costs the same as ticking two).</div>
        <div id="langSlow" class="warn" hidden>Several languages: transcription is about twice as slow as with one.</div>
        <input id="langFind" type="search" placeholder="Find a language…" autocomplete="off" spellcheck="false">
        <div id="langList"></div>
        <label><input type="checkbox" id="langAuto"> Any language: let the app guess (about twice as slow, and it may
        pick a language you do not speak)</label></div>
      <div class="setRow"><b>Microphone</b> <select id="micSel"></select> <button id="micTest">Test</button>
        <meter id="micLevel" min="0" max="1" value="0" hidden></meter> <span id="micVerdict"></span>
        <div class="note">Test listens for 5 seconds: the bar moves when you speak. An entry called "Monitor of ..."
        records what the computer plays, not your voice.</div></div>
      <div class="setRow" id="dictateSlot"></div>
    </section>
    <section id="speedSec" hidden><h4>▶ Video</h4>
      <div class="setRow"><b>Playback speed</b> <span id="speedSlot"></span>
        <div class="note">The voice keeps its pitch. Keys [ slower, ] faster. Remembered for the next video.</div></div>
    </section>
    <section><h4>🛡 Safe mode</h4>
      <div class="setRow"><label><input type="checkbox" id="setSafe"> <b>Rewrite rude comments politely</b></label>
        <div class="note">Off (default): every comment is written exactly as you said it. A small language model on this
        computer still checks each one, and a comment that may not be courteous, or breaks a rule below, is marked ⚠
        for you to decide. On: such a comment is rewritten at once, as little as possible, with every technical point
        and number kept: "This paragraph makes no sense at all" becomes "The meaning of this paragraph is difficult to
        understand. Could you do another pass?" Applies to what you say from now on. Nothing leaves this computer.</div>
        <div id="safeMissing" class="warn" hidden>Safe mode needs its model, which is not installed: run Install.bat once while online.</div></div>
      <div class="setRow" id="safeRules"><b>Rules and tone</b> <span class="note">Ticked lines apply. Add your own, or
        your organization's, with +: a rule, such as "No remarks about nationality", or a tone, such as "Be overly
        polite and flattering" or "Make it short and direct". With safe mode on, a tone rewrites every comment.</span>
        <div id="ruleRows"></div><button id="addRule" title="Add a rule">+</button></div>
    </section>
    <section><h4>✍ Your comments</h4>
      <div class="setRow"><b>Your initials</b> <input id="setInitials" maxlength="8" size="6" placeholder="e.g. DA" spellcheck="false">
        <div class="note">Every comment you add is signed: the text ends with (DA), and Acrobat, Zotero and other readers
        show DA as its author. Empty: comments are not signed.</div></div>
      <div class="setRow"><label><input type="checkbox" id="setNote"> <b>Say how the comments were made</b></label>
        <div class="note">Adds one note at the start of the review, before any comment, saying that the comments were dictated with Voice
        Review and transcribed automatically by speech recognition, which is not always perfect: an odd word is more
        likely the machine's mistake than yours, and the reader is invited to ask you.</div></div>
    </section>
    <section><h4>💾 Saving</h4>
      <div class="setRow" id="saveVideo" hidden><b>Video comments</b> are saved next to the video, in
        <i>name</i>_review.md, plain text you can read, print or send. The video itself is never changed; open it in
        Voice Review again to go on with the same comments.
        <div class="note">Saving to: <code id="outPathV"></code></div></div>
      <div class="setRow" id="savePdf"><b>Save PDF comments</b><br>
        <label><input type="radio" name="saveTo" value="copy"> in a copy, <i>name</i>_review.pdf; the original stays untouched</label><br>
        <label><input type="radio" name="saveTo" value="same"> in the PDF itself (for Zotero and other reference managers)</label>
        <div class="note">Applies at once. Saving to: <code id="outPath"></code></div></div>
      <div class="setRow"><label><input type="checkbox" id="setKeep"> <b>Keep my original recordings</b></label>
        <div class="note">Kept as mp3, privately on this computer in <code id="origPath"></code>, never next to the PDF,
        so they cannot be sent by accident. Off: each recording is deleted once it is transcribed.</div></div>
    </section>
    <p class="note" id="verLine"></p>
    <button id="settingsClose">Close</button>`;
  document.body.appendChild(panel);
  // "Dictate right after highlighting" (PDF window) or "Listen when I pause" (video): the existing tick box,
  // moved from the top bar into the panel, so app.js / video.js keep driving it as before.
  const firstLabel = header.querySelector("label");
  if (firstLabel) {
    firstLabel.querySelector("input").insertAdjacentHTML("afterend", " <b></b>");
    const b = firstLabel.querySelector("b"); b.append(...[...firstLabel.childNodes].filter((n) => n.nodeType === 3));
    el("dictateSlot").appendChild(firstLabel);
    el("dictateSlot").insertAdjacentHTML("beforeend", '<div class="note">' + (el("autoDictate")
      ? "Starts listening as soon as you finish a highlight. Off: double-click a highlight to dictate."
      : "Pausing the video starts listening; Play stops it.") + "</div>");
  }
  if (el("speedBtns")) {  // the video window's speed buttons (video.js drives them)
    el("speedSlot").appendChild(el("speedBtns"));
    el("speedSec").hidden = false;
  }
  // Saving says what happens to a video too (Daniel, 2026-10-27: "the saving only describes what happens to the PDF")
  const isVideo = !el("autoDictate");
  el("saveVideo").hidden = !isVideo;
  el("savePdf").hidden = isVideo;

  // Copying is always plain text, with no formatting (Daniel, 2026-10-27), also from the comment list.
  document.addEventListener("copy", (e) => {
    const a = document.activeElement;
    if (a && ["TEXTAREA", "INPUT"].includes(a.tagName)) return;  // already plain
    const t = String(window.getSelection() || "");
    if (t) { e.clipboardData.setData("text/plain", t); e.preventDefault(); }
  });

  function show(s) {
    cur = s;
    el("setSafe").checked = !!s.safe && s.safe_available !== false;
    el("setSafe").disabled = !s.safe_available;
    el("safeMissing").hidden = !!s.safe_available;
    el("setKeep").checked = !!s.keep;
    if (s.langs && !LANGS) { LANGS = s.langs; renderLangs(); }
    el("langRow").hidden = s.multilingual === false;  // an English-only speech model: nothing to choose
    showLangs();
    for (const r of panel.querySelectorAll('input[name="saveTo"]')) r.checked = r.value === s.save_to;
    el("setNote").checked = !!s.note;
    if (!panel.contains(document.activeElement) || document.activeElement.tagName !== "INPUT" || document.activeElement.type !== "text") {
      el("setInitials").value = s.initials || "";  // not while he is typing in it: the panel reloads every 15 s
      rules(s.rules || []);
    }
    if (s.originals) el("origPath").textContent = s.originals;
    if (s.out) el("outPath").textContent = el("outPathV").textContent = s.out;
    if (s.version) {  // so an old install can be told apart at a glance
      el("verLine").textContent = `Voice Review, version ${s.version}. Speech model: ${s.model}. ` +
        "© 2026 Daniel Attinger. Free software under the GNU AGPL-3.0 (LICENSE.txt in the app folder; " +
        "other software and models used: THIRD-PARTY-NOTICES.txt).";
      gear.title = `Settings (version ${s.version})`;
      if (el("aboutVer")) el("aboutVer").textContent = `Version ${s.version}. © 2026 Daniel Attinger, free software under the GNU AGPL-3.0.`;
    }
  }
  async function load() {
    try { show(await (await fetch("/api/settings")).json()); } catch (e) { /* server restarting */ }
  }
  async function change(patch) {
    const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const j = await r.json();
    if (!r.ok) { if (typeof toast === "function") toast(j.error, 6000); load(); return; }
    show({ ...cur, ...j });
    if ("initials" in patch && typeof toast === "function")
      toast(j.initials ? `New comments are signed (${j.initials}).` : "Comments are no longer signed.", 4000);
    if ("safe" in patch && typeof toast === "function")
      toast(patch.safe ? "Safe mode ON: what you say from now on is rewritten politely before it is written down."
        + (document.getElementById("flagPill") ? " Your earlier comments are checked too; a doubtful one gets a ⚠ and is not changed." : "")
        : "Safe mode off: comments are written as spoken.", 6000);
    if ("save_to" in patch && j.out) {  // applies at once (Daniel's test, 2026-10-21: it still saved to _review.pdf)
      const name = j.out.split(/[\\/]/).pop();
      if (typeof setStatus === "function" && el("status")) setStatus(`Comments save to ${j.out}`);
      if (typeof S !== "undefined" && S.doc) S.doc.out = j.out;
      if (typeof toast === "function") toast(`All comments of this document now save to ${name}`, 5000);
    }
  }
  // Safe mode's rules (Daniel, 2026-10-22): ticked = removed. The defaults keep their wording; "own" rows
  // (the free-text line and every + row) can be reworded and removed.
  function rules(list) {
    const box = el("ruleRows");
    box.innerHTML = "";
    list.forEach((r, i) => {
      const row = document.createElement("label");
      row.className = "ruleRow";
      row.innerHTML = '<input type="checkbox"> ' + (r.own
        ? '<input type="text" class="ruleText" placeholder="A rule or a tone, e.g. Be overly polite and flattering"> <button class="ruleDel" title="Remove this line">×</button>'
        : "<span></span>");
      row.querySelector("input").checked = !!r.on;
      if (r.own) row.querySelector(".ruleText").value = r.text; else row.querySelector("span").textContent = r.text;
      box.appendChild(row);
    });
  }
  function readRules() {
    return [...el("ruleRows").children].map((row) => {
      const t = row.querySelector(".ruleText");
      return t ? { text: t.value, on: row.querySelector("input").checked, own: true }
               : { text: row.querySelector("span").textContent, on: row.querySelector("input").checked };
    });
  }
  el("ruleRows").addEventListener("change", (e) => {
    const box = e.target.closest(".ruleRow").querySelector('input[type="checkbox"]');
    if (e.target.classList.contains("ruleText") && e.target.value.trim()) box.checked = true;  // a typed rule applies
    change({ rules: readRules() });
  });
  el("ruleRows").addEventListener("click", (e) => {
    if (!e.target.classList.contains("ruleDel")) return;
    e.preventDefault(); e.target.closest(".ruleRow").remove(); change({ rules: readRules() });
  });
  el("addRule").onclick = () => {
    const list = [...readRules(), { text: "", on: false, own: true }];
    rules(list); change({ rules: list });
    el("ruleRows").lastChild.querySelector(".ruleText").focus();
  };
  // The microphone (2026-10-22: on Nicolas, Firefox's first prompt offered the speakers' "Monitor" and it was
  // remembered, so nothing was heard). Kept by name: a device's id differs for every port the app runs on.
  window.micAudio = async function () {
    const base = { echoCancellation: true, noiseSuppression: true };
    if (!cur.mic) return base;
    try {
      const d = (await navigator.mediaDevices.enumerateDevices()).find((x) => x.kind === "audioinput" && x.label === cur.mic);
      if (d) return { ...base, deviceId: { exact: d.deviceId } };
    } catch (e) { /* no list: the browser's choice */ }
    return base;
  };
  async function micList() {
    const sel = el("micSel");
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"); } catch (e) { /* none */ }
    const named = devs.filter((d) => d.label);  // names appear only once the microphone has been allowed
    sel.innerHTML = '<option value="">Default (the browser\'s choice)</option>';
    for (const d of named) sel.add(new Option(d.label + (/monitor/i.test(d.label) ? "  (the speakers, not a microphone)" : ""), d.label));
    if (cur.mic && !named.some((d) => d.label === cur.mic)) sel.add(new Option(cur.mic + "  (not found now)", cur.mic));
    if (!named.length) sel.add(new Option("Press Test once to list the microphones", "", false, false));
    if (!named.length) sel.options[sel.options.length - 1].disabled = true;
    sel.value = cur.mic || "";
  }
  el("micSel").onchange = (e) => { change({ mic: e.target.value }); el("micVerdict").textContent = ""; e.target.blur(); };
  el("micTest").onclick = async () => {
    const meter = el("micLevel"), say = el("micVerdict");
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: await window.micAudio() }); }
    catch (e) { say.textContent = "Microphone unavailable: " + e.message; return; }
    const track = stream.getAudioTracks()[0];
    const ctx = new AudioContext(), an = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    meter.hidden = false; say.textContent = "Speak now: " + (track ? track.label : "");
    const t0 = performance.now();
    await new Promise((done) => {
      (function tick() {
        an.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        meter.value = Math.min(1, rms * 8); peak = Math.max(peak, rms);
        if (performance.now() - t0 < 5000) requestAnimationFrame(tick); else done();
      })();
    });
    stream.getTracks().forEach((t) => t.stop()); ctx.close(); meter.hidden = true;
    say.textContent = peak > 0.02 ? "✓ It hears you." : "✗ Nothing heard: choose another microphone above, or check its cable and volume.";
    micList();
  };
  el("setInitials").onchange = (e) => change({ initials: e.target.value });
  el("setSafe").onchange = (e) => { change({ safe: e.target.checked }); e.target.blur(); };
  el("setKeep").onchange = (e) => change({ keep: e.target.checked });
  el("setNote").onchange = (e) => change({ note: e.target.checked });
  el("langList").addEventListener("change", (e) => {
    const codes = langCodes();
    if (!codes.length) { e.target.checked = true; if (typeof toast === "function") toast("Keep at least one language ticked.", 3000); return; }
    change({ lang: codes.join(",") });
  });
  el("langAuto").onchange = (e) => change({ lang: e.target.checked ? "auto" : (langCodes().join(",") || "en") });
  el("langFind").oninput = filterLangs;
  for (const r of panel.querySelectorAll('input[name="saveTo"]')) r.onchange = () => change({ save_to: r.value });
  gear.onclick = async () => {
    panel.hidden = !panel.hidden; gear.classList.toggle("open", !panel.hidden);
    if (!panel.hidden) { el("langFind").value = ""; await load(); renderLangs(); showLangs(); micList(); }
  };
  el("settingsClose").onclick = el("settingsX").onclick = () => { panel.hidden = true; gear.classList.remove("open"); };
  document.addEventListener("keydown", (e) => {  // Esc closes the panel first, before anything else uses Esc
    if (e.key === "Escape" && !panel.hidden) { panel.hidden = true; gear.classList.remove("open"); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  load();
  setInterval(load, 15000);  // another window may have changed them
})();
