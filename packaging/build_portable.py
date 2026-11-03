# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Build the portable Windows zip of Voice Review.

    python build_portable.py [--out VoiceReview-win64.zip]   (default: in the current folder)

Bundles the embeddable CPython 3.12 with every dependency installed, the app, the
comment extractor, and Install.bat / Uninstall.bat / README.txt. The speech model
is not bundled: Install.bat downloads the one the target computer can carry.
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

PY = "3.12.7"
EMBED_URL = f"https://www.python.org/ftp/python/{PY}/python-{PY}-embed-amd64.zip"
DEPS = ["faster-whisper==1.2.1", "pymupdf==1.27.2.2", "flask==3.1.1", "llama-cpp-python==0.3.36",
        "markdown-it-py==3.0.0"]  # Markdown review (2026-10-29)
LLAMA_INDEX = "https://abetlen.github.io/llama-cpp-python/whl/cpu"  # PyPI has only the source; this is the CPU wheel
VC_DLLS = ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140_1.dll", "concrt140.dll"]
HERE = Path(__file__).resolve().parent
SKILL = HERE.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="VoiceReview-win64.zip")  # no computer's own path in the public code
    out = Path(ap.parse_args().out)
    if sys.version_info[:2] != (3, 12):
        sys.exit("run this with Python 3.12, the version that is bundled")

    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / "VoiceReview"
        py = stage / "python"
        py.mkdir(parents=True)
        print("python", PY)
        zpath = Path(tmp) / "embed.zip"
        urllib.request.urlretrieve(EMBED_URL, zpath)
        zipfile.ZipFile(zpath).extractall(py)
        pth = next(py.glob("python3*._pth"))
        pth.write_text(pth.read_text().replace("#import site", "import site") + "Lib\\site-packages\n")

        print("dependencies:", *DEPS)
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--no-compile", "--only-binary=:all:",
                        "--target", str(py / "Lib" / "site-packages"), "--extra-index-url", LLAMA_INDEX,
                        "-c", str(HERE / "constraints.txt"), *DEPS], check=True)
        for whl in (py / "Lib" / "site-packages").glob("*.whl"):  # pip --target leaves one behind
            whl.unlink()
        # The C++ runtime ctranslate2 and onnxruntime need; most PCs have it, a fresh one may not.
        for dll in VC_DLLS:
            src = Path(r"C:\Windows\System32") / dll
            if src.exists() and not (py / dll).exists():
                shutil.copy2(src, py / dll)

        shutil.copytree(SKILL / "app", stage / "app", ignore=shutil.ignore_patterns("__pycache__", "backup_*"))
        (stage / "scripts").mkdir()
        shutil.copy2(SKILL / "scripts" / "extract_review.py", stage / "scripts")
        shutil.copy2(HERE / "installer.py", stage)
        import re
        version = re.search(r'^VERSION = "([^"]+)"', (SKILL / "app" / "server.py").read_text(encoding="utf-8"), re.M).group(1)
        (stage / "VERSION.txt").write_text(f"Voice Review, version {version}\n", encoding="utf-8")
        print("version", version)
        shutil.copy2(HERE / "PRIVACY.md", stage)  # what is downloaded, from whom, what stays (2026-10-22)
        for f in (HERE / "files").iterdir():
            shutil.copy2(f, stage)
        # Licences (2026-10-21): LICENSE.txt (AGPL-3.0) comes from files\; the third-party list is generated
        # from what is really bundled, and kept beside this script for the GitHub repository too.
        sys.path.insert(0, str(HERE))
        import notices
        n = notices.main(py / "Lib" / "site-packages", stage / "THIRD-PARTY-NOTICES.txt")
        shutil.copy2(stage / "THIRD-PARTY-NOTICES.txt", HERE / "THIRD-PARTY-NOTICES.txt")
        print("notices:", n, "packages")

        out.parent.mkdir(parents=True, exist_ok=True)
        tmp_zip = out.with_suffix(".zip.tmp")
        with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for f in sorted(stage.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(stage.parent))
        tmp_zip.replace(out)
        size = sum(f.stat().st_size for f in stage.rglob("*") if f.is_file())
    print(f"{out}  ({out.stat().st_size / 2**20:.0f} MB zipped, {size / 2**20:.0f} MB installed before the model)")


if __name__ == "__main__":
    main()
