use crate::store::SharedStore;
use chrono::{Local, Utc};
use croner::{parser::{CronParser, Seconds, Year}, Cron};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::{io::{AsyncRead, AsyncReadExt}, process::Command};
use tracing::Instrument;

const OUTPUT_LIMIT: usize = 10 * 1024;
static STOPPING: AtomicBool = AtomicBool::new(false);
static PROCESSES: OnceLock<Mutex<HashMap<String, (u32, Arc<AtomicBool>)>>> = OnceLock::new();
#[cfg(windows)]
static WINDOWS_JOBS: OnceLock<Mutex<HashMap<u32, std::os::windows::io::OwnedHandle>>> = OnceLock::new();

fn processes() -> &'static Mutex<HashMap<String, (u32, Arc<AtomicBool>)>> {
    PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
fn windows_jobs() -> &'static Mutex<HashMap<u32, std::os::windows::io::OwnedHandle>> {
    WINDOWS_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
fn create_windows_job(child: &tokio::process::Child) -> Result<std::os::windows::io::OwnedHandle, String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::System::JobObjects::{CreateJobObjectW, SetInformationJobObject, AssignProcessToJobObject, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
        let job = std::os::windows::io::OwnedHandle::from_raw_handle(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let process = child.raw_handle().ok_or("无法获取 Windows 进程句柄")?;
        if AssignProcessToJobObject(handle, process) == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        Ok(job)
    }
}

#[cfg(windows)]
fn resume_windows_process(pid: u32) -> Result<(), String> {
    use std::os::windows::io::{FromRawHandle, AsRawHandle};
    use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE, System::{Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD}, Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME}}};
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE { return Err(std::io::Error::last_os_error().to_string()); }
        let snapshot = std::os::windows::io::OwnedHandle::from_raw_handle(snapshot);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        if Thread32First(snapshot.as_raw_handle(), &mut entry) == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        loop {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if thread.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
                let thread = std::os::windows::io::OwnedHandle::from_raw_handle(thread);
                if ResumeThread(thread.as_raw_handle()) == u32::MAX { return Err(std::io::Error::last_os_error().to_string()); }
                return Ok(());
            }
            if Thread32Next(snapshot.as_raw_handle(), &mut entry) == 0 { return Err(format!("无法找到 Windows 进程 {pid} 的主线程")); }
        }
    }
}

fn parse_cron(expression: &str) -> Result<Cron, String> {
    if !(5..=6).contains(&expression.split_whitespace().count())
        || !expression.chars().all(|character| character.is_ascii_alphanumeric() || character.is_ascii_whitespace() || "*/,-".contains(character))
    {
        return Err("Cron 表达式必须包含 5 或 6 个有效字段".into());
    }
    let mut normalized = expression.to_ascii_uppercase();
    for (full, short) in [
        ("JANUARY", "JAN"), ("FEBRUARY", "FEB"), ("MARCH", "MAR"), ("APRIL", "APR"),
        ("JUNE", "JUN"), ("JULY", "JUL"), ("AUGUST", "AUG"), ("SEPTEMBER", "SEP"),
        ("OCTOBER", "OCT"), ("NOVEMBER", "NOV"), ("DECEMBER", "DEC"),
        ("SUNDAY", "SUN"), ("MONDAY", "MON"), ("TUESDAY", "TUE"), ("WEDNESDAY", "WED"),
        ("THURSDAY", "THU"), ("FRIDAY", "FRI"), ("SATURDAY", "SAT"),
    ] { normalized = normalized.replace(full, short); }
    CronParser::builder()
        .seconds(Seconds::Optional)
        .year(Year::Disallowed)
        .dom_and_dow(true)
        .build()
        .parse(&normalized)
        .map_err(|error| error.to_string())
}

pub fn validate_cron(expression: &str) -> Result<(), String> {
    parse_cron(expression).map(|_| ())
}

fn is_registered_path(projects: &[Value], path: &str) -> bool {
    projects.iter().any(|project| {
        project.get("path").and_then(Value::as_str) == Some(path)
            || project.get("projectPath").and_then(Value::as_str) == Some(path)
            || ["subprojects", "commands"].iter().any(|key| {
                project.get(key).and_then(Value::as_array)
                    .is_some_and(|children| is_registered_path(children, path))
            })
    })
}

fn resolve_schedule(schedule: &Value, projects: &[Value]) -> Result<Value, String> {
    let project_id = schedule.get("projectId").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or("定时任务缺少项目编号")?;
    let project = projects.iter().find(|project| project.get("id").and_then(Value::as_str) == Some(project_id)).ok_or("定时任务关联的项目不存在")?;
    let index = schedule.get("commandIndex").and_then(Value::as_u64).and_then(|index| usize::try_from(index).ok()).ok_or("定时任务缺少有效命令序号")?;
    let command = project.get("commands").and_then(Value::as_array).and_then(|commands| commands.get(index)).and_then(Value::as_str).filter(|command| !command.trim().is_empty()).ok_or("定时任务关联的命令不存在或为空")?;
    let path = project.get("path").and_then(Value::as_str).ok_or("定时任务关联的项目缺少路径")?;
    let name = project.get("name").and_then(Value::as_str).ok_or("定时任务关联的项目缺少名称")?;
    let command_name = project.get("command_names").and_then(Value::as_array).and_then(|names| names.get(index)).and_then(Value::as_str).unwrap_or("");
    let mut resolved = schedule.clone();
    let fields = resolved.as_object_mut().ok_or("定时任务格式错误")?;
    fields.insert("projectPath".into(), json!(path));
    fields.insert("projectName".into(), json!(name));
    fields.insert("command".into(), json!(command));
    fields.insert("commandName".into(), json!(command_name));
    Ok(resolved)
}

fn remember_invalid_schedule(invalid: &mut HashMap<String, Value>, id: &str, schedule: &Value) -> bool {
    if invalid.get(id) == Some(schedule) { return false; }
    invalid.insert(id.into(), schedule.clone());
    true
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn user_shell() -> String {
    #[cfg(windows)]
    { std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()) }
    #[cfg(target_os = "macos")]
    { std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()) }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    { std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()) }
}

fn shell_script(shell: &str, command: &str, directory: &Path, keep_open: bool) -> Result<String, String> {
    let path = directory.to_str().ok_or("项目路径包含无效字符")?;
    #[cfg(windows)]
    { let _ = (shell, keep_open, path); return Ok(command.to_owned()); }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let rc = match (Path::new(shell).file_name().and_then(|name| name.to_str()), home) {
            (Some("zsh"), Some(home)) => Some(home.join(".zshrc")),
            (Some("bash"), Some(home)) => Some(home.join(".bashrc")),
            (Some("fish"), Some(home)) => Some(home.join(".config/fish/config.fish")),
            _ => None,
        };
        let mut script = String::new();
        if let Some(rc) = rc.filter(|path| path.is_file()) {
            script.push_str(&format!("source {} 2>/dev/null; ", shell_quote(&rc.to_string_lossy())));
        }
        script.push_str(&format!("cd {} && {command}", shell_quote(path)));
        if keep_open { script.push_str(&format!("; exec {} -l", shell_quote(shell))); }
        Ok(script)
    }
}

fn normalize_command(command: &str, directory: &Path, terminal: bool) -> String {
    if command.starts_with(['\'', '"']) { return command.into(); }
    let mut boundaries: Vec<usize> = command.char_indices().filter_map(|(index, character)| character.is_whitespace().then_some(index)).collect();
    boundaries.push(command.len());
    for boundary in boundaries.into_iter().rev() {
        let candidate = command[..boundary].trim_end();
        if candidate.is_empty() { continue; }
        let path = directory.join(candidate);
        if !path.is_file() && !(cfg!(target_os = "macos") && path.extension().is_some_and(|extension| extension == "app")) { continue; }
        let rest = &command[boundary..];
        #[cfg(target_os = "macos")]
        if path.extension().is_some_and(|extension| extension == "app") {
            if terminal { return format!("open {}{rest}", shell_quote(&path.to_string_lossy())); }
            let executable = path.join("Contents/MacOS").join(path.file_stem().unwrap_or_default());
            if executable.is_file() { return format!("{}{rest}", shell_quote(&executable.to_string_lossy())); }
            return format!("open {}{rest}", shell_quote(&path.to_string_lossy()));
        }
        let _ = terminal;
        #[cfg(windows)]
        { return format!("\"{}\"{rest}", path.to_string_lossy()); }
        #[cfg(not(windows))]
        { return format!("{}{rest}", shell_quote(&path.to_string_lossy())); }
    }
    command.into()
}

fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        // 每个受管命令使用独立进程组，负数 PID 会终止其中全部进程。
        if libc::kill(-(pid as i32), libc::SIGKILL) != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                tracing::error!(event = "error_occurred", decision_reason = "process_cleanup_failed", pid, error = %error);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if let Some(job) = windows_jobs().lock().expect("Windows 任务记录锁已损坏").get(&pid) {
            unsafe {
                if TerminateJobObject(job.as_raw_handle(), 1) == 0 {
                    tracing::error!(event = "error_occurred", decision_reason = "process_cleanup_failed", pid, error = %std::io::Error::last_os_error());
                }
            }
            return;
        }
        if let Err(error) = std::process::Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status() {
            tracing::error!(event = "error_occurred", decision_reason = "process_cleanup_failed", pid, error = %error);
        }
    }
}

pub fn shutdown_execution() {
    STOPPING.store(true, Ordering::Release);
    let processes = processes().lock().expect("执行进程记录锁已损坏");
    for (pid, cancelled) in processes.values() {
        cancelled.store(true, Ordering::Release);
        kill_group(*pid);
    }
}

fn cleanup_disabled_processes(enabled: &HashSet<String>) {
    let registry = processes().lock().expect("执行进程记录锁已损坏");
    for (key, (pid, cancelled)) in registry.iter() {
        if key.strip_prefix("schedule:").is_some_and(|id| !enabled.contains(id)) {
            cancelled.store(true, Ordering::Release);
            kill_group(*pid);
        }
    }
}

struct ProcessGuard { key: String, pid: u32 }

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        kill_group(self.pid);
        processes().lock().expect("执行进程记录锁已损坏").remove(&self.key);
        #[cfg(windows)]
        windows_jobs().lock().expect("Windows 任务记录锁已损坏").remove(&self.pid);
    }
}

async fn drain_output(mut reader: impl AsyncRead + Unpin, captured: Arc<Mutex<Vec<u8>>>) -> Result<(), String> {
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await.map_err(|error| error.to_string())?;
        if count == 0 { return Ok(()); }
        let mut output = captured.lock().expect("输出记录锁已损坏");
        let remaining = OUTPUT_LIMIT.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
    }
}

async fn run_shell_using(shell: &str, command: &str, directory: &Path, timeout: Duration, key: &str) -> Result<Value, String> {
    let started = Instant::now();
    let start_time = Utc::now().to_rfc3339();
    let script = shell_script(shell, command, directory, false)?;
    let mut process = Command::new(shell);
    #[cfg(windows)]
    process.args(["/D", "/S", "/C"]).raw_arg(format!("\"{script}\"")).creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
    #[cfg(not(windows))]
    process.args(["-l", "-c", &script]);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.as_std_mut().process_group(0);
    }
    process.current_dir(directory).env_remove("ELECTRON_RUN_AS_NODE").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let pid = child.id().ok_or("无法获取命令进程编号")?;
    #[cfg(windows)]
    let job = create_windows_job(&child)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut registry = processes().lock().expect("执行进程记录锁已损坏");
        if registry.contains_key(key) { kill_group(pid); return Err("相同任务正在执行".into()); }
        if STOPPING.load(Ordering::Acquire) { kill_group(pid); return Err("应用正在退出".into()); }
        registry.insert(key.into(), (pid, cancelled.clone()));
    }
    let _guard = ProcessGuard { key: key.into(), pid };
    #[cfg(windows)]
    {
        windows_jobs().lock().expect("Windows 任务记录锁已损坏").insert(pid, job);
        resume_windows_process(pid)?;
    }
    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let mut stdout_reader = tokio::spawn(drain_output(child.stdout.take().ok_or("无法读取命令输出")?, stdout.clone()));
    let mut stderr_reader = tokio::spawn(drain_output(child.stderr.take().ok_or("无法读取命令错误输出")?, stderr.clone()));
    let deadline = tokio::time::Instant::now() + timeout;
    let outcome = tokio::time::timeout_at(deadline, child.wait()).await;
    let (mut timed_out, status) = match outcome {
        Ok(status) => (false, status.map_err(|error| error.to_string())?),
        Err(_) => { kill_group(pid); (true, child.wait().await.map_err(|error| error.to_string())?) }
    };
    if !timed_out {
        match tokio::time::timeout_at(deadline, async {
            let (out, err) = tokio::join!(&mut stdout_reader, &mut stderr_reader);
            out.map_err(|error| error.to_string())??;
            err.map_err(|error| error.to_string())??;
            Ok::<(), String>(())
        }).await {
            Ok(result) => result?,
            Err(_) => { timed_out = true; kill_group(pid); }
        }
    }
    stdout_reader.abort();
    stderr_reader.abort();
    let status_name = if cancelled.load(Ordering::Acquire) { "cancelled" } else if timed_out { "timeout" } else if status.success() { "success" } else { "failed" };
    let stdout = String::from_utf8_lossy(&stdout.lock().expect("输出记录锁已损坏")).into_owned();
    let stderr = String::from_utf8_lossy(&stderr.lock().expect("输出记录锁已损坏")).into_owned();
    Ok(json!({"success": status_name == "success", "code": status.code(), "exitCode": status.code(), "stdout": stdout, "stderr": stderr, "status": status_name, "startTime": start_time, "endTime": Utc::now().to_rfc3339(), "durationMs": started.elapsed().as_millis() as u64}))
}

fn apple_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r"))
}

async fn launch_terminal(command: &str, directory: &Path, terminal: &str) -> Result<Value, String> {
    let started = Instant::now();
    let start_time = Utc::now().to_rfc3339();
    let shell = user_shell();
    let script = shell_script(&shell, command, directory, true)?;
    #[cfg(target_os = "macos")]
    let mut process = {
        if terminal == "kaku" {
            if !Path::new("/Applications/Kaku.app").is_dir() { return Err("/Applications/Kaku.app 不存在".into()); }
            let mut process = Command::new("open");
            process.args(["-n", "-a", "Kaku", "--args", "start", "--always-new-process", "--cwd"]).arg(directory).args(["--", &shell, "-l", "-c", &script]);
            process
        } else {
            let mut process = Command::new("osascript");
            process.args(["-e", &format!("tell application \"Terminal\"\nactivate\ndo script {}\nend tell", apple_quote(&script))]);
            process
        }
    };
    #[cfg(target_os = "linux")]
    let mut process = {
        let _ = terminal;
        let paths = std::env::var_os("PATH").ok_or("PATH 环境变量未设置")?;
        let terminal = ["gnome-terminal", "xterm", "xfce4-terminal", "konsole"].into_iter().find_map(|name| std::env::split_paths(&paths).map(|directory| directory.join(name)).find(|path| path.is_file()).map(|path| (name, path))).ok_or("未找到终端应用")?;
        let mut process = Command::new(terminal.1);
        if terminal.0 == "xfce4-terminal" {
            process.arg("--command").arg(format!("{} -l -c {}", shell_quote(&shell), shell_quote(&script)));
        } else { process.arg(if terminal.0 == "gnome-terminal" { "--" } else { "-e" }).args([&shell, "-l", "-c", &script]); }
        process
    };
    #[cfg(windows)]
    let mut process = {
        let _ = terminal;
        let mut process = Command::new("cmd.exe");
        process.args(["/D", "/S", "/K"]).raw_arg(format!("\"{script}\"")).creation_flags(0x00000010);
        process
    };
    #[cfg(windows)]
    {
        process.current_dir(directory).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
        let child = process.spawn().map_err(|error| error.to_string())?;
        return Ok(json!({"success":true, "code":0, "exitCode":0, "stdout":"", "stderr":"", "status":"success", "processId":child.id(), "startTime":start_time, "endTime":Utc::now().to_rfc3339(), "durationMs":started.elapsed().as_millis() as u64}));
    }
    #[cfg(not(windows))]
    {
    process.current_dir(directory).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), process.output()).await.map_err(|_| "终端启动超时".to_string())?.map_err(|error| error.to_string())?;
    let error = String::from_utf8_lossy(&output.stderr).into_owned();
    Ok(json!({"success": output.status.success(), "code": output.status.code(), "exitCode": output.status.code(), "stdout":"", "stderr": error, "status": if output.status.success() { "success" } else { "failed" }, "startTime": start_time, "endTime": Utc::now().to_rfc3339(), "durationMs": started.elapsed().as_millis() as u64}))
    }
}

async fn execute(mut args: Value, app: AppHandle, store: SharedStore, terminal: bool, schedule_id: Option<String>) -> Result<Value, String> {
    let started = Instant::now();
    let start_time = Utc::now().to_rfc3339();
    let key = schedule_id.as_ref().map(|id| format!("schedule:{id}:{}", uuid::Uuid::new_v4())).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let process_key = schedule_id.as_ref().map(|id| format!("schedule:{id}")).unwrap_or_else(|| key.clone());
    let environment = if cfg!(debug_assertions) { "development" } else { "production" };
    let span = tracing::info_span!("command_execution", trace_id = %key, service = "start-everything", env = environment);
    span.in_scope(|| tracing::info!(event = "job_started", trace_id = %key, service = "start-everything", env = environment, status = "running", latency_ms = 0_u64, decision_reason = "execution_requested", scheduled = schedule_id.is_some(), terminal));
    let prepared = (|| -> Result<(PathBuf, String, String, Duration), String> {
        let store = store.lock().map_err(|error| error.to_string())?;
        if let Some(id) = &schedule_id {
            let current = store.schedules.iter().find(|schedule| schedule.get("id").and_then(Value::as_str) == Some(id)).ok_or("定时任务已经删除")?;
            if current.get("enabled").and_then(Value::as_bool) != Some(true) { return Err("定时任务已经禁用".into()); }
            args = resolve_schedule(current, &store.projects)?;
        }
        let path = args.get("projectPath").and_then(Value::as_str).ok_or("缺少项目路径")?;
        let command = args.get("command").and_then(Value::as_str).filter(|command| !command.trim().is_empty()).ok_or("命令不能为空")?;
        if !is_registered_path(&store.projects, path) { return Err("项目路径尚未注册".into()); }
        let directory = if path.is_empty() { app.path().desktop_dir().map_err(|error| error.to_string())? } else { PathBuf::from(path) };
        if !directory.is_dir() { return Err(format!("项目目录不存在：{}", directory.display())); }
        let selected_terminal = store.setting("terminal").as_str().unwrap_or("default").to_string();
        let timeout_minutes = args.get("timeoutMinutes").and_then(Value::as_f64).filter(|minutes| minutes.is_finite() && *minutes > 0.0).unwrap_or(60.0);
        if timeout_minutes > 525_600.0 { return Err("命令超时不能超过一年".into()); }
        let command = normalize_command(command, &directory, terminal);
        Ok((directory, selected_terminal, command, Duration::from_secs_f64(timeout_minutes * 60.0)))
    })();
    let command = prepared.as_ref().map(|(_, _, command, _)| command.clone()).unwrap_or_else(|_| args.get("command").and_then(Value::as_str).unwrap_or("").to_owned());
    let outcome = match prepared {
        Ok((directory, selected_terminal, _, timeout)) => {
            if terminal { launch_terminal(&command, &directory, &selected_terminal).instrument(span.clone()).await }
            else { run_shell_using(&user_shell(), &command, &directory, timeout, &process_key).instrument(span.clone()).await }
        },
        Err(error) => Err(error),
    };
    let result = outcome.unwrap_or_else(|error| json!({"success":false, "code":-1, "exitCode":-1, "status":"error", "error":error, "stdout":"", "stderr":error, "startTime":start_time, "endTime":Utc::now().to_rfc3339(), "durationMs":started.elapsed().as_millis() as u64}));
    let status = result["status"].as_str().unwrap_or("error");
    let latency_ms = result["durationMs"].as_u64().unwrap_or(0);
    span.in_scope(|| {
        if status == "success" {
            tracing::info!(event = "job_succeeded", trace_id = %key, service = "start-everything", env = environment, status, latency_ms, decision_reason = "command_completed", exit_code = ?result["exitCode"]);
        } else {
            let decision_reason = match status { "timeout" => "process_timeout", "cancelled" => "execution_cancelled", "failed" => "non_zero_exit_code", _ => "execution_error" };
            tracing::error!(event = "job_failed", trace_id = %key, service = "start-everything", env = environment, status, latency_ms, decision_reason, exit_code = ?result["exitCode"], error = %result["stderr"]);
        }
    });
    let mut log = result.clone();
    let log_object = log.as_object_mut().ok_or("命令结果格式错误")?;
    log_object.insert("scheduleId".into(), json!(schedule_id));
    for name in ["projectName", "commandName"] { log_object.insert(name.into(), args.get(name).cloned().unwrap_or(json!(""))); }
    log_object.insert("command".into(), json!(command));
    log_object.insert("trigger".into(), json!(if schedule_id.is_some() { "scheduled" } else { "manual" }));
    log_object.insert("mode".into(), json!(if terminal { "terminal" } else { "silent" }));
    {
        let mut store = store.lock().map_err(|error| error.to_string())?;
        store.add_log(log)?;
        if let Some(id) = &schedule_id {
            if let Some(schedule) = store.schedules.iter_mut().find(|schedule| schedule.get("id").and_then(Value::as_str) == Some(id)) {
                schedule["lastRunAt"] = result["endTime"].clone();
                schedule["lastExitCode"] = result["exitCode"].clone();
                store.save_schedules()?;
            }
        }
    }
    let payload = json!({"scheduleId":schedule_id, "projectName":args["projectName"], "commandName":args["commandName"], "command":command, "status":result["status"], "durationMs":result["durationMs"]});
    if schedule_id.is_some() || !terminal {
        app.emit(if schedule_id.is_some() { "schedule-executed" } else { "silent-execution-complete" }, payload).map_err(|error| error.to_string())?;
    }
    if schedule_id.is_some() && args.get("notifyOnComplete").and_then(Value::as_bool) == Some(true) {
        let title = format!("定时任务：{}", args["projectName"].as_str().unwrap_or(""));
        let body = format!("{}：{}", args["commandName"].as_str().unwrap_or(&command), result["status"].as_str().unwrap_or("error"));
        if let Err(error) = app.notification().builder().title(title).body(body).show() { tracing::error!(event = "error_occurred", decision_reason = "notification_failed", trace_id = %key, error = %error); }
    }
    Ok(result)
}

pub async fn dispatch(action: &str, args: Value, app: AppHandle, store: SharedStore) -> Result<Value, String> {
    match action {
        "execute-command" => execute(args, app, store, true, None).await,
        "execute-command-silent" => execute(args, app, store, false, None).await,
        _ => Err(format!("不支持的执行操作：{action}")),
    }
}

pub fn start_scheduler(app: AppHandle, store: SharedStore) -> Result<(), String> {
    if std::env::var("START_EVERYTHING_DISABLE_SCHEDULER").as_deref() == Ok("1") { return Ok(()); }
    STOPPING.store(false, Ordering::Release);
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut expressions: HashMap<String, (String, Cron)> = HashMap::new();
        let mut last_runs: HashMap<String, i64> = HashMap::new();
        let mut invalid: HashMap<String, Value> = HashMap::new();
        let running = Arc::new(Mutex::new(HashSet::<String>::new()));
        while !STOPPING.load(Ordering::Acquire) {
            interval.tick().await;
            let (schedules, projects) = {
                let store = store.lock().expect("存储锁已损坏");
                (store.schedules.clone(), store.projects.clone())
            };
            let active: HashSet<String> = schedules.iter().filter(|schedule| schedule.get("enabled").and_then(Value::as_bool) == Some(true)).filter_map(|schedule| schedule.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
            invalid.retain(|id, _| active.contains(id));
            let mut enabled = HashSet::new();
            let mut valid_schedules = Vec::new();
            for schedule in schedules.into_iter().filter(|schedule| schedule.get("enabled").and_then(Value::as_bool) == Some(true)) {
                let Some(id) = schedule.get("id").and_then(Value::as_str) else { continue; };
                match resolve_schedule(&schedule, &projects) {
                    Ok(resolved) => {
                        invalid.remove(id);
                        enabled.insert(id.to_owned());
                        valid_schedules.push(resolved);
                    },
                    Err(error) => {
                        if remember_invalid_schedule(&mut invalid, id, &schedule) {
                            let trace_id = uuid::Uuid::new_v4().to_string();
                            let environment = if cfg!(debug_assertions) { "development" } else { "production" };
                            tracing::error!(event = "error_occurred", decision_reason = "schedule_reference_invalid", trace_id = %trace_id, service = "start-everything", env = environment, status = "error", latency_ms = 0_u64, schedule_id = %id, project_id = ?schedule.get("projectId"), error = %error);
                            tracing::error!(event = "job_failed", decision_reason = "schedule_reference_invalid", trace_id = %trace_id, service = "start-everything", env = environment, status = "error", latency_ms = 0_u64, schedule_id = %id, error = %error);
                            if let Err(error) = app.emit("schedule-executed", json!({"scheduleId":id,"status":"error","error":error})) {
                                tracing::error!(event = "error_occurred", decision_reason = "schedule_event_failed", trace_id = %trace_id, error = %error);
                            }
                        }
                    },
                }
            }
            cleanup_disabled_processes(&enabled);
            expressions.retain(|id, _| enabled.contains(id));
            last_runs.retain(|id, _| enabled.contains(id));
            let now = Local::now();
            for schedule in valid_schedules {
                let Some(id) = schedule.get("id").and_then(Value::as_str).map(str::to_owned) else { continue; };
                let Some(expression) = schedule.get("cronExpression").and_then(Value::as_str) else { continue; };
                if !expressions.get(&id).is_some_and(|(cached, _)| cached == expression) {
                    match parse_cron(expression) {
                        Ok(cron) => { expressions.insert(id.clone(), (expression.into(), cron)); }
                        Err(error) => { tracing::error!(event = "error_occurred", decision_reason = "schedule_invalid", schedule_id = %id, error = %error); continue; }
                    }
                }
                let matches = expressions.get(&id).expect("计划表达式缓存不存在").1.is_time_matching(&now);
                match matches {
                    Ok(true) => {},
                    Ok(false) => continue,
                    Err(error) => { tracing::error!(event = "error_occurred", decision_reason = "schedule_match_failed", schedule_id = %id, error = %error); continue; }
                }
                if last_runs.get(&id) == Some(&now.timestamp()) { continue; }
                last_runs.insert(id.clone(), now.timestamp());
                if !running.lock().expect("定时任务记录锁已损坏").insert(id.clone()) { continue; }
                let app = app.clone();
                let store = store.clone();
                let running = running.clone();
                tauri::async_runtime::spawn(async move {
                    let result = execute(schedule, app.clone(), store, false, Some(id.clone())).await;
                    running.lock().expect("定时任务记录锁已损坏").remove(&id);
                    if let Err(error) = result {
                        tracing::error!(event = "error_occurred", decision_reason = "schedule_execution_failed", schedule_id = %id, error = %error);
                        let _ = app.emit("schedule-executed", json!({"scheduleId":id,"status":"error","error":error}));
                    }
                });
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use serde_json::json;
    use std::{path::PathBuf, time::Duration};

    fn test_directory() -> PathBuf {
        let directory = std::env::current_dir()
            .unwrap()
            .join(".work")
            .join("execution-tests")
            .join(format!("中文 项目 ' {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn cron_accepts_node_lists_ranges_names_and_optional_seconds() {
        for expression in ["*/5 * * * *", "0,30 9-17 * JAN,MAR MON-FRI", "0 9 * January,March Monday-Friday", "*/2 * * * * *", "0 0 * * 0,7"] {
            validate_cron(expression).unwrap();
        }
        for expression in ["", "* * * *", "61 * * * * *", "0 25 * * *", "* * * * * * *"] {
            assert!(validate_cron(expression).is_err(), "{expression}");
        }
    }

    #[test]
    fn cron_matches_node_weekdays_and_requires_both_date_conditions() {
        let monday = Utc.with_ymd_and_hms(2026, 10, 19, 9, 30, 0).unwrap();
        assert!(parse_cron("30 9 * * MON-FRI").unwrap().is_time_matching(&monday).unwrap());
        assert!(!parse_cron("30 9 20 * MON").unwrap().is_time_matching(&monday).unwrap());
        let sunday = Utc.with_ymd_and_hms(2026, 10, 18, 0, 0, 0).unwrap();
        for expression in ["0 0 * * 0", "0 0 * * 7", "0 0 * * SUN"] {
            assert!(parse_cron(expression).unwrap().is_time_matching(&sunday).unwrap());
        }
    }

    #[test]
    fn registered_paths_include_subproject_and_command_paths() {
        let projects = vec![json!({"path":"/main", "commands":[{"path":"/command"}], "subprojects":[{"path":"/sub", "commands":[{"path":"/sub-command"}]}]})];
        for path in ["/main", "/command", "/sub", "/sub-command"] {
            assert!(is_registered_path(&projects, path));
        }
        assert!(!is_registered_path(&projects, "/unregistered"));
    }

    #[test]
    fn scheduled_command_uses_current_registered_project_data() {
        let projects = vec![json!({"id":"current-project", "name":"Current", "path":"/current", "commands":["printf current"], "command_names":["Current command"]})];
        let schedule = json!({"id":"valid", "projectId":"current-project", "commandIndex":0, "projectName":"Old", "projectPath":"/old", "command":"printf stale", "commandName":"Old command", "enabled":true});
        let resolved = resolve_schedule(&schedule, &projects).unwrap();
        assert_eq!(resolved["projectPath"], "/current");
        assert_eq!(resolved["projectName"], "Current");
        assert_eq!(resolved["command"], "printf current");
        assert_eq!(resolved["commandName"], "Current command");
        assert_eq!(schedule["command"], "printf stale");
    }

    #[test]
    fn orphan_and_missing_command_schedules_cannot_use_matching_paths() {
        let projects = vec![json!({"id":"other-project", "name":"Other", "path":"/shared", "commands":["printf other"]})];
        for schedule in [
            json!({"projectId":"missing-project", "commandIndex":0, "projectPath":"/shared", "command":"printf stale"}),
            json!({"projectId":"other-project", "commandIndex":1, "projectPath":"/shared", "command":"printf stale"}),
            json!({"projectId":"other-project", "commandIndex":-1}),
            json!({"projectId":"other-project", "commandIndex":"0"}),
        ] { assert!(resolve_schedule(&schedule, &projects).is_err()); }
    }

    #[test]
    fn invalid_schedule_reports_only_once_until_its_content_changes() {
        let mut invalid = HashMap::new();
        let schedule = json!({"id":"orphan", "projectId":"missing", "commandIndex":0});
        assert!(remember_invalid_schedule(&mut invalid, "orphan", &schedule));
        assert!(!remember_invalid_schedule(&mut invalid, "orphan", &schedule));
        let changed = json!({"id":"orphan", "projectId":"missing", "commandIndex":1});
        assert!(remember_invalid_schedule(&mut invalid, "orphan", &changed));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn silent_execution_preserves_unicode_quoted_path_and_output() {
        let directory = test_directory();
        let result = run_shell_using("/bin/sh", "printf 'hello 中文'; printf 'diagnostic' >&2; pwd", &directory, Duration::from_secs(5), "test-output").await.unwrap();
        assert_eq!(result["status"], "success");
        assert_eq!(result["exitCode"], 0);
        assert!(result["stdout"].as_str().unwrap().starts_with("hello 中文"));
        assert!(result["stdout"].as_str().unwrap().contains(directory.to_str().unwrap()));
        assert_eq!(result["stderr"], "diagnostic");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn silent_execution_reports_real_nonzero_exit() {
        let directory = test_directory();
        let result = run_shell_using("/bin/sh", "printf 'failure' >&2; exit 7", &directory, Duration::from_secs(5), "test-nonzero").await.unwrap();
        assert_eq!(result["status"], "failed");
        assert_eq!(result["exitCode"], 7);
        assert_eq!(result["stderr"], "failure");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn silent_execution_drains_output_after_capture_limit() {
        let directory = test_directory();
        let result = run_shell_using("/bin/sh", "awk 'BEGIN { for(i=0;i<2000000;i++) printf \"x\"; }'", &directory, Duration::from_secs(5), "test-output-limit").await.unwrap();
        assert_eq!(result["status"], "success");
        assert_eq!(result["stdout"].as_str().unwrap().len(), 10 * 1024);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_terminates_the_entire_process_group() {
        let directory = test_directory();
        let result = run_shell_using("/bin/sh", "(sleep 1; printf 'alive' > descendant-marker) & wait", &directory, Duration::from_millis(150), "test-timeout").await.unwrap();
        assert_eq!(result["status"], "timeout");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!directory.join("descendant-marker").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    async fn wait_for_process(key: &str) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if processes().lock().unwrap().contains_key(key) { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn enabled_schedule_survives_scheduler_cleanup() {
        let directory = test_directory();
        let run_directory = directory.clone();
        let key = "schedule:enabled-regression";
        let command = tokio::spawn(async move { run_shell_using("/bin/sh", "sleep 0.3; printf completed", &run_directory, Duration::from_secs(5), key).await.unwrap() });
        wait_for_process(key).await;
        cleanup_disabled_processes(&HashSet::from(["enabled-regression".to_string(), "disabled-regression".to_string()]));
        let result = command.await.unwrap();
        assert_eq!(result["status"], "success");
        assert_eq!(result["stdout"], "completed");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disabled_schedule_terminates_running_descendants() {
        let directory = test_directory();
        let run_directory = directory.clone();
        let key = "schedule:disabled-regression";
        let command = tokio::spawn(async move { run_shell_using("/bin/sh", "(sleep 1; printf alive > disabled-marker) & wait", &run_directory, Duration::from_secs(5), key).await.unwrap() });
        wait_for_process(key).await;
        cleanup_disabled_processes(&HashSet::from(["enabled-regression".to_string()]));
        let result = command.await.unwrap();
        assert_eq!(result["status"], "cancelled");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!directory.join("disabled-marker").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
