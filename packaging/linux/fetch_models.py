# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Voice Review on Linux / macOS: pick a speech model, put it and the safe-mode model in place, write
config.json. Run by install.sh; the Windows equivalent is ../installer.py (2026-10-22).

Models are kept once per computer (~/.local/share/VoiceReview/models on Linux). With --from DIR they
are copied from DIR/hub (Hugging Face cache layout) and DIR/safe/*.gguf, for a computer with no internet;
otherwise downloaded once.

    python fetch_models.py --prefix ~/.local/share/voice-review [--from DIR] [--model NAME] [--no-safe-mode]
"""
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--prefix", required=True, help="the installed app (holds app/ and config.json)")
ap.add_argument("--from", dest="src", help="copy models from here instead of downloading")
ap.add_argument("--model", choices=("large-v3-turbo", "distil-large-v3", "small.en", "base.en", "small"))
ap.add_argument("--no-safe-mode", action="store_true")
a = ap.parse_args()

PREFIX = Path(a.prefix).expanduser().resolve()
sys.path.insert(0, str(PREFIX / "app"))
from safe_mode import data_dir  # noqa: E402

SHARED = data_dir() / "models"
os.environ["HF_HOME"] = str(SHARED)
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")  # the default 10 s gives up on a slow hotel connection
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")
os.environ["HF_HUB_VERBOSITY"] = "error"
# the same choices as the Windows installer
SAFE_REPO, SAFE_FILE = "unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"


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


def physical_cores():
    try:  # Linux: distinct (socket, core) pairs
        ids, phys = set(), "0"
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            k, _, v = line.partition(":")
            if k.strip() == "physical id":
                phys = v.strip()
            elif k.strip() == "core id":
                ids.add((phys, v.strip()))
        if ids:
            return len(ids)
    except OSError:
        pass
    return max(1, (os.cpu_count() or 2) // 2)


def ram_gb():
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except (ValueError, OSError, AttributeError):
        return 8.0


def copy_tree(src, dest):
    """Copy what is not there yet; a model already on this computer is never copied twice."""
    n = 0
    for f in src.rglob("*"):
        t = dest / f.relative_to(src)
        if f.is_dir() or t.exists():
            continue
        t.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, t)
        n += 1
    return n


cores, ram = physical_cores(), ram_gb()
model = a.model or ("large-v3-turbo" if cores >= 8 and ram >= 15 else "small")
threads = max(2, min(4, cores // 2))
print(f"    this computer: {cores} CPU cores, {ram:.0f} GB RAM -> speech model {model}, {threads} threads")
print(f"    models folder: {SHARED}")

if a.src:
    src = Path(a.src)
    if (src / "hub").is_dir():
        print(f"    copied {copy_tree(src / 'hub', SHARED / 'hub')} speech-model files from {src / 'hub'}")
    if (src / "safe").is_dir() and not a.no_safe_mode:
        print(f"    copied {copy_tree(src / 'safe', SHARED / 'safe')} safe-mode file(s) from {src / 'safe'}")

from faster_whisper import WhisperModel  # noqa: E402
from faster_whisper.utils import _MODELS, download_model  # noqa: E402

try:
    download_model(model, local_files_only=True)
    print("    speech model: on this computer")
except Exception:  # noqa: BLE001  (not there yet)
    print(f"    downloading the speech model Whisper (OpenAI, MIT licence) from huggingface.co/{_MODELS[model]} (once only)...")
    t0 = time.time()
    fetch(download_model, model)
    print(f"    downloaded ({time.time() - t0:.0f} s)")
WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True)
print("    speech model ready")

if a.no_safe_mode:
    print("    safe mode: skipped (--no-safe-mode)")
elif (SHARED / "safe" / SAFE_FILE).is_file():
    print("    safe mode: model on this computer")
elif ram < 7:
    print(f"    safe mode: skipped, it needs about 4 GB of free memory and this computer has {ram:.0f} GB")
else:
    print("    downloading the safe-mode model Qwen3-4B-Instruct-2507 (the Qwen team, Alibaba Cloud, China; Apache 2.0)")
    print(f"    from huggingface.co/{SAFE_REPO} (2.5 GB, once only; skip it with --no-safe-mode; see PRIVACY.md)...")
    from huggingface_hub import hf_hub_download
    fetch(hf_hub_download, SAFE_REPO, SAFE_FILE, local_dir=str(SHARED / "safe"))
try:
    import llama_cpp
    print(f"    safe-mode engine: llama-cpp-python {llama_cpp.__version__}")
except ImportError as e:
    print(f"    WARNING: safe mode will not work, llama-cpp-python is missing ({e})")

cfg_path = PREFIX / "config.json"
cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
cfg.update({"model": model, "threads": threads})
cfg.pop("lang", None)  # the language is chosen in the window
cfg.setdefault("author", os.environ.get("USER", "Reviewer"))
cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
print(f"    settings: {cfg_path}")
