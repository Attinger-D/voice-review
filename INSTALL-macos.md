# Installing Voice Review on macOS (untested)

**Nobody has run Voice Review on a Mac yet.** The code has the macOS pieces (data folder, browser
window, file dialog, notifications), but until someone with a Mac confirms that it works, treat this
as a first attempt, and please report what happens.

> **Confidentiality.** Voice Review is made for confidential documents. Your documents, recordings and
> comments never leave your computer: speech recognition and safe mode run on it, and nothing is sent to
> the cloud. The internet is used only during installation, to download two models from Hugging Face.
> **[PRIVACY.md](PRIVACY.md)** lists what is downloaded and from whom (including the Qwen model, by Alibaba
> Cloud, China), how to check the files, how to install without the Qwen model, and every file the app keeps
> on your computer. Give it to your IT or confidentiality officer before installing, if your organization asks.

**You need:**
- Python 3.12 (from python.org or Homebrew: `brew install python@3.12`).
- Xcode command line tools, to compile llama.cpp for safe mode: `xcode-select --install`.
- Brave, Chrome, Chromium or Edge for an app window (Safari works in a normal tab).
- 8 GB of RAM for safe mode, about 5 GB of free disk space, and internet during installation only.

## Install

```
git clone <this repository> voice-review
cd voice-review
bash packaging/linux/install.sh
```

The same script as on Linux (see [INSTALL-linux.md](INSTALL-linux.md) for its options). On a Mac it
compiles llama.cpp (a few minutes, using Apple's Metal), and puts models and settings in
`~/Library/Application Support/VoiceReview`. It adds the command `~/.local/bin/voice-review`; there
is no menu entry or Dock icon. Add `~/.local/bin` to your `PATH` if it is not there.

## Use

```
voice-review paper.pdf
```

The first time, macOS asks whether the browser may use the microphone: allow it.
