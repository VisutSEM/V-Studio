use crate::{
    ai, assembler, audio_post,
    db::{self, AppState, Scene},
    error::CmdResult,
    planner, render, scene_parser, settings, tts_router,
};
use anyhow::{bail, Result};
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize)]
pub struct Progress {
    pub project_id: String,
    pub stage: String,
    pub done: u32,
    pub total: u32,
    pub message: Option<String>,
}

pub fn emit(
    app: &AppHandle,
    id: &str,
    stage: &str,
    done: u32,
    total: u32,
    message: Option<String>,
) {
    let _ = app.emit(
        "pipeline-progress",
        Progress {
            project_id: id.into(),
            stage: stage.into(),
            done,
            total,
            message,
        },
    );
}

pub async fn retry<T, F, Fut>(attempts: u32, f: F) -> Result<T>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut i = 0u32;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if i + 1 >= attempts => return Err(e),
            Err(_) => {
                i += 1;
                tokio::time::sleep(Duration::from_secs(2u64.pow(i))).await;
            }
        }
    }
}

/// Runs `f` for every scene with bounded concurrency, emitting progress. Returns the failure count.
pub async fn each_scene<F, Fut>(
    app: &AppHandle,
    id: &str,
    stage: &str,
    todo: Vec<Scene>,
    limit: usize,
    f: F,
) -> u32
where
    F: Fn(Scene) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let total = todo.len() as u32;
    let done = Arc::new(AtomicU32::new(0));
    let failed = Arc::new(AtomicU32::new(0));
    emit(app, id, stage, 0, total, None);

    stream::iter(todo)
        .for_each_concurrent(limit, |sc| {
            let fut = f(sc);
            let (app, id, stage) = (app.clone(), id.to_string(), stage.to_string());
            let (done, failed) = (done.clone(), failed.clone());
            async move {
                let msg = match fut.await {
                    Ok(()) => None,
                    Err(e) => {
                        failed.fetch_add(1, Ordering::SeqCst);
                        Some(format!("{e:#}"))
                    }
                };
                let d = done.fetch_add(1, Ordering::SeqCst) + 1;
                emit(&app, &id, &stage, d, total, msg);
            }
        })
        .await;
    failed.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------- script

#[derive(Deserialize, Serialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Chapter {
    pub title: String,
    pub summary: String,
}

#[derive(Deserialize, Serialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Outline {
    pub title: String,
    pub characters: String,
    pub chapters: Vec<Chapter>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScriptCheckpoint {
    pub project_id: String,
    pub completed_chapters: usize,
    pub total_chapters: usize,
    pub prev_end: String,
    pub next_idx: i64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ScriptTaskStatus {
    pub project_id: String,
    pub is_running: bool,
    pub stage: String,
    pub done: u32,
    pub total: u32,
    pub message: Option<String>,
    pub error: Option<String>,
    pub can_continue: bool,
}

static SCRIPT_TASKS: OnceLock<Mutex<HashMap<String, ScriptTaskStatus>>> = OnceLock::new();

fn get_tasks_lock() -> &'static Mutex<HashMap<String, ScriptTaskStatus>> {
    SCRIPT_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn update_task_progress(id: &str, done: u32, total: u32, message: Option<String>) {
    let mut tasks = get_tasks_lock().lock().unwrap();
    if let Some(t) = tasks.get_mut(id) {
        t.done = done;
        t.total = total;
        t.message = message;
    }
}

#[derive(Deserialize)]
struct GenScene {
    narration: String,
    image_prompt: String,
}

#[derive(Deserialize)]
struct GenScenes {
    scenes: Vec<GenScene>,
}

async fn llm_json<T: serde::de::DeserializeOwned>(
    s: &settings::Settings,
    key: &str,
    system: &str,
    user: &str,
) -> Result<T> {
    let mut last = None;
    for i in 0..3u64 {
        match ai::llm_generate(s, key, system, user, true)
            .await
            .and_then(|t| planner::extract_json::<T>(&t))
        {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(Duration::from_secs(2 * (i + 1))).await;
            }
        }
    }
    Err(last.unwrap())
}

#[tauri::command]
pub async fn get_script_status(
    _app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<ScriptTaskStatus> {
    // 1. Check in-memory task map first
    {
        let tasks = get_tasks_lock().lock().unwrap();
        if let Some(status) = tasks.get(&id) {
            return Ok(status.clone());
        }
    }

    // 2. Check on-disk checkpoint
    let dir = state.project_dir(&id);
    let checkpoint_path = dir.join("script_checkpoint.json");
    if checkpoint_path.exists() {
        if let Ok(cp_data) = tokio::fs::read_to_string(&checkpoint_path).await {
            if let Ok(cp) = serde_json::from_str::<ScriptCheckpoint>(&cp_data) {
                return Ok(ScriptTaskStatus {
                    project_id: id,
                    is_running: false,
                    stage: "script".into(),
                    done: (cp.completed_chapters + 1) as u32,
                    total: (cp.total_chapters + 1) as u32,
                    message: Some("Previous generation was interrupted".into()),
                    error: Some("Previous generation was interrupted".into()),
                    can_continue: true,
                });
            }
        }
    }

    // 3. Check outline without checkpoint (outline done, chapters interrupted before first save)
    let outline_path = dir.join("outline.json");
    if outline_path.exists() {
        if let Ok(project) = db::project(&state.pool, &id).await {
            if project.stage == "Draft" {
                return Ok(ScriptTaskStatus {
                    project_id: id,
                    is_running: false,
                    stage: "script".into(),
                    done: 1,
                    total: 2,
                    message: Some("Outline saved; chapters not completed".into()),
                    error: None,
                    can_continue: true,
                });
            }
        }
    }

    // Default: not running, no checkpoint
    Ok(ScriptTaskStatus {
        project_id: id,
        is_running: false,
        stage: "Draft".into(),
        done: 0,
        total: 0,
        message: None,
        error: None,
        can_continue: false,
    })
}

#[tauri::command]
pub async fn get_all_script_tasks(
    _app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Vec<ScriptTaskStatus>> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();

    // 1. In-memory tasks
    {
        let tasks = get_tasks_lock().lock().unwrap();
        for (_, t) in tasks.iter() {
            result.push(t.clone());
            seen.insert(t.project_id.clone());
        }
    }

    // 2. Projects with on-disk checkpoints not in memory
    if let Ok(rows) = sqlx::query_as::<_, (String,)>("SELECT id FROM projects")
        .fetch_all(&state.pool)
        .await
    {
        for (pid,) in rows {
            if !seen.contains(&pid) {
                let dir = state.project_dir(&pid);
                let cp_path = dir.join("script_checkpoint.json");
                if cp_path.exists() {
                    if let Ok(cp_data) = tokio::fs::read_to_string(&cp_path).await {
                        if let Ok(cp) = serde_json::from_str::<ScriptCheckpoint>(&cp_data) {
                            result.push(ScriptTaskStatus {
                                project_id: pid.clone(),
                                is_running: false,
                                stage: "script".into(),
                                done: (cp.completed_chapters + 1) as u32,
                                total: (cp.total_chapters + 1) as u32,
                                message: Some("Interrupted".into()),
                                error: Some("Interrupted".into()),
                                can_continue: true,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn generate_script(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    continue_from_saved: Option<bool>,
) -> CmdResult<u32> {
    let cont = continue_from_saved.unwrap_or(false);
    {
        let mut tasks = get_tasks_lock().lock().unwrap();
        if let Some(t) = tasks.get(&id) {
            if t.is_running {
                return Ok(0);
            }
        }
        tasks.insert(
            id.clone(),
            ScriptTaskStatus {
                project_id: id.clone(),
                is_running: true,
                stage: "script".into(),
                done: 0,
                total: 1,
                message: Some("Starting script generation...".into()),
                error: None,
                can_continue: false,
            },
        );
    }

    let app_clone = app.clone();
    let st_clone = (*state).clone();
    let id_clone = id.clone();

    tauri::async_runtime::spawn(async move {
        run_script_task(app_clone, st_clone, id_clone, cont).await;
    });

    Ok(0)
}

async fn run_script_task(
    app: AppHandle,
    st: AppState,
    id: String,
    continue_from_saved: bool,
) {
    let res = script_work(&app, &st, &id, continue_from_saved).await;
    let mut tasks = get_tasks_lock().lock().unwrap();
    match res {
        Err(e) => {
            let err_msg = format!("{e:#}");
            eprintln!("[ScriptTask] Script generation failed for {id}: {err_msg}");
            let (done, total) = tasks.get(&id).map(|t| (t.done, t.total)).unwrap_or((0, 1));
            tasks.insert(
                id.clone(),
                ScriptTaskStatus {
                    project_id: id.clone(),
                    is_running: false,
                    stage: "script".into(),
                    done,
                    total,
                    message: Some(err_msg.clone()),
                    error: Some(err_msg.clone()),
                    can_continue: true,
                },
            );
            emit(&app, &id, "script", done, total, Some(err_msg));
        }
        Ok(_) => {
            let total = tasks.get(&id).map(|t| t.total).unwrap_or(1);
            tasks.insert(
                id.clone(),
                ScriptTaskStatus {
                    project_id: id.clone(),
                    is_running: false,
                    stage: "ScriptReady".into(),
                    done: total,
                    total,
                    message: None,
                    error: None,
                    can_continue: false,
                },
            );
            emit(&app, &id, "script", total, total, None);
            let _ = app.emit(
                "project-updated",
                serde_json::json!({
                    "project_id": &id,
                    "stage": "ScriptReady"
                }),
            );
        }
    }
}

async fn script_work(
    app: &AppHandle,
    st: &AppState,
    id: &str,
    continue_from_saved: bool,
) -> Result<u32> {
    let p = db::project(&st.pool, id).await?;
    if p.prompt.trim().is_empty() {
        bail!("Write a prompt first");
    }
    let s = settings::load(app);
    let key = settings::llm_key()?;
    let (scene_len, total) = planner::plan_scenes(p.duration_sec as u32);
    let k = total.div_ceil(planner::CHAPTER_SCENES);
    let dir = st.project_dir(id);
    tokio::fs::create_dir_all(&dir).await?;
    let outline_path = dir.join("outline.json");
    let checkpoint_path = dir.join("script_checkpoint.json");

    let mut start_chapter = 0usize;
    let mut idx = 0i64;
    let mut prev_end = String::new();
    let mut loaded_outline: Option<Outline> = None;

    if continue_from_saved && outline_path.exists() {
        if let Ok(data) = tokio::fs::read_to_string(&outline_path).await {
            if let Ok(parsed) = serde_json::from_str::<Outline>(&data) {
                if !parsed.chapters.is_empty() {
                    loaded_outline = Some(parsed);
                }
            }
        }
        if checkpoint_path.exists() {
            if let Ok(cp_data) = tokio::fs::read_to_string(&checkpoint_path).await {
                if let Ok(cp) = serde_json::from_str::<ScriptCheckpoint>(&cp_data) {
                    start_chapter = cp.completed_chapters;
                    idx = cp.next_idx;
                    prev_end = cp.prev_end;
                }
            }
        }
        // Verify idx from DB
        let row: (i64,) = sqlx::query_as("SELECT COALESCE(MAX(idx) + 1, 0) FROM scenes WHERE project_id = ?")
            .bind(id)
            .fetch_one(&st.pool)
            .await
            .unwrap_or((0,));
        if row.0 > idx {
            idx = row.0;
        }
    }

    let outline = match loaded_outline {
        Some(o) => o,
        None => {
            // Fresh start: Reset everything built from the old script
            sqlx::query("DELETE FROM scenes WHERE project_id = ?")
                .bind(id)
                .execute(&st.pool)
                .await?;
            sqlx::query("DELETE FROM subtitles WHERE project_id = ?")
                .bind(id)
                .execute(&st.pool)
                .await?;
            for sub in ["audio", "images", "clips"] {
                let _ = tokio::fs::remove_dir_all(dir.join(sub)).await;
            }
            let _ = tokio::fs::remove_file(dir.join("final.mp4")).await;
            let _ = tokio::fs::remove_file(&checkpoint_path).await;
            let _ = tokio::fs::remove_file(&outline_path).await;

            // 1. Outline
            update_task_progress(id, 0, k + 1, Some("Planning outline...".into()));
            emit(app, id, "script", 0, k + 1, None);

            let generated: Outline = llm_json(
                &s,
                &key,
                &planner::outline_system(
                    &p.language,
                    &p.style,
                    (p.duration_sec as u32 / 60).max(1),
                    k,
                ),
                &p.prompt,
            )
            .await?;

            if let Ok(json_str) = serde_json::to_string_pretty(&generated) {
                let _ = tokio::fs::write(&outline_path, json_str).await;
            }
            sqlx::query("UPDATE projects SET character_sheet = ? WHERE id = ?")
                .bind(&generated.characters)
                .bind(id)
                .execute(&st.pool)
                .await?;

            start_chapter = 0;
            idx = 0;
            prev_end.clear();
            generated
        }
    };

    update_task_progress(id, (start_chapter + 1) as u32, k + 1, None);
    emit(app, id, "script", (start_chapter + 1) as u32, k + 1, None);

    let outline_text = outline
        .chapters
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}. {}: {}", i + 1, c.title, c.summary))
        .collect::<Vec<_>>()
        .join("\n");

    // 2. One call per chapter, saved as it goes
    for i in start_chapter..k as usize {
        let n = (total - (i as u32) * planner::CHAPTER_SCENES).min(planner::CHAPTER_SCENES);
        let ch = outline.chapters.get(i).cloned().unwrap_or_default();
        let prev = if prev_end.is_empty() {
            String::new()
        } else {
            format!("Previous chapter ended with: {prev_end}")
        };
        let user = format!(
            "Story: {}\n\nOutline:\n{outline_text}\n\nCharacters:\n{}\n\nWrite chapter {} of {k}: {} - {}\n{prev}",
            outline.title,
            outline.characters,
            i + 1,
            ch.title,
            ch.summary
        );
        let g: GenScenes = llm_json(
            &s,
            &key,
            &planner::chapter_system(&p.language, &p.style, &outline.title, (i + 1) as u32, k, n, scene_len),
            &user,
        )
        .await?;
        if g.scenes.is_empty() {
            bail!("Chapter {} returned no scenes", i + 1);
        }
        for sc in &g.scenes {
            let narration = scene_parser::normalize_narration(&sc.narration);
            if narration.is_empty() {
                continue;
            }
            for part in scene_parser::split_long_scene(&narration, scene_parser::MAX_SCENE_CHARS) {
                sqlx::query(
                    "INSERT INTO scenes (project_id, idx, narration, image_prompt) VALUES (?, ?, ?, ?)",
                )
                .bind(id)
                .bind(idx)
                .bind(part)
                .bind(sc.image_prompt.trim())
                .execute(&st.pool)
                .await?;
                idx += 1;
            }
        }
        prev_end = g
            .scenes
            .last()
            .map(|s| s.narration.clone())
            .unwrap_or_default();

        let cp = ScriptCheckpoint {
            project_id: id.to_string(),
            completed_chapters: i + 1,
            total_chapters: k as usize,
            prev_end: prev_end.clone(),
            next_idx: idx,
        };
        if let Ok(cp_json) = serde_json::to_string(&cp) {
            let _ = tokio::fs::write(&checkpoint_path, cp_json).await;
        }

        update_task_progress(id, (i + 2) as u32, k + 1, None);
        emit(app, id, "script", (i + 2) as u32, k + 1, None);
    }

    let _ = tokio::fs::remove_file(&checkpoint_path).await;
    db::set_stage(&st.pool, id, "ScriptReady", true).await?;
    Ok(0)
}

// ----------------------------------------------------------------- voice

#[tauri::command]
pub async fn generate_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    force: Option<bool>,
) -> CmdResult<u32> {
    Ok(voice(&app, &state, &id, force.unwrap_or(false)).await?)
}

/// Save one synthesized scene, post-process it to 48 kHz WAV, and return the
/// relative path + real duration. If FFmpeg post-processing fails we keep the
/// original bytes so a usable take is never thrown away.
async fn save_scene_audio(dir: &Path, idx: i64, bytes: &[u8]) -> Result<(String, i64)> {
    let raw_ext = ai::audio_ext(bytes);
    let raw_rel = format!("audio/scene_{:03}.raw.{raw_ext}", idx);
    let raw_path = dir.join(&raw_rel);
    tokio::fs::write(&raw_path, bytes).await?;

    let wav_rel = format!("audio/scene_{:03}.wav", idx);
    let wav_path = dir.join(&wav_rel);
    let final_rel = match audio_post::normalize(&raw_path, &wav_path).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&raw_path).await;
            wav_rel
        }
        Err(e) => {
            eprintln!("audio post failed for scene {idx}: {e:#}");
            let _ = tokio::fs::remove_file(&wav_path).await;
            let rel = format!("audio/scene_{:03}.{raw_ext}", idx);
            let _ = tokio::fs::rename(&raw_path, dir.join(&rel)).await;
            rel
        }
    };

    // Remove a stale take with the other extension.
    for ext in ["mp3", "wav"] {
        let stale = dir.join(format!("audio/scene_{:03}.{ext}", idx));
        if stale != dir.join(&final_rel) {
            let _ = tokio::fs::remove_file(stale).await;
        }
    }
    let _ = tokio::fs::remove_file(dir.join(format!("clips/scene_{:03}.mp4", idx))).await;
    let ms = render::probe_ms(&dir.join(&final_rel)).await?;
    Ok((final_rel, ms))
}

async fn voice(app: &AppHandle, st: &AppState, id: &str, force: bool) -> Result<u32> {
    let p = db::project(&st.pool, id).await?;
    let scenes = db::scenes(&st.pool, id).await?;
    if scenes.is_empty() {
        bail!("Generate the script first");
    }
    let mut s = settings::load(app);
    let mut route = tts_router::resolve(&s);
    let mut engine = route.engine;
    // Make sure the local VoxCPM 2 server is running before we start a batch.
    if engine == settings::TtsKind::VoxCpm {
        let started = match app.try_state::<crate::voxcpm::VoxCpmManager>() {
            Some(mgr) => mgr.inner().ensure_running(app).await,
            None => Ok(()),
        };
        if let Err(e) = started {
            if s.voxcpm_auto_fallback {
                eprintln!("VoxCPM 2 unavailable, using Edge TTS for this run: {e:#}");
                engine = settings::TtsKind::EdgeTts;
                s.tts_kind = settings::TtsKind::EdgeTts;
                route.engine = engine;
            } else {
                bail!(
                    "VoxCPM 2 is not ready: {e:#}. Open Settings → Voice and click 'Install Local Voice Engine', or enable 'Fall back to Edge TTS'."
                );
            }
        }
    }
    let key = match engine {
        settings::TtsKind::Azure => Some(settings::azure_key()?),
        settings::TtsKind::KiriTts => Some(settings::kiri_key()?),
        _ => None,
    };
    let dir = st.project_dir(id);
    tokio::fs::create_dir_all(dir.join("audio")).await?;

    let slow = p.style == "2d_horror";
    let mut todo: Vec<Scene> = if force {
        scenes
    } else {
        scenes
            .into_iter()
            .filter(|s| s.audio_path.is_none())
            .collect()
    };
    if todo.is_empty() {
        return Ok(0);
    }
    // Strict sequential 1-by-1 processing in ascending order (scene 1, 2, 3...)
    todo.sort_by_key(|s| s.idx);

    let total = todo.len() as u32;
    emit(
        app,
        id,
        "voice",
        0,
        total,
        Some(format!("Starting voice recording: 1 to {total} scenes step by step...")),
    );

    let mut done = 0u32;
    let mut failed = 0u32;

    for sc in todo {
        let scene_num = sc.idx + 1;
        emit(
            app,
            id,
            "voice",
            done,
            total,
            Some(format!("Recording Scene #{scene_num} (step {}/{total})...", done + 1)),
        );

        let tts_res = retry(4, || {
            ai::tts(&s, key.as_deref(), &p.voice, &sc.narration, &p.language, slow)
        })
        .await;

        match tts_res {
            Ok(bytes) => {
                match save_scene_audio(&dir, sc.idx, &bytes).await {
                    Ok((rel, ms)) => {
                        let _ = sqlx::query("UPDATE scenes SET audio_path = ?, audio_ms = ? WHERE id = ?")
                            .bind(&rel)
                            .bind(ms)
                            .bind(sc.id)
                            .execute(&st.pool)
                            .await;
                        done += 1;
                        emit(
                            app,
                            id,
                            "voice",
                            done,
                            total,
                            Some(format!("Scene #{scene_num} complete ({:.1}s)", ms as f64 / 1000.0)),
                        );
                    }
                    Err(e) => {
                        failed += 1;
                        eprintln!("[Voice] Scene #{scene_num} audio post-processing failed: {e:#}");
                        emit(
                            app,
                            id,
                            "voice",
                            done,
                            total,
                            Some(format!("Scene #{scene_num} audio error: {e:#}")),
                        );
                    }
                }
            }
            Err(e) => {
                failed += 1;
                eprintln!("[Voice] Scene #{scene_num} TTS generation failed: {e:#}");
                emit(
                    app,
                    id,
                    "voice",
                    done,
                    total,
                    Some(format!("Scene #{scene_num} voice generation failed: {e:#}")),
                );
            }
        }
    }

    if failed == 0 {
        db::set_stage(&st.pool, id, "VoiceReady", false).await?;
        let updated = db::scenes(&st.pool, id).await?;
        if let Err(e) = assembler::finalize(&dir, &p, &updated, &route).await {
            eprintln!("assembler: {e:#}");
        }
    }
    emit(app, id, "voice", done, total, None);
    Ok(failed)
}

// ---------------------------------------------------------------- images

#[tauri::command]
pub async fn generate_images(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<u32> {
    Ok(images(&app, &state, &id).await?)
}

async fn images(app: &AppHandle, st: &AppState, id: &str) -> Result<u32> {
    let p = db::project(&st.pool, id).await?;
    let scenes = db::scenes(&st.pool, id).await?;
    if scenes.is_empty() {
        bail!("Generate the script first");
    }
    let s = settings::load(app);
    let token = settings::cf_token()?;
    let dir = st.project_dir(id);
    tokio::fs::create_dir_all(dir.join("images")).await?;

    let prefix = format!(
        "{}. Characters: {}",
        planner::style_prompt(&p.style),
        p.character_sheet
    );
    let todo: Vec<Scene> = scenes
        .into_iter()
        .filter(|s| s.image_path.is_none())
        .collect();
    let pool = st.pool.clone();

    let failed = each_scene(app, id, "images", todo, 3, |sc| {
        let (pool, dir, s, token, prefix) = (
            pool.clone(),
            dir.clone(),
            s.clone(),
            token.clone(),
            prefix.clone(),
        );
        async move {
            let prompt = format!("{prefix}. Scene: {}", sc.image_prompt);
            let bytes = retry(3, || ai::cf_image(&s, &token, &prompt)).await?;
            let ext = if bytes.starts_with(&[0xFF, 0xD8]) {
                "jpg"
            } else {
                "png"
            };
            let rel = format!("images/scene_{:03}.{ext}", sc.idx);
            tokio::fs::write(dir.join(&rel), &bytes).await?;
            let _ = tokio::fs::remove_file(dir.join(format!("clips/scene_{:03}.mp4", sc.idx))).await;
            sqlx::query("UPDATE scenes SET image_path = ? WHERE id = ?")
                .bind(&rel)
                .bind(sc.id)
                .execute(&pool)
                .await?;
            Ok(())
        }
    })
    .await;

    if failed == 0 {
        db::set_stage(&st.pool, id, "ImagesReady", false).await?;
    }
    Ok(failed)
}

#[tauri::command]
pub async fn generate_scene_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    scene_id: i64,
) -> CmdResult<()> {
    let sc: Scene = sqlx::query_as("SELECT * FROM scenes WHERE id = ?")
        .bind(scene_id)
        .fetch_one(&state.pool)
        .await?;
    let p = db::project(&state.pool, &sc.project_id).await?;
    let mut s = settings::load(&app);
    let mut route = tts_router::resolve(&s);
    let mut engine = route.engine;
    if engine == settings::TtsKind::VoxCpm {
        let started = match app.try_state::<crate::voxcpm::VoxCpmManager>() {
            Some(mgr) => mgr.inner().ensure_running(&app).await,
            None => Ok(()),
        };
        if let Err(e) = started {
            if s.voxcpm_auto_fallback {
                eprintln!("VoxCPM 2 unavailable, using Edge TTS for this scene: {e:#}");
                engine = settings::TtsKind::EdgeTts;
                s.tts_kind = settings::TtsKind::EdgeTts;
                route.engine = engine;
            } else {
                return Err(crate::error::err(format!(
                    "VoxCPM 2 is not ready: {e:#}. Open Settings → Voice and click 'Install Local Voice Engine', or enable 'Fall back to Edge TTS'."
                )));
            }
        }
    }
    let key = match engine {
        settings::TtsKind::Azure => Some(settings::azure_key()?),
        settings::TtsKind::KiriTts => Some(settings::kiri_key()?),
        _ => None,
    };
    let dir = state.project_dir(&sc.project_id);
    tokio::fs::create_dir_all(dir.join("audio")).await?;

    let slow = p.style == "2d_horror";
    let bytes = retry(4, || {
        ai::tts(&s, key.as_deref(), &p.voice, &sc.narration, &p.language, slow)
    })
    .await?;
    let (rel, ms) = save_scene_audio(&dir, sc.idx, &bytes).await?;
    sqlx::query("UPDATE scenes SET audio_path = ?, audio_ms = ? WHERE id = ?")
        .bind(&rel)
        .bind(ms)
        .bind(sc.id)
        .execute(&state.pool)
        .await?;

    let updated = db::scenes(&state.pool, &sc.project_id).await?;
    if updated.iter().all(|s| s.audio_path.is_some()) {
        if let Err(e) = assembler::finalize(&dir, &p, &updated, &route).await {
            eprintln!("assembler: {e:#}");
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn generate_scene_image(
    app: AppHandle,
    state: State<'_, AppState>,
    scene_id: i64,
) -> CmdResult<()> {
    let sc: Scene = sqlx::query_as("SELECT * FROM scenes WHERE id = ?")
        .bind(scene_id)
        .fetch_one(&state.pool)
        .await?;
    let p = db::project(&state.pool, &sc.project_id).await?;
    let s = settings::load(&app);
    let token = settings::cf_token()?;
    let dir = state.project_dir(&sc.project_id);
    tokio::fs::create_dir_all(dir.join("images")).await?;

    let prefix = format!(
        "{}. Characters: {}",
        planner::style_prompt(&p.style),
        p.character_sheet
    );
    let prompt = format!("{prefix}. Scene: {}", sc.image_prompt);
    let bytes = retry(3, || ai::cf_image(&s, &token, &prompt)).await?;
    let ext = if bytes.starts_with(&[0xFF, 0xD8]) {
        "jpg"
    } else {
        "png"
    };
    let rel = format!("images/scene_{:03}.{ext}", sc.idx);
    tokio::fs::write(dir.join(&rel), &bytes).await?;
    let _ = tokio::fs::remove_file(dir.join(format!("clips/scene_{:03}.mp4", sc.idx))).await;
    sqlx::query("UPDATE scenes SET image_path = ? WHERE id = ?")
        .bind(&rel)
        .bind(sc.id)
        .execute(&state.pool)
        .await?;
    Ok(())
}
