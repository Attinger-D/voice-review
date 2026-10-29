# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Markdown review (Daniel, 2026-10-29): comments live inside the .md itself, as CriticMarkup.

    {==the highlighted words==}{>>the comment (DA)<<}

CriticMarkup is plain text that any editor shows and any person or program can read, answer and remove; Markdown
Preview Enhanced (VS Code) renders it as a highlight with its comment when "Enable Critic Markup Syntax" is on.
A comment without highlighted words is a lone {>>...<<}. "✓ " at the start of a comment means Done. What only the
app needs is in an HTML comment right after it, which no Markdown viewer shows: <!--vr:check--> (flagged "may not
be courteous", not yet decided) and <!--vr:id=...--> (a spoken comment still being transcribed, so a clip finished
after a crash finds it).

parse() gives the text without the markup ("clean") and the comments as offsets into it; write() puts them back.
Both are purely textual, so a file always reads back to the same text and comments, whatever its Markdown.
"""
import re

NOTE_MARK = "<!--voice-review-note-->"
DONE_MARK = "✓ "  # ✓
_COMMENT = r"\{>>([\s\S]*?)<<\}"
_META = r"(?:<!--vr:([^>]*?)-->)?"
TOKEN = re.compile(r"\{==([\s\S]*?)==\}(?:" + _COMMENT + r")?" + _META + "|" + _COMMENT + _META)
_NOTE_LINE = re.compile(r"\A(?:[^\n]*" + re.escape(NOTE_MARK) + r"[^\n]*\n(?:[ \t]*\n)?)")
_SIGNED = re.compile(r" \(([^()\s][^()]{0,7})\)$")


def _meta(s):
    out = {}
    for part in (s or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k:
            out[k] = v or True
    return out


def parse(text, pending_note=""):
    """(clean, comments): each comment has id, kind, start, end (offsets in clean), text (the highlighted words),
    comment, and author/signed/done/flag/waiting when they apply."""
    text = text.replace("\r\n", "\n")
    text = _NOTE_LINE.sub("", text, count=1)
    clean, comments, last = [], [], 0
    n = 0
    for m in TOKEN.finditer(text):
        clean.append(text[last:m.start()])
        start = sum(map(len, clean))
        if m.group(1) is not None:
            quote, body, meta = m.group(1), m.group(2), m.group(3)
        else:
            quote, body, meta = "", m.group(4), m.group(5)
        clean.append(quote)
        n += 1
        meta = _meta(meta)
        body = (body or "").strip()
        c = {"id": meta.get("id") if isinstance(meta.get("id"), str) else f"m{n}", "kind": "text",
             "start": start, "end": start + len(quote), "text": " ".join(quote.split()), "page": 0, "rects": [[0, 0, 0, 0]]}
        if pending_note and pending_note in body:
            body = body.replace(pending_note, "").strip()
            c["waiting"] = True
        if body.startswith(DONE_MARK.strip()):
            body = body[len(DONE_MARK.strip()):].strip()
            c["done"] = True
        s = _SIGNED.search(body)
        if s:
            c.update(author=s.group(1), signed=True)
            body = body[:s.start()]
        if quote.startswith("![") or quote.lstrip().startswith("<img"):
            c["kind"] = "area"
        c["comment"] = body
        if meta.get("check"):
            c["flag"] = True
        comments.append(c)
        last = m.end()
    clean.append(text[last:])
    return "".join(clean), comments


def _body(c, sig, table_row, pending_note, waiting):
    body = (c.get("comment") or "").replace(pending_note, "").strip() if pending_note else (c.get("comment") or "").strip()
    # signed: read signed from the file, or new from this window (an unsigned comment someone typed into the file
    # by hand, read in as "m<n>", stays unsigned rather than becoming the reviewer's)
    who = c.get("author") or ("" if str(c["id"]).startswith("m") else sig)
    if body and who and (c.get("signed") or who == sig) and not body.endswith(f" ({who})"):
        body += f" ({who})"
    if waiting:
        body = (body + " " + pending_note).strip()
    if c.get("done") and body:
        body = DONE_MARK + body
    body = re.sub(r"\s*\n\s*", " ", body).replace("<<}", "<< }").replace("==}", "== }")
    if table_row:  # a "|" would end the table cell
        body = body.replace("|", "/")
    return body


def write(clean, comments, sig="", pending=(), pending_note="", note=""):
    """The Markdown text with every comment in it. A comment overlapping an earlier one cannot nest in
    CriticMarkup: it becomes a lone comment after that one, quoting its words, so nothing is lost."""
    pending = set(pending)
    out, pos = [], 0
    cs = sorted(comments, key=lambda c: (c["start"], -c["end"]))
    for c in cs:
        s, e = max(0, min(c["start"], len(clean))), max(0, min(c["end"], len(clean)))
        e = max(s, e)
        waiting = c["id"] in pending or bool(c.get("waiting"))
        line_start = clean.rfind("\n", 0, s) + 1
        table_row = clean[line_start:line_start + 1] == "|" or clean[line_start:s].lstrip().startswith("|")
        meta = ";".join(x for x in ("check" if c.get("flag") else "", f"id={c['id']}" if waiting else "") if x)
        meta = f"<!--vr:{meta}-->" if meta else ""
        body = _body(c, sig, table_row, pending_note, waiting)
        if s < pos:  # overlaps the previous one
            words = " ".join(clean[s:e].split())
            if words and body:
                body = f"[on “{words[:120]}”] {body}"
            elif words:
                body = f"[on “{words[:120]}”]"
            if body or meta:
                out.append("{>>" + body + "<<}" + meta)
            continue
        out.append(clean[pos:s])
        if e > s:
            out.append("{==" + clean[s:e] + "==}" + ("{>>" + body + "<<}" if body else "") + meta)
        elif body or meta:
            out.append("{>>" + body + "<<}" + meta)
        pos = e
    out.append(clean[pos:])
    text = "".join(out)
    if note and comments:  # first, before any comment, as in the PDF; invisible mark so it is removed on reading
        text = f"> *{note}* {NOTE_MARK}\n\n" + text
    return text


# ---------- rendering (the window shows the clean text; comments are drawn by the window) ----------
_IMG_SRC = re.compile(r'(<img\b[^>]*?\bsrc=")(?!(?:[a-z][a-z0-9+.-]*:|/|#))([^"]+)(")', re.I)


def render(clean):
    """HTML of the clean text. Every block carries data-line / data-end (its source lines), which the window
    uses to find a selection's words in the source. Relative images are served by the app (/mdfile/...)."""
    from urllib.parse import quote
    from markdown_it import MarkdownIt
    md = MarkdownIt("commonmark", {"html": True, "linkify": False, "typographer": False})
    md.enable(["table", "strikethrough"])
    tokens = md.parse(clean)
    for t in tokens:
        if t.map and t.nesting >= 0 and t.type not in ("html_block",):
            t.attrSet("data-line", str(t.map[0]))
            t.attrSet("data-end", str(t.map[1]))
    html = md.renderer.render(tokens, md.options, {})
    return _IMG_SRC.sub(lambda m: m.group(1) + "/mdfile/" + quote(m.group(2).replace("\\", "/"), safe="/%") + m.group(3), html)
