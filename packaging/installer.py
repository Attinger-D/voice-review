# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Voice Review installer, run by Install.bat with the bundled Python.

Asks where to install, like other programs, with C:\\Program Files\\Voice Review as the default, and copies
the app there (Windows asks once for permission when the folder needs it; Daniel, 2026-11-03: "it says
installing on Downloads ... I want that"). Then picks a speech model this computer can carry, writes the
user's config.json, adds a desktop shortcut, a "Send to" entry and an entry in Settings > Apps. The speech
model and the safe-mode model are kept once per computer, in %LOCALAPPDATA%\\VoiceReview\\models, and
downloaded only if they are not there yet: reinstalling, or unpacking a new version into another folder,
reuses them (Daniel, 2026-10-21). Models left in an older install's folder are moved there. After this,
the app never needs the internet.

    Install.bat [--dir FOLDER | --here] [--model small.en] [--no-safe-mode] [--no-shortcuts]
    Uninstall.bat  (= installer.py --uninstall)
"""
import argparse
import base64
import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import winreg
from pathlib import Path

ROOT = Path(__file__).resolve().parent  # where Install.bat was double-clicked: the unzipped folder
DATA = Path(os.environ["LOCALAPPDATA"]) / "VoiceReview"
SHARED = DATA / "models"
# the user's own settings: the install folder may be Program Files, which only an administrator can write
USER_CONFIG = DATA / "config.json"
APP_NAME = "Voice Review"
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceReview"  # per user, no admin needed
ICON = r"%SystemRoot%\System32\imageres.dll,-5307"
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


def ps_quote(s):
    return "'" + str(s).replace("'", "''") + "'"


def powershell(script, **kw):
    """Run a PowerShell script passed as -EncodedCommand, so paths with spaces or quotes need no escaping."""
    enc = base64.b64encode(script.encode("utf-16-le")).decode()
    return subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], **kw)


def shortcut(path, target, workdir):
    ps = (f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut({ps_quote(path)});"
          f"$s.TargetPath={ps_quote(target)};$s.WorkingDirectory={ps_quote(workdir)};$s.WindowStyle=7;"
          f"$s.IconLocation={ps_quote(ICON)};"
          "$s.Description='Highlight a PDF and dictate comments';$s.Save()")
    powershell(ps, check=True)


# ---- where to install (Daniel, 2026-11-03) ----

def same_dir(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def registered_dir():
    """The folder of an earlier install, from its entry in Settings > Apps."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as k:
            d = Path(winreg.QueryValueEx(k, "InstallLocation")[0])
            return d if (d / "Voice Review.bat").exists() else None
    except OSError:
        return None


def default_dir():
    return registered_dir() or Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / APP_NAME


def with_app_name(p):
    """Like other installers: choosing D:\\Apps means D:\\Apps\\Voice Review, never the bare folder."""
    p = Path(os.path.expandvars(str(p).strip().strip('"'))).resolve()
    return p if p.name.lower() in ("voice review", "voicereview") else p / APP_NAME


ASK_FORM = r"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$font = New-Object System.Drawing.Font('Segoe UI', 10)
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Voice Review setup'; $f.Font = $font; $f.ClientSize = New-Object System.Drawing.Size(560, 190)
$f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.TopMost = $true
$l = New-Object System.Windows.Forms.Label; $l.Text = 'Install Voice Review in this folder:'; $l.SetBounds(16, 16, 520, 24)
$t = New-Object System.Windows.Forms.TextBox; $t.Text = __DEFAULT__; $t.SetBounds(16, 44, 420, 28)
$b = New-Object System.Windows.Forms.Button; $b.Text = 'Browse...'; $b.SetBounds(446, 42, 98, 30)
$n = New-Object System.Windows.Forms.Label; $n.SetBounds(16, 82, 528, 54)
$n.Text = __NOTE__
$ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Install'; $ok.SetBounds(338, 144, 98, 32)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$c = New-Object System.Windows.Forms.Button; $c.Text = 'Cancel'; $c.SetBounds(446, 144, 98, 32)
$c.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$b.Add_Click({
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = 'Choose the folder to install Voice Review in'
  $p = $t.Text; while ($p -and -not (Test-Path -LiteralPath $p)) { $p = Split-Path $p }
  if ($p) { $d.SelectedPath = $p }
  if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) {
    $s = $d.SelectedPath
    if ((Split-Path $s -Leaf) -notin @('Voice Review', 'VoiceReview')) { $s = Join-Path $s 'Voice Review' }
    $t.Text = $s
  }
})
$f.Controls.AddRange(@($l, $t, $b, $n, $ok, $c)); $f.AcceptButton = $ok; $f.CancelButton = $c
$r = $f.ShowDialog()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('OK|' + $t.Text) } else { Write-Output 'CANCEL' }
"""


def ask_dir(default, note):
    """The setup window: a folder box with Browse..., Install and Cancel. Falls back to a question in this
    console if no window can be shown. Returns None when cancelled."""
    script = ASK_FORM.replace("__DEFAULT__", ps_quote(default)).replace("__NOTE__", ps_quote(note))
    try:
        out = powershell(script, capture_output=True, timeout=3600).stdout.decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001
        out = ""
    if out == "CANCEL":
        return None
    if out.startswith("OK|") and out[3:].strip():
        return with_app_name(out[3:])
    answer = input(f"Install Voice Review in\n  {default}\nPress Enter to accept, or type another folder: ").strip()
    return with_app_name(answer or default)


def writable(d):
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / f".write-test-{os.getpid()}"
        probe.write_text("x")
        probe.unlink()
        return True
    except OSError:
        return False


def copy_app(src, dst):
    """Copy the unzipped app into dst, replacing an earlier version there. A Program Files folder needs an
    administrator: Windows then asks once for permission. Returns None on success, else what went wrong."""
    if dst.exists() and any(dst.iterdir()) and not (dst / "Voice Review.bat").exists():
        return f"{dst} already holds other files. Choose an empty folder, or the folder of an earlier Voice Review install."
    # /MIR replaces an older version's files (only in a Voice Review folder, checked above); the config.json
    # and models of very old installs, at the top of the folder only, are kept. Full paths: a bare name
    # matches at every depth, and "/XD models" left out ctranslate2\models, so no comment could be
    # transcribed (Daniel's Windows laptop, 2026-11-03). Compiling the Python files once here keeps the app's
    # start quick in a folder it may not write to.
    cmd = (f'@echo off\r\nrobocopy "{src}" "{dst}" /MIR /XF "{dst}\\config.json" /XD "{dst}\\models" '
           '/R:2 /W:1 /NFL /NDL /NJH /NJS /NP >nul\r\n'
           'if %errorlevel% GEQ 8 exit /b 8\r\n'
           f'"{dst}\\python\\python.exe" -m compileall -q "{dst}\\app" >nul 2>&1\r\n'
           'exit /b 0\r\n')
    bat = Path(tempfile.gettempdir()) / f"voice-review-copy-{os.getpid()}.cmd"
    bat.write_text(cmd, encoding="mbcs")
    try:
        if writable(dst):
            rc = subprocess.run(["cmd", "/c", str(bat)]).returncode
        else:
            print("Windows will ask for permission to write in this folder: click Yes.")
            r = powershell(f"try {{ $p = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', "
                           f"{ps_quote(chr(34) + str(bat) + chr(34))} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; "
                           "exit $p.ExitCode } catch { exit 1223 }")
            rc = r.returncode
            if rc == 1223:
                return "Windows did not give permission (you clicked No)."
    finally:
        bat.unlink(missing_ok=True)
    if rc != 0 or not (dst / "Voice Review.bat").exists():
        return (f"Copying into {dst} failed. If Voice Review is open, close it, wait until nothing is "
                "being transcribed, and run Install.bat again.")
    return None


def choose_and_copy(args):
    """Where the app will live. --here keeps the unzipped folder (as before 2026-11-03)."""
    if args.here:
        return ROOT
    target = with_app_name(args.dir) if args.dir else None
    note = ("Program Files needs your permission once: Windows will ask. Your speech models and settings are "
            "kept separately, in your own user folder, and are shared by every version.")
    while True:
        if target is None:
            target = ask_dir(default_dir(), note)
            if target is None:
                print("Setup cancelled. Nothing was installed.")
                sys.exit(1)
        if same_dir(target, ROOT):
            return ROOT
        print(f"Installing Voice Review in {target} ...")
        err = copy_app(ROOT, target)
        if err is None:
            return target
        print(f"  {err}\n")
        if args.dir:
            raise RuntimeError(err)
        note = err + " Choose another folder, or click Install to try again."
        target = None


def requeue_failed():
    """Recordings given up after three tries go back into the queue, so a reinstall is a second chance. The
    2026-11-03b installer left the speech engine out of its copy and every comment failed (Daniel's Windows
    laptop); the recordings were kept in failed\\. The app transcribes them the next time any document is
    opened, and the text replaces the "could not be transcribed" warning in the comment."""
    failed, queue = DATA / "failed", DATA / "queue"
    n = 0
    for j in sorted(failed.glob("*.json")) if failed.is_dir() else []:
        audio = next((p for p in failed.glob(j.stem + ".*") if p.suffix != ".json"), None)
        try:
            job = json.loads(j.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if audio is None:
            continue
        job["tries"] = 0
        queue.mkdir(parents=True, exist_ok=True)
        os.replace(audio, queue / audio.name)
        (queue / j.name).write_text(json.dumps(job), encoding="utf-8")
        j.unlink()
        n += 1
    return n


def folder_size_kb(d):
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file()) // 1024


def register(install_dir, version):
    """An entry in Settings > Apps (and Control Panel > Programs), for this user, pointing at Uninstall.bat."""
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as k:
        for name, value in (("DisplayName", APP_NAME), ("DisplayVersion", version.split()[-1]),
                            ("Publisher", "Attinger Consulting"), ("InstallLocation", str(install_dir)),
                            ("DisplayIcon", ICON), ("URLInfoAbout", "https://github.com/Attinger-D/voice-review"),
                            ("UninstallString", f'"{install_dir / "Uninstall.bat"}"')):
            winreg.SetValueEx(k, name, 0, winreg.REG_EXPAND_SZ if name == "DisplayIcon" else winreg.REG_SZ, value)
        for name in ("NoModify", "NoRepair"):
            winreg.SetValueEx(k, name, 0, winreg.REG_DWORD, 1)
        winreg.SetValueEx(k, "EstimatedSize", 0, winreg.REG_DWORD, folder_size_kb(install_dir))


def lnk_target(lnk):
    return powershell(f"(New-Object -ComObject WScript.Shell).CreateShortcut({ps_quote(lnk)}).TargetPath",
                      capture_output=True, text=True).stdout.strip()


def shortcut_dirs():
    """Desktop, right-click > Send to, and the Start menu."""
    desktop = subprocess.run(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                             capture_output=True, text=True).stdout.strip()
    roaming = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows"
    return [Path(desktop), roaming / "SendTo", roaming / "Start Menu" / "Programs"]


def uninstall():
    """Uninstall.bat: remove the shortcuts, the Settings > Apps entry and this folder (asking Windows for
    permission when it is in Program Files). The models, settings and unfinished recordings in
    %LOCALAPPDATA%\\VoiceReview are kept, and the reviewed PDFs are never touched."""
    print(f"This removes Voice Review from\n  {ROOT}\nand its shortcuts. Your reviewed PDFs are not touched.")
    print(f"The speech and safe-mode models (3 to 4 GB), your settings and any unfinished recording stay in\n"
          f"  {DATA}\nso a reinstall does not download them again. Delete that folder to free the space.\n")
    running = powershell("Get-Process python, pythonw -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "
                         f"{ps_quote(str(ROOT) + chr(92) + '*')} -and $_.Id -ne {os.getpid()} }} | Measure-Object | "
                         "Select-Object -ExpandProperty Count", capture_output=True, text=True).stdout.strip()
    if running not in ("", "0"):
        print("Voice Review is still running (it may be finishing a transcription). Close its window, wait a\n"
              "minute, and run Uninstall again.")
        input("Press Enter to close.")
        return
    input("Press Enter to uninstall, or close this window to cancel. ")
    for d in shortcut_dirs():
        for name in ("Voice Review.lnk", "PDF voice review.lnk"):  # the app was called PDF voice review until 2026-10-22
            lnk = d / name
            if lnk.exists() and lnk_target(lnk).lower().startswith(str(ROOT).lower() + "\\"):  # not another copy's
                lnk.unlink()
    if same_dir(registered_dir() or "", ROOT):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
        except OSError:
            pass
    # this Python runs from the folder, so the folder is removed after it exits, by a hidden PowerShell
    remove = (f"Wait-Process -Id {os.getpid()} -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; "
              f"Remove-Item -LiteralPath {ps_quote(ROOT)} -Recurse -Force -ErrorAction SilentlyContinue")
    enc = base64.b64encode(remove.encode("utf-16-le")).decode()
    args = f"'-NoProfile','-WindowStyle','Hidden','-EncodedCommand','{enc}'"
    verb = "" if writable(ROOT) else " -Verb RunAs"
    if verb:
        print("Windows will ask for permission to delete the program folder: click Yes.")
    powershell(f"Start-Process powershell -ArgumentList {args} -WindowStyle Hidden{verb}")
    print("Voice Review is uninstalled. Its folder is removed when this window closes.")
    input("Press Enter to close.")


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
    ap.add_argument("--dir", help="install in this folder without asking (default: ask, Program Files)")
    ap.add_argument("--here", action="store_true", help="run from the unzipped folder, as before 2026-11-03")
    ap.add_argument("--uninstall", action="store_true", help=argparse.SUPPRESS)  # Uninstall.bat
    a = ap.parse_args()
    if a.uninstall:
        return uninstall()

    ver = (ROOT / "VERSION.txt").read_text(encoding="utf-8").strip() if (ROOT / "VERSION.txt").exists() else "Voice Review"
    print(f"{ver}: setup\n")
    home = choose_and_copy(a)
    print(f"Voice Review is installed in {home}\n")
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

    # the user's config.json, which the app reads over the install folder's (kept from older installs)
    cfg = {}
    for p in (home / "config.json", USER_CONFIG):
        if p.exists():
            cfg.update(json.loads(p.read_text(encoding="utf-8")))
    cfg.update({"model": model, "threads": threads})
    cfg.pop("lang", None)  # the language is chosen in the window now (English, Français, ...)
    cfg.setdefault("author", os.environ.get("USERNAME", "Reviewer"))
    USER_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    USER_CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

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
        launcher = home / "Voice Review.bat"
        for d in shortcut_dirs():
            d.mkdir(parents=True, exist_ok=True)
            (d / "PDF voice review.lnk").unlink(missing_ok=True)  # the old name, before 2026-10-22
            shortcut(d / "Voice Review.lnk", launcher, home)
            print(f"Shortcut: {d / 'Voice Review.lnk'}")
        if not a.here:
            register(home, ver)
            print("Listed in Settings > Apps, where it can be uninstalled.")

    n = requeue_failed()
    if n:
        print(f"\n{n} spoken comment(s) that could not be transcribed earlier are queued again: they are written"
              " into their documents the next time you open any document with Voice Review.")

    size = sum(f.stat().st_size for f in SHARED.rglob("*") if f.is_file()) / 2**30
    print(f"\nModels: {SHARED} ({size:.1f} GB, shared by every copy of the app on this computer).")
    print("\nDone. Double-click 'Voice Review' on the desktop or in the Start menu, or right-click a PDF or a"
          " video > Send to > Voice Review.\nThe first time, the browser asks for the microphone: allow it."
          "\nFrom now on the app works without internet, also in airplane mode.")
    if not same_dir(home, ROOT):
        print(f"\nThe unzipped folder is no longer needed; you can delete it:\n  {ROOT}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"\nSETUP FAILED: {e}")
        sys.exit(1)
