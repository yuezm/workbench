"""Generate the Workbench app icon (pomodoro theme) as build/icon.png + build/icon.ico."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
BUILD.mkdir(exist_ok=True)

SIZE = 512
SS = 4  # supersample for smooth edges
W = SIZE * SS

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded-square dark slate background
radius = int(W * 0.22)
bg = (22, 22, 30, 255)
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=radius, fill=bg)

# Inner subtle ring
ring_pad = int(W * 0.10)
d.ellipse(
    [ring_pad, ring_pad, W - ring_pad, W - ring_pad],
    outline=(60, 62, 82, 255),
    width=int(W * 0.018),
)

# Tomato body
cx, cy = W / 2, W * 0.545
r = W * 0.255
tomato = (235, 76, 66, 255)
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tomato)

# Highlight
hr = r * 0.34
d.ellipse(
    [cx - r * 0.52 - hr, cy - r * 0.52 - hr, cx - r * 0.52 + hr, cy - r * 0.52 + hr],
    fill=(255, 150, 140, 150),
)

# Stem / leaves
leaf = (86, 190, 120, 255)
lw = int(W * 0.02)
# five short leaf strokes
import math

top = cy - r * 0.92
for ang in (-90, -140, -40, 180, 0):
    a = math.radians(ang)
    x2 = cx + math.cos(a) * r * 0.42
    y2 = top + math.sin(a) * r * 0.42
    d.line([cx, top, x2, y2], fill=leaf, width=lw)
d.line([cx, top - r * 0.10, cx, top + r * 0.28], fill=leaf, width=lw)

# Clock hands (pomodoro = timer)
center = (cx, cy)
d.line([center, (cx, cy - r * 0.55)], fill=(255, 255, 255, 240), width=int(W * 0.022))
d.line([center, (cx + r * 0.40, cy)], fill=(255, 255, 255, 240), width=int(W * 0.022))
dot = W * 0.022
d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=(255, 255, 255, 255))

img = img.resize((SIZE, SIZE), Image.LANCZOS)

png_path = BUILD / "icon.png"
img.save(png_path, "PNG")

ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
ico_path = BUILD / "icon.ico"
img.save(ico_path, "ICO", sizes=ico_sizes)

print("wrote", png_path, png_path.stat().st_size, "bytes")
print("wrote", ico_path, ico_path.stat().st_size, "bytes")
