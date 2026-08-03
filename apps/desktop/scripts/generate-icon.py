from pathlib import Path

from PIL import Image, ImageOps


PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SOURCE = PACKAGE_ROOT / "assets" / "icon-source.png"
OUTPUT = PACKAGE_ROOT / "build"
ICON_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def load_master() -> Image.Image:
    with Image.open(SOURCE) as source:
        image = ImageOps.exif_transpose(source).convert("RGBA")
    if image.width != image.height:
        image = ImageOps.fit(image, (min(image.size),) * 2, method=Image.Resampling.LANCZOS)
    if image.size != (1024, 1024):
        image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    return image


if __name__ == "__main__":
    if not SOURCE.is_file():
        raise SystemExit(f"Missing icon source: {SOURCE}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    master = load_master()
    master.save(OUTPUT / "icon.png", format="PNG", optimize=True)
    master.save(OUTPUT / "icon.ico", format="ICO", sizes=ICON_SIZES, bitmap_format="png")
