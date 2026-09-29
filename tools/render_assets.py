#!/usr/bin/env python3
"""Render build/scenes.json (produced by tools/capture.ts) to the PNG/GIF files in assets/.

Fully offline: it parses the ANSI text the extension really emitted and paints it cell by cell with
Pillow onto a dark terminal-window mock (title bar, rounded corners, soft shadow). No GUI, no
screenshots. Font: $BUNNY_FONT, else the first monospace font found from FONT_CANDIDATES.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SCENES = ROOT / "build" / "scenes.json"
ASSETS = ROOT / "assets"

FONT_CANDIDATES = [
    os.environ.get("BUNNY_FONT", ""),
    str(Path.home() / ".local/share/fonts/fonts/FiraCodeNerdFontMono-Regular.ttf"),
    "/usr/share/fonts/adobe-source-code-pro-fonts/SourceCodePro-Regular.otf",
    "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]

BASE_FONT_PX = 15
LINE_HEIGHT = 1.34
PAD_X, PAD_Y = 20, 14
TITLEBAR = 36
RADIUS = 12
SHADOW = 34  # margin around the window that holds the shadow

BG = (13, 17, 23)
TITLE_BG = (28, 33, 40)
FG = (201, 209, 217)
BORDER = (48, 54, 61)
DOTS = [(255, 95, 86), (255, 189, 46), (39, 201, 63)]

SGR = re.compile(r"\x1b\[([0-9;]*)m")


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if path and Path(path).exists():
            return path
    sys.exit("no monospace font found; set BUNNY_FONT=/path/to/font.ttf")


FONT_PATH = find_font()

try:  # optional: fail loudly on glyphs the font cannot draw instead of rendering tofu boxes
    from fontTools.ttLib import TTFont

    CMAP = TTFont(FONT_PATH, fontNumber=0).getBestCmap()
except ImportError:
    CMAP = None

PAINTED = set("█░─│╭╮╰╯★ ")  # drawn by hand, so the font does not need them


def parse_line(line: str) -> list[tuple[str, tuple[int, int, int]]]:
    """ANSI string -> [(char, rgb)]. Understands exactly what the extension and the mock emit:
    38;2;r;g;b and 0. Anything else is a bug worth failing on."""
    cells, color, pos = [], FG, 0
    for m in SGR.finditer(line):
        cells += [(c, color) for c in line[pos : m.start()]]
        pos = m.end()
        params = [int(p) for p in m.group(1).split(";") if p != ""] or [0]
        if params == [0]:
            color = FG
        elif params[:2] == [38, 2] and len(params) == 5:
            color = tuple(params[2:5])
        else:
            raise ValueError(f"unsupported SGR sequence: {m.group(0)!r}")
    cells += [(c, color) for c in line[pos:]]
    return cells


def mix(a, b, t):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))


def draw_cell(d: ImageDraw.ImageDraw, ch, color, x, y, cw, ch_h, font, ascent, scale):
    cx, cy = x + cw / 2, y + ch_h / 2
    lw = max(1, round(1.2 * scale))
    if ch == "█":  # stat bars: inset vertically so stacked rows read as bars, not one slab
        inset = round(ch_h * 0.2)
        d.rectangle([x, y + inset, x + cw - 1, y + ch_h - 1 - inset], fill=color)
    elif ch == "░":
        inset = round(ch_h * 0.2)
        d.rectangle([x, y + inset, x + cw - 1, y + ch_h - 1 - inset], fill=mix(BG, color, 0.22))
    elif ch == "★":
        outer, inner = cw * 0.52, cw * 0.21
        pts = [
            (cx + (outer if i % 2 == 0 else inner) * math.sin(i * math.pi / 5), cy + 1 - (outer if i % 2 == 0 else inner) * math.cos(i * math.pi / 5))
            for i in range(10)
        ]
        d.polygon(pts, fill=color)
    elif ch == "─":
        d.line([x, cy, x + cw, cy], fill=color, width=lw)
    elif ch == "│":
        d.line([cx, y, cx, y + ch_h], fill=color, width=lw)
    elif ch in "╭╮╰╯":
        r = cw / 2
        right, down = ch in "╭╰", ch in "╭╮"
        ex = x + cw if right else x  # horizontal stub end
        ey = y + ch_h if down else y  # vertical stub end
        hx0, hx1 = (cx + r, ex) if right else (ex, cx - r)
        vy0, vy1 = (cy + r, ey) if down else (ey, cy - r)
        d.line([hx0, cy, hx1, cy], fill=color, width=lw)
        d.line([cx, vy0, cx, vy1], fill=color, width=lw)
        box = [cx if right else cx - 2 * r, cy if down else cy - 2 * r, cx + 2 * r if right else cx, cy + 2 * r if down else cy]
        start = {"╭": 180, "╮": 270, "╯": 0, "╰": 90}[ch]
        d.arc(box, start, start + 90, fill=color, width=lw)
    elif ch != " ":
        if CMAP is not None and ord(ch) not in CMAP:
            raise ValueError(f"font has no glyph for {ch!r} (U+{ord(ch):04X})")
        d.text((x, y + (ch_h - ascent) / 2 - 1), ch, font=font, fill=color, anchor="la")


def render_window(screen: dict, scale: float = 2.0, shadow: bool = True) -> Image.Image:
    """One terminal-window mock (RGBA, transparent margin holding the shadow)."""
    px = round(BASE_FONT_PX * scale)
    font = ImageFont.truetype(FONT_PATH, px)
    asc, desc = font.getmetrics()
    cw = round(font.getlength("M"))
    ch_h = round(px * LINE_HEIGHT)
    rows = [parse_line(l) for l in screen["lines"]]
    cols = screen["cols"]
    pad_x, pad_y, bar, m = (round(v * scale) for v in (PAD_X, PAD_Y, TITLEBAR, SHADOW))
    w = cols * cw + 2 * pad_x
    h = bar + len(rows) * ch_h + 2 * pad_y
    radius = round(RADIUS * scale)

    win = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(win)
    d.rectangle([0, 0, w, bar], fill=TITLE_BG)
    d.line([0, bar, w, bar], fill=BORDER, width=max(1, round(scale)))
    dr = round(6 * scale)
    for i, c in enumerate(DOTS):
        cx = pad_x + dr + i * round(20 * scale)
        d.ellipse([cx - dr, bar / 2 - dr, cx + dr, bar / 2 + dr], fill=c)
    tfont = ImageFont.truetype(FONT_PATH, round(13 * scale))
    title = screen.get("title", "")
    d.text((w / 2, bar / 2), title, font=tfont, fill=(139, 148, 158), anchor="mm")
    for r, cells in enumerate(rows):
        y = bar + pad_y + r * ch_h
        for c, (glyph, color) in enumerate(cells[:cols]):
            draw_cell(d, glyph, color, pad_x + c * cw, y, cw, ch_h, font, asc + desc, scale)

    # rounded corners: draw the mask 4x larger and shrink for anti-aliasing
    ss = 4
    mask = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], radius * ss, fill=255)
    mask = mask.resize((w, h), Image.LANCZOS)
    # 1px window outline
    outline = Image.new("L", (w * ss, h * ss), 0)
    od = ImageDraw.Draw(outline)
    od.rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], radius * ss, fill=255)
    od.rounded_rectangle([ss, ss, w * ss - 1 - ss, h * ss - 1 - ss], (radius - 1) * ss, fill=0)
    outline = outline.resize((w, h), Image.LANCZOS)
    win.paste(Image.new("RGB", (w, h), (58, 65, 74)), (0, 0), outline)

    canvas = Image.new("RGBA", (w + 2 * m, h + 2 * m), (0, 0, 0, 0))
    if shadow:
        sh = Image.new("L", canvas.size, 0)
        sh.paste(mask.point(lambda v: int(v * 0.6)), (m, m + round(10 * scale)))
        sh = sh.filter(ImageFilter.GaussianBlur(round(14 * scale)))
        canvas.paste(Image.new("RGBA", canvas.size, (0, 0, 0, 255)), (0, 0), sh)
    canvas.paste(win.convert("RGBA"), (m, m), mask)
    return canvas


def save_png(img: Image.Image, name: str) -> None:
    ASSETS.mkdir(exist_ok=True)
    path = ASSETS / name
    img.save(path, optimize=True)
    print(f"{path.relative_to(ROOT)}  {img.width}x{img.height}  {path.stat().st_size / 1024:.0f} KiB")


def grid(images: list[Image.Image], columns: int, gap: int) -> Image.Image:
    cell_w = max(i.width for i in images)
    cell_h = max(i.height for i in images)
    rows = -(-len(images) // columns)
    out = Image.new("RGBA", (columns * cell_w + (columns - 1) * gap, rows * cell_h + (rows - 1) * gap), (0, 0, 0, 0))
    for n, im in enumerate(images):
        out.alpha_composite(im, ((n % columns) * (cell_w + gap), (n // columns) * (cell_h + gap)))
    return out


def crop_alpha(img: Image.Image) -> Image.Image:
    box = img.getchannel("A").getbbox()
    return img.crop(box) if box else img


def render_gif(frames: list[dict], name: str, scale: float) -> None:
    # collapse identical consecutive screens into one frame with the summed delay
    merged: list[dict] = []
    for f in frames:
        if merged and merged[-1]["screen"] == f["screen"]:
            merged[-1]["ms"] += f["ms"]
        else:
            merged.append({"screen": f["screen"], "ms": f["ms"]})
    backdrop = (13, 17, 23)
    imgs = []
    for f in merged:
        win = render_window(f["screen"], scale, shadow=False)
        bg = Image.new("RGBA", win.size, backdrop + (255,))
        bg.alpha_composite(win)
        imgs.append(bg.convert("RGB"))
    # one shared palette built from a mosaic of all frames keeps colours stable and the file small
    mosaic = Image.new("RGB", (imgs[0].width, imgs[0].height * min(len(imgs), 12)))
    for i, im in enumerate(imgs[:12]):
        mosaic.paste(im, (0, i * im.height))
    pal = mosaic.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    quant = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in imgs]
    ASSETS.mkdir(exist_ok=True)
    path = ASSETS / name
    quant[0].save(path, save_all=True, append_images=quant[1:], duration=[f["ms"] for f in merged], loop=0, optimize=True, disposal=1)
    print(f"{path.relative_to(ROOT)}  {imgs[0].width}x{imgs[0].height}  {len(merged)} frames  {path.stat().st_size / 1024:.0f} KiB")


def main() -> None:
    if not SCENES.exists():
        sys.exit("build/scenes.json missing: run `bun tools/capture.ts` first (or `bun run assets`)")
    scenes = json.loads(SCENES.read_text())

    save_png(render_window(scenes["hero"], 2.0), "hero.png")

    cards = {c["key"]: c["screen"] for c in scenes["cards"]}
    save_png(render_window(cards["legendary"], 2.0), "card.png")

    order = ["common", "uncommon", "rare", "epic", "legendary", "shiny"]
    tiles = [render_window(cards[k], 1.3) for k in order]
    save_png(grid(tiles, 2, 0), "gallery.png")

    save_png(render_window(scenes["hats"], 1.8), "hats.png")
    save_png(render_window(scenes["poses"], 1.6), "poses.png")

    render_gif(scenes["demo"], "demo.gif", 1.4)


if __name__ == "__main__":
    main()
