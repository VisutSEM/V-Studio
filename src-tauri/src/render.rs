use crate::{
    db::{self, AppState, Scene},
    error::CmdResult,
    pipeline::{each_scene, emit},
    subs,
};
use anyhow::{bail, Result};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tauri::{AppHandle, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
};

// Put NotoSansKhmer-Regular.ttf in src-tauri/fonts/ before building
static KHMER_FONT: &[u8] = include_bytes!("../fonts/NotoSansKhmer-Regular.ttf");

macro_rules! args {
    ($($a:expr),* $(,)?) => { vec![$(String::from($a)),*] };
}

/// Bundled sidecar next to the app executable, otherwise the one on PATH.
fn bin(name: &str) -> PathBuf {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(&exe)))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(name))
}

pub fn cmd(name: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(bin(name));
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // no console window
    c
}

fn tail(s: &str) -> String {
    let mut lines: Vec<&str> = s.lines().rev().take(8).collect();
    lines.reverse();
    lines.join("\n")
}

async fn run(name: &str, args: Vec<String>, cwd: &Path) -> Result<String> {
    let out = cmd(name)
        .args(&args)
        .current_dir(cwd)
        .kill_on_drop(true)
        .output()
        .await?;
    if !out.status.success() {
        bail!(
            "{name} failed:\n{}",
            tail(&String::from_utf8_lossy(&out.stderr))
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub async fn probe_ms(path: &Path) -> Result<i64> {
    let cwd = path.parent().unwrap_or(Path::new("."));
    let out = run(
        "ffprobe",
        args![
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            path.to_string_lossy()
        ],
        cwd,
    )
    .await?;
    Ok((out.trim().parse::<f64>()? * 1000.0).round() as i64)
}

pub fn default_output_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Videos").join("VideoGen");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Videos").join("VideoGen");
    }
    PathBuf::from(r"C:\VideoGen")
}

pub fn sanitize_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        "video".to_string()
    } else {
        trimmed.to_string()
    }
}

/// image + audio -> one clip with a slow zoom (in on even scenes, out on odd ones)
async fn clip(dir: &Path, sc: &Scene) -> Result<()> {
    let frames = subs::frames_for(sc.audio_ms.unwrap_or(0)).max(1);
    let secs = frames as f64 / subs::FPS as f64;
    let step = 0.15 / frames as f64;
    let z = if sc.idx % 2 == 0 {
        format!("min(zoom+{step:.6},1.15)")
    } else {
        format!("if(lte(on,1),1.15,max(zoom-{step:.6},1.0))")
    };
    let out = format!("clips/scene_{:03}.mp4", sc.idx);
    let tmp = format!("clips/scene_{:03}.part.mp4", sc.idx);

    let has_image = sc
        .image_path
        .as_deref()
        .map(|p| !p.trim().is_empty() && dir.join(p).exists())
        .unwrap_or(false);

    let mut args = args!["-y"];
    let vf = if has_image {
        let img = sc.image_path.as_deref().unwrap();
        args.extend(args!["-i", img]);
        format!(
            "scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,\
             zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s=1920x1080:fps={},format=yuv420p",
            subs::FPS
        )
    } else {
        args.extend(args![
            "-f",
            "lavfi",
            "-i",
            format!("color=c=black:s=1920x1080:r={}", subs::FPS)
        ]);
        "format=yuv420p".to_string()
    };

    let audio_file = sc.audio_path.as_deref().unwrap_or("");
    args.extend(args![
        "-i",
        audio_file,
        "-vf",
        vf,
        "-af",
        "apad",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-t",
        format!("{secs:.3}"),
        tmp.as_str()
    ]);

    run("ffmpeg", args, dir).await?;
    tokio::fs::rename(dir.join(&tmp), dir.join(&out)).await?;
    Ok(())
}

/// Final encode with `-progress` parsing so the UI can show a bar.
async fn run_final(
    app: &AppHandle,
    id: &str,
    args: Vec<String>,
    cwd: &Path,
    total_ms: i64,
) -> Result<()> {
    let mut child = cmd("ffmpeg")
        .args(["-progress", "pipe:1", "-nostats"])
        .args(&args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let total_s = (total_ms / 1000).max(1) as u32;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        if let Some(v) = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
        {
            if let Ok(us) = v.trim().parse::<i64>() {
                emit(
                    app,
                    id,
                    "encode",
                    ((us / 1_000_000).max(0) as u32).min(total_s),
                    total_s,
                    None,
                );
            }
        }
    }
    let status = child.wait().await?;
    let err = err_task.await.unwrap_or_default();
    if !status.success() {
        bail!("ffmpeg failed:\n{}", tail(&err));
    }
    Ok(())
}

#[tauri::command]
pub async fn render_video(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    ambient: Option<String>,
    subtitles: Option<bool>,
) -> CmdResult<Option<String>> {
    Ok(render(&app, &state, &id, ambient, subtitles).await?)
}

async fn render(
    app: &AppHandle,
    st: &AppState,
    id: &str,
    ambient: Option<String>,
    subtitles: Option<bool>,
) -> Result<Option<String>> {
    let scenes = db::scenes(&st.pool, id).await?;
    if scenes.is_empty() || scenes.iter().all(|s| s.audio_path.is_none()) {
        bail!("Generate voices for the scenes before rendering");
    }
    let mut cues = db::cues(&st.pool, id).await?;
    if cues.is_empty() {
        cues = subs::build_cues(&scenes);
        db::save_cues(&st.pool, id, &cues).await?;
    }

    let dir = st.project_dir(id);
    tokio::fs::create_dir_all(dir.join("clips")).await?;
    tokio::fs::create_dir_all(dir.join("fonts")).await?;
    tokio::fs::write(dir.join("fonts/NotoSansKhmer-Regular.ttf"), KHMER_FONT).await?;
    tokio::fs::write(dir.join("subs.ass"), subs::to_ass(&cues)).await?;
    tokio::fs::write(dir.join("subs.srt"), subs::to_srt(&cues)).await?;

    // 1. Clips (existing ones are reused; they are deleted when a scene's audio/image changes)
    let todo: Vec<Scene> = scenes
        .iter()
        .filter(|s| !dir.join(format!("clips/scene_{:03}.mp4", s.idx)).exists())
        .cloned()
        .collect();
    let failed = each_scene(app, id, "render", todo, 3, |sc| {
        let dir = dir.clone();
        async move { clip(&dir, &sc).await }
    })
    .await;
    if failed > 0 {
        bail!("{failed} clips failed to render, run Render again");
    }

    // 2. Concat all scene clips into 1 combined video + burn subtitles (if enabled) (+ optional looping ambient sound)
    let list: String = scenes
        .iter()
        .map(|s| format!("file 'clips/scene_{:03}.mp4'\n", s.idx))
        .collect();
    tokio::fs::write(dir.join("clips.txt"), list).await?;

    let s = crate::settings::load(app);
    let burn_subs = subtitles.unwrap_or(s.subtitles_enabled);

    let ass = "ass=subs.ass:fontsdir=fonts";
    let mut a = args!["-y", "-f", "concat", "-safe", "0", "-i", "clips.txt"];
    match ambient.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            a.extend(args!["-stream_loop", "-1", "-i", p]);
            if burn_subs {
                a.extend(args![
                    "-filter_complex",
                    format!("[0:v]{ass}[v];[1:a]volume=0.12[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]"),
                    "-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"
                ]);
            } else {
                a.extend(args![
                    "-filter_complex",
                    "[1:a]volume=0.12[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]",
                    "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"
                ]);
            }
        }
        None => {
            if burn_subs {
                a.extend(args!["-vf", ass, "-c:a", "copy"]);
            } else {
                a.extend(args!["-c:a", "copy"]);
            }
        }
    }
    a.extend(args![
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "final.mp4"
    ]);

    let total_ms: i64 = scenes
        .iter()
        .map(|s| subs::scene_ms(s.audio_ms.unwrap_or(0)))
        .sum();
    run_final(app, id, a, &dir, total_ms).await?;
    db::set_stage(&st.pool, id, "Rendered", false).await?;

    // Auto-export combined video to configured output_dir
    let out_dir = if !s.output_dir.trim().is_empty() {
        PathBuf::from(s.output_dir.trim())
    } else {
        default_output_dir()
    };

    let p = db::project(&st.pool, id).await?;
    let base_name = sanitize_filename(&p.name);
    let target_video = out_dir.join(format!("{base_name}.mp4"));
    let target_srt = out_dir.join(format!("{base_name}.srt"));

    let _ = tokio::fs::create_dir_all(&out_dir).await;
    let _ = tokio::fs::copy(dir.join("final.mp4"), &target_video).await;
    let _ = tokio::fs::copy(dir.join("subs.srt"), &target_srt).await;

    Ok(Some(target_video.to_string_lossy().to_string()))
}

/// Copies the combined final.mp4 (and subs.srt next to it) to the export destination or settings output_dir.
#[tauri::command]
pub async fn export_video(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    dest: Option<String>,
) -> CmdResult<String> {
    let dir = state.project_dir(&id);
    let final_src = dir.join("final.mp4");
    if !final_src.exists() {
        return Err(crate::error::err("Render the video first"));
    }

    let target_video = if let Some(d) = dest.filter(|d| !d.trim().is_empty()) {
        PathBuf::from(d)
    } else {
        let s = crate::settings::load(&app);
        let out_dir = if !s.output_dir.trim().is_empty() {
            PathBuf::from(s.output_dir.trim())
        } else {
            default_output_dir()
        };
        let p = db::project(&state.pool, &id).await?;
        let base_name = sanitize_filename(&p.name);
        out_dir.join(format!("{base_name}.mp4"))
    };

    if let Some(parent) = target_video.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    tokio::fs::copy(&final_src, &target_video)
        .await
        .map_err(|e| crate::error::err(&format!("Failed to export video: {e}")))?;

    let srt_dest = target_video.with_extension("srt");
    let _ = tokio::fs::copy(dir.join("subs.srt"), srt_dest).await;

    Ok(target_video.to_string_lossy().to_string())
}

/// Reveal or open the video output directory in Windows File Explorer.
#[tauri::command]
pub async fn open_output_dir(app: AppHandle, path: Option<String>) -> CmdResult<()> {
    let target = if let Some(p) = path.filter(|p| !p.trim().is_empty()) {
        PathBuf::from(p)
    } else {
        let s = crate::settings::load(&app);
        if !s.output_dir.trim().is_empty() {
            PathBuf::from(s.output_dir.trim())
        } else {
            default_output_dir()
        }
    };

    let _ = tokio::fs::create_dir_all(&target).await;

    #[cfg(windows)]
    {
        let mut c = std::process::Command::new("explorer");
        c.arg(&target);
        let _ = c.spawn();
    }

    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("open").arg(&target).spawn();
    }

    Ok(())
}
