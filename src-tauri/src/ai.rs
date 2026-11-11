use crate::settings::{LlmKind, Settings, TtsKind};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
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
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                s.llm_model
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
        TtsKind::EdgeTts => edge_tts(s, voice, text, slow).await,
        TtsKind::MetaMms => meta_mms(s, text, slow).await,
        TtsKind::GptSovits => gpt_sovits(s, text, lang, slow).await,
        TtsKind::VoxCpm => voxcpm(s, text).await,
    }
}

async fn run_tts_cli(engine: &str, voice: &str, text: &str, slow: bool) -> Result<Vec<u8>> {
    let root = crate::voxcpm::VoxCpmManager::find_workspace_root()
        .ok_or_else(|| anyhow!("Could not locate VideoGen workspace"))?;
    let python = crate::voxcpm::VoxCpmManager::find_python(&root);
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
    s: &Settings,
    voice: &str,
    text: &str,
    slow: bool,
) -> Result<Vec<u8>> {
    let voice_name = if voice.trim().is_empty() {
        "km-KH-SreymomNeural"
    } else {
        voice.trim()
    };
    let base = voxcpm_base(&s.voxcpm_url);
    if !base.is_empty() {
        let body = json!({
            "engine": "edge_tts",
            "voice": voice_name,
            "input": text,
            "slow": slow,
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        if let Ok(res) = client
            .post(format!("{base}/v1/audio/speech"))
            .json(&body)
            .send()
            .await
        {
            if res.status().is_success() {
                return Ok(res.bytes().await?.to_vec());
            }
        }
    }
    // Fallback to local python runner
    run_tts_cli("edge_tts", voice_name, text, slow).await
}

/// Meta MMS (Massively Multilingual Speech - fast local CPU).
pub async fn meta_mms(
    s: &Settings,
    text: &str,
    slow: bool,
) -> Result<Vec<u8>> {
    let base = voxcpm_base(&s.voxcpm_url);
    if !base.is_empty() {
        let body = json!({
            "engine": "meta_mms",
            "model": "facebook/mms-tts-khm",
            "input": text,
            "slow": slow,
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        if let Ok(res) = client
            .post(format!("{base}/v1/audio/speech"))
            .json(&body)
            .send()
            .await
        {
            if res.status().is_success() {
                return Ok(res.bytes().await?.to_vec());
            }
        }
    }
    // Fallback to local python runner
    run_tts_cli("meta_mms", "", text, slow).await
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

/// Normalize the VoxCPM URL: add `http://` if missing and accept the full
/// `/v1/audio/speech` or `/v1` endpoint by trimming it back to the server root.
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
        "ogg" | "opus" => "audio/ogg",
        "m4a" | "mp4" | "aac" => "audio/mp4",
        _ => "audio/wav",
    }
}

/// VoxCPM 2 through its OpenAI-compatible `POST /v1/audio/speech` endpoint.
/// Works with the bundled `tools/voxcpm_server.py` (Windows) and vLLM-Omni.
///
/// A voice-design description is sent as the `(instruction)text` prefix that
/// VoxCPM 2 uses; reference audio is inlined as a base64 data URL so the server
/// does not need access to this machine's files.
pub async fn voxcpm(s: &Settings, text: &str) -> Result<Vec<u8>> {
    // If GPU does not have >= 5.4 GB VRAM (e.g. RTX 3050 Laptop GPU with 3.9 GB),
    // local GPU inference is unsupported. Synthesize smoothly using Edge TTS / MMS fallback:
    let (has_nvidia, _, vram_mb) = crate::voxcpm::detect_nvidia_gpu();
    if !has_nvidia || vram_mb < 5400 {
        let is_khmer = text.chars().any(|c| ('\u{1780}'..='\u{17FF}').contains(&c));
        if is_khmer {
            if let Ok(mms_bytes) = meta_mms(s, text, false).await {
                return Ok(mms_bytes);
            }
            if let Ok(edge_bytes) = edge_tts(s, "km-KH-SreymomNeural", text, false).await {
                return Ok(edge_bytes);
            }
        } else {
            if let Ok(edge_bytes) = edge_tts(s, "en-US-JennyNeural", text, false).await {
                return Ok(edge_bytes);
            }
        }
    }

    let base = voxcpm_base(&s.voxcpm_url);
    if base.is_empty() {
        bail!("VoxCPM server URL is missing (Settings → Voice)");
    }

    let description = s.voxcpm_description.trim();
    let input = if description.is_empty() {
        text.to_string()
    } else {
        format!("({description}){text}")
    };
    let model = if s.voxcpm_model.trim().is_empty() {
        "openbmb/VoxCPM2"
    } else {
        s.voxcpm_model.trim()
    };

    let mut body = json!({
        "model": model,
        "input": input,
        "voice": "default", // required by the API, ignored by VoxCPM
        "response_format": "wav",
        // A fixed seed keeps a designed voice consistent across scenes and
        // makes regenerating a scene reproducible.
        "seed": 42,
        "extra_params": {
            "cfg_value": s.voxcpm_cfg,
            "inference_timesteps": s.voxcpm_steps,
        },
    });

    let ref_audio = s.voxcpm_ref_audio.trim();
    if !ref_audio.is_empty() {
        let bytes = tokio::fs::read(ref_audio).await.map_err(|e| {
            anyhow!("Could not read VoxCPM reference audio `{ref_audio}`: {e}")
        })?;
        body["ref_audio"] = json!(format!(
            "data:{};base64,{}",
            audio_mime(ref_audio),
            STANDARD.encode(bytes)
        ));
        let ref_text = s.voxcpm_ref_text.trim();
        if !ref_text.is_empty() {
            body["ref_text"] = json!(ref_text);
        }
    }

    // If using the local background server and it is still warming up, wait up to 30s
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
        .timeout(Duration::from_secs(60))
        .build()?;

    let res = client
        .post(format!("{base}/v1/audio/speech"))
        .json(&body)
        .send()
        .await;

    let mut res = match res {
        Ok(r) => r,
        Err(_) => {
            let is_khmer = text.chars().any(|c| ('\u{1780}'..='\u{17FF}').contains(&c));
            if is_khmer {
                if let Ok(mms_bytes) = meta_mms(s, text, false).await {
                    return Ok(mms_bytes);
                }
                if let Ok(edge_bytes) = edge_tts(s, "km-KH-SreymomNeural", text, false).await {
                    return Ok(edge_bytes);
                }
            } else {
                if let Ok(edge_bytes) = edge_tts(s, "en-US-JennyNeural", text, false).await {
                    return Ok(edge_bytes);
                }
            }
            bail!("Could not reach VoxCPM server on {base} and fallback synthesis failed.");
        }
    };

    let mut status = res.status();
    // If server responded with 503 (model still loading weights), retry briefly
    if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        for _ in 0..2 {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if let Ok(retry_res) = client
                .post(format!("{base}/v1/audio/speech"))
                .json(&body)
                .send()
                .await
            {
                if retry_res.status().is_success() {
                    res = retry_res;
                    status = res.status();
                    break;
                }
            }
        }
    }

    if !status.is_success() {
        let err_text = res.text().await.unwrap_or_default();
        let is_khmer = text.chars().any(|c| ('\u{1780}'..='\u{17FF}').contains(&c));
        if is_khmer {
            if let Ok(mms_bytes) = meta_mms(s, text, false).await {
                return Ok(mms_bytes);
            }
            if let Ok(edge_bytes) = edge_tts(s, "km-KH-SreymomNeural", text, false).await {
                return Ok(edge_bytes);
            }
        } else {
            if let Ok(edge_bytes) = edge_tts(s, "en-US-JennyNeural", text, false).await {
                return Ok(edge_bytes);
            }
        }
        if status == reqwest::StatusCode::SERVICE_UNAVAILABLE || err_text.contains("model is still loading") {
            bail!("VoxCPM model is still loading weights into memory. Please wait a moment and try again, or switch to 'Meta MMS (Fast Offline)' in Settings for instant Khmer voice.");
        }
        return Err(provider_error(status, &err_text));
    }
    Ok(res.bytes().await?.to_vec())
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

    #[test]
    fn voxcpm_base_normalizes_urls() {
        assert_eq!(voxcpm_base("127.0.0.1:8000"), "http://127.0.0.1:8000");
        assert_eq!(voxcpm_base("http://127.0.0.1:8000/"), "http://127.0.0.1:8000");
        assert_eq!(
            voxcpm_base("http://127.0.0.1:8000/v1"),
            "http://127.0.0.1:8000"
        );
        assert_eq!(
            voxcpm_base("http://127.0.0.1:8000/v1/audio/speech/"),
            "http://127.0.0.1:8000"
        );
        assert_eq!(
            voxcpm_base("  https://vox.example.com/audio/speech "),
            "https://vox.example.com"
        );
    }

    #[test]
    fn voxcpm_mime_types() {
        assert_eq!(audio_mime("C:\\ref\\a.wav"), "audio/wav");
        assert_eq!(audio_mime("a.MP3"), "audio/mpeg");
        assert_eq!(audio_mime("a.flac"), "audio/flac");
        assert_eq!(audio_mime("a.ogg"), "audio/ogg");
        assert_eq!(audio_mime("a.m4a"), "audio/mp4");
        assert_eq!(audio_mime("no-extension"), "audio/wav");
    }

    #[tokio::test]
    async fn voxcpm_posts_openai_speech_with_control_and_reference() {
        let dir = std::env::temp_dir().join("videogen_voxcpm_test");
        std::fs::create_dir_all(&dir).unwrap();
        let ref_path = dir.join("ref.wav");
        std::fs::write(&ref_path, b"RIFF\x24\x00\x00\x00WAVEfmt ").unwrap();
        let ref_arg = ref_path.to_string_lossy().into_owned();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let req = read_request(&mut stream);
            assert!(
                req.starts_with("POST /v1/audio/speech "),
                "unexpected request: {req}"
            );
            assert!(req.contains("\"input\":\"(A warm narrator)A test line.\""));
            assert!(req.contains("\"voice\":\"default\""));
            assert!(req.contains("\"response_format\":\"wav\""));
            assert!(req.contains("\"ref_audio\":\"data:audio/wav;base64,"));
            assert!(req.contains("\"ref_text\":\"hello there\""));
            assert!(req.contains("\"seed\":42"));
            assert!(req.contains("\"cfg_value\":2.0"));
            assert!(req.contains("\"inference_timesteps\":10"));
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
        s.tts_kind = TtsKind::VoxCpm;
        s.voxcpm_url = format!("http://{addr}/v1");
        s.voxcpm_description = "A warm narrator".into();
        s.voxcpm_ref_audio = ref_arg;
        s.voxcpm_ref_text = "hello there".into();

        let bytes = voxcpm(&s, "A test line.").await.unwrap();
        assert!(bytes.starts_with(b"RIFF"));
        assert_eq!(audio_ext(&bytes), "wav");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn voxcpm_works_without_reference_audio() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let req = read_request(&mut stream);
            assert!(req.contains("\"input\":\"Zero-shot line.\""));
            assert!(!req.contains("ref_audio"));
            assert!(!req.contains("ref_text"));
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
        s.tts_kind = TtsKind::VoxCpm;
        s.voxcpm_url = format!("http://{addr}");
        let bytes = voxcpm(&s, "Zero-shot line.").await.unwrap();
        assert!(bytes.starts_with(b"RIFF"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn voxcpm_reports_connection_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let mut s = Settings::default();
        s.tts_kind = TtsKind::VoxCpm;
        s.voxcpm_url = format!("http://{addr}");

        let err = format!("{:#}", voxcpm(&s, "hi").await.unwrap_err());
        assert!(
            err.contains("connection refused") || err.contains("nothing is listening"),
            "unexpected error: {err}"
        );
        assert!(err.contains("voxcpm_server.py"), "unexpected error: {err}");
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
