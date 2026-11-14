"""Generates the app icons (a folded notebook page with an ink stroke)."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(OUT, exist_ok=True)


def icon(size: int, pad_ratio: float = 0.0) -> Image.Image:
    s = 4  # supersample
    S = size * s
    img = Image.new('RGBA', (S, S), (44, 62, 92, 255))
    d = ImageDraw.Draw(img)
    pad = int(S * (0.2 + pad_ratio))
    x0, y0, x1, y1 = pad, int(pad * 0.85), S - pad, S - int(pad * 0.85)
    fold = int((x1 - x0) * 0.28)
    # page with folded corner
    d.polygon([(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)], fill=(250, 247, 240, 255))
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(214, 205, 188, 255))
    # ruled lines
    lh = (y1 - y0) / 7
    for i in range(2, 7):
        y = int(y0 + i * lh)
        d.line([(x0 + S * 0.04, y), (x1 - S * 0.04, y)], fill=(190, 205, 225, 255), width=max(1, S // 120))
    # ink squiggle
    import math
    pts = []
    for i in range(60):
        t = i / 59
        x = x0 + (x1 - x0) * (0.12 + 0.76 * t)
        y = y0 + (y1 - y0) * (0.55 + 0.12 * math.sin(t * math.pi * 3.2))
        pts.append((x, y))
    d.line(pts, fill=(34, 76, 160, 255), width=S // 28, joint='curve')
    r = S // 56
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(34, 76, 160, 255))
    return img.resize((size, size), Image.LANCZOS)


for name, size in [('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)]:
    icon(size).convert('RGB').save(os.path.join(OUT, name))
print('icons written to', OUT)
