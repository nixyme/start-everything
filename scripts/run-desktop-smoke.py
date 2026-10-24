import hashlib
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


parser = argparse.ArgumentParser()
parser.add_argument("--scheduler", action="store_true")
parser.add_argument("--native", action="store_true")
arguments = parser.parse_args()
root = Path(__file__).resolve().parent.parent
workspace = root / ".work" / ("native-smoke" if arguments.native else "scheduler-smoke" if arguments.scheduler else "desktop-smoke")
workspace.mkdir(parents=True, exist_ok=True)
source = Path.home() / "Library" / "Application Support" / "start-everything" / "data"
target = workspace / "data"
target.mkdir(exist_ok=True)
names = ["projects.json", "schedules.json", "settings.json", "schedule-logs.json"]
original_hashes = {}
for name in names:
    original_hashes[name] = hashlib.sha256((source / name).read_bytes()).hexdigest()
    shutil.copy2(source / name, target / name)
terminal_marker = root / ".work" / "terminal-smoke-output.txt"
if terminal_marker.exists():
    terminal_marker.unlink()
settings = json.loads((target / "settings.json").read_text())
settings["globalShortcut"] = ""
settings["locale"] = "en"
settings["terminal"] = "default"
(target / "settings.json").write_text(json.dumps(settings, ensure_ascii=False))
if arguments.scheduler:
    schedules = json.loads((target / "schedules.json").read_text())
    for schedule in schedules:
        schedule["enabled"] = False
    (target / "schedules.json").write_text(json.dumps(schedules, ensure_ascii=False))
report_path = workspace / "report.json"
if report_path.exists():
    report_path.unlink()
environment = os.environ.copy()
environment.update({
    "START_EVERYTHING_DATA_DIR": str(target),
    "START_EVERYTHING_DISABLE_SCHEDULER": "0" if arguments.scheduler else "1",
    "START_EVERYTHING_TEST_SCRIPT": str(root / "scripts" / ("native-smoke.js" if arguments.native else "scheduler-smoke.js" if arguments.scheduler else "desktop-smoke.js")),
    "START_EVERYTHING_TEST_REPORT": str(report_path),
    "RUST_BACKTRACE": "1",
    "RUST_LOG": "info",
})
binary = root / "src-tauri" / "target" / "debug" / "start-everything-new"
begin = time.monotonic()
with (workspace / "process.log").open("w") as output:
    process = subprocess.Popen([str(binary)], env=environment, cwd=root, stdout=output, stderr=subprocess.STDOUT)
    try:
        while not report_path.exists():
            if process.poll() is not None:
                raise RuntimeError(f"Desktop process exited with {process.returncode}; inspect {workspace / 'process.log'}")
            if time.monotonic() - begin > 120:
                raise TimeoutError(f"Desktop regression exceeded 120 seconds; inspect {workspace / 'logs' / 'app.jsonl'}")
            time.sleep(0.2)
        report = json.loads(report_path.read_text())
        process_info = subprocess.run(["ps", "-o", "pid=,ppid=,rss=,%cpu=,etime=", "-p", str(process.pid)], text=True, check=True, capture_output=True).stdout.strip()
        report["process"] = process_info
        report["wallSeconds"] = time.monotonic() - begin
        report["legacyDataUnchanged"] = all(hashlib.sha256((source / name).read_bytes()).hexdigest() == digest for name, digest in original_hashes.items())
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if report["failed"] or not report["legacyDataUnchanged"]:
            raise RuntimeError("Desktop regression failed")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
