use crate::error::CmdResult;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "videogen";
const LLM_KEY: &str = "llm_api_key";
const CF_KEY: &str = "cf_api_token";
const AZURE_KEY: &str = "azure_tts_key";
const KIRI_KEY: &str = "kiri_tts_key";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum LlmKind {
    Gemini,
    OpenAi,
    Anthropic,
    OpenAiCompatible, // OpenRouter, DeepSeek, Groq, Ollama, ...
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TtsKind {
    Azure,
    GptSovits,
    #[serde(rename = "voxcpm")]
    VoxCpm,
    #[serde(rename = "edge_tts")]
    EdgeTts,
    #[serde(rename = "meta_mms")]
    MetaMms,
    #[serde(rename = "kiri_tts")]
    KiriTts,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub llm_kind: LlmKind,
    pub llm_model: String,
    pub llm_base_url: String, // only for OpenAiCompatible
    pub cf_account_id: String,
    pub cf_image_model: String,
    // Voice
    pub tts_kind: TtsKind,
    pub azure_region: String,
    // Kiri TTS (Blizzer kiritts.com OpenAI-compatible endpoint)
    pub kiri_base_url: String,
    pub kiri_model: String,
    pub kiri_voice: String,
    pub kiri_speed: f32,
    // GPT-SoVITS local API (api_v2.py, POST /tts)
    pub gpt_sovits_url: String,
    pub gpt_sovits_ref_audio: String,
    pub gpt_sovits_prompt_text: String,
    pub gpt_sovits_prompt_lang: String,
    pub gpt_sovits_text_lang: String,
    pub gpt_sovits_speed: f32,
    // VoxCPM 2 local server (OpenAI-compatible POST /v1/audio/speech)
    pub voxcpm_url: String,
    pub voxcpm_model: String,
    pub voxcpm_description: String,
    pub voxcpm_ref_audio: String,
    pub voxcpm_ref_text: String,
    pub voxcpm_cfg: f32,
    pub voxcpm_steps: u32,
    pub voxcpm_device: String,
    // Subtitles in video
    pub subtitles_enabled: bool,
    // Video Output / Export directory
    pub output_dir: String,
    // Appearance: "system" | "light" | "dark"
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            llm_kind: LlmKind::Gemini,
            llm_model: "gemini-2.5-flash".into(),
            llm_base_url: String::new(),
            cf_account_id: String::new(),
            cf_image_model: "@cf/black-forest-labs/flux-1-schnell".into(),
            tts_kind: TtsKind::Azure,
            azure_region: "southeastasia".into(),
            kiri_base_url: "https://api.kiritts.com/v1".into(),
            kiri_model: "kiritts".into(),
            kiri_voice: "Maly".into(),
            kiri_speed: 1.0,
            gpt_sovits_url: "http://127.0.0.1:9880".into(),
            gpt_sovits_ref_audio: String::new(),
            gpt_sovits_prompt_text: String::new(),
            gpt_sovits_prompt_lang: "en".into(),
            gpt_sovits_text_lang: "auto".into(),
            gpt_sovits_speed: 1.0,
            voxcpm_url: "http://127.0.0.1:8000".into(),
            voxcpm_model: "openbmb/VoxCPM2".into(),
            voxcpm_description: String::new(),
            voxcpm_ref_audio: String::new(),
            voxcpm_ref_text: String::new(),
            voxcpm_cfg: 2.0,
            voxcpm_steps: 10,
            voxcpm_device: "auto".into(),
            subtitles_enabled: true,
            output_dir: crate::render::default_output_dir().to_string_lossy().to_string(),
            theme: "system".into(),
        }
    }
}

#[derive(Serialize)]
pub struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    has_llm_key: bool,
    has_cf_token: bool,
    has_azure_key: bool,
    has_kiri_key: bool,
}

fn file(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    file(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn secret_get(name: &str) -> Result<String> {
    keyring::Entry::new(SERVICE, name)?
        .get_password()
        .map_err(|_| anyhow!("Missing {name}. Save it in Settings."))
}

fn secret_set(name: &str, value: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, name)?.set_password(value)?;
    Ok(())
}

pub fn llm_key() -> Result<String> {
    secret_get(LLM_KEY)
}
pub fn cf_token() -> Result<String> {
    secret_get(CF_KEY)
}
pub fn azure_key() -> Result<String> {
    secret_get(AZURE_KEY)
}
pub fn kiri_key() -> Result<String> {
    secret_get(KIRI_KEY)
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> SettingsView {
    SettingsView {
        settings: load(&app),
        has_llm_key: secret_get(LLM_KEY).is_ok(),
        has_cf_token: secret_get(CF_KEY).is_ok(),
        has_azure_key: secret_get(AZURE_KEY).is_ok(),
        has_kiri_key: secret_get(KIRI_KEY).is_ok(),
    }
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    settings: Settings,
    llm_api_key: Option<String>,
    cf_api_token: Option<String>,
    azure_tts_key: Option<String>,
    kiri_tts_key: Option<String>,
) -> CmdResult<()> {
    fs::write(file(&app)?, serde_json::to_string_pretty(&settings)?)?;
    // A secret is overwritten only when a new value is typed
    for (name, val) in [
        (LLM_KEY, llm_api_key),
        (CF_KEY, cf_api_token),
        (AZURE_KEY, azure_tts_key),
        (KIRI_KEY, kiri_tts_key),
    ] {
        if let Some(v) = val.filter(|v| !v.trim().is_empty()) {
            secret_set(name, v.trim())?;
        }
    }
    Ok(())
}

/// Test can run against the values currently typed in the form: a non-empty
/// `api_key` wins over the saved one, and `settings` wins over the saved config.
fn override_key(api_key: Option<String>, saved: fn() -> Result<String>) -> Result<String> {
    match api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => Ok(k),
        None => saved(),
    }
}

#[tauri::command]
pub async fn test_llm(
    app: AppHandle,
    settings: Option<Settings>,
    api_key: Option<String>,
) -> CmdResult<String> {
    let s = settings.unwrap_or_else(|| load(&app));
    let key = override_key(api_key, llm_key)?;
    Ok(crate::ai::llm_generate(
        &s,
        &key,
        "Reply with the single word OK.",
        "ping",
        false,
    )
    .await?)
}

#[tauri::command]
pub async fn test_image(
    app: AppHandle,
    settings: Option<Settings>,
    api_key: Option<String>,
) -> CmdResult<usize> {
    let s = settings.unwrap_or_else(|| load(&app));
    let key = override_key(api_key, cf_token)?;
    let bytes = crate::ai::cf_image(&s, &key, "a red circle, flat 2D cartoon").await?;
    Ok(bytes.len())
}

#[derive(Serialize)]
pub struct TestTtsResult {
    pub len: usize,
    pub audio_base64: String,
    pub mime: String,
}

#[tauri::command]
pub async fn test_tts(
    app: AppHandle,
    settings: Option<Settings>,
    api_key: Option<String>,
    text: Option<String>,
) -> CmdResult<TestTtsResult> {
    let s = settings.unwrap_or_else(|| load(&app));
    let test_text = text
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or("ការសាកសំឡេង");
    let is_english = test_text.chars().any(|c| c.is_ascii_alphabetic())
        && !test_text.chars().any(|c| ('\u{1780}'..='\u{17FF}').contains(&c));
    let lang = if is_english { "en" } else { "km" };
    let voice = match s.tts_kind {
        TtsKind::Azure | TtsKind::EdgeTts => {
            if is_english {
                "en-US-JennyNeural"
            } else {
                "km-KH-SreymomNeural"
            }
        }
        TtsKind::KiriTts => {
            if !s.kiri_voice.trim().is_empty() {
                s.kiri_voice.trim()
            } else {
                "Maly"
            }
        }
        TtsKind::MetaMms | TtsKind::VoxCpm | TtsKind::GptSovits => "",
    };
    let key = match s.tts_kind {
        TtsKind::Azure => Some(override_key(api_key, azure_key)?),
        TtsKind::KiriTts => Some(override_key(api_key, kiri_key)?),
        TtsKind::EdgeTts | TtsKind::MetaMms | TtsKind::GptSovits | TtsKind::VoxCpm => None,
    };
    let bytes = crate::ai::tts(&s, key.as_deref(), voice, test_text, lang, false).await?;
    let mime = if bytes.starts_with(b"RIFF") {
        "audio/wav"
    } else {
        "audio/mpeg"
    };
    let audio_base64 = STANDARD.encode(&bytes);
    Ok(TestTtsResult {
        len: bytes.len(),
        audio_base64,
        mime: mime.into(),
    })
}
