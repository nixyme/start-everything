import hashlib
import json
from pathlib import Path
import platform
import shutil


root = Path(__file__).resolve().parent.parent
version = json.loads((root / "package.json").read_text())["version"]
architecture = platform.machine()
bundle_root = root / "src-tauri" / "target" / "release" / "bundle"
destination = root / "dist"
destination.mkdir(exist_ok=True)
app = bundle_root / "macos" / "START EVERYTHING.app"
app_destination = destination / app.name
if app_destination.exists():
    raise FileExistsError(f"Output already exists: {app_destination}")
shutil.copytree(app, app_destination, symlinks=True)
images = list((bundle_root / "dmg").glob("*.dmg"))
if len(images) != 1:
    raise RuntimeError(f"Expected exactly one macOS disk image, found {len(images)}")
image = destination / f"start-everything-tauri-{version}-{architecture}.dmg"
shutil.copy2(images[0], image)
manifest = {
    "version": version,
    "architecture": architecture,
    "app": str(app_destination.relative_to(root)),
    "dmg": str(image.relative_to(root)),
    "dmgBytes": image.stat().st_size,
    "sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest, indent=2))
