use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    FromRow, SqlitePool,
};
use std::path::{Path, PathBuf};

pub struct AppState {
    pub pool: SqlitePool,
    pub dir: PathBuf,
}

impl AppState {
    pub fn project_dir(&self, id: &str) -> PathBuf {
        self.dir.join("projects").join(id)
    }
}

#[derive(Serialize, FromRow, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub duration_sec: i64,
    pub style: String,
    pub language: String,
    pub voice: String,
    pub character_sheet: String,
    pub stage: String,
    pub updated_at: String,
    pub created_at: String,
}

#[derive(Serialize, FromRow, Clone)]
pub struct Scene {
    pub id: i64,
    pub project_id: String,
    pub idx: i64,
    pub narration: String,
    pub image_prompt: String,
    pub audio_path: Option<String>,
    pub image_path: Option<String>,
    pub audio_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, FromRow, Clone)]
pub struct Cue {
    pub idx: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

pub async fn init(dir: &Path) -> anyhow::Result<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(dir.join("videogen.db"))
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub async fn project(pool: &SqlitePool, id: &str) -> anyhow::Result<Project> {
    Ok(sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?)
}

pub async fn scenes(pool: &SqlitePool, id: &str) -> anyhow::Result<Vec<Scene>> {
    Ok(
        sqlx::query_as::<_, Scene>("SELECT * FROM scenes WHERE project_id = ? ORDER BY idx")
            .bind(id)
            .fetch_all(pool)
            .await?,
    )
}

pub async fn cues(pool: &SqlitePool, id: &str) -> anyhow::Result<Vec<Cue>> {
    Ok(sqlx::query_as::<_, Cue>(
        "SELECT idx, start_ms, end_ms, text FROM subtitles WHERE project_id = ? ORDER BY idx",
    )
    .bind(id)
    .fetch_all(pool)
    .await?)
}

pub async fn save_cues(pool: &SqlitePool, id: &str, cues: &[Cue]) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM subtitles WHERE project_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for c in cues {
        sqlx::query(
            "INSERT INTO subtitles (project_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(c.idx)
        .bind(c.start_ms)
        .bind(c.end_ms)
        .bind(&c.text)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    sqlx::query("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

fn rank(stage: &str) -> u8 {
    match stage {
        "ScriptReady" => 1,
        "VoiceReady" => 2,
        "ImagesReady" => 3,
        "Editing" => 4,
        "Rendered" => 5,
        _ => 0,
    }
}

/// Moves the stage forward only (unless `force`).
pub async fn set_stage(pool: &SqlitePool, id: &str, stage: &str, force: bool) -> anyhow::Result<()> {
    let cur: String = sqlx::query_scalar("SELECT stage FROM projects WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    if force || rank(stage) > rank(&cur) {
        sqlx::query("UPDATE projects SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(stage)
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(())
}
