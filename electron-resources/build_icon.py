"""
Generate Notes Intel icon (teal rounded square with NI lettermark).
Run: python electron-resources/build_icon.py
Requires: pip install Pillow
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ICO_OUT = HERE / "icon.ico"
PNG_OUT = HERE / "icon.png"

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

TEAL        = (93, 202, 165)   # #5DCAA5
TEAL_DARK   = (4, 52, 44)      # #04342C
BG          = (8, 8, 9, 0)     # transparent background


def rounded_rectangle(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.ellipse([x0, y0, x0 + radius * 2, y0 + radius * 2], fill=fill)
    draw.ellipse([x1 - radius * 2, y0, x1, y0 + radius * 2], fill=fill)
    draw.ellipse([x0, y1 - radius * 2, x0 + radius * 2, y1], fill=fill)
    draw.ellipse([x1 - radius * 2, y1 - radius * 2, x1, y1], fill=fill)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(size * 0.06)
    radius = int(size * 0.22)
    rounded_rectangle(draw, (pad, pad, size - pad - 1, size - pad - 1), radius, TEAL)

    # Draw a simple "N" lettermark in teal-dark
    m = int(size * 0.28)
    r = size - m
    lw = max(2, int(size * 0.09))
    draw.line([(m, m), (m, r)], fill=TEAL_DARK, width=lw)
    draw.line([(m, m), (r, r)], fill=TEAL_DARK, width=lw)
    draw.line([(r, m), (r, r)], fill=TEAL_DARK, width=lw)

    return img


def main():
    base = make_icon(512)
    base.save(PNG_OUT, format="PNG")
    print(f"Wrote {PNG_OUT}")

    frames = [make_icon(s[0]) for s in ICO_SIZES]
    frames[0].save(
        ICO_OUT,
        format="ICO",
        sizes=ICO_SIZES,
        append_images=frames[1:],
    )
    print(f"Wrote {ICO_OUT}")


if __name__ == "__main__":
    main()
