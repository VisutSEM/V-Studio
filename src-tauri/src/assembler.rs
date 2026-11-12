//! Writes the per-project manifest and merged narration track.
//!
//! The manifest is the resume/debug record described in ARCHITECTURE.md:
//! which engine ran, which GPU was used, and the status of every scene.

use crate::{
    audio_post,
    db::{Project, Scene},
    settings::TtsKind,
    tts_router::{self, TtsRoute},
};
use anyhow::{bail, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
struct ManifestScene {
    scene_id: i64,
    file: String,
    duration_s: f64,
    status: String,
}

#[derive(Serialize)]
struct Manifest {
    job_id: String,
    project: String,
    engine: String,
    gpu: tts_router::GpuProbe,
    scenes: Vec<ManifestScene>,
}

pub fn engine_name(kind: TtsKind) -> &'static str {
    match kind {
        TtsKind::Auto => "auto",
        TtsKind::VoxCpm => "voxcpm2",
        TtsKind::EdgeTts => "edge",
        TtsKind::Azure => "azure",
        TtsKind::KiriTts => "kiri_tts",
        TtsKind::MetaMms => "meta_mms",
        TtsKind::GptSovits => "gpt_sovits",
    }
}

/// Write `manifest.json` and, when scene audio exists, `merged.wav`.
pub async fn finalize(
    dir: &Path,
    project: &Project,
    scenes: &[Scene],
    route: &TtsRoute,
) -> Result<()> {
    let mut files = Vec::new();
    let mut entries = Vec::new();

    for sc in scenes {
        let (file, status) = match sc.audio_path.as_deref() {
            Some(rel) if dir.join(rel).exists() => {
                files.push(rel.replace('\\', "/"));
                (rel.to_string(), "ok".to_string())
            }
            Some(rel) => (rel.to_string(), "missing".to_string()),
            None => (String::new(), "pending".to_string()),
        };
        entries.push(ManifestScene {
            scene_id: sc.idx + 1,
            file,
            duration_s: sc.audio_ms.unwrap_or(0) as f64 / 1000.0,
            status,
        });
    }

    let manifest = Manifest {
        job_id: project.id.clone(),
        project: project.name.clone(),
        engine: engine_name(route.engine).to_string(),
        gpu: tts_router::gpu_probe().clone(),
        scenes: entries,
    };
    tokio::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )
    .await?;

    if files.is_empty() {
        bail!("assembler: no scene audio to merge");
    }
    audio_post::merge_scenes(dir, &files).await?;
    Ok(())
}
