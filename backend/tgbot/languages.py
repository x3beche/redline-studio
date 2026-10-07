"""Every language Telegram can be told about: ISO 639-1, as the Bot API's
`language_code` takes it. One list for the whole app - the bot profile's
language picker, a person's question language, `/lang` in the chat - served
to the page by GET /api/telegram/languages.

Each: (code, English name, native name). The English name is what the
Reading translation job is asked for (backend/reading.py takes a language
name, not a code).
"""

from __future__ import annotations

LANGUAGES: list[tuple[str, str, str]] = [
    ("aa", "Afar", "Afaraf"), ("ab", "Abkhaz", "аҧсуа бызшәа"), ("ae", "Avestan", "avesta"),
    ("af", "Afrikaans", "Afrikaans"), ("ak", "Akan", "Akan"), ("am", "Amharic", "አማርኛ"),
    ("an", "Aragonese", "aragonés"), ("ar", "Arabic", "العربية"), ("as", "Assamese", "অসমীয়া"),
    ("av", "Avaric", "авар мацӀ"), ("ay", "Aymara", "aymar aru"), ("az", "Azerbaijani", "azərbaycan dili"),
    ("ba", "Bashkir", "башҡорт теле"), ("be", "Belarusian", "беларуская"), ("bg", "Bulgarian", "български"),
    ("bi", "Bislama", "Bislama"), ("bm", "Bambara", "bamanankan"), ("bn", "Bengali", "বাংলা"),
    ("bo", "Tibetan", "བོད་ཡིག"), ("br", "Breton", "brezhoneg"), ("bs", "Bosnian", "bosanski"),
    ("ca", "Catalan", "català"), ("ce", "Chechen", "нохчийн мотт"), ("ch", "Chamorro", "Chamoru"),
    ("co", "Corsican", "corsu"), ("cr", "Cree", "ᓀᐦᐃᔭᐍᐏᐣ"), ("cs", "Czech", "čeština"),
    ("cu", "Church Slavonic", "ѩзыкъ словѣньскъ"), ("cv", "Chuvash", "чӑваш чӗлхи"), ("cy", "Welsh", "Cymraeg"),
    ("da", "Danish", "dansk"), ("de", "German", "Deutsch"), ("dv", "Divehi", "ދިވެހި"),
    ("dz", "Dzongkha", "རྫོང་ཁ"), ("ee", "Ewe", "Eʋegbe"), ("el", "Greek", "Ελληνικά"),
    ("en", "English", "English"), ("eo", "Esperanto", "Esperanto"), ("es", "Spanish", "Español"),
    ("et", "Estonian", "eesti"), ("eu", "Basque", "euskara"), ("fa", "Persian", "فارسی"),
    ("ff", "Fula", "Fulfulde"), ("fi", "Finnish", "suomi"), ("fj", "Fijian", "vosa Vakaviti"),
    ("fo", "Faroese", "føroyskt"), ("fr", "French", "Français"), ("fy", "Western Frisian", "Frysk"),
    ("ga", "Irish", "Gaeilge"), ("gd", "Scottish Gaelic", "Gàidhlig"), ("gl", "Galician", "galego"),
    ("gn", "Guaraní", "Avañe'ẽ"), ("gu", "Gujarati", "ગુજરાતી"), ("gv", "Manx", "Gaelg"),
    ("ha", "Hausa", "Hausa"), ("he", "Hebrew", "עברית"), ("hi", "Hindi", "हिन्दी"),
    ("ho", "Hiri Motu", "Hiri Motu"), ("hr", "Croatian", "hrvatski"), ("ht", "Haitian Creole", "Kreyòl ayisyen"),
    ("hu", "Hungarian", "magyar"), ("hy", "Armenian", "Հայերեն"), ("hz", "Herero", "Otjiherero"),
    ("ia", "Interlingua", "Interlingua"), ("id", "Indonesian", "Bahasa Indonesia"), ("ie", "Interlingue", "Interlingue"),
    ("ig", "Igbo", "Asụsụ Igbo"), ("ii", "Nuosu", "ꆈꌠ꒿"), ("ik", "Inupiaq", "Iñupiaq"),
    ("io", "Ido", "Ido"), ("is", "Icelandic", "íslenska"), ("it", "Italian", "Italiano"),
    ("iu", "Inuktitut", "ᐃᓄᒃᑎᑐᑦ"), ("ja", "Japanese", "日本語"), ("jv", "Javanese", "basa Jawa"),
    ("ka", "Georgian", "ქართული"), ("kg", "Kongo", "Kikongo"), ("ki", "Kikuyu", "Gĩkũyũ"),
    ("kj", "Kwanyama", "Kuanyama"), ("kk", "Kazakh", "қазақ тілі"), ("kl", "Kalaallisut", "kalaallisut"),
    ("km", "Khmer", "ខ្មែរ"), ("kn", "Kannada", "ಕನ್ನಡ"), ("ko", "Korean", "한국어"),
    ("kr", "Kanuri", "Kanuri"), ("ks", "Kashmiri", "कश्मीरी"), ("ku", "Kurdish", "Kurdî"),
    ("kv", "Komi", "коми кыв"), ("kw", "Cornish", "Kernewek"), ("ky", "Kyrgyz", "Кыргызча"),
    ("la", "Latin", "latine"), ("lb", "Luxembourgish", "Lëtzebuergesch"), ("lg", "Ganda", "Luganda"),
    ("li", "Limburgish", "Limburgs"), ("ln", "Lingala", "Lingála"), ("lo", "Lao", "ພາສາລາວ"),
    ("lt", "Lithuanian", "lietuvių"), ("lu", "Luba-Katanga", "Tshiluba"), ("lv", "Latvian", "latviešu"),
    ("mg", "Malagasy", "fiteny malagasy"), ("mh", "Marshallese", "Kajin M̧ajeļ"), ("mi", "Māori", "te reo Māori"),
    ("mk", "Macedonian", "македонски"), ("ml", "Malayalam", "മലയാളം"), ("mn", "Mongolian", "Монгол хэл"),
    ("mr", "Marathi", "मराठी"), ("ms", "Malay", "Bahasa Melayu"), ("mt", "Maltese", "Malti"),
    ("my", "Burmese", "ဗမာစာ"), ("na", "Nauru", "Dorerin Naoero"), ("nb", "Norwegian Bokmål", "norsk bokmål"),
    ("nd", "Northern Ndebele", "isiNdebele"), ("ne", "Nepali", "नेपाली"), ("ng", "Ndonga", "Owambo"),
    ("nl", "Dutch", "Nederlands"), ("nn", "Norwegian Nynorsk", "norsk nynorsk"), ("no", "Norwegian", "norsk"),
    ("nr", "Southern Ndebele", "isiNdebele"), ("nv", "Navajo", "Diné bizaad"), ("ny", "Chichewa", "chiCheŵa"),
    ("oc", "Occitan", "occitan"), ("oj", "Ojibwe", "ᐊᓂᔑᓈᐯᒧᐎᓐ"), ("om", "Oromo", "Afaan Oromoo"),
    ("or", "Oriya", "ଓଡ଼ିଆ"), ("os", "Ossetian", "ирон æвзаг"), ("pa", "Punjabi", "ਪੰਜਾਬੀ"),
    ("pi", "Pāli", "पाऴि"), ("pl", "Polish", "polski"), ("ps", "Pashto", "پښتو"),
    ("pt", "Portuguese", "Português"), ("qu", "Quechua", "Runa Simi"), ("rm", "Romansh", "rumantsch grischun"),
    ("rn", "Kirundi", "Ikirundi"), ("ro", "Romanian", "română"), ("ru", "Russian", "Русский"),
    ("rw", "Kinyarwanda", "Ikinyarwanda"), ("sa", "Sanskrit", "संस्कृतम्"), ("sc", "Sardinian", "sardu"),
    ("sd", "Sindhi", "सिन्धी"), ("se", "Northern Sami", "Davvisámegiella"), ("sg", "Sango", "yângâ tî sängö"),
    ("si", "Sinhala", "සිංහල"), ("sk", "Slovak", "slovenčina"), ("sl", "Slovenian", "slovenščina"),
    ("sm", "Samoan", "gagana fa'a Samoa"), ("sn", "Shona", "chiShona"), ("so", "Somali", "Soomaaliga"),
    ("sq", "Albanian", "shqip"), ("sr", "Serbian", "српски"), ("ss", "Swati", "SiSwati"),
    ("st", "Southern Sotho", "Sesotho"), ("su", "Sundanese", "Basa Sunda"), ("sv", "Swedish", "svenska"),
    ("sw", "Swahili", "Kiswahili"), ("ta", "Tamil", "தமிழ்"), ("te", "Telugu", "తెలుగు"),
    ("tg", "Tajik", "тоҷикӣ"), ("th", "Thai", "ไทย"), ("ti", "Tigrinya", "ትግርኛ"),
    ("tk", "Turkmen", "Türkmençe"), ("tl", "Tagalog", "Wikang Tagalog"), ("tn", "Tswana", "Setswana"),
    ("to", "Tonga", "faka Tonga"), ("tr", "Turkish", "Türkçe"), ("ts", "Tsonga", "Xitsonga"),
    ("tt", "Tatar", "татар теле"), ("tw", "Twi", "Twi"), ("ty", "Tahitian", "Reo Tahiti"),
    ("ug", "Uyghur", "ئۇيغۇرچە"), ("uk", "Ukrainian", "Українська"), ("ur", "Urdu", "اردو"),
    ("uz", "Uzbek", "Oʻzbek"), ("ve", "Venda", "Tshivenḓa"), ("vi", "Vietnamese", "Tiếng Việt"),
    ("vo", "Volapük", "Volapük"), ("wa", "Walloon", "walon"), ("wo", "Wolof", "Wollof"),
    ("xh", "Xhosa", "isiXhosa"), ("yi", "Yiddish", "ייִדיש"), ("yo", "Yoruba", "Yorùbá"),
    ("za", "Zhuang", "Saɯ cueŋƅ"), ("zh", "Chinese", "中文"), ("zu", "Zulu", "isiZulu"),
]

CODES = {c for c, _, _ in LANGUAGES}
ENGLISH = {c: e for c, e, _ in LANGUAGES}
NATIVE = {c: n for c, _, n in LANGUAGES}

# A few that read better spelled out for the translation model.
_PROMPT_NAMES = {"zh": "Chinese (Simplified)", "pt": "Portuguese", "no": "Norwegian (Bokmål)"}


def known(code: str | None) -> bool:
    return (code or "").lower() in CODES


def english(code: str) -> str:
    """The name the Reading translation job is asked for."""
    code = code.lower()
    return _PROMPT_NAMES.get(code) or ENGLISH.get(code) or code


def label(code: str | None) -> str:
    """"Deutsch · de"; "English (original)" for none."""
    if not code or code == "en":
        return "English (original)"
    return f"{NATIVE.get(code, code)} · {code}"


def listing() -> list[dict]:
    """For the page: native name, English name, code - sorted by English name."""
    return [{"code": c, "name": e, "native": n} for c, e, n in sorted(LANGUAGES, key=lambda x: x[1])]
