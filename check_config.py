import json
import os
from pathlib import Path
import shutil


root = Path(__file__).resolve().parent
config = json.loads((root / "config.json").read_text())
for key, value in config.items():
    if not isinstance(value, str) or not value.startswith("${") or not value.endswith("}"):
        raise ValueError(f"Invalid environment reference: {key}")
data_directory = os.environ.get("START_EVERYTHING_DATA_DIR", "")
if data_directory and not Path(data_directory).is_absolute():
    raise ValueError("START_EVERYTHING_DATA_DIR must be an absolute path")
if os.environ.get("START_EVERYTHING_DISABLE_SCHEDULER", "0") not in ("0", "1"):
    raise ValueError("START_EVERYTHING_DISABLE_SCHEDULER must be 0 or 1")
for command in ("node", "cargo", "rustc"):
    if shutil.which(command) is None:
        raise RuntimeError(f"Required development tool is missing: {command}")
if not (root / "node_modules" / "@tauri-apps" / "cli" / "tauri.js").is_file():
    raise RuntimeError("Install project dependencies with pnpm 10.12.3 install")
print("Configuration validated")
