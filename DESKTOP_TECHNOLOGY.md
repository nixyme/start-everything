# 桌面应用技术选型与开发规范

适用范围：需要本地文件、系统窗口、托盘、快捷键或后台任务的桌面工具。

本文可以直接复制到其他项目根目录，作为开发说明或 AI 开发任务的技术约束。文中的 `desktop-tool`、`Desktop Tool`、`com.example.desktop-tool` 和 `APP_` 前缀需要统一替换为目标项目的名称。所有目录均相对于目标项目根目录。

文档日期：2026-10-21。技术依据：已运行的 Tauri 2 桌面应用。依赖版本属于已验证基线，升级时需要重新构建与验证。

## 1. 技术组成

| 部分 | 使用的技术 | 职责 |
| --- | --- | --- |
| 桌面框架 | Tauri 2 | 窗口、生命周期、原生通信、应用打包 |
| 原生逻辑 | Rust | 文件、持久化、任务、系统调用、参数校验 |
| 页面 | HTML、CSS、JavaScript | 页面渲染、表单、交互与多语言 |
| 页面运行环境 | 操作系统提供的 WebView | 执行页面代码，显示界面 |
| 异步处理 | Tokio | 异步进程、输出读取、超时和并发任务 |
| 数据格式 | JSON、Serde、serde_json | 配置、业务记录、导入导出 |
| 结构化日志 | tracing、tracing-subscriber | JSONL 日志、请求关联、耗时和错误 |
| 原生功能 | Tauri 官方插件 | 对话框、文件打开、通知、自动启动、快捷键 |
| HTTP 请求 | reqwest、futures-util | 外部接口与流式下载 |
| 开发与构建 | Rust 工具链、Node.js、pnpm、Tauri CLI | 安装依赖、开发启动、测试与打包 |

macOS 使用 WKWebView，Windows 使用 WebView2，Linux 使用 WebKitGTK。应用包使用系统的页面运行环境，因此体积通常较小。不同系统的 WebView 行为需要分别验证。

页面直接交付静态文件，开发过程使用 Tauri CLI。此方案使用原生 JavaScript，页面代码无需经过 React、TypeScript 或 Vite 的编译流程。项目若已有其他页面框架，可以保留页面框架，并让 Tauri 加载其构建输出目录。

已安装的应用通常无需用户安装 Rust、Node.js、pnpm 或 Python。Windows 的 WebView2 和 Linux 的系统运行库需要由安装流程或操作系统提供。应用若启动用户的外部命令，该命令仍需在用户电脑中可用。

## 2. 模块职责与调用方式

| 文件或目录 | 职责 |
| --- | --- |
| `src/index.html` | 页面结构与脚本加载顺序 |
| `src/styles.css` | 页面样式和适配 |
| `src/app.js` | 页面交互、表单状态、页面刷新 |
| `src/bridge.js` | 统一封装原生调用、事件订阅与错误展示 |
| `src/frontend-utils.js` | 可以独立测试的页面纯函数 |
| `src/i18n.js` | 语言资源、语言选择和文字更新 |
| `src-tauri/src/main.rs` | 应用启动、插件注册、窗口与生命周期 |
| `src-tauri/src/lib.rs` | 导出可以独立测试的 Rust 模块 |
| `src-tauri/src/store.rs` | 数据读取、缓存、校验、事务与保存 |
| `src-tauri/src/execution.rs` | 子进程、定时任务、超时和退出清理 |
| `src-tauri/src/platform.rs` | 原生对话框、系统设置和平台差异 |
| `src-tauri/build.rs` | 调用 tauri-build，生成构建所需资源 |
| `src-tauri/Cargo.toml` | Rust 依赖和发布编译配置 |
| `src-tauri/Cargo.lock` | Rust 依赖的实际解析版本 |
| `src-tauri/tauri.conf.json` | 应用标识、窗口、安全与打包配置 |
| `src-tauri/icons/` | 各个平台使用的图标 |
| `src-tauri/tests/` | 数据兼容与集成测试 |
| `scripts/` | 验证、性能测量和交付脚本 |
| `.work/` | 隔离的测试数据与中间结果，加入 Git 忽略规则 |
| `dist/` | 整理后的安装包、应用和校验信息 |

调用顺序为：用户操作页面，`bridge.js` 调用 Tauri command，Rust 完成操作，返回结构化结果，页面更新对应区域。后台任务通过 Tauri event 通知页面。

页面负责用户交互。Rust 负责操作系统权限、文件路径、网络请求和持久化。页面中的按钮状态不能替代 Rust 的参数与权限校验。

模块之间通过明确的参数和返回类型通信。共享数据可以使用 `Arc<Mutex<Store>>`；获得数据后及时释放锁，避免持有锁执行 `.await`、原生对话框或长时间任务。

## 3. 环境与版本

| 工具 | 已验证配置 |
| --- | --- |
| Rust | 1.95.0 |
| Rust edition | 2021 |
| Node.js | 22 及以上作为开发环境基线 |
| pnpm | 10.12.3 |
| Tauri | 2.x，实际版本由 lock 文件固定 |
| macOS | Apple Silicon、macOS 12 及以上 |

复制项目配置时，同时提交 `Cargo.lock` 和 `pnpm-lock.yaml`。`Cargo.toml` 中的版本范围无法替代完整的依赖锁定。Rust 最低版本还受间接依赖影响；声明较低的 `rust-version` 需要在该版本的编译器上实际验证。

`rust-toolchain.toml`：

```toml
[toolchain]
channel = "1.95.0"
profile = "minimal"
components = ["rustfmt", "clippy"]
```

开发机器需要安装目标系统的原生构建工具。macOS 使用 Xcode Command Line Tools。Windows 使用对应的 C++ 构建工具与 WebView2。Linux 使用目标发行版要求的 WebKitGTK、编译工具和相关系统库，安装项以 Tauri 2 的平台前置要求为准。

## 4. 依赖配置

下面的 `package.json` 适用于直接加载静态页面的项目：

```json
{
  "name": "desktop-tool",
  "version": "1.0.0",
  "private": true,
  "packageManager": "pnpm@10.12.3",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "build:mac": "tauri build --bundles app,dmg",
    "build:win": "tauri build --bundles nsis",
    "build:linux": "tauri build --bundles appimage,deb",
    "test": "cargo test --manifest-path src-tauri/Cargo.toml",
    "tauri": "tauri"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.10.1"
  }
}
```

Rust 依赖按业务职责选择。下表给出已验证项目的依赖范围与启用条件；目标项目需要的功能应使用对应的成熟库。

| 依赖 | 版本范围 | 用途与启用条件 |
| --- | --- | --- |
| `tauri` | `2` | 桌面框架；需要托盘时启用 `tray-icon` |
| `tauri-build` | `2` | 放在 `[build-dependencies]` |
| `serde` | `1` | 开启 `derive`，用于结构化数据 |
| `serde_json` | `1` | JSON 解析与序列化 |
| `tokio` | `1` | 需要异步任务；按实现启用 `process`、`time`、`io-util`、`rt-multi-thread`、`sync`、`macros` |
| `tracing` | `0.1` | 记录结构化事件 |
| `tracing-subscriber` | `0.3` | 开启 `json`、`env-filter` |
| `uuid` | `1` | 开启 `v4`，生成记录与请求标识 |
| `chrono` | `0.4` | 时间、时区与日期序列化 |
| `tempfile` | `3` | 在目标目录创建临时文件 |
| `fs2` | `0.4` | 数据目录的文件锁 |
| `reqwest` | `0.12` | HTTP 与下载；已验证配置使用 `default-features = false`，启用 `json`、`native-tls`、`stream` |
| `futures-util` | `0.3` | 读取异步下载流 |
| `semver` | `1` | 解析和比较软件版本 |
| `croner` | `4` | 需要 Cron 定时任务时启用 |
| `libc` | `0.2` | Unix 进程组等底层系统操作 |
| `windows-sys` | `0.61` | Windows Job Object 等原生操作，放在 Windows 专属依赖中 |

原生插件均使用 2.x 系列，在 Rust Builder 中注册。插件的职责如下：

| 插件 | 提供的功能 |
| --- | --- |
| `tauri-plugin-dialog` | 文件选择、目录选择、保存对话框和错误弹窗 |
| `tauri-plugin-opener` | 使用系统应用打开文件、目录和网址 |
| `tauri-plugin-notification` | 系统通知 |
| `tauri-plugin-autostart` | 登录后自动启动 |
| `tauri-plugin-global-shortcut` | 全局快捷键 |

Windows 需要完整管理命令后代进程时，为 `windows-sys` 启用 `Win32_Foundation`、`Win32_System_JobObjects`、`Win32_System_Threading`、`Win32_Security`、`Win32_System_Diagnostics_ToolHelp`。其他原生功能按照实际调用的 API 声明 feature。

发布编译配置：

```toml
[profile.release]
opt-level = "s"
lto = "thin"
codegen-units = 1
panic = "abort"
strip = "symbols"
```

该配置侧重较小的发布产物。`panic = "abort"` 会使 panic 直接结束进程，因此读取 JSON 和处理外部输入时必须先校验类型，再访问字段；预期会发生的输入错误通过 `Result` 返回。性能指标仍需根据真实业务测量。

## 5. Tauri 配置

下面是通用项目配置。图标文件需要实际存在。配置文件位于 `src-tauri/tauri.conf.json`，因此 `../src` 指向项目根目录的页面目录。

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Desktop Tool",
  "version": "1.0.0",
  "identifier": "com.example.desktop-tool",
  "build": {
    "frontendDist": "../src"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [{
      "label": "main",
      "title": "Desktop Tool",
      "width": 1180,
      "height": 800,
      "minWidth": 760,
      "minHeight": 540,
      "dragDropEnabled": true
    }],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; frame-src 'none'",
      "capabilities": [{
        "identifier": "main",
        "windows": ["main"],
        "permissions": ["core:default"]
      }]
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.png", "icons/icon.icns", "icons/icon.ico"],
    "macOS": {
      "minimumSystemVersion": "12.0",
      "signingIdentity": "-"
    },
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper",
        "silent": true
      }
    }
  }
}
```

目标项目必须使用自己的 `identifier`，同时更换窗口标题、图标、安装包名称和数据迁移来源。应用标识会影响系统识别和默认数据目录。

上述 CSP 适用于外部脚本文件和外部样式文件。复用已有页面时，需要检查内联事件、内联脚本、动态样式、图片与请求来源，再设置对应 CSP。已运行的旧界面兼容配置允许内联脚本与样式；该兼容设置需要结合目标页面审查。

JavaScript 直接调用插件时，需要配置插件对应的 capabilities。例如通知插件可能需要 `notification:default`。Rust 注册插件与 JavaScript 获得调用权限是两个独立步骤。

自定义 command 通过 `invoke_handler` 注册后，仍需在 Rust 中校验业务参数。窗口 capabilities 不会自动为单一 command 内部的每个 `action` 建立业务授权。存在多个权限不同的窗口时，使用 command 的权限声明和调用窗口信息限制访问。

## 6. 页面与 Rust 通信

使用统一页面入口，例如 `window.desktopAPI`。业务页面通过该入口调用原生能力，避免在每个组件重复处理通信错误。

静态 JavaScript 可以使用：

```javascript
const result = await window.__TAURI__.core.invoke('api', {
  action: 'list-records',
  args: {}
});
```

此调用要求 Rust 已注册名为 `api` 的 command，并实现对应的 `action`。`withGlobalTauri` 提供全局 API；使用前端构建工具的项目也可以从 `@tauri-apps/api` 导入 API。

统一返回合同：

| 场景 | 返回规则 |
| --- | --- |
| 操作成功 | `{ "success": true, "data": ... }` |
| 操作失败 | Rust 返回 `Err`，bridge 记录日志并显示具体错误 |
| 用户取消对话框 | `{ "canceled": true }`，页面结束本次操作 |
| 后台任务完成 | event 携带任务 ID、状态、耗时与退出码 |

修改已有应用时，以其现有返回格式为兼容合同。统一入口可以集中分发 `action`；每个 action 的输入和返回内容必须有明确校验和测试。

事件订阅需要保存解除订阅函数。关闭页面、关闭临时界面或完成下载后解除对应订阅。依赖事件结果的测试应等待订阅真正完成。

文件拖放使用 Tauri 原生拖放事件提供的路径。根据屏幕缩放比例把原生坐标转换为页面坐标，再查找接收位置。不要依赖 Electron 特有的 `File.path`。

## 7. 数据存储与兼容

配置和业务数据放在 Tauri path API 返回的应用数据目录。测试使用显式指定的隔离目录。安装目录只放程序与资源。

JSON 适合配置、项目列表、快捷操作等数据。需要复杂查询、大量记录或关系事务的项目应使用成熟数据库，例如 SQLite，并单独定义迁移规则。

使用 JSON 时需要实现以下规则：

1. 启动时完整解析并校验文件，成功后建立内存缓存。
2. 更新时先校验候选数据，保存成功后再提交内存状态。
3. 在目标文件的同一目录创建临时文件，写入并同步，再原子替换目标文件。
4. 多文件操作保存事务记录，明确提交、失败恢复和重启恢复行为；单个文件原子替换不能自动保证多个文件同时提交。
5. 使用数据目录文件锁，阻止多个写入者同时修改相同数据。
6. 保留前一次有效备份，错误文件不覆盖有效数据。

兼容旧格式时，明确比较键、必需字段、缺失字段默认值、冲突优先级、删除规则和关联记录处理。使用 `serde_json::Value` 保留未知扩展字段；使用 Rust struct 时，可以通过 `#[serde(flatten)]` 保存扩展字段。

迁移先验证源文件，再复制到新目录。导入后再次导出并逐个比较字段值，JSON 对象的键顺序不参与语义比较。定时任务等关联记录需要通过稳定 ID 和命令索引重新检查；历史孤立记录可以保留，执行之前必须确认关联有效。

## 8. 命令执行与后台任务

Rust 使用 Tokio 启动进程，页面显示执行状态。项目需要外部命令时，明确工作目录、shell、环境变量、输出限制和超时时间。

| 问题 | 实现要求 |
| --- | --- |
| 中文、空格、引号路径 | 使用路径对象和独立参数；必须测试各个平台的 shell 转义 |
| shell 环境 | 正确加载目标用户的环境；macOS 从 Finder 启动时检查 `SHELL` 缺失情况 |
| 输出很多 | 限制保存的输出大小，同时持续读取 stdout 与 stderr，避免管道阻塞 |
| 执行超时 | 截止时间覆盖等待进程结束与输出读取两个阶段 |
| Unix 后代进程 | 建立独立进程组，取消时清理整个进程组 |
| Windows 后代进程 | 使用 Job Object 管理整个任务的后代进程 |
| 应用退出 | 停止调度、结束受管进程并保存终态 |
| 同任务重复触发 | 维护运行任务集合，明确是否允许同任务重叠 |
| 计划内容变化 | 执行前重新读取当前有效配置，避免执行旧命令快照 |

Cron 使用 `croner` 等成熟库解析。兼容其他 Cron 实现时，需要测试字段数量、秒字段、星期编号、月份名称、日期与星期组合、本地时区和系统休眠后的行为。

## 9. 配置、日志与错误

`.env.example` 使用通用前缀：

```dotenv
APP_DATA_DIR=
APP_DISABLE_SCHEDULER=0
RUST_LOG=info
```

Rust 需要明确读取这些变量。`run.sh` 可以加载 `.env`，通过 `set -a` 将变量导出给子进程。打包后的应用从 Finder 启动时，环境变量和工作目录可能与开发终端不同；应用需要自行确定配置来源。

如果使用 `config.json` 中的 `${变量}` 引用，项目必须实现引用解析与配置校验。JSON 文件和 Tauri 不会自动完成这项替换。提供 `check_config.py` 或功能等价的配置检查程序，检查目录、变量格式和开发工具可用性。

配置校验程序需要 Python 时，把 Python 列入开发工具要求；应用本身需要 Python 执行业务时，则必须明确用户环境或打包依赖。

使用 tracing 输出 JSONL。每个请求创建 `trace_id`，传递给异步任务。每条日志至少包含 `timestamp`、`event`、`level`、`trace_id`，并记录 `service`、`env`、`status`、`latency_ms` 和 `decision_reason`。tracing 的 JSON 输出可能把业务字段放在 `fields` 中，日志校验程序应读取实际结构。

请求记录 `request_received` 与 `request_finished` / `request_failed`。任务记录 `job_started` 与 `job_succeeded` / `job_failed`。日志文件需要设置轮换规则。

初始化失败显示原生错误弹窗。运行失败显示具体操作、错误和可定位的日志信息。异步对话框通过回调或异步结果完成，避免在系统主线程等待阻塞对话框。

密钥和长期凭据放在受控的原生配置或系统凭据存储中。日志需要隐藏密钥、令牌与敏感业务输入。业务代码使用 `Result` 传播可预期错误，禁止把解析失败转换为空数据并继续覆盖文件。

## 10. 构建与分发

安装和构建按顺序执行：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

第一次建立新项目时，使用 `pnpm install` 生成锁文件，再提交锁文件。后续使用 `--frozen-lockfile` 复现依赖。

在对应系统执行目标构建命令：

```bash
pnpm build:mac
pnpm build:win
pnpm build:linux
```

上述三条命令分别用于 macOS、Windows、Linux。单个平台构建成功只能证明该平台的结果。

macOS 的 `signingIdentity: "-"` 使用 ad hoc 签名。面向互联网正式分发时，按项目要求配置 Developer ID 签名和 Apple 公证。Windows 安装需要的 WebView2 下载方式与离线安装要求需要分别验证。Linux 安装包必须保留并验证系统依赖。

交付目录应包含安装包、版本、平台、CPU 架构、文件大小与 SHA-256。自动更新校验发布来源、目标平台和架构；实现签名校验时使用成熟更新插件及其签名流程。

## 11. 验证与性能标准

通用检查命令：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
node --check src/app.js
node --check src/bridge.js
```

存在前端纯函数测试文件时，使用 Node.js 内建测试运行器执行。真实界面测试必须启动实际 Tauri 应用并调用实际原生接口。浏览器中的页面测试不能证明原生对话框、快捷键和进程管理正确。

发布前需要验证真实文件读写、中文路径、损坏数据、导入再导出、任务取消、超时、退出清理和错误弹窗。已有数据迁移前后比较源文件哈希。原生设置测试结束后恢复用户设置。

性能测量使用发布构建，并明确以下指标：

| 指标 | 统计方式 |
| --- | --- |
| 应用体积 | 应用目录实际文件字节数 |
| 安装包体积 | 安装包实际字节数 |
| 应用内部启动时间 | Rust 入口开始计时，页面完成必需数据加载与事件订阅后结束 |
| 完整启动时间 | 启动进程开始计时，等待实际界面就绪 |
| 内存 | 同时记录主进程和 WebView 辅助进程，并说明 RSS 共享页可能重复计数 |
| 交互耗时 | 使用真实业务数据测量搜索、切换和保存 |
| 后台开销 | 空闲 CPU、计划轮询和退出后的残留进程 |

macOS 的 WebKit 辅助进程可能由系统启动，父进程编号不能完整表示应用的辅助进程。记录进程启动前后的变化，并说明其他程序活动对统计的影响。

参考案例：Start Everything 在2026-10-19的 Apple Silicon 验证中，应用约11.96 MiB，DMG约7.99 MiB；旧应用约225.78 MiB，应用体积减少94.70%。采样的进程 RSS 总和减少约47.50%。此结果属于该应用、该数据量和该机器，不作为其他项目的目标保证。

## 12. 复制到其他项目后的实施要求

以下内容可以直接作为目标项目的开发任务：

> 按本说明使用 Tauri 2、Rust 和 HTML/CSS/JavaScript 构建桌面应用。Rust 管理文件、持久化、后台任务与系统能力，页面通过统一 bridge 调用已注册的原生接口。按业务功能选择表格中对应的成熟库。
>
> 使用目标项目自己的名称、identifier、图标、环境变量前缀、数据目录与安装包名称。提交 Rust 工具链配置和两种依赖锁文件。明确开发工具要求与用户运行要求。
>
> 在编写功能前定义输入、返回结构、数据格式、关联规则、错误传播和退出清理。建立结构化日志。持久化使用原子文件替换；多文件更新需要事务记录与恢复。与旧数据兼容的项目，使用真实旧文件验证读取、修改和导出再导入。
>
> 分别实现支持平台的系统操作。使用真实命令和真实原生接口完成测试，验证失败立即修复并重新执行。完成各个平台的发布构建、签名校验、安装包检查和性能测量后，提供实际产物与证据。

## 官方依据

Tauri 2 官方文档的 Architecture、Develop、Calling Rust、Capabilities、Prerequisites 和 macOS Code Signing 章节可用于核对框架行为。本文的版本范围与配置来自已验证项目；目标项目升级依赖后应重新核对官方文档和实际解析版本。
