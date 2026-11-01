"""Draw LagBuster's icon (a lightning bolt) and save icon.png + icon.ico.

Run once with Pillow installed: ``python tools/make_icon.py``.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "lagbuster" / "assets"


def gradient(size, top, bottom):
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        t = y / (size - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        draw.line([(0, y), (size, y)], fill=color)
    return image


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Rounded dark tile.
    tile_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle([40, 40, SIZE - 40, SIZE - 40], radius=220, fill=255)
    icon.paste(gradient(SIZE, (38, 28, 82), (12, 15, 24)), (0, 0), tile_mask)

    # Lightning bolt with a purple-to-green gradient and a soft glow.
    bolt = [(575, 120), (250, 575), (470, 575), (395, 905), (780, 420), (545, 420), (640, 120)]
    bolt_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(bolt_mask).polygon(bolt, fill=255)
    glow = bolt_mask.filter(ImageFilter.GaussianBlur(38))
    glow_layer = Image.new("RGBA", (SIZE, SIZE), (124, 92, 255, 0))
    glow_layer.putalpha(glow.point(lambda v: int(v * 0.75)))
    icon = Image.alpha_composite(icon, glow_layer)
    icon.paste(gradient(SIZE, (160, 130, 255), (47, 224, 160)), (0, 0), bolt_mask)

    # Keep everything inside the rounded tile.
    alpha = Image.new("L", (SIZE, SIZE), 0)
    alpha.paste(icon.getchannel("A"), (0, 0), tile_mask)
    icon.putalpha(alpha)

    icon.resize((256, 256), Image.LANCZOS).save(OUT / "icon.png")
    icon.resize((256, 256), Image.LANCZOS).save(
        OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    print("wrote", OUT / "icon.png", "and", OUT / "icon.ico")


if __name__ == "__main__":
    main()
