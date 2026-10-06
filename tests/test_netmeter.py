"""The proxy meter: every byte between this machine and the proxy, counted
both ways - what a residential proxy bills - and put down to its session
and its destination."""
from __future__ import annotations

import asyncio
import base64

from backend import netmeter


def _head(target: str, user: str | None) -> bytes:
    auth = (f"Proxy-Authorization: Basic {base64.b64encode(f'{user}:pw'.encode()).decode()}\r\n"
            if user else "")
    return f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n{auth}\r\n".encode()


def test_the_session_and_the_destination_are_read_from_the_head():
    head = _head("easyeda.com:443", "acct-zone-custom-region-de-session-rl3f9a")
    assert netmeter._session_of(head) == "rl3f9a"
    assert netmeter._target_of(head) == "easyeda.com"
    assert netmeter._session_of(_head("ipinfo.io:443", "acct-zone-custom")) is None
    assert netmeter._target_of(b"GET http://Example.org/x HTTP/1.1\r\n\r\n") == "example.org"


def test_every_byte_is_counted_both_ways(monkeypatch):
    """A stand-in proxy answers the CONNECT and echoes; the meter's counts
    must equal what the client put on and took off its own socket."""
    async def main():
        monkeypatch.setattr(netmeter, "_server", None)
        monkeypatch.setattr(netmeter, "_port", None)
        monkeypatch.setattr(netmeter, "_upstream", None)
        monkeypatch.setattr(netmeter, "_sessions", {})
        monkeypatch.setattr(netmeter, "_session_seen", {})
        monkeypatch.setattr(netmeter, "_db_getter", None)

        async def fake_proxy(r: asyncio.StreamReader, w: asyncio.StreamWriter):
            await r.readuntil(b"\r\n\r\n")
            w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await w.drain()
            while data := await r.read(4096):
                w.write(data * 3)                         # the answer is three times the question
                await w.drain()
            w.close()

        upstream = await asyncio.start_server(fake_proxy, "127.0.0.1", 0)
        netmeter.set_upstream("127.0.0.1", upstream.sockets[0].getsockname()[1])
        port = await netmeter.start()

        r, w = await asyncio.open_connection("127.0.0.1", port)
        head = _head("easyeda.com:443", "acct-zone-custom-session-rlabc")
        payload = bytes(range(256)) * 37                  # 9472 bytes
        sent, got = len(head) + len(payload), 0
        w.write(head)
        got += len(await r.readuntil(b"\r\n\r\n"))
        w.write(payload)
        await w.drain()
        w.write_eof()
        while chunk := await r.read(65536):
            got += len(chunk)
        w.close()
        await asyncio.sleep(0.1)
        netmeter._server.close()
        upstream.close()
        return sent, got

    sent, got = asyncio.run(main())
    counted = netmeter.session_bytes("rlabc")["easyeda.com"]
    assert (counted["up"], counted["down"], counted["conns"]) == (sent, got, 1)
    assert got == len(b"HTTP/1.1 200 Connection established\r\n\r\n") + 9472 * 3
