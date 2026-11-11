import { useEffect, useRef, useState } from "react";
import { api, onProgress, fileUrl, Detail, Progress, Scene } from "./api";
import { Icon } from "./components/icons";
import { langLabel, stageName } from "./format";
import { VoiceRecorderModal } from "./components/VoiceRecorderModal";

type Msg = { text: string; kind: "ok" | "error" } | null;

export default function Pipeline({
  id,
  onBack,
  onEditor,
}: {
  id: string;
  onBack: () => void;
  onEditor: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [prog, setProg] = useState<Progress | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const lastErr = useRef("");

  // Project rename state
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState("");

  // Collapsible story & character details
  const [showStory, setShowStory] = useState(false);
  const [storyPrompt, setStoryPrompt] = useState("");
  const [charSheet, setCharSheet] = useState("");
  const [savingStory, setSavingStory] = useState(false);

  // Audio playback state
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);

  // Per-scene edit state
  const [editingSceneId, setEditingSceneId] = useState<number | null>(null);
  const [editNarration, setEditNarration] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [savingScene, setSavingScene] = useState(false);

  // Per-scene single generation loading state
  const [sceneOp, setSceneOp] = useState<{ id: number; kind: "voice" | "image" } | null>(null);

  // Script preview modal state
  const [showScriptPreview, setShowScriptPreview] = useState(false);
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);

  // In-modal scene editing state
  const [modalEditingSceneId, setModalEditingSceneId] = useState<number | null>(null);
  const [modalNarration, setModalNarration] = useState("");
  const [modalImagePrompt, setModalImagePrompt] = useState("");
  const [modalSavingScene, setModalSavingScene] = useState(false);

  // In-modal adding new scene state
  const [showAddScene, setShowAddScene] = useState(false);
  const [newSceneNarration, setNewSceneNarration] = useState("");
  const [newSceneImagePrompt, setNewSceneImagePrompt] = useState("");
  const [addingScene, setAddingScene] = useState(false);

  // Single-character voice recording modal state
  const [recordingScene, setRecordingScene] = useState<Scene | null>(null);

  // Scenes per image toggle (1 or 2)
  const [scenesPerImage, setScenesPerImage] = useState<number>(1);

  // Full image lightbox preview modal
  const [previewImgUrl, setPreviewImgUrl] = useState<string | null>(null);

  const load = async () => {
    const data = await api.get(id);
    setD(data);
    setNameVal(data.project.name);
    setStoryPrompt(data.project.prompt);
    setCharSheet(data.project.character_sheet);
  };

  useEffect(() => {
    load();
    const un = onProgress((p) => {
      if (p.project_id !== id) return;
      setProg(p);
      if (p.message) lastErr.current = p.message;
    });
    return () => {
      un.then((f) => f());
    };
  }, [id]);

  const run = async (name: string, fn: () => Promise<number>) => {
    setBusy(name);
    setMsg(null);
    setProg(null);
    lastErr.current = "";
    try {
      const failed = await fn();
      setMsg(
        failed
          ? {
              text: `${failed} failed (${lastErr.current}). Run it again: only missing items are retried.`,
              kind: "error",
            }
          : { text: "Done", kind: "ok" },
      );
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    }
    setBusy(null);
    load();
  };

  const handleSaveName = async () => {
    const clean = nameVal.trim();
    if (!clean || clean === d?.project.name) {
      setEditingName(false);
      return;
    }
    try {
      await api.renameProject(id, clean);
      setEditingName(false);
      load();
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    }
  };

  const handleSaveStory = async () => {
    setSavingStory(true);
    setMsg(null);
    try {
      await api.updateProjectStory(id, storyPrompt, charSheet);
      setMsg({ text: "Story & character details saved", kind: "ok" });
      load();
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setSavingStory(false);
    }
  };

  const toggleAudio = (s: Scene) => {
    if (!s.audio_path || !d) return;
    const a = audioRef.current;
    if (!a) return;

    if (playingId === s.id) {
      a.pause();
      setPlayingId(null);
      return;
    }

    a.src = fileUrl(d.dir, s.audio_path);
    a.play().then(() => setPlayingId(s.id)).catch(() => setPlayingId(null));
  };

  const startEditScene = (s: Scene) => {
    setEditingSceneId(s.id);
    setEditNarration(s.narration);
    setEditPrompt(s.image_prompt);
  };

  const saveSceneEdit = async (s: Scene) => {
    setSavingScene(true);
    setMsg(null);
    try {
      await api.updateScene(s.id, editNarration, editPrompt);
      setEditingSceneId(null);
      load();
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setSavingScene(false);
    }
  };

  const runSingleVoice = async (sceneId: number) => {
    setSceneOp({ id: sceneId, kind: "voice" });
    setMsg(null);
    try {
      await api.generateSceneVoice(sceneId);
      load();
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setSceneOp(null);
    }
  };

  const runSingleImage = async (sceneId: number) => {
    setSceneOp({ id: sceneId, kind: "image" });
    setMsg(null);
    try {
      await api.generateSceneImage(sceneId);
      load();
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setSceneOp(null);
    }
  };

  if (!d) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <Icon name="film" size={24} />
        </div>
        <h3>Loading project…</h3>
      </div>
    );
  }

  const sc = d.scenes;
  const hasScript = sc.length > 0;
  const voiceDone = hasScript && sc.every((s) => s.audio_path);
  const withAudio = sc.filter((s) => s.audio_path).length;
  const withImage = sc.filter((s) => s.image_path).length;
  const confirmRegenerateScript = () => {
    if (
      !hasScript ||
      confirm(
        "Are you sure you want to generate the script again?\n\nThis will recreate all scenes from your prompt and DELETE all existing voice recordings and images for this project.",
      )
    ) {
      run("script", () => api.script(id));
    }
  };
  const generateScript = confirmRegenerateScript;

  const handleSaveModalPrompt = async (newPrompt: string) => {
    setSavingPrompt(true);
    setMsg(null);
    try {
      await api.updateProjectStory(id, newPrompt, charSheet);
      setStoryPrompt(newPrompt);
      if (d) {
        setD({
          ...d,
          project: { ...d.project, prompt: newPrompt },
        });
      }
      setIsEditingPrompt(false);
      setMsg({ text: "Story prompt saved", kind: "ok" });
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setSavingPrompt(false);
    }
  };

  const handleStartEditModalScene = (s: Scene) => {
    setModalEditingSceneId(s.id);
    setModalNarration(s.narration);
    setModalImagePrompt(s.image_prompt);
  };

  const handleSaveModalScene = async (sceneId: number) => {
    setModalSavingScene(true);
    setMsg(null);
    try {
      await api.updateScene(sceneId, modalNarration, modalImagePrompt);
      setModalEditingSceneId(null);
      await load();
      setMsg({ text: "Scene script updated", kind: "ok" });
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setModalSavingScene(false);
    }
  };

  const handleDeleteModalScene = async (sceneId: number, sceneIdx: number) => {
    if (!confirm(`Delete Scene #${sceneIdx + 1}?`)) return;
    setMsg(null);
    try {
      await api.deleteScene(sceneId);
      await load();
      setMsg({ text: `Scene #${sceneIdx + 1} deleted`, kind: "ok" });
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    }
  };

  const handleAddNewScene = async () => {
    if (!newSceneNarration.trim()) return;
    setAddingScene(true);
    setMsg(null);
    try {
      await api.addScene(id, newSceneNarration, newSceneImagePrompt);
      setNewSceneNarration("");
      setNewSceneImagePrompt("");
      setShowAddScene(false);
      await load();
      setMsg({ text: "New scene added to script", kind: "ok" });
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setAddingScene(false);
    }
  };

  const handleGenerateScriptAgain = async () => {
    if (isEditingPrompt && promptDraft.trim() !== (d?.project.prompt || "").trim()) {
      await handleSaveModalPrompt(promptDraft);
    }
    confirmRegenerateScript();
  };

  return (
    <>
      <div className="nitean-pipeline">
        {/* Top Header */}
        <div className="nitean-header">
          <button className="nitean-crumb-btn" onClick={onBack}>
            Projects
          </button>
          <div className="nitean-title-row">
            {editingName ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  className="nitean-title-input"
                  value={nameVal}
                  onChange={(e) => setNameVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  autoFocus
                />
                <button className="btn sm primary" onClick={handleSaveName}>
                  Save
                </button>
                <button className="btn sm ghost" onClick={() => setEditingName(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h1 className="nitean-title">{d.project.name}</h1>
                <button
                  className="icon-btn sm"
                  onClick={() => setEditingName(true)}
                  title="Rename project"
                  style={{ opacity: 0.6 }}
                >
                  <Icon name="pencil" size={15} />
                </button>
              </div>
            )}
          </div>

          {/* Badges Row */}
          <div className="nitean-badges-row">
            <span className="nitean-status-badge approved">
              <span className="dot" /> Approved
            </span>
            <span className="nitean-ratio-badge">16:9</span>
            <span className="nitean-counts-text">
              Voices: {withAudio} of {sc.length} · Images: {withImage} of {sc.length}
            </span>

            {d.has_final && (
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  className="btn sm"
                  style={{ background: "#059669", color: "#fff", borderColor: "#047857" }}
                  disabled={!!busy}
                  onClick={async () => {
                    try {
                      const out = await api.exportVideo(id);
                      setMsg({ text: `Combined video exported to: ${out}`, kind: "ok" });
                    } catch (e) {
                      setMsg({ text: String(e), kind: "error" });
                    }
                  }}
                >
                  <Icon name="check" size={14} /> Export Video
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() => api.openOutputDir()}
                  title="Open output directory"
                >
                  <Icon name="folder" size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Stage Steps Pill Tabs */}
          <div className="nitean-stage-tabs">
            <button
              type="button"
              className="nitean-stage-tab done"
              onClick={() => setShowScriptPreview(true)}
            >
              <Icon name="check" size={13} />
              <span>Script</span>
            </button>
            <button
              type="button"
              className="nitean-stage-tab active"
              onClick={() => {}}
            >
              <Icon name="volume" size={14} />
              <span>Voices &amp; pictures</span>
            </button>
            <button
              type="button"
              className={`nitean-stage-tab ${voiceDone ? "" : "disabled"}`}
              disabled={!voiceDone}
              onClick={onEditor}
            >
              <Icon name="video" size={14} />
              <span>Edit &amp; export</span>
            </button>
          </div>

          {/* Action Toolbar */}
          <div className="nitean-action-bar">
            <div className="nitean-action-left">
              <button
                type="button"
                className="nitean-tool-btn"
                onClick={() => {
                  setPromptDraft(d.project.prompt || "");
                  setIsEditingPrompt(false);
                  setShowAddScene(false);
                  setModalEditingSceneId(null);
                  setShowScriptPreview(true);
                }}
              >
                <Icon name="pencil" size={14} />
                <span>Edit script</span>
              </button>
              <button
                type="button"
                className="nitean-tool-btn"
                disabled={!!busy}
                onClick={() => run("voice", () => api.voice(id))}
              >
                <Icon name="volume" size={14} />
                <span>Generate voices</span>
              </button>
              <button
                type="button"
                className="nitean-tool-btn"
                onClick={() => setShowStory(!showStory)}
              >
                <Icon name="wand" size={14} />
                <span>Improve image prompts</span>
              </button>
              <button
                type="button"
                className="nitean-tool-btn primary-glow"
                disabled={!!busy}
                onClick={() => run("images", () => api.images(id))}
              >
                <Icon name="sparkles" size={14} />
                <span>Generate images</span>
              </button>
            </div>
          </div>

          {/* Sub-bar: Scenes per image + allowance */}
          <div className="nitean-subbar">
            <div className="nitean-subbar-left">
              <span className="nitean-subbar-label">Scenes per image</span>
              <div className="nitean-seg">
                <button
                  type="button"
                  className={`nitean-seg-btn ${scenesPerImage === 1 ? "active" : ""}`}
                  onClick={() => setScenesPerImage(1)}
                >
                  1
                </button>
                <button
                  type="button"
                  className={`nitean-seg-btn ${scenesPerImage === 2 ? "active" : ""}`}
                  onClick={() => setScenesPerImage(2)}
                >
                  2
                </button>
              </div>
            </div>
            <div className="nitean-subbar-info">
              {sc.length} images · {sc.length} Cloudflare (free, ~5% of today's allowance)
            </div>
          </div>
        </div>

        {/* Collapsible Story Details */}
        {showStory && (
          <section className="panel" style={{ padding: 18, margin: "10px 0", display: "grid", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: 16 }}>Story Prompt & Visual Continuity</h3>
              <span className="muted" style={{ fontSize: 13 }}>
                Visual descriptions here guide every scene's image generation.
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div className="field">
                <label>Story Prompt</label>
                <textarea
                  rows={4}
                  value={storyPrompt}
                  onChange={(e) => setStoryPrompt(e.target.value)}
                  placeholder="Story prompt..."
                />
              </div>
              <div className="field">
                <label>Character & Setting Sheet (Visual Guide)</label>
                <textarea
                  rows={4}
                  value={charSheet}
                  onChange={(e) => setCharSheet(e.target.value)}
                  placeholder="Descriptions of characters, clothing, color palette, setting..."
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              {hasScript && (
                <button
                  type="button"
                  className="btn sm ghost"
                  style={{ color: "#b91c1c", borderColor: "#fecaca" }}
                  disabled={!!busy || savingStory}
                  onClick={confirmRegenerateScript}
                  title="Regenerate script using the prompt above"
                >
                  <Icon name="refresh" size={13} />
                  Regenerate Script from Prompt
                </button>
              )}
              <button
                className="btn sm primary"
                disabled={savingStory}
                onClick={handleSaveStory}
              >
                {savingStory ? "Saving…" : "Save Details"}
              </button>
            </div>
          </section>
        )}

        {/* Progress box */}
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

        {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

        {/* Chapter 1 Header */}
        <div className="nitean-chapter-row">
          <div className="nitean-chapter-left">
            <span className="nitean-chapter-pill">Chapter 1</span>
            <span className="nitean-chapter-title">
              {d.project.name}
            </span>
          </div>
          <span className="nitean-chapter-count">{sc.length} scenes</span>
        </div>

        {/* 4-Column Scene Grid */}
        {sc.length ? (
          <div className="nitean-scene-grid">
            {sc.map((s) => {
              const isPlayingThis = playingId === s.id;
              const isEditing = editingSceneId === s.id;
              const isVoiceOp = sceneOp?.id === s.id && sceneOp.kind === "voice";
              const isImageOp = sceneOp?.id === s.id && sceneOp.kind === "image";
              const durText = s.audio_ms ? `${(s.audio_ms / 1000).toFixed(1)}s` : null;

              return (
                <div key={s.id} className="nitean-scene-card">
                  <div className="nitean-card-thumb">
                    {s.image_path ? (
                      <img
                        src={fileUrl(d.dir, s.image_path)}
                        alt=""
                        loading="lazy"
                        className="nitean-thumb-img"
                        onClick={() => setPreviewImgUrl(fileUrl(d.dir, s.image_path!))}
                      />
                    ) : (
                      <div className="nitean-thumb-empty">
                        <Icon name="image" size={26} className="placeholder-icon" />
                      </div>
                    )}
                    <span className="nitean-key-badge">Key</span>
                    <div className="nitean-thumb-overlay">
                      {String(s.idx + 1).padStart(3, "0")} {durText || "--:--"}
                    </div>
                  </div>

                  <div className="nitean-card-content">
                    <div className="nitean-status-row">
                      <span className={`nitean-pill ${s.audio_path ? "voiced" : "pending"}`}>
                        <Icon name="volume" size={11} />
                        {isVoiceOp ? "Voicing…" : s.audio_path ? (durText || "Voiced") : "Pending"}
                      </span>
                      <span className={`nitean-pill ${s.image_path ? "drawn" : "pending"}`}>
                        <Icon name="image" size={11} />
                        {isImageOp ? "Drawing…" : s.image_path ? "Ready" : "Pending"}
                      </span>
                    </div>

                    {isEditing ? (
                      <div style={{ display: "grid", gap: 6, margin: "6px 0" }}>
                        <textarea
                          rows={2}
                          value={editNarration}
                          onChange={(e) => setEditNarration(e.target.value)}
                          placeholder="Narration..."
                          style={{ fontSize: 12 }}
                        />
                        <textarea
                          rows={2}
                          value={editPrompt}
                          onChange={(e) => setEditPrompt(e.target.value)}
                          placeholder="Image prompt..."
                          style={{ fontSize: 11 }}
                        />
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button className="btn sm primary" disabled={savingScene} onClick={() => saveSceneEdit(s)}>
                            {savingScene ? "Saving…" : "Save"}
                          </button>
                          <button className="btn sm ghost" disabled={savingScene} onClick={() => setEditingSceneId(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="nitean-narration-text" title={s.narration}>
                        {s.narration || "No narration text"}
                      </div>
                    )}

                    <div className="nitean-card-actions">
                      {s.audio_path ? (
                        <button
                          type="button"
                          className="nitean-act-btn"
                          onClick={() => toggleAudio(s)}
                          title={isPlayingThis ? "Pause audio" : "Play audio preview"}
                        >
                          <Icon name={isPlayingThis ? "pause" : "play"} size={13} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="nitean-act-btn"
                          disabled={!!busy || isVoiceOp}
                          onClick={() => runSingleVoice(s.id)}
                          title="Generate voice for this scene"
                        >
                          <Icon name="volume" size={13} />
                        </button>
                      )}

                      <button
                        type="button"
                        className="nitean-act-btn"
                        disabled={!!busy || isVoiceOp || isImageOp}
                        onClick={() => {
                          if (s.image_path) runSingleImage(s.id);
                          else runSingleVoice(s.id);
                        }}
                        title="Regenerate scene"
                      >
                        <Icon name="refresh" size={13} />
                      </button>

                      <button
                        type="button"
                        className="nitean-act-btn"
                        disabled={!s.image_path}
                        onClick={() => s.image_path && setPreviewImgUrl(fileUrl(d.dir, s.image_path!))}
                        title="View full image"
                      >
                        <Icon name="external-link" size={13} />
                      </button>

                      <button
                        type="button"
                        className="nitean-act-btn"
                        onClick={() => (isEditing ? setEditingSceneId(null) : startEditScene(s))}
                        title="Edit narration or prompt"
                      >
                        <Icon name="pencil" size={13} />
                      </button>

                      <button
                        type="button"
                        className="nitean-act-btn record"
                        onClick={() => setRecordingScene(s)}
                        title="Record voice for this character"
                      >
                        <Icon name="mic" size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty">
            <div className="empty-icon">
              <Icon name="sparkles" size={24} />
            </div>
            <h3>No scenes yet</h3>
            <p>Generate the script first — each beat becomes one scene.</p>
            <button className="btn primary" disabled={!!busy} onClick={generateScript}>
              Generate script
            </button>
          </div>
        )}
      </div>

      {/* Image Lightbox Preview Modal */}
      {previewImgUrl && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0, 0, 0, 0.85)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          onClick={() => setPreviewImgUrl(null)}
        >
          <div
            style={{
              position: "relative",
              maxWidth: "90vw",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setPreviewImgUrl(null)}
              style={{
                position: "absolute",
                top: -36,
                right: 0,
                background: "transparent",
                border: 0,
                color: "#fff",
                fontSize: 16,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Icon name="x" size={20} /> Close
            </button>
            <img
              src={previewImgUrl}
              alt=""
              style={{
                maxWidth: "100%",
                maxHeight: "85vh",
                borderRadius: 12,
                boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
                objectFit: "contain",
              }}
            />
          </div>
        </div>
      )}

      {/* Hidden audio element for previewing scene voices */}
      <audio
        ref={audioRef}
        onEnded={() => setPlayingId(null)}
        onPause={() => setPlayingId(null)}
      />

      {/* Script Preview & Edit Modal */}
      {showScriptPreview && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(18, 16, 12, 0.7)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          onClick={() => setShowScriptPreview(false)}
        >
          <div
            style={{
              background: "var(--modal-bg, #fff)",
              color: "var(--ink, #141311)",
              borderRadius: 16,
              maxWidth: 820,
              width: "100%",
              maxHeight: "88vh",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 20px 48px rgba(0, 0, 0, 0.35)",
              overflow: "hidden",
              border: "1px solid var(--line)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: "18px 24px",
                borderBottom: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "var(--modal-header-bg, #faf8f5)",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>
                    Script Preview
                  </h3>
                  <span className="chip neutral" style={{ position: "static" }}>
                    {sc.length} scene{sc.length === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                  {d.project.name} · {langLabel(d.project.language)}
                </p>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowScriptPreview(false)}
                title="Close preview"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  border: "1px solid var(--line)",
                  background: "var(--btn-bg, #fff)",
                  color: "var(--ink)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <Icon name="x" size={16} />
              </button>
            </div>

            {/* Modal Body */}
            <div
              style={{
                padding: "20px 24px",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 18,
                flex: 1,
              }}
            >
              {/* Story Prompt Box (Editable) */}
              <div
                style={{
                  padding: "16px",
                  background: "var(--soft, #f8f6f2)",
                  borderRadius: 12,
                  border: "1px solid var(--line)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--accent, #f97316)", display: "inline-flex" }}>
                      <Icon name="sparkles" size={15} />
                    </span>
                    <b style={{ color: "var(--ink)", fontSize: 13.5 }}>Story Prompt:</b>
                  </div>
                  {!isEditingPrompt ? (
                    <button
                      type="button"
                      className="btn sm"
                      style={{ padding: "4px 11px", fontSize: 12, height: 28, display: "inline-flex", alignItems: "center", gap: 6 }}
                      onClick={() => {
                        setPromptDraft(d.project.prompt || "");
                        setIsEditingPrompt(true);
                      }}
                      title="Edit this story prompt"
                    >
                      <Icon name="pencil" size={12} />
                      Edit Prompt
                    </button>
                  ) : (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="btn sm ghost"
                        style={{ padding: "4px 10px", fontSize: 12, height: 28 }}
                        onClick={() => setIsEditingPrompt(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn sm primary"
                        style={{ padding: "4px 12px", fontSize: 12, height: 28 }}
                        disabled={savingPrompt}
                        onClick={() => handleSaveModalPrompt(promptDraft)}
                      >
                        {savingPrompt ? "Saving…" : "Save Prompt"}
                      </button>
                    </div>
                  )}
                </div>

                {isEditingPrompt ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <textarea
                      className="input"
                      rows={4}
                      value={promptDraft}
                      onChange={(e) => setPromptDraft(e.target.value)}
                      placeholder="Describe the story setting, characters, and plot beats..."
                      style={{
                        width: "100%",
                        padding: "10px 12px",
                        fontSize: 13.5,
                        borderRadius: 8,
                        resize: "vertical",
                        lineHeight: 1.5,
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 12,
                        color: "var(--muted)",
                      }}
                    >
                      <span>Rewrite your prompt above, then click <b>Generate Script Again</b> to recreate all scenes.</span>
                      <span>{promptDraft.length} chars</span>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      color: d.project.prompt ? "var(--ink)" : "var(--muted)",
                      fontSize: 13.5,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      cursor: "pointer",
                      fontStyle: d.project.prompt ? "normal" : "italic",
                    }}
                    onClick={() => {
                      setPromptDraft(d.project.prompt || "");
                      setIsEditingPrompt(true);
                    }}
                    title="Click to edit story prompt"
                  >
                    {d.project.prompt || "No story prompt written yet. Click 'Edit Prompt' to write one."}
                  </div>
                )}
              </div>

              {/* Form to Add New Scene Manually */}
              {showAddScene && (
                <div
                  style={{
                    border: "2px solid #3b82f6",
                    borderRadius: 12,
                    padding: "16px",
                    background: "var(--card-bg, #fff)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    boxShadow: "0 4px 16px rgba(59, 130, 246, 0.12)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <b style={{ fontSize: 14, color: "var(--ink)" }}>Write New Scene #{sc.length + 1}</b>
                    <button
                      type="button"
                      className="btn sm ghost"
                      style={{ padding: "3px 8px", fontSize: 12, height: 26 }}
                      onClick={() => setShowAddScene(false)}
                    >
                      Cancel
                    </button>
                  </div>

                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 5 }}>
                      Narration Text (Spoken audio)
                    </label>
                    <textarea
                      className="input khmer"
                      rows={3}
                      value={newSceneNarration}
                      onChange={(e) => setNewSceneNarration(e.target.value)}
                      placeholder="Write the narration line in Khmer or English..."
                      style={{ width: "100%", fontSize: 14, borderRadius: 8, padding: 10 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 5 }}>
                      Visual Image Prompt (Background illustration)
                    </label>
                    <textarea
                      className="input"
                      rows={2}
                      value={newSceneImagePrompt}
                      onChange={(e) => setNewSceneImagePrompt(e.target.value)}
                      placeholder="Visual prompt: e.g. An ancient moss-covered well at night, moonlight shining through palm trees, atmospheric..."
                      style={{ width: "100%", fontSize: 13, borderRadius: 8, padding: 10 }}
                    />
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => setShowAddScene(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={addingScene || !newSceneNarration.trim()}
                      onClick={handleAddNewScene}
                    >
                      {addingScene ? "Adding…" : "Save Scene"}
                    </button>
                  </div>
                </div>
              )}

              {/* Scenes List or Empty State */}
              {sc.length === 0 && !showAddScene ? (
                <div
                  style={{
                    padding: "36px 20px",
                    textAlign: "center",
                    border: "1px dashed var(--line-strong)",
                    borderRadius: 12,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 12,
                    background: "var(--card-bg, #fff)",
                  }}
                >
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: "50%",
                      background: "var(--soft, #f3efe8)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--muted)",
                    }}
                  >
                    <Icon name="sparkles" size={24} />
                  </div>
                  <div>
                    <h4 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
                      No script scenes yet
                    </h4>
                    <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", maxWidth: 440 }}>
                      Generate scenes automatically with AI from your prompt above, or write scenes manually.
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap", justifyContent: "center" }}>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!!busy}
                      onClick={handleGenerateScriptAgain}
                      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                    >
                      <Icon name="sparkles" size={15} className={busy === "script" ? "spin" : ""} />
                      {busy === "script" ? "Writing script with AI…" : "Generate Script with AI"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setShowAddScene(true)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                    >
                      <Icon name="plus" size={15} />
                      Write Scene Manually
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {sc.map((s) => {
                    const isEditingThis = modalEditingSceneId === s.id;
                    return (
                      <div
                        key={s.id}
                        style={{
                          border: isEditingThis ? "2px solid #3b82f6" : "1px solid var(--line)",
                          borderRadius: 12,
                          padding: "14px 16px",
                          background: "var(--card-bg, #fff)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                          transition: "border-color 0.15s ease",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span
                              style={{
                                fontSize: 11.5,
                                fontWeight: 700,
                                letterSpacing: "0.06em",
                                color: "var(--muted)",
                              }}
                            >
                              SCENE {String(s.idx + 1).padStart(2, "0")}
                            </span>
                            {s.audio_ms ? (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "var(--muted)",
                                  background: "var(--soft, #f3efe8)",
                                  padding: "2px 8px",
                                  borderRadius: 6,
                                }}
                              >
                                {(s.audio_ms / 1000).toFixed(1)}s voice
                              </span>
                            ) : null}
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {!isEditingThis ? (
                              <>
                                <button
                                  type="button"
                                  className="btn sm ghost"
                                  style={{ padding: "3px 8px", fontSize: 12, height: 26, display: "inline-flex", alignItems: "center", gap: 5 }}
                                  onClick={() => handleStartEditModalScene(s)}
                                  title="Edit scene script"
                                >
                                  <Icon name="pencil" size={12} />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn danger"
                                  style={{ width: 26, height: 26 }}
                                  onClick={() => handleDeleteModalScene(s.id, s.idx)}
                                  title="Delete scene"
                                >
                                  <Icon name="trash" size={13} />
                                </button>
                              </>
                            ) : (
                              <div style={{ display: "flex", gap: 6 }}>
                                <button
                                  type="button"
                                  className="btn sm ghost"
                                  style={{ padding: "3px 8px", fontSize: 12, height: 26 }}
                                  onClick={() => setModalEditingSceneId(null)}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  className="btn sm primary"
                                  style={{ padding: "3px 12px", fontSize: 12, height: 26 }}
                                  disabled={modalSavingScene}
                                  onClick={() => handleSaveModalScene(s.id)}
                                >
                                  {modalSavingScene ? "Saving…" : "Save"}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>

                        {isEditingThis ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div>
                              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 4 }}>
                                Narration Text
                              </label>
                              <textarea
                                className="input khmer"
                                rows={3}
                                value={modalNarration}
                                onChange={(e) => setModalNarration(e.target.value)}
                                style={{ width: "100%", fontSize: 14, borderRadius: 8, padding: 10 }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 4 }}>
                                Visual Image Prompt
                              </label>
                              <textarea
                                className="input"
                                rows={2}
                                value={modalImagePrompt}
                                onChange={(e) => setModalImagePrompt(e.target.value)}
                                style={{ width: "100%", fontSize: 13, borderRadius: 8, padding: 10 }}
                              />
                            </div>
                          </div>
                        ) : (
                          <>
                            <div
                              className="khmer"
                              style={{
                                fontSize: 15,
                                lineHeight: 1.7,
                                color: "var(--ink)",
                              }}
                            >
                              {s.narration}
                            </div>

                            <div
                              style={{
                                fontSize: 12,
                                color: "var(--muted)",
                                lineHeight: 1.45,
                                background: "var(--soft, #faf8f5)",
                                padding: "8px 12px",
                                borderRadius: 6,
                                borderLeft: "3px solid var(--line-strong, #d9d2c7)",
                              }}
                            >
                              <b style={{ color: "var(--ink)" }}>Visual Prompt:</b> {s.image_prompt}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}

                  {/* Add scene inline button */}
                  {!showAddScene && (
                    <button
                      type="button"
                      className="btn ghost"
                      style={{
                        padding: "10px",
                        border: "1px dashed var(--line-strong)",
                        borderRadius: 10,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                        fontSize: 13.5,
                      }}
                      onClick={() => setShowAddScene(true)}
                    >
                      <Icon name="plus" size={15} />
                      Write / Add Another Scene
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: "14px 24px",
                borderTop: "1px solid var(--line)",
                background: "var(--modal-header-bg, #faf8f5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                className="btn-danger-soft"
                style={{
                  padding: "8px 16px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13.5,
                }}
                disabled={!!busy}
                onClick={handleGenerateScriptAgain}
                title="Regenerate all scenes from prompt (deletes voices & images)"
              >
                <Icon name="refresh" size={14} className={busy === "script" ? "spin" : ""} />
                {busy === "script" ? "Writing script with AI…" : "Generate Script Again"}
              </button>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {!showAddScene && sc.length > 0 && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setShowAddScene(true)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                  >
                    <Icon name="plus" size={14} />
                    Add Scene
                  </button>
                )}
                {sc.length > 0 && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => {
                      setShowScriptPreview(false);
                      document.getElementById("scenes-section")?.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    Scroll to Scenes
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => setShowScriptPreview(false)}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {recordingScene && (
        <VoiceRecorderModal
          isOpen={!!recordingScene}
          onClose={() => setRecordingScene(null)}
          title={`Record Voice — Scene #${recordingScene.idx + 1}`}
          subtitle="Record narration voice for only this selected character / scene"
          promptText={recordingScene.narration}
          onSave={async (audioBase64) => {
            await api.saveSceneRecording(recordingScene.id, audioBase64);
            await load();
          }}
        />
      )}
    </>
  );
}
