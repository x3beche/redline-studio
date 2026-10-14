"""Voice to text (backend/voice.py): POST /api/voice/transcribe.

What matters: the phone app's contract holds (fields, answer shape, 400 /
503 / 502); a recording is known by its bytes, not its name, and its length
is read from the container - Chrome's webm without a Duration, Safari's
fragmented m4a, ogg/opus, wav, mp3, aac, flac - so a long or wrong file is
refused before a model is paid; the audio goes to the job's own provider
and model as OpenRouter's input_audio part with the format named; the
call is in the usage log as kind "voice"; only someone who may write a
chat line may ask; and Settings' Test sends a voice model audio. No real
model is called here.
"""

import asyncio
import base64
import struct

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import access, llm, llm_api, voice


# ---------------- recordings made here ----------------

def wav(seconds=2.0, rate=16000):
    return voice.silence_wav(seconds, rate)


def ebml(eid: int, body: bytes, unknown=False) -> bytes:
    """One EBML element: its id as written, an 8-byte size (or "unknown")."""
    n = (eid.bit_length() + 7) // 8
    size = b"\x01\xff\xff\xff\xff\xff\xff\xff" if unknown else b"\x01" + len(body).to_bytes(7, "big")
    return eid.to_bytes(n, "big") + size + body


def webm(seconds=3.0, duration=False):
    """As Chrome's MediaRecorder writes it: no Duration, a cluster of unknown
    size, SimpleBlocks every 20 ms (timecodes relative to the cluster's)."""
    head = ebml(0x1A45DFA3, ebml(0x4282, b"webm"))
    info = ebml(0x2AD7B1, (1_000_000).to_bytes(3, "big"))
    if duration:
        info += ebml(0x4489, struct.pack(">d", seconds * 1000))
    blocks = b""
    cluster_at = 0
    clusters = b""
    t = 0
    while t <= seconds * 1000 - 20:
        if t - cluster_at > 30000:                     # a new cluster every 30 s
            clusters += ebml(0x1F43B675, ebml(0xE7, cluster_at.to_bytes(4, "big")) + blocks, unknown=True)
            cluster_at, blocks = t, b""
        blocks += ebml(0xA3, b"\x81" + struct.pack(">h", t - cluster_at) + b"\x80" + b"\x00" * 10)
        t += 20
    clusters += ebml(0x1F43B675, ebml(0xE7, cluster_at.to_bytes(4, "big")) + blocks, unknown=True)
    return head + ebml(0x18538067, ebml(0x1549A966, info) + clusters, unknown=True)


def ogg_opus(seconds=4.0, skip=312):
    def page(granule, body):
        return b"OggS\x00\x00" + struct.pack("<q", granule) + b"\x00" * 12 + body
    head = page(0, b"OpusHead\x01\x01" + struct.pack("<H", skip) + b"\x80\xbb\x00\x00")
    return head + page(0, b"OpusTags") + page(int(seconds * 48000) + skip, b"\x00" * 50)


def box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", 8 + len(body)) + kind + body


def m4a(seconds=5.0, fragmented=False):
    scale = 44100
    ftyp = box(b"ftyp", b"M4A \x00\x00\x02\x00isomM4A ")
    dur = 0 if fragmented else int(seconds * scale)
    mvhd = box(b"mvhd", b"\x00\x00\x00\x00" + struct.pack(">IIII", 0, 0, 1000, int(dur / scale * 1000)) + b"\x00" * 80)
    mdhd = box(b"mdhd", b"\x00\x00\x00\x00" + struct.pack(">IIII", 0, 0, scale, dur) + b"\x00" * 4)
    moov = box(b"moov", mvhd + box(b"trak", box(b"mdia", mdhd)))
    if not fragmented:
        return ftyp + moov + box(b"mdat", b"\x00" * 100)
    frames = int(seconds * scale / 1024)
    out = ftyp + moov
    per = 20
    for start in range(0, frames, per):
        n = min(per, frames - start)
        tfhd = box(b"tfhd", b"\x00\x00\x00\x08" + struct.pack(">II", 1, 1024))   # default duration 1024
        trun = box(b"trun", b"\x00\x00\x02\x00" + struct.pack(">I", n) + struct.pack(">I", 100) * n)  # sizes only
        out += box(b"moof", box(b"traf", tfhd + trun)) + box(b"mdat", b"\x00" * 100 * n)
    return out


def mp3(seconds=6.0):
    # MPEG-1 layer III, 64 kbit/s, 44.1 kHz, no Xing: estimated from the size.
    frame = b"\xff\xfb\x50\x00" + b"\x00" * 204
    return b"ID3\x03\x00\x00\x00\x00\x00\x00" + frame * int(seconds * 64000 / 8 / len(frame))


def adts(seconds=3.0):
    n = 7 + 100
    hdr = bytes([0xFF, 0xF1, (1 << 6) | (4 << 2), 0x80 | (n >> 11), (n >> 3) & 0xFF, ((n & 7) << 5) | 0x1F, 0xFC])
    return (hdr + b"\x00" * 100) * int(seconds * 44100 / 1024)


def flac(seconds=2.0, rate=16000):
    x = (rate << 44) | (0 << 41) | (15 << 36) | int(seconds * rate)
    return b"fLaC" + b"\x80\x00\x00\x22" + b"\x00" * 10 + x.to_bytes(8, "big") + b"\x00" * 16


# ---------------- what a file is, and how long ----------------

@pytest.mark.parametrize("make, fmt, secs", [
    (lambda: wav(2.0), "wav", 2.0),
    (lambda: webm(3.0), "webm", 3.0),
    (lambda: webm(3.0, duration=True), "webm", 3.0),
    (lambda: webm(75.0), "webm", 75.0),
    (lambda: ogg_opus(4.0), "ogg", 4.0),
    (lambda: m4a(5.0), "m4a", 5.0),
    (lambda: m4a(5.0, fragmented=True), "m4a", 5.0),
    (lambda: mp3(6.0), "mp3", 6.0),
    (lambda: adts(3.0), "aac", 3.0),
    (lambda: flac(2.0), "flac", 2.0),
])
def test_known_by_its_bytes_and_measured(make, fmt, secs):
    got_fmt, got = voice.sniff(make())
    assert got_fmt == fmt
    assert got == pytest.approx(secs, abs=0.15)


@pytest.mark.parametrize("data, word", [
    (b"", "empty"),
    (b"#!AMR\n" + b"\x00" * 40, "AMR"),
    (b"\x00\x00\x00\x18ftyp3gp4" + b"\x00" * 40, "3GP"),
    (b"<html><body>hello</body></html>", "not a recording"),
    (b"%PDF-1.7\n" + b"\x00" * 40, "not a recording"),
])
def test_what_is_not_taken_says_so(data, word):
    with pytest.raises(voice.BadAudio, match=word):
        voice.sniff(data)


def test_a_file_that_hides_its_length_is_guessed_long_not_short():
    # A webm with no blocks the walk can read: guessed from the size at a low bit rate.
    assert voice.seconds_guess(4000 * 400, "webm") == 400
    assert voice.seconds_guess(32000 * 10, "wav") == 10


def test_language_of_the_transcript():
    assert voice.language("Kartın üzerindeki kondansatörü iki milimetre sola kaydıralım.") == "tr"
    assert voice.language("Please move the connector to the left.") == "en"
    assert voice.language("Şimdi decoupling capacitor'leri kontrol et, sonra pull request aç.") == "tr"
    assert voice.language("STM32", "tr") == "tr"
    assert voice.language("", "en") == "en"


# ---------------- the route ----------------

class Coll:
    def __init__(self):
        self.rows = []

    async def update_one(self, q, update, upsert=False):
        self.rows.append({**q, **(update.get("$setOnInsert") or {})})


class Db:
    def __init__(self):
        self.colls = {}

    def __getitem__(self, name):
        return self.colls.setdefault(name, Coll())


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {"openrouter": "k"}, "jobs": {}})
    calls = []
    answer = {"text": "Kartın üzerindeki STM32'nin yanına 10 mikrofaradlık bir kondansatör ekleyelim."}

    async def complete(messages, **kw):
        calls.append({"messages": messages, **kw})
        return {"choices": [{"message": {"content": answer["text"]}}],
                "usage": {"prompt_tokens": 600, "completion_tokens": 60, "cost": 0.00034},
                "provider": kw["provider"], "model": kw["model"]}

    async def models(provider):
        return [{"id": "google/gemini-3.1-flash-lite", "audio": True},
                {"id": "some/text-only", "audio": False}]

    async def endpoint(provider, model):
        return "messages" if provider == "commandcode" and model.startswith("claude-") else "chat"

    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "models", models)
    monkeypatch.setattr(llm, "_endpoint", endpoint)
    db = Db()
    monkeypatch.setattr(voice, "_db", lambda: db)
    monkeypatch.setattr(llm_api, "_db", lambda: db)
    app = FastAPI()
    app.include_router(voice.router)
    app.include_router(llm_api.router)
    return TestClient(app), db, calls, answer


def post(client, data: bytes, name="clip.webm", **form):
    return client.post("/api/voice/transcribe", files={"audio": (name, data, "audio/webm")}, data=form)


def test_contract_answer_and_the_call(env):
    client, db, calls, _ = env
    r = post(client, webm(3.0), lang="tr", purpose="note")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["text"].startswith("Kartın üzerindeki STM32")
    assert d["language"] == "tr"
    assert d["model"] == "google/gemini-3.1-flash-lite"
    assert d["seconds"] == pytest.approx(3.0, abs=0.1)
    # The job's own provider and model, the audio as an input_audio part with its format.
    (c,) = calls
    assert (c["provider"], c["model"]) == llm.JOBS["voice"]["default"]
    assert c["temperature"] == 0
    parts = c["messages"][0]["content"]
    assert "verbatim" in parts[0]["text"] and "Never translate" in parts[0]["text"]
    assert "Turkish" in parts[0]["text"].split("\n\n")[-1]
    audio = parts[1]["input_audio"]
    assert audio["format"] == "webm" and base64.b64decode(audio["data"]) == webm(3.0)
    # In the usage log like every job's.
    (row,) = db["llm_calls"].rows
    assert row["kind"] == "voice" and row["surface"] == "note"
    assert row["model"] == "google/gemini-3.1-flash-lite" and row["cost_usd"] == 0.00034
    assert llm.job_label("voice") == "Voice to text"


def test_the_format_named_is_the_bytes_not_the_name(env):
    client, _, calls, _ = env
    assert post(client, m4a(4.0, fragmented=True), name="voice.webm").status_code == 200
    assert calls[-1]["messages"][0]["content"][1]["input_audio"]["format"] == "m4a"


def test_nothing_said_is_an_empty_text(env):
    client, _, _, answer = env
    answer["text"] = "(no speech)"
    d = post(client, wav(1.0)).json()
    assert d["text"] == "" and d["language"] == "en"


def test_limits(env, monkeypatch):
    client, _, calls, _ = env
    r = post(client, webm(310.0))
    assert r.status_code == 400 and "at most 5 minutes" in r.json()["detail"]
    monkeypatch.setattr(voice, "MAX_BYTES", 1000)
    r = post(client, wav(1.0))
    assert r.status_code == 400 and "MB" in r.json()["detail"]
    monkeypatch.setattr(voice, "MAX_BYTES", 10 * 1024 * 1024)
    r = post(client, wav(0.1))
    assert r.status_code == 400 and "too short" in r.json()["detail"]
    r = post(client, b"not audio at all, just some text bytes")
    assert r.status_code == 400 and "webm" in r.json()["detail"]
    assert post(client, wav(1.0), lang="de").status_code == 400
    assert post(client, wav(1.0), purpose="mail").status_code == 400
    assert not calls                                   # nothing was paid for


def test_not_configured_is_503(env, monkeypatch):
    client, _, calls, _ = env
    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})
    r = post(client, wav(1.0))
    assert r.status_code == 503 and "OpenRouter API key" in r.json()["detail"]
    monkeypatch.setattr(llm, "_conf", {"keys": {"openrouter": "k"},
                                       "jobs": {"voice": {"provider": "openrouter", "model": "some/text-only"}}})
    r = post(client, wav(1.0))
    assert r.status_code == 503 and "does not take audio" in r.json()["detail"]
    monkeypatch.setattr(llm, "_conf", {"keys": {"commandcode": "k"},
                                       "jobs": {"voice": {"provider": "commandcode", "model": "claude-sonnet-5"}}})
    r = post(client, wav(1.0))
    assert r.status_code == 503 and "takes no audio" in r.json()["detail"]
    monkeypatch.setattr(llm, "_loaded", False)
    assert post(client, wav(1.0)).status_code == 503
    assert not calls


def test_provider_failure_is_502_with_its_words(env, monkeypatch):
    client, db, _, _ = env

    async def fails(messages, **kw):
        raise RuntimeError("OpenRouter answered HTTP 400: Audio format not supported")

    monkeypatch.setattr(llm, "complete", fails)
    r = post(client, wav(1.0))
    assert r.status_code == 502 and "Audio format not supported" in r.json()["detail"]
    assert not db["llm_calls"].rows


def test_rights_are_a_chat_lines():
    assert access.action("POST", "/api/voice/transcribe") == "draw"
    assert access.allowed("reviewer", "draw") and access.allowed("user", "draw")
    assert not access.allowed("viewer", "draw")


def test_settings_lists_the_job_and_its_test_sends_audio(env):
    client, _, calls, _ = env
    job = llm.public()["jobs"]["voice"]
    assert job["audio"] is True and job["provider"] == "openrouter"
    r = client.post("/api/llm/test", json={"provider": "openrouter", "model": "google/gemini-3.1-flash-lite", "job": "voice"})
    assert r.json()["ok"] is True
    parts = calls[-1]["messages"][0]["content"]
    assert parts[1]["type"] == "input_audio" and parts[1]["input_audio"]["format"] == "wav"
    # Another job's test is words only, as before.
    client.post("/api/llm/test", json={"provider": "openrouter", "model": "x/y", "job": "summary"})
    assert calls[-1]["messages"][0]["content"] == "Reply with exactly: OK"
    # A model that takes no audio fails the voice test with words, not a made-up OK.
    r = client.post("/api/llm/test", json={"provider": "openrouter", "model": "some/text-only", "job": "voice"})
    assert r.json()["ok"] is False and "does not take audio" in r.json()["error"]


def test_models_say_whether_they_take_audio(monkeypatch):
    rows = [{"id": "a/audio", "architecture": {"input_modalities": ["text", "audio"]}},
            {"id": "b/text", "architecture": {"input_modalities": ["text"]}},
            {"id": "c/unknown"}]

    async def fake_rows(provider):
        return rows

    monkeypatch.setattr(llm, "_model_rows", fake_rows)
    monkeypatch.setattr(llm, "_models_cache", {})
    got = {m["id"]: m["audio"] for m in asyncio.run(llm.models("openrouter"))}
    assert got == {"a/audio": True, "b/text": False, "c/unknown": None}
