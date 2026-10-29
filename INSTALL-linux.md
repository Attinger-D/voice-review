# Installing Voice Review on Linux

Voice Review runs from source on Linux. It is written for Ubuntu 24.04 (x86-64); other
distributions should work but have not been tried. Speech and safe mode run on the CPU: no graphics
card is used.

> **Confidentiality.** Voice Review is made for confidential documents. Your documents, recordings and
> comments never leave your computer: speech recognition and safe mode run on it, and nothing is sent to
> the cloud. The internet is used only during installation, to download two models from Hugging Face.
> **[PRIVACY.md](PRIVACY.md)** lists what is downloaded and from whom (including the Qwen model, by Alibaba
> Cloud, China), how to check the files, how to install without the Qwen model, and every file the app keeps
> on your computer. Give it to your IT or confidentiality officer before installing, if your organization asks.

**You need:**
- Python 3.10 or newer (3.12 recommended) with `venv`. On Ubuntu/Debian: `sudo apt install python3-venv`.
- A Chromium browser (Brave, Chrome or Chromium) for an app window; Firefox also works, in a normal
  window.
- `zenity` for the file dialog (installed with GNOME), and a microphone.
- 8 GB of RAM for safe mode, and about 5 GB of free disk space.
- Internet during installation only. Afterwards it works offline.

## Install

```
git clone <this repository> voice-review
cd voice-review
bash packaging/linux/install.sh
```

The script:

1. makes a Python environment in `~/.local/share/voice-review/venv` with the exact package versions
   of `packaging/constraints.txt` (llama.cpp comes ready-built from its CPU wheel index, so no
   compiler is needed);
2. copies the app to `~/.local/share/voice-review`;
3. picks a speech model your computer can carry (`large-v3-turbo` on 8 or more cores and 15 GB or more
   of RAM, otherwise `small`) and downloads it and the safe-mode model (2.5 GB), once per computer, into
   `~/.local/share/VoiceReview/models`;
4. adds the command `voice-review` in `~/.local/bin` and a **Voice Review** menu entry, which also
   appears under right-click > **Open With** on a PDF or a video.

Options (`bash packaging/linux/install.sh --help`):

| Option | What it does |
|---|---|
| `--model small.en` | choose the speech model (`large-v3-turbo`, `distil-large-v3`, `small`, `small.en`, `base.en`) |
| `--no-safe-mode` | skip the 2.5 GB safe-mode model |
| `--prefix DIR` | install the app somewhere else |
| `--python PY` | add the packages to an existing Python environment instead of making one (only missing packages are added; nothing already there is changed) |
| `--wheels DIR` | install from a folder of wheel files, with no internet |
| `--models DIR` | copy the models from `DIR/hub` (speech, Hugging Face cache layout) and `DIR/safe` (`.gguf`) instead of downloading |
| `--no-launcher` | no command and no menu entry |

Running it again updates the app and keeps your models and settings.

## Use

```
voice-review paper.pdf
voice-review talk.mp4
voice-review              # a file dialog opens
```

The first time, the browser asks for the microphone: allow it. Comments are saved in
`paper_review.pdf` beside the original, which is never changed.

## Where things are

| What | Where |
|---|---|
| The app | `~/.local/share/voice-review` (`config.json` there: speech model, threads, author) |
| Models, settings, recording queue | `~/.local/share/VoiceReview` (or `$XDG_DATA_HOME/VoiceReview`) |
| Log, when started from the menu | `/tmp/voice-review.log` |

## Uninstall

```
rm -rf ~/.local/share/voice-review ~/.local/share/VoiceReview
rm ~/.local/bin/voice-review ~/.local/share/applications/voice-review.desktop
```

Your reviewed PDFs and videos are not touched.
