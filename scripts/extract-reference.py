#!/usr/bin/env python3
"""Unpack the six visual templates and bundled fonts from the supplied HTML."""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import re
import sys
from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".codex-attachments/a1853606-c2cb-44ba-b7a1-8e662ae11d8d/6b1d4bb0-d41c-4651-91a5-5119995bc123/Tempo Planner _1_.html"
TARGET = ROOT / "src/templates"
FONTS = ROOT / "src/assets/fonts"
SCREENS = (
    ("today", "Today"),
    ("focus", "Focus"),
    ("brain-dump", "Brain dump"),
    ("settings", "Settings"),
    ("desktop-today", "Desktop: Today"),
    ("desktop-week", "Desktop: Week"),
)


def payload(script: str, kind: str):
    match = re.search(rf'<script type="{re.escape(kind)}">(.*?)</script>', script, re.S)
    return json.loads(match.group(1)) if match else None


def main() -> None:
    if not SOURCE.exists():
        sys.exit(f"Approved source not found: {SOURCE}")
    TARGET.mkdir(parents=True, exist_ok=True)
    FONTS.mkdir(parents=True, exist_ok=True)
    outer = SOURCE.read_text(encoding="utf-8")
    manifest = payload(outer, "__bundler/manifest")
    font_names: dict[str, str] = {}

    for key, entry in manifest.items():
        if not entry.get("mime", "").startswith("text/html"):
            continue
        document = base64.b64decode(entry["data"])
        if entry.get("compressed"):
            document = gzip.decompress(document)
        text = document.decode("utf-8")
        nested = payload(text, "__bundler/manifest")
        template = payload(text, "__bundler/template")
        for asset_id, asset in nested.items():
            if not asset.get("mime", "").startswith("font/"):
                continue
            data = base64.b64decode(asset["data"])
            digest = hashlib.sha256(data).hexdigest()[:16]
            name = f"atkinson-{digest}.woff2"
            (FONTS / name).write_bytes(data)
            font_names[asset_id] = name

        body_match = re.search(r"<body[^>]*>(.*?)</body>", template, re.S | re.I)
        dc_match = re.search(r"<x-dc[^>]*>(.*?)</x-dc>", body_match.group(1), re.S | re.I)
        if not body_match or not dc_match:
            raise ValueError(f"Could not find the screen markup in nested template {key}")
        inner = dc_match.group(1)
        style_blocks = re.findall(r"<style[^>]*>(.*?)</style>", inner, re.S | re.I)
        styles = "\n".join(style_blocks)
        inner = re.sub(r"<helmet[^>]*>.*?</helmet>", "", inner, flags=re.S | re.I)
        inner = re.sub(r"<script[^>]*>.*?</script>", "", inner, flags=re.S | re.I)
        inner = inner.replace("{{accent}}", "#2B5FC4")
        for asset_id, name in font_names.items():
            inner = inner.replace(f'url("{asset_id}")', f'url("../assets/fonts/{name}")')
            styles = styles.replace(f'url("{asset_id}")', f'url("../assets/fonts/{name}")')
        index = list(manifest).index(key)
        slug, title = SCREENS[index]
        shell = (
            "<!doctype html>\n"
            '<html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"<title>{escape(title)} · Tempo</title>"
            f"<style>{styles}\nhtml,body{{margin:0;min-height:100%;}}"
            "button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible"
            "{outline:3px solid #C17A3A;outline-offset:2px;}"
            "</style></head><body>"
            f"{inner}</body></html>"
        )
        (TARGET / f"{slug}.html").write_text(shell, encoding="utf-8")
        print(f"wrote src/templates/{slug}.html")

    print(f"extracted {len(font_names)} font subsets into src/assets/fonts")


if __name__ == "__main__":
    main()
