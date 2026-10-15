"""Locations work both from a source checkout and an installed package."""
import os
from pathlib import Path
import shutil


def find_tool(name):
    adjacent = Path(__file__).resolve().parents[2] / 'build-host' / name
    return adjacent if adjacent.is_file() else Path(shutil.which(name) or name)


def asset_dir():
    default = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
    return Path(os.environ.get('RTCAMERA_OFFLINE_ASSETS', default / 'rtcamera-offline/assets'))
