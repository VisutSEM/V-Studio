use crate::settings::{LlmKind, Settings, TtsKind};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn human_duration(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m")
    } else {
        format!("{s}s")
    }
}

/// Turn a provider error body into a short, actionable message.
fn provider_error(status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    let v: Option<Value> = serde_json::from_str(body).ok();
    // OpenAI/Anthropic/Gemini use error.message; GPT-SoVITS uses message + Exception.
    let detail = v
        .as_ref()
        .and_then(|v| {
            let msg = v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v["message"].as_str());
            let extra = v["Exception"].as_str();
            match (msg, extra) {
                (Some(m), Some(e)) => Some(format!("{m}: {e}")),
                (Some(m), None) => Some(m.to_string()),
                (None, Some(e)) => Some(e.to_string()),
                (None, None) => None,
            }
        })
        .unwrap_or_else(|| body.to_string());
    let short: String = detail.trim().chars().take(500).collect();

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let mut model = None;
        let mut limit = None;
        let mut retry_secs = None;
        if let Some(details) = v.as_ref().and_then(|v| v["error"]["details"].as_array()) {
            for d in details {
                if retry_secs.is_none() {
                    retry_secs = d["retryDelay"]
                        .as_str()
                        .and_then(|s| s.trim_end_matches('s').parse::<u64>().ok());
                }
                if let Some(violations) = d["violations"].as_array() {
                    for viol in violations {
                        if model.is_none() {
                            model = viol["quotaDimensions"]["model"].as_str().map(str::to_owned);
                        }
                        if limit.is_none() {
                            limit = viol["quotaValue"].as_str().map(str::to_owned);
                        }
                    }
                }
            }
        }
        let quota = model.is_some() || limit.is_some();

        let mut msg = String::from("Rate limit / quota exceeded (HTTP 429)");
        if let Some(m) = model {
            msg.push_str(&format!(" for model {m}"));
        }
        if let Some(l) = limit {
            msg.push_str(&format!(" — free tier: {l} requests/day"));
        }
        if let Some(secs) = retry_secs {
            msg.push_str(&format!(". Retry in about {}", human_duration(secs)));
        }
        if quota {
            msg.push_str(
                ". Fix: choose another model in Settings (each Gemini model has its own daily \
                 quota), wait for the reset, enable billing on the Google Cloud project, use a key \
                 from a different project, or switch provider. Docs: https://ai.dev/rate-limit",
            );
        } else {
            msg.push_str(
                ". Wait a moment and retry; if it keeps happening, check your provider's plan \
                 and billing.",
            );
        }
        return anyhow!(msg);
    }

    anyhow!("HTTP {status}: {short}")
}

async fn send_json(req: reqwest::RequestBuilder) -> Result<Value> {
    let res = req.send().await?;
    let status = res.status();
    let body = res.text().await?;
    if !status.is_success() {
        return Err(provider_error(status, &body));
    }
    Ok(serde_json::from_str(&body)?)
}

/// `json_mode` asks Gemini/OpenAI for strict JSON output.
pub async fn llm_generate(
    s: &Settings,
    key: &str,
    system: &str,
    user: &str,
    json_mode: bool,
) -> Result<String> {
    let client = reqwest::Client::new();

    let text = match s.llm_kind {
        LlmKind::Gemini => {
            let model_raw = s.llm_model.trim();
            let model_clean = model_raw.strip_prefix("models/").unwrap_or(model_raw);
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                model_clean
            );
            let mut body = json!({
                "systemInstruction": { "parts": [{ "text": system }] },
                "contents": [{ "role": "user", "parts": [{ "text": user }] }]
            });
            if json_mode {
                body["generationConfig"] = json!({ "responseMimeType": "application/json" });
            }
            let v = send_json(client.post(url).header("x-goog-api-key", key).json(&body)).await?;
            v["candidates"][0]["content"]["parts"].as_array().map(|ps| {
                ps.iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<String>()
            })
        }
        LlmKind::Anthropic => {
            let v = send_json(
                client
                    .post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01")
                    .json(&json!({
                        "model": s.llm_model,
                        "max_tokens": 8192,
                        "system": system,
                        "messages": [{ "role": "user", "content": user }]
                    })),
            )
            .await?;
            v["content"][0]["text"].as_str().map(str::to_owned)
        }
        LlmKind::OpenAi | LlmKind::OpenAiCompatible => {
            let base = if s.llm_kind == LlmKind::OpenAi {
                "https://api.openai.com/v1".to_string()
            } else {
                s.llm_base_url.trim_end_matches('/').to_string()
            };
            if base.is_empty() {
                bail!("Base URL is required for OpenAI-compatible providers");
            }
            let mut body = json!({
                "model": s.llm_model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user }
                ]
            });
            if json_mode && s.llm_kind == LlmKind::OpenAi {
                body["response_format"] = json!({ "type": "json_object" });
            }
            let v = send_json(
                client
                    .post(format!("{base}/chat/completions"))
                    .bearer_auth(key)
                    .json(&body),
            )
            .await?;
            v["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_owned)
        }
    };

    text.filter(|t| !t.trim().is_empty())
        .ok_or_else(|| anyhow!("Empty response from the model (it may have blocked the content)"))
}

/// Cloudflare Workers AI text-to-image. Returns image bytes (jpeg or png).
pub async fn cf_image(s: &Settings, token: &str, prompt: &str) -> Result<Vec<u8>> {
    if s.cf_account_id.trim().is_empty() {
        bail!("Cloudflare Account ID is required");
    }
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/ai/run/{}",
        s.cf_account_id.trim(),
        s.cf_image_model
    );
    let mut body = json!({ "prompt": prompt });
    if s.cf_image_model.contains("flux") {
        body["steps"] = json!(4);
    }

    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
    let status = res.status();
    let is_image = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map_or(false, |v| v.starts_with("image/"));

    if !status.is_success() {
        return Err(provider_error(status, &res.text().await?));
    }
    if is_image {
        return Ok(res.bytes().await?.to_vec()); // Stable Diffusion models
    }
    let v: Value = res.json().await?; // FLUX: base64 inside JSON
    let b64 = v["result"]["image"]
        .as_str()
        .ok_or_else(|| anyhow!("No image in response: {v}"))?;
    Ok(STANDARD.decode(b64)?)
}

/// Azure Neural TTS. `slow` adds a slower, lower voice for horror narration.
pub async fn azure_tts(
    region: &str,
    key: &str,
    voice: &str,
    text: &str,
    slow: bool,
) -> Result<Vec<u8>> {
    let lang = voice.splitn(3, '-').take(2).collect::<Vec<_>>().join("-");
    let esc = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let body = if slow {
        format!("<prosody rate='-10%' pitch='-2st'>{esc}</prosody>")
    } else {
        esc
    };
    let ssml = format!(
        "<speak version='1.0' xml:lang='{lang}'><voice name='{voice}'>{body}</voice></speak>"
    );

    let res = reqwest::Client::new()
        .post(format!(
            "https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
        ))
        .header("Ocp-Apim-Subscription-Key", key)
        .header("Content-Type", "application/ssml+xml")
        .header(
            "X-Microsoft-OutputFormat",
            "audio-24khz-96kbitrate-mono-mp3",
        )
        .header("User-Agent", "videogen")
        .body(ssml)
        .send()
        .await?;
    let status = res.status();
    if !status.is_success() {
        return Err(provider_error(status, &res.text().await?));
    }
    Ok(res.bytes().await?.to_vec())
}

/// File extension that matches returned audio bytes.
pub fn audio_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"RIFF") {
        "wav"
    } else {
        "mp3"
    }
}

/// Text-to-speech with the configured engine. `slow` suits horror narration.
pub async fn tts(
    s: &Settings,
    azure_key: Option<&str>,
    voice: &str,
    text: &str,
    lang: &str,
    slow: bool,
) -> Result<Vec<u8>> {
    match s.tts_kind {
        TtsKind::Auto => match crate::tts_router::effective_kind(s) {
            TtsKind::VoxCpm => voxcpm(s, voice, text, lang, slow).await,
            _ => {
                let v = if !voice.trim().is_empty() {
                    voice
                } else if lang == "en" {
                    &s.edge_voice_en
                } else {
                    &s.edge_voice_km
                };
                edge_tts(v, text, slow, s.edge_speed, s.edge_pitch).await
            }
        },
        TtsKind::VoxCpm => voxcpm(s, voice, text, lang, slow).await,
        TtsKind::Azure => {
            let key = azure_key
                .ok_or_else(|| anyhow!("Missing Azure speech key. Save it in Settings."))?;
            azure_tts(&s.azure_region, key, voice, text, slow).await
        }
        TtsKind::KiriTts => {
            let key = azure_key
                .ok_or_else(|| anyhow!("Missing Kiri TTS API key. Save it in Settings."))?;
            kiri_tts(s, key, voice, text, slow).await
        }
        TtsKind::EdgeTts => {
            let v = if !voice.trim().is_empty() {
                voice
            } else if lang == "en" {
                &s.edge_voice_en
            } else {
                &s.edge_voice_km
            };
            edge_tts(v, text, slow, s.edge_speed, s.edge_pitch).await
        }
        TtsKind::MetaMms => meta_mms(text, slow).await,
        TtsKind::GptSovits => gpt_sovits(s, text, lang, slow).await,
    }
}

fn find_workspace_root() -> Option<PathBuf> {
    if let Ok(cwd) = std::env::current_dir() {
        for dir in cwd.ancestors() {
            if dir.join("tools").join("tts_cli.py").exists() {
                return Some(dir.to_path_buf());
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for dir in exe.ancestors() {
            if dir.join("tools").join("tts_cli.py").exists() {
                return Some(dir.to_path_buf());
            }
        }
    }
    let fallback = PathBuf::from(r"D:\videogen");
    if fallback.join("tools").join("tts_cli.py").exists() {
        return Some(fallback);
    }
    None
}

fn find_python(root: &Path) -> PathBuf {
    for venv_name in [".venv", ".venv-voxcpm", "venv"] {
        let venv_py = root.join(venv_name).join("Scripts").join("python.exe");
        if venv_py.exists() {
            return venv_py;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for venv_name in [".venv", ".venv-voxcpm", "venv", "python"] {
                let p = parent.join(venv_name).join("Scripts").join("python.exe");
                if p.exists() {
                    return p;
                }
                let p2 = parent.join(venv_name).join("python.exe");
                if p2.exists() {
                    return p2;
                }
            }
        }
    }
    PathBuf::from("python")
}

async fn run_tts_cli(
    engine: &str,
    voice: &str,
    text: &str,
    slow: bool,
    speed: &str,
    pitch: &str,
) -> Result<Vec<u8>> {
    let root = find_workspace_root()
        .ok_or_else(|| anyhow!("Could not locate VideoGen workspace or tools/tts_cli.py"))?;
    let python = find_python(&root);
    let cli_script = root.join("tools").join("tts_cli.py");
    if !cli_script.exists() {
        bail!("tools/tts_cli.py not found at {}", cli_script.display());
    }

    let ext = if engine == "edge_tts" { "mp3" } else { "wav" };
    let temp_out = std::env::temp_dir().join(format!("videogen_{}_{}.{}", engine, uuid::Uuid::new_v4(), ext));

    let mut cmd = tokio::process::Command::new(python);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.arg(&cli_script)
        .arg("--engine").arg(engine)
        .arg("--text").arg(text)
        .arg("--out").arg(&temp_out);

    if !voice.is_empty() {
        cmd.arg("--voice").arg(voice);
    }
    if slow {
        cmd.arg("--slow");
    }
    if !speed.is_empty() {
        cmd.arg("--speed").arg(speed);
    }
    if !pitch.is_empty() {
        cmd.arg("--pitch").arg(pitch);
    }

    let output = cmd.output().await?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        bail!("{engine} failed: {err}");
    }

    let bytes = tokio::fs::read(&temp_out).await?;
    let _ = tokio::fs::remove_file(&temp_out).await;
    Ok(bytes)
}

/// Microsoft Edge TTS (free Azure neural speech).
pub async fn edge_tts(
    voice: &str,
    text: &str,
    slow: bool,
    speed_pct: i32,
    pitch_hz: i32,
) -> Result<Vec<u8>> {
    let clean_text = normalize_khmer_text(text);
    let voice_name = if voice.trim().is_empty() {
        "km-KH-SreymomNeural"
    } else {
        voice.trim()
    };
    let speed_arg = if speed_pct >= 0 {
        format!("+{speed_pct}%")
    } else {
        format!("{speed_pct}%")
    };
    let pitch_arg = if pitch_hz >= 0 {
        format!("+{pitch_hz}Hz")
    } else {
        format!("{pitch_hz}Hz")
    };
    run_tts_cli("edge_tts", voice_name, &clean_text, slow, &speed_arg, &pitch_arg).await
}

/// Meta MMS (Massively Multilingual Speech - fast local CPU).
pub async fn meta_mms(
    text: &str,
    slow: bool,
) -> Result<Vec<u8>> {
    let clean_text = normalize_khmer_text(text);
    run_tts_cli("meta_mms", "", &clean_text, slow, "", "").await
}

/// Kiri TTS (Blizzer - Khmer/English neural TTS API via OpenAI-compatible endpoint).
pub async fn kiri_tts(
    s: &Settings,
    api_key: &str,
    voice: &str,
    text: &str,
    slow: bool,
) -> Result<Vec<u8>> {
    let base = if s.kiri_base_url.trim().is_empty() {
        "https://api.kiritts.com/v1"
    } else {
        s.kiri_base_url.trim().trim_end_matches('/')
    };
    let voice_name = if !voice.trim().is_empty() {
        voice.trim()
    } else if !s.kiri_voice.trim().is_empty() {
        s.kiri_voice.trim()
    } else {
        "Maly"
    };
    let model = if !s.kiri_model.trim().is_empty() {
        s.kiri_model.trim()
    } else {
        "kiritts"
    };
    let speed = if slow {
        (s.kiri_speed * 0.85).max(0.25)
    } else if s.kiri_speed > 0.0 {
        s.kiri_speed
    } else {
        1.0
    };

    let url = format!("{base}/audio/speech");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()?;

    let body = json!({
        "model": model,
        "input": text,
        "voice": voice_name,
        "response_format": "mp3",
        "speed": speed,
    });

    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = res.status();
    if !status.is_success() {
        let err_body = res.text().await.unwrap_or_default();
        return Err(provider_error(status, &err_body));
    }

    let bytes = res.bytes().await?;
    if bytes.is_empty() {
        bail!("Kiri TTS returned empty audio response");
    }
    Ok(bytes.to_vec())
}

/// Normalize the URL typed in Settings: add `http://` if missing and accept a
/// full `.../tts` URL by trimming it back to the server root.
fn gpt_sovits_base(url: &str) -> String {
    let mut base = url.trim().trim_end_matches('/').to_string();
    if let Some(root) = base.strip_suffix("/tts") {
        base = root.trim_end_matches('/').to_string();
    }
    if !base.is_empty() && !base.starts_with("http://") && !base.starts_with("https://") {
        base = format!("http://{base}");
    }
    base
}

/// GPT-SoVITS local API (api_v2.py). Clones the configured reference voice.
pub async fn gpt_sovits(s: &Settings, text: &str, lang: &str, slow: bool) -> Result<Vec<u8>> {
    let base = gpt_sovits_base(&s.gpt_sovits_url);
    if base.is_empty() {
        bail!("GPT-SoVITS server URL is missing (Settings → Voice)");
    }
    let ref_audio = s.gpt_sovits_ref_audio.trim();
    if ref_audio.is_empty() {
        bail!("GPT-SoVITS reference audio is missing (Settings → Voice)");
    }
    if s.gpt_sovits_prompt_text.trim().is_empty() {
        bail!("GPT-SoVITS prompt text is missing — it must match the reference audio exactly");
    }

    let text_lang = if s.gpt_sovits_text_lang.trim().is_empty() {
        if lang == "en" {
            "en"
        } else {
            "auto"
        }
    } else {
        s.gpt_sovits_text_lang.trim()
    };
    let speed = if slow {
        s.gpt_sovits_speed * 0.9
    } else {
        s.gpt_sovits_speed
    };

    let body = json!({
        "text": text,
        "text_lang": text_lang,
        "ref_audio_path": ref_audio,
        "prompt_text": s.gpt_sovits_prompt_text.trim(),
        "prompt_lang": s.gpt_sovits_prompt_lang,
        "text_split_method": "cut5",
        "batch_size": 1,
        "speed_factor": speed,
        "media_type": "wav",
        "streaming_mode": false,
    });

    let res = reqwest::Client::new()
        .post(format!("{base}/tts"))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let problem = if e.is_connect() {
                format!(
                    "nothing is listening on {base} (connection refused). The API server is not \
                     running, or it is bound to a different address/port. In the GPT-SoVITS \
                     folder start it in a second terminal and keep it open: \
                     `python api_v2.py -a 127.0.0.1 -p 9880`. The GPT-SoVITS WebUI is not the \
                     API server, so running the WebUI alone is not enough."
                )
            } else if e.is_timeout() {
                format!(
                    "the request to {base} timed out. The server may still be loading its \
                     models — check its console, then try again."
                )
            } else {
                format!(
                    "the request to {base} failed. Is the GPT-SoVITS API server running \
                     (`python api_v2.py -a 127.0.0.1 -p 9880`)?"
                )
            };
            anyhow!("Could not reach GPT-SoVITS: {problem} Details: {e:#}")
        })?;
    let status = res.status();
    if !status.is_success() {
        return Err(provider_error(status, &res.text().await?));
    }
    Ok(res.bytes().await?.to_vec())
}

/// Normalize the URL typed in Settings: add `http://` if missing and accept a
/// full `/v1/audio/speech` or `/v1` endpoint by trimming it back to the root.
fn voxcpm_base(url: &str) -> String {
    let mut base = url.trim().trim_end_matches('/').to_string();
    for suffix in ["/v1/audio/speech", "/audio/speech", "/v1"] {
        if let Some(root) = base.strip_suffix(suffix) {
            base = root.trim_end_matches('/').to_string();
            break;
        }
    }
    if !base.is_empty() && !base.starts_with("http://") && !base.starts_with("https://") {
        base = format!("http://{base}");
    }
    base
}

/// MIME type for a reference clip, used when inlining it as a data URL.
fn audio_mime(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        _ => "audio/wav",
    }
}

fn edge_voice_for(lang: &str, voice: &str, slow: bool) -> String {
    let requested = voice.trim();
    if requested.starts_with("km-") || requested.starts_with("en-") {
        return requested.to_string();
    }
    if lang == "km" {
        "km-KH-SreymomNeural".to_string()
    } else if slow {
        "en-US-GuyNeural".to_string()
    } else {
        "en-US-JennyNeural".to_string()
    }
}

/// Last-resort synthesis when the local VoxCPM 2 server is unavailable.
async fn voxcpm_fallback(
    voice: &str,
    text: &str,
    lang: &str,
    slow: bool,
) -> Result<Vec<u8>> {
    let edge_voice = edge_voice_for(lang, voice, slow);
    match edge_tts(&edge_voice, text, slow, 0, 0).await {
        Ok(bytes) => Ok(bytes),
        Err(edge_err) if lang == "km" => meta_mms(text, slow)
            .await
            .map_err(|mms_err| anyhow!("Edge TTS failed ({edge_err}); Meta MMS failed ({mms_err})")),
        Err(edge_err) => Err(edge_err),
    }
}

/// VoxCPM 2 through its OpenAI-compatible `POST /v1/audio/speech` endpoint.
///
/// `voxcpm_mode` follows VOXCPM2_BEST_SETTINGS.md:
/// - `design`: `(voice description)` prefix, no reference audio.
/// - `clone_controllable`: reference audio + `(style)` prefix.
/// - `clone_ultimate`: reference audio + exact transcript.
/// - `auto`: clone when a reference clip exists, otherwise design.
pub async fn voxcpm(s: &Settings, voice: &str, text: &str, lang: &str, slow: bool) -> Result<Vec<u8>> {
    let clean_text = normalize_khmer_text(text);
    if clean_text.trim().is_empty() {
        bail!("VoxCPM 2: narration text is empty");
    }

    let base = voxcpm_base(&s.voxcpm_url);
    if base.is_empty() {
        bail!("VoxCPM 2 server URL is missing (Settings → Voice)");
    }

    let requested_mode = s.voxcpm_mode.trim().to_ascii_lowercase();
    let custom_ref = s.voxcpm_ref_audio.trim();
    let mut ref_path: Option<PathBuf> = if !custom_ref.is_empty() && Path::new(custom_ref).exists() {
        Some(PathBuf::from(custom_ref))
    } else if let Some(root) = crate::voxcpm::VoxCpmManager::find_workspace_root() {
        let bundled = root.join("tools").join("voices").join("khmer_mrr_piseth_16k.wav");
        if bundled.exists() {
            Some(bundled)
        } else {
            None
        }
    } else {
        None
    };

    let mode = match requested_mode.as_str() {
        "clone_ultimate" | "clone_controllable" | "design" => requested_mode.as_str(),
        _ if ref_path.is_some() => "clone_ultimate",
        _ => "design",
    };

    // Design mode must not send a reference clip; cloning modes need one.
    if mode == "design" {
        ref_path = None;
    }
    if mode != "design" && ref_path.is_none() {
        // No usable reference: degrade to voice design instead of failing.
        ref_path = None;
    }

    let style = if s.voxcpm_description.trim().is_empty() {
        "a clear, natural adult narrator"
    } else {
        s.voxcpm_description.trim()
    };
    let input = if mode == "clone_ultimate" {
        clean_text.clone()
    } else {
        format!("({style}){clean_text}")
    };

    let model = if s.voxcpm_model.trim().is_empty() {
        "openbmb/VoxCPM2"
    } else {
        s.voxcpm_model.trim()
    };
    let cfg = if s.voxcpm_cfg < 1.0 { 2.0 } else { s.voxcpm_cfg };
    let steps = if s.voxcpm_steps < 4 { 10 } else { s.voxcpm_steps };

    let mut body = json!({
        "model": model,
        "input": input,
        "voice": "default",
        "response_format": "wav",
        "seed": 42,
        "extra_params": {
            "cfg_value": cfg,
            "inference_timesteps": steps,
            "denoise": s.voxcpm_load_denoiser,
        },
    });

    if let Some(ref_path) = ref_path {
        if let Ok(bytes) = tokio::fs::read(&ref_path).await {
            let mime = audio_mime(&ref_path.to_string_lossy());
            body["ref_audio"] = json!(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
            let ref_text = s.voxcpm_ref_text.trim();
            if !ref_text.is_empty() {
                body["ref_text"] = json!(ref_text);
            }
        }
    }

    // A cold local server may still be loading weights; give it a short window.
    if (base == "http://127.0.0.1:8000" || base == "http://localhost:8000")
        && !crate::voxcpm::is_server_healthy(&base).await
    {
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if crate::voxcpm::is_server_healthy(&base).await {
                break;
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()?;
    let res = client
        .post(format!("{base}/v1/audio/speech"))
        .json(&body)
        .send()
        .await;

    let mut res = match res {
        Ok(r) => r,
        Err(e) => {
            if s.voxcpm_auto_fallback {
                return voxcpm_fallback(voice, &clean_text, lang, slow).await;
            }
            bail!("Could not reach VoxCPM 2 on {base}: {e}");
        }
    };

    let mut status = res.status();
    // 503 usually means "model still loading"; retry briefly before falling back.
    if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        for _ in 0..2 {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if let Ok(retry) = client
                .post(format!("{base}/v1/audio/speech"))
                .json(&body)
                .send()
                .await
            {
                if retry.status().is_success() {
                    res = retry;
                    status = res.status();
                    break;
                }
            }
        }
    }

    if !status.is_success() {
        let err_text = res.text().await.unwrap_or_default();
        let loading = status == reqwest::StatusCode::SERVICE_UNAVAILABLE
            || err_text.to_ascii_lowercase().contains("still loading");
        if s.voxcpm_auto_fallback {
            return voxcpm_fallback(voice, &clean_text, lang, slow).await;
        }
        if loading {
            bail!("VoxCPM 2 is still loading weights. Wait a moment and try again, or enable Auto fallback.");
        }
        return Err(provider_error(status, &err_text));
    }
    Ok(res.bytes().await?.to_vec())
}

/// Normalize and clean Khmer text for articulate speech synthesis:
/// Strips zero-width non-joiners/spaces that disrupt tokenizers, collapses spaces,
/// and adds natural breathing pauses at clause boundaries.
pub fn normalize_khmer_text(text: &str) -> String {
    if !text.chars().any(|c| ('\u{1780}'..='\u{17FF}').contains(&c)) {
        return text.trim().to_string();
    }
    let s = text
        .replace('\u{200b}', " ")
        .replace('\u{200c}', "")
        .replace('\u{200d}', "")
        .replace('\u{feff}', "");
    let mut cleaned = String::with_capacity(s.len());
    let mut last_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_space {
                cleaned.push(' ');
                last_space = true;
            }
        } else {
            cleaned.push(c);
            last_space = false;
        }
    }
    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    /// Reads one HTTP request (headers + body) from the mock client.
    fn read_request(stream: &mut TcpStream) -> String {
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            data.extend_from_slice(&buf[..n]);
            if let Some(head_end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&data[..head_end]).to_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if data.len() >= head_end + 4 + len {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&data).into_owned()
    }

    #[tokio::test]
    async fn gpt_sovits_posts_api_v2_json_and_returns_wav() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let req = read_request(&mut stream);
            assert!(req.starts_with("POST /tts "), "unexpected request: {req}");
            assert!(req.contains("\"ref_audio_path\":\"C:\\\\ref\\\\voice.wav\""));
            assert!(req.contains("\"prompt_text\":\"hello there\""));
            assert!(req.contains("\"text_lang\":\"auto\""));
            let wav = b"RIFF\x24\x00\x00\x00WAVEfmt ";
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        wav.len()
                    )
                    .as_bytes(),
                )
                .unwrap();
            stream.write_all(wav).unwrap();
        });

        let mut s = Settings::default();
        s.tts_kind = TtsKind::GptSovits;
        s.gpt_sovits_url = format!("http://{addr}/");
        s.gpt_sovits_ref_audio = r"C:\ref\voice.wav".into();
        s.gpt_sovits_prompt_text = "hello there".into();

        let bytes = gpt_sovits(&s, "A test line.", "en", false).await.unwrap();
        assert!(bytes.starts_with(b"RIFF"));
        assert_eq!(audio_ext(&bytes), "wav");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn gpt_sovits_requires_reference_audio() {
        let mut s = Settings::default();
        s.tts_kind = TtsKind::GptSovits;
        let err = gpt_sovits(&s, "hi", "en", false).await.unwrap_err();
        assert!(format!("{err}").contains("reference audio"));
    }

    #[test]
    fn gpt_sovits_base_normalizes_urls() {
        assert_eq!(gpt_sovits_base("127.0.0.1:9880"), "http://127.0.0.1:9880");
        assert_eq!(gpt_sovits_base("http://127.0.0.1:9880/"), "http://127.0.0.1:9880");
        assert_eq!(gpt_sovits_base("http://127.0.0.1:9880/tts"), "http://127.0.0.1:9880");
        assert_eq!(
            gpt_sovits_base("  https://gsv.example.com/tts/ "),
            "https://gsv.example.com"
        );
    }

    #[tokio::test]
    async fn gpt_sovits_reports_connection_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let mut s = Settings::default();
        s.tts_kind = TtsKind::GptSovits;
        s.gpt_sovits_url = format!("http://{addr}");
        s.gpt_sovits_ref_audio = r"C:\ref\voice.wav".into();
        s.gpt_sovits_prompt_text = "hello there".into();

        let err = format!("{:#}", gpt_sovits(&s, "hi", "en", false).await.unwrap_err());
        assert!(
            err.contains("connection refused") || err.contains("nothing is listening"),
            "unexpected error: {err}"
        );
    }
}
