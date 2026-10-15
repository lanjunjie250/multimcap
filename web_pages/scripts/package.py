"""Create a dashboard Direct Upload ZIP with index.html at its root."""
from pathlib import Path
import zipfile
root = Path(__file__).resolve().parents[1]
target = root / 'release/rtcamera-pages-trial.zip'
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted((root / 'dist').rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(root / 'dist'))
print(f'可直接上传：{target} ({target.stat().st_size / 1024 / 1024:.1f} MiB)')
