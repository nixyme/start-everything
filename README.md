# Start Everything

A compact native desktop launcher built with Tauri 2, Rust, and the system WebView.

The application preserves Start Everything's project interface and JSON format. It manages commands, websites, folders, files, grouped resources, schedules, and execution history in English, Simplified Chinese, Japanese, and French.

## Install on macOS

The local release is available in `dist/START EVERYTHING.app` and `dist/start-everything-tauri-2.3.0-arm64.dmg` after packaging. Open the disk image and drag the application to Applications.

The current build targets Apple Silicon and macOS 12 or later. It uses an ad hoc signature. Apple notarization requires a Developer ID certificate and credentials.

## Development

Requirements: Rust 1.95, Node.js 22 or later, pnpm 10.12.3, and the native Tauri prerequisites for your operating system. macOS requires Xcode Command Line Tools. The installed application requires no Node.js or Rust installation.

```sh
pnpm install --frozen-lockfile
bash run.sh
```

Configuration is optional. Copy `.env.example` to `.env` to customize the data directory, scheduler switch, or log filter. An empty data directory setting uses the system default. `check_config.py` validates development configuration before startup.

```sh
pnpm build:mac
python3 scripts/package-artifacts.py
```

Windows packaging uses `pnpm build:win`. Linux packaging uses `pnpm build:linux`. These commands must run on their respective native operating systems. Windows and Linux have platform implementations and packaging settings; this delivery was built and exercised on macOS.

## Data compatibility

Supported inputs include the legacy `projects.json` array and exported objects containing `version`, `projects`, and `schedules`. Exports retain `version: "1.1"`.

Project fields retain their original names: `id`, `name`, `path`, `commands`, `command_names`, `command_modes`, `default_command`, `result_path`, `urls`, `folders`, `files`, `subprojects`, `pinned`, and `order`. Unknown extension fields survive saves and exports. Legacy records containing only `default_command` remain readable.

Imports match existing projects by name and retain their local IDs. Schedule references follow the imported project IDs. Historical schedules with missing projects remain readable and exportable. The scheduler checks project IDs and command indexes before executing a command.

On first normal startup, the application validates and copies the legacy data directory into its own directory. It preserves the legacy files. On macOS:

| Purpose | Directory |
| --- | --- |
| Legacy input | `~/Library/Application Support/start-everything/data/` |
| Native application | `~/Library/Application Support/com.nixyme.start-everything-new/data/` |
| Structured logs | `~/Library/Application Support/com.nixyme.start-everything-new/logs/` |

The new application maintains an in-memory cache, a previous-project backup, atomic file replacement, and transaction recovery for related file changes. Invalid JSON produces an explicit initialization error.

## Commands and schedules

Commands run in the configured system terminal or silently with captured output. macOS supports Terminal and Kaku. The default macOS shell is zsh when `SHELL` is absent. Shell startup files provide the user's command environment.

Silent execution captures up to 10 KiB from each output stream while continuing to drain larger output. Commands have a timeout. Disabling a running schedule and quitting the application terminate managed processes and their descendants. Unix uses process groups; Windows uses Job Objects.

Schedules accept the five-field and six-field Cron forms used by the previous application. Lists, ranges, weekday aliases, and English month names are supported. A running schedule cannot overlap itself.

The tray menu keeps the application available after its window closes. Global shortcuts restore its window. Launch at login uses the native autostart plugin.

Update checks use the official repository's release metadata. Compatible installers must be named `start-everything-tauri-<version>-<architecture>.<extension>`. Downloaded installers are opened for installation.

## Verification

```sh
cargo test --manifest-path src-tauri/Cargo.toml
node --test scripts/frontend-test.cjs
```

The macOS integration scripts exercise a real Tauri WKWebView and real commands. They read legacy data into isolated working directories and verify that the source files remain unchanged:

```sh
node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle
python3 scripts/run-desktop-smoke.py
python3 scripts/run-desktop-smoke.py --scheduler
python3 scripts/run-desktop-smoke.py --native
```

The native check temporarily changes this application's login setting, restores it, and launches a disposable Terminal command. Test scripts use `.work/`; the source data directory is never their write destination.

Release measurement uses `python3 scripts/measure-release.py`. The legacy comparison uses `node scripts/measure-legacy.cjs`. Detailed evidence and the CC-Switch source investigation are stored in the task archive.

## License

MIT. The interface and icon originate from Start Everything by nixyme.
