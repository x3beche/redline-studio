"""SSD1306 OLED controller over I2C (128x64, address 0x3C/0x3D).

Written from the SSD1306 datasheet. Orientation: every common driver
(Adafruit, u8g2, luma) sends A1 + C8 for an upright image on the usual
modules, so that pair is drawn upright and A0 / C0 mirror it. COM pin
configuration (DA) and scrolling are accepted and not drawn.
"""

from __future__ import annotations

from .parts import Part, Screen, reply

# Commands that take arguments, and how many. Everything else takes none.
ARGS = {0x20: 1, 0x21: 2, 0x22: 2, 0x26: 6, 0x27: 6, 0x29: 5, 0x2A: 5, 0x81: 1, 0xA3: 2,
        0xA8: 1, 0xD3: 1, 0xD5: 1, 0xD9: 1, 0xDA: 1, 0xDB: 1, 0x8D: 1}


class SSD1306(Part):
    def __init__(self, ref, spec, emit):
        super().__init__(ref, spec, emit)
        self.screen = Screen(ref, {"width": 128, "height": spec.get("height", 64)}, emit)
        self.ram = [bytearray(128) for _ in range(8)]      # GDDRAM: 8 pages x 128 columns
        self.cmd: list[int] = []                           # a command waiting for its arguments
        self.on_ = self.invert = self.all_on = self.seg_remap = self.com_remap = False
        self.mode, self.contrast, self.mux, self.start, self.offset = 2, 0x7F, 63, 0, 0
        self.col, self.page = 0, 0
        self.cols, self.pages, self.page_col = (0, 127), (0, 7), 0

    # -- I2C ------------------------------------------------------------------
    def on(self, msg):
        if msg["type"] != "i2c":
            return None
        data, i = bytes.fromhex(msg.get("write") or ""), 0
        while i < len(data):                 # control byte: Co (bit 7), D/C# (bit 6)
            ctrl, i = data[i], i + 1
            if ctrl & 0x80:                  # Co=1: one byte, then another control byte
                if i < len(data):
                    self._byte(data[i], ctrl & 0x40)
                i += 1
            else:                            # Co=0: the rest is one stream
                for b in data[i:]:
                    self._byte(b, ctrl & 0x40)
                break
        return reply(msg)

    def _byte(self, b: int, is_data: int) -> None:
        if is_data:
            self._data(b)
            return
        self.cmd.append(b)
        if len(self.cmd) > ARGS.get(self.cmd[0], 0):
            self._command(*self.cmd)
            self.cmd = []

    def _command(self, c: int, *a: int) -> None:
        if c in (0xAE, 0xAF):
            self.on_ = c == 0xAF
        elif c == 0x20:
            self.mode = a[0] & 3
        elif c == 0x21:
            self.cols = (a[0] & 127, a[1] & 127)
            self.col = self.cols[0]
        elif c == 0x22:
            self.pages = (a[0] & 7, a[1] & 7)
            self.page = self.pages[0]
        elif 0xB0 <= c <= 0xB7:
            self.page = c & 7
        elif c <= 0x0F:
            self.col = self.page_col = (self.col & 0xF0) | c
        elif 0x10 <= c <= 0x1F:
            self.col = self.page_col = ((c & 0x0F) << 4) | (self.col & 0x0F)
        elif 0x40 <= c <= 0x7F:
            self.start = c & 63
        elif c == 0x81:
            self.contrast = a[0]
        elif c in (0xA0, 0xA1):
            self.seg_remap = c == 0xA1
        elif c in (0xC0, 0xC8):
            self.com_remap = c == 0xC8
        elif c in (0xA6, 0xA7):
            self.invert = c == 0xA7
        elif c in (0xA4, 0xA5):
            self.all_on = c == 0xA5
        elif c == 0xA8:
            self.mux = max(15, a[0] & 63)
        elif c == 0xD3:
            self.offset = a[0] & 63
        # D5 D9 DA DB 8D, scrolling 26 27 29 2A 2E 2F A3, E3 (nop): accepted, nothing to draw

    def _data(self, b: int) -> None:
        self.ram[self.page][self.col] = b
        (c0, c1), (p0, p1) = self.cols, self.pages
        if self.mode == 0:                   # horizontal: column, then page
            self.col += 1
            if self.col > c1:
                self.col = c0
                self.page = p0 if self.page >= p1 else self.page + 1
        elif self.mode == 1:                 # vertical: page, then column
            self.page += 1
            if self.page > p1:
                self.page = p0
                self.col = c0 if self.col >= c1 else self.col + 1
        else:                                # page: column wraps to its start, page stays
            self.col = self.page_col if self.col >= 127 else self.col + 1

    # -- what the page draws --------------------------------------------------
    def view(self):
        s = self.screen
        for y in range(s.h):
            row = y if self.com_remap else s.h - 1 - y
            ram_row = (row + self.start + self.offset) & 63
            for x in range(s.w):
                col = x if self.seg_remap else 127 - x
                lit = row <= self.mux and (self.ram[ram_row >> 3][col] >> (ram_row & 7)) & 1
                if self.all_on:
                    lit = 1
                s.set(x, y, self.on_ and bool(lit) != self.invert)
        out = s.view()
        out["screen"].update(on=self.on_, contrast=self.contrast)
        return out
