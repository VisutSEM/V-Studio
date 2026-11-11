import { useState, useRef, useEffect } from "react";
import { Icon } from "./icons";

interface VoiceRecorderModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  promptText?: string;
  onSave: (audioBase64: string) => Promise<void>;
}

export function VoiceRecorderModal({
  isOpen,
  onClose,
  title,
  subtitle,
  promptText,
  onSave,
}: VoiceRecorderModalProps) {
  const [status, setStatus] = useState<"idle" | "recording" | "recorded" | "saving">("idle");
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const recordedBlobRef = useRef<Blob | null>(null);

  // Clean up resources on unmount or close
  const cleanup = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch (_) {}
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    recordedBlobRef.current = null;
    setStatus("idle");
    setSeconds(0);
    setErrorMsg(null);
    setIsPlaying(false);
  };

  useEffect(() => {
    if (!isOpen) {
      cleanup();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const startRecording = async () => {
    setErrorMsg(null);
    audioChunksRef.current = [];
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    recordedBlobRef.current = null;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Microphone recording is not supported in this environment.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      // Select mime type
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

      const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const mime = recorder.mimeType || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type: mime });
        recordedBlobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setStatus("recorded");
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
      };

      recorder.start(100);
      setStatus("recording");
      setSeconds(0);
      timerRef.current = window.setInterval(() => {
        setSeconds((s) => s + 1);
      }, 1000);
    } catch (e: any) {
      setErrorMsg(e?.message || "Failed to access microphone. Please check microphone permissions.");
      setStatus("idle");
    }
  };

  const stopRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const togglePreview = () => {
    if (!audioPreviewRef.current || !audioUrl) return;
    if (isPlaying) {
      audioPreviewRef.current.pause();
      setIsPlaying(false);
    } else {
      audioPreviewRef.current.currentTime = 0;
      audioPreviewRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const handleSave = async () => {
    if (!recordedBlobRef.current) return;
    setStatus("saving");
    setErrorMsg(null);

    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const res = reader.result as string;
          const base64 = res.includes(",") ? res.split(",")[1] : res;
          await onSave(base64);
          cleanup();
          onClose();
        } catch (err: any) {
          setErrorMsg(err?.message || String(err));
          setStatus("recorded");
        }
      };
      reader.onerror = () => {
        setErrorMsg("Failed to read recorded audio data.");
        setStatus("recorded");
      };
      reader.readAsDataURL(recordedBlobRef.current);
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
      setStatus("recorded");
    }
  };

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={() => {
        if (status !== "recording" && status !== "saving") {
          cleanup();
          onClose();
        }
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 540,
          background: "var(--modal-bg, #fff)",
          color: "var(--ink, #1e293b)",
          border: "1px solid var(--line, #e2e8f0)",
          borderRadius: 14,
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.28)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--line, #e2e8f0)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--modal-header-bg, #fbfaf8)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: status === "recording" ? "#fee2e2" : "var(--soft, #e0e7ff)",
                  color: status === "recording" ? "#dc2626" : "var(--accent, #4338ca)",
                }}
              >
                <Icon name="mic" size={15} />
              </span>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--ink, #1e293b)" }}>{title}</h3>
            </div>
            {subtitle && (
              <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--muted, #64748b)" }}>{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            className="icon-btn"
            disabled={status === "recording" || status === "saving"}
            onClick={() => {
              cleanup();
              onClose();
            }}
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              border: "1px solid var(--line, #e2e8f0)",
              background: "var(--btn-bg, #fff)",
              color: "var(--ink, #1e293b)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
          {errorMsg && (
            <div
              style={{
                padding: "10px 14px",
                background: "#fef2f2",
                color: "#b91c1c",
                borderRadius: 8,
                fontSize: 13,
                border: "1px solid #fecaca",
              }}
            >
              {errorMsg}
            </div>
          )}

          {/* Script Prompt Text to read */}
          {promptText && (
            <div
              style={{
                padding: "14px 16px",
                background: "var(--soft, #f8fafc)",
                borderRadius: 10,
                border: "1px solid var(--line, #e2e8f0)",
              }}
            >
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--muted, #64748b)",
                  marginBottom: 6,
                }}
              >
                Read this line aloud:
              </div>
              <div
                style={{
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: "var(--ink, #0f172a)",
                  fontWeight: 500,
                }}
              >
                {promptText}
              </div>
            </div>
          )}

          {/* Recorder Visual Center */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "24px 16px",
              background: "var(--surface, #fafafa)",
              borderRadius: 12,
              border: "1px dashed var(--line-strong, #cbd5e1)",
            }}
          >
            {status === "idle" && (
              <>
                <button
                  type="button"
                  onClick={startRecording}
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: "50%",
                    background: "#ef4444",
                    color: "#fff",
                    border: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    boxShadow: "0 8px 16px rgba(239, 68, 68, 0.35)",
                    transition: "transform 0.15s ease",
                  }}
                  title="Click to start recording"
                >
                  <Icon name="mic" size={28} />
                </button>
                <div style={{ marginTop: 12, fontSize: 13.5, fontWeight: 600, color: "#334155" }}>
                  Click to start recording
                </div>
                <div style={{ marginTop: 2, fontSize: 12, color: "#64748b" }}>
                  Record a clear take using your microphone
                </div>
              </>
            )}

            {status === "recording" && (
              <>
                <div style={{ position: "relative", display: "inline-flex" }}>
                  <button
                    type="button"
                    onClick={stopRecording}
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: "50%",
                      background: "#dc2626",
                      color: "#fff",
                      border: "4px solid #fecaca",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      animation: "pulse 1.5s infinite",
                    }}
                    title="Stop recording"
                  >
                    <div style={{ width: 20, height: 20, background: "#fff", borderRadius: 4 }} />
                  </button>
                </div>
                <div
                  style={{
                    marginTop: 14,
                    fontSize: 22,
                    fontFamily: "monospace",
                    fontWeight: 700,
                    color: "#dc2626",
                    letterSpacing: "0.05em",
                  }}
                >
                  {formatTime(seconds)}
                </div>
                <div style={{ marginTop: 4, fontSize: 12.5, color: "#64748b" }}>
                  Recording… Click square button when finished
                </div>
              </>
            )}

            {status === "recorded" && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={togglePreview}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: "#2563eb",
                      color: "#fff",
                      border: "none",
                      padding: "8px 16px",
                      borderRadius: 8,
                      cursor: "pointer",
                    }}
                  >
                    <Icon name={isPlaying ? "pause" : "play"} size={14} />
                    {isPlaying ? "Pause preview" : "Play preview"}
                  </button>

                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={startRecording}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "8px 14px",
                      borderRadius: 8,
                    }}
                  >
                    <Icon name="refresh" size={13} />
                    Re-record
                  </button>
                </div>

                <div style={{ marginTop: 10, fontSize: 12.5, color: "#16a34a", fontWeight: 600 }}>
                  ✓ Recorded take: {formatTime(seconds)}
                </div>
              </>
            )}

            {status === "saving" && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#334155" }}>
                  Transcoding & Saving Audio…
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  Converting to 48kHz mono 16-bit PCM WAV via FFmpeg
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--line, #e2e8f0)",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10,
            background: "var(--modal-header-bg, #fbfaf8)",
          }}
        >
          <button
            type="button"
            className="btn ghost"
            disabled={status === "recording" || status === "saving"}
            onClick={() => {
              cleanup();
              onClose();
            }}
          >
            Cancel
          </button>

          {status === "recording" ? (
            <button
              type="button"
              className="btn primary"
              style={{ background: "#dc2626", borderColor: "#dc2626" }}
              onClick={stopRecording}
            >
              Stop &amp; Review
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={status !== "recorded"}
              onClick={handleSave}
            >
              Use Recorded Voice
            </button>
          )}
        </div>
      </div>

      {/* Hidden audio element for preview */}
      {audioUrl && (
        <audio
          ref={audioPreviewRef}
          src={audioUrl}
          onEnded={() => setIsPlaying(false)}
          onPause={() => setIsPlaying(false)}
        />
      )}
    </div>
  );
}
