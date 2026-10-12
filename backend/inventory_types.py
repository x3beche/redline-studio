"""What kind of thing an inventory item is - filament, a screw, a resistor,
a module - and what that kind says about it (backend/inventory.py).

Every item has a type. A person may set one (`type` on the item); an item
without one - every item kept before types existed among them - gets it
worked out from what it already says, each time it is read: its name, its
category and tags, its part number, and the LCSC part's own category when
the part has been looked at before (read from the copy on disk, never asked
for). So nothing has to be migrated, and renaming "PLA 1.75" to "PETG 1.75"
moves it along by itself.

Electronic components carry a subtype as well (resistor, capacitor, IC,
connector...), found the same way or set by hand.

`facts` reads what a type's card shows from the same words: a filament's
material, diameter, colour and spool size; a screw's size (M3x8), head,
drive and standard (DIN 912); a component's package and value. They are
read, not kept - the item's name stays the one source.
"""

from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from typing import Any

# The types, in the order the Inventory shows them.
TYPES: list[tuple[str, str]] = [
    ("filament", "Filament"),
    ("resin", "Resin"),
    ("screw", "Screws & bolts"),
    ("nut", "Nuts"),
    ("washer", "Washers"),
    ("insert", "Inserts"),
    ("fastener", "Other fasteners"),
    ("electronic", "Electronic components"),
    ("module", "Modules & boards"),
    ("cable", "Cables & wire"),
    ("mechanical", "Mechanical parts"),
    ("tool", "Tools"),
    ("consumable", "Consumables"),
    ("other", "Other"),
]
TYPE_IDS = [k for k, _ in TYPES]
LABEL = dict(TYPES)

# An electronic component's kind.
SUBTYPES: list[tuple[str, str]] = [
    ("resistor", "Resistor"),
    ("capacitor", "Capacitor"),
    ("inductor", "Inductor"),
    ("led", "LED"),
    ("diode", "Diode"),
    ("transistor", "Transistor"),
    ("ic", "IC"),
    ("crystal", "Crystal"),
    ("connector", "Connector"),
    ("switch", "Switch"),
    ("relay", "Relay"),
    ("fuse", "Fuse"),
    ("sensor", "Sensor"),
    ("display", "Display"),
    ("motor", "Motor / fan"),
]
SUBTYPE_IDS = [k for k, _ in SUBTYPES]
SUBLABEL = dict(SUBTYPES)

# Words a person (or the Chat) may say for a type.
_ALIASES = {
    "filaments": "filament", "3d filament": "filament",
    "resins": "resin",
    "screws": "screw", "bolt": "screw", "bolts": "screw", "screws & bolts": "screw", "vida": "screw", "civata": "screw",
    "nuts": "nut", "somun": "nut",
    "washers": "washer", "pul": "washer",
    "inserts": "insert", "heat-set insert": "insert", "heat set insert": "insert", "threaded insert": "insert",
    "fasteners": "fastener", "other fasteners": "fastener", "standoff": "fastener", "standoffs": "fastener",
    "electronic": "electronic", "electronics": "electronic", "electronic component": "electronic",
    "electronic components": "electronic", "component": "electronic", "components": "electronic",
    "elektronik": "electronic",
    "modules": "module", "board": "module", "boards": "module", "modules & boards": "module", "modul": "module",
    "cables": "cable", "wire": "cable", "wires": "cable", "cables & wire": "cable", "kablo": "cable",
    "mechanical": "mechanical", "mechanical part": "mechanical", "mechanical parts": "mechanical", "mekanik": "mechanical",
    "tools": "tool", "alet": "tool",
    "consumables": "consumable", "sarf": "consumable",
    "others": "other",
}

_FOLD = str.maketrans("ıİşŞğĞçÇöÖüÜ", "iissggccoouu")


def fold(text: Any) -> str:
    t = str(text or "").translate(_FOLD).lower()
    return "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))


def type_id(raw: Any) -> str:
    """A type as it is kept: one of TYPE_IDS, or "" for "work it out".
    A ValueError names the types when the word is none of them."""
    t = fold(raw).strip()
    if not t or t in ("auto", "automatic", "otomatik"):
        return ""
    t = re.sub(r"\s+", " ", t)
    if t in TYPE_IDS:
        return t
    if t in _ALIASES:
        return _ALIASES[t]
    for k, label in TYPES:
        if fold(label) == t:
            return k
    raise ValueError(f"{raw!r} is not a type; the types are {', '.join(TYPE_IDS)}")


def subtype_id(raw: Any) -> str:
    t = fold(raw).strip()
    if not t or t in ("auto", "automatic"):
        return ""
    t = t.rstrip("s") if t.rstrip("s") in SUBTYPE_IDS else t
    if t in SUBTYPE_IDS:
        return t
    for k, label in SUBTYPES:
        if fold(label) == t:
            return k
    if t in ("ics", "chip", "chips", "microcontroller", "mcu"):
        return "ic"
    if t in ("mosfet", "mosfets", "bjt"):
        return "transistor"
    if t in ("fan", "fans", "motors", "buzzer"):
        return "motor"
    raise ValueError(f"{raw!r} is not a component kind; they are {', '.join(SUBTYPE_IDS)}")


# ---- what the LCSC part says of itself (from disk only) -----------------------------

def lcsc_info(code: str) -> dict | None:
    """The kept EasyEDA record of an LCSC part, boiled down: its category
    (LCSC's), package, value and maker part number, and whether a photo of
    it is on disk. None when the part was never looked at - it is not asked
    for here."""
    from . import lcsc
    code = str(code or "").strip().upper()
    if not re.fullmatch(r"C\d{1,12}", code):
        return None
    path = lcsc.LOOK / code / "component.json"
    try:
        stamp = path.stat().st_mtime
    except OSError:
        return None
    got = _read_info(str(path), stamp)
    if got is None:
        return None
    return {**got, "photo": (lcsc.LOOK / code / "photo.jpg").exists()}


@lru_cache(maxsize=4096)
def _read_info(path: str, stamp: float) -> dict | None:  # noqa: ARG001 - the stamp is the cache's key
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            body = json.load(fh)
    except (OSError, ValueError):
        return None
    r = body.get("result") if isinstance(body, dict) else None
    if not isinstance(r, dict):
        return None
    para = ((r.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    tags = [str(x) for x in (r.get("tags") or []) if x]
    return {"category": tags[0] if tags else "", "package": str(para.get("package") or ""),
            "value": str(para.get("Value") or ""), "mpn": str(para.get("Manufacturer Part") or ""),
            "title": str(r.get("title") or ""), "has_photo": bool((r.get("szlcsc") or {}).get("image"))}


# ---- working the type out ---------------------------------------------------------

_MAT = r"pla\+?|petg|pet-g|pctg|abs\+?|asa|tpu|tpe|nylon|pa6|pa12|pa-cf|pc|pva|hips|cpe"
_R = lambda p: re.compile(p)  # noqa: E731

_FILAMENT = _R(r"\bfilament")
_FILAMENT_MAT = _R(rf"\b({_MAT})\b")
_FILAMENT_DIA = _R(r"\b(1[.,]75|2[.,]85)\s*mm\b|\bspool\b|\bmakara\b")
_RESIN = _R(r"\bresin\b|\brecine\b|photopolymer|fotopolimer")
_TOOL = _R(r"\btools?\b|screwdriver|tornavida|pliers|\bpense\b|tweezers?|cimbiz|soldering (iron|station)|\bhavya"
           r"|multimet(er|re)|caliper|kumpas|drill bits?|matkap|\bhex keys?|allen keys?|\balyan|\bwrench|spatula"
           r"|scissors|\bmakas\b|crimp(ing)? tool|wire strippers?|deburr|\bsaw\b|testere|\btap set|kilavuz|\bcutter\b")
_MECH_FIRST = _R(r"lead ?screws?|ball ?screws?|\btrapez|\bt8 ?(x|×)")
_INSERT = _R(r"heat[- ]?set|threaded inserts?|\binserts?\b|disli burc|sicak gomme|rivet ?nuts?|percin somun")
_NUT = _R(r"\bnuts?\b|\bsomun|\bdin ?(934|985|439|6923|562|557|1587|315)\b|\biso ?(4032|4035|10511|7040)\b"
          r"|nyloc|t-?nuts?\b")
_WASHER = _R(r"\bwashers?\b|\bpul(lar|u|lari)?\b|\bdin ?(125|127|9021|433|6798|7349)\b|\biso ?(7089|7090|7092|7093)\b"
             r"|\brondela")
_SCREW = _R(r"\bscrews?\b|\bbolts?\b|\bvida|\bcivata|\bdin ?(912|933|931|7991|7380|965|7985|7984|916|913|914|84|963"
            r"|7981|7982)\b|\biso ?(4762|7380|10642|4017|4014|7045|7046|4026|4027|4029|14579|14580|14581|14583)\b"
            r"|grub screw|set ?screw|\bm\d+(?:[.,]\d+)?\s*[x×*]\s*\d+")
_FASTENER_FIRST = _R(r"standoffs?|spacers?|\bmesafe|aralayici|\brivets?\b|percin|dowel|\bpim\b|circlips?|segman"
                     r"|cotter pin")
_FASTENER = _R(r"\bfasteners?\b|baglanti eleman|hirdavat")
_CONSUMABLE = _R(r"\bsolder\b|\blehim\b|lehim tel|\bflux\b|\bglue\b|yapistirici|tutkal|\bepoxy|\btape\b|\bbant\b"
                 r"|heat ?shrink|makaron|cable ties?|zip ties?|kelepce|isopropyl|\bipa\b|alcohol|\balkol|lubricant"
                 r"|grease|\bgres\b|sandpaper|zimpara|thermal (paste|pad|compound)|termal (macun|ped)|kapton"
                 r"|\bwipes\b|\bprimer\b|\bspray\b|\bsprey\b")
_MODULE = _R(r"\bmodul|\bmodules?\b|breakout|dev(elopment)? ?boards?|arduino|raspberry|\bshields?\b|gelistirme kart"
             r"|evaluation (board|kit)|\bkart\b|nodemcu|wemos|devkit|\bblue ?pill\b")
_MODULE_TAG = _R(r"modules?\b|development boards?|evaluation|kits?\b")
_CABLE = _R(r"\bcables?\b|\bkablo|\bwires?\b|\bawg\b|jumper wires?|silicone wire|\btel\b|ribbon|\bfiber\b")
_MECH = _R(r"bearings?|rulman|\bsprings?\b|\byay\b|hinges?|mentese|\bgears?\b|\bdisli\b|\bbelts?\b|\bkayis|pulley"
           r"|kasnak|\bshafts?\b|\bmil\b|linear (rail|guide|bearing)|lineer|\brails?\b|aluminium profile|aluminum profile"
           r"|\bprofil|\bsigma\b|magnets?\b|miknatis|couplings?|kaplin|\bnozzles?\b|\bwheels?\b|tekerlek|brackets?"
           r"|\bbraket|\bknobs?\b|o-?rings?|\bconta\b|gaskets?|caster|bushings?|\bburc\b|\b6\d{2,3} ?(zz|2rs)\b"
           r"|\bgt2\b|\bhandle\b|\bkulp\b|\bhousing\b|enclosure|\bkutu\b")
_PACKAGE = _R(r"\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b|\bsot-?\d{2,3}\b|\bsoic-?\d+|\btssop|\bqfn|\blqfp"
              r"|\bto-?(92|220|247|252|263)\b|\bdip-?\d+|\bsod-?\d+|\bsma\b|\bsmd\b|\bsmt\b")

_SUB = [
    ("led", _R(r"\bleds?\b|light emitting")),
    ("resistor", _R(r"resistors?|\bdirenc|\bohms?\b|\d\s*[kmr]?\s*[ωΩ]|\d[kmr]\d*\s*(ohm|resistor)|potentiomet|trimpot"
                    r"|\bpot\b|\bthermistor")),
    ("capacitor", _R(r"capacitors?|kondansator|kapasitor|\bmlcc\b|\bcaps?\b|\d\s*(pf|nf|uf|μf|µf)\b|electrolytic")),
    ("inductor", _R(r"inductors?|\bbobin|\bcoils?\b|endukt|ferrite|\d\s*(uh|μh|µh|mh|nh)\b|transformers?")),
    ("diode", _R(r"diodes?|\bdiyot|rectifier|zener|schottky|\btvs\b|\b1n4\d{3}\b|\bss\d{2}\b")),
    ("transistor", _R(r"mosfets?|transistors?|\bbjt\b|igbt|\b2n\d{4}\b|\birl?f?z?\d{3,4}n?\b|\bao\d{4}\b")),
    ("crystal", _R(r"crystals?|kristal|oscillators?|osilator|resonators?|\bxtal|\d\s*mhz\b")),
    ("connector", _R(r"connectors?|konnektor|\bheaders?\b|\bjst\b|\bxh\d|\bph2|terminal blocks?|klemens|\bsockets?\b"
                     r"|receptacle|\bidc\b|wire to board|wire to wire|pin headers?|\bfpc\b|\bffc\b")),
    ("switch", _R(r"\bswitch|tactile|\bbuton|\bbuttons?\b|push ?button|\btact\b|toggle|microswitch")),
    ("relay", _R(r"\brelays?\b|\brole\b")),
    ("fuse", _R(r"\bfuses?\b|sigorta|polyfuse|\bptc\b")),
    ("sensor", _R(r"sensors?|sensoru|\bntc\b|\bhall\b|accelerometer|gyro|\bimu\b|encoder")),
    ("display", _R(r"display|\boled\b|\blcd\b|\btft\b|ekran|7-segment|e-?paper")),
    ("motor", _R(r"\bmotors?\b|stepper|\bfans?\b|\bservo|buzzer|speaker|hoparlor|\bnema ?\d+")),
    ("ic", _R(r"\bics?\b|microcontroller|\bmcus?\b|regulators?|\bldo\b|op-?amp|amplifier|converters?|drivers?\b|eeprom"
              r"|\bflash\b|\blogic\b|interface|\bchips?\b|processor|\buart\b|\bstm32|\batmega|\besp32|\brp2040|\bch340"
              r"|\btps\d|\bams1117|\blm\d{3,4}|\bne555")),
]


def _hay(d: dict, info: dict | None) -> str:
    cat = d.get("catalog") or {}
    return fold(" ".join(str(x or "") for x in (
        d.get("name"), d.get("category"), cat.get("product_name"), " ".join(d.get("tags") or []), d.get("mpn"),
        (info or {}).get("category"), (info or {}).get("title"))))


def subtype_of(text: str) -> str:
    for k, rx in _SUB:
        if rx.search(text):
            return k
    return ""


def derive(d: dict, info: dict | None = None) -> tuple[str, str]:
    """The type (and for a component, its kind) an item's own words point
    at; ("other", "") when they say nothing this knows."""
    t = _hay(d, info)
    sub = lambda: subtype_of(t)  # noqa: E731
    if _FILAMENT.search(t) or (_FILAMENT_MAT.search(t) and _FILAMENT_DIA.search(t)):
        return "filament", ""
    if _RESIN.search(t):
        return "resin", ""
    if _TOOL.search(t):
        return "tool", ""
    if _MECH_FIRST.search(t):
        return "mechanical", ""
    for k, rx in (("insert", _INSERT), ("nut", _NUT), ("washer", _WASHER), ("fastener", _FASTENER_FIRST),
                  ("screw", _SCREW), ("fastener", _FASTENER)):
        if rx.search(t):
            return k, ""
    if _CONSUMABLE.search(t):
        return "consumable", ""
    # A part LCSC sells, or one whose LCSC record says what it is.
    if info and info.get("category") and _MODULE_TAG.search(fold(info["category"])):
        return "module", ""
    if d.get("lcsc") or info:
        return "electronic", sub()
    if _MODULE.search(t):
        return "module", ""
    if _CABLE.search(t):
        return "cable", ""
    s = sub()
    if s or _PACKAGE.search(t) or re.search(r"\belectronic|elektronik", t):
        return "electronic", s
    if _MECH.search(t):
        return "mechanical", ""
    return "other", ""


def type_of(d: dict, info: dict | None = None) -> tuple[str, str, bool]:
    """(type, subtype, worked out): the person's own when set, else derived."""
    own, own_sub = d.get("type") or "", d.get("subtype") or ""
    if own in TYPE_IDS:
        sub = own_sub if own == "electronic" else ""
        if own == "electronic" and not sub:
            sub = subtype_of(_hay(d, info))
        return own, sub, False
    t, s = derive(d, info)
    return t, (own_sub or s) if t == "electronic" else "", True


# ---- what a type's card shows -------------------------------------------------------

# Colours a filament's name says, in English and Turkish: (words, name, swatch).
_COLOURS = [
    (r"black|siyah", "black", "#1d1d1f"), (r"white|beyaz", "white", "#f4f4f2"),
    (r"grey|gray|gri", "grey", "#8a8d91"), (r"silver|gumus", "silver", "#c0c3c7"),
    (r"red|kirmizi", "red", "#d0312d"), (r"orange|turuncu", "orange", "#f08a24"),
    (r"yellow|sari", "yellow", "#f2c94c"), (r"gold|altin", "gold", "#c9a227"),
    (r"green|yesil", "green", "#3a9d4f"), (r"blue|mavi", "blue", "#2f6fd0"),
    (r"navy|lacivert", "navy", "#22325c"), (r"turquoise|turkuaz|cyan", "turquoise", "#25b5b0"),
    (r"purple|mor|violet", "purple", "#7d4cc2"), (r"pink|pembe", "pink", "#e86fa6"),
    (r"brown|kahverengi|kahve", "brown", "#7a5230"), (r"beige|bej|skin|ten rengi", "beige", "#d9c3a0"),
    (r"transparent|clear|seffaf|natural|naturel|natur", "natural", "#e8e4d8"),
    (r"wood|ahsap", "wood", "#a07a4f"),
]
_COLOUR_RX = [(re.compile(rf"\b({w})\b"), n, h) for w, n, h in _COLOURS]
_MAT_NAMES = [("pla+", "PLA+"), ("pla plus", "PLA+"), ("petg", "PETG"), ("pet-g", "PETG"), ("pctg", "PCTG"),
              ("abs+", "ABS+"), ("abs", "ABS"), ("asa", "ASA"), ("tpu", "TPU"), ("tpe", "TPE"), ("pa-cf", "PA-CF"),
              ("nylon", "Nylon"), ("pa12", "PA12"), ("pa6", "PA6"), ("pva", "PVA"), ("hips", "HIPS"), ("pc", "PC"),
              ("cpe", "CPE"), ("pla", "PLA")]
_FINISH = [(r"\bsilk\b|\bipek\b", "Silk"), (r"\bmat(te)?\b", "Matte"), (r"carbon|\bcf\b|karbon", "CF"),
           (r"glow|fosforlu", "Glow"), (r"\bmarble|mermer", "Marble"), (r"\beco\b", "Eco"), (r"\bhs\b|high ?speed", "HS")]


def _num(s: str) -> float:
    return float(s.replace(",", "."))


def weight_g(d: dict, spool_g: float) -> float | None:
    """How much filament (or resin) is on hand, in grams, from the quantity
    and its unit: kg and g are what they say; spools, rolls and pieces are
    whole spools of `spool_g`."""
    q = float(d.get("quantity") or 0)
    u = str(d.get("unit") or "pcs").lower()
    if u == "kg":
        return q * 1000
    if u == "g":
        return q
    if u in ("l", "ml"):
        return None
    return q * spool_g


def facts(d: dict, kind: str, sub: str = "", info: dict | None = None) -> dict:
    """What the item's words say that its type's card shows."""
    t = fold(" ".join(str(x or "") for x in (d.get("name"), (d.get("catalog") or {}).get("product_name"),
                                              " ".join(d.get("tags") or []), d.get("notes")[:300] if d.get("notes") else "")))
    out: dict[str, Any] = {}
    if kind in ("filament", "resin"):
        if kind == "filament":
            for key, name in _MAT_NAMES:
                if re.search(rf"(?<![a-z]){re.escape(key)}(?![a-z])", t):
                    out["material"] = name
                    break
            m = re.search(r"\b(1[.,]75|2[.,]85|3[.,]00?)\s*mm\b", t)
            if m:
                out["diameter"] = _num(m.group(1))
            fin = [n for rx, n in _FINISH if re.search(rx, t)]
            if fin:
                out["finish"] = " ".join(fin)
        m = re.search(r"\b(\d+(?:[.,]\d+)?)\s*(kg|kilo|g|gr|gram)\b", t)
        size = None
        if m:
            v = _num(m.group(1)) * (1000 if m.group(2) in ("kg", "kilo") else 1)
            if 50 <= v <= 10000:
                size = v
        if kind == "resin":
            m2 = re.search(r"\b(\d+(?:[.,]\d+)?)\s*(ml|l|lt)\b", t)
            if m2:
                out["volume_ml"] = _num(m2.group(1)) * (1000 if m2.group(2) in ("l", "lt") else 1)
        spool = size or 1000.0
        out["spool_g"] = spool
        out["spool_stated"] = size is not None
        w = weight_g(d, spool)
        if w is not None:
            out["weight_g"] = round(w, 1)
            full = int(w // spool) if spool else 0
            rest = w - full * spool
            if rest < 1e-6 and full:
                full, rest = full - 1, spool
            out["spools"] = round(w / spool, 2) if spool else None
            out["full_spools"] = full
            out["current_g"] = round(rest, 1)
            out["current_pct"] = round(100 * rest / spool, 1) if spool else None
        for rx, name, hexa in _COLOUR_RX:
            if rx.search(t):
                out["colour"], out["colour_hex"] = name, hexa
                break
        return out
    if kind in ("screw", "nut", "washer", "insert", "fastener"):
        m = re.search(r"\bm(\d+(?:[.,]\d+)?)(?:\s*[x×*]\s*(\d+(?:[.,]\d+)?))?(?:\s*[x×*]\s*(\d+(?:[.,]\d+)?))?", t)
        if m:
            th = m.group(1).replace(",", ".")
            out["thread"] = f"M{th}"
            if m.group(2):
                out["length"] = _num(m.group(2))
            if m.group(3):
                out["width"] = _num(m.group(3))
            out["size"] = "M" + th + ("x" + m.group(2).replace(",", ".") if m.group(2) else "") \
                + ("x" + m.group(3).replace(",", ".") if m.group(3) else "")
        std = re.search(r"\b(din|iso|en)\s?-?(\d{2,5})\b", t)
        if std:
            out["standard"] = f"{std.group(1).upper()} {std.group(2)}"
        head, drive = _head_drive(t, out.get("standard", ""))
        if kind == "screw":
            if head:
                out["head"] = head
            if drive:
                out["drive"] = drive
        if kind == "nut":
            out["form"] = ("Nylock" if re.search(r"nyloc|din ?985|iso ?10511|fiberli|kilitli", t) else
                           "T-nut" if re.search(r"t-?nut|t somun|t-somun", t) else
                           "Square" if re.search(r"square|kare", t) else
                           "Wing" if re.search(r"\bwing|kelebek", t) else
                           "Flange" if re.search(r"flange|flans", t) else "Hex")
        if kind == "washer":
            out["form"] = ("Spring" if re.search(r"spring|lock|yaylı|yayli|din ?127", t) else
                           "Large" if re.search(r"large|fender|genis|din ?9021|iso ?7093", t) else "Flat")
        mat = ("Stainless A4" if re.search(r"\ba4\b", t) else
               "Stainless" if re.search(r"stainless|paslanmaz|\binox\b|\ba2\b|\b304\b|\b316\b", t) else
               "Brass" if re.search(r"brass|pirinc", t) else
               "Nylon" if re.search(r"nylon|naylon|plastic|plastik|\bpa66?\b", t) else
               "Aluminium" if re.search(r"alumin", t) else
               "Black steel" if re.search(r"black|siyah|12[.,]9", t) else
               "Zinc" if re.search(r"zinc|galvaniz|cinko", t) else
               "Steel" if re.search(r"steel|celik|\b8[.,]8\b|\b10[.,]9\b", t) else "")
        if mat:
            out["material"] = mat
        return out
    if kind == "electronic":
        nfo = info or {}
        pkg = _package(nfo.get("package") or "") or _package_in(t)
        if pkg:
            out["package"] = pkg
        val = nfo.get("value") or _value_in(t, sub)
        if val:
            out["value"] = val
        if nfo.get("mpn"):
            out["mpn"] = nfo["mpn"]
        if nfo.get("category"):
            out["lcsc_category"] = nfo["category"]
        return out
    if kind == "cable":
        m = re.search(r"\b(\d+(?:[.,]\d+)?)\s*awg\b|\bawg\s*(\d+)", t)
        if m:
            out["gauge"] = f"{m.group(1) or m.group(2)} AWG"
        m = re.search(r"\b(\d+(?:[.,]\d+)?)\s*(mm2|mm²)", t)
        if m:
            out["section"] = f"{m.group(1)} mm²"
        m = re.search(r"\b(\d+(?:[.,]\d+)?)\s*(cm|m)\b", t)
        if m:
            out["length"] = f"{m.group(1)} {m.group(2)}"
        return out
    return out


_HEADS = [
    (r"socket (head|cap)|silindir bas|\bimbus|allen|\bdin ?912\b|\biso ?4762\b", "Socket cap"),
    (r"button head|bombe|yuvarlak bas|\biso ?7380\b|\bdin ?7380\b", "Button"),
    (r"countersunk|flat head|havsa|\bdin ?(7991|965|963)\b|\biso ?(10642|7046|14581)\b", "Countersunk"),
    (r"pan head|\bdin ?7985\b|\biso ?(7045|14583)\b|silindir yuvarlak", "Pan"),
    (r"hex head|alti ?kose bas|altikose bas|\bdin ?(933|931)\b|\biso ?(4017|4014)\b", "Hex"),
    (r"set ?screw|grub|setskur|\bdin ?(913|914|916)\b|\biso ?(4026|4027|4029)\b", "Set screw"),
]
_DRIVES = [(r"torx|\btx\d", "Torx"), (r"phillips|yildiz|\bph\d\b|\bdin ?(965|7985)\b|\biso ?(7045|7046)\b", "Phillips"),
           (r"slotted|\bduz\b|\bdin ?84\b", "Slotted"),
           (r"hex socket|socket|allen|imbus|\bdin ?(912|7991|7380|913|914|916)\b|\biso ?(4762|7380|10642)\b", "Hex socket")]


def _head_drive(t: str, std: str) -> tuple[str, str]:
    head = next((n for rx, n in _HEADS if re.search(rx, t)), "")
    drive = next((n for rx, n in _DRIVES if re.search(rx, t)), "")
    if head in ("Socket cap", "Button", "Set screw") and not drive:
        drive = "Hex socket"
    if head == "Hex" and drive == "Hex socket" and not re.search(r"socket|allen|imbus", t):
        drive = ""
    return head, drive


def _package(raw: str) -> str:
    """EasyEDA's package name, said shortly: R0603 -> 0603, SOT-23_L2.9-... -> SOT-23."""
    p = raw.strip()
    if not p:
        return ""
    m = re.match(r"^(?:R|C|L|LED|D|F)(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b", p)
    if m:
        return m.group(1)
    m = re.search(r"(0201|0402|0603|0805|1206|1210|2512)", p)
    if m and re.match(r"^(LED|R|C|L)", p):
        return m.group(1)
    return re.split(r"_", p, 1)[0][:24]


def _package_in(t: str) -> str:
    m = re.search(r"\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b", t)
    if m:
        return m.group(1)
    m = re.search(r"\b(sot-?\d{2,3}(?:-\d)?|soic-?\d+|tssop-?\d+|qfn-?\d+|lqfp-?\d+|to-?(?:92|220|247|252|263)|dip-?\d+"
                  r"|sod-?\d+)\b", t)
    return m.group(1).upper() if m else ""


def _value_in(t: str, sub: str) -> str:
    if sub == "resistor":
        m = re.search(r"\b(\d+(?:[.,]\d+)?\s*[kmr]?)\s*(?:ohm|ω)|\b(\d+[kmr]\d*)\b", t)
        if m:
            v = (m.group(1) or m.group(2)).replace(" ", "")
            return v.upper().replace("R", "R").replace("K", "k") + ("Ω" if m.group(1) else "")
    if sub == "capacitor":
        m = re.search(r"\b(\d+(?:[.,]\d+)?)\s*(pf|nf|uf|μf|µf)\b", t)
        if m:
            return m.group(1) + {"pf": "pF", "nf": "nF"}.get(m.group(2), "µF")
    if sub == "inductor":
        m = re.search(r"\b(\d+(?:[.,]\d+)?)\s*(nh|uh|μh|µh|mh)\b", t)
        if m:
            return m.group(1) + {"nh": "nH", "mh": "mH"}.get(m.group(2), "µH")
    if sub == "crystal":
        m = re.search(r"\b(\d+(?:[.,]\d+)?)\s*(mhz|khz)\b", t)
        if m:
            return m.group(1) + (" MHz" if m.group(2) == "mhz" else " kHz")
    return ""
