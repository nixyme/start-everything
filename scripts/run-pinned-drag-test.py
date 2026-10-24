import json
import os
import shutil
import subprocess
import time
from pathlib import Path


# 置顶格子真实鼠标拖动回归：CGEvent 发送 HID 拖动输入，验证指针事件实现的置顶排序。
root = Path(__file__).resolve().parent.parent
workspace = root / ".work" / "pinned-drag-test"
shutil.rmtree(workspace, ignore_errors=True)
workspace.mkdir(parents=True)

target = workspace / "data"
target.mkdir(exist_ok=True)
projects = []
for index, name in enumerate(["Alpha", "Beta", "Gamma"]):
    projects.append({
        "id": f"pinned-{name.lower()}",
        "name": name,
        "commands": [f"echo {name.lower()}"],
        "pinned": True,
        "order": index,
    })
(target / "projects.json").write_text(json.dumps(projects), encoding="utf-8")
(target / "settings.json").write_text(json.dumps({"globalShortcut": "", "locale": "en", "terminal": "default"}), encoding="utf-8")
(target / "schedules.json").write_text("[]", encoding="utf-8")
(target / "schedule-logs.json").write_text("[]", encoding="utf-8")

binary = root / "src-tauri" / "target" / "debug" / "start-everything-new"
assert binary.exists(), f"缺少调试构建：{binary}（先运行 cargo build 或 tauri build --debug --no-bundle）"

tool = workspace / "real-drag"
source_swift = root / "scripts" / "real-drag.swift"
compile_result = subprocess.run(["swiftc", "-O", str(source_swift), "-o", str(tool)], capture_output=True, text=True)
assert compile_result.returncode == 0, f"swiftc 编译失败：{compile_result.stderr}"

report_path = workspace / "report.json"
environment = os.environ.copy()
environment.update({
    "START_EVERYTHING_DATA_DIR": str(target),
    "START_EVERYTHING_DISABLE_SCHEDULER": "1",
    "START_EVERYTHING_TEST_SCRIPT": str(root / "scripts" / "pinned-drag-probe.js"),
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
        f'tell application "System Events" to set frontmost of (first process whose unix id is {process.pid}) to true\n'
        'delay 0.4\n'
        f'tell application "System Events" to get name of first process whose frontmost is true'],
        capture_output=True, text=True)
    frontmost = activation.stdout.strip()
    print(f"激活结果：frontmost={frontmost} {activation.stderr.strip()}")
    assert activation.returncode == 0 and "start-everything-new" in frontmost, f"无法激活测试窗口：{activation.stderr}"
    time.sleep(0.5)

    bounds, values = None, []
    for attempt in range(6):
        bounds = subprocess.run(["osascript", "-e",
            'tell application "System Events" to tell process "start-everything-new" to get {position, size} of window 1'],
            capture_output=True, text=True)
        if bounds.returncode == 0:
            values = [int(value.strip().replace(',', '')) for value in bounds.stdout.replace('\n', '').split(',') if value.strip()]
            if len(values) >= 4:
                break
        time.sleep(0.5)
    assert len(values) >= 4, f"无法读取窗口 bounds：{bounds.stderr.strip()}"
    win_x, win_y, win_w, win_h = values[:4]
    print(f"窗口 bounds：position=({win_x},{win_y}) size=({win_w},{win_h})")
    titlebar = win_h - probe["viewport"]["height"]
    start_point = (win_x + probe["start"]["x"], win_y + titlebar + probe["start"]["y"])
    end_point = (win_x + probe["end"]["x"], win_y + titlebar + probe["end"]["y"])
    print(f"真实拖动：{start_point} -> {end_point}（标题栏 {titlebar}px，pid {process.pid}）")
    # 全局 HID 投递（窗口已置前），postToPid 不触发 WKWebView 的指针事件
    drag = subprocess.run([str(tool), str(start_point[0]), str(start_point[1]), str(end_point[0]), str(end_point[1])],
                          capture_output=True, text=True)
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
    assert result, (f"真实拖动后置顶顺序没有变化；期望 {expected}，实际 {(read_report('status') or {}).get('after')}；"
                    f"事件日志 {json.dumps((read_report('status') or {}).get('dragLog', []), ensure_ascii=False)[:1200]}")

    # 持久化核验：重启数据目录回读，确认 order 落盘
    time.sleep(0.8)
    persisted = json.loads((target / "projects.json").read_text())
    persisted_ids = [p["id"] for p in sorted(persisted, key=lambda x: x.get("order", 0))]
    assert persisted_ids == expected, f"持久化顺序不符：{persisted_ids} != {expected}"
    print(json.dumps({"passed": True, "before": before, "after": result["after"], "persisted": persisted_ids}, ensure_ascii=False, indent=2))
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
