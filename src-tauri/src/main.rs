#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use start_everything::{execution, store::{self, SharedStore, Store}};
use std::{fs::{self, OpenOptions}, path::PathBuf, sync::{Arc, Mutex, OnceLock}, time::Instant};
use tauri::{Manager, menu::{Menu, MenuItem}, tray::TrayIconBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

mod platform;
static STARTED: OnceLock<Instant> = OnceLock::new();

fn store_action(action: &str) -> bool {
    matches!(action, "get-projects" | "add-project" | "update-project" | "delete-project" | "reorder-projects" | "toggle-pin" | "update-command" | "export-projects" | "import-projects" | "get-locale" | "set-locale" | "get-terminal" | "set-terminal" | "get-search-history" | "save-search-history" | "get-schedules" | "get-schedule-for-command" | "add-schedule" | "update-schedule" | "delete-schedule" | "toggle-schedule" | "validate-cron" | "get-schedule-logs" | "clear-schedule-logs" | "reset-data")
}

#[tauri::command]
async fn api(app: tauri::AppHandle, state: tauri::State<'_, SharedStore>, action: String, args: Value) -> Result<Value, String> {
    let trace_id = uuid::Uuid::new_v4().to_string();
    let begin = Instant::now();
    tracing::info!(event="request_received", %trace_id, service="start-everything", env="desktop", status="running", latency_ms=0, decision_reason="native_command", %action);
    let store = state.inner().clone();
    let result = match action.as_str() {
        "frontend-ready" => {
            let startup_ms = STARTED.get().unwrap().elapsed().as_millis() as u64;
            tracing::info!(event="job_succeeded", %trace_id, service="start-everything", env="desktop", status="success", latency_ms=startup_ms, decision_reason="frontend_ready", startup_ms, project_count=args["projectCount"].as_u64().unwrap_or(0));
            #[cfg(debug_assertions)]
            if let Ok(path) = std::env::var("START_EVERYTHING_TEST_SCRIPT") {
                let script = fs::read_to_string(path).map_err(|e| e.to_string())?;
                app.get_webview_window("main").ok_or("Main window missing")?.eval(script).map_err(|e| e.to_string())?;
            }
            Ok(json!({"success":true,"startupMs":startup_ms}))
        }
        "frontend-log" => {
            if args["level"] == "error" {
                tracing::error!(event="error_occurred", %trace_id, service="start-everything", env="desktop", status="failed", latency_ms=0, decision_reason="frontend_error", details=%args);
            } else {
                tracing::info!(event="job_succeeded", %trace_id, service="start-everything", env="desktop", status="success", latency_ms=0, decision_reason="frontend_event", details=%args);
            }
            Ok(json!({"success":true}))
        }
        #[cfg(debug_assertions)]
        "test-report" => {
            let report = std::env::var("START_EVERYTHING_TEST_REPORT").map_err(|e| e.to_string())?;
            start_everything::store::atomic_write(&PathBuf::from(report), &serde_json::to_vec_pretty(&args).map_err(|e| e.to_string())?)?;
            Ok(json!({"success":true}))
        }
        "reset-data" => {
            {
                let mut data = store.lock().map_err(|e| e.to_string())?;
                data.handle("reset-data", &args)?;
            }
            app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
            Ok(json!({"success":true}))
        }
        action if store_action(action) => {
            let mut data = store.lock().map_err(|e| e.to_string())?;
            data.handle(action, &args)
        }
        "execute-command" | "execute-command-silent" => execution::dispatch(&action, args, app.clone(), store).await,
        _ => platform::dispatch(&action, args, app.clone(), store).await,
    };
    let latency_ms = begin.elapsed().as_millis() as u64;
    match &result {
        Ok(_) => tracing::info!(event="request_finished", %trace_id, service="start-everything", env="desktop", status="success", latency_ms, decision_reason="native_command_completed", %action),
        Err(error) => tracing::error!(event="request_failed", %trace_id, service="start-everything", env="desktop", status="failed", latency_ms, decision_reason="native_command_failed", %action, %error),
    }
    result
}

fn legacy_data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = app.path().home_dir()?;
    #[cfg(target_os="macos")]
    { Ok(home.join("Library/Application Support/start-everything/data")) }
    #[cfg(target_os="windows")]
    { Ok(app.path().config_dir()?.join("start-everything/data")) }
    #[cfg(target_os="linux")]
    { let _ = home; Ok(app.path().config_dir()?.join("start-everything/data")) }
}

fn show_window(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    #[cfg(target_os="macos")]
    app.show()?;
    if let Some(window) = app.get_webview_window("main") { window.unminimize()?; window.show()?; window.set_focus()?; }
    Ok(())
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_override = std::env::var_os("START_EVERYTHING_DATA_DIR").filter(|value| !value.is_empty());
    let base = app.path().app_data_dir()?;
    let pointer = fs::read_to_string(platform::data_pointer_file(&base)).ok();
    let root = platform::resolve_data_dir(&base, data_override.as_ref().and_then(|value| value.to_str()), pointer.as_deref());
    let log_dir = root.parent().ok_or("Missing data parent")?.join("logs");
    fs::create_dir_all(&log_dir)?;
    let log_path = log_dir.join("app.jsonl");
    if fs::metadata(&log_path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        fs::rename(&log_path, log_dir.join("app.previous.jsonl"))?;
    }
    let file = OpenOptions::new().create(true).append(true).open(&log_path)?;
    tracing_subscriber::fmt().json().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).with_writer(Mutex::new(file)).try_init().map_err(|e| std::io::Error::other(e.to_string()))?;
    tracing::info!(event="system_started", trace_id=%uuid::Uuid::new_v4(), service="start-everything", env="desktop", status="running", latency_ms=STARTED.get().unwrap().elapsed().as_millis() as u64, decision_reason="application_setup", version=env!("CARGO_PKG_VERSION"), data_dir=%root.display());
    let legacy = legacy_data_dir(app)?;
    let source = if data_override.is_some() { None } else { Some(legacy.as_path()) };
    let store = Arc::new(Mutex::new(Store::open(root, source)?));
    app.manage(store.clone());
    if let Err(error) = platform::restore_shortcut(app.handle(), &store) {
        tracing::error!(event="error_occurred", trace_id=%uuid::Uuid::new_v4(), status="failed", decision_reason="shortcut_restore_failed", %error);
    }
    let show = MenuItem::with_id(app, "show", "START EVERYTHING", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit / 退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("START EVERYTHING").on_menu_event(|app, event| {
        match event.id.as_ref() {
            "show" => { if let Err(error) = show_window(app) { tracing::error!(event="error_occurred", %error); } }
            "quit" => app.exit(0),
            _ => {}
        }
    });
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.build(app)?;
    execution::start_scheduler(app.handle().clone(), store)?;
    Ok(())
}

fn main() {
    STARTED.set(Instant::now()).unwrap();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![api])
        .setup(|app| {
            if let Err(error) = setup(app) {
                let details = format!("Initialization failed\n{error:#}\n\nData files have been preserved.");
                tracing::error!(event="error_occurred", trace_id=%uuid::Uuid::new_v4(), status="failed", decision_reason="initialization_failed", error=%details);
                let handle = app.handle().clone();
                app.dialog().message(&details).title("START EVERYTHING").show(move |_| handle.exit(1));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() { tracing::error!(event="error_occurred", %error); }
            }
        });
    let app = builder.build(tauri::generate_context!()).expect("START EVERYTHING initialization failed");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        tauri::RunEvent::Exit => {
            execution::shutdown_execution();
            tracing::info!(event="system_stopped", trace_id=%uuid::Uuid::new_v4(), service="start-everything", env="desktop", status="success", latency_ms=0, decision_reason="application_exit");
        }
        #[cfg(target_os="macos")]
        tauri::RunEvent::Reopen { .. } => { if let Err(error) = show_window(app) { tracing::error!(event="error_occurred", %error); } }
        _ => {}
    });
}
