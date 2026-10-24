use std::path::{Path, PathBuf};

fn controlled_filename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_. ".contains(&byte))
}

/// 数据目录指针文件：内容为自定义数据目录的绝对路径，位于应用配置根目录。
pub fn data_pointer_file(base: &Path) -> PathBuf {
    base.join("data-dir.txt")
}

/// 解析生效数据目录：环境变量覆盖（测试）优先，其次指针文件（须为绝对路径），最后默认 data。
pub fn resolve_data_dir(base: &Path, env_override: Option<&str>, pointer: Option<&str>) -> PathBuf {
    if let Some(path) = env_override.map(str::trim).filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    match pointer.map(str::trim).filter(|text| !text.is_empty() && Path::new(text).is_absolute()) {
        Some(path) => PathBuf::from(path),
        None => base.join("data"),
    }
}

const DATA_FILE_NAMES: [&str; 6] = [
    "projects.json",
    "projects_backup.json",
    "settings.json",
    "schedules.json",
    "schedule-logs.json",
    "transaction.json",
];

/// 复制现有数据文件到新目录，返回复制数量。
fn copy_data_files(from: &Path, to: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let mut copied = 0;
    for name in DATA_FILE_NAMES {
        let source = from.join(name);
        if source.exists() {
            std::fs::copy(&source, to.join(name)).map_err(|e| format!("{}: {e}", source.display()))?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// 变更数据目录前的纯校验：绝对路径、不覆盖已有数据、不与当前目录互相嵌套、不是默认目录本身。
fn validate_data_dir_target(target: &Path, current: &Path, default_dir: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("Data directory must be an absolute path".into());
    }
    if target.join("projects.json").exists() {
        return Err("Target directory already contains project data".into());
    }
    if target == default_dir {
        return Err("Path is already the default data directory".into());
    }
    if target.starts_with(current) || current.starts_with(target) {
        return Err("New data directory must not contain or be inside the current one".into());
    }
    Ok(())
}

/// 从安装包文件名解析版本号：start-everything-tauri-<version>-<arch>.<ext>
fn installer_version(name: &str) -> Option<semver::Version> {
    let rest = name.strip_prefix("start-everything-tauri-")?;
    rest.split('-').next()?.parse::<semver::Version>().ok()
}

/// shell 脚本内单引号包裹使用的路径白名单：字母数字与 / 空格 . - _
fn shell_safe_path(path: &Path) -> bool {
    path.to_str().is_some_and(|text| {
        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/ .-_".contains(&byte))
    })
}

fn compatible_installer(name: &str, os: &str, arch: &str) -> bool {
    if !controlled_filename(name) {
        return false;
    }
    let name = name.to_ascii_lowercase();
    if !name.starts_with("start-everything-tauri-") {
        return false;
    }
    let matches_arch = match arch {
        "aarch64" => name.contains("-aarch64.") || name.contains("-arm64."),
        "x86_64" => name.contains("-x86_64.") || name.contains("-x64."),
        _ => false,
    } || name.contains("-universal.");
    matches_arch && match os {
        "macos" => name.ends_with(".dmg"),
        "windows" => name.ends_with(".msi") || name.ends_with(".exe"),
        "linux" => name.ends_with(".deb") || name.ends_with(".rpm") || name.ends_with(".appimage"),
        _ => false,
    }
}

mod native {
    use super::{compatible_installer, controlled_filename, copy_data_files, data_pointer_file, installer_version, shell_safe_path, validate_data_dir_target};
    use crate::store::SharedStore;
    use futures_util::StreamExt;
    use serde_json::{json, Value};
    use std::{fs, io::Write, path::{Path, PathBuf}, time::Duration};
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_autostart::ManagerExt as AutostartExt;
    use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogKind};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    use tauri_plugin_opener::OpenerExt;

    const RELEASE_API: &str = "https://api.github.com/repos/nixyme/start-everything/releases/latest";
    const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

    fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
        args.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing string argument: {key}"))
    }

    fn setting(store: &SharedStore, key: &str) -> Result<Value, String> {
        Ok(store.lock().map_err(|e| e.to_string())?.setting(key))
    }

    fn save_setting(store: &SharedStore, key: &str, value: Value) -> Result<(), String> {
        store.lock().map_err(|e| e.to_string())?.set_setting(key, value)
    }

    pub fn report_error(app: &AppHandle, action: &str, error: &str) {
        tracing::error!(event = "error_occurred", trace_id = %uuid::Uuid::new_v4(), service = "start-everything", env = "desktop", status = "failed", latency_ms = 0, decision_reason = action, error);
        app.dialog().message(format!("{action}\n\n{error}"))
            .title("START EVERYTHING").kind(MessageDialogKind::Error).show(|_| {});
    }

    fn show_main(app: &AppHandle) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        app.show().map_err(|e| e.to_string())?;
        let window = app.get_webview_window("main").ok_or("Main window does not exist")?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    }

    fn register_shortcut(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
        app.global_shortcut().on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(error) = show_main(app) {
                    report_error(app, "global_shortcut_show_window", &error);
                }
            }
        }).map_err(|e| e.to_string())
    }

    pub fn restore_shortcut(app: &AppHandle, store: &SharedStore) -> Result<(), String> {
        let result = (|| {
            let value = setting(store, "globalShortcut")?;
            let accelerator = value.as_str().unwrap_or_default();
            if accelerator.is_empty() { return Ok(()); }
            let shortcut = accelerator.parse::<Shortcut>().map_err(|e| e.to_string())?;
            register_shortcut(app, shortcut)
        })();
        if let Err(error) = &result {
            report_error(app, "restore_global_shortcut", error);
        }
        result
    }

    fn replace_shortcut(app: &AppHandle, store: &SharedStore, accelerator: &str) -> Result<Value, String> {
        let mut data = store.lock().map_err(|e| e.to_string())?;
        let old_value = data.setting("globalShortcut");
        let old_text = old_value.as_str().unwrap_or_default();
        if old_text == accelerator { return Ok(json!({"success":true})); }
        let old = if old_text.is_empty() { None } else {
            Some(old_text.parse::<Shortcut>().map_err(|e| e.to_string())?)
        };
        let new = if accelerator.is_empty() { None } else {
            Some(accelerator.parse::<Shortcut>().map_err(|e| e.to_string())?)
        };
        if old == new { return Ok(json!({"success":true})); }
        if let Some(shortcut) = new {
            register_shortcut(app, shortcut).map_err(|error| format!("conflict: {error}"))?;
        }
        if let Err(error) = data.set_setting("globalShortcut", json!(accelerator)) {
            if let Some(shortcut) = new {
                app.global_shortcut().unregister(shortcut).map_err(|cleanup| format!("{error}; unregister new shortcut: {cleanup}"))?;
            }
            return Err(error);
        }
        if let Some(shortcut) = old {
            if let Err(error) = app.global_shortcut().unregister(shortcut) {
                data.set_setting("globalShortcut", old_value).map_err(|restore| format!("{error}; restore shortcut setting: {restore}"))?;
                if let Some(new_shortcut) = new {
                    app.global_shortcut().unregister(new_shortcut).map_err(|cleanup| format!("{error}; unregister new shortcut: {cleanup}"))?;
                }
                return Err(error.to_string());
            }
        }
        Ok(json!({"success":true}))
    }

    async fn pick_path(app: &AppHandle, mode: &str, default: Option<PathBuf>) -> Result<Option<PathBuf>, String> {
        let mut builder = app.dialog().file();
        if let Some(window) = app.get_webview_window("main") { builder = builder.set_parent(&window); }
        if let Some(path) = default {
            if path.is_dir() { builder = builder.set_directory(path); }
            else {
                if let Some(parent) = path.parent().filter(|parent| parent.is_dir()) { builder = builder.set_directory(parent); }
                if mode == "save" {
                    if let Some(name) = path.file_name() { builder = builder.set_file_name(name.to_string_lossy()); }
                }
            }
        }
        builder = match mode {
            "save" => builder.set_title("Export Settings").add_filter("JSON Files", &["json"]),
            "import" => builder.set_title("Import Settings").add_filter("JSON Files", &["json"]),
            "folder" => builder.set_title("Select Folder"),
            _ => builder.set_title("Select Executable"),
        };
        let (send, receive) = tokio::sync::oneshot::channel::<Option<FilePath>>();
        let callback = move |path| { if send.send(path).is_err() { tracing::warn!(event = "error_occurred", trace_id = %uuid::Uuid::new_v4(), service = "start-everything", env = "desktop", status = "failed", latency_ms = 0, decision_reason = "file_dialog_receiver_closed"); } };
        match mode {
            "save" => builder.save_file(callback),
            "folder" => builder.pick_folder(callback),
            _ => builder.pick_file(callback),
        }
        receive.await.map_err(|e| e.to_string())?.map(|path| path.into_path().map_err(|e| e.to_string())).transpose()
    }

    async fn write_text(path: PathBuf, data: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || crate::store::atomic_write(&path, data.as_bytes()))
            .await.map_err(|e| e.to_string())?
    }

    fn http_client(app: &AppHandle) -> Result<reqwest::Client, String> {
        reqwest::Client::builder().user_agent(format!("START-EVERYTHING-Tauri/{}", app.package_info().version))
            .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(600))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let host = attempt.url().host_str().unwrap_or_default();
                if attempt.previous().len() >= 5 || attempt.url().scheme() != "https"
                    || !matches!(host, "github.com" | "api.github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com" | "github-releases.githubusercontent.com") {
                    attempt.error("Update redirect is outside GitHub HTTPS hosts")
                } else { attempt.follow() }
            })).build().map_err(|e| e.to_string())
    }

    async fn release(app: &AppHandle) -> Result<Value, String> {
        http_client(app)?.get(RELEASE_API).header("Accept", "application/vnd.github+json")
            .send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())
    }

    fn update_asset(release: &Value) -> Option<&Value> {
        release.get("assets")?.as_array()?.iter().find(|asset| {
            asset.get("name").and_then(Value::as_str).is_some_and(|name| {
                compatible_installer(name, std::env::consts::OS, std::env::consts::ARCH)
            })
        })
    }

    fn official_asset_url(url: &str, name: &str) -> Result<(), String> {
        let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
        let segments: Vec<_> = parsed.path_segments().ok_or("Invalid update path")?.collect();
        if parsed.scheme() != "https" || parsed.host_str() != Some("github.com")
            || !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some()
            || parsed.query().is_some() || parsed.fragment().is_some() || segments.len() != 6
            || segments[..4] != ["nixyme", "start-everything", "releases", "download"]
            || segments[4].is_empty() || segments[5] != name || !controlled_filename(name) {
            return Err("Update URL is outside the official GitHub release".into());
        }
        Ok(())
    }

    fn update_directory(app: &AppHandle) -> Result<PathBuf, String> {
        let directory = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        if fs::symlink_metadata(&directory).map_err(|e| e.to_string())?.file_type().is_symlink() {
            return Err("Update directory must not be a symbolic link".into());
        }
        directory.canonicalize().map_err(|e| e.to_string())
    }

    fn running_from_app_bundle() -> bool {
        match std::env::current_exe() {
            Ok(exe) => exe.ancestors().any(|p| p.extension().is_some_and(|ext| ext == "app")),
            Err(_) => false,
        }
    }

    fn downloaded_info(store: &SharedStore) -> Option<Value> {
        let value = setting(store, "downloadedUpdate").ok()?;
        let object = value.as_object()?;
        let name = object.get("name")?.as_str()?;
        let path = object.get("path")?.as_str()?;
        Some(json!({"path": path, "name": name, "version": installer_version(name)?.to_string()}))
    }

    async fn check_update(app: &AppHandle, store: &SharedStore) -> Result<Value, String> {
        let release = release(app).await?;
        let current = app.package_info().version.clone();
        let tag = release.get("tag_name").and_then(Value::as_str).ok_or("Missing release version")?.trim_start_matches('v');
        let latest = tag.parse::<semver::Version>().map_err(|e| format!("Invalid release version: {e}"))?;
        let asset = update_asset(&release);
        let newer = latest > current && asset.is_some() && release["prerelease"] != true && release["draft"] != true;
        let url = asset.and_then(|asset| asset["browser_download_url"].as_str());
        if let (Some(asset), Some(url)) = (asset, url) {
            official_asset_url(url, asset["name"].as_str().ok_or("Missing asset name")?)?;
        }
        Ok(json!({"success":true,"data":{"currentVersion":current.to_string(),"latestVersion":latest.to_string(),
            "isNewer":newer,"releaseNotes":release["body"].as_str().unwrap_or_default(),
            "downloadUrl":url,"releaseUrl":release["html_url"],"compatibleAsset":asset.is_some(),
            "autoCapable":running_from_app_bundle(),"downloaded":downloaded_info(store)}}))
    }

    async fn download_update(app: &AppHandle, store: &SharedStore, url: &str) -> Result<Value, String> {
        let release = release(app).await?;
        let asset = update_asset(&release).ok_or("No compatible Tauri installer in the official release")?;
        let name = asset["name"].as_str().ok_or("Missing update asset name")?;
        let expected_url = asset["browser_download_url"].as_str().ok_or("Missing update asset URL")?;
        if url != expected_url { return Err("Update URL does not match the official compatible asset".into()); }
        official_asset_url(url, name)?;
        let expected_size = asset["size"].as_u64().filter(|size| *size > 0 && *size <= MAX_UPDATE_BYTES).ok_or("Invalid update asset size")?;
        let directory = update_directory(app)?.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let path = directory.join(name);
        let response = http_client(app)?.get(url).send().await.map_err(|e| e.to_string())?
            .error_for_status().map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0_u64;
        let mut last_percent = 0;
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| e.to_string())?;
            downloaded += bytes.len() as u64;
            if downloaded > expected_size { return Err("Download exceeds the official asset size".into()); }
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            let percent = downloaded * 100 / expected_size;
            if percent > last_percent {
                app.emit("update-download-progress", json!({"percent":percent,"downloaded":downloaded,"total":expected_size})).map_err(|e| e.to_string())?;
                last_percent = percent;
            }
        }
        if downloaded != expected_size { return Err("Update download is incomplete".into()); }
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist_noclobber(&path).map_err(|e| e.to_string())?;
        save_setting(store, "downloadedUpdate", json!({"path":path,"url":url,"name":name,"size":expected_size}))?;
        Ok(json!({"success":true,"filePath":path}))
    }

    fn current_app_bundle() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        exe.ancestors().skip(1)
            .find(|p| p.extension().is_some_and(|ext| ext == "app"))
            .map(Path::to_path_buf)
    }

    // macOS 真升级：挂载 DMG → 生成独立升级脚本（等进程退出后 ditto 替换并重启）→ 应用自杀。
    // 脚本由 launchd 收养后独立运行，不依赖本进程存活。
    #[cfg(target_os = "macos")]
    fn apply_macos_update(dmg: &Path, target: &Path, root: &Path) -> Result<(), String> {
        let mount = tempfile::tempdir().map_err(|e| e.to_string())?.keep();
        let status = std::process::Command::new("/usr/bin/hdiutil")
            .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
            .arg(&mount).arg(dmg).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Failed to mount the update disk image".into());
        }
        let source = fs::read_dir(&mount).map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|ext| ext == "app"))
            .ok_or("No application bundle inside the update disk image")?;
        if !shell_safe_path(&source) || !shell_safe_path(target) {
            return Err("Update path contains characters that are not shell safe".into());
        }
        let pid = std::process::id();
        let script_path = root.join(format!("apply-update-{}.sh", uuid::Uuid::new_v4()));
        let log_path = root.join("apply-update.log");
        let (target_text, source_text, mount_text, log_text, script_text) =
            (target.to_string_lossy(), source.to_string_lossy(), mount.to_string_lossy(), log_path.to_string_lossy(), script_path.to_string_lossy());
        let script = format!(
            "#!/bin/bash\n\
             # START EVERYTHING auto update: wait for app exit, replace bundle, relaunch.\n\
             PID={pid}\n\
             TARGET='{target_text}'\n\
             SOURCE='{source_text}'\n\
             VOLUME='{mount_text}'\n\
             LOG='{log_text}'\n\
             SCRIPT='{script_text}'\n\
             for i in $(seq 1 300); do\n\
             \x20 kill -0 \"$PID\" 2>/dev/null || break\n\
             \x20 sleep 0.2\n\
             done\n\
             if kill -0 \"$PID\" 2>/dev/null; then\n\
             \x20 echo \"application did not exit in time\" >> \"$LOG\"\n\
             \x20 /usr/bin/hdiutil detach -force \"$VOLUME\" >> \"$LOG\" 2>&1\n\
             \x20 rm -f \"$SCRIPT\"\n\
             \x20 exit 1\n\
             fi\n\
             rm -rf \"$TARGET.new\"\n\
             /usr/bin/ditto \"$SOURCE\" \"$TARGET.new\" >> \"$LOG\" 2>&1\n\
             STATUS=$?\n\
             if [ $STATUS -eq 0 ]; then\n\
             \x20 rm -rf \"$TARGET\" && mv \"$TARGET.new\" \"$TARGET\" >> \"$LOG\" 2>&1\n\
             \x20 STATUS=$?\n\
             fi\n\
             /usr/bin/hdiutil detach \"$VOLUME\" >> \"$LOG\" 2>&1\n\
             if [ $STATUS -eq 0 ]; then\n\
             \x20 /usr/bin/open \"$TARGET\" >> \"$LOG\" 2>&1\n\
             fi\n\
             rm -f \"$SCRIPT\"\n"
        );
        crate::store::atomic_write(&script_path, script.as_bytes())?;
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::process::Command::new("/bin/bash").arg(&script_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn().map_err(|e| format!("Failed to start the updater script: {e}"))?;
        tracing::info!(event = "update_apply_started", source = %source.display(), target = %target.display(), script = %script_path.display());
        Ok(())
    }

    fn install_update(app: &AppHandle, store: &SharedStore, requested: &str) -> Result<Value, String> {
        let update = setting(store, "downloadedUpdate")?;
        let path = PathBuf::from(requested);
        let saved = update["path"].as_str().ok_or("No verified update has been downloaded")?;
        if saved != requested { return Err("Installer path does not match the downloaded update".into()); }
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        let root = update_directory(app)?;
        let relative = canonical.strip_prefix(&root).map_err(|_| "Installer is outside the controlled update directory")?;
        let name = update["name"].as_str().ok_or("Missing installer name")?;
        if canonical != path || relative.components().count() != 2
            || canonical.file_name().and_then(|name| name.to_str()) != Some(name)
            || !compatible_installer(name, std::env::consts::OS, std::env::consts::ARCH) {
            return Err("Installer path or platform does not match the downloaded update".into());
        }
        official_asset_url(update["url"].as_str().ok_or("Missing installer source")?, name)?;
        let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
        if !metadata.is_file() || Some(metadata.len()) != update["size"].as_u64() {
            return Err("Downloaded installer has changed".into());
        }
        // 升级流程一旦启动就清除已下载标记，重启后不应再显示旧安装包入口。
        let _ = save_setting(store, "downloadedUpdate", Value::Null);
        #[cfg(target_os = "macos")]
        {
            // 非 .app 环境（开发、裸二进制）无法自替换，退回打开 DMG 手动安装。
            match current_app_bundle().filter(|bundle| shell_safe_path(bundle)) {
                Some(target) => {
                    apply_macos_update(&canonical, &target, &root)?;
                    // 给 IPC 响应留出送达时间，再退出由升级脚本接管。
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(800));
                        handle.exit(0);
                    });
                    return Ok(json!({"success":true,"restarting":true}));
                }
                None => tracing::warn!(event = "update_fallback_open_installer", decision_reason = "not_running_from_app_bundle"),
            }
        }
        app.opener().open_path(canonical.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
        Ok(json!({"success":true,"installerOpened":true}))
    }

    #[cfg(target_os = "macos")]
    fn spawn_new_instance() -> Result<std::process::Child, String> {
        let bundle = current_app_bundle().ok_or("Application bundle not found")?;
        std::process::Command::new("/usr/bin/open").arg("-n").arg(&bundle).spawn().map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    fn spawn_new_instance() -> Result<std::process::Child, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        std::process::Command::new(exe).spawn().map_err(|e| e.to_string())
    }

    // 重启应用：先拉起新实例，再延迟退出当前进程，让新实例无缝接管。
    fn relaunch_app(app: &AppHandle) -> Result<Value, String> {
        spawn_new_instance().map_err(|e| format!("Failed to launch the new instance: {e}"))?;
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            handle.exit(0);
        });
        Ok(json!({"success":true}))
    }

    async fn set_data_dir(app: &AppHandle, store: &SharedStore, requested: &str) -> Result<Value, String> {
        let target = PathBuf::from(requested);
        let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let copied = {
            let data = store.lock().map_err(|e| e.to_string())?;
            validate_data_dir_target(&target, &data.data_dir, &base.join("data"))?;
            copy_data_files(&data.data_dir, &target)?
        };
        crate::store::atomic_write(&data_pointer_file(&base), target.to_string_lossy().as_bytes())?;
        tracing::info!(event = "data_dir_changed", target = %target.display(), copied);
        Ok(json!({"success":true,"dataDir":target,"copiedFiles":copied}))
    }

    pub async fn dispatch(action: &str, args: Value, app: AppHandle, store: SharedStore) -> Result<Value, String> {
        match action {
            "select-folder" | "select-file" => {
                let default = args.get("defaultPath").and_then(Value::as_str).filter(|path| Path::new(path).exists()).map(PathBuf::from);
                let mode = if action == "select-folder" { "folder" } else { "file" };
                Ok(match pick_path(&app, mode, default).await? {
                    Some(path) => json!({"canceled":false,"path":path}),
                    None => json!({"canceled":true}),
                })
            }
            "save-file" => {
                let last = setting(&store, "lastExportPath")?;
                let default = last.as_str().filter(|s| !s.is_empty()).or_else(|| args["defaultName"].as_str()).unwrap_or("start-everything-settings.json");
                let Some(path) = pick_path(&app, "save", Some(PathBuf::from(default))).await? else { return Ok(json!({"canceled":true})); };
                write_text(path.clone(), text(&args, "data")?.to_owned()).await?;
                save_setting(&store, "lastExportPath", json!(path))?;
                Ok(json!({"canceled":false,"path":path}))
            }
            "quick-save-file" => {
                let last = setting(&store, "lastExportPath")?;
                let Some(path) = last.as_str().filter(|path| !path.is_empty()) else { return Ok(json!({"needsDialog":true})); };
                let path = PathBuf::from(path);
                match write_text(path.clone(), text(&args, "data")?.to_owned()).await {
                    Ok(()) => Ok(json!({"success":true,"path":path})),
                    Err(error) => Ok(json!({"needsDialog":true,"error":error})),
                }
            }
            "open-file" => {
                let last = setting(&store, "lastImportPath")?;
                let default = last.as_str().and_then(|path| Path::new(path).parent()).map(Path::to_path_buf);
                let Some(path) = pick_path(&app, "import", default).await? else { return Ok(json!({"canceled":true})); };
                let source = path.clone();
                let data = tauri::async_runtime::spawn_blocking(move || fs::read_to_string(source).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())??;
                save_setting(&store, "lastImportPath", json!(path))?;
                Ok(json!({"canceled":false,"data":data}))
            }
            "open-data-dir" => {
                let path = store.lock().map_err(|e| e.to_string())?.data_dir.clone();
                app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
                Ok(json!({"success":true}))
            }
            "get-data-dir-info" => {
                let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
                let data = store.lock().map_err(|e| e.to_string())?;
                let default_dir = base.join("data");
                let is_custom = data.data_dir != default_dir;
                Ok(json!({"success":true,"data":{"dataDir":data.data_dir,"defaultDir":default_dir,"isCustom":is_custom}}))
            }
            "set-data-dir" => set_data_dir(&app, &store, text(&args, "path")?).await,
            "reset-data-dir" => {
                let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
                let pointer = data_pointer_file(&base);
                if pointer.exists() {
                    fs::remove_file(&pointer).map_err(|e| e.to_string())?;
                    tracing::info!(event = "data_dir_reset_to_default");
                }
                Ok(json!({"success":true}))
            }
            "relaunch-app" => relaunch_app(&app),
            "get-last-import-export-dir" => {
                let data = store.lock().map_err(|e| e.to_string())?;
                let exported = data.setting("lastExportPath");
                let imported = data.setting("lastImportPath");
                let path = exported.as_str().filter(|value| !value.is_empty()).or_else(|| imported.as_str().filter(|value| !value.is_empty()))
                    .and_then(|path| Path::new(path).parent()).map(Path::to_path_buf).unwrap_or_else(|| data.data_dir.clone());
                Ok(json!({"success":true,"path":path}))
            }
            "open-folder" | "open-file-with-default" => {
                let key = if action == "open-folder" { "folderPath" } else { "filePath" };
                let path = text(&args, key)?;
                fs::metadata(path).map_err(|e| e.to_string())?;
                app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())?;
                Ok(json!({"success":true}))
            }
            "open-url" => {
                app.opener().open_url(text(&args, "url")?, None::<&str>).map_err(|e| e.to_string())?;
                Ok(json!({"success":true}))
            }
            "check-path-type" => match fs::metadata(text(&args, "filePath")?) {
                Ok(metadata) => Ok(json!({"exists":true,"isDirectory":metadata.is_dir(),"isFile":metadata.is_file()})),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({"exists":false})),
                Err(error) => Err(error.to_string()),
            },
            "hide-window" | "minimize-window" => {
                let window = app.get_webview_window("main").ok_or("Main window does not exist")?;
                if action == "minimize-window" { window.minimize().map_err(|e| e.to_string())?; }
                else {
                    #[cfg(target_os = "macos")]
                    app.hide().map_err(|e| e.to_string())?;
                    #[cfg(not(target_os = "macos"))]
                    window.hide().map_err(|e| e.to_string())?;
                }
                Ok(json!({"success":true}))
            }
            "get-global-shortcut" => Ok(json!(setting(&store, "globalShortcut")?.as_str().unwrap_or_default())),
            "set-global-shortcut" => replace_shortcut(&app, &store, text(&args, "accelerator")?),
            "get-auto-launch" => Ok(json!(app.autolaunch().is_enabled().map_err(|e| e.to_string())?)),
            "set-auto-launch" => {
                let enabled = args["enabled"].as_bool().ok_or("Missing boolean argument: enabled")?;
                let manager = app.autolaunch();
                if enabled { manager.enable() } else { manager.disable() }.map_err(|e| e.to_string())?;
                Ok(json!({"success":true}))
            }
            "get-app-version" => Ok(json!(app.package_info().version.to_string())),
            "check-for-update" => check_update(&app, &store).await,
            "download-update" => download_update(&app, &store, text(&args, "url")?).await,
            "install-update" => install_update(&app, &store, text(&args, "filePath")?),
            _ => Err(format!("Unsupported platform action: {action}")),
        }
    }
}

pub use native::{dispatch, restore_shortcut};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_matching_tauri_installers() {
        assert!(compatible_installer("start-everything-tauri-2.1.0-aarch64.dmg", "macos", "aarch64"));
        assert!(compatible_installer("start-everything-tauri-2.1.0-universal.dmg", "macos", "x86_64"));
        assert!(!compatible_installer("START EVERYTHING-1.1.11-arm64.dmg", "macos", "aarch64"));
        assert!(!compatible_installer("start-everything-tauri-2.1.0-x86_64.dmg", "macos", "aarch64"));
        assert!(!compatible_installer("start-everything-tauri-2.1.0-aarch64.exe", "macos", "aarch64"));
    }

    #[test]
    fn rejects_download_filename_traversal() {
        assert!(controlled_filename("start-everything-tauri-2.1.0-aarch64.dmg"));
        for name in ["", ".", "..", "../installer.dmg", "dir/installer.dmg", "dir\\installer.dmg", "installer.dmg?query", "installer.dmg\0"] {
            assert!(!controlled_filename(name), "{name:?}");
        }
    }

    #[test]
    fn resolves_data_dir_with_env_pointer_and_default() {
        let base = Path::new("/base");
        // 环境变量覆盖优先于一切
        assert_eq!(resolve_data_dir(base, Some("/tmp/test-data", ), None), PathBuf::from("/tmp/test-data"));
        assert_eq!(resolve_data_dir(base, Some("/tmp/test-data"), Some("/ignored")), PathBuf::from("/tmp/test-data"));
        assert_eq!(resolve_data_dir(base, Some("  "), Some("/pointer/dir")), PathBuf::from("/pointer/dir"));
        // 指针内容必须是绝对路径，相对路径按无指针处理
        assert_eq!(resolve_data_dir(base, None, Some("relative/path")), base.join("data"));
        assert_eq!(resolve_data_dir(base, None, Some("  /abs/path  ")), PathBuf::from("/abs/path"));
        assert_eq!(resolve_data_dir(base, None, None), base.join("data"));
        assert_eq!(resolve_data_dir(base, None, Some("")), base.join("data"));
    }

    #[test]
    fn validates_data_dir_target() {
        let current = Path::new("/Users/t/Library/Application Support/app/data");
        let default = Path::new("/Users/t/Library/Application Support/app/data");
        assert!(validate_data_dir_target(Path::new("relative/dir"), current, default).is_err());
        assert!(validate_data_dir_target(current, current, default).is_err());
        // 目标目录已有数据文件时拒绝，防止覆盖
        let existing = std::env::temp_dir().join(format!("se-target-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("projects.json"), b"[]").unwrap();
        assert!(validate_data_dir_target(&existing, current, default).is_err());
        std::fs::remove_dir_all(&existing).unwrap();
        // 与当前目录互相嵌套一律拒绝
        let custom = Path::new("/Users/t/Data/start-everything");
        assert!(validate_data_dir_target(custom.parent().unwrap(), custom, default).is_err());
        assert!(validate_data_dir_target(&custom.join("nested"), custom, default).is_err());
        assert!(validate_data_dir_target(custom, current, default).is_ok());
    }

    #[test]
    fn parses_installer_versions() {
        assert_eq!(installer_version("start-everything-tauri-2.3.0-arm64.dmg").unwrap().to_string(), "2.3.0");
        assert_eq!(installer_version("start-everything-tauri-2.10.1-x86_64.exe").unwrap().to_string(), "2.10.1");
        assert!(installer_version("START EVERYTHING-1.1.11-arm64.dmg").is_none());
        assert!(installer_version("start-everything-tauri-notaversion-arm64.dmg").is_none());
    }

    #[test]
    fn shell_paths_allow_spaces_and_reject_quotes() {
        assert!(shell_safe_path(Path::new("/Applications/START EVERYTHING.app")));
        assert!(shell_safe_path(Path::new("/var/folders/T/abc123/__/d/start-everything-tauri-2.3.0-arm64.dmg")));
        assert!(!shell_safe_path(Path::new("/tmp/it's.app")));
        assert!(!shell_safe_path(Path::new("/tmp/$(reboot).app")));
        assert!(!shell_safe_path(Path::new("")));
    }

    #[test]
    fn copies_only_known_data_files() {
        let dir = std::env::temp_dir().join(format!("se-copy-test-{}", uuid::Uuid::new_v4()));
        let from = dir.join("from");
        let to = dir.join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("projects.json"), b"[]").unwrap();
        std::fs::write(from.join("settings.json"), b"{}").unwrap();
        std::fs::write(from.join("unrelated.txt"), b"skip").unwrap();
        let copied = copy_data_files(&from, &to).unwrap();
        assert_eq!(copied, 2);
        assert!(to.join("projects.json").exists());
        assert!(!to.join("unrelated.txt").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
