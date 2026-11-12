import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./components/icons";
import { langLabel, minutes, sceneLabel } from "./format";

const VOICES: [string, string, string][] = [
  ["km-KH-SreymomNeural", "km", "Khmer, female (Sreymom)"],
  ["km-KH-PisethNeural", "km", "Khmer, male (Piseth)"],
  ["en-US-AriaNeural", "en", "English, female (Aria)"],
];

const STYLES: { id: string; title: string; sub: string; swatch: string }[] = [
  {
    id: "2d_horror",
    title: "2D horror",
    sub: "Moonlit blues, deep shadows, unsettling faces",
    swatch: "swatch-horror",
  },
  {
    id: "2d_animation",
    title: "2D bright",
    sub: "Warm light, friendly shapes, storybook colours",
    swatch: "swatch-bright",
  },
  {
    id: "cinematic",
    title: "Cinematic",
    sub: "Dramatic film lighting, depth of field, photorealistic mood",
    swatch: "swatch-cinematic",
  },
];

export default function Wizard({
  onDone,
  onCancel,
}: {
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(
    "A ghost story in a Cambodian village: a boy hears a woman singing at the old well every night. The village elders warn him to stay away.",
  );
  const [mins, setMins] = useState(3);
  const [style, setStyle] = useState("2d_horror");
  const [language, setLanguage] = useState("km");
  const [voice, setVoice] = useState("km-KH-SreymomNeural");
  const [est, setEst] = useState({ scene_len: 6, scenes: 30 });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ttsKind, setTtsKind] = useState<"azure" | "gpt_sovits" | "edge_tts" | "meta_mms" | "kiri_tts">("edge_tts");

  useEffect(() => {
    api.estimate(mins * 60).then(setEst);
  }, [mins]);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setTtsKind(s.tts_kind))
      .catch(() => {});
  }, []);

  const localVoice = ttsKind === "gpt_sovits" || ttsKind === "meta_mms" || ttsKind === "kiri_tts";
  const voices = VOICES.filter((v) => v[1] === language);
  const engineName =
    ttsKind === "kiri_tts"
      ? "Kiri TTS"
      : ttsKind === "meta_mms"
        ? "Meta MMS (Khmer)"
        : "GPT-SoVITS";
  const voiceLabel = localVoice
    ? `${engineName} (${ttsKind === "kiri_tts" ? "native Khmer voice" : ttsKind === "meta_mms" ? "offline model" : "reference voice"})`
    : VOICES.find((v) => v[0] === voice)?.[2] ?? voice;
  const voiceShort = localVoice
    ? engineName
    : voiceLabel.match(/\(([^)]+)\)/)?.[1] ?? voiceLabel;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const p = await api.create(name.trim() || "Untitled");
      await api.update(p.id, {
        prompt,
        durationSec: mins * 60,
        style,
        language,
        voice,
      });
      onDone(p.id);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">
            <button className="crumb-link" onClick={onCancel}>
              Projects
            </button>
            <Icon name="chevron-right" size={14} />
            <span>New project</span>
          </div>
          <h1 className="page-title">New project</h1>
          <p className="page-sub">
            Describe the story once. VideoGen handles the script, voice and art.
          </p>
        </div>
      </div>

      <div className="wizard-grid">
        <div className="panel form-stack">
          <div className="field">
            <label htmlFor="p-name">Project name</label>
            <input
              id="p-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="The woman at the well"
            />
          </div>

          <div className="field">
            <label htmlFor="p-prompt">Story prompt</label>
            <textarea
              id="p-prompt"
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A ghost story about…"
            />
            <span className="hint">
              Mention the setting, the characters and what the ghost wants.
            </span>
          </div>

          <div className="field">
            <label>Length</label>
            <div className="range-row">
              <input
                type="range"
                min={1}
                max={60}
                value={mins}
                onChange={(e) => setMins(+e.target.value)}
                aria-label="Video length in minutes"
              />
              <span className="range-badge">{minutes(mins * 60)} min</span>
            </div>
            <span className="hint">
              About {sceneLabel(est.scenes)} of {est.scene_len}s — {est.scenes}{" "}
              images and {est.scenes} voice requests.
            </span>
          </div>

          <div className="field">
            <label>Visual style</label>
            <div className="choice-grid">
              {STYLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`choice${style === s.id ? " active" : ""}`}
                  onClick={() => setStyle(s.id)}
                >
                  <span className={`choice-swatch ${s.swatch}`} />
                  <span>
                    <span className="choice-title">{s.title}</span>
                    <span className="choice-sub">{s.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Language</label>
            <div className="seg">
              <button
                type="button"
                className={language === "km" ? "active" : ""}
                onClick={() => {
                  setLanguage("km");
                  setVoice("km-KH-SreymomNeural");
                }}
              >
                Khmer
              </button>
              <button
                type="button"
                className={language === "en" ? "active" : ""}
                onClick={() => {
                  setLanguage("en");
                  setVoice("en-US-AriaNeural");
                }}
              >
                English
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="p-voice">Narrator voice</label>
            {localVoice ? (
              <>
                <div className="key-help">
                  <span>
                    {ttsKind === "kiri_tts"
                      ? "Kiri TTS generates natural native Khmer voice via your Kiri API key (Maly, Neary, Oudom, etc.)."
                      : ttsKind === "meta_mms"
                        ? "Meta MMS generates Khmer voice locally on CPU without internet."
                        : "GPT-SoVITS clones the reference voice saved in Settings → Voice."}
                  </span>
                </div>
                {language === "km" && ttsKind === "gpt_sovits" && (
                  <span className="hint">
                    GPT-SoVITS has no built-in Khmer model — pick English here, or use a
                    custom fine-tuned Khmer voice.
                  </span>
                )}
              </>
            ) : (
              <select
                id="p-voice"
                className="select"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
              >
                {voices.map((v) => (
                  <option key={v[0]} value={v[0]}>
                    {v[2]}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        <aside className="panel summary-card">
          <div>
            <div className="summary-title">Summary</div>
            <div className="summary-list">
              <div className="summary-row">
                <span>Length</span>
                <b>{minutes(mins * 60)} min</b>
              </div>
              <div className="summary-row">
                <span>Scenes</span>
                <b>{est.scenes}</b>
              </div>
              <div className="summary-row">
                <span>Scene length</span>
                <b>~{est.scene_len}s</b>
              </div>
              <div className="summary-row">
                <span>Language</span>
                <b>{langLabel(language)}</b>
              </div>
              <div className="summary-row">
                <span>Style</span>
                <b>{STYLES.find((s) => s.id === style)?.title || style}</b>
              </div>
              <div className="summary-row">
                <span>Voice</span>
                <b className="truncate" title={voiceLabel}>
                  {voiceShort}
                </b>
              </div>
            </div>
          </div>

          <p className="summary-note">
            Scenes are generated in order, so you can close the app and resume
            later. Only missing pieces are retried.
          </p>

          {err && <div className="alert error">{err}</div>}

          <button className="btn primary block" disabled={busy} onClick={submit}>
            {busy ? "Creating…" : "Create project"}
            {!busy && <Icon name="chevron-right" size={17} />}
          </button>
          <button className="btn ghost block" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </aside>
      </div>
    </>
  );
}
