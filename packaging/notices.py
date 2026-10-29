# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Write THIRD-PARTY-NOTICES.txt from what is actually bundled (Daniel, 2026-10-21).

    python notices.py <site-packages dir> <out file>

Called by build_portable.py on the staged site-packages, so the list always matches the zip. Each
package's own licence text stays where pip put it, in its *.dist-info folder; this file says what is
there, under which licence, and where to find the full text.
"""
import sys
from email.parser import Parser
from pathlib import Path

HEADER = """VOICE REVIEW: THIRD-PARTY SOFTWARE AND MODELS
=================================================

Voice Review itself is Copyright (C) 2026 Daniel Attinger and is free software under the
GNU Affero General Public License, version 3 or later (LICENSE.txt). It is distributed with, or
downloads at installation, the following software and models made by others, each under its own
licence. Their full licence texts are in python\\Lib\\site-packages\\<name>.dist-info\\ (the
LICENSE, COPYING or licenses\\ files there), or at the address given.

The Attinger Consulting name and logo (app\\static\\attinger-consulting.png) are not covered by the
AGPL; they identify the author and may not be used to suggest endorsement of modified versions.


MODELS (downloaded by Install.bat, not inside the zip)
------------------------------------------------------
Whisper speech models (OpenAI), converted for faster-whisper by SYSTRAN
    large-v3-turbo, small, distil-large-v3, small.en, base.en ............ MIT licence
    https://github.com/openai/whisper/blob/main/LICENSE
Qwen3-4B-Instruct-2507 (Alibaba Qwen team), GGUF conversion by Unsloth
    used by safe mode ..................................................... Apache License 2.0
    https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507


RUNTIME
-------
Python 3.12 embeddable distribution (python\\) ............................ PSF License
    python\\LICENSE.txt
Microsoft Visual C++ runtime (python\\msvcp140*.dll, vcruntime140_1.dll, concrt140.dll)
    redistributable files under the Microsoft Visual Studio licence terms
    https://visualstudio.microsoft.com/license-terms/


PYTHON PACKAGES (python\\Lib\\site-packages)
------------------------------------------
"""

# Packages whose metadata does not state the licence plainly; checked by hand 2026-10-21.
KNOWN = {
    "pymupdf": "GNU AGPL-3.0, or Artifex commercial licence (dual)",
    "av": "BSD-3-Clause; its bundled FFmpeg libraries are LGPL-2.1-or-later",
    "llama_cpp_python": "MIT (includes llama.cpp, MIT)",
    "ctranslate2": "MIT",
    "onnxruntime": "MIT",
    "faster_whisper": "MIT",
    "numpy": "BSD-3-Clause (bundles OpenBLAS, BSD-3-Clause)",
}


def licence_of(meta):
    if meta.get("License-Expression"):
        return meta["License-Expression"]
    lic = (meta.get("License") or "").strip()
    if lic and len(lic) < 80 and "\n" not in lic:
        return lic
    cls = [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    return "; ".join(cls) or (lic.splitlines()[0][:80] if lic else "see its dist-info folder")


def main(site, out):
    rows = []
    for d in sorted(Path(site).glob("*.dist-info"), key=lambda p: p.name.lower()):
        meta = Parser().parsestr((d / "METADATA").read_text(encoding="utf-8", errors="replace"))
        name, ver = meta["Name"], meta["Version"]
        key = name.lower().replace("-", "_")
        rows.append((name, ver, KNOWN.get(key) or licence_of(meta), meta.get("Home-page") or ""))
    w = max(len(f"{n} {v}") for n, v, _, _ in rows) + 2
    body = "".join(f"{(n + ' ' + v).ljust(w, '.')} {lic}\n" for n, v, lic, _ in rows)
    Path(out).write_text(HEADER + body, encoding="utf-8")
    return len(rows)


if __name__ == "__main__":
    print(main(sys.argv[1], sys.argv[2]), "packages")
