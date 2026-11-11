use crate::{
    ai,
    db::{self, AppState, Scene},
    error::CmdResult,
    planner, render, settings,
};
use anyhow::{bail, Result};
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

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

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
struct Chapter {
    title: String,
    summary: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Outline {
    title: String,
    characters: String,
    chapters: Vec<Chapter>,
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
pub async fn generate_script(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<u32> {
    Ok(script(&app, &state, &id).await?)
}

async fn script(app: &AppHandle, st: &AppState, id: &str) -> Result<u32> {
    let p = db::project(&st.pool, id).await?;
    if p.prompt.trim().is_empty() {
        bail!("Write a prompt first");
    }
    let s = settings::load(app);
    let key = settings::llm_key()?;
    let (scene_len, total) = planner::plan_scenes(p.duration_sec as u32);
    let k = total.div_ceil(planner::CHAPTER_SCENES);

    // Reset everything built from the old script
    let dir = st.project_dir(id);
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

    // 1. Outline
    emit(app, id, "script", 0, k + 1, None);
    let outline: Outline = llm_json(
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
    sqlx::query("UPDATE projects SET character_sheet = ? WHERE id = ?")
        .bind(&outline.characters)
        .bind(id)
        .execute(&st.pool)
        .await?;
    emit(app, id, "script", 1, k + 1, None);

    let outline_text = outline
        .chapters
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}. {}: {}", i + 1, c.title, c.summary))
        .collect::<Vec<_>>()
        .join("\n");

    // 2. One call per chapter, saved as it goes
    let (mut idx, mut prev_end) = (0i64, String::new());
    for i in 0..k {
        let n = (total - i * planner::CHAPTER_SCENES).min(planner::CHAPTER_SCENES);
        let ch = outline.chapters.get(i as usize).cloned().unwrap_or_default();
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
            &planner::chapter_system(&p.language, &p.style, &outline.title, i + 1, k, n, scene_len),
            &user,
        )
        .await?;
        if g.scenes.is_empty() {
            bail!("Chapter {} returned no scenes", i + 1);
        }
        for sc in &g.scenes {
            sqlx::query(
                "INSERT INTO scenes (project_id, idx, narration, image_prompt) VALUES (?, ?, ?, ?)",
            )
            .bind(id)
            .bind(idx)
            .bind(sc.narration.trim())
            .bind(sc.image_prompt.trim())
            .execute(&st.pool)
            .await?;
            idx += 1;
        }
        prev_end = g
            .scenes
            .last()
            .map(|s| s.narration.clone())
            .unwrap_or_default();
        emit(app, id, "script", i + 2, k + 1, None);
    }
    db::set_stage(&st.pool, id, "ScriptReady", true).await?;
    Ok(0)
}

// ----------------------------------------------------------------- voice

#[tauri::command]
pub async fn generate_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<u32> {
    Ok(voice(&app, &state, &id).await?)
}

async fn voice(app: &AppHandle, st: &AppState, id: &str) -> Result<u32> {
    let p = db::project(&st.pool, id).await?;
    let scenes = db::scenes(&st.pool, id).await?;
    if scenes.is_empty() {
        bail!("Generate the script first");
    }
    let s = settings::load(app);
    let key = match s.tts_kind {
        settings::TtsKind::Azure => Some(settings::azure_key()?),
        settings::TtsKind::KiriTts => Some(settings::kiri_key()?),
        _ => None,
    };
    let dir = st.project_dir(id);
    tokio::fs::create_dir_all(dir.join("audio")).await?;

    let slow = p.style == "2d_horror";
    let todo: Vec<Scene> = scenes
        .into_iter()
        .filter(|s| s.audio_path.is_none())
        .collect();
    let (pool, s2, key, voice, lang) = (
        st.pool.clone(),
        s.clone(),
        key.clone(),
        p.voice.clone(),
        p.language.clone(),
    );

    let concurrency = match s.tts_kind {
        settings::TtsKind::VoxCpm => 1,
        settings::TtsKind::MetaMms => 2,
        settings::TtsKind::EdgeTts | settings::TtsKind::Azure | settings::TtsKind::GptSovits | settings::TtsKind::KiriTts => 4,
    };

    let failed = each_scene(app, id, "voice", todo, concurrency, |sc| {
        let (pool, dir, s2, key, voice, lang) = (
            pool.clone(),
            dir.clone(),
            s2.clone(),
            key.clone(),
            voice.clone(),
            lang.clone(),
        );
        async move {
            let bytes = retry(4, || {
                ai::tts(&s2, key.as_deref(), &voice, &sc.narration, &lang, slow)
            })
            .await?;
            let ext = ai::audio_ext(&bytes);
            for e in ["mp3", "wav"] {
                let _ = tokio::fs::remove_file(dir.join(format!("audio/scene_{:03}.{e}", sc.idx))).await;
            }
            let rel = format!("audio/scene_{:03}.{ext}", sc.idx);
            tokio::fs::write(dir.join(&rel), &bytes).await?;
            let ms = render::probe_ms(&dir.join(&rel)).await?;
            let _ = tokio::fs::remove_file(dir.join(format!("clips/scene_{:03}.mp4", sc.idx))).await;
            sqlx::query("UPDATE scenes SET audio_path = ?, audio_ms = ? WHERE id = ?")
                .bind(&rel)
                .bind(ms)
                .bind(sc.id)
                .execute(&pool)
                .await?;
            Ok(())
        }
    })
    .await;

    if failed == 0 {
        db::set_stage(&st.pool, id, "VoiceReady", false).await?;
    }
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
    let s = settings::load(&app);
    let key = match s.tts_kind {
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
    let ext = ai::audio_ext(&bytes);
    for e in ["mp3", "wav"] {
        let _ = tokio::fs::remove_file(dir.join(format!("audio/scene_{:03}.{e}", sc.idx))).await;
    }
    let rel = format!("audio/scene_{:03}.{ext}", sc.idx);
    tokio::fs::write(dir.join(&rel), &bytes).await?;
    let ms = render::probe_ms(&dir.join(&rel)).await?;
    let _ = tokio::fs::remove_file(dir.join(format!("clips/scene_{:03}.mp4", sc.idx))).await;
    sqlx::query("UPDATE scenes SET audio_path = ?, audio_ms = ? WHERE id = ?")
        .bind(&rel)
        .bind(ms)
        .bind(sc.id)
        .execute(&state.pool)
        .await?;
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
