# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Voice Review: highlight a PDF or a Markdown file (or pause a video), dictate comments, save them as real PDF
annotations, or as CriticMarkup inside the Markdown (since 2026-10-29).

    python server.py <file.pdf> [--port 8765] [--no-browser]

Opens the PDF in a browser window (an app window of Brave, else Chrome, else Edge). Drag across text to highlight
it, Shift+drag (or drag on a figure) to mark a rectangular region. Double-click a
highlight to dictate. Every change is autosaved to <name>_review.pdf next to the
original, which is never modified. Reopening a *_review.pdf edits it in place.

Speech is transcribed locally with faster-whisper on the CPU; nothing leaves the
machine. Recordings go into a queue on disk and are transcribed one at a time, at
below-normal priority, by a worker that writes the text into the PDF itself. The
reviewer never waits; closing the window does not lose a clip (the server stays up
until the queue is empty), and clips left by a crash or reboot are finished the next
time the app starts. The speech model is loaded only while there is work.
"""
import argparse
import ctypes
import gc
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8")) if (ROOT / "config.json").exists() else {}
sys.path.insert(0, str(HERE))  # the portable install's embedded Python does not add the script's folder
from safe_mode import LANGUAGES, Polisher, data_dir  # noqa: E402  (no heavy imports: llama.cpp loads on first use)
import md_review  # noqa: E402

# Models live once per computer, outside the install folder, so a reinstall or a second unpacked copy never
# downloads them again (Daniel, 2026-10-21). Older installs kept them beside the app; still honoured.
SHARED_MODELS = data_dir() / "models"
if (SHARED_MODELS / "hub").is_dir():
    os.environ.setdefault("HF_HOME", str(SHARED_MODELS))
elif (ROOT / "models").is_dir():
    os.environ.setdefault("HF_HOME", str(ROOT / "models"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")  # Xet stalls mid-download on some connections


def setting(key, default):
    return os.environ.get("PDF_REVIEW_" + key.upper()) or CONFIG.get(key) or default


import fitz  # PyMuPDF  # noqa: E402
from flask import Flask, Response, jsonify, request, send_file, send_from_directory  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

STATIC = HERE / "static"
# Shown in the window (top bar tooltip, ? and gear panels) and the log, so an old install can be told
# apart at a glance (2026-10-21: the travel laptop ran the old version without anyone being able to tell).
VERSION = "2026-10-29a"
AUTHOR = setting("author", os.environ.get("USERNAME") or os.environ.get("USER") or "Reviewer")
# large-v3-turbo since 2026-10-21: Daniel dictated in French and distil-large-v3, English only, wrote English.
# Measured that day, same clip, CPU, 4 threads: turbo told the language = distil's speed (8.5 s vs 8.4 s)
# and the same English errors; letting it detect the language doubles the time (16.8 s), so the window
# asks which language he speaks rather than detecting it.
MODEL_NAME = setting("model", "large-v3-turbo")
ENGLISH_ONLY = "distil" in MODEL_NAME or MODEL_NAME.endswith(".en")
CPU_THREADS = int(setting("threads", min(4, max(2, (os.cpu_count() or 4) // 2))))
BEAM = int(setting("beam", 5))
QUEUE = data_dir() / "queue"
# Daniel's choices (2026-10-21), shared by every window: safe mode, keep the recordings, where comments go.
SETTINGS_FILE = QUEUE.parent / "settings.json"
ORIGINALS = QUEUE.parent / "originals"   # private: never beside the PDF, so it cannot travel with it
LANGS = (*LANGUAGES, "auto")  # all 100 of Whisper's languages since 2026-10-27 (was en, fr, de, es, it)
# Safe mode's rules, ticked = enforced (Daniel, 2026-10-22). "own" rows are his to word or remove; the
# first one is an empty free-text line, unticked, and the window's + adds more.
DEFAULT_RULES = [{"text": t, "on": True} for t in
                 ("No profanity", "No racism", "No sexism", "No ageism", "No personal attacks on the author")] + \
                [{"text": "", "on": False, "own": True}]
# Safe mode OFF by default since 2026-10-22 (Daniel: "people will see that transcription is excellent");
# every spoken comment is still checked, and one that may not be courteous is flagged for the reviewer.
DEFAULTS = {"safe": False, "keep": False, "save_to": "copy",
            "lang": "en" if ENGLISH_ONLY else (setting("lang", "") or "en"),
            "initials": "",  # signs every comment (Daniel, 2026-10-22); empty = unsigned, as before
            "note": False,  # the "dictated with Voice Review" note at the end (Daniel, 2026-10-24); off by default
            "mic": "",  # the microphone's name, "" = the browser's choice (2026-10-22: Nico's Firefox took a "Monitor")
            # Highlight, then speak: on by default; off = double-click a highlight to dictate. Kept here, not in the
            # browser, whose memory is per port, so it was on in one window and off in the next (Daniel, 2026-10-28).
            "auto_dictate": True,
            "listen_on_pause": True,  # the video window's equivalent
            "rules": DEFAULT_RULES}


def load_settings():
    try:
        return {**DEFAULTS, **json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return dict(DEFAULTS)


def clean_lang(lang):
    """One language ("fr"), several he speaks routinely ("en,fr,nl", Daniel 2026-10-27), or "auto"."""
    if ENGLISH_ONLY:
        return "en"
    codes = [c for c in dict.fromkeys(str(lang or "").split(",")) if c in LANGS]
    if "auto" in codes:
        return "auto"
    return ",".join(codes[:12]) or "en"


def store_settings(new):
    cur = load_settings()
    cur.update({k: v for k, v in new.items() if k in DEFAULTS})
    cur["save_to"] = "same" if cur["save_to"] == "same" else "copy"
    cur["lang"] = clean_lang(cur["lang"])
    cur["initials"] = "".join(c for c in str(cur.get("initials") or "") if c not in "()\r\n").strip()[:8]
    cur["mic"] = str(cur.get("mic") or "")[:200]
    cur["note"] = bool(cur.get("note"))
    cur["auto_dictate"], cur["listen_on_pause"] = bool(cur["auto_dictate"]), bool(cur["listen_on_pause"])
    rules = cur.get("rules") if isinstance(cur.get("rules"), list) else DEFAULT_RULES
    cur["rules"] = [{"text": str(r.get("text", ""))[:200], "on": bool(r.get("on")), **({"own": True} if r.get("own") else {})}
                    for r in rules[:30] if isinstance(r, dict)]
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(cur, indent=1), encoding="utf-8")
    return cur


def active_rules(st):
    return [r["text"].strip() for r in st.get("rules", DEFAULT_RULES) if r.get("on") and r.get("text", "").strip()]


def signed(content, who):
    """The comment as written in the file ends with the reviewer's initials, "... (DA)", so they survive a
    copy-paste into a rebuttal; readers also show them as the author (Daniel, 2026-10-22)."""
    tag = f" ({who})"
    return content if not (who and content) or content.endswith(tag) else content + tag


def unsigned(content, who):
    tag = f" ({who})"
    return content[:-len(tag)] if who and content.endswith(tag) else content


# The app window's browser, first found wins (Daniel, 2026-10-19: Brave, then Chrome, then Edge, which
# he is removing). All three are Chromium: same --app window, same full-screen behaviour.
_LOCAL = Path(os.environ.get("LOCALAPPDATA", ""))
EDGES = [Path(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
         Path(r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"),
         _LOCAL / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
         Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
         Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
         _LOCAL / "Google" / "Chrome" / "Application" / "chrome.exe",
         Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
         Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")]
if sys.platform == "darwin":
    EDGES = [Path(f"/Applications/{a}.app/Contents/MacOS/{a}")
             for a in ("Brave Browser", "Google Chrome", "Chromium", "Microsoft Edge")]
elif sys.platform != "win32":  # Linux: the same Chromium browsers by command name; Firefox is the fallback below
    EDGES = [Path(p) for p in map(shutil.which, ("brave-browser", "brave", "google-chrome", "google-chrome-stable",
                                                 "chromium", "chromium-browser", "microsoft-edge")) if p]
IDLE_EXIT_S = 300    # no heartbeat for this long -> window is gone, exit
BYE_EXIT_S = 10      # window closed -> exit unless it pings again (reload)
WINDOW_WAIT_S = 15   # no page request this long after opening the window -> open an isolated one
UNLOAD_AFTER_S = 120  # free the speech model's memory after this long with nothing queued

KINDS = (fitz.PDF_ANNOT_HIGHLIGHT, fitz.PDF_ANNOT_SQUARE)
AREA_COLOR = (0.93, 0.35, 0.10)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def lower_priority():
    """Below-normal priority: transcription yields to whatever else the machine is doing."""
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    else:
        os.nice(10)


def pid_alive(pid):
    if sys.platform != "win32":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    k = ctypes.windll.kernel32
    h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    code = ctypes.c_ulong()
    k.GetExitCodeProcess(h, ctypes.byref(code))
    k.CloseHandle(h)
    return code.value == 259  # STILL_ACTIVE


# A file sent too early must say so (Daniel, 2026-10-21: "I believe I have all my comments transcribed, I email
# it, and the colleague only receives some of the comments. That would be a failure."). While a clip waits, its
# note in the PDF carries PENDING_NOTE; the transcription replaces it. A clip that finally fails leaves
# FAILED_NOTE, so a comment is never silently empty.
PENDING_NOTE = ("\u23f3 [This spoken comment is still being transcribed. If you received this file, it is not "
                "final yet: ask the sender for the finished version.]")
FAILED_NOTE = "\u26a0 [A spoken comment here could not be transcribed. The sender still has the recording.]"


class SaveError(RuntimeError):
    """The review file could not be written (held by Acrobat, Zotero, Dropbox...). Never a transcription error."""


def replace_retry(tmp: Path, out: Path, seconds=8.0):
    """os.replace, retried: Zotero and Dropbox read a PDF for a moment each time it changes (2026-10-22: a
    PDF in a Dropbox folder with "save into the PDF itself" was locked on and off for 20 minutes)."""
    t0 = time.time()
    while True:
        try:
            os.replace(tmp, out)
            return
        except PermissionError:
            if time.time() - t0 > seconds:
                tmp.unlink(missing_ok=True)
                raise SaveError(f"{out.name} is open in another program (Acrobat, Zotero, Dropbox?). "
                                "Nothing is lost: it is saved as soon as the file is free.") from None
            time.sleep(0.4)


def strip_pending(comment):
    return (comment or "").replace(PENDING_NOTE, "").strip()


def append(comment, text):
    comment = strip_pending(comment)
    return (comment.rstrip() + " " + text).strip() if comment else text


# Every comment's Subject names the app and its maker (Daniel, 2026-10-24); most readers never show it.
# read_annots looks for "check" in it, so the name must not contain that word.
SUBJECT = "Voice Review, Attinger Consulting"  # nor the word "done", for the same reason
NOTE_ID = "voice-review-note"
# A comment ticked Done (Daniel, 2026-10-28) also gets a hidden "Review state" reply, which Acrobat and Foxit
# show as "Completed"; these replies carry an NM starting with this, so each save replaces ours.
DONE_ID = "voice-review-done-"
DONE_STATES = ("Completed", "Accepted")  # also when the reviewer ticked it in Acrobat or Foxit
# Daniel, 2026-10-27: say plainly that the transcription is not always perfect, so a misheard word is blamed on
# the machine, not on the reviewer or the author.
# First, not last (Daniel, 2026-10-27: "people may get angry if it's poorly transcribed"), with the website.
NOTE_TEXT = ("These comments were dictated with Voice Review, a productivity app by attinger-consulting.com, "
             "and transcribed automatically by speech recognition, which is not always perfect: an odd word is "
             "more likely the machine's mistake than the reviewer's. If a comment seems odd, please ask the reviewer.")


def write_annots(src_bytes, annots, out: Path, pending=()):
    """Write annots onto a fresh copy of the source and atomically replace `out`. Comments whose clip is
    still queued (`pending`) carry PENDING_NOTE in the file."""
    doc = fitz.open("pdf", src_bytes)
    st = load_settings()
    sig = st["initials"]
    # Replies written in Acrobat or Foxit to a comment (Daniel, 2026-10-28: "that person may edit comments, suppress
    # some, add some and send the PDF back"). Every comment is rewritten below with a new number, and MuPDF deletes
    # a comment's replies with it: unhook them first, hook them to the new number after, drop those whose comment
    # is gone. Everything else someone added (sticky notes, strike-outs, drawings) is left as it was.
    replies = {}  # reply xref: id of its comment
    for page in doc:
        ids = {a.xref: a.info.get("id") or f"p{page.number}x{a.xref}" for a in page.annots(types=KINDS)}
        for a in page.annots():
            irt = doc.xref_get_key(a.xref, "IRT")
            if irt[0] == "xref" and int(irt[1].split()[0]) in ids:
                if doc.xref_get_key(a.xref, "State")[0] == "null":  # a state ("Completed") is rewritten from "done"
                    replies[a.xref] = ids[int(irt[1].split()[0])]
                doc.xref_set_key(a.xref, "IRT", "null")
    for page in doc:
        for a in list(page.annots(types=KINDS)):
            page.delete_annot(a)
        for a in list(page.annots(types=(fitz.PDF_ANNOT_TEXT,))):  # our note and Done replies, from an earlier save,
            # and every state reply ("Completed" set in Acrobat): a comment ticked there was read in as done
            if (a.info.get("id") == NOTE_ID or (a.info.get("id") or "").startswith(DONE_ID)
                    or doc.xref_get_key(a.xref, "State")[0] != "null"):
                page.delete_annot(a)
    new = {}  # comment id: its new xref
    for a in sorted(annots, key=lambda a: (a["page"], a["rects"][0][1], a["rects"][0][0])):
        page = doc[a["page"]]
        if a["kind"] == "text":
            an = page.add_highlight_annot([fitz.Rect(r).quad for r in a["rects"]])
        else:
            an = page.add_rect_annot(fitz.Rect(a["rects"][0]))
            an.set_colors(stroke=AREA_COLOR)
            an.set_border(width=1.5)
        if a.get("color"):  # someone else's comment keeps its colour
            an.set_colors(stroke=a["color"])
        # Comments read from the file keep their author; new ones are signed with the initials in Settings.
        who = a.get("author") or sig
        content = strip_pending(a.get("comment", ""))
        if a.get("signed") or (who and who == sig):
            content = signed(content, who)
        if a["id"] in pending:
            content = (content + "\n" + PENDING_NOTE).strip()
        # someone else's comment keeps its own subject: it was not made with Voice Review
        subject = "; ".join(s for s in (a.get("subject", SUBJECT), "check" if a.get("flag") else "",
                                        "done" if a.get("done") else "") if s)
        an.set_info(content=content, title=who or AUTHOR, subject=subject)
        an.update()
        doc.xref_set_key(an.xref, "NM", fitz.get_pdf_str(a["id"]))  # stable id, so queued clips find it
        new[a["id"]] = an.xref
        if a.get("done"):
            r = page.add_text_annot(an.rect.tl, "Done", icon="Note")
            r.set_info(title=who or AUTHOR, subject=SUBJECT)
            r.update()
            for k, v in (("IRT", f"{an.xref} 0 R"), ("StateModel", "(Review)"), ("State", "(Completed)"),
                         ("F", "30"), ("NM", fitz.get_pdf_str(DONE_ID + a["id"]))):  # F 30: hidden, as Acrobat's own
                doc.xref_set_key(r.xref, k, v)
    for page in doc:
        for a in list(page.annots()):
            if a.xref in replies:
                if replies[a.xref] in new:
                    doc.xref_set_key(a.xref, "IRT", f"{new[replies[a.xref]]} 0 R")
                else:
                    page.delete_annot(a)  # its comment was deleted
    if st["note"] and annots:  # a sticky note in the top-right corner of the first page: read before any comment
        first = doc[0]
        an = first.add_text_annot(fitz.Point(first.rect.width - 28, 14), NOTE_TEXT, icon="Note")
        an.set_info(title="Voice Review", subject=SUBJECT)
        an.update()
        doc.xref_set_key(an.xref, "NM", fitz.get_pdf_str(NOTE_ID))
    tmp = out.with_name(out.name + ".tmp")
    doc.save(tmp, garbage=1, deflate=True)
    doc.close()
    replace_retry(tmp, out)


def read_annots(doc):
    out = []
    for page in doc:
        words = None
        states = {}  # xref of a comment: its latest Review state ("Completed" = ticked Done, here or in Acrobat)
        for t in page.annots(types=(fitz.PDF_ANNOT_TEXT,)):
            irt, state = doc.xref_get_key(t.xref, "IRT"), doc.xref_get_key(t.xref, "State")
            if irt[0] == "xref" and state[0] != "null":  # a plain reply has no State ("null")
                states[int(irt[1].split()[0])] = state[1].strip("()")
        for a in page.annots(types=KINDS):
            if a.type[0] == fitz.PDF_ANNOT_HIGHLIGHT:
                v = a.vertices or []
                rects = [list(fitz.Quad(v[i:i + 4]).rect) for i in range(0, len(v) - 3, 4)] or [list(a.rect)]
                kind = "text"
            else:
                rects, kind = [list(a.rect)], "area"
            rects = [[round(c, 2) for c in r] for r in rects]
            words = words if words is not None else page.get_text("words")
            rs = [fitz.Rect(r) for r in rects]
            text = " ".join(w[4] for w in words
                            if any(r.contains(fitz.Point((w[0] + w[2]) / 2, (w[1] + w[3]) / 2)) for r in rs))
            title, content = a.info.get("title", ""), strip_pending(a.info.get("content", ""))
            sgn = bool(title) and content.endswith(f" ({title})")
            item = {"id": a.info.get("id") or f"p{page.number}x{a.xref}", "page": page.number, "kind": kind,
                    "rects": rects, "text": text, "comment": unsigned(content, title)}
            if sgn or (title and title != AUTHOR):  # someone's signed or named comment keeps its author
                item.update(author=title, signed=sgn)
            # our marks are whole parts of the Subject: "...; check" (flagged "may not be courteous", not yet
            # decided) and "...; done" (ticked Done), so a subject such as "Abandoned" is not read as done
            parts = (a.info.get("subject") or "").split("; ")
            if "check" in parts:
                item["flag"] = True
            if "done" in parts or states.get(a.xref) in DONE_STATES:
                item["done"] = True
            if not parts[0].startswith(SUBJECT):  # not made with Voice Review: keep its subject and colour
                item["subject"] = "; ".join(p for p in parts if p not in ("check", "done"))
                if a.colors.get("stroke"):
                    item["color"] = [round(c, 3) for c in a.colors["stroke"]]
            out.append(item)
    return out


class Comments:
    """Comment list + transcription results, shared by the PDF and the video review.

    The window's list is authoritative, except for transcriptions it has not seen yet
    (seq > ack), which are merged into whatever it sends. Subclasses implement _write().
    """

    def __init__(self):
        self.lock = threading.Lock()      # guards annots/results (and MuPDF, which is not thread-safe)
        self.results = []                 # [{seq, id, text}] transcriptions, in arrival order
        self.pending_ids = lambda: ()     # set by the Worker: ids whose clip is still queued
        self.unsaved = False              # a write failed: the worker retries until it goes through

    @property
    def shown(self):  # the file the reviewer sends: the PDF's out; a video's .md (VideoReview sets it)
        return self.__dict__.get("_shown", self.out)

    @shown.setter
    def shown(self, v):
        self._shown = v

    def _try_write(self):
        try:
            self._write()
            if self.unsaved:
                log("saved again after the file was busy")
            self.unsaved = False
        except Exception as e:  # noqa: BLE001  (file busy: kept in memory, retried by the worker)
            self.unsaved = True
            log("save failed, will retry:", e)

    def rewrite(self):
        """Write the file again, e.g. so a newly queued comment shows PENDING_NOTE at once."""
        with self.lock:
            self._try_write()

    def seq(self):
        return self.results[-1]["seq"] if self.results else 0

    def save(self, annots, ack):
        with self.lock:
            byid = {a["id"]: a for a in annots}
            for r in self.results:
                if r["seq"] > ack and r["id"] in byid:
                    byid[r["id"]]["comment"] = append(byid[r["id"]].get("comment", ""), r["text"])
                    if r.get("flag"):  # the window has not seen the flag yet either
                        byid[r["id"]]["flag"] = True
            self.annots = annots
            self._write()
        return str(self.shown)

    def add_result(self, aid, text, flag=False):
        """Empty text is recorded too: it tells the video window to drop a comment nobody spoke into.
        `flag`: the check found it may not be courteous; the window warns and the reviewer decides."""
        with self.lock:
            self.results.append({"seq": self.seq() + 1, "id": aid, "text": text, "flag": bool(flag)})
            for a in self.annots:
                if a["id"] == aid and text:
                    a["comment"] = append(a.get("comment", ""), text)
                    if flag:
                        a["flag"] = True
                    self._try_write()  # a busy file never loses the text: it is in memory and retried

    def add_flag(self, aid):
        """An earlier comment that may not be courteous: flagged, text unchanged (no text in the result)."""
        with self.lock:
            self.results.append({"seq": self.seq() + 1, "id": aid, "text": "", "flag": True, "recheck": True})
            for a in self.annots:
                if a["id"] == aid:
                    a["flag"] = True
                    self._try_write()

    def results_since(self, seq):
        with self.lock:
            return [r for r in self.results if r["seq"] > seq]


class Review(Comments):
    kind = "pdf"

    def __init__(self, src: Path):
        super().__init__()
        self.src = src
        self.set_target(load_settings()["save_to"])
        # Read into memory so the file on disk is never held open (Windows can't replace open files).
        # The PDF opened again after a review (2026-10-28): carry on in its _review.pdf, with the comments and
        # whatever someone added there in Acrobat, instead of starting empty and overwriting it.
        base = self.out if self.out != src and self.out.exists() else src
        if base != src:
            log(f"continuing the review already in {base.name}")
        self.src_bytes = base.read_bytes()
        self.doc = fitz.open("pdf", self.src_bytes)
        self.words_cache = {}
        self.annots = read_annots(self.doc)

    def set_target(self, save_to):
        """"same" (Daniel, 2026-10-21, for Zotero): comments go into the PDF itself, else into a copy.
        Changing it in an open window applies at once: the next save writes every comment to the new file."""
        src = self.src
        self.out = src if save_to == "same" or src.stem.endswith("_review") else src.with_name(src.stem + "_review.pdf")

    def info(self):
        with self.lock:
            pages =[{"w": round(p.rect.width, 2), "h": round(p.rect.height, 2), "label": p.get_label() or ""}
                     for p in self.doc]
            return {"type": "pdf", "name": self.src.name, "src": str(self.src), "out": str(self.out),
                    "pages": pages, "annots": self.annots, "seq": self.seq()}

    def render(self, n, zoom):
        with self.lock:
            r = self.doc[n].rect  # cap the image at ~48 Mpx so a poster-size page can't exhaust memory
            zoom = min(zoom, (48e6 / max(r.width * r.height, 1)) ** 0.5)
            pix = self.doc[n].get_pixmap(matrix=fitz.Matrix(zoom, zoom), annots=False)
            return pix.tobytes("png")

    def words(self, n):
        with self.lock:
            if n not in self.words_cache:
                self.words_cache[n] = [[round(w[0], 2), round(w[1], 2), round(w[2], 2), round(w[3], 2),
                                        w[4], w[5], w[6]] for w in self.doc[n].get_text("words")]
            return self.words_cache[n]

    def _write(self):
        write_annots(self.src_bytes, self.annots, self.out, set(self.pending_ids()))


VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv"}


def clock_str(t):
    t = int(round(t))
    return f"{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def video_md(video: Path):
    return video.with_name(video.stem + "_review.md")


def video_state(video: Path):
    """Where a video review's comments are kept for the app to reopen. Beside the video, as <name>_review.json,
    only where config.json says "video_json": true (Daniel's own computers, 2026-10-27: "I want on my computers
    to have the JSON, and the customers to only have the MD"); elsewhere privately, in the data folder."""
    if setting("video_json", False):
        return video.with_name(video.stem + "_review.json")
    d = QUEUE.parent / "videos"
    d.mkdir(parents=True, exist_ok=True)
    return d / (hashlib.sha1(str(video).lower().encode("utf-8")).hexdigest()[:16] + ".json")


def write_video_review(video: Path, annots, out: Path):
    """`out`, the comments as JSON (for the app, and for Claude on Daniel's computers), and <name>_review.md
    beside the video (for reading and sending)."""
    annots = sorted(annots, key=lambda a: a["t"])
    st = load_settings()
    who = st["initials"]
    data = {"video": str(video), "author": who or AUTHOR, "comments": [
        {"id": a["id"], "t": round(a["t"], 2), "at": clock_str(a["t"]), "comment": a.get("comment", ""),
         **({"done": True} if a.get("done") else {})}
        for a in annots]}
    done = sum(1 for a in annots if a.get("done"))
    if st["note"] and annots:
        data["note"] = NOTE_TEXT
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    replace_retry(tmp, out)  # Dropbox locks the file now and then (Daniel's promo review, 2026-10-22: red NOT SAVED)
    md = [f"# Review comments: {video.name}", ""]
    if st["note"] and annots:  # first, as in the PDF
        md += [f"*{NOTE_TEXT}*", ""]
    md += [f"Video: `{video}`, {len(annots)} comments by {who or AUTHOR}" + (f", {done} of them done." if done else "."),
           "Times are where the video was paused; the comment itself may point earlier (\"10 seconds ago\").", ""]
    for n, a in enumerate(annots, 1):
        md += [f"## {n}. at {clock_str(a['t'])}" + (" (done)" if a.get("done") else ""), "", signed(a.get("comment") or "", who) or "(no comment)", ""]
    tmp = video_md(video).with_name(video_md(video).name + ".tmp")
    tmp.write_text("\n".join(md), encoding="utf-8")
    replace_retry(tmp, video_md(video))


class VideoReview(Comments):
    """Comments anchored to the moment the video was paused."""
    kind = "video"

    def __init__(self, src: Path):
        super().__init__()
        self.src = src
        self.out = video_state(src)
        self.shown = video_md(src)  # what the reviewer sees and sends
        self.annots = []
        beside = src.with_name(src.stem + "_review.json")  # also a review made before 2026-10-27c
        for f in (self.out, beside):
            if f.exists():
                self.annots = [{"id": c["id"], "t": c["t"], "comment": c.get("comment", ""), "done": bool(c.get("done"))}
                               for c in json.loads(f.read_text(encoding="utf-8"))["comments"]]
                break

    def info(self):
        with self.lock:
            return {"type": "video", "name": self.src.name, "src": str(self.src), "out": str(self.shown),
                    "annots": self.annots, "seq": self.seq()}

    def _write(self):
        write_video_review(self.src, self.annots, self.out)


MD_EXTS = {".md", ".markdown"}
# Pictures a Markdown file shows, served from its folder (and below or beside it); nothing else is served.
MD_MEDIA = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif"}


def md_out(src: Path, save_to):
    return src if save_to == "same" or src.stem.endswith("_review") else src.with_name(src.stem + "_review.md")


def write_md_review(clean, annots, out: Path, pending=()):
    st = load_settings()
    text = md_review.write(clean, annots, st["initials"], pending, PENDING_NOTE, NOTE_TEXT if st["note"] else "")
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    replace_retry(tmp, out)


class MdReview(Comments):
    """A Markdown file (Daniel, 2026-10-29: "accept markdown files as inputs and outputs"). The window shows it
    rendered, with its pictures; comments go into the Markdown as CriticMarkup ({==words==}{>>comment<<}), so
    anyone can read them in any editor, answer them and update the file. See md_review.py."""
    kind = "md"

    def __init__(self, src: Path):
        super().__init__()
        self.src = src
        self.set_target(load_settings()["save_to"])
        base = self.out if self.out != src and self.out.exists() else src  # carry on in an earlier _review.md
        if base != src:
            log(f"continuing the review already in {base.name}")
        self.clean, self.annots = md_review.parse(base.read_text(encoding="utf-8-sig"), PENDING_NOTE)

    def set_target(self, save_to):
        self.out = md_out(self.src, save_to)

    def info(self):
        with self.lock:
            return {"type": "md", "name": self.src.name, "src": str(self.src), "out": str(self.out),
                    "md": self.clean, "html": md_review.render(self.clean), "pages": [],
                    "annots": self.annots, "seq": self.seq()}

    def media(self, rel):
        f = (self.src.parent / rel).resolve()
        return f if f.suffix.lower() in MD_MEDIA and f.is_file() else None

    def _write(self):
        write_md_review(self.clean, self.annots, self.out, set(self.pending_ids()))


def apply_to_file(out: Path, aid, text):
    """For a clip whose window is long gone (crash, reboot): edit that review file directly."""
    if out.suffix == ".json":
        data = json.loads(out.read_text(encoding="utf-8"))
        for c in data["comments"]:
            if c["id"] == aid:
                c["comment"] = append(c.get("comment", ""), text)
                write_video_review(Path(data["video"]), data["comments"], out)
                return True
        return False
    if out.suffix.lower() in MD_EXTS:
        clean, annots = md_review.parse(out.read_text(encoding="utf-8-sig"), PENDING_NOTE)
        for a in annots:
            if a["id"] == aid:
                a["comment"] = append(a.get("comment", ""), text)
                a.pop("waiting", None)
                write_md_review(clean, annots, out)
                return True
        return False
    data = out.read_bytes()
    doc = fitz.open("pdf", data)
    for page in doc:
        for a in page.annots(types=KINDS):
            if a.info.get("id") == aid:
                who, said = a.info.get("title", ""), strip_pending(a.info.get("content", ""))
                sgn = bool(who) and said.endswith(f" ({who})")
                new = append(unsigned(said, who), text)  # append() drops PENDING_NOTE
                a.set_info(content=signed(new, who) if sgn else new)
                a.update()
                tmp = out.with_name(out.name + ".tmp")
                doc.save(tmp, garbage=1, deflate=True)
                doc.close()
                replace_retry(tmp, out)
                return True
    return False


class Transcriber:
    """faster-whisper on the CPU, loaded on demand and unloaded when idle. Never touches the GPU."""

    def __init__(self):
        self.model, self.error, self.busy = None, None, False
        self.state, self.spoken = "idle", None

    def _ensure(self):
        if self.model:
            return
        self.state = "loading"
        from faster_whisper import WhisperModel
        kw = dict(device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)
        t0 = time.time()
        try:
            self.model = WhisperModel(MODEL_NAME, local_files_only=True, **kw)
        except Exception:
            log(f"model {MODEL_NAME} not cached, downloading…")
            try:
                self.model = WhisperModel(MODEL_NAME, **kw)
            except Exception as e:
                raise RuntimeError(f"speech model {MODEL_NAME} is not installed and could not be downloaded "
                                   f"(no internet?). Run Install.bat once while online. ({e})") from e
        log(f"speech model loaded in {time.time() - t0:.0f}s: {MODEL_NAME} (cpu, {CPU_THREADS} threads)")

    def transcribe(self, path, lang="en"):
        try:
            self._ensure()
            self.error = None
        except Exception as e:  # noqa: BLE001
            self.error, self.state = f"speech model failed to load: {e}", "error"
            raise
        self.state = "working"
        lang = clean_lang(lang)
        audio, language = str(path), None if lang == "auto" else lang
        if "," in lang:  # several languages ticked: find which of them was spoken, then transcribe in it
            from faster_whisper import decode_audio
            audio = decode_audio(audio)
            _, _, probs = self.model.detect_language(audio=audio, vad_filter=True)
            p = dict(probs)
            language = max(lang.split(","), key=lambda c: p.get(c, 0.0))
        segs, info = self.model.transcribe(audio, language=language, beam_size=BEAM, vad_filter=True)
        self.spoken = info.language  # safe mode answers in that language
        return " ".join(s.text.strip() for s in segs).strip()

    def unload(self):
        if self.model:
            self.model = None
            gc.collect()
            log("speech model unloaded (queue empty)")
        self.state = "idle"


class Worker:
    """One clip at a time from the on-disk queue: ours first, then orphans of dead sessions."""

    def __init__(self, review: Comments, stt: Transcriber):
        self.review, self.stt = review, stt
        self.polisher = Polisher(threads=CPU_THREADS, log=log)
        self.finishing = None  # id whose text is being written right now: no longer "pending"
        review.pending_ids = lambda: [i for i in self.pending() if i != self.finishing]
        self.wake = threading.Event()
        self.failed = []  # [{id, error}] clips of this PDF given up after 3 tries
        # Safe mode switched on in an open PDF (Daniel, 2026-10-28): his earlier comments are checked too,
        # one at a time after any new clip, and the doubtful ones flagged, never rewritten.
        self.recheck, self.rechecked = [], {"run": 0, "checked": 0, "flagged": 0}
        self.was_safe = self.safe_now()
        QUEUE.mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self._run, daemon=True).start()

    def enqueue(self, audio: bytes, aid):
        jid = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        (QUEUE / f"{jid}.webm").write_bytes(audio)
        st = load_settings()  # the settings when he spoke, not when the clip's turn comes
        job = {"out": str(self.review.out), "id": aid, "pid": os.getpid(), "created": time.time(), "tries": 0,
               "safe": bool(st["safe"]) and self.polisher.available(), "keep": bool(st["keep"]), "lang": st["lang"], "name": self.review.src.stem,
               "rules": active_rules(st), "check": self.polisher.available()}
        (QUEUE / f"{jid}.json").write_text(json.dumps(job), encoding="utf-8")
        self.review.rewrite()  # the PDF now says this comment is still being transcribed
        self.wake.set()

    def _jobs(self):
        jobs = []
        for f in sorted(QUEUE.glob("*.json")):
            try:
                j = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            j["file"] = f
            if j["pid"] == os.getpid() or (j["out"] == str(self.review.out) and not pid_alive(j["pid"])):
                j["mine"] = True  # ours, or left by a dead session of this same document
            elif pid_alive(j["pid"]):
                continue  # another running session owns it, even for this same document: never take its clips
            else:
                j["mine"] = False
            jobs.append(j)
        return sorted(jobs, key=lambda j: (not j["mine"], j["created"]))

    def pending(self):
        return [j["id"] for j in self._jobs() if j["mine"]]

    def has_work(self):
        return bool(self._jobs()) or self.stt.busy or self.review.unsaved

    def safe_now(self):
        return bool(load_settings()["safe"]) and self.polisher.available()

    def start_recheck(self):
        """Every comment of this reviewer already in the PDF, not someone else's and not flagged yet."""
        sig = load_settings()["initials"]
        with self.review.lock:
            self.recheck = [a["id"] for a in self.review.annots if strip_pending(a.get("comment", "")).strip()
                            and not a.get("flag") and (not a.get("author") or a["author"] == sig)]
        # "run" tells the window that safe mode was switched on and the check is over, even one too quick for it
        # to see running, or with nothing to check: it then shows the flagged comments, old ones included
        self.rechecked = {"run": self.rechecked["run"] + 1, "checked": 0, "flagged": 0}
        if self.recheck:
            log(f"safe mode switched on: checking {len(self.recheck)} earlier comments")

    def _recheck_one(self):
        aid = self.recheck[0]  # stays counted as "left" until its check is done
        with self.review.lock:  # the comment as it is now: it may have been edited, deleted or flagged since
            a = next((x for x in self.review.annots if x["id"] == aid), None)
            text = strip_pending(a.get("comment", "")).strip() if a and not a.get("flag") else ""
        if text:
            try:
                bad = self.polisher.flag(text, active_rules(load_settings()))
            except Exception as e:  # noqa: BLE001  (an unchecked comment is better than a stopped worker)
                log("recheck failed:", e)
                bad = False
            self.rechecked["checked"] += 1
            if bad:
                self.rechecked["flagged"] += 1
                self.review.add_flag(aid)
        self.recheck.pop(0)
        if not self.recheck:
            log(f"earlier comments checked: {self.rechecked['checked']}, flagged: {self.rechecked['flagged']}")

    def _run(self):
        lower_priority()
        self.idle_since = time.time()
        while True:
            try:
                self._step()
            except Exception as e:  # noqa: BLE001  (2026-10-22: an error here once stopped all transcription)
                log("worker error, continuing:", e)
                time.sleep(5)

    def _step(self):
        if self.review.unsaved:
            self.review.rewrite()
        safe = self.safe_now()
        if safe and not self.was_safe and self.review.kind in ("pdf", "md"):
            self.start_recheck()
        elif not safe:
            self.recheck = []  # switched off again: new comments are checked as they come, as always
        self.was_safe = safe
        jobs = self._jobs()
        if not jobs and self.recheck:  # new clips first: they are what the reviewer is waiting for
            self._recheck_one()
            self.idle_since = time.time()
            return
        if not jobs:
            if (self.stt.model or self.polisher.llm) and time.time() - self.idle_since > UNLOAD_AFTER_S:
                self.stt.unload()
                self.polisher.unload()
            self.wake.wait(10)
            self.wake.clear()
            return
        self._do(jobs[0])
        self.idle_since = time.time()

    def _do(self, j):
        f, audio = j["file"], j["file"].with_suffix(".webm")
        self.stt.busy = True
        try:
            t0 = time.time()
            if "text" in j:  # transcribed before, only the save was left (orphan whose file was busy)
                said, text = j.get("said", j["text"]), j["text"]
            else:
                self.stt.spoken = None
                said = text = self.stt.transcribe(audio, j.get("lang", "en")) if audio.exists() else ""
            if j.get("safe") and said and "text" not in j:
                # Safe mode: only the polished text reaches the PDF and the log. If polishing fails, the
                # clip is retried and finally parked in failed\, never written as spoken.
                self.stt.state = "polishing"
                text = self.polisher.polish(said, self.stt.spoken or j.get("lang", "en"), j.get("rules"))
            flag = False
            if not j.get("safe") and j.get("check") and said and "text" not in j:
                self.stt.state = "checking"
                try:
                    flag = self.polisher.flag(said, j.get("rules"))
                except Exception as e:  # noqa: BLE001  (no check is better than no comment)
                    log("courtesy check failed:", e)
            log(f"transcribed in {time.time() - t0:.1f}s ({len(self._jobs()) - 1} left)"
                f"{' [safe mode]' if j.get('safe') else ''}: {text[:80]!r}")
            if j.get("keep") and audio.exists():
                keep_original(j, audio, said, text)
            if j["mine"]:
                self.finishing = j["id"]
                self.review.add_result(j["id"], text, flag)
            elif text:
                try:
                    if not apply_to_file(Path(j["out"]), j["id"], text):
                        log(f"comment {j['id']} not found in {j['out']}; text was: {text}")
                except SaveError as e:  # keep the text with the clip; try the file again later
                    j.update(text=text, said=said)
                    f.write_text(json.dumps({k: v for k, v in j.items() if k not in ("file", "mine")}),
                                 encoding="utf-8")
                    log("save postponed:", e)
                    time.sleep(10)
                    return
            f.unlink(missing_ok=True)
            audio.unlink(missing_ok=True)
        except Exception as e:  # noqa: BLE001
            j["tries"] = j.get("tries", 0) + 1
            log(f"transcription failed (try {j['tries']}):", e)
            if j["tries"] >= 3:
                self.finishing = j["id"]
                if j["mine"]:
                    self.failed.append({"id": j["id"], "error": str(e)})
                    self.review.add_result(j["id"], FAILED_NOTE)
                else:
                    try:
                        apply_to_file(Path(j["out"]), j["id"], FAILED_NOTE)
                    except Exception as e2:  # noqa: BLE001
                        log("could not mark the failed comment in the file:", e2)
                failed = QUEUE.parent / "failed"
                failed.mkdir(exist_ok=True)
                for p in (f, audio):
                    if p.exists():
                        os.replace(p, failed / p.name)
            else:
                f.write_text(json.dumps({k: v for k, v in j.items() if k not in ("file", "mine")}), encoding="utf-8")
                time.sleep(5)
        finally:
            self.finishing = None
            self.stt.busy = False
            if self.stt.state == "working":
                self.stt.state = "ready"


def keep_original(j, audio: Path, said, text):
    """The private copy (Daniel's choice, off by default): the recording as mp3 and what was said,
    in %LOCALAPPDATA%\\VoiceReview\\originals\\<document>\\, never beside the PDF."""
    d = ORIGINALS / (j.get("name") or "unknown")
    d.mkdir(parents=True, exist_ok=True)
    try:
        import av
        with av.open(str(audio)) as src, av.open(str(d / f"{audio.stem}.mp3"), "w") as dst:
            st = dst.add_stream("mp3", rate=48000)
            st.bit_rate = 64000
            rs = av.AudioResampler(format="fltp", layout="mono", rate=48000)
            for frame in src.decode(audio=0):
                for f in rs.resample(frame):
                    for pkt in st.encode(f):
                        dst.mux(pkt)
            for pkt in st.encode(None):
                dst.mux(pkt)
    except Exception as e:  # noqa: BLE001
        log("mp3 failed, keeping the original recording:", e)
        shutil.copy2(audio, d / audio.name)
    with open(d / "comments.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"clip": audio.stem, "comment_id": j["id"], "review_file": j["out"], "said": said,
                            "written": text, "safe_mode": bool(j.get("safe"))}, ensure_ascii=False) + "\n")


def make_app(review: Comments, stt: Transcriber, worker: Worker):
    app = Flask(__name__, static_folder=None)
    clock = {"seen": None, "bye": None, "opened": False}
    app.config["clock"] = clock

    @app.after_request
    def no_store(resp):
        # Never let the browser keep anything (Daniel, 2026-10-19): page images are addressed by port,
        # page and zoom only, so a new document on a reused port showed the PREVIOUS document's cached
        # pages in full screen (Brave). Everything is local and fast; nothing is worth caching.
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        return resp

    def touch():
        clock["seen"], clock["bye"] = time.time(), None

    def status(since=0):
        return {"stt": stt.state, "error": stt.error, "pending": worker.pending(), "failed": worker.failed,
                "results": review.results_since(since), "settings": load_settings(),
                "safe_available": worker.polisher.available(),
                "recheck": {"left": len(worker.recheck), **worker.rechecked}}

    @app.get("/")
    def index():
        clock["opened"] = True
        if review.kind == "md":  # the PDF window, with md.js replacing the page images by the rendered text
            html = (STATIC / "index.html").read_text(encoding="utf-8").replace(
                '<script src="/static/settings.js"></script>',
                '<script src="/static/settings.js"></script>\n<script src="/static/md.js"></script>')
            html = html.replace('<link rel="stylesheet" href="/static/style.css">',
                                '<link rel="stylesheet" href="/static/style.css">\n<link rel="stylesheet" href="/static/md.css">')
            return Response(html, mimetype="text/html")
        return send_from_directory(STATIC, "video.html" if review.kind == "video" else "index.html")

    @app.get("/mdfile/<path:rel>")
    def md_file(rel):
        f = review.media(rel) if review.kind == "md" else None
        return send_file(f) if f else ("", 404)

    @app.get("/media")
    def media():
        return send_file(review.src, conditional=True)  # Range requests, so the player can seek

    @app.get("/static/<path:p>")
    def static_files(p):
        r = send_from_directory(STATIC, p)
        r.headers["Cache-Control"] = "no-store"
        return r

    @app.get("/api/doc")
    def doc():
        touch()
        return jsonify({**review.info(), **status(10**9), "model": MODEL_NAME, "version": VERSION})

    @app.get("/api/page/<int:n>.png")
    def page(n):
        zoom = min(max(float(request.args.get("zoom", 2)), 0.5), 8)  # 8 = max app zoom 4 x browser zoom 200%
        return Response(review.render(n, zoom), mimetype="image/png",
                        headers={"Cache-Control": "max-age=3600"})

    @app.get("/api/words/<int:n>")
    def words(n):
        return jsonify(review.words(n))

    @app.post("/api/annotations")
    def save():
        # not touch(): the closing window sends this save and /api/bye together, and when the save came second it
        # cancelled the goodbye, so the app lingered 5 minutes and its notifications came late (Daniel, 2026-10-28)
        clock["seen"] = time.time()
        data = request.get_json(force=True)
        try:
            path = review.save(data["annots"], int(data.get("ack", 0)))
        except Exception as e:  # noqa: BLE001
            log("save failed:", e)
            return jsonify({"error": str(e)}), 500
        log(f"saved {len(data['annots'])} comments -> {path}")
        return jsonify({"ok": True, "out": path, "saved_at": time.strftime("%H:%M:%S")})

    @app.post("/api/transcribe")
    def transcribe():
        touch()
        worker.enqueue(request.get_data(), request.args.get("id", ""))
        return jsonify({"queued": len(worker.pending())})

    @app.post("/api/polish")
    def polish_now():
        """The reviewer pressed "Rewrite politely" on a flagged comment."""
        touch()
        j = request.get_json(force=True)
        if not worker.polisher.available():
            return jsonify({"error": "The rewriting model is not installed: run Install.bat once while online."}), 400
        st = load_settings()
        try:
            text = worker.polisher.polish(j.get("text", ""), st["lang"] if st["lang"] != "auto" else "", active_rules(st), force=True)
        except Exception as e:  # noqa: BLE001
            return jsonify({"error": str(e)}), 500
        log(f"rewritten on request ({len(text)} characters)")  # never the text: the log is not private (2026-10-22)
        return jsonify({"text": text})

    @app.route("/api/settings", methods=["GET", "POST"])
    def settings():
        if request.method == "GET":
            return jsonify({**load_settings(), "safe_available": worker.polisher.available(),
                            "multilingual": not ENGLISH_ONLY, "model": MODEL_NAME, "version": VERSION, "langs": LANGUAGES,
                            "originals": str(ORIGINALS), "out": str(review.shown)})
        new = request.get_json(force=True)
        if new.get("safe") and not worker.polisher.available():
            return jsonify({"error": "Safe mode needs its model: run Install.bat once while online."}), 400
        cur = store_settings(new)
        worker.wake.set()  # safe mode just switched on: check the earlier comments now, not in 10 s
        if "note" in new:  # add or remove the note now, not at the next comment
            with review.lock:
                review._try_write()
        if "save_to" in new and review.kind in ("pdf", "md"):
            with review.lock:
                review.set_target(cur["save_to"])
                try:
                    review._write()  # all comments of this window go to the chosen file now
                except Exception as e:  # noqa: BLE001  (file open in Acrobat: the next save retries)
                    log("save failed:", e)
            log(f"comments now save to {review.out}")
        return jsonify({**cur, "out": str(review.shown)})

    @app.post("/api/ping")
    def ping():
        touch()
        return jsonify(status(int(request.args.get("since", 0))))

    @app.post("/api/close-window")
    def close_window_route():
        """Finish, once everything is saved: the page cannot close its own --app window (Brave refuses
        window.close() even with one history entry, 2026-10-28), so the window is asked to close from here."""
        return jsonify({"closed": close_window(request.get_json(force=True).get("title", ""))})

    @app.post("/api/bye")
    def bye():
        clock["bye"] = time.time()
        return "", 204

    def watchdog():
        warned = False
        while True:
            time.sleep(2)
            now = time.time()
            gone = clock["bye"] and now - clock["bye"] > BYE_EXIT_S or clock["seen"] and now - clock["seen"] > IDLE_EXIT_S
            left = len(worker.pending())
            if gone and left and not warned:  # window closed with comments still queued: say so outside it
                warned = True
                notify(f"Not ready to send: {review.src.name}",
                       f"{left} spoken comment{'s are' if left > 1 else ' is'} still being transcribed. Don't send the "
                       "file yet; you will get a message when it is complete.")
            if gone and not worker.has_work():  # queued clips are finished and saved first
                flagged = sum(1 for a in review.annots if a.get("flag")) if review.kind in ("pdf", "md") else 0
                if flagged:  # the window asked once before closing; this reminder outlives it (2026-10-28)
                    notify(f"Check before sending: {review.src.name}",
                           f"{flagged} comment{'s' if flagged > 1 else ''} may not be courteous and "
                           f"{'are' if flagged > 1 else 'is'} flagged. Open the file in Voice Review to rewrite or keep "
                           f"{'them' if flagged > 1 else 'it'}.")
                if warned:
                    notify(f"Ready to send: {review.src.name}",
                           f"All comments are transcribed and saved in {review.shown.name}.")
                log("window closed and queue empty, exiting")
                unregister(review.src)
                os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    return app


def close_window(title):
    """Ask the top-level window titled `title` to close, as its X would (WM_CLOSE). Only a title ending in
    " · voice review" is accepted, so no other program's window can be closed this way. Windows only."""
    if sys.platform != "win32" or not title.endswith(" · voice review"):
        return False
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        n = u.GetWindowTextLengthW(hwnd)
        if n and u.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value == title:
                found.append(hwnd)
        return True

    u.EnumWindows(each, 0)
    for hwnd in found:
        u.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    log(f"closing the window ({len(found)} found)")
    return bool(found)


def notify(title, text):
    """A desktop notification that outlives the window (Windows balloon/toast, or notify-send on Linux)."""
    log(f"notify: {title}: {text}")
    try:
        if sys.platform == "win32":
            q = lambda v: v.replace("'", "''")  # noqa: E731  (PowerShell single-quoted string)
            ps = ("Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;"
                  "$n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information;"
                  "$n.BalloonTipTitle='" + q(title) + "'; $n.BalloonTipText='" + q(text) + "';"
                  "$n.Visible=$true; $n.ShowBalloonTip(15000); Start-Sleep -Seconds 16; $n.Dispose()")
            subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        elif sys.platform == "darwin":
            q = lambda v: v.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731  (AppleScript string)
            subprocess.Popen(["osascript", "-e", f'display notification "{q(text)}" with title "{q(title)}"'])
        elif shutil.which("notify-send"):
            subprocess.Popen(["notify-send", "-u", "critical", title, text])
    except Exception as e:  # noqa: BLE001
        log("notification failed:", e)


def registry(src: Path):
    """One running session per document (2026-10-21). Daniel closed the window while clips were still being
    transcribed and reopened the PDF: a second process read the PDF before the texts were in, and its window
    saved over them. Now the second launch only opens a window onto the session still running."""
    d = QUEUE.parent / "open"
    d.mkdir(parents=True, exist_ok=True)
    return d / (hashlib.sha1(str(src).lower().encode("utf-8")).hexdigest()[:16] + ".json")


def running_session(src: Path):
    """The port of a live session of this document, or None."""
    f = registry(src)
    try:
        r = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if r.get("pid") == os.getpid() or not pid_alive(r.get("pid", 0)):
        return None
    with socket.socket() as s:
        s.settimeout(1.0)
        if s.connect_ex(("127.0.0.1", int(r["port"]))) != 0:
            return None
    return int(r["port"])


def register(src: Path, port):
    registry(src).write_text(json.dumps({"pid": os.getpid(), "port": port, "src": str(src)}), encoding="utf-8")


def unregister(src: Path):
    try:
        f = registry(src)
        if json.loads(f.read_text(encoding="utf-8")).get("pid") == os.getpid():
            f.unlink()
    except (OSError, ValueError):
        pass


def free_port(start):
    for p in range(start, start + 50):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise SystemExit("no free port")


def pick_file():
    if sys.platform == "darwin":
        r = subprocess.run(["osascript", "-e", 'POSIX path of (choose file with prompt "PDF, Markdown or video to review")'],
                           capture_output=True, text=True)
        return r.stdout.strip()
    if sys.platform != "win32":  # Linux (the workstation): GNOME's own dialog
        r = subprocess.run(["zenity", "--file-selection", "--title=PDF, Markdown or video to review",
                            "--file-filter=PDF, Markdown or video | *.pdf *.md *.markdown *.mp4 *.m4v *.mov *.webm *.mkv",
                            "--file-filter=All files | *"], capture_output=True, text=True)
        return r.stdout.strip()
    ps = ("Add-Type -AssemblyName System.Windows.Forms;"
          "$d=New-Object System.Windows.Forms.OpenFileDialog;"
          "$d.Filter='PDF, Markdown or video|*.pdf;*.md;*.markdown;*.mp4;*.m4v;*.mov;*.webm;*.mkv|All files|*.*';"
          "$d.Title='PDF, Markdown or video to review';if($d.ShowDialog() -eq 'OK'){$d.FileName}")
    r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True, text=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return r.stdout.strip()


def open_window(url, window=None, fullscreen=False, isolated=False):
    """window: (x, y, w, h) to place it; fullscreen: the whole screen (two documents, 2026-10-19);
    else maximized. isolated: a browser of its own (own profile, no proxy), for when the normal window
    never reached the app (2026-10-21: travel laptop with a VPN on)."""
    edge = next((e for e in EDGES if e.exists()), None)
    if edge:
        place = (["--start-fullscreen"] if fullscreen else
                 [f"--window-position={window[0]},{window[1]}", f"--window-size={window[2]},{window[3]}"]
                 if window else ["--start-maximized"])
        own = ([f"--user-data-dir={QUEUE.parent / 'window-profile'}", "--no-proxy-server",
                "--proxy-bypass-list=<-loopback>", "--no-first-run", "--no-default-browser-check"] if isolated else [])
        subprocess.Popen([str(edge), f"--app={url}", *own, *place])
    elif sys.platform != "win32" and shutil.which("firefox"):
        subprocess.Popen(["firefox", "--new-window", url])
    else:
        webbrowser.open(url)


def make_fullscreen(title, timeout_s=20):
    """Put the window called `title` in full screen (F11), as Daniel would. Edge ignores
    --start-fullscreen when it is already running (measured 2026-10-19). F11 is sent only when that
    window is in front, so a key never lands in another program."""
    if sys.platform != "win32":
        return
    u = ctypes.windll.user32
    found = ctypes.c_void_p(0)
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def each(h, _):
        n = u.GetWindowTextLengthW(h)
        if n and u.IsWindowVisible(h):
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, buf, n + 1)
            if buf.value.startswith(title):
                found.value = h
                return False
        return True
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        found.value = 0
        u.EnumWindows(proto(each), 0)
        if found.value:
            break
        time.sleep(0.25)
    if not found.value:
        log("  duo: window not found; press F11 for full screen")
        return
    time.sleep(1.0)                                   # let it finish appearing
    # already full screen (a browser that honours --start-fullscreen)? F11 would switch it OFF
    class RECT(ctypes.Structure):
        _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long), ("r", ctypes.c_long), ("b", ctypes.c_long)]
    r = RECT()
    u.GetWindowRect(found.value, ctypes.byref(r))
    u.MonitorFromWindow.restype = ctypes.c_void_p
    u.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    mon = u.MonitorFromWindow(ctypes.c_void_p(found.value), 2)
    class MI(ctypes.Structure):
        _fields_ = [("size", ctypes.c_ulong), ("mon", RECT), ("work", RECT), ("flags", ctypes.c_ulong)]
    mi = MI(); mi.size = ctypes.sizeof(MI)
    if mon and u.GetMonitorInfoW(mon, ctypes.byref(mi)) and \
            (r.l, r.t, r.r, r.b) == (mi.mon.l, mi.mon.t, mi.mon.r, mi.mon.b):
        log("  duo: already full screen")
        return
    u.ShowWindow(found.value, 9)
    u.SetForegroundWindow(found.value)
    time.sleep(0.3)
    if u.GetForegroundWindow() == found.value:
        u.keybd_event(0x7A, 0, 0, 0)                  # F11 down
        u.keybd_event(0x7A, 0, 2, 0)                  # F11 up
        log("  duo: full screen")
    else:
        log("  duo: window not in front; press F11 for full screen")


def main():
    if sys.stdout is None:  # pythonw: no console, log to a file instead
        sys.stdout = sys.stderr = open(Path(tempfile.gettempdir()) / "voice-review.log", "a", encoding="utf-8", buffering=1)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", nargs="?")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--fit", action="store_true", help="no header, page at the window's full height")
    ap.add_argument("--window", help="x,y,w,h: place the window there")
    ap.add_argument("--duo", metavar="OTHER.pdf",
                    help="one full-screen window: this PDF on the left, OTHER.pdf on the right, each with its own comments")
    args = ap.parse_args()

    pdf = args.pdf or pick_file()
    if not pdf:
        sys.exit(0)
    src = Path(pdf).resolve()
    if not src.is_file():
        sys.exit(f"not found: {src}")

    live = None if args.duo else running_session(src)
    if live:
        url = f"http://127.0.0.1:{live}/" + ("?fit=1" if args.fit else "")
        log(f"{src.name} is still open in another session (port {live}), probably finishing its recordings; "
            f"opening a window onto it instead of starting a second one")
        if not args.no_browser:
            open_window(url, tuple(int(v) for v in args.window.split(",")) if args.window else None)
        sys.exit(0)

    ext = src.suffix.lower()
    review = VideoReview(src) if ext in VIDEO_EXTS else MdReview(src) if ext in MD_EXTS else Review(src)
    stt = Transcriber()
    worker = Worker(review, stt)
    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}/" + ("?fit=1" if args.fit else "")
    window = tuple(int(v) for v in args.window.split(",")) if args.window else None
    log(f"reviewing {src}\n  comments save to {review.shown}\n  {url}\n  queue {QUEUE}"
        f"\n  model {MODEL_NAME}, {CPU_THREADS} threads, beam {BEAM}")
    if args.duo and not args.no_browser:
        # Two documents in one full-screen window (Daniel, 2026-10-19): the other PDF gets its own server
        # (its own _review.pdf, its own queue) on the next free port; duo.html shows both halves. Each
        # server exits by itself once the window is closed, as a single window does.
        from urllib.parse import quote
        other = Path(args.duo).resolve()
        if not other.is_file():
            sys.exit(f"not found: {other}")
        port2 = free_port(port + 1)
        subprocess.Popen([sys.executable, "-X", "utf8", str(Path(__file__).resolve()), str(other),
                          "--no-browser", "--port", str(port2)],
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        left = f"http://127.0.0.1:{port}/?fit=1&duo=left"
        right = f"http://127.0.0.1:{port2}/?fit=1&duo=right"
        duo = (f"http://127.0.0.1:{port}/static/duo.html?l={quote(left, safe='')}&r={quote(right, safe='')}"
               f"&t={quote(src.stem + ' + ' + other.stem, safe='')}")
        log(f"  duo: right half {other} on port {port2}")
        title = f"{src.stem} + {other.stem} · voice review"

        def open_duo():
            # the window loads both halves at once: wait until the right half's server answers
            # (measured 2026-10-19: opened too early, the right half stayed empty)
            for _ in range(80):
                with socket.socket() as s:
                    if s.connect_ex(("127.0.0.1", port2)) == 0:
                        break
                time.sleep(0.25)
            open_window(duo, None, True)
            make_fullscreen(title)
        threading.Timer(0.2, open_duo).start()
    # Listen BEFORE the window opens (2026-10-21): on Daniel's travel laptop, in airplane mode, the window
    # came up before the server and showed "no connection to 127.0.0.1". Nothing here needs the internet.
    app = make_app(review, stt, worker)
    server = make_server("127.0.0.1", port, app, threaded=True)
    if not args.duo and not args.no_browser:
        def open_and_check():
            # If the window never asks for the page (a VPN or a proxy in the browser's way), open a second
            # one with a browser profile of its own and no proxy. Its microphone permission is asked once.
            open_window(url, window)
            for _ in range(int(WINDOW_WAIT_S * 4)):
                if app.config["clock"]["opened"]:
                    return
                time.sleep(0.25)
            log(f"  the window did not reach the app in {WINDOW_WAIT_S:.0f} s; opening one that bypasses proxies and VPNs")
            open_window(url, window, isolated=True)
        threading.Thread(target=open_and_check, daemon=True).start()
    if not args.duo:
        register(src, port)
    log(f"  listening on {url}  (version {VERSION})")
    server.serve_forever()


if __name__ == "__main__":
    main()
