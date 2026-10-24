import json
from pathlib import Path
import statistics


root = Path(__file__).resolve().parent.parent
destination = root / "processing" / "2026-10-19-tauri-rewrite"
if not destination.exists():
    destination = root / "archived" / "2026-10-19-tauri-rewrite"
reports = {}
for name in ["desktop-smoke", "scheduler-smoke", "native-smoke"]:
    report = json.loads((root / ".work" / name / "report.json").read_text())
    if report["failed"] != 0 or not report["legacyDataUnchanged"]:
        raise RuntimeError(f"Verification failed: {name}")
    reports[name] = {"passed": report["passed"], "failed": report["failed"], "legacyDataUnchanged": report["legacyDataUnchanged"], "checks": [{"name": item["name"], "passed": item["passed"]} for item in report["checks"]]}
release = json.loads((root / ".work" / "release-measurement" / "report.json").read_text())
legacy = json.loads((root / ".work" / "legacy-measurement" / "report.json").read_text())
manifest = json.loads((root / "dist" / "manifest.json").read_text())
native_memory = [item["nativeRssKiB"] + sum(process["rssKiB"] for process in item["relatedProcesses"]) for item in release["measurements"]]
legacy_memory = [item["totalRssKiB"] for item in legacy["measurements"]]
evidence = {
    "date": "2026-10-19",
    "platform": "macOS Apple Silicon",
    "unitTests": {"rustPassed": 29, "frontendPassed": 6},
    "integration": reports,
    "release": manifest,
    "size": {"newBundleBytes": release["bundleBytes"], "legacyBundleBytes": release["legacyBundleBytes"], "reductionPercent": release["sizeReductionPercent"]},
    "memory": {"metric": "sum of process RSS, including WebView helpers; shared pages may be counted more than once", "nativeTotalRssKiB": native_memory, "legacyTotalRssKiB": legacy_memory, "reductionPercent": (1 - statistics.mean(native_memory) / statistics.mean(legacy_memory)) * 100},
    "startup": {"nativeInternalReadyMs": [item["startupMs"] for item in release["measurements"]], "nativeProcessToReadyMs": [item["launchToReadyMs"] for item in release["measurements"]], "legacyProcessToReadyMs": [item["launchToReadyMs"] for item in legacy["measurements"]], "note": "Native readiness includes project rendering and event subscriptions. Legacy readiness is measured through CDP after document loading and a real project query. This run does not demonstrate a startup speed improvement."},
    "legacyDataUnchanged": release["legacyDataUnchanged"],
    "signature": "ad hoc; codesign --verify --deep --strict passed",
    "diskImage": "hdiutil verify passed; mounted application signature and executable compared successfully",
    "limitations": ["Windows and Linux implementations have not been run on their native operating systems.", "Apple notarization is not configured.", "RSS is sampled on this machine; system workload and shared memory affect measurements."]
}
(destination / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
print(json.dumps({"rustTests":29,"frontendTests":6,"integrationChecks":sum(report["passed"] for report in reports.values()),"sizeReductionPercent":evidence["size"]["reductionPercent"],"rssReductionPercent":evidence["memory"]["reductionPercent"],"dmgBytes":manifest["dmgBytes"]}, ensure_ascii=False, indent=2))
