from pathlib import Path
import math
import subprocess

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def gradient(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = image.load()
    stops = ((25, 76, 206), (42, 202, 169), (126, 87, 255))
    for y in range(size):
        for x in range(size):
            nx = x / (size - 1)
            ny = y / (size - 1)
            a = max(0.0, min(1.0, (nx * 0.7 + ny * 0.45)))
            b = max(0.0, min(1.0, ((1 - nx) * 0.25 + ny * 0.75)))
            r = int(stops[0][0] * (1 - a) + stops[1][0] * a)
            g = int(stops[0][1] * (1 - a) + stops[1][1] * a)
            bl = int(stops[0][2] * (1 - a) + stops[1][2] * a)
            r = int(r * (1 - b * 0.45) + stops[2][0] * b * 0.45)
            g = int(g * (1 - b * 0.45) + stops[2][1] * b * 0.45)
            bl = int(bl * (1 - b * 0.45) + stops[2][2] * b * 0.45)
            pixels[x, y] = (r, g, bl, 255)
    return image


def draw_wave(draw: ImageDraw.ImageDraw, size: int) -> None:
    cx = size / 2
    cy = size * 0.53
    color = (255, 255, 255, 86)
    for i, radius in enumerate((236, 314, 392)):
        width = 15 if i == 0 else 12
        box = (cx - radius, cy - radius, cx + radius, cy + radius)
        draw.arc(box, start=-38, end=38, fill=color, width=width)
        draw.arc(box, start=142, end=218, fill=color, width=width)


def draw_microphone(draw: ImageDraw.ImageDraw, size: int) -> None:
    white = (255, 255, 255, 245)
    soft = (255, 255, 255, 210)
    cx = size / 2
    top = size * 0.245
    body_w = size * 0.245
    body_h = size * 0.375
    radius = int(body_w / 2)
    body = (cx - body_w / 2, top, cx + body_w / 2, top + body_h)
    draw.rounded_rectangle(body, radius=radius, fill=white)
    for offset in (-54, 0, 54):
        y = top + body_h * 0.35 + offset
        draw.rounded_rectangle((cx - body_w * 0.28, y, cx + body_w * 0.28, y + 13), radius=7, fill=(42, 202, 169, 110))

    cup = (
        cx - size * 0.23,
        top + body_h * 0.28,
        cx + size * 0.23,
        top + body_h + size * 0.09,
    )
    draw.arc(cup, start=20, end=160, fill=soft, width=int(size * 0.042))
    draw.line((cx, top + body_h + size * 0.095, cx, size * 0.78), fill=white, width=int(size * 0.042))
    draw.rounded_rectangle((cx - size * 0.15, size * 0.77, cx + size * 0.15, size * 0.82), radius=int(size * 0.025), fill=white)


def draw_sparkles(draw: ImageDraw.ImageDraw, size: int) -> None:
    for cx, cy, r in ((700, 245, 34), (763, 325, 16), (283, 315, 13)):
        scale = size / 1024
        x, y, rr = cx * scale, cy * scale, r * scale
        points = [(x, y - rr), (x + rr * 0.28, y - rr * 0.28), (x + rr, y), (x + rr * 0.28, y + rr * 0.28), (x, y + rr), (x - rr * 0.28, y + rr * 0.28), (x - rr, y), (x - rr * 0.28, y - rr * 0.28)]
        draw.polygon(points, fill=(255, 255, 255, 220))


def create_app_icon(size: int = 1024) -> Image.Image:
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    pad = int(size * 0.045)
    radius = int(size * 0.23)
    shadow_draw.rounded_rectangle((pad, pad + int(size * 0.025), size - pad, size - pad + int(size * 0.025)), radius=radius, fill=(13, 25, 45, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(size * 0.035)))

    base = gradient(size)
    mask = rounded_mask(size, radius)
    base.putalpha(mask)

    shine = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shine_draw = ImageDraw.Draw(shine)
    shine_draw.ellipse((-size * 0.2, -size * 0.3, size * 0.85, size * 0.55), fill=(255, 255, 255, 44))
    shine.putalpha(Image.composite(shine.getchannel("A"), Image.new("L", (size, size), 0), mask))

    symbol = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    symbol_draw = ImageDraw.Draw(symbol)
    draw_wave(symbol_draw, size)
    draw_microphone(symbol_draw, size)
    draw_sparkles(symbol_draw, size)
    symbol = symbol.filter(ImageFilter.UnsharpMask(radius=1.2, percent=125))

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(base)
    canvas.alpha_composite(shine)
    canvas.alpha_composite(symbol)
    return canvas


def create_tray(size: int) -> Image.Image:
    scale = size / 32
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    black = (0, 0, 0, 255)
    cx = size / 2
    draw.rounded_rectangle((cx - 4.2 * scale, 5 * scale, cx + 4.2 * scale, 17 * scale), radius=int(4 * scale), fill=black)
    draw.arc((7 * scale, 10 * scale, 25 * scale, 24 * scale), start=25, end=155, fill=black, width=max(2, int(2.2 * scale)))
    draw.line((cx, 22 * scale, cx, 26 * scale), fill=black, width=max(2, int(2.2 * scale)))
    draw.rounded_rectangle((10 * scale, 25 * scale, 22 * scale, 28 * scale), radius=int(1.5 * scale), fill=black)
    for x, h in ((5, 5), (27, 5), (2.5, 2.5), (29.5, 2.5)):
        draw.rounded_rectangle(((x - 0.8) * scale, (16 - h / 2) * scale, (x + 0.8) * scale, (16 + h / 2) * scale), radius=int(scale), fill=black)
    return image


def main() -> None:
    BUILD.mkdir(exist_ok=True)
    ICONSET.mkdir(exist_ok=True)
    icon = create_app_icon()
    icon.save(BUILD / "icon.png")

    sizes = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for px, name in sizes:
        icon.resize((px, px), Image.Resampling.LANCZOS).save(ICONSET / name)

    subprocess.run(["iconutil", "-c", "icns", str(ICONSET), "-o", str(BUILD / "icon.icns")], check=True)

    create_tray(32).save(BUILD / "trayTemplate.png")
    create_tray(64).save(BUILD / "trayTemplate@2x.png")


if __name__ == "__main__":
    main()
