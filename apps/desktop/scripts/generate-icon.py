from pathlib import Path
from PIL import Image, ImageDraw


def render(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (245, 251, 255, 255))
    draw = ImageDraw.Draw(image)
    margin = size * 0.075
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=size * 0.19,
        fill=(21, 107, 190, 255),
        outline=(75, 185, 239, 255),
        width=max(1, int(size * 0.025)),
    )
    center = size / 2
    outer = size * 0.31
    inner = size * 0.095
    points = []
    for index in range(16):
        angle = -3.14159265 / 2 + index * 3.14159265 / 8
        radius = outer if index % 2 == 0 else inner
        points.append((center + radius * __import__("math").cos(angle), center + radius * __import__("math").sin(angle)))
    draw.polygon(points, fill=(255, 255, 255, 255))
    draw.ellipse(
        (center - size * 0.065, center - size * 0.065, center + size * 0.065, center + size * 0.065),
        fill=(75, 185, 239, 255),
    )
    for offset in (-0.31, 0.31):
        x = center + size * offset
        draw.line((x, size * 0.23, x, size * 0.36), fill=(131, 216, 250, 210), width=max(1, int(size * 0.012)))
        draw.ellipse((x-size*.025, size*.205, x+size*.025, size*.255), fill=(131, 216, 250, 255))
    return image


if __name__ == "__main__":
    output = Path(__file__).resolve().parent.parent / "build"
    output.mkdir(parents=True, exist_ok=True)
    master = render(1024)
    master.save(output / "icon.png")
    master.save(output / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
