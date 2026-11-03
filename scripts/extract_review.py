# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Extract review comments from an annotated PDF or a reviewed video into numbered Markdown (or JSON).

    python extract_review.py paper_review.pdf [-o comments.md] [--json] [--crops DIR] [--no-context]
    python extract_review.py talk.mp4 [-o comments.md] [--json] [--crops DIR] [--narration]

PDF: reads every highlight, underline, strike-out, rectangle, sticky note and text box,
in page order, with the highlighted text, the comment, and the surrounding paragraph so
the passage can be found in the source (.md / .tex). Works on PDFs from the voice
review app and from Acrobat alike. --crops saves a PNG of each region comment
(figures, tables) so it can be looked at.

Video (or its <name>_review.json): comments in time order, each at the moment the
video was paused. --crops saves the frame shown at each pause (needs ffmpeg).
--narration transcribes the video's own soundtrack once (local faster-whisper, CPU,
cached as <name>_narration.json beside the video) and gives, per comment, what the
video said in the 20 s before the pause: what the reviewer was reacting to.
"""
import argparse
import json
import re
import os
import subprocess
import sys
from pathlib import Path

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv"}
LOOKBACK_S = 20

import fitz

KIND = {fitz.PDF_ANNOT_HIGHLIGHT: "highlight", fitz.PDF_ANNOT_UNDERLINE: "underline",
        fitz.PDF_ANNOT_STRIKE_OUT: "strike-out", fitz.PDF_ANNOT_SQUIGGLY: "squiggly",
        fitz.PDF_ANNOT_SQUARE: "region", fitz.PDF_ANNOT_CIRCLE: "region",
        fitz.PDF_ANNOT_TEXT: "note", fitz.PDF_ANNOT_FREE_TEXT: "text box"}
MARKUP = {fitz.PDF_ANNOT_HIGHLIGHT, fitz.PDF_ANNOT_UNDERLINE, fitz.PDF_ANNOT_STRIKE_OUT, fitz.PDF_ANNOT_SQUIGGLY}


def rects_of(a):
    v = a.vertices or []
    if a.type[0] in MARKUP and len(v) >= 4:
        return [fitz.Quad(v[i:i + 4]).rect for i in range(0, len(v) - 3, 4)]
    return [a.rect]


def inside(w, rects):
    p = fitz.Point((w[0] + w[2]) / 2, (w[1] + w[3]) / 2)
    return any(r.contains(p) for r in rects)


def extract(pdf, context=True, crops=None):
    doc = fitz.open(pdf)
    items = []
    for page in doc:
        words = page.get_text("words")
        blocks = {b[5]: b[4] for b in page.get_text("blocks")}
        for a in page.annots():
            t = a.type[0]
            if t not in KIND:
                continue
            rects = rects_of(a)
            hit = [w for w in words if inside(w, rects)]
            item = {"page": page.number + 1, "label": page.get_label() or "", "kind": KIND[t],
                    "author": a.info.get("title", ""), "text": " ".join(w[4] for w in hit),
                    "comment": (a.info.get("content") or "").strip(),
                    "y": rects[0].y0, "x": rects[0].x0, "rect": [round(c, 1) for c in fitz.Rect(a.rect)]}
            if context and hit and item["kind"] != "region":
                ids = sorted({w[5] for w in hit})
                item["context"] = " ".join(" ".join(blocks.get(i, "").split()) for i in ids)
            if crops and item["kind"] == "region":
                crops.mkdir(parents=True, exist_ok=True)
                f = crops / f"p{page.number + 1:03d}_y{int(rects[0].y0):04d}.png"
                page.get_pixmap(clip=a.rect + (-6, -6, 6, 6), dpi=150).save(f)
                item["image"] = str(f)
            items.append(item)
    items.sort(key=lambda i: (i["page"], i["y"], i["x"]))
    for n, i in enumerate(items, 1):
        i["n"] = n
        del i["x"], i["y"]
    return items


def to_markdown(pdf, items):
    out = [f"# Review comments: {Path(pdf).name}", "",
           f"Source: `{Path(pdf).resolve()}`, {len(items)} comments", ""]
    for i in items:
        where = f"page {i['page']}" + (f" (label {i['label']})" if i["label"] and i["label"] != str(i["page"]) else "")
        out.append(f"## {i['n']}. {where}, {i['kind']}")
        if i["text"]:
            out.append(f"> {i['text']}")
        elif i["kind"] == "region":
            out.append("> [figure / region with no text]")
        out.append("")
        out.append(f"**Comment:** {i['comment'] or '(none)'}")
        if i.get("context") and i["context"] != i["text"]:
            ctx = i["context"] if len(i["context"]) < 900 else i["context"][:900] + " …"
            out += ["", f"Context: {ctx}"]
        if i.get("image"):
            out += ["", f"Image: `{i['image']}`"]
        out.append("")
    return "\n".join(out)


def narration(video: Path):
    """The video's own soundtrack as [{start, end, text}], transcribed once and cached."""
    cache = video.with_name(video.stem + "_narration.json")
    if cache.exists() and cache.stat().st_mtime >= video.stat().st_mtime:
        return json.loads(cache.read_text(encoding="utf-8"))
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from faster_whisper import WhisperModel
    m = WhisperModel(os.environ.get("PDF_REVIEW_MODEL", "distil-large-v3"), device="cpu", compute_type="int8", cpu_threads=4)
    segs, _ = m.transcribe(str(video), language="en", beam_size=5, vad_filter=True)
    out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]
    cache.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    return out


def clock(t):
    t = int(round(t))
    return f"{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def extract_video(review_json: Path, frames=None, with_narration=False):
    data = json.loads(review_json.read_text(encoding="utf-8"))
    video = Path(data["video"])
    segs = narration(video) if with_narration else []
    items = []
    for n, c in enumerate(sorted(data["comments"], key=lambda c: c["t"]), 1):
        t = c["t"]
        item = {"n": n, "t": t, "at": clock(t), "comment": c.get("comment", "").strip()}
        if segs:
            item["video_said"] = " ".join(s["text"] for s in segs if s["end"] > t - LOOKBACK_S and s["start"] < t + 1)
        if frames:
            frames.mkdir(parents=True, exist_ok=True)
            f = frames / f"{n:02d}_{clock(t).replace(':', 'm')}s.png"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", str(max(t - 0.05, 0)), "-i", str(video),
                            "-frames:v", "1", str(f)], check=True)
            item["image"] = str(f)
        items.append(item)
    return items


def video_markdown(review_json: Path, items):
    data = json.loads(review_json.read_text(encoding="utf-8"))
    out = [f"# Review comments: {Path(data['video']).name}", "",
           f"Video: `{data['video']}`, {len(items)} comments. Each time is where the video was paused;",
           "the comment itself may point earlier (\"10 seconds ago\", \"at 1:30\").", ""]
    for i in items:
        out += [f"## {i['n']}. at {i['at']}", "", f"**Comment:** {i['comment'] or '(none)'}"]
        if i.get("video_said"):
            out += ["", f"Video said in the {LOOKBACK_S} s before: {i['video_said']}"]
        if i.get("image"):
            out += ["", f"Frame: `{i['image']}`"]
        out.append("")
    return "\n".join(out)


def extract_md(path: Path):
    """A Markdown review (2026-10-29): the CriticMarkup comments, numbered in reading order, each with its
    highlighted words and the paragraph around them (search the source .md with that paragraph)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
    import md_review
    clean, cs = md_review.parse(path.read_text(encoding="utf-8-sig"))
    items = []
    for n, c in enumerate(sorted(cs, key=lambda c: c["start"]), 1):
        ps = clean.rfind("\n\n", 0, c["start"])
        ps = ps + 2 if ps >= 0 else 0
        pe = clean.find("\n\n", c["end"])
        pe = len(clean) if pe < 0 else pe
        heading = ([""] + re.findall(r"^#{1,6}[ \t]+(.+)$", clean[:c["start"]], re.M))[-1]
        items.append({"n": n, "kind": "picture" if c["kind"] == "area" else "text", "section": heading.strip(),
                      "line": clean.count("\n", 0, c["start"]) + 1, "text": c["text"], "comment": c["comment"],
                      "author": c.get("author", ""), "done": bool(c.get("done")), "flagged": bool(c.get("flag")),
                      "paragraph": " ".join(clean[ps:pe].split())})
    return items


def md_markdown(path: Path, items):
    out = [f"# Comments in {path.name}", "", f"{len(items)} comments. Line numbers are in the text without the comments.", ""]
    for it in items:
        out += [f"## {it['n']}. line {it['line']}" + (f", {it['section']}" if it["section"] else "")
                + (" (done)" if it["done"] else "") + (" (flagged: may not be courteous)" if it["flagged"] else ""), ""]
        if it["text"]:
            out += [f"> {it['text']}", ""]
        out += [f"**Comment{' by ' + it['author'] if it['author'] else ''}:** {it['comment'] or '(no comment)'}", ""]
        if it["paragraph"] and it["paragraph"] != it["text"]:
            out += [f"Paragraph: {it['paragraph'][:600]}", ""]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("-o", "--out")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--crops", type=Path)
    ap.add_argument("--no-context", action="store_true")
    ap.add_argument("--narration", action="store_true", help="video: add what the video said before each pause")
    a = ap.parse_args()
    src = Path(a.pdf)
    if src.suffix.lower() in (".md", ".markdown"):
        items = extract_md(src)
        text = json.dumps(items, indent=1, ensure_ascii=False) if a.json else md_markdown(src, items)
    elif src.suffix.lower() in VIDEO_EXTS or src.name.endswith("_review.json"):
        rj = src if src.suffix == ".json" else src.with_name(src.stem + "_review.json")
        items = extract_video(rj, a.crops, a.narration)
        text = json.dumps(items, indent=1, ensure_ascii=False) if a.json else video_markdown(rj, items)
    else:
        items = extract(a.pdf, not a.no_context, a.crops)
        text = json.dumps(items, indent=1, ensure_ascii=False) if a.json else to_markdown(a.pdf, items)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"{len(items)} comments -> {a.out}")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(text)


if __name__ == "__main__":
    main()
