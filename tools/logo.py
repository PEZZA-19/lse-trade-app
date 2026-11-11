"""Clean up the business logo (assets-in/lse-logo.jpg, kept untouched) into crisp flat-colour art.

Splits the JPG into its two inks (blue bolt, navy letters) as soft masks, upscales them 4x and
re-sharpens the edges, then writes:
  assets/lse-logo.png              transparent, trimmed (documents and Settings)
  apps/web/public/icon-512.png     white background, logo filling ~80%
  apps/web/public/icon-192.png
  apps/web/public/icon-maskable-512.png / -192.png   logo inside the 80% safe zone (60%)
  apps/web/public/apple-touch-icon.png               180x180, white, no transparency
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
src = np.asarray(Image.open(ROOT / 'assets-in/lse-logo.jpg').convert('RGB')).astype(float)
r, g, b = src[..., 0], src[..., 1], src[..., 2]
bg = np.median(np.concatenate([src[:4].reshape(-1, 3), src[-4:].reshape(-1, 3)]), axis=0)
lum = 0.299 * r + 0.587 * g + 0.114 * b
bg_l = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]

blue_px = (b - r > 70) & (lum < bg_l - 40)
navy_px = (lum < 90) & ~blue_px
blue = np.median(src[blue_px], axis=0)
navy = np.median(src[navy_px], axis=0)

# Ink strength: how far a pixel is from the background towards each ink.
def strength(ink):
    d_bg = np.linalg.norm(src - bg, axis=2)
    d_ink = np.linalg.norm(src - ink, axis=2)
    return np.clip(d_bg / (d_bg + d_ink + 1e-6), 0, 1)

# The bolt sits above the letters: split by the first row of the letters, so JPEG colour noise
# inside the letters can't turn blue.
split = int(np.argmax(navy_px.sum(axis=1) > 10)) - 2
top = np.arange(lum.shape[0])[:, None] < split
a_blue = np.where(top, strength(blue), 0)
a_navy = np.where(~top, strength(navy), 0)

SCALE = 4
H, W = lum.shape

def up(a):
    im = Image.fromarray((a * 255).astype(np.uint8))
    # Closing (max then min) fills the JPEG highlight specks inside the letters.
    im = im.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    im = im.resize((W * SCALE, H * SCALE), Image.BICUBIC)
    im = im.filter(ImageFilter.GaussianBlur(SCALE * 0.6))
    x = np.asarray(im).astype(float) / 255
    # Sigmoid re-sharpen: crisp, smooth edges instead of JPEG mush.
    return 1 / (1 + np.exp(-(x - 0.5) * 18))

A_blue, A_navy = up(a_blue), up(a_navy)
alpha = np.clip(A_blue + A_navy, 0, 1)
w_blue = A_blue / (A_blue + A_navy + 1e-6)
rgb = w_blue[..., None] * blue + (1 - w_blue[..., None]) * navy
rgba = np.dstack([rgb, alpha * 255]).astype(np.uint8)
logo = Image.fromarray(rgba, 'RGBA')
logo = logo.crop(logo.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox())
(ROOT / 'assets').mkdir(exist_ok=True)
logo.save(ROOT / 'assets/lse-logo.png', optimize=True)
print('ink colours', blue.round(), navy.round(), 'logo', logo.size)

def icon(size, fill, bg=(255, 255, 255)):
    canvas = Image.new('RGBA', (size, size), bg + (255,))
    s = fill * size / max(logo.size)
    l = logo.resize((round(logo.width * s), round(logo.height * s)), Image.LANCZOS)
    canvas.alpha_composite(l, ((size - l.width) // 2, (size - l.height) // 2))
    return canvas.convert('RGB')

pub = ROOT / 'apps/web/public'
icon(512, 0.8).save(pub / 'icon-512.png', optimize=True)
icon(192, 0.8).save(pub / 'icon-192.png', optimize=True)
icon(512, 0.6).save(pub / 'icon-maskable-512.png', optimize=True)
icon(192, 0.6).save(pub / 'icon-maskable-192.png', optimize=True)
icon(180, 0.74).save(pub / 'apple-touch-icon.png', optimize=True)
