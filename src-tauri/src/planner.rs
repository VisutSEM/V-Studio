use anyhow::{anyhow, Result};
use serde::de::DeserializeOwned;

pub const CHAPTER_SCENES: u32 = 20;

/// (scene_len_seconds, scene_count)
pub fn plan_scenes(duration_sec: u32) -> (u32, u32) {
    let scene_len = match duration_sec {
        0..=300 => 6,
        301..=1200 => 10,
        _ => 15,
    };
    (scene_len, duration_sec.div_ceil(scene_len).max(1))
}

pub fn style_prompt(style: &str) -> &'static str {
    match style {
        "2d_horror" => {
            "dark 2D cartoon animation, moody blue and black palette, thick outlines, fog, \
            glowing eyes, silhouettes, Cambodian village at night, wooden stilt houses, rice fields, \
            banyan tree, pagoda, eerie but not gory, no text, 16:9"
        }
        "2d_animation" => {
            "flat 2D cartoon animation, bold outlines, vibrant colors, simple shapes, \
            consistent character design, no text, 16:9"
        }
        "cinematic" => {
            "cinematic 35mm movie photography, award-winning film still, dramatic volumetric lighting, \
            shallow depth of field, rich color grading, ultra-detailed atmospheric textures, \
            anamorphic lens, photorealistic composition, cinematic masterwork, no text, 16:9"
        }
        _ => "illustration, no text, 16:9",
    }
}

pub fn lang_name(code: &str) -> &'static str {
    match code {
        "km" => "Khmer (ភាសាខ្មែរ, written in Khmer script)",
        _ => "English",
    }
}

fn genre_rules(style: &str, language: &str) -> &'static str {
    match (style, language) {
        ("2d_horror", "km") => {
            "- Setting: rural Cambodia. Draw on Khmer folklore: ខ្មោច (ghost), ព្រាយ, អាប, អារក្ស, អ្នកតា (guardian spirit).\n\
             - Atmospheric horror only: dread, silence, shadows. No gore, no graphic violence."
        }
        ("2d_horror", _) => "- Atmospheric horror only: dread, silence, shadows. No gore, no graphic violence.",
        ("cinematic", "km") => {
            "- Tone: cinematic and emotionally immersive storytelling with vivid sensory details, rich dialogue, and a gripping narrative arc.\n\
             - Setting: authentic Cambodian landscapes, rich cultural textures, natural lighting and atmosphere."
        }
        ("cinematic", _) => "- Tone: cinematic and emotionally immersive storytelling with vivid sensory details, rich dialogue, and a gripping narrative arc.",
        _ => "",
    }
}

pub fn outline_system(language: &str, style: &str, minutes: u32, chapters: u32) -> String {
    format!(
        r#"You are a {lang} YouTube storyteller planning a {minutes}-minute video.
Return ONLY valid JSON:
{{"title":"...","characters":"...","chapters":[{{"title":"...","summary":"..."}}]}}
Rules:
- "title", chapter titles and summaries are in {lang}.
- "characters": English visual description of the recurring characters and the main setting, 2-4 sentences. It is reused in every image prompt, so be concrete (age, clothes, hair, colors).
- Exactly {chapters} chapters that together tell one story: hook in the first seconds, calm setup, rising tension, twist, short chilling ending.
{genre}"#,
        lang = lang_name(language),
        genre = genre_rules(style, language),
    )
}

pub fn chapter_system(
    language: &str,
    style: &str,
    title: &str,
    i: u32,
    k: u32,
    n: u32,
    scene_len: u32,
) -> String {
    let khmer = if language == "km" {
        "- Put a normal space between phrases (every 4-8 words) so subtitles can wrap. No English words. Write numbers in Khmer words.\n"
    } else {
        ""
    };
    format!(
        r#"You are a {lang} YouTube storyteller. Write the scenes for chapter {i} of {k} of the video "{title}".
Return ONLY valid JSON:
{{"scenes":[{{"narration":"...","image_prompt":"..."}}]}}
Rules:
- Exactly {n} scenes.
- "narration" is in {lang}: 2-3 short sentences, about {scene_len} seconds when spoken aloud.
{khmer}- "image_prompt" is in English: one clear visual, describe characters by their appearance, never include text or letters in the image.
- Keep character names and looks consistent with the outline.
{genre}"#,
        lang = lang_name(language),
        genre = genre_rules(style, language),
    )
}

/// Pulls the first {...} block out of an LLM reply (handles ```json fences).
pub fn extract_json<T: DeserializeOwned>(raw: &str) -> Result<T> {
    let start = raw.find('{').ok_or_else(|| anyhow!("No JSON in model reply"))?;
    let end = raw.rfind('}').ok_or_else(|| anyhow!("No JSON in model reply"))?;
    Ok(serde_json::from_str(&raw[start..=end])?)
}
