#!/usr/bin/env python3
"""Generate square PWA and iPhone app icons from the original Gladstone Fire/EMS patch."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "gfd-patch.jpg"
OUTPUT = ROOT / "icons"

def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as loaded:
        patch = loaded.convert("RGB")
    if patch.size != (945, 777):
        raise ValueError(f"Unexpected official patch dimensions: {patch.size}")

    for filename, size, scale in [
        ("icon-192.png", 192, 0.89),
        ("icon-512.png", 512, 0.89),
        ("icon-maskable-512.png", 512, 0.69),
        ("apple-touch-icon.png", 180, 0.89),
        ("favicon-48.png", 48, 0.90),
    ]:
        square = Image.new("RGB", (size, size), "white")
        width = round(size * scale)
        height = round(width * patch.height / patch.width)
        artwork = patch.resize((width, height), Image.Resampling.LANCZOS)
        square.paste(artwork, ((size - width) // 2, (size - height) // 2))
        square.save(OUTPUT / filename, format="PNG", optimize=True)
        with Image.open(OUTPUT / filename) as verify:
            assert verify.format == "PNG" and verify.size == (size, size)
        print(f"Generated icons/{filename} ({size}x{size})")

if __name__ == "__main__":
    main()
