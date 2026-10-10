#!/usr/bin/env python3
"""Generate one image with the Venice API and write it to disk.

Usage: venice-image.py <out.png> "<prompt>" [model] [width] [height]
"""
import base64
import json
import os
import sys
import urllib.request

out, prompt = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else "venice-sd35"
width = int(sys.argv[4]) if len(sys.argv) > 4 else 1024
height = int(sys.argv[5]) if len(sys.argv) > 5 else 1024

key = os.environ.get("VENICE_API_KEY")
if not key:
    sys.exit("VENICE_API_KEY is not set")

body = json.dumps(
    {
        "model": model,
        "prompt": prompt,
        "width": width,
        "height": height,
        "format": "png",
        "safe_mode": False,
        "hide_watermark": True,
    }
).encode()

req = urllib.request.Request(
    "https://api.venice.ai/api/v1/image/generate",
    data=body,
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    method="POST",
)

with urllib.request.urlopen(req, timeout=180) as resp:
    payload = json.load(resp)

images = payload.get("images") or []
if not images:
    sys.exit(f"no image returned: {json.dumps(payload)[:400]}")

data = images[0]
raw = base64.b64decode(data) if not data.startswith("http") else None
if raw is None:
    with urllib.request.urlopen(data, timeout=180) as r:
        raw = r.read()

with open(out, "wb") as fh:
    fh.write(raw)
print(f"wrote {out} ({len(raw)} bytes) via {model}")
