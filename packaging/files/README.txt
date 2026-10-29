VOICE REVIEW
============

Review a PDF by highlighting passages and speaking your comments, or review a
video by pausing it and speaking. Your speech is turned into text on this
computer. In a PDF the comments are saved as ordinary PDF comments, which
Acrobat, Edge and every other PDF reader can show; for a video they are saved
in a small file next to it.

Requirements: Windows 10 or 11 (64-bit), a Chromium browser (Brave, Chrome,
or Microsoft Edge, which is built into Windows), a microphone, 8 GB of memory,
about 5 GB of disk space, and an internet connection during installation only.
No graphics card is needed. Once installed, it works with no internet at all,
also in airplane mode.


INSTALL
-------
1. Right-click the zip file > Properties > tick "Unblock" (if shown) > OK.
   Without this, Windows warns about every file inside.
2. Right-click the zip > Extract All... into a folder of your own, for example
   Documents\VoiceReview. Do not use Program Files.
3. Double-click Install.bat in that folder. It looks at the computer, picks a
   speech model it can handle, downloads it (0.5 to 1.5 GB) and the safe-mode
   model (2.5 GB), once only, and adds a "Voice Review" shortcut to the
   desktop and to the "Send to" menu. Without safe mode: Install.bat --no-safe-mode
   If Windows shows "Windows protected your PC", click More info > Run anyway.


USE
---
Open a PDF or a video by double-clicking the desktop shortcut, or right-click
the file > Send to > Voice Review. The first time, the browser asks to use the
microphone: allow it.

  Drag across text ................. yellow highlight
  Shift + drag, or drag on a figure  orange box around a region
  Double-click a highlight ......... start speaking your comment
  Ctrl+Enter, Esc, Stop, or double-clicking the next highlight ... stop
  Click a highlight ................ read or type its comment
  F ................................ full screen;  Page Up/Down: page by page

You never wait for the transcription. Recordings go into a queue and are turned
into text one at a time in the background, at low priority, so the computer stays
responsive. A blue badge means "queued"; the text appears by itself. Closing the
window does not lose anything: the app keeps working until the queue is empty.
After a crash or restart, unfinished recordings are completed the next time you
open any PDF.

BEFORE YOU SEND THE PDF: wait until nothing is queued. While comments are
waiting, the window title shows "3 left", and each unfinished comment reads, in
the PDF itself, "This spoken comment is still being transcribed... ask the
sender for the finished version". If you close the window before the end, a
notification says "Not ready to send", then "Ready to send" when it is done.

Everything is saved automatically to <name>_review.pdf next to your PDF. The
original PDF is never changed. Opening a _review.pdf again lets you keep working on it.
To put the comments into the PDF itself instead (for Zotero or another reference
manager), choose it under the gear button (see SETTINGS IN THE WINDOW).


SAFE MODE
---------
Safe mode is OFF by default: every comment is written exactly as you said it.
A small language model on this computer still checks each spoken comment. One
that may not be courteous, or that breaks a ticked rule (below), is marked with
an orange warning, and you decide: "Rewrite politely" or "Keep as is".
Turn safe mode ON with the gear button, and such comments are rewritten at once,
with as few changes as possible, every technical point kept. A courteous
comment, even a critical one, is never changed.
For example:
  said:    "Oh, this paragraph makes no sense at all."
  written: "The meaning of this paragraph is difficult to understand.
            Could you do another pass?"
  said:    "Shit, page 12, line 4, it's 37 degrees, not 73."
  written: "Page 12, line 4: the value should be 37 degrees, not 73."
The rewriting is done by a small language model (Qwen3-4B-Instruct, Apache 2.0
licence) on this computer; nothing is sent anywhere. It adds a few seconds per
comment, in the background. It applies to what you SAY, not to what you type.
If it cannot produce a clean comment, nothing is written as spoken: the recording
is set aside in %LOCALAPPDATA%\VoiceReview\failed and you are told.
Read the comments before you send the PDF: the model can lose a nuance.

What safe mode removes is a list of tick boxes under it, all ticked by default:
no profanity, no racism, no sexism, no ageism, no personal attacks on the
author. Untick one to let it through. Below them is an empty line for a rule
of your own or your organization's (for example "No remarks about
nationality"); the + button adds more lines, and x removes one.


SIGNATURE
---------
Type your initials in the gear panel, for example DA. Every comment you add is
then signed: its text ends with (DA), so the initials survive a copy-paste into
a reply to the authors, and Acrobat, Zotero and other readers show DA as the
comment's author. Leave it empty for unsigned comments.


SETTINGS IN THE WINDOW (gear button)
------------------------------------
  Dictate right after highlighting
                             on (default): listening starts as soon as you
                             finish a highlight. Off: double-click to dictate.
  Language you speak ....... English (default), Français, Deutsch, Español,
                             Italiano, or Automatic (about twice as slow).
  Safe mode ................ as above, with its tick-box rules.
  Your initials ............ empty (default); see SIGNATURE.
  Keep my original recordings
                             off (default): each recording is deleted once it
                             is transcribed. On: it is kept as an mp3, with the
                             words you actually said, in
                             %LOCALAPPDATA%\VoiceReview\originals\<document>
                             - never next to the PDF, so it cannot travel with it.
  Save comments ............ in a copy, <name>_review.pdf (default), or in the
                             PDF itself. Applies at once.


VIDEOS (.mp4, .mov, .m4v, .webm, .mkv)
--------------------------------------
Open a video the same way. Press Play, and whenever you want to comment,
pause (Space) and speak. The microphone is on ONLY while the video is paused,
so you never talk over it. Press Play (Space) again to continue: your comment
is pinned to the moment you paused. You may refer to other moments by voice
("ten seconds ago", "at one minute thirty"). A pause with nothing said leaves
no comment. Untick "Listen when I pause" to pause without recording.
Comments are saved next to the video as <name>_review.md (easy to read) and
<name>_review.json.


PRIVACY
-------
Speech is transcribed, and in safe mode rewritten, on this computer. No audio
or text is sent anywhere. The internet is used only to download the models
during installation; after that the app runs in airplane mode.
The models are Whisper (OpenAI) for speech and, for the courtesy check and
safe mode, Qwen3-4B-Instruct-2507 (the Qwen team, Alibaba Cloud, China), both
from huggingface.co. Install.bat --no-safe-mode skips the second one.
PRIVACY.md in this folder lists every download with its source and
fingerprint, and every file the app keeps on this computer.


SETTINGS (config.json, in this folder)
--------------------------------------
  "model"    speech model. Any language: large-v3-turbo (best), small (lighter).
             English only: distil-large-v3, small.en, base.en (fastest). To change, run
             Install.bat --model small   (downloads the new model).
  The language you speak is chosen at the top of the window (English, Français,
  Deutsch, Español, Italiano, or Automatic, which is about twice as slow).
  "threads"  CPU threads for transcription (2 to 4 is right for most laptops).
  "author"   the name shown on the comments.


TROUBLESHOOTING
---------------
- Nothing opens, or the window says it cannot connect to 127.0.0.1: close the
  window and open the PDF again; if it happens again, send
  %TEMP%\voice-review.log to the author. (127.0.0.1 is this computer
  itself, not the internet: the window talks to the app running beside it.)
- "NOT SAVED" in red: the _review.pdf is open in Acrobat or another program.
  Close it; the next change saves everything.
- Recordings that failed three times are kept in %LOCALAPPDATA%\VoiceReview\failed


UNINSTALL
---------
Run Uninstall.bat, then delete this folder.


ABOUT AND LICENCE
-----------------
Made by Daniel Attinger, Attinger Consulting: https://attinger-consulting.com

Copyright (C) 2026 Daniel Attinger. Voice Review is free software: you can
use, share and change it under the terms of the GNU Affero General Public
License, version 3 or (at your option) any later version (LICENSE.txt). It
comes with NO WARRANTY. If you share a changed version, you must share its
source code under the same licence.

It includes or downloads software and models by others, each under its own
licence: see THIRD-PARTY-NOTICES.txt. The Attinger Consulting name and logo
are not covered by the AGPL.
