import json
import os
import shutil
import subprocess
import time
from pathlib import Path


# 更新链路与数据目录变更回归：真实调用 checkForUpdate / setDataDir，并核验指针文件落盘。
# 关键：结束后必须删除 data-dir.txt 指针文件，防止影响真实安装版的数据目录。
root = Path(__file__).resolve().parent.parent
workspace = root / ".work" / "update-flow-test"
shutil.rmtree(workspace, ignore_errors=True)
workspace.mkdir(parents=True)

target = workspace / "data"
target.mkdir(exist_ok=True)
projects = [{"id": "p1", "name": "示例项目", "commands": ["pwd"], "order": 0}]
(target / "projects.json").write_text(json.dumps(projects, ensure_ascii=False), encoding="utf-8")
(target / "settings.json").write_text(json.dumps({"globalShortcut": "", "locale": "en"}), encoding="utf-8")
(target / "schedules.json").write_text("[]", encoding="utf-8")
(target / "schedule-logs.json").write_text("[]", encoding="utf-8")

new_dir = workspace / "new-data"

# 注入测试目标目录后写出探针副本
probe_source = (root / "scripts" / "update-flow-probe.js").read_text()
injected = workspace / "probe-injected.js"
injected.write_text(f"window.__UPDATE_TEST_NEW_DIR = {json.dumps(str(new_dir))};\n" + probe_source, encoding="utf-8")

binary = root / "src-tauri" / "target" / "debug" / "start-everything-new"
assert binary.exists(), f"缺少调试构建：{binary}"

report_path = workspace / "report.json"
environment = os.environ.copy()
environment.update({
    "START_EVERYTHING_DATA_DIR": str(target),
    "START_EVERYTHING_DISABLE_SCHEDULER": "1",
    "START_EVERYTHING_TEST_SCRIPT": str(injected),
    "START_EVERYTHING_TEST_REPORT": str(report_path),
    "RUST_LOG": "info",
})

pointer_file = Path.home() / "Library" / "Application Support" / "com.nixyme.start-everything-new" / "data-dir.txt"

process = subprocess.Popen([str(binary)], env=environment, cwd=root,
                           stdout=(workspace / "process.log").open("w"), stderr=subprocess.STDOUT)
try:
    report = None
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if report_path.exists():
            try:
                candidate = json.loads(report_path.read_text())
                report = candidate if candidate.get("phase") in ("done", "error") else None
            except json.JSONDecodeError:
                pass
        if report:
            break
        if process.poll() is not None:
            raise RuntimeError(f"应用提前退出，退出码 {process.returncode}；查看 {workspace / 'process.log'}")
        time.sleep(0.25)
    assert report, "60 秒内没有收到测试报告"
    assert report["phase"] == "done", f"探针失败：{report.get('message')}\n{report.get('stack', '')}"

    # 指针文件核验：内容指向新目录
    assert pointer_file.exists(), f"指针文件未写入：{pointer_file}"
    pointer_content = pointer_file.read_text().strip()
    assert pointer_content == str(new_dir), f"指针内容不符：{pointer_content}"

    # 新目录数据核验：与源目录逐文件一致
    copied = {name: (new_dir / name).read_bytes() for name in ["projects.json", "settings.json", "schedules.json"]}
    for name, content in copied.items():
        assert content == (target / name).read_bytes(), f"{name} 复制不一致"
    assert not (new_dir / "transaction.json").exists(), "不应复制不存在的事务文件"

    print(json.dumps({"passed": report["passed"], "failed": report["failed"], "results": report["results"],
                      "pointer": pointer_content, "persistedCopy": True}, ensure_ascii=False, indent=2))
    assert report["failed"] == 0, "存在失败断言"
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
    # 必须清理：指针文件会改变真实安装版的数据目录
    if pointer_file.exists():
        pointer_file.unlink()
        print(f"已清理指针文件：{pointer_file}")
