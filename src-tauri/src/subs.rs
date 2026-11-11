use crate::db::{Cue, Scene};
use unicode_segmentation::UnicodeSegmentation;

pub const FPS: i64 = 30;
const MAX_CHARS: usize = 32;

/// Every clip is a whole number of frames; subtitle timing uses the same durations.
pub fn frames_for(ms: i64) -> i64 {
    (ms * FPS + 999) / 1000
}

pub fn scene_ms(ms: i64) -> i64 {
    frames_for(ms) * 1000 / FPS
}

pub fn wrap(text: &str, max: usize) -> Vec<String> {
    let mut words = Vec::new();
    for token in text.split(|c: char| c.is_whitespace() || c == '\u{200B}') {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        let graphemes: Vec<&str> = trimmed.graphemes(true).collect();
        if graphemes.len() > max {
            for chunk in graphemes.chunks(max) {
                words.push(chunk.join(""));
            }
        } else {
            words.push(trimmed.to_string());
        }
    }
    if words.is_empty() && !text.trim().is_empty() {
        let graphemes: Vec<&str> = text.trim().graphemes(true).collect();
        for chunk in graphemes.chunks(max) {
            words.push(chunk.join(""));
        }
    }

    let (mut lines, mut cur, mut n) = (vec![], String::new(), 0usize);
    for word in words {
        let w = word.graphemes(true).count();
        if n + w + 1 > max && !cur.is_empty() {
            lines.push(std::mem::take(&mut cur));
            n = 0;
        }
        if !cur.is_empty() {
            cur.push(' ');
            n += 1;
        }
        cur.push_str(&word);
        n += w;
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

pub fn build_cues(scenes: &[Scene]) -> Vec<Cue> {
    let mut cues = vec![];
    let (mut t, mut idx) = (0i64, 0i64);
    for sc in scenes {
        let dur = scene_ms(sc.audio_ms.unwrap_or(0));
        let lines = wrap(&sc.narration, MAX_CHARS);
        let groups: Vec<String> = lines.chunks(2).map(|c| c.join("\n")).collect();
        if groups.is_empty() {
            t += dur;
            continue;
        }
        let weights: Vec<i64> = groups
            .iter()
            .map(|g| g.graphemes(true).count().max(1) as i64)
            .collect();
        let sum: i64 = weights.iter().sum();
        let mut acc = 0i64;
        for (g, w) in groups.iter().zip(&weights) {
            let start = t + dur * acc / sum;
            acc += w;
            let end = t + dur * acc / sum;
            cues.push(Cue {
                idx,
                start_ms: start,
                end_ms: end,
                text: g.clone(),
            });
            idx += 1;
        }
        t += dur;
    }
    cues
}

fn ts_ass(ms: i64) -> String {
    let ms = ms.max(0);
    format!(
        "{}:{:02}:{:02}.{:02}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000 / 10
    )
}

fn ts_srt(ms: i64) -> String {
    let ms = ms.max(0);
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

pub fn to_ass(cues: &[Cue]) -> String {
    let mut s = String::from(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: Default,Noto Sans Khmer,56,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,60,1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );
    for c in cues {
        let text = c
            .text
            .replace('\n', "\\N")
            .replace('{', "(")
            .replace('}', ")");
        s.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            ts_ass(c.start_ms),
            ts_ass(c.end_ms),
            text
        ));
    }
    s
}

pub fn to_srt(cues: &[Cue]) -> String {
    let mut s = String::new();
    for (i, c) in cues.iter().enumerate() {
        s.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            ts_srt(c.start_ms),
            ts_srt(c.end_ms),
            c.text
        ));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wrap_khmer_and_english() {
        let text = "នៅពេលយប់ នៅក្នុងភូមិដ៏ស្ងាត់ជ្រងំមួយ មានសំឡេងចម្លែក";
        let wrapped = wrap(text, 20);
        assert!(!wrapped.is_empty());
        for line in wrapped {
            assert!(line.graphemes(true).count() <= 20);
        }
    }

    #[test]
    fn test_timing_calculation() {
        assert_eq!(frames_for(1000), 30);
        assert_eq!(scene_ms(1000), 1000);
    }
}
