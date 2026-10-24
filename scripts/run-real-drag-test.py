import argparse
import json
import os
import shutil
import subprocess
import time
from pathlib import Path


# 真实鼠标拖动回归：编译 CGEvent 工具，向真实应用窗口发送 HID 拖动输入，验证 WebKit 启动整行拖拽。
parser = argparse.ArgumentParser()
arguments = parser.parse_args()
root = Path(__file__).resolve().parent.parent
workspace = root / ".work" / "real-drag-test"
shutil.rmtree(workspace, ignore_errors=True)
workspace.mkdir(parents=True)

source = Path.home() / "Library" / "Application Support" / "start-everything" / "data"
target = workspace / "data"
target.mkdir(exist_ok=True)
names = ["projects.json", "schedules.json", "settings.json", "schedule-logs.json"]
for name in names:
    shutil.copy2(source / name, target / name)
settings = json.loads((target / "settings.json").read_text())
settings["globalShortcut"] = ""
settings["locale"] = "en"
settings["terminal"] = "default"
(target / "settings.json").write_text(json.dumps(settings, ensure_ascii=False))

binary = root / "src-tauri" / "target" / "debug" / "start-everything-new"
assert binary.exists(), f"缺少调试构建：{binary}（先运行 tauri build --debug --no-bundle）"

tool = workspace / "real-drag"
source_swift = root / "scripts" / "real-drag.swift"
compile_result = subprocess.run(["swiftc", "-O", str(source_swift), "-o", str(tool)], capture_output=True, text=True)
assert compile_result.returncode == 0, f"swiftc 编译失败：{compile_result.stderr}"

report_path = workspace / "report.json"
environment = os.environ.copy()
environment.update({
    "START_EVERYTHING_DATA_DIR": str(target),
    "START_EVERYTHING_DISABLE_SCHEDULER": "1",
    "START_EVERYTHING_TEST_SCRIPT": str(root / "scripts" / "real-drag-probe.js"),
    "START_EVERYTHING_TEST_REPORT": str(report_path),
    "RUST_LOG": "info",
})


def read_report(phase):
    if not report_path.exists():
        return None
    try:
        report = json.loads(report_path.read_text())
    except json.JSONDecodeError:
        return None
    return report if report.get("phase") == phase else None


process = subprocess.Popen([str(binary)], env=environment, cwd=root,
                           stdout=(workspace / "process.log").open("w"), stderr=subprocess.STDOUT)
try:
    probe = None
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        # status 报告同样携带坐标，读到任意一份即可
        probe = read_report("probe") or read_report("status")
        if probe:
            break
        failure = read_report("error")
        if failure:
            raise RuntimeError(f"探针初始化失败：{failure['message']}")
        if process.poll() is not None:
            raise RuntimeError(f"应用提前退出，退出码 {process.returncode}；查看 {workspace / 'process.log'}")
        time.sleep(0.25)
    assert probe, "30 秒内没有收到探针坐标"

    activation = subprocess.run(["osascript", "-e",
        'tell application id "com.nixyme.start-everything-new" to activate\n'
        'delay 0.3\n'
        'tell application "System Events" to tell process "start-everything-new" to get frontmost'],
        capture_output=True, text=True)
    print(f"激活结果：frontmost={activation.stdout.strip()} {activation.stderr.strip()}（由探针内 Tauri setFocus 保证窗口 key）")
    assert activation.returncode == 0, f"无法激活应用窗口：{activation.stderr}"
    time.sleep(0.5)

    # System Events 与 CGEvent 共用左上原点的全局逻辑坐标；窗口内 rect 需加窗口原点与标题栏高度
    bounds = subprocess.run(["osascript", "-e",
        'tell application "System Events" to tell process "start-everything-new" to get {position, size} of window 1'],
        capture_output=True, text=True, check=True).stdout
    values = [int(value.strip().replace(',', '')) for value in bounds.replace('\n', '').split(',') if value.strip()]
    win_x, win_y, win_w, win_h = values[:4]
    print(f"窗口 bounds：position=({win_x},{win_y}) size=({win_w},{win_h})")
    titlebar = win_h - probe["viewport"]["height"]  # 窗口高度减内容高度即标题栏
    start_point = (win_x + probe["handle"]["x"], win_y + titlebar + probe["handle"]["y"])
    end_point = (win_x + probe["second"]["x"], win_y + titlebar + probe["second"]["y"])
    print(f"真实拖动：{start_point} -> {end_point}（标题栏 {titlebar}px，pid {process.pid}）")
    drag = subprocess.run([str(tool), str(start_point[0]), str(start_point[1]), str(end_point[0]), str(end_point[1])],
                          capture_output=True, text=True, env={**os.environ, "REAL_DRAG_PID": str(process.pid)})
    assert drag.returncode == 0, f"拖动工具失败（退出码 {drag.returncode}）：{drag.stderr}"

    before = probe["before"]
    expected = [before[1], before[0]] + before[2:]
    result = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = read_report("status")
        if status and status.get("after") == expected:
            result = status
            break
        time.sleep(0.25)
    assert result, f"真实拖动后顺序没有变化；期望 {expected}，实际 {(read_report('status') or {}).get('after')}；事件日志 {json.dumps((read_report('status') or {}).get('dragLog', []), ensure_ascii=False)[:1200]}"
    print(json.dumps({"passed": True, "before": before, "after": result["after"]}, ensure_ascii=False, indent=2))
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
