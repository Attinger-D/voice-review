# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
"""Safe mode: rewrite a spoken comment so it can be sent to a colleague (Daniel, 2026-10-21).

A small instruction model runs on the CPU with llama.cpp, like the speech model: nothing leaves
the computer. It keeps every technical point and turns venting into a polite request. What it must
remove is the list of rules ticked in Settings (Daniel, 2026-10-22): no profanity, racism, sexism,
ageism or personal attacks by default, plus any rule the reviewer or the organization adds. Daniel's
own examples are the few-shot pairs below.

Only when needed (Daniel, 2026-10-22, after French comments came back with their meaning changed): the
model first CHECKS the comment; one that is courteous and breaks no ticked rule is written exactly as
spoken. Only a flagged comment is rewritten, and then with as few changes as possible.

    python safe_mode.py "what the fuck, again he's making these mistakes"   # try one comment
"""
import gc
import os
import threading
import re
import sys
import time
from pathlib import Path

SYSTEM = """You polish spoken review comments before they are sent to a colleague, who will read them in a PDF.
Rewrite the comment so that it is professional, courteous and constructive, and could not humiliate or offend the reader.

Rules:
- Keep every technical point, request, number, name, reference (page, figure, table, equation) and suggested fix.
- Remove exasperation.
{rules}
- When you remove something, keep only the professional point, if there is one.
- Turn complaints into clear, polite requests ("Could you ...", "Please ...").
- Keep the reviewer's verdict and its strength. Criticism stays criticism and strong disagreement stays strong
  disagreement, said politely. Never turn a criticism into praise, agreement or a mere remark about clarity.
- Change as little as possible: keep the speaker's own words, order and meaning, and replace only what breaks a rule or would offend.
- If the comment is already professional, return it unchanged except for removing filler words such as "uh" or "um".
- Never mention a figure, table, page or detail that the comment does not mention: you cannot see the document.
- Do not add new criticisms, praise, explanations or greetings. Do not answer or comment on the comment.
- Keep the language of the comment. Keep it about as short as the original, or shorter.
- Output only the rewritten comment, nothing else."""

# The reviewer's own tone or style (Daniel, 2026-10-27: a rule like "Be overly polite and flattering" must work
# too, "that could be really fun"). Such a line wins over "change as little as possible".
TONE = """

The reviewer also asks for this tone or style. Follow it fully: it takes priority over the rules above about changing
as little as possible, keeping the length and adding no praise. Still keep every technical point and number.
{tone}"""

EXAMPLES = [  # Daniel's own two examples (2026-10-21), then two that teach "keep the technical point"
    ("Oh, what the fuck, again, he's making these mistakes.",
     "We already talked about this. Could you please revise this passage and apply the rules we discussed?"),
    ("Oh, this paragraph makes no sense at all.",
     "The meaning of this paragraph is difficult to understand. Could you do another pass?"),
    ("Jesus, who taught this clown statistics? A t-test on three samples per group, seriously? Use a Mann-Whitney test or show the normality check.",
     "With three samples per group, a t-test may not be appropriate. Could you use a Mann-Whitney test, or show the normality check?"),
    ("Um, table 2, the units in the second column are missing.",
     "Table 2: the units in the second column are missing."),
    ("Nice, I like this paragraph.",
     "Nice, I like this paragraph."),
    # Daniel, 2026-10-28: a rude French comment came back as praise ("L'actualité est bien présentée"), and
    # "garbage" as "unclear". The verdict must survive; only the insult goes.
    ("This is garbage, honestly, I don't believe a word of it.",
     "I strongly disagree with this passage and do not find it convincing. It needs to be substantially revised."),
    # French (2026-10-21): with English-only examples a French comment came back in English
    ("Putain, encore cette erreur, le tableau trois n'a pas d'unités. [Write the rewritten comment in French.]",
     "Le tableau 3 n'a pas d'unités. Pourriez-vous les ajouter ?"),
]

# Last line of defence: if one of these survives the rewrite, the comment is not sent as is.
PROFANITY = re.compile(r"\b(fuck\w*|shit\w*|bullshit|crap\w*|damn\w*|goddamn\w*|bitch\w*|bastard\w*|asshole\w*|"
                       r"arse|arsehole\w*|idiot\w*|moron\w*|stupid|dumb\w*|retard\w*|wtf|piss\w*|merde|putain|connard\w*|"
                       r"idiote?s?|scheisse|scheiße)\b", re.I)


CHECK = """You screen spoken review comments before they are sent to a colleague, who will read them in a PDF.
Answer YES if the comment is rude, insulting, contemptuous, sarcastic or swearing, or if it breaks any of these rules:
{rules}
Answer NO if it is courteous, even when it is critical, blunt or short. A clear technical criticism is NO.
Answer with one word: YES or NO."""

# The default rules of the Settings panel, spelled out for the model. Any other rule is passed as written.
RULES = {
    "no profanity": "Remove profanity, swearing and crude language.",
    "no racism": "Remove any remark about a person's race, ethnicity, nationality or religion.",
    "no sexism": "Remove any remark about a person's gender or sexual orientation.",
    "no ageism": "Remove any remark about a person's age.",
    "no personal attacks on the author": "Remove insults, sarcasm and remarks about a person's appearance or "
                                         "disability. Criticise the text, never the author.",
}
DEFAULT_RULES = list(RULES)


def swear_net(rules):
    """The swear-word regex applies only while a rule asks for it: unticked, those words may stay."""
    return any(r.strip().lower().rstrip(".") in ("no profanity", "no personal attacks on the author") for r in rules)


def rule_lines(rules):
    return "\n".join("- " + RULES.get(r.strip().lower().rstrip("."), r.strip().rstrip(".") + ".") for r in rules)


# A rule forbids ("No remarks about nationality", "Never ..."); any other line of his own asks for a tone or a
# style ("Be overly polite and flattering"). Rules are checked even with safe mode off (a comment breaking one is
# flagged); a tone applies only with safe mode on, or every plain comment would be flagged as discourteous.
FORBIDS = re.compile(r"^\s*(no|not|don'?t|do not|never|avoid|without|remove|ban|pas d[e']|ne |jamais|aucun|"
                     r"kein|nicht|geen|niet|nunca|sin|senza|non)\b", re.I)


def split_rules(rules):
    """-> (rules that forbid something, tone or style lines)."""
    tone = [r for r in rules if r.strip() and r.strip().lower().rstrip(".") not in RULES and not FORBIDS.match(r)]
    return [r for r in rules if r.strip() and r not in tone], tone


# Every language the Whisper speech models know (Daniel, 2026-10-27, after a request for Dutch: "there is no
# limit to the languages we can have"): code -> (English name, the language's own name). The window's menu
# is built from this table; safe mode tells its model the English name.
LANGUAGES = {
    "af": ("Afrikaans", "Afrikaans"), "am": ("Amharic", "አማርኛ"), "ar": ("Arabic", "العربية"),
    "as": ("Assamese", "অসমীয়া"), "az": ("Azerbaijani", "Azərbaycanca"), "ba": ("Bashkir", "Башҡортса"),
    "be": ("Belarusian", "Беларуская"), "bg": ("Bulgarian", "Български"), "bn": ("Bengali", "বাংলা"),
    "bo": ("Tibetan", "བོད་སྐད"), "br": ("Breton", "Brezhoneg"), "bs": ("Bosnian", "Bosanski"),
    "ca": ("Catalan", "Català"), "cs": ("Czech", "Čeština"), "cy": ("Welsh", "Cymraeg"), "da": ("Danish", "Dansk"),
    "de": ("German", "Deutsch"), "el": ("Greek", "Ελληνικά"), "en": ("English", "English"),
    "es": ("Spanish", "Español"), "et": ("Estonian", "Eesti"), "eu": ("Basque", "Euskara"), "fa": ("Persian", "فارسی"),
    "fi": ("Finnish", "Suomi"), "fo": ("Faroese", "Føroyskt"), "fr": ("French", "Français"),
    "gl": ("Galician", "Galego"), "gu": ("Gujarati", "ગુજરાતી"), "ha": ("Hausa", "Hausa"),
    "haw": ("Hawaiian", "ʻŌlelo Hawaiʻi"), "he": ("Hebrew", "עברית"), "hi": ("Hindi", "हिन्दी"),
    "hr": ("Croatian", "Hrvatski"), "ht": ("Haitian Creole", "Kreyòl ayisyen"), "hu": ("Hungarian", "Magyar"),
    "hy": ("Armenian", "Հայերեն"), "id": ("Indonesian", "Bahasa Indonesia"), "is": ("Icelandic", "Íslenska"),
    "it": ("Italian", "Italiano"), "ja": ("Japanese", "日本語"), "jw": ("Javanese", "Basa Jawa"),
    "ka": ("Georgian", "ქართული"), "kk": ("Kazakh", "Қазақша"), "km": ("Khmer", "ខ្មែរ"), "kn": ("Kannada", "ಕನ್ನಡ"),
    "ko": ("Korean", "한국어"), "la": ("Latin", "Latina"), "lb": ("Luxembourgish", "Lëtzebuergesch"),
    "ln": ("Lingala", "Lingála"), "lo": ("Lao", "ລາວ"), "lt": ("Lithuanian", "Lietuvių"), "lv": ("Latvian", "Latviešu"),
    "mg": ("Malagasy", "Malagasy"), "mi": ("Maori", "Te reo Māori"), "mk": ("Macedonian", "Македонски"),
    "ml": ("Malayalam", "മലയാളം"), "mn": ("Mongolian", "Монгол"), "mr": ("Marathi", "मराठी"),
    "ms": ("Malay", "Bahasa Melayu"), "mt": ("Maltese", "Malti"), "my": ("Burmese", "မြန်မာ"),
    "ne": ("Nepali", "नेपाली"), "nl": ("Dutch", "Nederlands"), "nn": ("Norwegian Nynorsk", "Nynorsk"),
    "no": ("Norwegian", "Norsk"), "oc": ("Occitan", "Occitan"), "pa": ("Punjabi", "ਪੰਜਾਬੀ"), "pl": ("Polish", "Polski"),
    "ps": ("Pashto", "پښتو"), "pt": ("Portuguese", "Português"), "ro": ("Romanian", "Română"),
    "ru": ("Russian", "Русский"), "sa": ("Sanskrit", "संस्कृतम्"), "sd": ("Sindhi", "سنڌي"), "si": ("Sinhala", "සිංහල"),
    "sk": ("Slovak", "Slovenčina"), "sl": ("Slovenian", "Slovenščina"), "sn": ("Shona", "chiShona"),
    "so": ("Somali", "Soomaali"), "sq": ("Albanian", "Shqip"), "sr": ("Serbian", "Српски"), "su": ("Sundanese", "Basa Sunda"),
    "sv": ("Swedish", "Svenska"), "sw": ("Swahili", "Kiswahili"), "ta": ("Tamil", "தமிழ்"), "te": ("Telugu", "తెలుగు"),
    "tg": ("Tajik", "Тоҷикӣ"), "th": ("Thai", "ไทย"), "tk": ("Turkmen", "Türkmençe"), "tl": ("Tagalog", "Tagalog"),
    "tr": ("Turkish", "Türkçe"), "tt": ("Tatar", "Татарча"), "uk": ("Ukrainian", "Українська"), "ur": ("Urdu", "اردو"),
    "uz": ("Uzbek", "Oʻzbekcha"), "vi": ("Vietnamese", "Tiếng Việt"), "yi": ("Yiddish", "ייִדיש"),
    "yo": ("Yoruba", "Yorùbá"), "zh": ("Chinese (Mandarin)", "中文"), "yue": ("Cantonese", "粵語"),
}
LANG_NAMES = {k: v[0] for k, v in LANGUAGES.items()}


def data_dir():
    """Where models, queue and settings live, once per computer: %LOCALAPPDATA%\\VoiceReview on Windows,
    ~/.local/share/VoiceReview on Linux (not /tmp, which is wiped at reboot; 2026-10-22, for Nicolas),
    ~/Library/Application Support/VoiceReview on macOS."""
    if sys.platform == "win32":
        import tempfile
        return Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "VoiceReview"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "VoiceReview"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "VoiceReview"


def model_path():
    """The GGUF beside the app (portable install: models\\safe\\), else PDF_REVIEW_SAFE_MODEL."""
    here = Path(__file__).resolve().parent.parent
    env = os.environ.get("PDF_REVIEW_SAFE_MODEL")
    if env:
        return Path(env)
    shared = data_dir() / "models"  # one copy per computer
    for d in (shared / "safe", shared, here / "models" / "safe"):
        if d.is_dir():
            found = sorted(d.glob("*.gguf"), key=lambda p: p.stat().st_size, reverse=True)
            if found:
                return found[0]
    return None


class Polisher:
    """Loaded on first use, unloaded with the speech model when the queue is idle."""

    def __init__(self, path=None, threads=4, log=print):
        self.path, self.threads, self.log, self.llm = path, threads, log, None
        self.lock = threading.RLock()  # the queue's worker and the window's "Rewrite politely" share the model

    def available(self):
        p = self.path or model_path()
        return bool(p and Path(p).is_file())

    def _ensure(self):
        if self.llm:
            return
        from llama_cpp import Llama
        p = Path(self.path or model_path() or "")
        if not p.is_file():
            raise RuntimeError("safe mode has no model: run Install.bat (Linux, macOS: install.sh) again, it downloads one")
        t0 = time.time()
        self.llm = Llama(model_path=str(p), n_ctx=4096, n_threads=self.threads, n_gpu_layers=0, verbose=False)
        self.log(f"safe-mode model loaded in {time.time() - t0:.0f}s: {p.name}")

    def polish(self, text, lang="en", rules=None, force=False):
        """`rules`: the ticked rules of Settings, as written there; None = the defaults (older queued clips).
        `force`: rewrite without checking first (the reviewer pressed "Rewrite politely")."""
        with self.lock:
            return self._polish(text, lang, rules, force)

    def flag(self, text, rules=None):
        """Safe mode off: True when the comment may not be courteous. It is only flagged, never changed."""
        text = (text or "").strip()
        if not text:
            return False
        with self.lock:
            self._ensure()
            rules = DEFAULT_RULES if rules is None else rules
            return self.needs_rewrite(text, split_rules(rules)[0], swear_net(rules))  # a tone is never flagged

    def _polish(self, text, lang, rules, force):
        text = (text or "").strip()
        if not text:
            return text
        self._ensure()
        rules = DEFAULT_RULES if rules is None else rules
        rules, tone = split_rules(rules)
        # the swear-word net only while a rule asks for it: unticked, those words may stay
        net = swear_net(rules)
        # A tone of his own applies to every comment: the check cannot tell "not flattering enough" (measured
        # 2026-10-27: a plain comment passed it and came back unchanged)
        if not force and not tone and not self.needs_rewrite(text, rules, net):
            return text  # courteous and within the rules: written exactly as spoken
        system = SYSTEM.replace("{rules}", rule_lines(rules)).replace("\n\n- When", "\n- When")
        if tone:
            system += TONE.replace("{tone}", rule_lines(tone))
        msgs = [{"role": "system", "content": system}]
        for said, polished in EXAMPLES:
            msgs += [{"role": "user", "content": said}, {"role": "assistant", "content": polished}]
        name = LANG_NAMES.get(lang)
        tell = f" [Write the rewritten comment in {name}.]" if name else " [Write it in the language of the comment.]"
        if tone:  # said again next to the comment: the examples above teach small changes
            tell += " [Tone or style asked for: " + " ".join(t.strip().rstrip(".") + "." for t in tone) + "]"
        msgs.append({"role": "user", "content": text + tell + "  /no_think"})  # Qwen3 hybrids: answer directly
        out = None
        for temp in (0.0, 0.4, 0.7):  # freer tries if one still swears or changed a number
            r = self.llm.create_chat_completion(messages=msgs, temperature=temp, max_tokens=max(120, len(text) // 2),
                                                seed=1)
            out = clean(r["choices"][0]["message"]["content"])
            rude = net and out and PROFANITY.search(out)
            if out and not rude and not new_numbers(text, out):
                return out
            self.log(f"safe mode: rewrite rejected ({'profanity' if rude else 'a number changed'}), retrying")
        raise RuntimeError("safe mode could not produce a clean comment that keeps every number")

    def needs_rewrite(self, text, rules, net):
        """True when the comment swears (regex) or the model says it is rude or breaks a ticked rule."""
        if net and PROFANITY.search(text):
            return True
        r = self.llm.create_chat_completion(
            messages=[{"role": "system", "content": CHECK.replace("{rules}", rule_lines(rules) or "- (none)")},
                      {"role": "user", "content": text + "  /no_think"}],
            temperature=0.0, max_tokens=4, seed=1)
        answer = clean(r["choices"][0]["message"]["content"]).upper()
        self.log(f"safe mode check: {answer[:10]}")
        return not answer.startswith("NO")  # anything but a clear NO is rewritten: the safe side

    def unload(self):
        with self.lock:
            self._unload()

    def _unload(self):
        if self.llm:
            self.llm = None
            gc.collect()
            self.log("safe-mode model unloaded")


NUMBER_WORDS = re.compile(
    r"\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|"
    r"seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|"
    r"zéro|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|"
    r"trente|quarante|cinquante|soixante|cent|cents|mille|million)\b", re.I)


def numbers(s):
    return set(re.findall(r"\d+(?:[.,]\d+)?", s.replace(" ", "").replace("\xa0", "")))


def new_numbers(said, written):
    """Numbers in the rewrite that were not said (measured 2026-10-21: "soixante-treize" came back as 63).
    The speech model writes numbers as digits, so they can be compared; if the speaker's words still hold a
    number word, a small digit in the rewrite may be its honest conversion ("figure deux" -> "Figure 2")."""
    extra = numbers(written) - numbers(said)
    if extra and NUMBER_WORDS.search(said):
        extra = {n for n in extra if not (n.isdigit() and int(n) <= 20)}
    return extra


def clean(s):
    s = re.sub(r"<think>.*?</think>", "", s or "", flags=re.S).strip()
    s = re.sub(r"^(rewritten comment|comment|polished)\s*:\s*", "", s, flags=re.I).strip()
    if len(s) > 1 and s[0] == s[-1] and s[0] in "\"'“”":
        s = s[1:-1].strip()
    return s


if __name__ == "__main__":
    p = Polisher()
    for t in sys.argv[1:]:
        t0 = time.time()
        print(f"{t!r}\n -> {p.polish(t)!r}  ({time.time() - t0:.1f}s)")
        print(f" -> with 'No mention of other journals' added: "
              f"{p.polish(t, rules=DEFAULT_RULES + ['No mention of other journals'])!r}")
