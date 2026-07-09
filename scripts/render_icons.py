#!/usr/bin/env python3
"""Render assets/icon-512.png and assets/icon-256.png.

Python 3 stdlib only (zlib, struct, math) - no Pillow, no cairosvg. This
does NOT parse assets/icon.svg; it re-draws the same shapes analytically
from the same design-space coordinates (a 512x512 unit canvas), so the
two files are two independent renderers of one design that must be kept
in sync by hand if the design ever changes:

  - a rounded-square background (rx=112) filled with a vertical navy
    gradient (#1b3552 top -> #081422 bottom)
  - a light external-drive body (rounded rect) with two vent grooves,
    a green status LED, and a connector tab poking out the bottom edge
  - an amber (#e5a00d, Plex's own brand color) play triangle badged on
    the drive face

Anti-aliasing is done by 4x supersampling: each output pixel is sampled
on a 4x4 subpixel grid, shape membership is tested exactly (analytic
rounded-rect / triangle / circle containment, no fuzz), and the samples
are averaged in premultiplied-alpha space before being written out - so
edges (the rounded corners, the drive outline, the LED, the triangle)
come out smooth instead of jagged, and the transparent corners outside
the rounded square don't bleed a dark fringe into the gradient.

Usage: python scripts/render_icons.py
Writes assets/icon-512.png and assets/icon-256.png (RGBA, non-indexed).
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "assets"

# ---------------------------------------------------------------------------
# Design-space geometry (a 512x512 unit canvas - matches assets/icon.svg)
# ---------------------------------------------------------------------------

CANVAS = 512.0
SUPERSAMPLE = 4

# Rounded-square background: (x0, y0, x1, y1, corner radius)
BG_RECT = (0.0, 0.0, 512.0, 512.0, 112.0)

# External drive body
DRIVE_RECT = (86.0, 160.0, 426.0, 352.0, 36.0)
DRIVE_COLOR = (0xE7, 0xED, 0xF5)

# Vent grooves near the top of the drive: (x0, y0, x1, y1, r)
GROOVE_RECTS = (
    (136.0, 178.0, 256.0, 188.0, 5.0),
    (136.0, 196.0, 256.0, 206.0, 5.0),
)
GROOVE_COLOR = (0xB9, 0xC4, 0xD4)

# Status LED: (cx, cy, radius)
LED = (166.0, 326.0, 11.0)
LED_COLOR = (0x22, 0xC5, 0x5E)

# Connector tab poking out the bottom edge of the case: (x0, y0, x1, y1, r)
PORT_RECT = (236.0, 344.0, 276.0, 374.0, 6.0)
PORT_COLOR = (0x0C, 0x1A, 0x2C)

# Amber play triangle, badged on the drive face (Plex brand amber)
TRIANGLE = ((196.0, 196.0), (196.0, 316.0), (336.0, 256.0))
TRIANGLE_COLOR = (0xE5, 0xA0, 0x0D)

GRADIENT_TOP = (0x1B, 0x35, 0x52)
GRADIENT_BOTTOM = (0x08, 0x14, 0x22)


# ---------------------------------------------------------------------------
# Analytic shape containment tests
# ---------------------------------------------------------------------------


def in_rounded_rect(px: float, py: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    """True if (px, py) lies inside the rounded rect [x0,x1]x[y0,y1] with corner radius r."""
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    # Clamp the point onto the "inner" rect whose corners are the rounded
    # corners' centers; the point is inside iff it's within r of that clamp.
    nx = x0 + r if px < x0 + r else (x1 - r if px > x1 - r else px)
    ny = y0 + r if py < y0 + r else (y1 - r if py > y1 - r else py)
    dx = px - nx
    dy = py - ny
    return dx * dx + dy * dy <= r * r


def _sign(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    return (px - bx) * (ay - by) - (ax - bx) * (py - by)


def in_triangle(px: float, py: float, tri) -> bool:
    (ax, ay), (bx, by), (cx, cy) = tri
    d1 = _sign(px, py, ax, ay, bx, by)
    d2 = _sign(px, py, bx, by, cx, cy)
    d3 = _sign(px, py, cx, cy, ax, ay)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def in_circle(px: float, py: float, cx: float, cy: float, r: float) -> bool:
    dx = px - cx
    dy = py - cy
    return dx * dx + dy * dy <= r * r


def gradient_at(dy: float) -> tuple[float, float, float]:
    t = 0.0 if dy <= 0.0 else (1.0 if dy >= CANVAS else dy / CANVAS)
    r = GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * t
    g = GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * t
    b = GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * t
    return r, g, b


def sample(dx: float, dy: float) -> tuple[float, float, float, float]:
    """Straight-alpha (r, g, b, a) of the design at one design-space point."""
    bx0, by0, bx1, by1, br = BG_RECT
    if in_rounded_rect(dx, dy, bx0, by0, bx1, by1, br):
        r, g, b = gradient_at(dy)
        a = 1.0
    else:
        r = g = b = 0.0
        a = 0.0

    dr0, dr_y0, dr1, dr_y1, dr_r = DRIVE_RECT
    if in_rounded_rect(dx, dy, dr0, dr_y0, dr1, dr_y1, dr_r):
        r, g, b, a = float(DRIVE_COLOR[0]), float(DRIVE_COLOR[1]), float(DRIVE_COLOR[2]), 1.0

    for gx0, gy0, gx1, gy1, gr in GROOVE_RECTS:
        if in_rounded_rect(dx, dy, gx0, gy0, gx1, gy1, gr):
            r, g, b, a = float(GROOVE_COLOR[0]), float(GROOVE_COLOR[1]), float(GROOVE_COLOR[2]), 1.0

    led_cx, led_cy, led_r = LED
    if in_circle(dx, dy, led_cx, led_cy, led_r):
        r, g, b, a = float(LED_COLOR[0]), float(LED_COLOR[1]), float(LED_COLOR[2]), 1.0

    px0, py0, px1, py1, pr = PORT_RECT
    if in_rounded_rect(dx, dy, px0, py0, px1, py1, pr):
        r, g, b, a = float(PORT_COLOR[0]), float(PORT_COLOR[1]), float(PORT_COLOR[2]), 1.0

    if in_triangle(dx, dy, TRIANGLE):
        r, g, b, a = float(TRIANGLE_COLOR[0]), float(TRIANGLE_COLOR[1]), float(TRIANGLE_COLOR[2]), 1.0

    return r, g, b, a


# ---------------------------------------------------------------------------
# Rasterizer
# ---------------------------------------------------------------------------


def render(size: int, ss: int = SUPERSAMPLE) -> bytearray:
    """Render an RGBA raster of `size`x`size` pixels, supersampled `ss`x per axis."""
    scale = CANVAS / size
    n = ss * ss
    offsets = [(k + 0.5) / ss for k in range(ss)]
    pixels = bytearray(size * size * 4)

    for oy in range(size):
        dys = [(oy + off) * scale for off in offsets]
        row_off = oy * size * 4
        for ox in range(size):
            dxs = [(ox + off) * scale for off in offsets]
            sr = sg = sb = sa = 0.0
            for dy in dys:
                for dx in dxs:
                    r, g, b, a = sample(dx, dy)
                    if a:
                        sr += r * a
                        sg += g * a
                        sb += b * a
                        sa += a
            a_avg = sa / n
            if a_avg > 0.0:
                r_out = sr / n / a_avg
                g_out = sg / n / a_avg
                b_out = sb / n / a_avg
            else:
                r_out = g_out = b_out = 0.0
            idx = row_off + ox * 4
            pixels[idx] = _clamp_byte(r_out)
            pixels[idx + 1] = _clamp_byte(g_out)
            pixels[idx + 2] = _clamp_byte(b_out)
            pixels[idx + 3] = _clamp_byte(a_avg * 255.0)

    return pixels


def _clamp_byte(v: float) -> int:
    iv = int(round(v))
    if iv < 0:
        return 0
    if iv > 255:
        return 255
    return iv


# ---------------------------------------------------------------------------
# Minimal PNG encoder (RGBA, 8-bit, non-interlaced, color type 6)
# ---------------------------------------------------------------------------


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, size: int, pixels: bytearray) -> None:
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0 (None) per scanline
        raw.extend(pixels[y * stride : (y + 1) * stride])

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA, no interlace
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(_png_chunk(b"IHDR", ihdr))
        f.write(_png_chunk(b"IDAT", idat))
        f.write(_png_chunk(b"IEND", b""))


def main() -> None:
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    for size in (512, 256):
        pixels = render(size)
        out_path = ASSETS_DIR / f"icon-{size}.png"
        write_png(out_path, size, pixels)
        print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
