import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, onProgress, fileUrl, sceneMs, Cue, Detail, Progress } from "./api";
import { Icon } from "./components/icons";
import { langLabel, minutes, sceneLabel, stageMeta, stageName } from "./format";

type Msg = { text: string; kind: "ok" | "error" } | null;

export default function Editor({
  id,
  onBack,
  onProjects,
}: {
  id: string;
  onBack: () => void;
  onProjects: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [sel, setSel] = useState(0);
  const [ambient, setAmbient] = useState<string | null>(null);
  const [prog, setProg] = useState<Progress | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewMode, setPreviewMode] = useState<"cue" | "video">("cue");
  const [subtitlesEnabled, setSubtitlesEnabled] = useState<boolean>(true);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const stopTimeRef = useRef<number | null>(null);

  const load = async () => {
    const detail = await api.get(id);
    setD(detail);
    let c = await api.getSubs(id);
    if (!c.length) c = await api.buildSubs(id);
    setCues(c);
  };

  useEffect(() => {
    load().catch((e) => setMsg({ text: String(e), kind: "error" }));
    api.getSettings().then((s) => {
      if (typeof s.subtitles_enabled === "boolean") {
        setSubtitlesEnabled(s.subtitles_enabled);
      }
    }).catch(() => {});
    const un = onProgress((p) => {
      if (p.project_id === id) setProg(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, [id]);

  const ranges = useMemo(() => {
    let t = 0;
    return (d?.scenes ?? []).map((s) => {
      const start = t;
      t += sceneMs(s.audio_ms ?? 0);
      return { start, end: t, s };
    });
  }, [d]);

  const cue = cues[sel];
  const inRange = (c?: Cue) =>
    c ? ranges.find((r) => c.start_ms >= r.start && c.start_ms < r.end) : undefined;
  const cur = inRange(cue) ?? ranges[0];

  const play = (i: number) => {
    setSel(i);
    const c = cues[i];
    const r = inRange(c);
    const a = audio.current;
    if (!r || !r.s.audio_path || !a || !d) return;

    const targetSrc = fileUrl(d.dir, r.s.audio_path);
    const startSec = Math.max(0, (c.start_ms - r.start) / 1000);
    const endSec = Math.max(startSec + 0.1, (c.end_ms - r.start) / 1000);
    stopTimeRef.current = endSec;

    const startPlayback = () => {
      a.currentTime = startSec;
      a.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    };

    if (a.src !== targetSrc) {
      a.src = targetSrc;
      a.onloadedmetadata = () => startPlayback();
    } else {
      startPlayback();
    }
  };

  const togglePlayCurrent = () => {
    const a = audio.current;
    if (!a) return;
    if (isPlaying) {
      a.pause();
      setIsPlaying(false);
    } else {
      play(sel);
    }
  };

  const edit = (i: number, patch: Partial<Cue>) =>
    setCues(cues.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const add = () => {
    const base = cue ?? { start_ms: 0, end_ms: 2000 };
    const n = [...cues];
    n.splice(sel + 1, 0, {
      idx: 0,
      start_ms: base.end_ms,
      end_ms: base.end_ms + 2000,
      text: "",
    });
    setCues(n);
    setSel(sel + 1);
  };

  const del = (i: number) => {
    setCues(cues.filter((_, j) => j !== i));
    setSel(Math.max(0, i - 1));
  };

  const norm = () => cues.map((c, i) => ({ ...c, idx: i }));

  const rebuild = async () => {
    if (!confirm("Discard your subtitle edits and rebuild from the script?")) return;
    try {
      setCues(await api.buildSubs(id));
      setMsg({ text: "Subtitles rebuilt from the script", kind: "ok" });
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    }
  };

  const saveOnly = async () => {
    try {
      await api.saveSubs(id, norm());
      setMsg({ text: "Subtitles saved", kind: "ok" });
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    }
  };

  const render = async () => {
    setBusy(true);
    setMsg(null);
    setProg(null);
    try {
      await api.saveSubs(id, norm());
      const out = await api.render(id, ambient, subtitlesEnabled);
      if (out) setExportedPath(out);
      setMsg({
        text: out
          ? `Render complete! All scenes combined into 1 video (${subtitlesEnabled ? "with subtitles" : "without subtitles"}) & exported to: ${out}`
          : `Render complete! All scenes combined into 1 video (${subtitlesEnabled ? "with subtitles" : "without subtitles"}).`,
        kind: "ok",
      });
      const updated = await api.get(id);
      setD(updated);
      if (updated.has_final) {
        setPreviewMode("video");
      }
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    }
    setBusy(false);
  };

  const pickAmbient = async () => {
    const p = await open({
      filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "ogg"] }],
    });
    if (typeof p === "string") setAmbient(p);
  };

  const exportIt = async (chooseCustomLocation = false) => {
    let dest: string | null = null;
    if (chooseCustomLocation) {
      dest = await save({
        defaultPath: `${d?.project.name || "video"}.mp4`,
        filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
      });
      if (!dest) return;
    }
    try {
      setBusy(true);
      const out = await api.exportVideo(id, dest);
      setExportedPath(out);
      setMsg({
        text: `Exported successfully to: ${out} (with subtitles saved as .srt)`,
        kind: "ok",
      });
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  // Keyboard navigation: Space (play/pause), Up/Down (switch cue), Ctrl+S (save)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const inInput = tag === "input" || tag === "textarea";

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveOnly();
        return;
      }

      if (!inInput) {
        if (e.key === " " || e.code === "Space") {
          e.preventDefault();
          togglePlayCurrent();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((prev) => Math.max(0, prev - 1));
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((prev) => Math.min(cues.length - 1, prev + 1));
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cues.length, sel, isPlaying]);

  if (!d) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <Icon name="doc" size={24} />
        </div>
        <h3>{msg?.text ?? "Loading editor…"}</h3>
      </div>
    );
  }

  const tone = stageMeta(d.project.stage);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">
            <button className="crumb-link" onClick={onProjects}>
              Projects
            </button>
            <Icon name="chevron-right" size={14} />
            <button className="crumb-link" onClick={onBack}>
              {d.project.name}
            </button>
            <Icon name="chevron-right" size={14} />
            <span>Editor</span>
          </div>
          <div className="title-row">
            <h1 className="page-title">{d.project.name}</h1>
            <span className={`chip ${tone.tone}`} style={{ position: "static" }}>
              {tone.label}
            </span>
          </div>
          <p className="page-sub">
            Subtitles · {minutes(d.project.duration_sec)} min ·{" "}
            {sceneLabel(d.scenes.length)} · {langLabel(d.project.language)}
          </p>
        </div>
        <div className="head-actions" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* Subtitles ON/OFF Toggle */}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setSubtitlesEnabled((prev) => !prev)}
            title={subtitlesEnabled ? "Subtitles: ON (will be burned into video). Click to turn OFF." : "Subtitles: OFF (clean video without text). Click to turn ON."}
            style={{
              borderColor: subtitlesEnabled ? "var(--accent-primary, #6366f1)" : "var(--border-subtle, #334155)",
              background: subtitlesEnabled ? "rgba(99, 102, 241, 0.12)" : "rgba(255, 255, 255, 0.04)",
              color: subtitlesEnabled ? "var(--accent-primary, #6366f1)" : "var(--text-secondary, #94a3b8)",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: subtitlesEnabled ? "#22c55e" : "#94a3b8",
                display: "inline-block",
              }}
            />
            Subtitles: {subtitlesEnabled ? "ON" : "OFF"}
          </button>

          <button className="btn" disabled={busy} onClick={saveOnly}>
            Save subtitles
          </button>
          <button className="btn primary" disabled={busy} onClick={render}>
            <Icon name="film" size={15} />
            {busy ? "Rendering Video…" : "Combine & Render Video (1080p)"}
          </button>
          {d.has_final && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => exportIt(false)}
              style={{ background: "#059669", color: "#fff", borderColor: "#047857" }}
              title="Export combined video to configured output folder"
            >
              <Icon name="check" size={15} />
              Export Video
            </button>
          )}
          {exportedPath && (
            <button
              className="btn ghost"
              onClick={() => api.openOutputDir(exportedPath)}
              title="Open output folder in File Explorer"
            >
              <Icon name="folder" size={15} />
              Open Folder
            </button>
          )}
        </div>
      </div>

      {busy && prog && (
        <div className="progress-box">
          <div className="progress-head">
            <b>{stageName(prog.stage)}</b>
            <span className="muted">
              {prog.done} / {prog.total}
            </span>
          </div>
          <div className="bar">
            <span
              style={{
                width: `${Math.min(100, (prog.done / Math.max(prog.total, 1)) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {msg && (
        <div
          className={`alert ${msg.kind}`}
          style={{
            marginBottom: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>{msg.text}</span>
          {exportedPath && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => api.openOutputDir(exportedPath)}
              style={{ padding: "4px 10px", fontSize: 12 }}
            >
              <Icon name="folder" size={13} />
              Show in File Explorer
            </button>
          )}
        </div>
      )}

      <div className="editor-grid">
        <div className="editor-left">
          {d.has_final && (
            <div className="seg" style={{ marginBottom: 10, alignSelf: "start" }}>
              <button
                type="button"
                className={previewMode === "cue" ? "active" : ""}
                onClick={() => setPreviewMode("cue")}
              >
                Cue Still
              </button>
              <button
                type="button"
                className={previewMode === "video" ? "active" : ""}
                onClick={() => setPreviewMode("video")}
              >
                Rendered Video
              </button>
            </div>
          )}

          {previewMode === "video" && d.has_final ? (
            <div className="preview-box" style={{ background: "#000" }}>
              <video
                controls
                src={fileUrl(d.dir, "final.mp4")}
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            </div>
          ) : (
            <div className="preview-box">
              {cur?.s.image_path ? (
                <img src={fileUrl(d.dir, cur.s.image_path)} alt="" />
              ) : (
                <div className="preview-empty">
                  <Icon name="image" size={30} />
                </div>
              )}
              {cue?.text && subtitlesEnabled && (
                <div className="preview-caption khmer">{cue.text}</div>
              )}
              {cue && cur?.s.audio_path && (
                <button
                  className="preview-play"
                  onClick={togglePlayCurrent}
                  type="button"
                >
                  <Icon name={isPlaying ? "pause" : "play"} size={14} />
                  {isPlaying ? "Pause cue" : "Play cue"}
                </button>
              )}
            </div>
          )}

          <div className="panel summary-card" style={{ position: "static", gap: 12 }}>
            <div className="summary-list">
              <div className="summary-row">
                <span>Cue</span>
                <b>
                  {cues.length ? sel + 1 : 0} of {cues.length}
                </b>
              </div>
              <div className="summary-row">
                <span>Ambient sound</span>
                <b className="truncate" title={ambient ?? undefined}>
                  {ambient ? ambient.split(/[\\/]/).pop() : "None"}
                </b>
              </div>
              <div className="summary-row">
                <span>Subtitles in video</span>
                <button
                  type="button"
                  onClick={() => setSubtitlesEnabled(!subtitlesEnabled)}
                  style={{
                    border: "1px solid",
                    borderColor: subtitlesEnabled ? "rgba(34, 197, 94, 0.4)" : "rgba(148, 163, 184, 0.3)",
                    background: subtitlesEnabled ? "rgba(34, 197, 94, 0.12)" : "rgba(148, 163, 184, 0.1)",
                    color: subtitlesEnabled ? "#22c55e" : "#94a3b8",
                    padding: "2px 8px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                  title="Toggle burn-in subtitles for final video"
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: subtitlesEnabled ? "#22c55e" : "#94a3b8",
                      display: "inline-block",
                    }}
                  />
                  {subtitlesEnabled ? "ON (Burn-in)" : "OFF (Clean)"}
                </button>
              </div>
              <div className="summary-row" style={{ borderBottom: 0 }}>
                <span>Final video</span>
                <b>{d.has_final ? "Rendered (Ready)" : "Not rendered"}</b>
              </div>
            </div>

            <div className="toolbar" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button className="btn sm" disabled={busy} onClick={rebuild}>
                Rebuild from script
              </button>
              <button className="btn sm" disabled={busy} onClick={pickAmbient}>
                <Icon name="film" size={14} />
                {ambient ? "Change ambient" : "Ambient sound"}
              </button>
              <button
                className="btn sm"
                disabled={busy || !d.has_final}
                onClick={() => exportIt(false)}
                title="Export combined video to output directory"
              >
                <Icon name="check" size={14} />
                Export MP4
              </button>
              <button
                className="btn sm ghost"
                disabled={busy || !d.has_final}
                onClick={() => exportIt(true)}
                title="Choose custom location to save MP4"
              >
                Export As…
              </button>
              {d.has_final && (
                <button
                  className="btn sm ghost"
                  onClick={() => api.openOutputDir(exportedPath || null)}
                  title="Open video output folder"
                >
                  <Icon name="folder" size={14} />
                  Open Folder
                </button>
              )}
            </div>

            {ambient && (
              <div className="ambient-note">
                <Icon name="check" size={14} />
                <span className="truncate">{ambient}</span>
              </div>
            )}
          </div>
        </div>

        <section className="cue-panel">
          <div className="cue-head">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h2>Subtitles</h2>
                <button
                  type="button"
                  onClick={() => setSubtitlesEnabled(!subtitlesEnabled)}
                  style={{
                    border: "none",
                    background: subtitlesEnabled ? "rgba(99, 102, 241, 0.12)" : "rgba(148, 163, 184, 0.12)",
                    color: subtitlesEnabled ? "var(--accent-primary, #6366f1)" : "var(--muted)",
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                  title="Click to toggle burn-in subtitles on/off for video"
                >
                  Burn-in: {subtitlesEnabled ? "ON" : "OFF"}
                </button>
              </div>
              <p className="muted" style={{ fontSize: 13.5, marginTop: 2 }}>
                Click a row to hear that line. Space to play/pause, ↑/↓ to navigate.
              </p>
            </div>
            <div className="toolbar">
              <button className="btn sm" onClick={add}>
                <Icon name="plus" size={14} />
                Add cue
              </button>
            </div>
          </div>

          <div>
            {cues.map((c, i) => {
              const durSec = ((c.end_ms - c.start_ms) / 1000).toFixed(1);
              return (
                <div
                  key={i}
                  className={`cue-row${i === sel ? " active" : ""}`}
                  onClick={() => play(i)}
                >
                  <div className="cue-num">{i + 1}</div>
                  <div className="cue-times">
                    <div className="cue-field" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        aria-label={`Cue ${i + 1} start`}
                        value={c.start_ms}
                        onChange={(e) => edit(i, { start_ms: +e.target.value })}
                      />
                    </div>
                    <div className="cue-arrow">→</div>
                    <div className="cue-field" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        aria-label={`Cue ${i + 1} end`}
                        value={c.end_ms}
                        onChange={(e) => edit(i, { end_ms: +e.target.value })}
                      />
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--muted)",
                        fontWeight: 600,
                        marginLeft: 4,
                      }}
                      title="Cue duration"
                    >
                      {durSec}s
                    </span>
                  </div>
                  <div className="cue-field cue-text" onClick={(e) => e.stopPropagation()}>
                    <textarea
                      className="khmer"
                      rows={2}
                      aria-label={`Cue ${i + 1} text`}
                      value={c.text}
                      onChange={(e) => edit(i, { text: e.target.value })}
                    />
                  </div>
                  <button
                    className="icon-btn danger cue-del"
                    title="Delete cue"
                    onClick={(e) => {
                      e.stopPropagation();
                      del(i);
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              );
            })}
            {!cues.length && (
              <div className="empty" style={{ border: 0, padding: "40px 20px" }}>
                <div className="empty-icon">
                  <Icon name="doc" size={22} />
                </div>
                <p>No subtitles yet. Rebuild them from the script.</p>
              </div>
            )}
          </div>
        </section>
      </div>

      <audio
        ref={audio}
        onTimeUpdate={() => {
          const a = audio.current;
          if (a && stopTimeRef.current !== null && a.currentTime >= stopTimeRef.current) {
            a.pause();
            setIsPlaying(false);
            stopTimeRef.current = null;
          }
        }}
        onEnded={() => {
          setIsPlaying(false);
          stopTimeRef.current = null;
        }}
        onPause={() => setIsPlaying(false)}
      />
    </>
  );
}
