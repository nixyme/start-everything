use fs2::FileExt;
use serde_json::{json, Map, Value};
use std::{collections::{HashMap, HashSet}, fs::{self, File, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use uuid::Uuid;

pub type SharedStore = Arc<Mutex<Store>>;

pub struct Store {
    pub data_dir: PathBuf,
    pub projects: Vec<Value>,
    pub schedules: Vec<Value>,
    pub logs: Vec<Value>,
    pub settings: Map<String, Value>,
    _lock: File,
}

fn read_json(path: &Path, default: Value) -> Result<Value, String> {
    if !path.exists() { return Ok(default); }
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing destination directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    atomic_write(path, &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
}

fn array(value: Value, label: &str) -> Result<Vec<Value>, String> {
    value.as_array().cloned().ok_or_else(|| format!("{label} must be an array"))
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing string field: {key}"))
}

fn normalize_project(mut project: Value, index: usize) -> Result<Value, String> {
    let object = project.as_object_mut().ok_or("Project must be an object")?;
    let name = object.get("name").and_then(Value::as_str).ok_or("Project name must be a string")?;
    if name.trim().is_empty() { return Err("Project name is required".into()); }
    object.entry("id").or_insert_with(|| json!(Uuid::new_v4().to_string()));
    if object["id"].as_str().is_none_or(str::is_empty) { return Err("Project id must be a nonempty string".into()); }
    if !object.contains_key("commands") {
        let default = object.get("default_command").and_then(Value::as_str).unwrap_or("");
        object.insert("commands".into(), if default.is_empty() { json!([]) } else { json!([default]) });
    }
    if !object["commands"].is_array() || object["commands"].as_array().unwrap().iter().any(|v| !v.is_string()) {
        return Err("Project commands must be an array of strings".into());
    }
    let first = object["commands"].as_array().unwrap().first().cloned().unwrap_or(json!(""));
    object.entry("default_command").or_insert(first);
    for key in ["path", "result_path"] { object.entry(key).or_insert(json!("")); }
    for key in ["command_names", "command_modes", "urls", "folders", "files", "subprojects"] {
        object.entry(key).or_insert(json!([]));
        if !object[key].is_array() { return Err(format!("{key} must be an array")); }
    }
    for key in ["command_names", "command_modes"] {
        if object[key].as_array().unwrap().iter().any(|v| !v.is_string()) { return Err(format!("{key} must contain strings")); }
    }
    for key in ["urls", "folders", "files"] {
        for entry in object[key].as_array().unwrap() {
            let entry = entry.as_object().ok_or_else(|| format!("{key} must contain objects"))?;
            for field in ["name", "url", "path"] {
                if entry.get(field).is_some_and(|v| !v.is_string()) { return Err(format!("{key}.{field} must be a string")); }
            }
        }
    }
    for group in object["subprojects"].as_array().unwrap() {
        let group = group.as_object().ok_or("subprojects must contain objects")?;
        if let Some(items) = group.get("items") {
            let items = items.as_array().ok_or("Subproject items must be an array")?;
            for item in items {
                let item = item.as_object().ok_or("Subproject items must contain objects")?;
                for key in ["name", "type", "path", "url"] {
                    if item.get(key).is_some_and(|v| !v.is_string()) { return Err(format!("Subproject item {key} must be a string")); }
                }
            }
        }
    }
    for key in ["path", "result_path", "default_command"] {
        if !object[key].is_string() { return Err(format!("{key} must be a string")); }
    }
    object.entry("order").or_insert(json!(index));
    object.entry("pinned").or_insert(json!(false));
    Ok(project)
}

fn validate_projects(projects: Vec<Value>) -> Result<Vec<Value>, String> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    projects.into_iter().enumerate().map(|(index, project)| {
        let project = normalize_project(project, index)?;
        if !ids.insert(project["id"].as_str().unwrap().to_owned()) { return Err("Duplicate project id".into()); }
        if !names.insert(project["name"].as_str().unwrap().to_owned()) { return Err("Duplicate project name".into()); }
        Ok(project)
    }).collect()
}

fn normalize_urls(project: &mut Value) {
    fn item(item: &mut Value) {
        if let Some(url) = item.get_mut("url") {
            if let Some(text) = url.as_str() {
                let trimmed = text.trim();
                if !trimmed.is_empty() && !trimmed.contains("://") {
                    *url = json!(format!("https://{trimmed}"));
                }
            }
        }
    }
    if let Some(urls) = project["urls"].as_array_mut() { urls.iter_mut().for_each(item); }
    if let Some(groups) = project["subprojects"].as_array_mut() {
        for group in groups {
            if let Some(items) = group["items"].as_array_mut() {
                for entry in items { if entry["type"] == "url" { item(entry); } }
            }
        }
    }
}

const CODEX_COMMAND: &str = "codex --dangerously-bypass-approvals-and-sandbox";

// 首个词为 codex 才算已有 Codex 命令，避免把 codexcli 等前缀相近的命令误判为已存在。
fn is_codex_command(command: &str) -> bool {
    command.split_whitespace().next() == Some("codex")
}

// 给缺少 Codex 命令的项目在末尾追加一条，末尾插入不影响计划里已有的 commandIndex。
fn ensure_codex_command(project: &mut Value) -> bool {
    let Some(commands) = project.get_mut("commands").and_then(Value::as_array_mut) else { return false; };
    if commands.iter().any(|c| c.as_str().is_some_and(is_codex_command)) { return false; }
    commands.push(json!(CODEX_COMMAND));
    let length = commands.len();
    if let Some(names) = project.get_mut("command_names").and_then(Value::as_array_mut) {
        while names.len() < length { names.push(json!("")); }
    }
    if let Some(modes) = project.get_mut("command_modes").and_then(Value::as_array_mut) {
        while modes.len() < length { modes.push(json!("terminal")); }
    }
    true
}

impl Store {
    pub fn open(data_dir: PathBuf, legacy: Option<&Path>) -> Result<Self, String> {
        if !data_dir.exists() {
            if let Some(source) = legacy.filter(|p| p.join("projects.json").exists()) {
                // 完整验证后再复制，避免损坏的输入留下半份迁移数据。
                validate_projects(array(read_json(&source.join("projects.json"), json!([]))?, "projects")?)?;
                for (name, default, is_array) in [("settings.json", json!({}), false), ("schedules.json", json!([]), true), ("schedule-logs.json", json!([]), true)] {
                    let value = read_json(&source.join(name), default)?;
                    if (is_array && !value.is_array()) || (!is_array && !value.is_object()) { return Err(format!("Invalid {name}")); }
                }
                let parent = data_dir.parent().ok_or("Missing data directory parent")?;
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                let staging = tempfile::Builder::new().prefix("migration-").tempdir_in(parent).map_err(|e| e.to_string())?;
                for name in ["projects.json", "projects_backup.json", "settings.json", "schedules.json", "schedule-logs.json"] {
                    if source.join(name).exists() { fs::copy(source.join(name), staging.path().join(name)).map_err(|e| e.to_string())?; }
                }
                fs::rename(staging.path(), &data_dir).map_err(|e| e.to_string())?;
            }
        }
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(data_dir.join(".lock")).map_err(|e| e.to_string())?;
        lock.try_lock_exclusive().map_err(|e| format!("Data directory is already in use: {e}"))?;
        let journal_path = data_dir.join("transaction.json");
        if journal_path.exists() {
            let journal = read_json(&journal_path, Value::Null)?;
            let files = journal.as_object().ok_or("Invalid transaction journal")?;
            for (name, value) in files {
                if !["projects.json", "schedules.json", "schedule-logs.json", "settings.json"].contains(&name.as_str()) { return Err("Invalid transaction journal filename".into()); }
                if value.is_null() {
                    let path = data_dir.join(name);
                    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
                } else {
                    let contents = value.as_str().ok_or("Invalid transaction journal contents")?;
                    atomic_write(&data_dir.join(name), contents.as_bytes())?;
                }
            }
            fs::remove_file(journal_path).map_err(|e| e.to_string())?;
        }
        let projects = validate_projects(array(read_json(&data_dir.join("projects.json"), json!([]))?, "projects")?)?;
        let schedules = array(read_json(&data_dir.join("schedules.json"), json!([]))?, "schedules")?;
        let logs = array(read_json(&data_dir.join("schedule-logs.json"), json!([]))?, "logs")?;
        let settings = read_json(&data_dir.join("settings.json"), json!({}))?.as_object().cloned().ok_or("settings must be an object")?;
        let mut store = Self { data_dir, projects, schedules, logs, settings, _lock: lock };
        if !store.data_dir.join("projects.json").exists() { store.save_projects()?; }
        store.apply_codex_command_migration()?;
        Ok(store)
    }

    // 历史数据一次性补齐默认 Codex 命令；设置标记后用户删除的命令不会再被加回。
    fn apply_codex_command_migration(&mut self) -> Result<(), String> {
        if self.setting("codexCommandMigrated") == json!(true) { return Ok(()); }
        let mut projects = self.projects.clone();
        let mut changed = false;
        for project in projects.iter_mut() { changed |= ensure_codex_command(project); }
        if changed { self.commit_projects(projects)?; }
        self.set_setting("codexCommandMigrated", json!(true))
    }

    pub fn setting(&self, key: &str) -> Value { self.settings.get(key).cloned().unwrap_or(Value::Null) }

    pub fn set_setting(&mut self, key: &str, value: Value) -> Result<(), String> {
        let mut settings = self.settings.clone();
        settings.insert(key.to_owned(), value);
        write_json(&self.data_dir.join("settings.json"), &Value::Object(settings.clone()))?;
        self.settings = settings;
        Ok(())
    }

    pub fn save_projects(&self) -> Result<(), String> {
        let path = self.data_dir.join("projects.json");
        if path.exists() { atomic_write(&self.data_dir.join("projects_backup.json"), &fs::read(&path).map_err(|e| e.to_string())?)?; }
        write_json(&path, &json!(self.projects))
    }

    pub fn save_schedules(&self) -> Result<(), String> { write_json(&self.data_dir.join("schedules.json"), &json!(self.schedules)) }

    pub fn add_log(&mut self, mut log: Value) -> Result<Value, String> {
        let object = log.as_object_mut().ok_or("Log must be an object")?;
        object.entry("id").or_insert_with(|| json!(Uuid::new_v4().to_string()));
        let mut logs = self.logs.clone();
        logs.insert(0, log.clone());
        logs.truncate(500);
        write_json(&self.data_dir.join("schedule-logs.json"), &json!(logs))?;
        self.logs = logs;
        Ok(log)
    }

    fn commit_projects(&mut self, projects: Vec<Value>) -> Result<(), String> {
        let projects = validate_projects(projects)?;
        let previous = std::mem::replace(&mut self.projects, projects);
        if let Err(error) = self.save_projects() { self.projects = previous; return Err(error); }
        Ok(())
    }

    fn commit_state(&mut self, projects: Vec<Value>, schedules: Vec<Value>, logs: Vec<Value>) -> Result<(), String> {
        self.commit_all(projects, schedules, logs, self.settings.clone())
    }

    fn commit_all(&mut self, projects: Vec<Value>, schedules: Vec<Value>, logs: Vec<Value>, settings: Map<String, Value>) -> Result<(), String> {
        let projects = validate_projects(projects)?;
        let values = [("projects.json", json!(projects)), ("schedules.json", json!(schedules)), ("schedule-logs.json", json!(logs)), ("settings.json", json!(settings))];
        let mut previous = Map::new();
        // 先读取并验证全部目标，再建立事务记录。
        for (name, _) in &values {
            let path = self.data_dir.join(name);
            let content = if path.exists() { json!(fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?) } else { Value::Null };
            previous.insert((*name).into(), content);
        }
        let journal_path = self.data_dir.join("transaction.json");
        write_json(&journal_path, &Value::Object(previous.clone()))?;
        if let Some(content) = previous["projects.json"].as_str() { atomic_write(&self.data_dir.join("projects_backup.json"), content.as_bytes())?; }
        for (name, value) in &values {
            if let Err(error) = write_json(&self.data_dir.join(name), value) {
                for (old_name, content) in &previous {
                    let path = self.data_dir.join(old_name);
                    if let Some(content) = content.as_str() { atomic_write(&path, content.as_bytes())?; }
                    else if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
                }
                fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
                return Err(error);
            }
        }
        fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
        self.projects = projects;
        self.schedules = schedules;
        self.logs = logs;
        self.settings = settings;
        Ok(())
    }

    fn import(&mut self, data: &Value) -> Result<Value, String> {
        let input = if data.is_array() { data.clone() } else { data["projects"].clone() };
        let raw_incoming = array(input, "projects")?;
        let incoming = validate_projects(raw_incoming.clone())?;
        let mut id_map = HashMap::new();
        let mut imported = Vec::new();
        let mut added = 0;
        let mut updated = 0;
        for (mut project, raw) in incoming.into_iter().zip(raw_incoming) {
            let source_id = required(&project, "id")?.to_owned();
            let existing = self.projects.iter().find(|p| p["name"] == project["name"]);
            let id = if let Some(existing) = existing { updated += 1; existing["id"].clone() } else { added += 1; json!(Uuid::new_v4().to_string()) };
            id_map.insert(source_id, id.clone());
            if let Some(existing) = existing {
                let mut merged = existing.as_object().unwrap().clone();
                merged.extend(project.as_object().unwrap().clone());
                for key in ["pinned", "order", "subprojects"] {
                    if !raw.as_object().unwrap().contains_key(key) {
                        if let Some(value) = existing.get(key) { merged.insert(key.into(), value.clone()); }
                    }
                }
                project = Value::Object(merged);
            }
            project["id"] = id;
            normalize_urls(&mut project);
            imported.push(project);
        }
        let ids: HashSet<String> = imported.iter().map(|p| p["id"].as_str().unwrap().to_owned()).collect();
        let deleted = self.projects.iter().filter(|p| !ids.contains(p["id"].as_str().unwrap())).count();
        let mut schedules: Vec<Value> = self.schedules.iter().filter(|s| ids.contains(s["projectId"].as_str().unwrap_or(""))).cloned().collect();
        schedules.retain(|s| imported.iter().find(|p| p["id"] == s["projectId"]).is_some_and(|p| s["commandIndex"].as_u64().is_some_and(|index| p["commands"].get(index as usize).is_some())));
        for schedule in &mut schedules {
            let project = imported.iter().find(|p| p["id"] == schedule["projectId"]).unwrap();
            let index = schedule["commandIndex"].as_u64().unwrap() as usize;
            schedule["command"] = project["commands"][index].clone();
            schedule["projectPath"] = project["path"].clone();
            schedule["projectName"] = project["name"].clone();
            schedule["commandName"] = project["command_names"].get(index).cloned().unwrap_or(json!(""));
        }
        if let Some(entries) = data.get("schedules") {
            for mut entry in array(entries.clone(), "schedules")? {
                let object = entry.as_object_mut().ok_or("Schedule must be an object")?;
                let source = object.get("projectId").and_then(Value::as_str).ok_or("Schedule projectId is required")?;
                if let Some(id) = id_map.get(source) { object.insert("projectId".into(), id.clone()); }
                if !ids.contains(entry["projectId"].as_str().unwrap_or("")) {
                    if let Some(project) = imported.iter().find(|p| p["name"] == entry["projectName"]) { entry["projectId"] = project["id"].clone(); }
                }
                if let Some(project) = imported.iter().find(|p| p["id"] == entry["projectId"]) {
                    let command_index = entry["commandIndex"].as_u64().ok_or("Invalid imported schedule command index")? as usize;
                    if project["commands"].get(command_index).is_none() { return Err("Imported schedule references a missing command".into()); }
                    entry["command"] = project["commands"][command_index].clone();
                    entry["projectPath"] = project["path"].clone();
                    entry["projectName"] = project["name"].clone();
                    entry["commandName"] = project["command_names"].get(command_index).cloned().unwrap_or(json!(""));
                }
                crate::execution::validate_cron(required(&entry, "cronExpression")?)?;
                let id = required(&entry, "id")?;
                if let Some(index) = schedules.iter().position(|s| s["id"] == id) { schedules[index] = entry; } else { schedules.push(entry); }
            }
        }
        self.commit_state(imported, schedules, self.logs.clone())?;
        Ok(json!({"success":true,"data":{"added":added,"updated":updated,"deleted":deleted}}))
    }

    pub fn handle(&mut self, action: &str, args: &Value) -> Result<Value, String> {
        match action {
            "get-projects" => {
                let mut projects = self.projects.clone();
                projects.sort_by_key(|p| (!p["pinned"].as_bool().unwrap_or(false), p["order"].as_i64().unwrap_or(0)));
                Ok(json!({"success":true,"data":projects}))
            }
            "add-project" => {
                let mut project = args["project"].clone();
                let object = project.as_object_mut().ok_or("project must be an object")?;
                object.insert("id".into(), json!(Uuid::new_v4().to_string()));
                object.insert("order".into(), json!(0));
                let mut project = normalize_project(project, 0)?;
                normalize_urls(&mut project);
                let mut projects = self.projects.clone();
                for item in &mut projects { item["order"] = json!(item["order"].as_i64().unwrap_or(0) + 1); }
                projects.insert(0, project.clone());
                self.commit_projects(projects)?;
                Ok(json!({"success":true,"data":project}))
            }
            "update-project" | "toggle-pin" | "update-command" => {
                let id = if action == "update-command" { required(args, "projectId")? } else { required(args, "id")? };
                let mut projects = self.projects.clone();
                let project = projects.iter_mut().find(|p| p["id"] == id).ok_or("Project not found")?;
                match action {
                    "toggle-pin" => project["pinned"] = json!(!project["pinned"].as_bool().unwrap_or(false)),
                    "update-command" => {
                        let index = args["index"].as_u64().ok_or("Invalid command index")? as usize;
                        let command = required(args, "command")?;
                        let commands = project["commands"].as_array_mut().ok_or("Missing commands")?;
                        *commands.get_mut(index).ok_or("Command not found")? = json!(command);
                        project["default_command"] = project["commands"][0].clone();
                    }
                    _ => {
                        let updates = args["updates"].as_object().ok_or("updates must be an object")?;
                        let object = project.as_object_mut().unwrap();
                        for (key, value) in updates { if key != "id" { object.insert(key.clone(), value.clone()); } }
                        if updates.contains_key("commands") { project["default_command"] = project["commands"].as_array().and_then(|a| a.first()).cloned().unwrap_or(json!("")); }
                    }
                }
                // 命令修改同步到计划，命令删除同时移除关联计划。
                let mut projects = validate_projects(projects)?;
                let changed = projects.iter_mut().find(|p| p["id"] == id).unwrap();
                normalize_urls(changed);
                let output = changed.clone();
                let project = projects.iter().find(|p| p["id"] == id).unwrap();
                let commands = project["commands"].as_array().unwrap();
                let mut schedules = self.schedules.clone();
                schedules.retain(|s| s["projectId"] != id || s["commandIndex"].as_u64().is_some_and(|i| (i as usize) < commands.len()));
                for schedule in &mut schedules {
                    if schedule["projectId"] == id {
                        let index = schedule["commandIndex"].as_u64().unwrap() as usize;
                        schedule["command"] = commands[index].clone();
                        schedule["projectPath"] = project["path"].clone();
                        schedule["projectName"] = project["name"].clone();
                        schedule["commandName"] = project["command_names"].get(index).cloned().unwrap_or(json!(""));
                    }
                }
                if schedules == self.schedules { self.commit_projects(projects)?; }
                else { self.commit_state(projects, schedules, self.logs.clone())?; }
                Ok(json!({"success":true,"data":output}))
            }
            "delete-project" => {
                let id = required(args, "id")?;
                let projects: Vec<_> = self.projects.iter().filter(|p| p["id"] != id).cloned().collect();
                let deleted = projects.len() != self.projects.len();
                let deleted_schedule_ids: HashSet<_> = self.schedules.iter().filter(|s| s["projectId"] == id).map(|s| s["id"].clone()).filter_map(|v| v.as_str().map(str::to_owned)).collect();
                let schedules = self.schedules.iter().filter(|s| s["projectId"] != id).cloned().collect();
                let logs = self.logs.iter().filter(|l| !deleted_schedule_ids.contains(l["scheduleId"].as_str().unwrap_or(""))).cloned().collect();
                self.commit_state(projects, schedules, logs)?;
                Ok(json!({"success":true,"data":deleted}))
            }
            "reorder-projects" => {
                let ids = args["ids"].as_array().ok_or("ids must be an array")?;
                let mut projects = self.projects.clone();
                projects.sort_by_key(|p| ids.iter().position(|id| *id == p["id"]).unwrap_or(usize::MAX));
                for (index, project) in projects.iter_mut().enumerate() { project["order"] = json!(index); }
                self.commit_projects(projects)?;
                Ok(json!({"success":true}))
            }
            "export-projects" => Ok(json!({"success":true,"data":{"version":"1.1","projects":self.projects,"schedules":self.schedules}})),
            "import-projects" => self.import(&args["data"]),
            "get-locale" => Ok(self.setting("locale")),
            "get-terminal" => Ok(self.settings.get("terminal").cloned().unwrap_or(json!("default"))),
            "get-search-history" => Ok(self.settings.get("searchHistory").cloned().unwrap_or(json!([]))),
            "set-locale" | "set-terminal" | "save-search-history" => {
                let (key, arg) = match action { "set-locale" => ("locale","locale"), "set-terminal" => ("terminal","terminal"), _ => ("searchHistory","history") };
                self.set_setting(key, args[arg].clone())?;
                Ok(json!({"success":true}))
            }
            "get-schedules" => Ok(json!({"success":true,"data":self.schedules})),
            "get-schedule-for-command" => Ok(json!({"success":true,"data":self.schedules.iter().find(|s| s["projectId"] == args["projectId"] && s["commandIndex"] == args["index"])})),
            "add-schedule" | "update-schedule" | "delete-schedule" | "toggle-schedule" => {
                let previous = self.schedules.clone();
                let result = if action == "add-schedule" {
                    let mut schedule = args["schedule"].clone();
                    let object = schedule.as_object_mut().ok_or("schedule must be an object")?;
                    object.insert("id".into(), json!(Uuid::new_v4().to_string()));
                    object.insert("lastRunAt".into(), Value::Null);
                    object.insert("lastExitCode".into(), Value::Null);
                    self.validate_schedule(&schedule)?;
                    if self.schedules.iter().any(|s| s["projectId"] == schedule["projectId"] && s["commandIndex"] == schedule["commandIndex"]) { return Err("A schedule already exists for this command".into()); }
                    self.schedules.push(schedule.clone());
                    schedule
                } else {
                    let id = required(args, "id")?;
                    let index = self.schedules.iter().position(|s| s["id"] == id).ok_or("Schedule not found")?;
                    if action == "delete-schedule" { self.schedules.remove(index); json!(true) }
                    else {
                        let mut schedule = self.schedules[index].clone();
                        if action == "toggle-schedule" { schedule["enabled"] = args["enabled"].as_bool().map(Value::Bool).unwrap_or(json!(!schedule["enabled"].as_bool().unwrap_or(false))); }
                        else {
                            let updates = args["updates"].as_object().ok_or("updates must be an object")?;
                            for (key,value) in updates { if key != "id" { schedule[key] = value.clone(); } }
                        }
                        self.validate_schedule(&schedule)?;
                        self.schedules[index] = schedule.clone();
                        schedule
                    }
                };
                if let Err(error) = self.save_schedules() { self.schedules = previous; return Err(error); }
                Ok(json!({"success":true,"data":result}))
            }
            "validate-cron" => Ok(json!({"valid":crate::execution::validate_cron(args["cronExpression"].as_str().unwrap_or("")).is_ok()})),
            "get-schedule-logs" => {
                let options = &args["options"];
                let filtered: Vec<_> = self.logs.iter().filter(|l| options["scheduleId"].is_null() || l["scheduleId"] == options["scheduleId"]).cloned().collect();
                let total = filtered.len();
                let offset = options["offset"].as_u64().unwrap_or(0) as usize;
                let limit = options["limit"].as_u64().unwrap_or(50) as usize;
                Ok(json!({"success":true,"data":{"total":total,"logs":filtered.into_iter().skip(offset).take(limit).collect::<Vec<_>>()}}))
            }
            "clear-schedule-logs" => {
                let logs: Vec<_> = if args["scheduleId"].is_null() { Vec::new() } else { self.logs.iter().filter(|l| l["scheduleId"] != args["scheduleId"]).cloned().collect() };
                write_json(&self.data_dir.join("schedule-logs.json"), &json!(logs))?;
                self.logs = logs;
                Ok(json!({"success":true}))
            }
            "reset-data" => {
                self.commit_all(Vec::new(), Vec::new(), Vec::new(), Map::new())?;
                Ok(json!({"success":true}))
            }
            _ => Err(format!("Unknown store action: {action}")),
        }
    }

    fn validate_schedule(&self, schedule: &Value) -> Result<(), String> {
        crate::execution::validate_cron(required(schedule, "cronExpression")?)?;
        let project = self.projects.iter().find(|p| p["id"] == schedule["projectId"]).ok_or("Schedule project not found")?;
        let index = schedule["commandIndex"].as_u64().ok_or("Invalid schedule command index")? as usize;
        if project["commands"].get(index).is_none() { return Err("Schedule command not found".into()); }
        if let Some(timeout) = schedule.get("timeoutMinutes") { if timeout.as_u64().is_none_or(|n| n == 0 || n > 10080) { return Err("timeoutMinutes must be between 1 and 10080".into()); } }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn directory() -> std::path::PathBuf {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.work/store-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn preserves_legacy_fields_and_unknown_fields_across_restart() {
        let path = directory();
        let project = json!({"id":"legacy","name":"中文项目","commands":["pwd"],"command_names":["启动"],"command_modes":["silent"],"subprojects":[{"name":"子项目","items":[{"type":"url","url":"https://example.com"}]}],"future":{"value":42}});
        std::fs::write(path.join("projects.json"), serde_json::to_vec(&vec![project.clone()]).unwrap()).unwrap();
        let mut store = Store::open(path.clone(), None).unwrap();
        store.handle("update-project", &json!({"id":"legacy","updates":{"pinned":true}})).unwrap();
        drop(store);
        let store = Store::open(path, None).unwrap();
        assert_eq!(store.projects[0]["future"], project["future"]);
        assert_eq!(store.projects[0]["subprojects"], project["subprojects"]);
        // 启动迁移补齐 Codex 命令，名称与模式数组同步追加
        assert_eq!(store.projects[0]["commands"], json!(["pwd", CODEX_COMMAND]));
        assert_eq!(store.projects[0]["command_names"], json!(["启动", ""]));
        assert_eq!(store.projects[0]["command_modes"], json!(["silent", "terminal"]));
        assert_eq!(store.projects[0]["pinned"], true);
    }

    #[test]
    fn codex_migration_fills_all_projects_once_and_respects_removal() {
        let path = directory();
        let seed = json!([
            {"id":"a","name":"项目甲","commands":["pwd"]},
            {"id":"b","name":"项目乙","commands":["pwd","codex --yolo"]},
            {"id":"c","name":"项目丙","commands":[]},
            {"id":"d","name":"项目丁","commands":["codexcli --dangerously-bypass-approvals-and-sandbox"]}
        ]);
        std::fs::write(path.join("projects.json"), serde_json::to_vec(&seed).unwrap()).unwrap();
        let mut store = Store::open(path.clone(), None).unwrap();
        assert_eq!(store.projects[0]["commands"], json!(["pwd", CODEX_COMMAND]));
        assert_eq!(store.projects[0]["command_modes"], json!(["terminal", "terminal"]));
        assert_eq!(store.projects[1]["commands"], json!(["pwd", "codex --yolo"]));
        assert_eq!(store.projects[2]["commands"], json!([CODEX_COMMAND]));
        // codexcli 是不同命令，不能当作已存在的 Codex
        assert_eq!(store.projects[3]["commands"], json!(["codexcli --dangerously-bypass-approvals-and-sandbox", CODEX_COMMAND]));
        // 用户删除 Codex 命令后重启不再回加
        store.handle("update-project", &json!({"id":"a","updates":{"commands":["pwd"]}})).unwrap();
        drop(store);
        let store = Store::open(path, None).unwrap();
        assert_eq!(store.projects[0]["commands"], json!(["pwd"]));
    }

    #[test]
    fn import_matches_names_and_remaps_schedules() {
        let mut store = Store::open(directory(), None).unwrap();
        store.handle("add-project", &json!({"project":{"name":"项目","commands":["pwd"]}})).unwrap();
        let id = store.projects[0]["id"].clone();
        let result = store.handle("import-projects", &json!({"data":{"version":"1.1","projects":[{"id":"foreign","name":"项目","default_command":"ls","extra":true}],"schedules":[{"id":"schedule","projectId":"foreign","commandIndex":0,"command":"ls","cronExpression":"0 9 * * *","enabled":false}]}})).unwrap();
        assert_eq!(result["data"]["updated"], 1);
        assert_eq!(store.projects[0]["id"], id);
        assert_eq!(store.projects[0]["commands"], json!(["ls"]));
        assert_eq!(store.schedules[0]["projectId"], id);
        assert_eq!(store.projects[0]["extra"], true);
    }

    #[test]
    fn rejects_corrupt_data_without_overwriting() {
        let path = directory();
        std::fs::write(path.join("projects.json"), b"{broken").unwrap();
        assert!(Store::open(path.clone(), None).is_err());
        assert_eq!(std::fs::read(path.join("projects.json")).unwrap(), b"{broken");
    }

    #[test]
    fn migration_copies_all_files_and_never_changes_source() {
        let source = directory();
        let destination = directory().join("data");
        let bytes = br#"[{"id":"old","name":"old","default_command":"pwd","custom":7}]"#;
        std::fs::write(source.join("projects.json"), bytes).unwrap();
        std::fs::write(source.join("settings.json"), br#"{"locale":"zh","searchHistory":["old"]}"#).unwrap();
        std::fs::write(source.join("schedules.json"), b"[]").unwrap();
        std::fs::write(source.join("schedule-logs.json"), b"[]").unwrap();
        let store = Store::open(destination.clone(), Some(&source)).unwrap();
        assert_eq!(store.projects[0]["custom"], 7);
        assert_eq!(store.setting("locale"), "zh");
        assert_eq!(std::fs::read(source.join("projects.json")).unwrap(), bytes);
        assert!(destination.join("settings.json").exists());
    }

    #[test]
    fn failed_import_preserves_files_and_memory() {
        let mut store = Store::open(directory(), None).unwrap();
        store.handle("add-project", &json!({"project":{"name":"existing"}})).unwrap();
        let before = store.projects.clone();
        let bytes = std::fs::read(store.data_dir.join("projects.json")).unwrap();
        assert!(store.handle("import-projects", &json!({"data":{"projects":[{"name":"duplicate"},{"name":"duplicate"}]}})).is_err());
        assert_eq!(store.projects, before);
        assert_eq!(std::fs::read(store.data_dir.join("projects.json")).unwrap(), bytes);
    }
}
