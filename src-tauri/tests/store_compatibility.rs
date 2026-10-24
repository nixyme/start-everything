use serde_json::{json, Value};

#[test]
fn legacy_orphan_schedules_survive_export_and_import() {
    let directory = workspace_directory();
    fs::write(directory.path().join("projects.json"), br#"[{"id":"p","name":"project","commands":["pwd"]}]"#).unwrap();
    fs::write(directory.path().join("schedules.json"), br#"[{"id":"orphan","projectId":"deleted","projectName":"deleted","commandIndex":0,"command":"pwd","cronExpression":"0 9 * * *","enabled":false}]"#).unwrap();
    let mut store = Store::open(directory.path().to_path_buf(), None).unwrap();
    let expected = store.schedules.clone();
    let exported = store.handle("export-projects", &json!({})).unwrap();
    store.handle("import-projects", &json!({"data":exported["data"]})).unwrap();
    assert_eq!(store.schedules, expected);
}
use start_everything::store::Store;
use std::{fs, path::PathBuf};

fn workspace_directory() -> tempfile::TempDir {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.work/store-compatibility-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

fn seeded_store() -> (tempfile::TempDir, Store, String, String) {
    let directory = workspace_directory();
    let mut store = Store::open(directory.path().join("data"), None).unwrap();
    let result = store.handle("add-project", &json!({"project":{"name":"兼容测试项目","commands":["pwd"],"pinned":true,"order":7,"subprojects":[{"name":"子项目","items":[{"type":"folder","path":"/Applications"}]}]}})).unwrap();
    let project_id = result["data"]["id"].as_str().unwrap().to_owned();
    let result = store.handle("add-schedule", &json!({"schedule":{"projectId":project_id,"commandIndex":0,"command":"pwd","projectPath":"","projectName":"兼容测试项目","commandName":"","cronExpression":"0 9 * * *","enabled":false,"timeoutMinutes":60}})).unwrap();
    let schedule_id = result["data"]["id"].as_str().unwrap().to_owned();
    (directory, store, project_id, schedule_id)
}

#[test]
fn old_import_without_optional_fields_preserves_existing_group_and_pin() {
    let (_directory, mut store, project_id, _) = seeded_store();
    let before = store.projects[0].clone();
    store.handle("import-projects", &json!({"data":{"version":"1.0","projects":[{"name":"兼容测试项目","default_command":"ls"}]}})).unwrap();
    assert_eq!(store.projects[0]["id"], project_id);
    assert_eq!(store.projects[0]["pinned"], before["pinned"]);
    assert_eq!(store.projects[0]["subprojects"], before["subprojects"]);
    assert_eq!(store.projects[0]["order"], before["order"]);
    assert_eq!(store.projects[0]["commands"], json!(["ls"]));
}

#[test]
fn schedule_write_failure_preserves_project_file_and_all_in_memory_state() {
    let (_directory, mut store, project_id, _) = seeded_store();
    let before_projects = store.projects.clone();
    let before_schedules = store.schedules.clone();
    let before_bytes = fs::read(store.data_dir.join("projects.json")).unwrap();
    let schedules_file = store.data_dir.join("schedules.json");
    fs::remove_file(&schedules_file).unwrap();
    fs::create_dir(&schedules_file).unwrap();
    let result = store.handle("update-project", &json!({"id":project_id,"updates":{"commands":["ls"]}}));
    assert!(result.is_err());
    assert_eq!(store.projects, before_projects);
    assert_eq!(store.schedules, before_schedules);
    assert_eq!(fs::read(store.data_dir.join("projects.json")).unwrap(), before_bytes);
}

#[test]
fn delete_project_removes_associated_schedule_logs() {
    let (_directory, mut store, project_id, schedule_id) = seeded_store();
    store.add_log(json!({"scheduleId":schedule_id,"projectId":project_id,"exitCode":0})).unwrap();
    store.handle("delete-project", &json!({"id":project_id})).unwrap();
    assert!(store.schedules.is_empty());
    assert!(store.logs.is_empty());
    let persisted: Value = serde_json::from_slice(&fs::read(store.data_dir.join("schedule-logs.json")).unwrap()).unwrap();
    assert_eq!(persisted, json!([]));
}

#[test]
fn invalid_import_schedule_index_is_rejected_without_modifying_data() {
    let (_directory, mut store, _, _) = seeded_store();
    let before_projects = store.projects.clone();
    let before_schedules = store.schedules.clone();
    let result = store.handle("import-projects", &json!({"data":{"projects":[{"id":"incoming","name":"兼容测试项目","commands":["pwd"]}],"schedules":[{"id":"invalid","projectId":"incoming","commandIndex":999,"cronExpression":"0 9 * * *","enabled":true,"command":"wrong"}]}}));
    assert!(result.is_err());
    assert_eq!(store.projects, before_projects);
    assert_eq!(store.schedules, before_schedules);
}

#[test]
fn import_updates_retained_schedule_to_the_imported_command() {
    let (_directory, mut store, _, _) = seeded_store();
    store.handle("import-projects", &json!({"data":{"projects":[{"name":"兼容测试项目","commands":["ls"],"command_names":["新命令"],"path":"/Applications"}]}})).unwrap();
    assert_eq!(store.schedules.len(), 1);
    assert_eq!(store.schedules[0]["command"], "ls");
    assert_eq!(store.schedules[0]["projectPath"], "/Applications");
    assert_eq!(store.schedules[0]["commandName"], "新命令");
}

#[test]
fn import_drops_retained_schedule_for_a_removed_command() {
    let (_directory, mut store, _, _) = seeded_store();
    store.handle("import-projects", &json!({"data":{"projects":[{"name":"兼容测试项目","commands":[]}]}})).unwrap();
    assert!(store.schedules.is_empty());
}

#[test]
fn rejects_malformed_subproject_entries_without_panicking_or_modifying_data() {
    let (_directory, mut store, _, _) = seeded_store();
    let before = store.projects.clone();
    let result = store.handle("import-projects", &json!({"data":{"projects":[{"name":"兼容测试项目","commands":["pwd"],"subprojects":["invalid"]}]}}));
    assert!(result.is_err());
    assert_eq!(store.projects, before);
}

#[test]
fn reset_data_clears_saved_preferences() {
    let (_directory, mut store, _, _) = seeded_store();
    store.set_setting("searchHistory", json!(["test"])).unwrap();
    store.set_setting("lastExportPath", json!("/nonexistent/export.json")).unwrap();
    store.handle("reset-data", &json!({})).unwrap();
    assert!(store.setting("searchHistory").is_null());
    assert!(store.setting("lastExportPath").is_null());
    drop(store);
}

#[test]
fn reads_and_reexports_legacy_files_with_unknown_fields_without_copying_personal_data() {
    let directory = workspace_directory();
    let project = json!({"id":"legacy","name":"文件兼容项目","default_command":"pwd","future":{"number":1},"command_modes":["silent"],"subprojects":[{"name":"子项目","items":[]}]});
    fs::write(directory.path().join("projects.json"), serde_json::to_vec(&vec![project.clone()]).unwrap()).unwrap();
    fs::write(directory.path().join("settings.json"), br#"{"locale":"zh","terminal":"kaku"}"#).unwrap();
    fs::write(directory.path().join("schedules.json"), b"[]").unwrap();
    fs::write(directory.path().join("schedule-logs.json"), b"[]").unwrap();
    let mut store = Store::open(directory.path().to_path_buf(), None).unwrap();
    let exported = store.handle("export-projects", &json!({})).unwrap();
    assert_eq!(exported["data"]["version"], "1.1");
    assert_eq!(exported["data"]["projects"][0]["future"], project["future"]);
    assert_eq!(exported["data"]["projects"][0]["subprojects"], project["subprojects"]);
    // 启动迁移为旧项目补齐 Codex 命令，导出随之携带
    assert_eq!(exported["data"]["projects"][0]["command_modes"], json!(["silent", "terminal"]));
    assert_eq!(exported["data"]["projects"][0]["commands"], json!(["pwd", "codex --dangerously-bypass-approvals-and-sandbox"]));
    assert_eq!(store.setting("terminal"), "kaku");
}
