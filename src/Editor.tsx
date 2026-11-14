import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, onProgress, fileUrl, convertFileSrc, sceneMs, Cue, Detail, Progress } from "./api";
import { Icon } from "./components/icons";

type Msg = { text: string; kind: "ok" | "error" } | null;

const HIGHLIGHT_COLORS = [
  { id: "yellow", hex: "#facc15" },
  { id: "red", hex: "#f87171" },
  { id: "green", hex: "#4ade80" },
  { id: "blue", hex: "#38bdf8" },
  { id: "pink", hex: "#f472b6" },
];

function formatMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

export default function Editor({
  id,
  onBack,
  onProjects: _onProjects,
}: {
  id: string;
  onBack: () => void;
  onProjects: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [, setCues] = useState<Cue[]>([]);
  const [activeSceneIdx, setActiveSceneIdx] = useState(0);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [ambient, setAmbient] = useState<string | null>(null);
  const [prog, setProg] = useState<Progress | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [wordTrackerEnabled, setWordTrackerEnabled] = useState(true);
  const [highlightColor, setHighlightColor] = useState("#facc15");
  const [fontChoice] = useState("Khmer OS Battambang · ក ខ គ");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  // Audio volume state (voice narration & background music)
  const [voiceVolume, setVoiceVolume] = useState<number>(100);
  const [bgmVolume, setBgmVolume] = useState<number>(20);
  const [isVoiceMuted, setIsVoiceMuted] = useState(false);
  const [isBgmMuted, setIsBgmMuted] = useState(false);
  const [activeVolumePopover, setActiveVolumePopover] = useState<"voice" | "bgm" | null>(null);

  // Fullscreen / Full-window cinema viewing state
  const [isFullWindow, setIsFullWindow] = useState(false);
  const [showCinemaControls, setShowCinemaControls] = useState(true);
  const [videoRes, setVideoRes] = useState("1080p");
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const volumePopoverRef = useRef<HTMLDivElement>(null);

  // Auto-hide fullscreen cinema controls on mouse idle
  const handleMouseMoveCinema = () => {
    setShowCinemaControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowCinemaControls(false);
      }, 2500);
    }
  };

  // Toggle watch fit-to-screen / full-window cinema mode
  const toggleFullWindow = async () => {
    const nextState = !isFullWindow;
    setIsFullWindow(nextState);
    setShowCinemaControls(true);
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.setFullscreen(nextState);
    } catch (_) {}
  };

  // Close volume popover when clicking outside
  useEffect(() => {
    if (!activeVolumePopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (volumePopoverRef.current && !volumePopoverRef.current.contains(e.target as Node)) {
        setActiveVolumePopover(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [activeVolumePopover]);

  // Real-time synchronization of voice volume to preview audio element
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isVoiceMuted ? 0 : Math.max(0, Math.min(1, voiceVolume / 100));
    }
  }, [voiceVolume, isVoiceMuted]);

  // Real-time synchronization of BGM volume to preview audio element
  useEffect(() => {
    if (bgmRef.current) {
      bgmRef.current.volume = isBgmMuted ? 0 : Math.max(0, Math.min(1, bgmVolume / 100));
    }
  }, [bgmVolume, isBgmMuted]);

  // Synchronize BGM playback state with voice audio playback
  useEffect(() => {
    if (!bgmRef.current || !ambient) return;
    if (isPlaying) {
      bgmRef.current.volume = isBgmMuted ? 0 : Math.max(0, Math.min(1, bgmVolume / 100));
      bgmRef.current.play().catch(() => {});
    } else {
      bgmRef.current.pause();
    }
  }, [isPlaying, ambient, bgmVolume, isBgmMuted]);

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
      if (s.resolution) {
        setVideoRes(s.resolution);
      }
    }).catch(() => {});
    const un = onProgress((p) => {
      if (p.project_id === id) setProg(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, [id]);

  // Compute timing ranges for each scene
  const ranges = useMemo(() => {
    let t = 0;
    return (d?.scenes ?? []).map((s) => {
      const start = t;
      t += sceneMs(s.audio_ms ?? 0);
      return { start, end: t, s };
    });
  }, [d]);

  const totalDurationMs = ranges.length > 0 ? ranges[ranges.length - 1].end : 0;
  const currentScene = d?.scenes[activeSceneIdx] ?? d?.scenes[0];
  const currentSceneDurSec = Math.max(0.1, ((currentScene?.audio_ms ?? 0) / 1000));

  // Compute total elapsed time across the entire video
  const totalCurrentMs = useMemo(() => {
    const sceneStart = ranges[activeSceneIdx]?.start ?? 0;
    return Math.min(totalDurationMs, sceneStart + (currentTimeSec * 1000));
  }, [ranges, activeSceneIdx, currentTimeSec, totalDurationMs]);

  // Split scene narration for real-time word tracker
  const words = useMemo(() => {
    const text = currentScene?.narration || "";
    return text.trim() ? text.split(/\s+/) : [];
  }, [currentScene]);

  // Compute active word index based on playback progress inside active scene
  const activeWordIndex = useMemo(() => {
    if (!isPlaying || !wordTrackerEnabled || words.length === 0 || currentSceneDurSec <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, currentTimeSec / currentSceneDurSec));
    return Math.min(words.length - 1, Math.floor(ratio * words.length));
  }, [isPlaying, wordTrackerEnabled, words.length, currentTimeSec, currentSceneDurSec]);

  // Audio playback controls
  const playScene = (idx: number, startOffsetSec = 0) => {
    if (!d || !d.scenes[idx]) return;
    setActiveSceneIdx(idx);
    const scene = d.scenes[idx];
    const a = audioRef.current;
    if (!a || !scene.audio_path) return;

    const targetSrc = fileUrl(d.dir, scene.audio_path);
    const startSec = Math.max(0, startOffsetSec);

    const startPlayback = () => {
      a.currentTime = startSec;
      a.volume = isVoiceMuted ? 0 : Math.max(0, Math.min(1, voiceVolume / 100));
      a.play().then(() => {
        setIsPlaying(true);
        if (ambient && bgmRef.current) {
          bgmRef.current.volume = isBgmMuted ? 0 : Math.max(0, Math.min(1, bgmVolume / 100));
          bgmRef.current.play().catch(() => {});
        }
      }).catch(() => setIsPlaying(false));
    };

    if (a.src !== targetSrc) {
      a.src = targetSrc;
      a.onloadedmetadata = () => startPlayback();
    } else {
      startPlayback();
    }
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) {
      a.pause();
      if (bgmRef.current) bgmRef.current.pause();
      setIsPlaying(false);
    } else {
      if (a.src && a.src.includes(currentScene?.audio_path || "")) {
        a.volume = isVoiceMuted ? 0 : Math.max(0, Math.min(1, voiceVolume / 100));
        a.play().then(() => {
          setIsPlaying(true);
          if (ambient && bgmRef.current) {
            bgmRef.current.volume = isBgmMuted ? 0 : Math.max(0, Math.min(1, bgmVolume / 100));
            bgmRef.current.play().catch(() => {});
          }
        }).catch(() => setIsPlaying(false));
      } else {
        playScene(activeSceneIdx, currentTimeSec);
      }
    }
  };

  const handleNextScene = () => {
    if (!d) return;
    const nextIdx = Math.min(d.scenes.length - 1, activeSceneIdx + 1);
    setCurrentTimeSec(0);
    playScene(nextIdx, 0);
  };

  const handlePrevScene = () => {
    if (!d) return;
    const prevIdx = Math.max(0, activeSceneIdx - 1);
    setCurrentTimeSec(0);
    playScene(prevIdx, 0);
  };

  // Import custom audio from user's local file for a specific scene
  const handleImportSceneAudio = async (targetSceneIdx?: number) => {
    if (!d) return;
    const sIdx = typeof targetSceneIdx === "number" ? targetSceneIdx : activeSceneIdx;
    const targetScene = d.scenes[sIdx];
    if (!targetScene) return;

    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "m4a", "ogg", "aac", "flac"] }],
      });
      if (!selected || typeof selected !== "string") return;

      setBusy(true);
      setMsg({ text: `Importing audio for Scene ${sIdx + 1}…`, kind: "ok" });
      const newMs = await api.importSceneAudio(targetScene.id, selected);
      await load();
      setCurrentTimeSec(0);
      playScene(sIdx, 0);
      setMsg({
        text: `Scene ${sIdx + 1} voice replaced with imported audio (${(newMs / 1000).toFixed(1)}s)!`,
        kind: "ok",
      });
    } catch (e) {
      setMsg({ text: `Failed to import audio: ${String(e)}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  // Import background music / ambient audio file
  const handlePickAmbient = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Music / Audio", extensions: ["mp3", "wav", "m4a", "ogg", "aac", "flac"] }],
      });
      if (selected && typeof selected === "string") {
        setAmbient(selected);
        setMsg({
          text: `Background music set: ${selected.split(/[\\/]/).pop()}`,
          kind: "ok",
        });
      }
    } catch (e) {
      setMsg({ text: `Failed to pick music: ${String(e)}`, kind: "error" });
    }
  };

  // Video render and export
  const render = async () => {
    setBusy(true);
    setMsg(null);
    setProg(null);
    try {
      const vVol = isVoiceMuted ? 0 : voiceVolume / 100;
      const bgVol = isBgmMuted ? 0 : bgmVolume / 100;
      const out = await api.render(
        id,
        ambient,
        subtitlesEnabled,
        vVol,
        bgVol,
        wordTrackerEnabled,
        highlightColor,
      );
      if (out) setExportedPath(out);
      setMsg({
        text: out
          ? `Render complete! All scenes combined into 1 video & exported to: ${out}`
          : "Render complete! All scenes combined into 1 video.",
        kind: "ok",
      });
      const updated = await api.get(id);
      setD(updated);
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  // YouTube thumbnail prompt generator
  const youtubeThumbnailPrompt = useMemo(() => {
    const title = d?.project.name || "Explainer Video";
    const prompt = d?.project.prompt ? `\n\nVIDEO TOPIC (context only, never write it in the image): ${title}` : `\n\nVIDEO TOPIC (context only, never write it in the image): ${title}`;
    return `Create ONE YouTube thumbnail image, 16:9 landscape (1280x720 px), for a narrated explainer video.${prompt}

STYLE: Cinematic, high-contrast, bold composition, professional YouTube thumbnail photography. No text overlays.`;
  }, [d]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(youtubeThumbnailPrompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch (_) {}
  };

  // Keyboard listener for play/pause, fullscreen, and scene navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const inInput = tag === "input" || tag === "textarea";
      if (!inInput) {
        if (e.key === " " || e.code === "Space") {
          e.preventDefault();
          togglePlay();
        } else if (e.key === "f" || e.key === "F") {
          e.preventDefault();
          toggleFullWindow();
        } else if (e.key === "Escape" && isFullWindow) {
          e.preventDefault();
          toggleFullWindow();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          handlePrevScene();
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          handleNextScene();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isPlaying, activeSceneIdx, d, isFullWindow]);

  if (!d) {
    return (
      <div className="empty" style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <Icon name="doc" size={28} />
        <h3 style={{ marginTop: 12 }}>{msg?.text ?? "Loading editor…"}</h3>
      </div>
    );
  }

  // Playhead percentage for timeline
  const playheadPercent = totalDurationMs > 0 ? (totalCurrentMs / totalDurationMs) * 100 : 0;

  // Handle click on timeline track to seek
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || totalDurationMs <= 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    const targetMs = ratio * totalDurationMs;

    const foundIdx = ranges.findIndex((r) => targetMs >= r.start && targetMs < r.end);
    if (foundIdx !== -1) {
      const offsetSec = (targetMs - ranges[foundIdx].start) / 1000;
      setCurrentTimeSec(offsetSec);
      playScene(foundIdx, offsetSec);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: "#0b0c10", color: "#f8fafc", fontFamily: "'Kantumruy Pro', sans-serif" }}>
      {/* 1. TOP HEADER BAR */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 24px",
          borderBottom: "1px solid #1e2230",
          background: "#0f1118",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        {/* Left: Back Arrow + Project Title + Review Status */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            className="icon-btn"
            onClick={onBack}
            style={{ color: "#94a3b8", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center" }}
            title="Back to Scenes"
          >
            <Icon name="arrow-left" size={18} />
          </button>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#ffffff", letterSpacing: "0.01em" }}>
            {d.project.name}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: 999,
              background: "rgba(245, 158, 11, 0.15)",
              color: "#f59e0b",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
            Review
          </span>
        </div>

        {/* Right: Step Indicator Pills + Primary Export Button */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* Stage Steps Indicator */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#94a3b8" }}>
            <button
              type="button"
              onClick={onBack}
              style={{ background: "transparent", border: "none", color: "#22c55e", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontWeight: 500 }}
            >
              <Icon name="check" size={13} /> Script
            </button>
            <span style={{ opacity: 0.4 }}>—</span>
            <button
              type="button"
              onClick={onBack}
              style={{ background: "transparent", border: "none", color: "#22c55e", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontWeight: 500 }}
            >
              <Icon name="check" size={13} /> Voices &amp; pictures
            </button>
            <span style={{ opacity: 0.4 }}>—</span>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 12px",
                borderRadius: 999,
                border: "1px solid #e05e46",
                background: "rgba(224, 94, 70, 0.12)",
                color: "#e05e46",
                fontWeight: 600,
              }}
            >
              <Icon name="video" size={13} />
              <span>Edit &amp; export</span>
            </div>
          </div>

          {/* Export Button */}
          <button
            type="button"
            disabled={busy}
            onClick={render}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "#e05e46",
              color: "#ffffff",
              border: "none",
              borderRadius: 8,
              padding: "7px 18px",
              fontSize: 13.5,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
              boxShadow: "0 2px 8px rgba(224, 94, 70, 0.35)",
            }}
          >
            <Icon name="film" size={14} />
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </header>

      {/* Progress notification banner if rendering */}
      {busy && prog && (
        <div style={{ background: "#1a1c26", padding: "10px 24px", borderBottom: "1px solid #282c40", display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#e05e46" }}>Combining &amp; Rendering Video:</span>
          <span style={{ fontSize: 12, color: "#cbd5e1" }}>Stage: {prog.stage} ({prog.done}/{prog.total})</span>
          <div style={{ flex: 1, height: 6, background: "#282c40", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, (prog.done / Math.max(prog.total, 1)) * 100)}%`, background: "#e05e46" }} />
          </div>
        </div>
      )}

      {msg && (
        <div
          style={{
            margin: "12px 24px 0 24px",
            padding: "10px 16px",
            borderRadius: 8,
            background: msg.kind === "ok" ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
            color: msg.kind === "ok" ? "#4ade80" : "#f87171",
            border: `1px solid ${msg.kind === "ok" ? "#22c55e" : "#ef4444"}`,
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>{msg.text}</span>
          {exportedPath && (
            <button
              type="button"
              className="btn sm"
              style={{ padding: "4px 10px", fontSize: 12, background: "#22c55e", color: "#000", border: "none" }}
              onClick={() => api.openOutputDir(exportedPath)}
            >
              Open in Explorer
            </button>
          )}
        </div>
      )}

      {/* 2. MAIN UPPER WORKSPACE: Video Player (Left) + Inspector Sidebar (Right) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          gap: 20,
          padding: "16px 24px 8px 24px",
          flex: 1,
        }}
      >
        {/* LEFT: 16:9 Cinema Player & Transport Controls */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* 16:9 Screen */}
          <div
            onDoubleClick={toggleFullWindow}
            style={{
              width: "100%",
              aspectRatio: "16 / 9",
              background: "#000000",
              borderRadius: 14,
              overflow: "hidden",
              position: "relative",
              border: "1px solid #1e2230",
              boxShadow: "0 8px 30px rgba(0, 0, 0, 0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
            title="Double-click to watch full window"
          >
            {/* Quick Full Window Cinema Button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleFullWindow();
              }}
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                zIndex: 15,
                background: "rgba(15, 17, 24, 0.8)",
                backdropFilter: "blur(6px)",
                border: "1px solid rgba(255, 255, 255, 0.2)",
                color: "#ffffff",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                transition: "all 0.15s ease",
              }}
              title="Watch Fit to Screen / Full Window (F or Double Click)"
            >
              <Icon name="maximize" size={14} />
              <span>Full Window</span>
            </button>
            {currentScene?.image_path ? (
              <img
                src={fileUrl(d.dir, currentScene.image_path)}
                alt={`Scene ${activeSceneIdx + 1}`}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "#64748b" }}>
                <Icon name="image" size={38} />
                <span style={{ fontSize: 13 }}>No image generated yet for Scene {activeSceneIdx + 1}</span>
              </div>
            )}

            {/* Clean Subtitles Overlay on Video Player (No black blur background) */}
            {subtitlesEnabled && currentScene?.narration && (
              <div
                style={{
                  position: "absolute",
                  left: "5%",
                  right: "5%",
                  bottom: "7%",
                  display: "flex",
                  justifyContent: "center",
                  pointerEvents: "none",
                  zIndex: 10,
                }}
              >
                <div
                  style={{
                    maxWidth: "95%",
                    textAlign: "center",
                    lineHeight: 1.55,
                    fontSize: 22,
                    fontWeight: 700,
                    fontFamily: "'Khmer OS Battambang', 'Battambang', 'Kantumruy Pro', sans-serif",
                    background: "transparent",
                    filter: "drop-shadow(0 2px 5px rgba(0,0,0,0.9))",
                  }}
                >
                  {wordTrackerEnabled ? (
                    words.map((word, wIdx) => {
                      const isHighlighted = isPlaying && wIdx === activeWordIndex;
                      return (
                        <span
                          key={wIdx}
                          style={{
                            color: isHighlighted ? highlightColor : "#ffffff",
                            fontWeight: isHighlighted ? 800 : 700,
                            marginRight: 6,
                            transition: "color 0.1s ease",
                            textShadow: isHighlighted
                              ? `0 0 16px ${highlightColor}, -1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000`
                              : "-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 2px 6px rgba(0,0,0,0.95)",
                          }}
                        >
                          {word}
                        </span>
                      );
                    })
                  ) : (
                    <span
                      style={{
                        color: "#ffffff",
                        textShadow:
                          "-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 2px 6px rgba(0,0,0,0.95)",
                      }}
                    >
                      {currentScene.narration}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Player Transport Controls Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 8px",
              color: "#94a3b8",
              fontSize: 13,
            }}
          >
            {/* Timestamp: Current / Total */}
            <div style={{ fontFamily: "monospace", fontSize: 13, color: "#cbd5e1" }}>
              {formatMmSs(totalCurrentMs / 1000)} / {formatMmSs(totalDurationMs / 1000)}
            </div>

            {/* Playback Buttons: Prev, Play/Pause, Next */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <button
                type="button"
                onClick={handlePrevScene}
                disabled={activeSceneIdx === 0}
                style={{
                  background: "transparent",
                  border: "none",
                  color: activeSceneIdx === 0 ? "#475569" : "#ffffff",
                  cursor: activeSceneIdx === 0 ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  fontSize: 15,
                  padding: 6,
                }}
                title="Previous Scene"
              >
                |◀
              </button>

              <button
                type="button"
                onClick={togglePlay}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "#ffffff",
                  color: "#000000",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 4px 14px rgba(0, 0, 0, 0.4)",
                  transition: "transform 0.1s ease",
                }}
                title={isPlaying ? "Pause (Space)" : "Play (Space)"}
              >
                <Icon name={isPlaying ? "pause" : "play"} size={18} />
              </button>

              <button
                type="button"
                onClick={handleNextScene}
                disabled={activeSceneIdx >= (d.scenes.length - 1)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: activeSceneIdx >= (d.scenes.length - 1) ? "#475569" : "#ffffff",
                  cursor: activeSceneIdx >= (d.scenes.length - 1) ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  fontSize: 15,
                  padding: 6,
                }}
                title="Next Scene"
              >
                ▶|
              </button>
            </div>

            {/* Quality badge & Subtitle Quick Toggle */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                type="button"
                onClick={() => setSubtitlesEnabled((prev) => !prev)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 9px",
                  borderRadius: 6,
                  border: subtitlesEnabled ? "1px solid #22c55e" : "1px solid #475569",
                  background: subtitlesEnabled ? "rgba(34, 197, 94, 0.15)" : "rgba(100, 116, 139, 0.15)",
                  color: subtitlesEnabled ? "#4ade80" : "#94a3b8",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                title={subtitlesEnabled ? "Subtitles: ON (Click to turn OFF)" : "Subtitles: OFF (Click to turn ON)"}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: subtitlesEnabled ? "#22c55e" : "#64748b",
                    display: "inline-block",
                  }}
                />
                CC {subtitlesEnabled ? "ON" : "OFF"}
              </button>

              <div style={{ fontSize: 12.5, color: "#64748b", fontWeight: 500 }}>
                {videoRes === "shorts" ? "1080×1920" : videoRes === "720p" ? "720p" : videoRes === "4k" ? "4K UHD" : "1080p"} · 30 fps
              </div>

              <button
                type="button"
                onClick={toggleFullWindow}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid #334155",
                  background: "rgba(30, 41, 59, 0.5)",
                  color: "#cbd5e1",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                title="Watch Fit to Screen / Full Window (F)"
              >
                <Icon name="maximize" size={14} />
                <span>Fullscreen</span>
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT: Inspector Sidebar */}
        <div
          style={{
            background: "#12141d",
            border: "1px solid #1e2230",
            borderRadius: 12,
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          {/* Subtitles Settings Card */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#ffffff" }}>Subtitles</h3>
              <button
                type="button"
                onClick={() => setSubtitlesEnabled((prev) => !prev)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: subtitlesEnabled ? "1px solid #22c55e" : "1px solid #475569",
                  background: subtitlesEnabled ? "rgba(34, 197, 94, 0.15)" : "rgba(100, 116, 139, 0.15)",
                  color: subtitlesEnabled ? "#4ade80" : "#94a3b8",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                title={subtitlesEnabled ? "Subtitles are ON. Click to turn OFF." : "Subtitles are OFF. Click to turn ON."}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: subtitlesEnabled ? "#22c55e" : "#64748b",
                    display: "inline-block",
                  }}
                />
                {subtitlesEnabled ? "ON" : "OFF"}
              </button>
            </div>

            {/* Subtitle Master ON/OFF Switch Card */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "#181b26",
                padding: "9px 12px",
                borderRadius: 8,
                border: "1px solid #282c40",
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: subtitlesEnabled ? "#ffffff" : "#94a3b8" }}>
                  Burn-in Subtitles
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                  {subtitlesEnabled ? "Overlay text will be burned into the exported video" : "Clean video without any subtitle overlay"}
                </div>
              </div>
              <label style={{ position: "relative", display: "inline-block", width: 38, height: 20, cursor: "pointer", flexShrink: 0, marginLeft: 8 }}>
                <input
                  type="checkbox"
                  checked={subtitlesEnabled}
                  onChange={(e) => setSubtitlesEnabled(e.target.checked)}
                  style={{ opacity: 0, width: 0, height: 0 }}
                />
                <span
                  style={{
                    position: "absolute",
                    cursor: "pointer",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: subtitlesEnabled ? "#22c55e" : "#334155",
                    transition: "0.2s",
                    borderRadius: 20,
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      content: "''",
                      height: 14,
                      width: 14,
                      left: subtitlesEnabled ? 21 : 3,
                      bottom: 3,
                      backgroundColor: "#ffffff",
                      transition: "0.2s",
                      borderRadius: "50%",
                    }}
                  />
                </span>
              </label>
            </div>

            {/* Subtitle Appearance Settings (Dimmed if Subtitles are OFF) */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                opacity: subtitlesEnabled ? 1 : 0.45,
                pointerEvents: subtitlesEnabled ? "auto" : "none",
                transition: "opacity 0.2s ease",
              }}
            >
              {/* Font Picker */}
              <div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>Font style</div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#ffffff",
                    padding: "7px 10px",
                    background: "#181b26",
                    borderRadius: 6,
                    border: "1px solid #282c40",
                    fontFamily: "'Khmer OS Battambang', 'Battambang', sans-serif",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span>{fontChoice}</span>
                  <span style={{ fontSize: 10.5, color: "#22c55e", background: "rgba(34,197,94,0.15)", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>
                    Active
                  </span>
                </div>
              </div>

              {/* Word Tracker Toggle */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff" }}>Word tracker</div>
                  <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 2, lineHeight: 1.4 }}>
                    Highlights each word while it is spoken.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={wordTrackerEnabled}
                  onChange={(e) => setWordTrackerEnabled(e.target.checked)}
                  style={{
                    width: 17,
                    height: 17,
                    accentColor: "#e05e46",
                    cursor: "pointer",
                    marginTop: 2,
                  }}
                />
              </div>

              {/* Highlight Colour Swatches */}
              <div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>Highlight colour</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setHighlightColor(c.hex)}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        backgroundColor: c.hex,
                        border: highlightColor === c.hex ? "2px solid #ffffff" : "2px solid transparent",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                        boxShadow: highlightColor === c.hex ? `0 0 10px ${c.hex}` : "none",
                      }}
                      title={`Highlight colour: ${c.id}`}
                    >
                      {highlightColor === c.hex && (
                        <span style={{ color: "#000000", display: "flex", alignItems: "center" }}>
                          <Icon name="check" size={11} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: "#1e2230" }} />

          {/* Active Scene Narration Card */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#ffffff" }}>
                Scene {activeSceneIdx + 1} · {currentSceneDurSec.toFixed(1)} s
              </div>
              <button
                type="button"
                onClick={() => handleImportSceneAudio(activeSceneIdx)}
                disabled={busy}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 9px",
                  background: "rgba(99, 102, 241, 0.15)",
                  border: "1px solid #6366f1",
                  color: "#818cf8",
                  borderRadius: 6,
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
                title="Replace AI voice for this scene with your own audio file"
              >
                <Icon name="folder" size={12} />
                Import Voice
              </button>
            </div>
            <div
              style={{
                background: "#181b26",
                border: "1px solid #282c40",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 12.5,
                color: "#cbd5e1",
                lineHeight: 1.55,
                maxHeight: 110,
                overflowY: "auto",
              }}
            >
              {currentScene?.narration || "No narration text for this scene."}
            </div>
          </div>

          <div style={{ height: 1, background: "#1e2230" }} />

          {/* YouTube Thumbnail Prompt Card */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#ffffff" }}>YouTube thumbnail prompt</div>
              <button
                type="button"
                onClick={copyPrompt}
                style={{
                  background: copiedPrompt ? "#22c55e" : "#282c40",
                  color: copiedPrompt ? "#000" : "#cbd5e1",
                  border: "none",
                  borderRadius: 4,
                  padding: "2px 8px",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {copiedPrompt ? "Copied!" : "Copy"}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: "#94a3b8", lineHeight: 1.4 }}>
              Paste this into ChatGPT or Gemini to make a thumbnail that matches your video. It asks for no text.
            </div>
            <textarea
              readOnly
              rows={4}
              value={youtubeThumbnailPrompt}
              style={{
                width: "100%",
                background: "#181b26",
                border: "1px solid #282c40",
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 11.5,
                color: "#94a3b8",
                lineHeight: 1.45,
                resize: "none",
                fontFamily: "monospace",
                boxSizing: "border-box",
              }}
            />
          </div>
        </div>
      </div>

      {/* 3. BOTTOM MULTI-TRACK TIMELINE */}
      <div
        style={{
          background: "#0d0f15",
          borderTop: "1px solid #1e2230",
          padding: "10px 24px 16px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* Timeline Header Row: Label + Audio Import Actions + Zoom Controls */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.02em" }}>Timeline</span>

            {/* Import user audio file for selected scene */}
            <button
              type="button"
              onClick={() => handleImportSceneAudio(activeSceneIdx)}
              disabled={busy}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: "#181b26",
                border: "1px solid #3b82f6",
                color: "#60a5fa",
                padding: "3px 10px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: busy ? "not-allowed" : "pointer",
              }}
              title="Import your own voice/audio recording from file to replace voice for the active scene"
            >
              <Icon name="folder" size={13} />
              Import Voice (Scene {activeSceneIdx + 1})
            </button>

            {/* Import background music audio file */}
            <button
              type="button"
              onClick={handlePickAmbient}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: ambient ? "rgba(168, 85, 247, 0.15)" : "#181b26",
                border: ambient ? "1px solid #a855f7" : "1px solid #282c40",
                color: ambient ? "#c084fc" : "#94a3b8",
                padding: "3px 10px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
              title={ambient ? `Background Music: ${ambient}` : "Import background music audio file"}
            >
              <span>♫</span>
              {ambient ? `BGM: ${ambient.split(/[\\/]/).pop()?.slice(0, 14)}…` : "+ Add Music (BGM)"}
            </button>
            {ambient && (
              <button
                type="button"
                onClick={() => setAmbient(null)}
                style={{ background: "transparent", border: "none", color: "#f87171", cursor: "pointer", fontSize: 12, padding: "0 2px" }}
                title="Remove background music"
              >
                ✕
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setZoomLevel((z) => Math.max(0.7, z - 0.2))}
              style={{ background: "#181b26", border: "1px solid #282c40", color: "#cbd5e1", padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
              title="Zoom Out"
            >
              -
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setZoomLevel((z) => Math.min(2.0, z + 0.2))}
              style={{ background: "#181b26", border: "1px solid #282c40", color: "#cbd5e1", padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
              title="Zoom In"
            >
              +
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setZoomLevel(1)}
              style={{ background: "#181b26", border: "1px solid #282c40", color: "#cbd5e1", padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
              title="Fit to Window"
            >
              ⛶
            </button>
          </div>
        </div>

        {/* Timeline Track Area */}
        <div style={{ display: "flex", gap: 8, width: "100%" }}>
          {/* Left Track Icons & Volume Controls */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              paddingTop: 26,
              width: 32,
              flexShrink: 0,
              color: "#64748b",
              position: "relative",
            }}
          >
            {/* Track 1: Visuals */}
            <div style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "center" }} title="Visuals Track">
              <Icon name="image" size={15} />
            </div>

            {/* Track 2: Subtitles */}
            <div
              style={{
                height: 26,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: subtitlesEnabled ? 1 : 0.45,
                cursor: "pointer",
              }}
              onClick={() => setSubtitlesEnabled((prev) => !prev)}
              title={subtitlesEnabled ? "Subtitles Track (ON) - Click to toggle off" : "Subtitles Track (OFF) - Click to toggle on"}
            >
              <Icon name="doc" size={14} />
            </div>

            {/* Track 3: Voice Audio Volume Button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setActiveVolumePopover((curr) => (curr === "voice" ? null : "voice"));
              }}
              style={{
                height: 22,
                width: 30,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background:
                  activeVolumePopover === "voice"
                    ? "rgba(59, 130, 246, 0.25)"
                    : isVoiceMuted
                    ? "rgba(239, 68, 68, 0.2)"
                    : "transparent",
                border: activeVolumePopover === "voice" ? "1px solid #3b82f6" : "1px solid transparent",
                borderRadius: 4,
                color: isVoiceMuted ? "#ef4444" : activeVolumePopover === "voice" ? "#60a5fa" : "#94a3b8",
                cursor: "pointer",
                padding: 0,
                transition: "all 0.15s ease",
              }}
              title={`Voice Audio Volume: ${isVoiceMuted ? "Muted" : `${voiceVolume}%`} (Click to adjust volume slider)`}
            >
              <Icon name="volume" size={14} />
            </button>

            {/* Track 4: Background Music (BGM) Volume Button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!ambient) {
                  handlePickAmbient();
                } else {
                  setActiveVolumePopover((curr) => (curr === "bgm" ? null : "bgm"));
                }
              }}
              style={{
                height: 24,
                width: 30,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background:
                  activeVolumePopover === "bgm"
                    ? "rgba(168, 85, 247, 0.25)"
                    : isBgmMuted
                    ? "rgba(239, 68, 68, 0.2)"
                    : "transparent",
                border: activeVolumePopover === "bgm" ? "1px solid #a855f7" : "1px solid transparent",
                borderRadius: 4,
                color: isBgmMuted ? "#ef4444" : ambient ? "#c084fc" : "#64748b",
                cursor: "pointer",
                padding: 0,
                fontWeight: 700,
                fontSize: 13,
                transition: "all 0.15s ease",
              }}
              title={
                ambient
                  ? `Background Music Volume: ${isBgmMuted ? "Muted" : `${bgmVolume}%`} (Click to adjust volume slider)`
                  : "Add Background Music (BGM)"
              }
            >
              ♫
            </button>

            {/* VOICE AUDIO VOLUME SLIDER POPOVER */}
            {activeVolumePopover === "voice" && (
              <div
                ref={volumePopoverRef}
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  left: 36,
                  top: 92,
                  zIndex: 90,
                  background: "#161922",
                  border: "1px solid #3b82f6",
                  borderRadius: 8,
                  boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(59, 130, 246, 0.3)",
                  padding: "10px 14px",
                  width: 260,
                  color: "#f1f5f9",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {/* Popover Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#60a5fa" }}>
                    <Icon name="volume" size={14} />
                    <span>Voice Audio Volume</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        fontFamily: "monospace",
                        color: isVoiceMuted ? "#ef4444" : "#60a5fa",
                        background: isVoiceMuted ? "rgba(239, 68, 68, 0.15)" : "rgba(59, 130, 246, 0.15)",
                        padding: "1px 6px",
                        borderRadius: 4,
                      }}
                    >
                      {isVoiceMuted ? "MUTED" : `${voiceVolume}%`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveVolumePopover(null)}
                      style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 13, padding: 0 }}
                      title="Close"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Horizontal Left-to-Right Slider */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>0%</span>
                  <input
                    type="range"
                    min={0}
                    max={150}
                    step={1}
                    value={isVoiceMuted ? 0 : voiceVolume}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setVoiceVolume(val);
                      if (isVoiceMuted && val > 0) setIsVoiceMuted(false);
                    }}
                    style={{
                      flex: 1,
                      accentColor: "#3b82f6",
                      cursor: "pointer",
                      height: 6,
                    }}
                  />
                  <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>150%</span>
                </div>

                {/* Quick Presets / Mute Toggle */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 2 }}>
                  <button
                    type="button"
                    onClick={() => setIsVoiceMuted(!isVoiceMuted)}
                    style={{
                      background: isVoiceMuted ? "#ef4444" : "#1e2433",
                      border: isVoiceMuted ? "1px solid #ef4444" : "1px solid #333d54",
                      color: isVoiceMuted ? "#ffffff" : "#cbd5e1",
                      fontSize: 11,
                      padding: "3px 9px",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    {isVoiceMuted ? "Unmute" : "Mute"}
                  </button>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[50, 80, 100, 125].map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => {
                          setVoiceVolume(lvl);
                          setIsVoiceMuted(false);
                        }}
                        style={{
                          background: voiceVolume === lvl && !isVoiceMuted ? "#2563eb" : "#181b26",
                          border: voiceVolume === lvl && !isVoiceMuted ? "1px solid #3b82f6" : "1px solid #282c40",
                          color: voiceVolume === lvl && !isVoiceMuted ? "#ffffff" : "#94a3b8",
                          fontSize: 10,
                          padding: "2px 6px",
                          borderRadius: 3,
                          cursor: "pointer",
                        }}
                      >
                        {lvl}%
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* BACKGROUND MUSIC (BGM) VOLUME SLIDER POPOVER */}
            {activeVolumePopover === "bgm" && (
              <div
                ref={volumePopoverRef}
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  left: 36,
                  top: 122,
                  zIndex: 90,
                  background: "#161922",
                  border: "1px solid #a855f7",
                  borderRadius: 8,
                  boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(168, 85, 247, 0.3)",
                  padding: "10px 14px",
                  width: 260,
                  color: "#f1f5f9",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {/* Popover Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#c084fc" }}>
                    <span>♫</span>
                    <span>Music (BGM) Volume</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        fontFamily: "monospace",
                        color: isBgmMuted ? "#ef4444" : "#c084fc",
                        background: isBgmMuted ? "rgba(239, 68, 68, 0.15)" : "rgba(168, 85, 247, 0.15)",
                        padding: "1px 6px",
                        borderRadius: 4,
                      }}
                    >
                      {isBgmMuted ? "MUTED" : `${bgmVolume}%`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveVolumePopover(null)}
                      style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 13, padding: 0 }}
                      title="Close"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Current BGM file info or pick music */}
                {ambient ? (
                  <div style={{ fontSize: 10.5, color: "#94a3b8", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#11131a", padding: "4px 8px", borderRadius: 4, border: "1px solid #231d30" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }} title={ambient}>
                      {ambient.split(/[\\/]/).pop()}
                    </span>
                    <button
                      type="button"
                      onClick={handlePickAmbient}
                      style={{ background: "transparent", border: "none", color: "#c084fc", fontSize: 10.5, cursor: "pointer", textDecoration: "underline", padding: 0 }}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handlePickAmbient}
                    style={{
                      background: "rgba(168, 85, 247, 0.15)",
                      border: "1px dashed #a855f7",
                      color: "#c084fc",
                      borderRadius: 4,
                      padding: "6px 8px",
                      fontSize: 11,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                    }}
                  >
                    <span>+ Select BGM Music File</span>
                  </button>
                )}

                {/* Horizontal Left-to-Right Slider */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>0%</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={isBgmMuted ? 0 : bgmVolume}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setBgmVolume(val);
                      if (isBgmMuted && val > 0) setIsBgmMuted(false);
                    }}
                    style={{
                      flex: 1,
                      accentColor: "#a855f7",
                      cursor: "pointer",
                      height: 6,
                    }}
                  />
                  <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>100%</span>
                </div>

                {/* Quick Presets / Mute Toggle */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 2 }}>
                  <button
                    type="button"
                    onClick={() => setIsBgmMuted(!isBgmMuted)}
                    style={{
                      background: isBgmMuted ? "#ef4444" : "#1e2433",
                      border: isBgmMuted ? "1px solid #ef4444" : "1px solid #333d54",
                      color: isBgmMuted ? "#ffffff" : "#cbd5e1",
                      fontSize: 11,
                      padding: "3px 9px",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    {isBgmMuted ? "Unmute" : "Mute"}
                  </button>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[10, 20, 35, 50].map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => {
                          setBgmVolume(lvl);
                          setIsBgmMuted(false);
                        }}
                        style={{
                          background: bgmVolume === lvl && !isBgmMuted ? "#7e22ce" : "#181b26",
                          border: bgmVolume === lvl && !isBgmMuted ? "1px solid #a855f7" : "1px solid #282c40",
                          color: bgmVolume === lvl && !isBgmMuted ? "#ffffff" : "#94a3b8",
                          fontSize: 10,
                          padding: "2px 6px",
                          borderRadius: 3,
                          cursor: "pointer",
                        }}
                      >
                        {lvl}%
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Main Horizontal Timeline Tracks & Ruler */}
          <div
            ref={timelineRef}
            onClick={handleTimelineClick}
            style={{
              flex: 1,
              position: "relative",
              overflowX: "auto",
              cursor: "pointer",
              background: "#12141e",
              borderRadius: 8,
              border: "1px solid #1e2230",
              padding: "4px 8px 10px 8px",
            }}
          >
            {/* Time Ruler (every 5 seconds) */}
            <div style={{ display: "flex", alignItems: "center", height: 20, marginBottom: 6, borderBottom: "1px solid #1e2230", color: "#64748b", fontSize: 10.5, fontFamily: "monospace" }}>
              {Array.from({ length: Math.ceil((totalDurationMs / 1000) / 5) + 1 }).map((_, i) => (
                <div key={i} style={{ width: `${Math.round(65 * zoomLevel)}px`, flexShrink: 0 }}>
                  {formatMmSs(i * 5)}
                </div>
              ))}
            </div>

            {/* Red Playhead Vertical Needle */}
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${playheadPercent}%`,
                width: 2,
                background: "#ef4444",
                pointerEvents: "none",
                zIndex: 20,
                transition: isPlaying ? "none" : "left 0.1s ease",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: -2,
                  left: -16,
                  background: "#ef4444",
                  color: "#ffffff",
                  fontSize: 9.5,
                  fontWeight: 700,
                  padding: "1px 4px",
                  borderRadius: 3,
                  fontFamily: "monospace",
                }}
              >
                {formatMmSs(totalCurrentMs / 1000)}
              </div>
            </div>

            {/* TRACK 1: Visuals (Scene Thumbnails) */}
            <div style={{ display: "flex", gap: 6, height: 56, marginBottom: 6 }}>
              {d.scenes.map((s, idx) => {
                const isActive = idx === activeSceneIdx;
                const durMs = s.audio_ms || 3000;
                const cardWidth = Math.max(90, Math.round((durMs / 1000) * 16 * zoomLevel));
                return (
                  <div
                    key={s.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentTimeSec(0);
                      playScene(idx, 0);
                    }}
                    style={{
                      width: cardWidth,
                      height: 56,
                      borderRadius: 6,
                      overflow: "hidden",
                      position: "relative",
                      background: "#181b26",
                      border: isActive ? "2px solid #e05e46" : "1px solid #282c40",
                      flexShrink: 0,
                      boxShadow: isActive ? "0 0 10px rgba(224, 94, 70, 0.45)" : "none",
                      transition: "border 0.15s ease",
                    }}
                  >
                    {s.image_path ? (
                      <img
                        src={fileUrl(d.dir, s.image_path)}
                        alt={`Scene ${idx + 1}`}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#475569" }}>
                        <Icon name="image" size={14} />
                      </div>
                    )}
                    {/* Scene Number Badge in top left */}
                    <div
                      style={{
                        position: "absolute",
                        top: 3,
                        left: 4,
                        background: "rgba(0,0,0,0.75)",
                        color: "#ffffff",
                        fontSize: 10,
                        fontWeight: 700,
                        borderRadius: 3,
                        padding: "1px 4px",
                        lineHeight: 1,
                      }}
                    >
                      {idx + 1}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* TRACK 2: Subtitle text snippets */}
            <div style={{ display: "flex", gap: 6, height: 26, marginBottom: 6 }}>
              {d.scenes.map((s, idx) => {
                const durMs = s.audio_ms || 3000;
                const cardWidth = Math.max(90, Math.round((durMs / 1000) * 16 * zoomLevel));
                const isActive = idx === activeSceneIdx;
                return (
                  <div
                    key={s.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentTimeSec(0);
                      playScene(idx, 0);
                    }}
                    style={{
                      width: cardWidth,
                      height: 26,
                      borderRadius: 4,
                      background: !subtitlesEnabled ? "#14161f" : isActive ? "#262b3d" : "#1a1d29",
                      border: !subtitlesEnabled ? "1px dashed #262938" : isActive ? "1px solid #3b82f6" : "1px solid #282c40",
                      opacity: !subtitlesEnabled ? 0.45 : 1,
                      flexShrink: 0,
                      padding: "4px 6px",
                      boxSizing: "border-box",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                      fontSize: 11,
                      color: !subtitlesEnabled ? "#64748b" : isActive ? "#93c5fd" : "#cbd5e1",
                      lineHeight: "16px",
                    }}
                    title={subtitlesEnabled ? s.narration : `(Subtitles OFF) ${s.narration}`}
                  >
                    {!subtitlesEnabled ? `[OFF] ${s.narration}` : (s.narration || `Scene ${idx + 1}`)}
                  </div>
                );
              })}
            </div>

            {/* TRACK 3: Audio segments */}
            <div style={{ display: "flex", gap: 6, height: 22 }}>
              {d.scenes.map((s, idx) => {
                const durMs = s.audio_ms || 3000;
                const cardWidth = Math.max(90, Math.round((durMs / 1000) * 16 * zoomLevel));
                const isActive = idx === activeSceneIdx;
                return (
                  <div
                    key={s.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentTimeSec(0);
                      playScene(idx, 0);
                    }}
                    style={{
                      width: cardWidth,
                      height: 22,
                      borderRadius: 4,
                      background: isActive ? "#1e5235" : "#143723",
                      border: isActive ? "1px solid #4ade80" : "1px solid #22c55e",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0 6px",
                      boxSizing: "border-box",
                      fontSize: 10,
                      color: "#86efac",
                      fontFamily: "monospace",
                      cursor: "pointer",
                    }}
                    title={`Scene ${idx + 1} voice (${((s.audio_ms || 0) / 1000).toFixed(1)}s). Click folder icon to import your own audio.`}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span>♫</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleImportSceneAudio(idx);
                        }}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#86efac",
                          cursor: "pointer",
                          padding: 0,
                          fontSize: 10,
                          lineHeight: 1,
                        }}
                        title={`Import custom audio file for Scene ${idx + 1}`}
                      >
                      
                      </button>
                    </span>
                    <span>{((s.audio_ms || 0) / 1000).toFixed(1)}s</span>
                  </div>
                );
              })}
            </div>

            {/* TRACK 4: Background Music / Ambient Audio Track (if selected) */}
            {ambient && (
              <div
                style={{
                  marginTop: 6,
                  height: 24,
                  borderRadius: 4,
                  background: "linear-gradient(90deg, rgba(88, 28, 135, 0.4), rgba(126, 34, 206, 0.4))",
                  border: "1px solid #a855f7",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 10px",
                  fontSize: 11,
                  color: "#e9d5ff",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span>♫ BGM:</span>
                  <span style={{ fontWeight: 600 }}>{ambient.split(/[\\/]/).pop()}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {/* Inline Volume Slider for Track 4 */}
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ fontSize: 10, color: "#d8b4fe" }}>Vol:</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={isBgmMuted ? 0 : bgmVolume}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setBgmVolume(val);
                        if (isBgmMuted && val > 0) setIsBgmMuted(false);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 64, height: 4, accentColor: "#a855f7", cursor: "pointer" }}
                      title={`BGM Volume: ${isBgmMuted ? "Muted" : `${bgmVolume}%`}`}
                    />
                    <span style={{ fontSize: 9.5, fontFamily: "monospace", color: isBgmMuted ? "#ef4444" : "#c084fc", width: 28 }}>
                      {isBgmMuted ? "0%" : `${bgmVolume}%`}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handlePickAmbient}
                    style={{ background: "transparent", border: "none", color: "#d8b4fe", fontSize: 10.5, cursor: "pointer", textDecoration: "underline" }}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={() => setAmbient(null)}
                    style={{ background: "transparent", border: "none", color: "#f87171", fontSize: 11, cursor: "pointer" }}
                    title="Remove background music"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 4. FULL WINDOW / FULLSCREEN CINEMA THEATER OVERLAY */}
      {isFullWindow && (
        <div
          onMouseMove={handleMouseMoveCinema}
          style={{
            position: "fixed",
            inset: 0,
            width: "100vw",
            height: "100vh",
            zIndex: 99999,
            background: "#000000",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            cursor: showCinemaControls ? "default" : "none",
            userSelect: "none",
            fontFamily: "'Kantumruy Pro', sans-serif",
          }}
        >
          {/* TOP CINEMA HEADER BAR (Auto-hides) */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              zIndex: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 32px",
              background: "linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 65%, transparent 100%)",
              opacity: showCinemaControls ? 1 : 0,
              pointerEvents: showCinemaControls ? "auto" : "none",
              transition: "opacity 0.25s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: "#ffffff", letterSpacing: "0.01em" }}>
                {d.project.name}
              </span>
              <span style={{ fontSize: 13, color: "#94a3b8", background: "rgba(255,255,255,0.08)", padding: "2px 8px", borderRadius: 4 }}>
                Scene {activeSceneIdx + 1} of {d.scenes.length} · {((currentScene?.audio_ms || 0) / 1000).toFixed(1)}s
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                type="button"
                onClick={() => setSubtitlesEnabled((prev) => !prev)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: subtitlesEnabled ? "1px solid #22c55e" : "1px solid #475569",
                  background: subtitlesEnabled ? "rgba(34, 197, 94, 0.25)" : "rgba(100, 116, 139, 0.25)",
                  color: subtitlesEnabled ? "#4ade80" : "#94a3b8",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
                title="Toggle Subtitles (CC)"
              >
                CC {subtitlesEnabled ? "ON" : "OFF"}
              </button>

              <button
                type="button"
                onClick={toggleFullWindow}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 14px",
                  borderRadius: 6,
                  background: "#222738",
                  border: "1px solid #3b425b",
                  color: "#ffffff",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "background 0.15s ease",
                }}
                title="Exit Full Window (Esc or F)"
              >
                <Icon name="minimize" size={16} />
                <span>Exit Fullscreen</span>
                <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 2 }}>(Esc)</span>
              </button>
            </div>
          </div>

          {/* CENTER MEDIA: 16:9 Image Fit-to-Screen */}
          <div
            onClick={togglePlay}
            onDoubleClick={toggleFullWindow}
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              cursor: "pointer",
            }}
          >
            {currentScene?.image_path ? (
              <img
                src={fileUrl(d.dir, currentScene.image_path)}
                alt={`Scene ${activeSceneIdx + 1}`}
                style={{
                  maxWidth: "100vw",
                  maxHeight: "100vh",
                  width: "auto",
                  height: "auto",
                  objectFit: "contain",
                  aspectRatio: "16 / 9",
                  display: "block",
                }}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, color: "#64748b" }}>
                <Icon name="image" size={64} />
                <span style={{ fontSize: 16 }}>No image generated for Scene {activeSceneIdx + 1}</span>
              </div>
            )}

            {/* Subtitles Overlay in Fullscreen */}
            {subtitlesEnabled && currentScene?.narration && (
              <div
                style={{
                  position: "absolute",
                  left: "6%",
                  right: "6%",
                  bottom: "10%",
                  display: "flex",
                  justifyContent: "center",
                  pointerEvents: "none",
                  zIndex: 20,
                }}
              >
                <div
                  style={{
                    maxWidth: "92%",
                    textAlign: "center",
                    lineHeight: 1.5,
                    fontSize: "clamp(24px, 3.2vw, 42px)",
                    fontWeight: 700,
                    fontFamily: "'Khmer OS Battambang', 'Battambang', 'Kantumruy Pro', sans-serif",
                    background: "transparent",
                    filter: "drop-shadow(0 3px 8px rgba(0,0,0,0.95))",
                  }}
                >
                  {wordTrackerEnabled ? (
                    words.map((word, wIdx) => {
                      const isHighlighted = isPlaying && wIdx === activeWordIndex;
                      return (
                        <span
                          key={wIdx}
                          style={{
                            color: isHighlighted ? highlightColor : "#ffffff",
                            fontWeight: isHighlighted ? 800 : 700,
                            marginRight: 8,
                            transition: "color 0.1s ease",
                            textShadow: isHighlighted
                              ? `0 0 20px ${highlightColor}, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000`
                              : "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 8px rgba(0,0,0,0.95)",
                          }}
                        >
                          {word}
                        </span>
                      );
                    })
                  ) : (
                    <span
                      style={{
                        color: "#ffffff",
                        textShadow:
                          "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 8px rgba(0,0,0,0.95)",
                      }}
                    >
                      {currentScene.narration}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* BOTTOM CINEMA TRANSPORT BAR (Auto-hides) */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 30,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "16px 32px 22px 32px",
              background: "linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.55) 65%, transparent 100%)",
              opacity: showCinemaControls ? 1 : 0,
              pointerEvents: showCinemaControls ? "auto" : "none",
              transition: "opacity 0.25s ease",
            }}
          >
            {/* Full-width Timeline Progress Scrubber */}
            <div
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const ratio = Math.max(0, Math.min(1, clickX / rect.width));
                const targetMs = ratio * totalDurationMs;
                const foundIdx = ranges.findIndex((r) => targetMs >= r.start && targetMs < r.end);
                if (foundIdx !== -1) {
                  const offsetSec = (targetMs - ranges[foundIdx].start) / 1000;
                  setCurrentTimeSec(offsetSec);
                  playScene(foundIdx, offsetSec);
                }
              }}
              style={{
                width: "100%",
                height: 6,
                background: "rgba(255, 255, 255, 0.25)",
                borderRadius: 3,
                cursor: "pointer",
                position: "relative",
                marginBottom: 6,
              }}
              title="Click to seek anywhere in video"
            >
              <div
                style={{
                  height: "100%",
                  width: `${playheadPercent}%`,
                  background: "#ef4444",
                  borderRadius: 3,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    right: -6,
                    top: -4,
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: "#ef4444",
                    boxShadow: "0 0 8px rgba(0,0,0,0.9)",
                  }}
                />
              </div>
            </div>

            {/* Control Buttons Row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              {/* Left: Playback controls + timestamp */}
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePrevScene();
                  }}
                  disabled={activeSceneIdx === 0}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: activeSceneIdx === 0 ? "#475569" : "#ffffff",
                    cursor: activeSceneIdx === 0 ? "not-allowed" : "pointer",
                    fontSize: 16,
                    padding: 6,
                  }}
                  title="Previous Scene (Left Arrow)"
                >
                  |◀
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay();
                  }}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: "50%",
                    background: "#ffffff",
                    color: "#000000",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.4)",
                  }}
                  title={isPlaying ? "Pause (Space)" : "Play (Space)"}
                >
                  <Icon name={isPlaying ? "pause" : "play"} size={18} />
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNextScene();
                  }}
                  disabled={activeSceneIdx >= d.scenes.length - 1}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: activeSceneIdx >= d.scenes.length - 1 ? "#475569" : "#ffffff",
                    cursor: activeSceneIdx >= d.scenes.length - 1 ? "not-allowed" : "pointer",
                    fontSize: 16,
                    padding: 6,
                  }}
                  title="Next Scene (Right Arrow)"
                >
                  ▶|
                </button>

                <div style={{ fontFamily: "monospace", fontSize: 13.5, color: "#cbd5e1", marginLeft: 4 }}>
                  {formatMmSs(totalCurrentMs / 1000)} / {formatMmSs(totalDurationMs / 1000)}
                </div>
              </div>

              {/* Right: Volume & fullscreen exit */}
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                {/* Quick Voice Volume control */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#94a3b8" }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsVoiceMuted(!isVoiceMuted);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: isVoiceMuted ? "#ef4444" : "#94a3b8",
                      cursor: "pointer",
                      padding: 0,
                    }}
                    title={isVoiceMuted ? "Unmute Voice" : "Mute Voice"}
                  >
                    <Icon name="volume" size={16} />
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={150}
                    value={isVoiceMuted ? 0 : voiceVolume}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setVoiceVolume(val);
                      if (isVoiceMuted && val > 0) setIsVoiceMuted(false);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: 80, height: 4, accentColor: "#3b82f6", cursor: "pointer" }}
                    title={`Voice Volume: ${isVoiceMuted ? "0%" : `${voiceVolume}%`}`}
                  />
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: "#60a5fa", width: 34 }}>
                    {isVoiceMuted ? "0%" : `${voiceVolume}%`}
                  </span>
                </div>

                <div style={{ fontSize: 12.5, color: "#64748b", fontWeight: 500 }}>
                  {videoRes === "shorts" ? "1080×1920" : videoRes === "720p" ? "720p" : videoRes === "4k" ? "4K UHD" : "1080p"} · 30 fps
                </div>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFullWindow();
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#cbd5e1",
                    cursor: "pointer",
                    padding: 4,
                    display: "flex",
                    alignItems: "center",
                  }}
                  title="Exit Fullscreen (Esc or F)"
                >
                  <Icon name="minimize" size={18} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hidden audio element for voice narration playback & synchronization */}
      <audio
        ref={audioRef}
        onTimeUpdate={() => {
          if (audioRef.current) setCurrentTimeSec(audioRef.current.currentTime);
        }}
        onEnded={() => {
          if (!d) return;
          if (activeSceneIdx < d.scenes.length - 1) {
            // Continuously play the next scene!
            const nextIdx = activeSceneIdx + 1;
            setCurrentTimeSec(0);
            playScene(nextIdx, 0);
          } else {
            setIsPlaying(false);
            setCurrentTimeSec(0);
            if (bgmRef.current) {
              bgmRef.current.pause();
              bgmRef.current.currentTime = 0;
            }
          }
        }}
        onPause={() => {
          setIsPlaying(false);
          if (bgmRef.current) bgmRef.current.pause();
        }}
        onPlay={() => {
          setIsPlaying(true);
          if (ambient && bgmRef.current) {
            bgmRef.current.volume = isBgmMuted ? 0 : Math.max(0, Math.min(1, bgmVolume / 100));
            bgmRef.current.play().catch(() => {});
          }
        }}
      />

      {/* Background music / ambient audio element */}
      <audio
        ref={bgmRef}
        src={ambient ? convertFileSrc(ambient) : undefined}
        loop
      />
    </div>
  );
}
