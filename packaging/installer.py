# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Voice Review installer, run by Install.bat with the bundled Python.

Picks a speech model this computer can carry, writes config.json, and adds a desktop shortcut and a
"Send to" entry. The speech model and the safe-mode model are kept once per computer, in
%LOCALAPPDATA%\\VoiceReview\\models, and downloaded only if they are not there yet: reinstalling, or
unpacking a new version into another folder, reuses them (Daniel, 2026-10-21). Models left in an older
install's folder are moved there. After this, the app never needs the internet.

    Install.bat [--model small.en] [--no-safe-mode] [--no-shortcuts]
"""
import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHARED = Path(os.environ["LOCALAPPDATA"]) / "VoiceReview" / "models"
os.environ["HF_HOME"] = str(SHARED)
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")  # the default 10 s gives up on a slow hotel connection
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"  # harmless on Windows, but alarming to read
os.environ["HF_HUB_VERBOSITY"] = "error"

# Safe mode (2026-10-21): rewrites spoken comments politely, on this computer. Apache-2.0 licence.
# Chosen over Qwen3-1.7B, which kept a remark about a student's origin and invented a figure fix.
SAFE_REPO, SAFE_FILE = "unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"

MODELS = {  # name: (download size, what it is)
    "large-v3-turbo": ("1.6 GB", "most accurate, English, French and 98 other languages, needs a strong CPU"),
    "distil-large-v3": ("1.5 GB", "as accurate in English, English only, needs a strong CPU"),
    "small.en": ("0.5 GB", "good accuracy, English only, fine on an ordinary laptop"),
    "base.en": ("0.15 GB", "fastest, English only, makes more mistakes"),
    "small": ("0.5 GB", "multilingual (French, German, ...), fine on an ordinary laptop"),
}


def fetch(fn, *args, **kw):
    """A download that survives a dropped connection (2026-10-22: a laptop got "peer closed connection
    without sending complete message body" halfway through the speech model). Hugging Face downloads
    resume where they stopped, so each retry continues the same file."""
    for attempt in range(1, 9):
        try:
            return fn(*args, **kw)
        except Exception as e:  # noqa: BLE001
            if attempt == 8:
                raise
            print(f"  The connection dropped ({type(e).__name__}); continuing in {5 * attempt} s (try {attempt + 1} of 8)...")
            time.sleep(5 * attempt)


def ram_gb():
    class MS(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                    ("avail", ctypes.c_ulonglong), ("pf", ctypes.c_ulonglong), ("apf", ctypes.c_ulonglong),
                    ("v", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ext", ctypes.c_ulonglong)]
    m = MS()
    m.len = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.total / 2**30


def physical_cores():
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "(Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum"],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        return int(out)
    except Exception:  # noqa: BLE001
        return max(1, (os.cpu_count() or 2) // 2)


def shortcut(path, target):
    ps = (f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{path}');"
          f"$s.TargetPath='{target}';$s.WorkingDirectory='{ROOT}';$s.WindowStyle=7;"
          "$s.IconLocation='%SystemRoot%\\System32\\imageres.dll,-5307';"
          "$s.Description='Highlight a PDF and dictate comments';$s.Save()")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)


def old_install_dirs():
    """This folder, and the folder the existing desktop shortcut points to (the previous install)."""
    dirs = [ROOT]
    desktop = subprocess.run(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                             capture_output=True, text=True).stdout.strip()
    # the app was called PDF voice review until 2026-10-22: its old shortcut also points to a previous install
    lnk = next((p for p in (Path(desktop) / "Voice Review.lnk", Path(desktop) / "PDF voice review.lnk") if p.exists()),
               Path(desktop) / "Voice Review.lnk")
    if lnk.exists():
        target = subprocess.run(["powershell", "-NoProfile", "-Command",
                                 f"(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}').TargetPath"],
                                capture_output=True, text=True).stdout.strip()
        if target:
            dirs.append(Path(target).parent)
    return [d for d in dict.fromkeys(dirs) if (d / "models").is_dir()]


def adopt_old_models():
    """Move models an older install kept beside itself into the shared folder, instead of downloading them."""
    for d in old_install_dirs():
        old = d / "models"
        for item in list((old / "hub").glob("models--*")) if (old / "hub").is_dir() else []:
            dest = SHARED / "hub" / item.name
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                print(f"Reusing {item.name.split('--')[-1]} from {d}")
                shutil.move(str(item), str(dest))
        for g in (old / "safe").glob("*.gguf") if (old / "safe").is_dir() else []:
            dest = SHARED / "safe" / g.name
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                print(f"Reusing the safe-mode model from {d}")
                shutil.move(str(g), str(dest))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=MODELS)
    ap.add_argument("--no-safe-mode", action="store_true", help="skip the 2.5 GB safe-mode model")
    ap.add_argument("--no-shortcuts", action="store_true")
    a = ap.parse_args()

    ver = (ROOT / "VERSION.txt").read_text(encoding="utf-8").strip() if (ROOT / "VERSION.txt").exists() else "Voice Review"
    print(f"{ver}: setup\n")
    print("Downloads, once per computer, from huggingface.co (no account; your documents are never sent):")
    print("  - a speech-to-text model: Whisper (OpenAI), MIT licence")
    if not a.no_safe_mode:
        print("  - for the courtesy check and safe mode: Qwen3-4B-Instruct-2507 (the Qwen team, Alibaba Cloud,")
        print("    China), Apache 2.0 licence. A file of numbers read on this computer; it never goes online.")
        print("    To install without it: Install.bat --no-safe-mode")
    print("Details and file fingerprints: PRIVACY.md in this folder.\n")
    cores, ram = physical_cores(), ram_gb()
    model = a.model or ("large-v3-turbo" if cores >= 8 and ram >= 15 else "small")
    threads = max(2, min(4, cores // 2))
    print(f"This computer: {cores} CPU cores, {ram:.0f} GB RAM.")
    print(f"Speech model: {model} ({MODELS[model][1]}), {threads} threads.\n")

    cfg_path = ROOT / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    cfg.update({"model": model, "threads": threads})
    cfg.pop("lang", None)  # the language is chosen in the window now (English, Français, ...)
    cfg.setdefault("author", os.environ.get("USERNAME", "Reviewer"))
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    SHARED.mkdir(parents=True, exist_ok=True)
    adopt_old_models()
    from faster_whisper import WhisperModel
    from faster_whisper.utils import _MODELS, download_model
    load = lambda: WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True)
    try:
        download_model(model, local_files_only=True)
        load()  # a folder left by a broken download can lack model.bin (Daniel's laptop, 2026-10-27): try it
        print(f"Speech model: already on this computer, not downloaded again.")
    except Exception:  # noqa: BLE001  (not cached yet, or incomplete)
        stale = SHARED / "hub" / ("models--" + _MODELS[model].replace("/", "--"))
        if stale.exists():
            print("Speech model: the copy on this computer is incomplete (an earlier download stopped); downloading it again.")
            shutil.rmtree(stale, ignore_errors=True)
        print(f"Downloading the speech model from huggingface.co/{_MODELS[model]} ({MODELS[model][0]}, once only)...")
        t0 = time.time()
        fetch(download_model, model)
        print(f"Speech model downloaded ({time.time() - t0:.0f} s).")
    load()
    print("Speech model ready.\n")

    safe_dir = SHARED / "safe"
    if a.no_safe_mode:
        print("Safe mode: skipped (--no-safe-mode).\n")
    elif ram < 7:
        print(f"Safe mode: skipped, it needs about 4 GB of free memory and this computer has {ram:.0f} GB.\n")
    elif (safe_dir / SAFE_FILE).is_file():
        print("Safe mode: model already on this computer, not downloaded again.\n")
    else:
        print(f"Downloading the safe-mode model from huggingface.co/{SAFE_REPO} (2.5 GB, once only)...")
        from huggingface_hub import hf_hub_download
        t0 = time.time()
        fetch(hf_hub_download, SAFE_REPO, SAFE_FILE, local_dir=str(safe_dir))
        print(f"Safe mode ready ({time.time() - t0:.0f} s).\n")

    if not a.no_shortcuts:
        launcher = ROOT / "Voice Review.bat"
        desktop = subprocess.run(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                                 capture_output=True, text=True).stdout.strip()
        sendto = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "SendTo"
        for d in (Path(desktop), sendto):
            (d / "PDF voice review.lnk").unlink(missing_ok=True)  # the old name, before 2026-10-22
            shortcut(d / "Voice Review.lnk", launcher)
            print(f"Shortcut: {d / 'Voice Review.lnk'}")

    size = sum(f.stat().st_size for f in SHARED.rglob("*") if f.is_file()) / 2**30
    print(f"\nModels: {SHARED} ({size:.1f} GB, shared by every copy of the app on this computer).")
    print("\nDone. Double-click 'Voice Review' on the desktop, or right-click a PDF or a video >"
          " Send to > Voice Review.\nThe first time, the browser asks for the microphone: allow it."
          "\nFrom now on the app works without internet, also in airplane mode.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"\nSETUP FAILED: {e}")
        sys.exit(1)
