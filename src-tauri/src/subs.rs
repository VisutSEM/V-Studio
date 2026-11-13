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

enum Token {
    Word(String),
    Sep(String),
}

fn tokenize_cue(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut current_word = String::new();
    let mut current_sep = String::new();

    for ch in text.chars() {
        let is_sep = ch.is_whitespace() || ch == '\u{200B}';
        if is_sep {
            if !current_word.is_empty() {
                tokens.push(Token::Word(std::mem::take(&mut current_word)));
            }
            if ch == '\n' {
                current_sep.push_str("\\N");
            } else if ch == '{' {
                current_sep.push('(');
            } else if ch == '}' {
                current_sep.push(')');
            } else {
                current_sep.push(ch);
            }
        } else {
            if !current_sep.is_empty() {
                tokens.push(Token::Sep(std::mem::take(&mut current_sep)));
            }
            if ch == '{' {
                current_word.push('(');
            } else if ch == '}' {
                current_word.push(')');
            } else {
                current_word.push(ch);
            }
        }
    }
    if !current_word.is_empty() {
        tokens.push(Token::Word(current_word));
    }
    if !current_sep.is_empty() {
        tokens.push(Token::Sep(current_sep));
    }
    tokens
}

pub fn hex_to_ass_color(hex: &str) -> String {
    let clean = hex.trim().trim_start_matches('#');
    if clean.len() == 6 {
        let r = &clean[0..2];
        let g = &clean[2..4];
        let b = &clean[4..6];
        format!("&H00{}{}{}&", b, g, r).to_uppercase()
    } else {
        "&H0015CCFA&".to_string() // default to yellow #facc15
    }
}

#[allow(dead_code)]
pub fn to_ass(cues: &[Cue]) -> String {
    to_ass_with_tracker(cues, false, None)
}

pub fn to_ass_with_tracker(cues: &[Cue], word_tracker: bool, highlight_hex: Option<&str>) -> String {
    let mut s = String::from(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: Default,Noto Sans Khmer,56,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1.5,2,60,60,60,1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );

    let hl_color = hex_to_ass_color(highlight_hex.unwrap_or("#facc15"));

    for c in cues {
        if !word_tracker {
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
            continue;
        }

        let tokens = tokenize_cue(&c.text);
        let word_indices: Vec<usize> = tokens
            .iter()
            .enumerate()
            .filter_map(|(i, t)| match t {
                Token::Word(_) => Some(i),
                _ => None,
            })
            .collect();

        let num_words = word_indices.len();
        let dur = c.end_ms - c.start_ms;

        if num_words <= 1 || dur <= 0 {
            let mut line = String::new();
            for t in &tokens {
                match t {
                    Token::Word(w) => {
                        line.push_str(&format!("{{\\c{hl_color}}}{w}{{\\c&H00FFFFFF&}}"));
                    }
                    Token::Sep(sep) => line.push_str(sep),
                }
            }
            s.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
                ts_ass(c.start_ms),
                ts_ass(c.end_ms),
                line
            ));
            continue;
        }

        for (w_pos, &active_tok_idx) in word_indices.iter().enumerate() {
            let slice_start = c.start_ms + (dur * w_pos as i64) / (num_words as i64);
            let slice_end = if w_pos + 1 == num_words {
                c.end_ms
            } else {
                c.start_ms + (dur * (w_pos + 1) as i64) / (num_words as i64)
            };

            if slice_end <= slice_start {
                continue;
            }

            let mut line = String::new();
            for (t_idx, t) in tokens.iter().enumerate() {
                match t {
                    Token::Word(w) => {
                        if t_idx == active_tok_idx {
                            line.push_str(&format!("{{\\c{hl_color}}}{w}{{\\c&H00FFFFFF&}}"));
                        } else {
                            line.push_str(w);
                        }
                    }
                    Token::Sep(sep) => {
                        line.push_str(sep);
                    }
                }
            }

            s.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
                ts_ass(slice_start),
                ts_ass(slice_end),
                line
            ));
        }
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

    #[test]
    fn test_word_tracker_ass() {
        let cues = vec![Cue {
            idx: 0,
            start_ms: 0,
            end_ms: 3000,
            text: "Hello world Apple".to_string(),
        }];
        let ass_tracked = to_ass_with_tracker(&cues, true, Some("#facc15"));
        assert!(ass_tracked.contains(r"{\c&H0015CCFA&}Hello{\c&H00FFFFFF&} world Apple"));
        assert!(ass_tracked.contains(r"Hello {\c&H0015CCFA&}world{\c&H00FFFFFF&} Apple"));
        assert!(ass_tracked.contains(r"Hello world {\c&H0015CCFA&}Apple{\c&H00FFFFFF&}"));

        let ass_untracked = to_ass_with_tracker(&cues, false, None);
        assert!(!ass_untracked.contains(r"{\c&H0015CCFA&}"));
        assert!(ass_untracked.contains("Hello world Apple"));
    }
}
