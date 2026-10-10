#!/usr/bin/env python3
"""Generate one image with the Venice API and write it to disk.

Usage:
  venice-image.py <out.png> "<prompt>" [model] [WxH | aspect-ratio]

Examples:
  venice-image.py hero.png "a cloche" venice-sd35 1152x896
  venice-image.py hero.png "a cloche" nano-banana-pro 3:2

Older models take explicit width/height; newer ones take an aspect ratio.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

if len(sys.argv) < 3:
    sys.exit(__doc__)

out, prompt = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else "venice-sd35"
size = sys.argv[4] if len(sys.argv) > 4 else "1024x1024"

key = os.environ.get("VENICE_API_KEY")
if not key:
    sys.exit("VENICE_API_KEY is not set")

body: dict[str, object] = {
    "model": model,
    "prompt": prompt,
    "format": "png",
    "safe_mode": False,
    "hide_watermark": True,
}
if ":" in size:
    body["aspect_ratio"] = size
else:
    w, _, h = size.partition("x")
    body["width"], body["height"] = int(w), int(h)

req = urllib.request.Request(
    "https://api.venice.ai/api/v1/image/generate",
    data=json.dumps(body).encode(),
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=240) as resp:
        payload = json.load(resp)
except urllib.error.HTTPError as err:
    detail = err.read().decode(errors="replace")
    sys.exit(f"HTTP {err.code} from Venice for model {model}: {detail[:500]}")

images = payload.get("images") or []
if not images:
    sys.exit(f"no image returned: {json.dumps(payload)[:400]}")

data = images[0]
raw = base64.b64decode(data) if not data.startswith("http") else None
if raw is None:
    with urllib.request.urlopen(data, timeout=240) as r:
        raw = r.read()

with open(out, "wb") as fh:
    fh.write(raw)
print(f"wrote {out} ({len(raw)} bytes) via {model} at {size}")
