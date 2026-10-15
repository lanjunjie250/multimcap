"""Read-only capability reporting; never assumes a working GPU from its name."""
import importlib.util
import subprocess
import shutil
from .paths import asset_dir, find_tool


def diagnose():
    result = {'opencv': importlib.util.find_spec('cv2') is not None,
              'merger': str(find_tool('mcap_merge')), 'assets': str(asset_dir())}
    for name, args in [('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv']),
                       ('mokutil', ['--sb-state'])]:
        if not shutil.which(name):
            result[name] = {'available': False}
            continue
        try:
            process = subprocess.run([name, *args], capture_output=True, text=True, timeout=10)
            result[name] = {'available': process.returncode == 0,
                            'detail': (process.stdout + process.stderr).strip()[:4096]}
        except (OSError, subprocess.TimeoutExpired) as exc:
            result[name] = {'available': False, 'detail': str(exc)}
    return result
