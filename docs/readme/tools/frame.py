"""Frame and shrink an image for the README.

usage: frame.py in.png out.png [--crop x,y,w,h] [--width 2000] [--pad 28]
                               [--radius 28] [--inner 14] [--raw] [--quality 80]

A screenshot is cropped (pixels of the input), scaled down to --width,
set with rounded corners and a hairline border on a near-black panel that
itself has rounded, transparent corners - so it reads as a card on both a
dark and a light GitHub page. --raw skips the panel (for pages that already
draw their own, like the feature cards). The result is quantized with
libimagequant (pip: imagequant) when that is installed.
"""
import argparse, sys
from PIL import Image, ImageDraw

SURFACE = (9, 9, 11, 255)      # spartan-dark --surface
LINE = (39, 39, 42, 255)       # --line


def rounded(size, r, fill):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), r, fill=255)
    layer = Image.new("RGBA", size, fill)
    layer.putalpha(m)
    return layer, m


def main():
    a = argparse.ArgumentParser()
    a.add_argument("src"); a.add_argument("dst")
    a.add_argument("--crop"); a.add_argument("--width", type=int, default=0)
    a.add_argument("--pad", type=int, default=28); a.add_argument("--radius", type=int, default=28)
    a.add_argument("--inner", type=int, default=14); a.add_argument("--raw", action="store_true")
    a.add_argument("--quality", type=int, default=82)
    o = a.parse_args()
    im = Image.open(o.src).convert("RGBA")
    if o.crop:
        x, y, w, h = map(int, o.crop.split(","))
        im = im.crop((x, y, x + w, y + h))
    if not o.raw:
        inner_w = (o.width - 2 * o.pad - 4) if o.width else im.width
        if inner_w != im.width:
            im = im.resize((inner_w, round(im.height * inner_w / im.width)), Image.LANCZOS)
        # the shot, rounded, with a 2px hairline (1 css px at 2x)
        b = 2
        framed, mask = rounded((im.width + 2 * b, im.height + 2 * b), o.inner + b, LINE)
        _, m2 = rounded(im.size, o.inner, (0, 0, 0, 0))
        framed.paste(im, (b, b), m2)
        W, H = framed.width + 2 * o.pad, framed.height + 2 * o.pad
        panel, _ = rounded((W, H), o.radius, SURFACE)
        panel.alpha_composite(framed, (o.pad, o.pad))
        im = panel
    elif o.width and o.width != im.width:
        im = im.resize((o.width, round(im.height * o.width / im.width)), Image.LANCZOS)
    try:
        import imagequant
        q = imagequant.quantize_pil_image(im, dithering_level=0.6, max_colors=256,
                                          min_quality=max(0, o.quality - 20), max_quality=o.quality)
        q.save(o.dst, optimize=True)
    except Exception as e:  # no libimagequant, or quality not reachable: keep it full colour
        print("unquantized:", e, file=sys.stderr)
        im.save(o.dst, optimize=True)
    import os
    print(o.dst, Image.open(o.dst).size, f"{os.path.getsize(o.dst)/1024:.0f} KB")


if __name__ == "__main__":
    main()
