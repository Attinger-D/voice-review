# Voice Review: privacy and confidentiality

Voice Review is meant for confidential documents: manuscripts under review, reports, legal and
medical files. This page says exactly what goes over the internet, when, to whom, and what is
written to your computer, so that you, or your IT and confidentiality officers, can check it.

## In short

- **Using the app needs no internet, and the app makes no internet connection.** Your documents,
  your voice and your comments are processed on your computer and stay there.
- **Installing it downloads two models**, once per computer, from Hugging Face: a speech-to-text
  model (Whisper, by OpenAI) and, for the courtesy check and safe mode, a language model
  (**Qwen3-4B-Instruct-2507, by the Qwen team of Alibaba Cloud, China**). Both are listed below with
  their exact source and a fingerprint you can verify. You can skip the second one, or install
  without any internet access at all.
- Attinger Consulting receives nothing: no account, no licence check, no usage statistics, no
  update check, no crash reports.

## 1. What the installation downloads

`Install.bat` (Windows) or `install.sh` (Linux, macOS) downloads the following, and only this,
from `huggingface.co`, the public model library run by Hugging Face, Inc. (USA). No account is
used. Hugging Face sees an ordinary download request: your IP address and the version numbers of
the download library. It does not see any document, recording or comment: there are none yet.

| Purpose | Model | Made by | Downloaded from | Licence | Size |
|---|---|---|---|---|---|
| Speech to text (computers with 8+ cores and 15+ GB of memory) | Whisper large-v3-turbo | OpenAI (USA); converted for faster-whisper by Mobius Labs GmbH (Germany) | `mobiuslabsgmbh/faster-whisper-large-v3-turbo`, which Hugging Face now lists under the account `dropbox-dash` | MIT | 1.6 GB |
| Speech to text (lighter computers) | Whisper small | OpenAI (USA); converted by SYSTRAN (France) | `Systran/faster-whisper-small` | MIT | 0.5 GB |
| Courtesy check and safe mode | Qwen3-4B-Instruct-2507, 4-bit | The Qwen team, Alibaba Cloud (China); 4-bit file by Unsloth AI (USA) | `unsloth/Qwen3-4B-Instruct-2507-GGUF`, file `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | Apache 2.0 | 2.5 GB |

Other speech models are used only when someone asks for them (`Install.bat --model ...`):
`small.en`, `base.en` and `distil-large-v3`, all from SYSTRAN's account, MIT licence.

On Linux and macOS, `install.sh` also downloads the Python packages the app needs, from the Python
Package Index (`pypi.org` and its file server `files.pythonhosted.org`); on Linux, llama.cpp's
ready-built package comes from `abetlen.github.io`. With `install.sh --wheels <folder>` these come
from a folder instead, with no internet. On Windows they are already inside the zip.

### Why a model from China, and what it can and cannot do

The courtesy check needs a small language model that runs on an ordinary laptop with no graphics
card, follows rules such as "no personal attacks" reliably in English and French, and has a licence
that allows free use. Qwen3-4B-Instruct did this best in our tests; a smaller model from the same
family kept a remark about a person's origin and invented a correction, and was rejected.

A model file is **not a program**. It is a large table of numbers (the GGUF format) that the
open-source program llama.cpp reads on your computer. It cannot open a network connection, read
your files, or run code of its own. The app gives it only the text of one comment at a time and
takes back the rewritten text. Whisper's file (`model.bin`, the CTranslate2 format) is likewise
numbers, read by the open-source program CTranslate2.

**If your organization does not accept this model, or wants none:**
- install without it: `Install.bat --no-safe-mode` (Linux, macOS: `install.sh --no-safe-mode`).
  Comments are then written exactly as spoken, with no courtesy check and no safe mode. Nothing
  else changes;
- or use another model your organization has approved, in the same GGUF format: set the
  environment variable `PDF_REVIEW_SAFE_MODEL` to its file. Safe mode's quality then depends on
  that model.

### Checking the files

The fingerprints (SHA-256) of the files Voice Review was tested with, as published by Hugging Face:

| File | SHA-256 |
|---|---|
| `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |
| `model.bin` of Whisper large-v3-turbo | `e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da` |

On Windows: `certutil -hashfile <file> SHA256`. On Linux or macOS: `sha256sum <file>` or
`shasum -a 256 <file>`. The files are in the models folder listed in section 4.

### Installing with no internet at all

Copy the `models` folder (section 4) from a computer that already has it, onto the new computer,
in the same place, before running the installer. The installer finds the models and downloads
nothing. Then disconnect the computer, or block the app in the firewall, and it works as before.

## 2. While you use it

- **No internet connection is made by the app.** Both models are loaded with downloading switched
  off. You can check this: turn on airplane mode, or block `python.exe` / `pythonw.exe` of the app's
  folder in the firewall. Everything keeps working.
- **The app is reachable only from your own computer.** It runs a small local web server that
  listens on `127.0.0.1`, the address of the computer itself; other computers on the network,
  and the internet, cannot reach it.
- **The window is your own browser** (Brave, Chrome or Edge on Windows), opened on that local
  address. The page loads nothing from the internet: no fonts, scripts, images or analytics.
  The browser program itself may still contact its maker, as it always does (updates, for
  example); that is the browser, not Voice Review, and it does not see your recordings.
- **The microphone** records in that browser window while you dictate a comment. The recording
  goes to the local app only.
- The one internet link in the app is the Attinger Consulting logo. It opens a web page only if
  you click it.

## 3. What travels with your document

Comments are written into `name_review.pdf`, beside the original, which is never changed (or,
if you choose it in Settings, into the PDF itself). In the PDF, each comment carries:

- the text of the comment, as transcribed (or as rewritten by safe mode);
- an author: **your initials if you set them in Settings, otherwise the name in the app's
  `config.json`, which the installer sets to your Windows user name**. Set your initials, or edit
  `config.json`, if your user name should not appear;
- a marker `voice-review` used by the app to find its own comments.

**Recordings never go into the PDF.** For a video, the comments go into `name_review.json` and
`name_review.md` beside the video.

## 4. What is kept on your computer

| What | Where (Windows; Linux: `~/.local/share/VoiceReview`; macOS: `~/Library/Application Support/VoiceReview`) | How long |
|---|---|---|
| Recordings waiting to be transcribed, with a small file saying which comment they belong to | `%LOCALAPPDATA%\VoiceReview\queue` | deleted as soon as the comment is in the PDF; if the PDF is locked by another program, the text waits there too until it can be written |
| Recordings that could not be transcribed after three tries | `%LOCALAPPDATA%\VoiceReview\failed` | until you delete them; the app tells you when this happens |
| Your original words: each recording as mp3 and what you said | `%LOCALAPPDATA%\VoiceReview\originals` | **only if you tick "keep my recordings" in Settings (off by default)**; until you delete them; never beside the PDF |
| Settings: options, initials, safe-mode rules | `%LOCALAPPDATA%\VoiceReview\settings.json` | until uninstalled |
| Which documents are open (file path, process number) | `%LOCALAPPDATA%\VoiceReview\open` | removed when the document is closed |
| The models | `%LOCALAPPDATA%\VoiceReview\models` | until uninstalled |
| A log: times, file names, errors | `%TEMP%\voice-review.log` (Linux, macOS: `/tmp/voice-review.log`) | until Windows cleans the temporary folder, or you delete it |

The log never contains recordings. It contains document file names, and in one rare case the text
of a comment: when a comment's place in the PDF can no longer be found (the PDF was changed by
another program in the meantime), its text is written to the log so that it is not lost.

## 5. Removing everything

Run `Uninstall.bat`, delete the app's folder, then delete `%LOCALAPPDATA%\VoiceReview` and
`%TEMP%\voice-review.log`. On Linux:
`rm -rf ~/.local/share/voice-review ~/.local/share/VoiceReview /tmp/voice-review.log`. Your
reviewed PDFs and videos are not touched.

## 6. Checking it yourself

Voice Review is open source (GNU AGPL-3.0). Everything above can be verified in the code: the
app is `app/server.py`, the courtesy check `app/safe_mode.py`, the installers
`packaging/installer.py` and `packaging/linux/`. The third-party software it bundles is listed in
`THIRD-PARTY-NOTICES.txt`.

Questions: Attinger Consulting, https://attinger-consulting.com
