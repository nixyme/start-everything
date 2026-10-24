// 真实鼠标拖动工具：用 CGEvent 发送 HID 级输入事件，验证 WebKit 真实拖拽启动。
// 用法：real-drag <x1> <y1> <x2> <y2> [steps]；坐标为全局屏幕逻辑点（左上原点）。
import CoreGraphics
import Foundation

func sessionLocked() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (dict["kCGSSessionScreenIsLocked"] as? Int ?? 0) != 0 || (dict["kCGSSessionScreenIsLocked"] as? Bool ?? false)
}

let args = CommandLine.arguments.dropFirst().compactMap { Double($0) }

// 诊断模式：real-drag probe <x> <y> — 发送移动并回报系统实际鼠标位置，验证事件投递权限
if CommandLine.arguments.count > 2 && CommandLine.arguments[1] == "probe" && args.count >= 2 {
    let point = CGPoint(x: args[0], y: args[1])
    let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    move?.post(tap: .cghidEventTap)
    usleep(120_000)
    let actual = CGEvent(source: nil)?.location ?? CGPoint.zero
    let output = "requested=(\(point.x),\(point.y)) actual=(\(actual.x),\(actual.y))\n"
    FileHandle.standardOutput.write(output.data(using: .utf8)!)
    exit(abs(actual.x - point.x) < 2 && abs(actual.y - point.y) < 2 ? 0 : 3)
}

guard args.count >= 4 else {
    FileHandle.standardError.write("usage: real-drag <x1> <y1> <x2> <y2> [steps]\n".data(using: .utf8)!)
    exit(1)
}
if sessionLocked() {
    FileHandle.standardError.write("screen is locked; native UI test aborted\n".data(using: .utf8)!)
    exit(2)
}
let start = CGPoint(x: args[0], y: args[1])
let end = CGPoint(x: args[2], y: args[3])
let steps = args.count > 4 ? Int(args[4]) : 24

// 设置 REAL_DRAG_PID 时直接投递给目标进程，避免被遮挡窗口抢走 HID 路由
let targetPid: Int32? = ProcessInfo.processInfo.environment["REAL_DRAG_PID"].flatMap { Int32($0) }.flatMap { $0 > 0 ? $0 : nil }

func post(_ type: CGEventType, _ point: CGPoint) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    if let pid = targetPid { event?.postToPid(pid) } else { event?.post(tap: .cghidEventTap) }
    usleep(25_000)
}

post(.mouseMoved, start)
post(.leftMouseDown, start)
usleep(150_000) // 按住稳定，等待 WebKit 的拖拽起拖判定
for step in 1...steps {
    let ratio = Double(step) / Double(steps)
    let point = CGPoint(x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio)
    post(.leftMouseDragged, point)
}
usleep(180_000)
post(.leftMouseUp, end)
