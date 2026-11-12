use crate::{
    db::{self, AppState, Cue, Project, Scene},
    error::{err, CmdResult},
    planner, subs,
};
use serde::Serialize;
use tauri::{AppHandle, State};

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
        .bind(narration.trim())
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
    .bind(narration.trim())
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

#[tauri::command]
pub async fn save_voxcpm_recording(
    app: tauri::AppHandle,
    audio_base64: String,
) -> CmdResult<String> {
    use base64::Engine;
    use tauri::Manager;

    let clean_base64 = if let Some(pos) = audio_base64.find(',') {
        &audio_base64[pos + 1..]
    } else {
        &audio_base64
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(clean_base64)
        .map_err(|e| err(&format!("Invalid base64 audio: {e}")))?;

    let temp_in = std::env::temp_dir().join(format!("vox_rec_in_{}.bin", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp_in, &bytes).await.map_err(|e| err(&e.to_string()))?;

    let data_dir = app.path().app_data_dir().map_err(|e| err(&e.to_string()))?;
    tokio::fs::create_dir_all(&data_dir).await.map_err(|e| err(&e.to_string()))?;
    let out_path = data_dir.join("voxcpm_character_voice.wav");

    let status = crate::render::cmd("ffmpeg")
        .args([
            "-y",
            "-i",
            temp_in.to_string_lossy().as_ref(),
            "-af",
            "highpass=f=75,lowpass=f=7800,volume=1.2,dynaudnorm=p=0.9:m=10.0",
            "-ar",
            "16000",
            "-ac",
            "1",
            out_path.to_string_lossy().as_ref(),
        ])
        .status()
        .await
        .map_err(|e| err(&format!("ffmpeg execution failed: {e}")))?;

    let _ = tokio::fs::remove_file(&temp_in).await;

    if !status.success() {
        return Err(err("ffmpeg failed to process character reference audio"));
    }

    let path_str = out_path.to_string_lossy().to_string();
    Ok(path_str)
}

#[derive(Serialize)]
pub struct GpuInfo {
    pub has_nvidia: bool,
    pub gpu_name: String,
    pub vram_mb: u64,
    pub torch_cuda_available: bool,
    pub torch_version: String,
}

#[tauri::command]
pub async fn get_gpu_info(app: AppHandle) -> CmdResult<GpuInfo> {
    let mut has_nvidia = false;
    let mut gpu_name = String::new();
    let mut vram_mb = 0;

    let mut c = std::process::Command::new("nvidia-smi");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    if let Ok(out) = c.output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 2 {
                    has_nvidia = true;
                    gpu_name = parts[0].trim().to_string();
                    vram_mb = parts[1].trim().parse::<u64>().unwrap_or(0);
                }
            }
        }
    }

    let mut torch_cuda_available = false;
    let mut torch_version = String::new();

    if let Some(python) = crate::voxcpm::VoxCpmManager::find_best_python(&app) {
        let mut py_cmd = std::process::Command::new(python);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            py_cmd.creation_flags(0x0800_0000);
        }
        py_cmd.args(["-c", "import torch; print(f'{torch.__version__}|{torch.cuda.is_available()}')"]);
        if let Ok(py_out) = py_cmd.output() {
            if py_out.status.success() {
                let res = String::from_utf8_lossy(&py_out.stdout);
                let trimmed = res.trim();
                if let Some((ver, cuda)) = trimmed.split_once('|') {
                    torch_version = ver.trim().to_string();
                    torch_cuda_available = cuda.trim().eq_ignore_ascii_case("true");
                }
            }
        }
    }

    Ok(GpuInfo {
        has_nvidia,
        gpu_name,
        vram_mb,
        torch_cuda_available,
        torch_version,
    })
}
