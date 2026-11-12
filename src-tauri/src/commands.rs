use crate::{
    db::{self, AppState, Cue, Project, Scene},
    error::{err, CmdResult},
    planner, scene_parser, subs,
};
use serde::Serialize;
use tauri::State;

#[tauri::command]
pub async fn create_project(state: State<'_, AppState>, name: String) -> CmdResult<Project> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO projects (id, name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .bind(&id)
        .bind(name.trim())
        .execute(&state.pool)
        .await?;
    Ok(db::project(&state.pool, &id).await?)
}

#[tauri::command]
pub async fn update_project(
    state: State<'_, AppState>,
    id: String,
    prompt: String,
    duration_sec: i64,
    style: String,
    language: String,
    voice: String,
) -> CmdResult<()> {
    sqlx::query(
        "UPDATE projects SET prompt=?, duration_sec=?, style=?, language=?, voice=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    )
    .bind(prompt)
    .bind(duration_sec.clamp(60, 3600))
    .bind(style)
    .bind(language)
    .bind(voice)
    .bind(id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<Project>> {
    Ok(
        sqlx::query_as::<_, Project>("SELECT * FROM projects ORDER BY COALESCE(NULLIF(updated_at, ''), created_at) DESC")
            .fetch_all(&state.pool)
            .await?,
    )
}

/// One row per project for the home grid: scene count and the first still.
#[derive(sqlx::FromRow)]
struct CardRow {
    id: String,
    name: String,
    duration_sec: i64,
    language: String,
    stage: String,
    updated_at: String,
    scene_count: i64,
    thumb: Option<String>,
}

#[derive(Serialize)]
pub struct ProjectCard {
    id: String,
    name: String,
    duration_sec: i64,
    language: String,
    stage: String,
    updated_at: String,
    scene_count: i64,
    thumb: Option<String>,
    dir: String,
}

#[tauri::command]
pub async fn list_project_cards(state: State<'_, AppState>) -> CmdResult<Vec<ProjectCard>> {
    let rows = sqlx::query_as::<_, CardRow>(
        "SELECT p.id, p.name, p.duration_sec, p.language, p.stage,
                COALESCE(NULLIF(p.updated_at, ''), p.created_at) AS updated_at,
                (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) AS scene_count,
                (SELECT s.image_path FROM scenes s WHERE s.project_id = p.id AND s.image_path IS NOT NULL
                  ORDER BY s.idx LIMIT 1) AS thumb
         FROM projects p
         ORDER BY updated_at DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ProjectCard {
            dir: state.project_dir(&r.id).to_string_lossy().into_owned(),
            id: r.id,
            name: r.name,
            duration_sec: r.duration_sec,
            language: r.language,
            stage: r.stage,
            updated_at: r.updated_at,
            scene_count: r.scene_count,
            thumb: r.thumb,
        })
        .collect())
}

#[derive(Serialize)]
pub struct Detail {
    project: Project,
    scenes: Vec<Scene>,
    dir: String,
    has_final: bool,
}

#[tauri::command]
pub async fn get_project(state: State<'_, AppState>, id: String) -> CmdResult<Detail> {
    let dir = state.project_dir(&id);
    Ok(Detail {
        project: db::project(&state.pool, &id).await?,
        scenes: db::scenes(&state.pool, &id).await?,
        has_final: dir.join("final.mp4").exists(),
        dir: dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;
    let _ = tokio::fs::remove_dir_all(state.project_dir(&id)).await;
    Ok(())
}

#[derive(Serialize)]
pub struct Estimate {
    scene_len: u32,
    scenes: u32,
}

#[tauri::command]
pub fn estimate(duration_sec: u32) -> Estimate {
    let (scene_len, scenes) = planner::plan_scenes(duration_sec);
    Estimate { scene_len, scenes }
}

/// "image" or "audio": forget that asset so the next run regenerates it
#[tauri::command]
pub async fn clear_asset(state: State<'_, AppState>, scene_id: i64, kind: String) -> CmdResult<()> {
    let q = match kind.as_str() {
        "image" => "UPDATE scenes SET image_path = NULL WHERE id = ?",
        "audio" => "UPDATE scenes SET audio_path = NULL, audio_ms = NULL WHERE id = ?",
        _ => return Err(err("kind must be 'image' or 'audio'")),
    };
    sqlx::query(q).bind(scene_id).execute(&state.pool).await?;
    Ok(())
}

#[tauri::command]
pub async fn build_subtitles(state: State<'_, AppState>, id: String) -> CmdResult<Vec<Cue>> {
    let scenes = db::scenes(&state.pool, &id).await?;
    if scenes.is_empty() || scenes.iter().any(|s| s.audio_ms.is_none()) {
        return Err(err("Generate the voice for every scene first"));
    }
    let cues = subs::build_cues(&scenes);
    db::save_cues(&state.pool, &id, &cues).await?;
    db::set_stage(&state.pool, &id, "Editing", false).await?;
    Ok(cues)
}

#[tauri::command]
pub async fn get_subtitles(state: State<'_, AppState>, id: String) -> CmdResult<Vec<Cue>> {
    Ok(db::cues(&state.pool, &id).await?)
}

#[tauri::command]
pub async fn save_subtitles(
    state: State<'_, AppState>,
    id: String,
    cues: Vec<Cue>,
) -> CmdResult<()> {
    Ok(db::save_cues(&state.pool, &id, &cues).await?)
}

#[tauri::command]
pub async fn rename_project(state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err(err("Project name cannot be empty"));
    }
    sqlx::query("UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(clean)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn update_project_story(
    state: State<'_, AppState>,
    id: String,
    prompt: String,
    character_sheet: String,
) -> CmdResult<()> {
    sqlx::query(
        "UPDATE projects SET prompt = ?, character_sheet = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(prompt.trim())
    .bind(character_sheet.trim())
    .bind(&id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn update_scene(
    state: State<'_, AppState>,
    scene_id: i64,
    narration: String,
    image_prompt: String,
) -> CmdResult<()> {
    sqlx::query("UPDATE scenes SET narration = ?, image_prompt = ? WHERE id = ?")
        .bind(scene_parser::normalize_narration(&narration))
        .bind(image_prompt.trim())
        .bind(scene_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn add_scene(
    state: State<'_, AppState>,
    project_id: String,
    narration: String,
    image_prompt: String,
) -> CmdResult<Scene> {
    let next_idx: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(idx), -1) + 1 FROM scenes WHERE project_id = ?")
        .bind(&project_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| err(format!("Failed to determine scene index: {e}")))?;

    let id = sqlx::query(
        "INSERT INTO scenes (project_id, idx, narration, image_prompt) VALUES (?, ?, ?, ?)"
    )
    .bind(&project_id)
    .bind(next_idx)
    .bind(scene_parser::normalize_narration(&narration))
    .bind(image_prompt.trim())
    .execute(&state.pool)
    .await
    .map_err(|e| err(format!("Failed to insert scene: {e}")))?
    .last_insert_rowid();

    let scene: Scene = sqlx::query_as("SELECT * FROM scenes WHERE id = ?")
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| err(format!("Failed to fetch created scene: {e}")))?;

    Ok(scene)
}

#[tauri::command]
pub async fn delete_scene(
    state: State<'_, AppState>,
    scene_id: i64,
) -> CmdResult<()> {
    let project_id: String = sqlx::query_scalar("SELECT project_id FROM scenes WHERE id = ?")
        .bind(scene_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| err(format!("Scene not found: {e}")))?;

    sqlx::query("DELETE FROM scenes WHERE id = ?")
        .bind(scene_id)
        .execute(&state.pool)
        .await
        .map_err(|e| err(format!("Failed to delete scene: {e}")))?;

    // Re-index remaining scenes
    let remaining_ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM scenes WHERE project_id = ? ORDER BY idx ASC")
        .bind(&project_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

    for (new_idx, sid) in remaining_ids.iter().enumerate() {
        let _ = sqlx::query("UPDATE scenes SET idx = ? WHERE id = ?")
            .bind(new_idx as i64)
            .bind(sid)
            .execute(&state.pool)
            .await;
    }

    Ok(())
}

#[tauri::command]
pub async fn save_scene_recording(
    state: State<'_, AppState>,
    scene_id: i64,
    audio_base64: String,
) -> CmdResult<i64> {
    use base64::Engine;

    let (idx, project_id): (i64, String) = sqlx::query_as("SELECT idx, project_id FROM scenes WHERE id = ?")
        .bind(scene_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| err(&e.to_string()))?;

    let clean_base64 = if let Some(pos) = audio_base64.find(',') {
        &audio_base64[pos + 1..]
    } else {
        &audio_base64
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(clean_base64)
        .map_err(|e| err(&format!("Invalid base64 audio: {e}")))?;

    let temp_in = std::env::temp_dir().join(format!("rec_in_{}.bin", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp_in, &bytes).await.map_err(|e| err(&e.to_string()))?;

    let dir = state.project_dir(&project_id);
    tokio::fs::create_dir_all(dir.join("audio")).await.map_err(|e| err(&e.to_string()))?;
    let rel = format!("audio/scene_{:03}.wav", idx);
    let out_path = dir.join(&rel);

    // Convert via ffmpeg to standard 48kHz mono 16-bit PCM WAV
    let status = crate::render::cmd("ffmpeg")
        .args([
            "-y",
            "-i",
            temp_in.to_string_lossy().as_ref(),
            "-ar",
            "48000",
            "-ac",
            "1",
            out_path.to_string_lossy().as_ref(),
        ])
        .status()
        .await
        .map_err(|e| err(&format!("ffmpeg execution failed: {e}")))?;

    let _ = tokio::fs::remove_file(&temp_in).await;

    if !status.success() {
        return Err(err("ffmpeg failed to process recorded audio"));
    }

    let ms = crate::render::probe_ms(&out_path).await.map_err(|e| err(&e.to_string()))?;
    let _ = tokio::fs::remove_file(dir.join(format!("clips/scene_{:03}.mp4", idx))).await;

    sqlx::query("UPDATE scenes SET audio_path = ?, audio_ms = ? WHERE id = ?")
        .bind(&rel)
        .bind(ms)
        .bind(scene_id)
        .execute(&state.pool)
        .await
        .map_err(|e| err(&e.to_string()))?;

    Ok(ms)
}

#[derive(Serialize, serde::Deserialize, Clone, Debug)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: String,
    pub installer_url: Option<String>,
    pub installer_size: Option<u64>,
}

#[derive(Serialize, serde::Deserialize, Clone, Debug)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: u32,
    pub done: bool,
    pub error: Option<String>,
}

fn parse_version_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches('v')
        .split('.')
        .filter_map(|p| p.parse::<u64>().ok())
        .collect()
}

fn is_version_newer(latest: &str, current: &str) -> bool {
    let l = parse_version_parts(latest);
    let c = parse_version_parts(current);
    for i in 0..l.len().max(c.len()) {
        let p_l = l.get(i).copied().unwrap_or(0);
        let p_c = c.get(i).copied().unwrap_or(0);
        if p_l > p_c {
            return true;
        } else if p_l < p_c {
            return false;
        }
    }
    false
}

#[tauri::command]
pub async fn check_for_updates() -> CmdResult<UpdateCheckResult> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let client = reqwest::Client::builder()
        .user_agent("V-Studio")
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| err(&e.to_string()))?;

    let mut latest_version = current_version.clone();
    let mut download_url = "https://github.com/VisutSEM/V-Studio/releases".to_string();
    let mut installer_url = None;
    let mut installer_size = None;

    // 1. Try checking latest GitHub release
    if let Ok(res) = client
        .get("https://api.github.com/repos/VisutSEM/V-Studio/releases/latest")
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(tag) = json["tag_name"].as_str() {
                    let clean = tag.trim().trim_start_matches('v');
                    if !clean.is_empty() {
                        latest_version = clean.to_string();
                    }
                }
                if let Some(url) = json["html_url"].as_str() {
                    download_url = url.to_string();
                }
                if let Some(assets) = json["assets"].as_array() {
                    for asset in assets {
                        let name = asset["name"].as_str().unwrap_or_default();
                        if name.ends_with(".exe") && (name.contains("setup") || name.contains("V-Studio")) {
                            installer_url = asset["browser_download_url"].as_str().map(str::to_string);
                            installer_size = asset["size"].as_u64();
                            break;
                        }
                    }
                }
            }
        }
    }

    // 2. Fallback: check main branch package.json
    if latest_version == current_version {
        if let Ok(res) = client
            .get("https://raw.githubusercontent.com/VisutSEM/V-Studio/main/package.json")
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    if let Some(ver) = json["version"].as_str() {
                        let clean = ver.trim();
                        if !clean.is_empty() {
                            latest_version = clean.to_string();
                        }
                    }
                }
            }
        }
    }

    let has_update = is_version_newer(&latest_version, &current_version);

    if installer_url.is_none() && has_update {
        installer_url = Some(format!(
            "https://github.com/VisutSEM/V-Studio/releases/download/v{latest_version}/V-Studio_{latest_version}_x64-setup.exe"
        ));
    }

    Ok(UpdateCheckResult {
        current_version,
        latest_version,
        has_update,
        download_url,
        installer_url,
        installer_size,
    })
}

#[tauri::command]
pub async fn download_update_installer(
    app: tauri::AppHandle,
    url: String,
    version: String,
) -> CmdResult<String> {
    use futures::StreamExt;
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::builder()
        .user_agent("V-Studio")
        .build()
        .map_err(|e| err(&e.to_string()))?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| err(&format!("Failed to connect to download URL: {e}")))?;

    if !res.status().is_success() {
        return Err(err(&format!("Download failed with HTTP status {}", res.status())));
    }

    let total_bytes = res.content_length().unwrap_or(102_824_347);
    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join(format!("V-Studio_{version}_installer.exe"));

    let mut file = tokio::fs::File::create(&installer_path)
        .await
        .map_err(|e| err(&format!("Failed to create destination installer file: {e}")))?;

    let mut stream = res.bytes_stream();
    let mut downloaded_bytes: u64 = 0;
    let mut last_percent: u32 = 0;

    let _ = app.emit(
        "update-download-progress",
        DownloadProgress {
            downloaded_bytes: 0,
            total_bytes,
            percent: 0,
            done: false,
            error: None,
        },
    );

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| err(&format!("Error downloading chunk: {e}")))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| err(&format!("Error writing installer file: {e}")))?;
        downloaded_bytes += chunk.len() as u64;

        let percent = if total_bytes > 0 {
            ((downloaded_bytes as f64 / total_bytes as f64) * 100.0) as u32
        } else {
            0
        }
        .min(100);

        if percent != last_percent {
            last_percent = percent;
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded_bytes,
                    total_bytes,
                    percent,
                    done: false,
                    error: None,
                },
            );
        }
    }

    file.flush()
        .await
        .map_err(|e| err(&format!("Failed to flush installer file: {e}")))?;

    let _ = app.emit(
        "update-download-progress",
        DownloadProgress {
            downloaded_bytes: total_bytes,
            total_bytes,
            percent: 100,
            done: true,
            error: None,
        },
    );

    Ok(installer_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn run_installer_and_exit(app: tauri::AppHandle, installer_path: String) -> CmdResult<()> {
    let path = std::path::PathBuf::from(&installer_path);
    if !path.exists() {
        return Err(err("Installer file not found on disk."));
    }

    let mut cmd = std::process::Command::new(&path);
    #[cfg(windows)]
    {
        cmd.spawn().map_err(|e| err(&format!("Failed to start installer: {e}")))?;
    }

    app.exit(0);
    Ok(())
}


