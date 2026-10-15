"""Prepare pinned runtime resources locally; no CDN dependencies during playback."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root.parent / 'data_pipeline/offline/rtcamera_offline/assets.json').read_text())
cache = root / '.cache/assets'
existing = Path(os.environ.get('RTCAMERA_OFFLINE_ASSETS', str(Path.home() / '.local/share/rtcamera-offline/assets')))

def install(entry):
    target = cache / entry['path']
    for candidate in (target, existing / entry['path']):
        if candidate.is_file() and hashlib.sha256(candidate.read_bytes()).hexdigest() == entry['sha256']:
            data = candidate.read_bytes()
            break
    else:
        with urllib.request.urlopen(entry['url'], timeout=45) as source:
            data = source.read(25 * 1024 * 1024 + 1)
    if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ValueError('Resource size/hash mismatch: ' + entry['path'])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return 'Verified: ' + entry['path']

with ThreadPoolExecutor(max_workers=3) as pool:
    for message in pool.map(install, manifest['files']):
        print(message, flush=True)
