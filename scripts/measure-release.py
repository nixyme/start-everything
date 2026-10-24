import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


root = Path(__file__).resolve().parent.parent
workspace = root / ".work" / "release-measurement"
workspace.mkdir(parents=True, exist_ok=True)
bundle = root / "src-tauri" / "target" / "release" / "bundle" / "macos" / "START EVERYTHING.app"
binary = bundle / "Contents" / "MacOS" / "start-everything-new"
source = Path.home() / "Library" / "Application Support" / "start-everything" / "data"
data = workspace / "data"
data.mkdir(exist_ok=True)
hashes = {}
for name in ["projects.json", "schedules.json", "settings.json", "schedule-logs.json"]:
    hashes[name] = hashlib.sha256((source / name).read_bytes()).hexdigest()
    shutil.copy2(source / name, data / name)
settings = json.loads((data / "settings.json").read_text())
settings["globalShortcut"] = ""
(data / "settings.json").write_text(json.dumps(settings, ensure_ascii=False))
environment = os.environ.copy()
environment.update({"START_EVERYTHING_DATA_DIR": str(data), "START_EVERYTHING_DISABLE_SCHEDULER": "1", "RUST_LOG": "info"})
measurements = []
for index in range(3):
    log_file = workspace / "logs" / "app.jsonl"
    previous_size = log_file.stat().st_size if log_file.exists() else 0
    begin = time.monotonic()
    baseline = {int(line.strip()) for line in subprocess.run(["ps", "-axo", "pid="], check=True, capture_output=True, text=True).stdout.splitlines() if line.strip()}
    with (workspace / f"process-{index}.log").open("w") as output:
        process = subprocess.Popen([str(binary)], env=environment, cwd=root, stdout=output, stderr=subprocess.STDOUT)
        try:
            ready = None
            while ready is None:
                if process.poll() is not None:
                    raise RuntimeError(f"Release process exited {process.returncode}")
                if time.monotonic() - begin > 30:
                    raise TimeoutError("Release startup exceeded 30 seconds")
                if log_file.exists():
                    with log_file.open() as logs:
                        logs.seek(previous_size)
                        for line in logs:
                            if not line.endswith("\n"):
                                continue
                            record = json.loads(line)
                            fields = record["fields"]
                            if fields.get("decision_reason") == "frontend_ready":
                                ready = fields
                time.sleep(0.05)
            launch_to_ready_ms = (time.monotonic() - begin) * 1000
            time.sleep(2)
            native = subprocess.run(["ps", "-o", "pid=,ppid=,rss=,%cpu=", "-p", str(process.pid)], check=True, capture_output=True, text=True).stdout.strip().split()
            processes = subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,%cpu=,command="], check=True, capture_output=True, text=True).stdout
            related = []
            for line in processes.splitlines():
                fields = line.strip().split(None, 4)
                if len(fields) == 5 and (int(fields[1]) == process.pid or (int(fields[0]) not in baseline and "/com.apple.WebKit." in fields[4])):
                    related.append({"pid": int(fields[0]), "ppid": int(fields[1]), "rssKiB": int(fields[2]), "cpuPercent": float(fields[3]), "command": fields[4]})
            measurements.append({"startupMs": ready["startup_ms"], "launchToReadyMs": launch_to_ready_ms, "projects": ready["project_count"], "nativeRssKiB": int(native[2]), "nativeCpuPercent": float(native[3]), "relatedProcesses": related})
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    time.sleep(1)
bundle_bytes = sum(path.stat().st_size for path in bundle.rglob("*") if path.is_file() and not path.is_symlink())
legacy_bundle = root.parent / "start-everything" / "dist" / "mac-arm64" / "START EVERYTHING.app"
legacy_bytes = sum(path.stat().st_size for path in legacy_bundle.rglob("*") if path.is_file() and not path.is_symlink())
report = {
    "bundleBytes": bundle_bytes,
    "legacyBundleBytes": legacy_bytes,
    "sizeReductionPercent": (1 - bundle_bytes / legacy_bytes) * 100,
    "measurements": measurements,
    "legacyDataUnchanged": all(hashlib.sha256((source / name).read_bytes()).hexdigest() == digest for name, digest in hashes.items()),
}
(workspace / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))
if not report["legacyDataUnchanged"]:
    raise RuntimeError("Legacy data changed")
