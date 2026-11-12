//! Audio post-processing and merged-track assembly.
//!
//! Every generated scene goes through the same chain: trim leading/trailing
//! silence, normalise loudness, and resample to 48 kHz mono PCM. That keeps
//! scene clips interchangeable and makes the final concat predictable.

use crate::render::cmd;
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

pub const SAMPLE_RATE: u32 = 48_000;
pub const PAUSE_MS: u32 = 350;

/// FFmpeg filter chain used for every scene.
pub const NORMALIZE_FILTER: &str = "silenceremove=start_periods=1:start_silence=0.10:start_threshold=-50dB:stop_periods=1:stop_silence=0.10:stop_threshold=-50dB,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000";

fn tail(s: &str) -> String {
    let mut lines: Vec<&str> = s.lines().rev().take(8).collect();
    lines.reverse();
    lines.join("\n")
}

async fn run_ffmpeg(args: Vec<String>, cwd: &Path) -> Result<()> {
    let out = cmd("ffmpeg")
        .args(&args)
        .current_dir(cwd)
        .kill_on_drop(true)
        .output()
        .await?;
    if !out.status.success() {
        bail!(
            "ffmpeg audio post failed:\n{}",
            tail(&String::from_utf8_lossy(&out.stderr))
        );
    }
    Ok(())
}

/// Trim silence, normalise loudness, and write a 48 kHz mono WAV.
pub async fn normalize(input: &Path, output: &Path) -> Result<()> {
    if !input.exists() {
        bail!("audio post: input does not exist: {}", input.display());
    }
    let cwd = output.parent().unwrap_or(Path::new("."));
    if let Some(parent) = output.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    run_ffmpeg(
        vec![
            "-y".into(),
            "-i".into(),
            input.to_string_lossy().into_owned(),
            "-af".into(),
            NORMALIZE_FILTER.into(),
            "-ar".into(),
            SAMPLE_RATE.to_string(),
            "-ac".into(),
            "1".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            output.to_string_lossy().into_owned(),
        ],
        cwd,
    )
    .await?;

    let meta = tokio::fs::metadata(output).await?;
    if meta.len() == 0 {
        bail!("audio post produced an empty file: {}", output.display());
    }
    Ok(())
}

/// Build `merged.wav` from the per-scene WAVs with a short pause between them.
pub async fn merge_scenes(dir: &Path, scene_files: &[String]) -> Result<PathBuf> {
    if scene_files.is_empty() {
        bail!("audio post: no scene audio to merge");
    }
    run_ffmpeg(
        vec![
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("anullsrc=r={SAMPLE_RATE}:cl=mono"),
            "-t".into(),
            format!("{:.3}", PAUSE_MS as f64 / 1000.0),
            "-c:a".into(),
            "pcm_s16le".into(),
            "pause.wav".into(),
        ],
        dir,
    )
    .await?;

    let mut list = String::new();
    for (i, file) in scene_files.iter().enumerate() {
        list.push_str(&format!("file '{}'\n", file.replace('\\', "/")));
        if i + 1 < scene_files.len() {
            list.push_str("file 'pause.wav'\n");
        }
    }
    let list_path = dir.join("merged.txt");
    tokio::fs::write(&list_path, list).await?;

    let merged = dir.join("merged.wav");
    run_ffmpeg(
        vec![
            "-y".into(),
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            "merged.txt".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            "merged.wav".into(),
        ],
        dir,
    )
    .await?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_chain_is_48k_and_normalised() {
        assert!(NORMALIZE_FILTER.contains("aresample=48000"));
        assert!(NORMALIZE_FILTER.contains("loudnorm"));
        assert!(NORMALIZE_FILTER.contains("silenceremove"));
    }

    #[test]
    fn pause_is_350ms() {
        assert_eq!(PAUSE_MS, 350);
    }
}
