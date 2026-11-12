//! Picks a text-to-speech engine for a project.
//!
//! The architecture doc routes every scene to VoxCPM 2 when the machine has a
//! capable NVIDIA GPU, and to Edge TTS otherwise. The probe is cached for the
//! lifetime of the app because `nvidia-smi` is relatively slow.

use crate::settings::{Settings, TtsKind};
use serde::Serialize;
use std::sync::OnceLock;

/// Default minimum VRAM for local VoxCPM 2 inference (the docs use 5.5 GB).
pub const DEFAULT_VRAM_THRESHOLD_GB: f32 = 5.5;

#[derive(Clone, Debug, Serialize)]
pub struct GpuProbe {
    pub has_nvidia: bool,
    pub name: Option<String>,
    pub vram_mb: u64,
    pub system_ram_mb: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct TtsRoute {
    /// Engine that will actually be used.
    pub engine: TtsKind,
    /// Engine requested in Settings (may be `auto`).
    pub requested: TtsKind,
    pub gpu_name: Option<String>,
    pub vram_mb: u64,
    pub vram_threshold_gb: f32,
    pub reason: String,
}

/// Probe NVIDIA once per process. Returns cached values afterwards.
pub fn gpu_probe() -> &'static GpuProbe {
    static PROBE: OnceLock<GpuProbe> = OnceLock::new();
    PROBE.get_or_init(|| {
        let (has_nvidia, name, vram_mb) = crate::voxcpm::detect_nvidia_gpu();
        GpuProbe {
            has_nvidia,
            name: if has_nvidia && !name.trim().is_empty() {
                Some(name)
            } else {
                None
            },
            vram_mb,
            system_ram_mb: crate::voxcpm::get_system_ram_mb(),
        }
    })
}

fn threshold_mb(threshold_gb: f32) -> u64 {
    (threshold_gb.max(0.0) * 1024.0).round() as u64
}

/// Pure routing decision, kept separate so it can be unit-tested.
pub fn choose(
    requested: TtsKind,
    has_nvidia: bool,
    vram_mb: u64,
    threshold_gb: f32,
) -> (TtsKind, String) {
    let threshold = threshold_mb(threshold_gb);
    match requested {
        TtsKind::Auto => {
            if has_nvidia && vram_mb >= threshold {
                (
                    TtsKind::VoxCpm,
                    format!(
                        "Auto: GPU has {} MB VRAM (threshold {} MB) — using local VoxCPM 2",
                        vram_mb, threshold
                    ),
                )
            } else if has_nvidia {
                (
                    TtsKind::EdgeTts,
                    format!(
                        "Auto: GPU has only {} MB VRAM (needs {} MB) — falling back to Edge TTS",
                        vram_mb, threshold
                    ),
                )
            } else {
                (
                    TtsKind::EdgeTts,
                    "Auto: no NVIDIA GPU detected — falling back to Edge TTS".to_string(),
                )
            }
        }
        TtsKind::VoxCpm => (
            TtsKind::VoxCpm,
            "VoxCPM 2 selected explicitly in Settings".to_string(),
        ),
        TtsKind::EdgeTts => (
            TtsKind::EdgeTts,
            "Edge TTS selected explicitly in Settings".to_string(),
        ),
        other => (other, format!("{other:?} selected explicitly in Settings")),
    }
}

/// Resolve the effective engine for a settings snapshot.
pub fn resolve(settings: &Settings) -> TtsRoute {
    let probe = gpu_probe();
    resolve_with(
        settings,
        probe.has_nvidia,
        probe.name.clone(),
        probe.vram_mb,
    )
}

/// Resolve with an injected GPU probe (used by tests and the UI command).
pub fn resolve_with(
    settings: &Settings,
    has_nvidia: bool,
    gpu_name: Option<String>,
    vram_mb: u64,
) -> TtsRoute {
    let threshold = if settings.voxcpm_vram_threshold_gb > 0.0 {
        settings.voxcpm_vram_threshold_gb
    } else {
        DEFAULT_VRAM_THRESHOLD_GB
    };
    let (engine, reason) = choose(settings.tts_kind, has_nvidia, vram_mb, threshold);
    TtsRoute {
        engine,
        requested: settings.tts_kind,
        gpu_name,
        vram_mb,
        vram_threshold_gb: threshold,
        reason,
    }
}

/// Effective engine for the pipeline (the rest of the app only needs this).
pub fn effective_kind(settings: &Settings) -> TtsKind {
    resolve(settings).engine
}

/// UI command: show what the router will do on this machine.
#[tauri::command]
pub fn get_tts_route(app: tauri::AppHandle) -> TtsRoute {
    resolve(&crate::settings::load(&app))
}

/// UI command: cached GPU probe for the settings badge.
#[tauri::command]
pub fn get_gpu_info() -> GpuProbe {
    gpu_probe().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(kind: TtsKind) -> Settings {
        let mut s = Settings::default();
        s.tts_kind = kind;
        s.voxcpm_vram_threshold_gb = 5.5;
        s
    }

    #[test]
    fn auto_uses_voxcpm_on_a_big_gpu() {
        let (engine, reason) = choose(TtsKind::Auto, true, 12_288, 5.5);
        assert_eq!(engine, TtsKind::VoxCpm);
        assert!(reason.contains("VoxCPM"));
    }

    #[test]
    fn auto_falls_back_on_a_small_gpu() {
        let (engine, reason) = choose(TtsKind::Auto, true, 4_096, 5.5);
        assert_eq!(engine, TtsKind::EdgeTts);
        assert!(reason.contains("falling back"));
    }

    #[test]
    fn auto_falls_back_without_a_gpu() {
        let (engine, _) = choose(TtsKind::Auto, false, 0, 5.5);
        assert_eq!(engine, TtsKind::EdgeTts);
    }

    #[test]
    fn explicit_engine_is_honoured() {
        let s = settings(TtsKind::EdgeTts);
        let route = resolve_with(&s, true, Some("RTX 4090".into()), 24_576);
        assert_eq!(route.engine, TtsKind::EdgeTts);
        assert_eq!(route.requested, TtsKind::EdgeTts);
    }

    #[test]
    fn custom_threshold_is_used() {
        let mut s = settings(TtsKind::Auto);
        s.voxcpm_vram_threshold_gb = 8.0;
        let route = resolve_with(&s, true, Some("RTX 3060".into()), 6_144);
        assert_eq!(route.engine, TtsKind::EdgeTts);
        assert_eq!(route.vram_threshold_gb, 8.0);
    }
}
