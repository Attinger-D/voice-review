# Voice Review

Review a PDF by highlighting a passage and **speaking** your comment. The comment is
transcribed on your own computer and saved as an ordinary PDF comment, which Acrobat,
Edge, Zotero and every other PDF reader can show. Videos can be reviewed the same way:
pause, speak, play on. So can Markdown files: the comments are written into the Markdown itself.

**Watch the 3-minute walkthrough:** `voice-review-walkthrough.mp4` in the
[latest release](../../releases/latest) (also under the **?** button in the app).

Everything runs locally. No audio, text or document ever leaves the computer, so it can
be used on confidential manuscripts, and it works with no internet connection, also in
airplane mode. The internet is needed once, at installation, to download two models from
Hugging Face: Whisper (OpenAI) for speech, and Qwen3-4B-Instruct-2507 (Alibaba Cloud's Qwen
team) for the courtesy check, which you can skip. **[PRIVACY.md](PRIVACY.md)** lists every
download with its source and fingerprint, and every file the app keeps on your computer.

## What it does

- **Highlight and speak.** Drag across text for a yellow highlight, or around a figure
  for a box. Double-click it and talk. You never wait: recordings are queued and
  transcribed in the background while you read on.
- **Courtesy check and safe mode.** Every comment is written exactly as you said it. A
  small language model on your computer checks each one, and marks a comment that may
  not be courteous with a warning: you decide, "Rewrite politely" or "Keep as is". Turn
  on **safe mode** and such comments are rewritten at once, as little as possible, with
  every technical point kept. What it removes is a list of tick boxes, all ticked by default: no
  profanity, no racism, no sexism, no ageism, no personal attacks on the author. Add
  your own rules, or your organization's, with **+**, or a tone: "Be overly polite and
  flattering" or "Make it short and direct" rewrites every comment in that tone.

  | You said | The PDF says |
  |---|---|
  | "Oh, this paragraph makes no sense at all." | "The meaning of this paragraph is difficult to understand. Could you do another pass?" |
  | "Shit, page 12, line 4, it's 37 degrees, not 73." | "Page 12, line 4: the value should be 37 degrees, not 73." |
  | "God, this guy is an idiot. He cites Smith 2019 for the viscosity but Smith never measured it." | "The citation to Smith 2019 for viscosity appears to be incorrect, as Smith did not measure viscosity. Could you verify the reference and update it accordingly?" |

  Read the comments before you send the PDF: the model can lose a nuance.
- **Signed comments.** Type your initials once, and every comment ends with "(DA)";
  Acrobat, Zotero and other readers also show DA as the comment's author.
- **Where comments go.** By default into a copy, `name_review.pdf`, so the original is
  never changed. Or, for Zotero and other reference managers, into the PDF itself.
- **Your original words**, if you want them: each recording kept as an mp3 with what you
  actually said, in a private folder on your computer, never next to the PDF.
- **100 languages.** Tick the ones you speak in the settings; with one ticked, transcription
  is fastest.
- **Video review.** Pause and speak; the comments, with their times, go next to the video in
  `name_review.md`, plain text you can read or send.
- **Markdown review.** Open a `.md` file: it is shown formatted, with its pictures. Select words
  (or click a picture) and speak; the comments go into `name_review.md` as
  [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit), `{==the words==}{>>your comment<<}`,
  plain text that any editor shows, so anyone can read the comments, answer them and update the file.
  In VS Code, Markdown Preview Enhanced shows them as highlights when "Enable Critic Markup Syntax" is on.
- Full screen reading, search, plain-text copy, zoom, crash-safe queue. Keyboard shortcuts
  and answers to common questions are under the **?** button.

> **Confidentiality.** Voice Review is made for confidential documents. Your documents, recordings and
> comments never leave your computer: speech recognition and safe mode run on it, and nothing is sent to
> the cloud. The internet is used only during installation, to download two models from Hugging Face.
> **[PRIVACY.md](PRIVACY.md)** lists what is downloaded and from whom (including the Qwen model, by Alibaba
> Cloud, China), how to check the files, how to install without the Qwen model, and every file the app keeps
> on your computer. Give it to your IT or confidentiality officer before installing, if your organization asks.

## Install (Windows 10 or 11, 64-bit)

1. Download `VoiceReview-win64.zip` from the
   [latest release](../../releases/latest).
2. Right-click the zip > Properties > tick **Unblock** > OK. Then Extract All into a folder
   of your own, such as `Documents\VoiceReview` (not Program Files).
3. Double-click **Install.bat**. It picks a speech model your computer can carry,
   downloads it and the safe-mode model (about 2 to 4 GB, once only), and adds a
   desktop shortcut and a "Send to" entry. This is the only step that needs the internet.

Needs: a Chromium browser (Brave, Chrome, or Edge, which comes with Windows), a
microphone, 8 GB of RAM, about 5 GB of disk. No graphics card. Full instructions are in
`README.txt` inside the zip.

## Install (Linux, macOS)

From source, with one script: [INSTALL-linux.md](INSTALL-linux.md) and
[INSTALL-macos.md](INSTALL-macos.md) (untested on a Mac).

## Models

| Purpose | Model | Licence |
|---|---|---|
| Speech to text | Whisper via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`large-v3-turbo` or `small`, chosen by the installer; 100 languages) | MIT |
| Safe mode | [Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507), 4-bit GGUF, run with [llama.cpp](https://github.com/ggml-org/llama.cpp) | Apache 2.0 |

Both run on the CPU at low priority.

## Build from source

```
python packaging\build_portable.py --out VoiceReview-win64.zip
```

with Python 3.12. It bundles the embeddable CPython and pinned dependencies
(`packaging\constraints.txt`).

## Feedback

Feedback is welcome: a problem, an idea, a language that works badly. Open an
[issue](../../issues), start a [discussion](../../discussions), or write to
daniel@attinger-consulting.com. Please never attach a confidential document: describe the
problem instead.

## About and licence

Made by Daniel Attinger, [Attinger Consulting](https://attinger-consulting.com).

Copyright (C) 2026 Daniel Attinger. Voice Review is free software under the
[GNU Affero General Public License, version 3 or later](LICENSE): you may use, share and
change it, and if you share a changed version you must share its source under the same
licence. It comes with no warranty.

It uses software and models by others, each under its own licence (PyMuPDF under the
AGPL-3.0, the rest under permissive licences such as MIT, BSD and Apache 2.0): see
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt). The Attinger Consulting name and logo
are not covered by the AGPL.
