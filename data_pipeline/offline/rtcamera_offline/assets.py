"""Download pinned local assets once; playback itself never contacts a CDN."""
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request
from .paths import asset_dir


def fetch_assets():
    manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
    root = asset_dir()
    for entry in manifest['files']:
        target = root / entry['path']
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == entry['sha256']:
            print('Verified:', entry['path'])
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            digest = hashlib.sha256()
            with urllib.request.urlopen(entry['url'], timeout=60) as source, tempfile.NamedTemporaryFile(
                    dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != entry['sha256']:
                raise ValueError('SHA-256 mismatch: ' + entry['path'])
            temporary.replace(target)
            print('Installed:', entry['path'])
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    fetch_assets()
