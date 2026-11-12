//! Scene text validation and normalisation.
//!
//! The script model returns free-form narration. TTS engines are happiest with
//! plain sentences, so this module strips markup/emoji and splits scenes that
//! exceed the documented 400-character limit.

use unicode_segmentation::UnicodeSegmentation;

/// The architecture doc caps a scene at ~400 characters.
pub const MAX_SCENE_CHARS: usize = 400;

fn is_emoji(c: char) -> bool {
    matches!(
        c as u32,
        0x1F000..=0x1FAFF   // pictographs, emoticons, transport, symbols
        | 0x2600..=0x27BF   // misc symbols and dingbats
        | 0x2B00..=0x2BFF   // arrows/stars
        | 0xFE00..=0xFE0F   // variation selectors
        | 0x20E3            // combining enclosing keycap
        | 0x200D            // zero-width joiner
    )
}

/// Remove markup and emoji, collapse whitespace, and trim.
pub fn normalize_narration(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;

    for c in input.chars() {
        if c == '<' {
            in_tag = true;
            continue;
        }
        if c == '>' && in_tag {
            in_tag = false;
            continue;
        }
        if in_tag {
            continue;
        }
        if is_emoji(c) || c.is_control() && c != '\n' && c != '\t' {
            continue;
        }
        // Markdown/formatting characters that TTS would otherwise read out.
        if matches!(c, '*' | '_' | '#' | '`' | '~' | '|' | '[' | ']' | '{' | '}' | '\\') {
            continue;
        }
        out.push(c);
    }

    let mut cleaned = String::with_capacity(out.len());
    let mut last_space = false;
    for c in out.chars() {
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

fn is_sentence_end(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '។' | '៕' | '…' | '\n')
}

/// Split one scene into sentences, then pack sentences into <= `max_chars`
/// chunks. A single over-long sentence is split on word boundaries (or
/// grapheme clusters for scripts without spaces).
pub fn split_long_scene(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    if text.chars().count() <= max_chars {
        return vec![text.to_string()];
    }

    let mut sentences = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        current.push(c);
        if is_sentence_end(c) {
            let s = current.trim();
            if !s.is_empty() {
                sentences.push(s.to_string());
            }
            current.clear();
        }
    }
    let tail = current.trim();
    if !tail.is_empty() {
        sentences.push(tail.to_string());
    }
    if sentences.is_empty() {
        sentences.push(text.to_string());
    }

    let mut chunks = Vec::new();
    let mut chunk = String::new();
    for sentence in sentences {
        if sentence.chars().count() > max_chars {
            if !chunk.trim().is_empty() {
                chunks.push(chunk.trim().to_string());
                chunk.clear();
            }
            chunks.extend(hard_split(&sentence, max_chars));
            continue;
        }
        let candidate_len = chunk.chars().count() + usize::from(!chunk.is_empty()) + sentence.chars().count();
        if candidate_len > max_chars && !chunk.trim().is_empty() {
            chunks.push(chunk.trim().to_string());
            chunk.clear();
        }
        if !chunk.is_empty() {
            chunk.push(' ');
        }
        chunk.push_str(&sentence);
    }
    if !chunk.trim().is_empty() {
        chunks.push(chunk.trim().to_string());
    }
    chunks
}

fn hard_split(text: &str, max_chars: usize) -> Vec<String> {
    // Prefer spaces so words stay intact.
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    for c in text.chars() {
        if c.is_whitespace() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        words.push(word);
    }

    if words.len() > 1 {
        let mut out = Vec::new();
        let mut part = String::new();
        for w in words {
            let extra = usize::from(!part.is_empty()) + w.chars().count();
            if part.chars().count() + extra > max_chars && !part.is_empty() {
                out.push(std::mem::take(&mut part));
            }
            if !part.is_empty() {
                part.push(' ');
            }
            part.push_str(&w);
        }
        if !part.is_empty() {
            out.push(part);
        }
        return out;
    }

    // No spaces (e.g. Khmer): split by grapheme clusters so combining marks
    // stay attached to their base character.
    let mut out = Vec::new();
    let mut part = String::new();
    for g in text.graphemes(true) {
        if part.chars().count() + g.chars().count() > max_chars && !part.is_empty() {
            out.push(std::mem::take(&mut part));
        }
        part.push_str(g);
    }
    if !part.is_empty() {
        out.push(part);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markup_and_emoji() {
        let got = normalize_narration("  **Hello** <b>world</b> 😀 `code`  ");
        assert_eq!(got, "Hello world code");
    }

    #[test]
    fn collapses_whitespace_and_keeps_khmer() {
        let got = normalize_narration("សួស្តី\n\n   ពិភពលោក");
        assert_eq!(got, "សួស្តី ពិភពលោក");
    }

    #[test]
    fn short_scene_stays_whole() {
        let parts = split_long_scene("A short line.", MAX_SCENE_CHARS);
        assert_eq!(parts, vec!["A short line."]);
    }

    #[test]
    fn long_scene_splits_on_sentences() {
        let sentence = "This is a sentence that is reasonably long. ";
        let text = sentence.repeat(20);
        let parts = split_long_scene(&text, 120);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|p| p.chars().count() <= 120));
        assert!(parts.iter().all(|p| !p.trim().is_empty()));
    }

    #[test]
    fn long_khmer_scene_splits_without_spaces() {
        let text = "ក".repeat(900);
        let parts = split_long_scene(&text, 400);
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.chars().count() <= 400));
    }
}
