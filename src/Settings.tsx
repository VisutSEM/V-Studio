import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Settings as S, SettingsView, VoxCpmSetupStatus, VoxCpmSetupProgress, onVoxcpmSetupProgress } from "./api";
import { Icon } from "./components/icons";
import { VoiceRecorderModal } from "./components/VoiceRecorderModal";
import { applyTheme } from "./theme";

type Kind = S["llm_kind"];
type TtsKind = S["tts_kind"];
type Msg = { text: string; kind: "ok" | "error" } | null;
type TestKey = "llm" | "voice" | "cf";
type TestMsg = { which: TestKey; text: string; ok: boolean } | null;
type SettingsTab = "general" | "ai" | "voice" | "images" | "stock" | "about";

const DEFAULT_MODEL: Record<Kind, string> = {
  gemini: "gemini-2.5-flash",
  open_ai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
  open_ai_compatible: "",
};

const KEY_HELP: Record<Kind, { text: string; url: string; label: string }> = {
  gemini: {
    text: "Free key from Google AI Studio: sign in, then Create API key.",
    url: "https://aistudio.google.com/app/apikey",
    label: "Get a Gemini key",
  },
  open_ai: {
    text: "OpenAI Platform: API keys → Create new secret key.",
    url: "https://platform.openai.com/api-keys",
    label: "Get an OpenAI key",
  },
  anthropic: {
    text: "Anthropic Console: Settings → API keys → Create key.",
    url: "https://console.anthropic.com/settings/keys",
    label: "Get a Claude key",
  },
  open_ai_compatible: {
    text: "Works with OpenRouter, DeepSeek, Groq, Ollama…",
    url: "https://openrouter.ai/keys",
    label: "OpenRouter keys",
  },
};

function HelpLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="linkish"
      style={{ color: "#818cf8" }}
      onClick={() => {
        openUrl(url).catch((e) => console.error("Could not open link", e));
      }}
    >
      <Icon name="globe" size={12} />
      {children}
    </button>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("voice");
  const [s, setS] = useState<SettingsView | null>(null);
  const [keys, setKeys] = useState({ llm: "", cf: "", azure: "", kiri: "" });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<TestKey | null>(null);
  const [testMsg, setTestMsg] = useState<TestMsg>(null);
  const [voxStatus, setVoxStatus] = useState<string>("checking");
  const [testVoiceText] = useState("ការសាកសំឡេង");
  const [serverCheck, setServerCheck] = useState<{
    loading: boolean;
    result: { ok: boolean; status: string; message: string } | null;
  }>({ loading: false, result: null });
  const [gpuInfo, setGpuInfo] = useState<{
    has_nvidia: boolean;
    gpu_name: string;
    vram_mb: number;
    torch_cuda_available: boolean;
    torch_version: string;
  } | null>(null);
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [setupStatus, setSetupStatus] = useState<VoxCpmSetupStatus | null>(null);
  const [setupProgress, setSetupProgress] = useState<VoxCpmSetupProgress | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<"latest" | "available" | null>("latest");

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true);
    await new Promise((r) => setTimeout(r, 900));
    setCheckingUpdate(false);
    setUpdateStatus("latest");
  };

  useEffect(() => {
    let active = true;
    api.getVoxcpmSetupStatus().then((st) => {
      if (active) setSetupStatus(st);
    }).catch(() => {});

    const unlisten = onVoxcpmSetupProgress((p) => {
      if (!active) return;
      setSetupProgress(p);
      if (p.is_done) {
        setIsInstalling(false);
        api.getVoxcpmSetupStatus().then(setSetupStatus).catch(() => {});
        setVoxStatus("ready");
      }
      if (p.error) {
        setIsInstalling(false);
      }
    });

    return () => {
      active = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let active = true;
    const check = () => {
      invoke<string>("get_voxcpm_status")
        .then((st) => {
          if (active) setVoxStatus(st);
        })
        .catch(() => {
          if (active) setVoxStatus("stopped");
        });
    };
    check();
    const interval = setInterval(check, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    api
      .getSettings()
      .then(setS)
      .catch((e) => setMsg({ text: String(e), kind: "error" }));

    api
      .getGpuInfo()
      .then(setGpuInfo)
      .catch(() => {});
  }, []);

  if (!s) return null;
  const set = (p: Partial<S>) => setS({ ...s, ...p });
  const has = {
    llm: s.has_llm_key,
    cf: s.has_cf_token,
    azure: s.has_azure_key,
    kiri: s.has_kiri_key,
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.saveSettings(s, {
        llmApiKey: keys.llm || null,
        cfApiToken: keys.cf || null,
        azureTtsKey: keys.azure || null,
        kiriTtsKey: keys.kiri || null,
      });
      setS({
        ...s,
        has_llm_key: has.llm || !!keys.llm,
        has_cf_token: has.cf || !!keys.cf,
        has_azure_key: has.azure || !!keys.azure,
        has_kiri_key: has.kiri || !!keys.kiri,
      });
      setKeys({ llm: "", cf: "", azure: "", kiri: "" });
      setMsg({ text: "Settings saved successfully", kind: "ok" });
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    }
    setBusy(false);
  };

  const runTest = async (
    which: TestKey,
    cmd: string,
    label: string,
    key: string,
    describe: (result: any) => string,
    extraArgs: Record<string, unknown> = {},
  ) => {
    if (testing) return;
    setTesting(which);
    setTestMsg(null);
    setMsg(null);
    try {
      const result = await invoke<any>(cmd, {
        settings: s,
        apiKey: key.trim() || null,
        ...extraArgs,
      });
      if (result && typeof result === "object" && result.audio_base64) {
        try {
          const snd = new Audio(`data:${result.mime || "audio/wav"};base64,${result.audio_base64}`);
          snd.play().catch(() => {});
        } catch (_) {}
      }
      setTestMsg({ which, text: `${label} OK — ${describe(result)}`, ok: true });
    } catch (e) {
      setTestMsg({ which, text: `${label} failed: ${String(e)}`, ok: false });
    }
    setTesting(null);
  };

  const playPreview = (lang: "km" | "en") => {
    const text =
      lang === "km"
        ? (testVoiceText.trim() || "សួស្តី! នេះជាការសាកល្បងសំឡេងខ្មែរ។")
        : "Hello! This is a voice preview for narration.";
    runTest(
      "voice",
      "test_tts",
      lang === "km" ? "Preview Khmer" : "Preview English",
      s.tts_kind === "azure" ? keys.azure : s.tts_kind === "kiri_tts" ? keys.kiri : "",
      () => `Playing ${lang === "km" ? "Khmer" : "English"} sample`,
      { text },
    );
  };

  const testVoxcpmServer = async () => {
    if (!s) return;
    setServerCheck({ loading: true, result: null });
    try {
      const res = await invoke<{ ok: boolean; status: string; message: string }>(
        "check_voxcpm_health",
        { url: s.voxcpm_url || "http://127.0.0.1:8000" },
      );
      setServerCheck({ loading: false, result: res });
      if (res.ok) setVoxStatus("ready");
      else if (res.status === "loading") setVoxStatus("starting");
      else setVoxStatus("stopped");
    } catch (e) {
      setServerCheck({
        loading: false,
        result: {
          ok: false,
          status: "unreachable",
          message: String(e),
        },
      });
      setVoxStatus("stopped");
    }
  };

  const pickAudio = async (apply: (path: string) => void) => {
    try {
      const file = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "ogg", "aac"] }],
      });
      if (typeof file === "string" && file) apply(file);
    } catch (e) {
      setMsg({ text: String(e), kind: "error" });
    }
  };

  const gpuName = setupStatus?.gpu_name || gpuInfo?.gpu_name || "NVIDIA GeForce GPU";
  const vramMb = setupStatus?.vram_mb ?? gpuInfo?.vram_mb ?? 0;
  const vramGb = vramMb > 0 ? (vramMb / 1024).toFixed(1) : "0.0";
  const systemRamMb = setupStatus?.system_ram_mb ?? 0;
  const systemRamGb = systemRamMb > 0 ? (systemRamMb / 1024).toFixed(1) : "0.0";
  const hasEnoughVram = vramMb >= 5400;
  const hasEnoughCpuRam = systemRamMb >= 15000;
  const canInstall = setupStatus ? setupStatus.can_install : (hasEnoughVram || hasEnoughCpuRam);

  const handleInstallEngine = async () => {
    if (!canInstall) return;
    setIsInstalling(true);
    setSetupProgress({
      step: "Starting setup...",
      percent: 5,
      log: "Initializing setup...",
      is_done: false,
    });
    try {
      await api.setupVoxcpmEngine();
      const updated = await api.getVoxcpmSetupStatus();
      setSetupStatus(updated);
      setVoxStatus("ready");
    } catch (e) {
      setSetupProgress({
        step: "Installation failed",
        percent: 0,
        log: String(e),
        is_done: false,
        error: String(e),
      });
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <div className="settings-view-dark">
      {/* Top Header */}
      <div className="settings-header-dark">
        <div className="settings-eyebrow-dark">Workspace</div>
        <h1 className="settings-title-dark">Settings</h1>
      </div>

      {msg && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            marginBottom: 20,
            background: msg.kind === "ok" ? "#14532d" : "#7f1d1d",
            color: "#f0fdf4",
            border: `1px solid ${msg.kind === "ok" ? "#22c55e" : "#ef4444"}`,
            fontSize: 13.5,
          }}
        >
          {msg.text}
        </div>
      )}

      {testMsg && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            marginBottom: 20,
            background: testMsg.ok ? "#14532d" : "#7f1d1d",
            color: "#f0fdf4",
            border: `1px solid ${testMsg.ok ? "#22c55e" : "#ef4444"}`,
            fontSize: 13.5,
          }}
        >
          {testMsg.text}
        </div>
      )}

      {/* Main Layout: Left Navigation + Right Content */}
      <div className="settings-layout-dark">
        {/* Left Vertical Nav */}
        <div className="settings-nav-dark">
          <button
            type="button"
            className={`settings-nav-btn ${activeTab === "general" ? "active" : ""}`}
            onClick={() => setActiveTab("general")}
          >
            <Icon name="settings" size={16} />
            General
          </button>

          <button
            type="button"
            className={`settings-nav-btn ${activeTab === "ai" ? "active" : ""}`}
            onClick={() => setActiveTab("ai")}
          >
            <Icon name="sparkles" size={16} />
            AI &amp; keys
          </button>

          <button
            type="button"
            className={`settings-nav-btn ${activeTab === "voice" ? "active" : ""}`}
            onClick={() => setActiveTab("voice")}
          >
            <Icon name="mic" size={16} />
            Voice
          </button>

          <button
            type="button"
            className={`settings-nav-btn ${activeTab === "images" ? "active" : ""}`}
            onClick={() => setActiveTab("images")}
          >
            <Icon name="image" size={16} />
            Images
          </button>

          <button
            type="button"
            className={`settings-nav-btn ${activeTab === "stock" ? "active" : ""}`}
            onClick={() => setActiveTab("stock")}
          >
            <Icon name="film" size={16} />
            Stock &amp; video
          </button>

          <button
            type="button"
            className={`settings-nav-btn ${activeTab === "about" ? "active" : ""}`}
            onClick={() => setActiveTab("about")}
          >
            <Icon name="info" size={16} />
            About &amp; updates
          </button>
        </div>

        {/* Right Content Area */}
        <div className="settings-content-dark">
          {/* ==================================================== TAB: VOICE */}
          {activeTab === "voice" && (
            <>
              {/* Card 1: Voice Engine */}
              <div className="settings-card-dark">
                <div className="settings-card-left">
                  <h3>Voice</h3>
                  <p>
                    Engine and voice for the narration. Edge TTS is free but unofficial — Microsoft
                    can change or block it at any time. Gemini TTS uses your API key.
                  </p>
                </div>

                <div className="settings-card-right">
                  <div className="settings-field-dark">
                    <label htmlFor="s-tts-kind">Voice engine</label>
                    <select
                      id="s-tts-kind"
                      className="settings-select-dark"
                      value={s.tts_kind}
                      onChange={(e) => set({ tts_kind: e.target.value as TtsKind })}
                    >
                      <option value="voxcpm">VoxCPM2 (local, your GPU)</option>
                      <option value="meta_mms">Meta MMS (local offline, fast CPU)</option>
                      <option value="kiri_tts">Kiri TTS (Khmer AI, cloud)</option>
                      <option value="azure">Azure Speech (Khmer &amp; English, cloud)</option>
                      <option value="gpt_sovits">GPT-SoVITS (local voice clone)</option>
                      <option value="edge_tts">Edge TTS (free cloud)</option>
                    </select>
                  </div>

                  <div className="settings-info-box-dark">
                    <Icon name="info" size={16} className="info-icon" />
                    <span>
                      Local voices run on your graphics card: free and offline. Install the model
                      and make or choose a voice in “Local voices” below.
                    </span>
                  </div>

                  <div className="settings-actions-row-dark">
                    <button
                      type="button"
                      className="settings-btn-dark primary"
                      disabled={busy}
                      onClick={save}
                    >
                      {busy ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="settings-btn-dark"
                      disabled={testing !== null}
                      onClick={() => playPreview("km")}
                    >
                      <Icon name="play" size={12} />
                      {testing === "voice" ? "Generating…" : "Preview Khmer"}
                    </button>
                    <button
                      type="button"
                      className="settings-btn-dark"
                      disabled={testing !== null}
                      onClick={() => playPreview("en")}
                    >
                      <Icon name="play" size={12} />
                      {testing === "voice" ? "Generating…" : "Preview English"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Card 2: Local voices (VoxCPM 2) */}
              <div className="settings-card-dark">
                <div className="settings-card-left">
                  <h3>Local voices</h3>
                  <p>
                    VoxCPM2 makes natural narration on your own graphics card — free, no limits,
                    works offline. Make a voice from a description or from your own recording; it
                    stays the same in every scene and project.
                  </p>
                </div>

                <div className="settings-card-right">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    <div className="gpu-badge-dark">
                      <Icon name="cpu" size={16} />
                      <span>{gpuName}</span>
                      <span className="vram-pill">{vramGb} GB video memory</span>
                    </div>
                    {systemRamMb > 0 && (
                      <div className="gpu-badge-dark">
                        <Icon name="sparkles" size={15} />
                        <span>System Memory</span>
                        <span className="vram-pill">{systemRamGb} GB RAM</span>
                      </div>
                    )}
                  </div>

                  <div className="settings-info-box-dark">
                    <Icon name="info" size={16} className="info-icon" />
                    <span>
                      {hasEnoughVram
                        ? `Local voices run best on a graphics card with at least 5.4 GB VRAM. Detected ${vramGb} GB VRAM — ready for high-speed CUDA acceleration!`
                        : hasEnoughCpuRam
                          ? `GPU has under 5.4 GB VRAM, but your PC has ${systemRamGb} GB system RAM. Can run on CPU (safe, ~20-30s per scene).`
                          : `Local voices require a graphics card with at least 5.4 GB VRAM or at least 16 GB system RAM. Your hardware is below minimum specs.`}
                    </span>
                  </div>

                  {/* Installer & Engine Status Banner */}
                  {isInstalling ? (
                    <div
                      style={{
                        background: "var(--bg-card)",
                        border: "1px solid var(--accent-primary, #6366f1)",
                        borderRadius: 8,
                        padding: "14px 16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                          {setupProgress?.step || "Installing VoxCPM 2 Engine..."}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-primary, #6366f1)" }}>
                          {setupProgress?.percent ?? 0}%
                        </span>
                      </div>
                      <div
                        style={{
                          width: "100%",
                          height: 6,
                          background: "var(--border-subtle)",
                          borderRadius: 999,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${setupProgress?.percent ?? 5}%`,
                            background: "var(--accent-primary, #6366f1)",
                            transition: "width 0.3s ease",
                          }}
                        />
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                        {setupProgress?.log}
                      </div>
                    </div>
                  ) : setupProgress?.error ? (
                    <div
                      style={{
                        background: "rgba(239, 68, 68, 0.1)",
                        border: "1px solid #ef4444",
                        borderRadius: 8,
                        padding: "12px 14px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#f87171" }}>Setup Failed</div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{setupProgress.error}</div>
                      {canInstall && (
                        <button
                          type="button"
                          className="settings-btn-dark"
                          style={{ alignSelf: "flex-start", marginTop: 4 }}
                          onClick={handleInstallEngine}
                        >
                          Retry Installation
                        </button>
                      )}
                    </div>
                  ) : setupStatus && !setupStatus.is_ready ? (
                    !canInstall ? (
                      /* LOW RAM / GPU DETECTED: STRICTLY BLOCK INSTALLATION */
                      <div
                        style={{
                          background: "rgba(239, 68, 68, 0.12)",
                          border: "1px solid #ef4444",
                          borderRadius: 10,
                          padding: "14px 16px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ color: "#ef4444", display: "inline-flex" }}>
                            <Icon name="x" size={16} />
                          </span>
                          <span style={{ fontSize: 13.5, fontWeight: 700, color: "#f87171" }}>
                            Low Memory Detected — VoxCPM 2 Cannot Be Installed
                          </span>
                        </div>
                        <p style={{ margin: 0, fontSize: 12.5, color: "#e5e7eb", lineHeight: 1.55 }}>
                          VoxCPM 2 requires an <b>NVIDIA GPU with at least 5.4 GB VRAM</b> or a PC with at least <b>16 GB System RAM</b>.
                          <br />
                          Detected on this computer: <b>{gpuName} ({vramGb} GB VRAM)</b> · <b>{systemRamGb} GB System RAM</b>.
                        </p>
                        <div
                          style={{
                            background: "#16181f",
                            border: "1px solid #2e313d",
                            borderRadius: 8,
                            padding: "10px 12px",
                            fontSize: 12.5,
                            color: "#93c5fd",
                            lineHeight: 1.5,
                          }}
                        >
                          🛡️ <b>Installation is blocked to protect this computer from freezing or running out of memory.</b>
                          <br />
                          <b>Recommended alternative:</b> Switch Voice Engine above to <b>Meta MMS (Khmer offline CPU)</b> or <b>Edge TTS (cloud)</b> — both work smoothly on any laptop or PC!
                        </div>
                      </div>
                    ) : (
                      /* HARDWARE IS CAPABLE: SHOW INSTALL BUTTON */
                      <div
                        style={{
                          background: "var(--bg-card)",
                          border: "1px solid #eab308",
                          borderRadius: 8,
                          padding: "14px 16px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Icon name="info" size={16} className="info-icon" />
                          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                            Local Voice Engine Not Installed
                          </span>
                        </div>
                        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                          To generate voices completely offline on this computer, install the local VoxCPM 2 engine.
                          {hasEnoughVram
                            ? ` We detected ${gpuName} (${vramGb} GB VRAM) and will automatically configure CUDA GPU acceleration!`
                            : ` We detected ${systemRamGb} GB system memory and will configure safe CPU mode.`}
                        </p>
                        <div>
                          <button
                            type="button"
                            className="settings-btn-dark primary"
                            onClick={handleInstallEngine}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                          >
                            <Icon name="sparkles" size={13} />
                            Install Local Voice Engine (~2.5 GB)
                          </button>
                        </div>
                      </div>
                    )
                  ) : setupStatus?.gpu_name && !setupStatus?.torch_cuda ? (
                    <div
                      style={{
                        background: "var(--bg-card)",
                        border: "1px solid #3b82f6",
                        borderRadius: 8,
                        padding: "14px 16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Icon name="cpu" size={16} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                          NVIDIA GPU Detected — Enable CUDA Acceleration
                        </span>
                      </div>
                      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                        Your {setupStatus.gpu_name} is detected, but VoxCPM is currently running in CPU mode (~30s per voice).
                        Click below to upgrade PyTorch with CUDA 12.4 to generate voices in ~1.5 seconds!
                      </p>
                      <div>
                        <button
                          type="button"
                          className="settings-btn-dark primary"
                          onClick={handleInstallEngine}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <Icon name="sparkles" size={13} />
                          Enable GPU CUDA Acceleration
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* Reference Audio + Mic Recording */}
                  <div className="settings-field-dark">
                    <label htmlFor="s-vox-ref">Reference voice audio</label>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input
                        id="s-vox-ref"
                        className="settings-input-dark"
                        style={{ flex: 1, minWidth: 220 }}
                        placeholder="Path to audio clip (3–10s WAV or MP3)"
                        value={s.voxcpm_ref_audio}
                        onChange={(e) => set({ voxcpm_ref_audio: e.target.value })}
                      />
                      <button
                        type="button"
                        className="settings-btn-dark"
                        onClick={() => pickAudio((path) => set({ voxcpm_ref_audio: path }))}
                      >
                        Browse…
                      </button>
                      <button
                        type="button"
                        className="settings-btn-dark"
                        style={{
                          background: "#dc2626",
                          borderColor: "#b91c1c",
                          color: "#fff",
                        }}
                        onClick={() => setShowRecordModal(true)}
                        title="Record your microphone voice directly for this character"
                      >
                        <Icon name="mic" size={13} />
                        Record Voice
                      </button>
                      {s.voxcpm_ref_audio.trim() && (
                        <button
                          type="button"
                          className="settings-btn-dark"
                          onClick={() => set({ voxcpm_ref_audio: "", voxcpm_ref_text: "" })}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Voice Design Description */}
                  <div className="settings-field-dark">
                    <label htmlFor="s-vox-desc">Voice design (optional prompt)</label>
                    <textarea
                      id="s-vox-desc"
                      className="settings-textarea-dark"
                      rows={2}
                      placeholder="A slow, warm female storyteller with a calm and mysterious tone"
                      value={s.voxcpm_description}
                      onChange={(e) => set({ voxcpm_description: e.target.value })}
                    />
                  </div>

                  {/* Steps & Device Row */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <div className="settings-field-dark">
                      <label htmlFor="s-vox-device">Compute device</label>
                      <select
                        id="s-vox-device"
                        className="settings-select-dark"
                        value={s.voxcpm_device || "auto"}
                        onChange={(e) => set({ voxcpm_device: e.target.value })}
                      >
                        <option value="auto">Auto (CUDA GPU preferred)</option>
                        <option value="cuda">CUDA (NVIDIA GPU — Fast ~1.5s)</option>
                        <option value="cpu">CPU (Standard ~30s)</option>
                      </select>
                    </div>

                    <div className="settings-field-dark">
                      <label htmlFor="s-vox-steps">Inference steps</label>
                      <select
                        id="s-vox-steps"
                        className="settings-select-dark"
                        value={s.voxcpm_steps || 6}
                        onChange={(e) => set({ voxcpm_steps: +e.target.value })}
                      >
                        <option value={6}>6 steps (Fastest ~40% faster on GPU)</option>
                        <option value={8}>8 steps (Balanced quality &amp; speed)</option>
                        <option value={10}>10 steps (Maximum fidelity)</option>
                      </select>
                    </div>
                  </div>

                  {/* Server status & test row */}
                  <div className="settings-actions-row-dark" style={{ marginTop: 4 }}>
                    <button
                      type="button"
                      className="settings-btn-dark"
                      disabled={serverCheck.loading}
                      onClick={testVoxcpmServer}
                    >
                      <Icon name="check" size={13} />
                      {serverCheck.loading ? "Checking…" : "Test Server"}
                    </button>

                    {voxStatus === "ready" ? (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <span
                          style={{
                            fontSize: 12,
                            color: "#22c55e",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                          }}
                        >
                          <Icon name="check" size={12} /> Server ready (port 8000) {setupStatus?.torch_cuda ? "• CUDA GPU" : "• CPU"}
                        </span>
                        <button
                          type="button"
                          className="settings-btn-dark"
                          style={{ padding: "4px 10px", fontSize: 11.5 }}
                          onClick={async () => {
                            setVoxStatus("starting");
                            await invoke("stop_voxcpm_server");
                            await invoke("start_voxcpm_server");
                          }}
                          title="Restart the local VoxCPM server"
                        >
                          Restart
                        </button>
                      </div>
                    ) : voxStatus === "starting" ? (
                      <span style={{ fontSize: 12, color: "#f59e0b" }}>
                        Loading model weights…
                      </span>
                    ) : (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "#9ca3af" }}>Server offline</span>
                        <button
                          type="button"
                          className="settings-btn-dark"
                          style={{ padding: "4px 10px", fontSize: 11.5 }}
                          onClick={() => {
                            setVoxStatus("starting");
                            invoke("start_voxcpm_server");
                          }}
                        >
                          Start server
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="settings-footnote-dark">
                    Engine: voxcpm (CUDA / PyTorch) · Model: VoxCPM2 (Apache-2.0)
                  </div>
                </div>
              </div>

              {/* Conditional Engine Details if Azure or Kiri selected */}
              {s.tts_kind === "kiri_tts" && (
                <div className="settings-card-dark">
                  <div className="settings-card-left">
                    <h3>Kiri TTS Settings</h3>
                    <p>High-fidelity native Khmer voices developed by Blizzer.</p>
                  </div>
                  <div className="settings-card-right">
                    <div className="settings-field-dark">
                      <label htmlFor="s-kiri-key">API Key</label>
                      <input
                        id="s-kiri-key"
                        className="settings-input-dark"
                        type="password"
                        placeholder={has.kiri ? "Key saved — paste to replace" : "kiri-live-..."}
                        value={keys.kiri}
                        onChange={(e) => setKeys({ ...keys, kiri: e.target.value })}
                      />
                    </div>
                    <div className="settings-field-dark">
                      <label htmlFor="s-kiri-voice">Speaker Voice</label>
                      <select
                        id="s-kiri-voice"
                        className="settings-select-dark"
                        value={s.kiri_voice || "Maly"}
                        onChange={(e) => set({ kiri_voice: e.target.value })}
                      >
                        <option value="Maly">Maly (Female — Gentle &amp; Clear)</option>
                        <option value="Neary">Neary (Female — Storyteller)</option>
                        <option value="Oudom">Oudom (Male — Formal &amp; Warm)</option>
                        <option value="Phanin">Phanin (Male — Expressive)</option>
                        <option value="Sokha">Sokha (Male — Calm Narrator)</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {s.tts_kind === "azure" && (
                <div className="settings-card-dark">
                  <div className="settings-card-left">
                    <h3>Azure Speech</h3>
                    <p>Cloud voice synthesis supporting Khmer and English via Microsoft Cognitive Services.</p>
                  </div>
                  <div className="settings-card-right">
                    <div className="settings-field-dark">
                      <label htmlFor="s-az-key">Speech API Key</label>
                      <input
                        id="s-az-key"
                        className="settings-input-dark"
                        type="password"
                        placeholder={has.azure ? "Key saved — paste to replace" : "32-character key"}
                        value={keys.azure}
                        onChange={(e) => setKeys({ ...keys, azure: e.target.value })}
                      />
                    </div>
                    <div className="settings-field-dark">
                      <label htmlFor="s-az-region">Region</label>
                      <input
                        id="s-az-region"
                        className="settings-input-dark"
                        placeholder="eastus, southeastasia…"
                        value={s.azure_region}
                        onChange={(e) => set({ azure_region: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ==================================================== TAB: AI & KEYS */}
          {activeTab === "ai" && (
            <div className="settings-card-dark">
              <div className="settings-card-left">
                <h3>Script model</h3>
                <p>Writes the scene-by-scene narration and script beats from your story prompt.</p>
              </div>

              <div className="settings-card-right">
                <div className="settings-field-dark">
                  <label htmlFor="s-kind">Provider</label>
                  <select
                    id="s-kind"
                    className="settings-select-dark"
                    value={s.llm_kind}
                    onChange={(e) => {
                      const k = e.target.value as Kind;
                      set({ llm_kind: k, llm_model: DEFAULT_MODEL[k] });
                    }}
                  >
                    <option value="gemini">Google Gemini</option>
                    <option value="open_ai">OpenAI (ChatGPT)</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="open_ai_compatible">
                      OpenAI-compatible (OpenRouter, DeepSeek, Groq…)
                    </option>
                  </select>
                </div>

                <div className="settings-field-dark">
                  <label htmlFor="s-model">Model name</label>
                  <input
                    id="s-model"
                    className="settings-input-dark"
                    placeholder="Model name"
                    value={s.llm_model}
                    onChange={(e) => set({ llm_model: e.target.value })}
                  />
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {s.llm_kind === "gemini" && (
                      <>
                        {["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"].map((m) => (
                          <button
                            key={m}
                            type="button"
                            className="settings-btn-dark"
                            style={{ padding: "2px 8px", fontSize: 11 }}
                            onClick={() => set({ llm_model: m })}
                          >
                            {m}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </div>

                <div className="settings-field-dark">
                  <label htmlFor="s-llm-key">API Key</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      id="s-llm-key"
                      className="settings-input-dark"
                      type="password"
                      placeholder={has.llm ? "Key saved — paste to replace" : "API key"}
                      value={keys.llm}
                      onChange={(e) => setKeys({ ...keys, llm: e.target.value })}
                    />
                    <button
                      type="button"
                      className="settings-btn-dark"
                      disabled={testing !== null}
                      onClick={() =>
                        runTest(
                          "llm",
                          "test_llm",
                          "Script",
                          keys.llm,
                          (r) => `${(r?.model || s.llm_model)} answered: "${String(r?.reply || "").slice(0, 40)}…"`,
                        )
                      }
                    >
                      {testing === "llm" ? "Testing…" : "Test Key"}
                    </button>
                  </div>
                </div>

                <div className="settings-info-box-dark">
                  <Icon name="info" size={16} className="info-icon" />
                  <div>
                    <span>{KEY_HELP[s.llm_kind].text} </span>
                    <HelpLink url={KEY_HELP[s.llm_kind].url}>
                      {KEY_HELP[s.llm_kind].label}
                    </HelpLink>
                  </div>
                </div>

                <div className="settings-actions-row-dark">
                  <button
                    type="button"
                    className="settings-btn-dark primary"
                    disabled={busy}
                    onClick={save}
                  >
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ==================================================== TAB: IMAGES */}
          {activeTab === "images" && (
            <div className="settings-card-dark">
              <div className="settings-card-left">
                <h3>Images &amp; Visuals</h3>
                <p>Generates high-resolution widescreen illustrations for each scene beat.</p>
              </div>

              <div className="settings-card-right">
                <div className="settings-field-dark">
                  <label htmlFor="s-cf-acc">Cloudflare Account ID</label>
                  <input
                    id="s-cf-acc"
                    className="settings-input-dark"
                    placeholder="32-character hex ID"
                    value={s.cf_account_id}
                    onChange={(e) => set({ cf_account_id: e.target.value })}
                  />
                </div>

                <div className="settings-field-dark">
                  <label htmlFor="s-cf-tok">API Token</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      id="s-cf-tok"
                      className="settings-input-dark"
                      type="password"
                      placeholder={has.cf ? "Token saved — paste to replace" : "Workers AI token"}
                      value={keys.cf}
                      onChange={(e) => setKeys({ ...keys, cf: e.target.value })}
                    />
                    <button
                      type="button"
                      className="settings-btn-dark"
                      disabled={testing !== null}
                      onClick={() =>
                        runTest(
                          "cf",
                          "test_cf",
                          "Images",
                          keys.cf,
                          (r) => `${(r?.len ?? Number(r)).toLocaleString()} bytes rendered`,
                        )
                      }
                    >
                      {testing === "cf" ? "Testing…" : "Test Token"}
                    </button>
                  </div>
                </div>

                <div className="settings-field-dark">
                  <label htmlFor="s-cf-model">Model</label>
                  <select
                    id="s-cf-model"
                    className="settings-select-dark"
                    value={s.cf_image_model}
                    onChange={(e) => set({ cf_image_model: e.target.value })}
                  >
                    <option value="@cf/black-forest-labs/flux-1-schnell">
                      FLUX.1-schnell (Recommended — 4 steps, photorealistic)
                    </option>
                    <option value="@cf/bytedance/stable-diffusion-xl-lightning">
                      SDXL-Lightning (Fastest — 2-4 steps)
                    </option>
                    <option value="@cf/stabilityai/stable-diffusion-xl-base-1.0">
                      Stable Diffusion XL Base 1.0 (Detailed)
                    </option>
                  </select>
                </div>

                <div className="settings-actions-row-dark">
                  <button
                    type="button"
                    className="settings-btn-dark primary"
                    disabled={busy}
                    onClick={save}
                  >
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ==================================================== TAB: GENERAL */}
          {activeTab === "general" && (
            <>
              {/* Appearance Card */}
              <div className="settings-card-dark">
                <div className="settings-card-left">
                  <h3>Appearance</h3>
                  <p>
                    Customize how VideoGen looks on your device. Choose light, dark, or sync with
                    your system theme.
                  </p>
                </div>

                <div className="settings-card-right">
                  <div className="settings-field-dark">
                    <label>Interface theme</label>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                        gap: 12,
                      }}
                    >
                      {/* Light Mode */}
                      <button
                        type="button"
                        onClick={() => {
                          set({ theme: "light" });
                          applyTheme("light");
                        }}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 10,
                          padding: "16px 14px",
                          borderRadius: 12,
                          border:
                            (s.theme || "system") === "light"
                              ? "2px solid #3b82f6"
                              : "1px solid var(--line)",
                          background:
                            (s.theme || "system") === "light"
                              ? "rgba(59, 130, 246, 0.12)"
                              : "var(--card-bg)",
                          cursor: "pointer",
                          color: (s.theme || "system") === "light" ? "var(--ink)" : "var(--muted)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <div
                          style={{
                            width: "100%",
                            height: 48,
                            borderRadius: 8,
                            background: "#f3efe9",
                            border: "1px solid #ded8ce",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#1a1917",
                          }}
                        >
                          <Icon name="sun" size={22} />
                        </div>
                        <span
                          style={{
                            fontSize: 13.5,
                            fontWeight: (s.theme || "system") === "light" ? 600 : 500,
                          }}
                        >
                          Light
                        </span>
                      </button>

                      {/* Dark Mode */}
                      <button
                        type="button"
                        onClick={() => {
                          set({ theme: "dark" });
                          applyTheme("dark");
                        }}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 10,
                          padding: "16px 14px",
                          borderRadius: 12,
                          border:
                            (s.theme || "system") === "dark"
                              ? "2px solid #3b82f6"
                              : "1px solid var(--line)",
                          background:
                            (s.theme || "system") === "dark"
                              ? "rgba(59, 130, 246, 0.12)"
                              : "var(--card-bg)",
                          cursor: "pointer",
                          color: (s.theme || "system") === "dark" ? "var(--ink)" : "var(--muted)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <div
                          style={{
                            width: "100%",
                            height: 48,
                            borderRadius: 8,
                            background: "#121316",
                            border: "1px solid #282a33",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#ffffff",
                          }}
                        >
                          <Icon name="moon" size={20} />
                        </div>
                        <span
                          style={{
                            fontSize: 13.5,
                            fontWeight: (s.theme || "system") === "dark" ? 600 : 500,
                          }}
                        >
                          Dark
                        </span>
                      </button>

                      {/* System Theme */}
                      <button
                        type="button"
                        onClick={() => {
                          set({ theme: "system" });
                          applyTheme("system");
                        }}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 10,
                          padding: "16px 14px",
                          borderRadius: 12,
                          border:
                            (s.theme || "system") === "system"
                              ? "2px solid #3b82f6"
                              : "1px solid var(--line)",
                          background:
                            (s.theme || "system") === "system"
                              ? "rgba(59, 130, 246, 0.12)"
                              : "var(--card-bg)",
                          cursor: "pointer",
                          color: (s.theme || "system") === "system" ? "var(--ink)" : "var(--muted)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <div
                          style={{
                            width: "100%",
                            height: 48,
                            borderRadius: 8,
                            background: "linear-gradient(90deg, #f3efe9 50%, #121316 50%)",
                            border: "1px solid var(--line)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#3b82f6",
                          }}
                        >
                          <Icon name="monitor" size={20} />
                        </div>
                        <span
                          style={{
                            fontSize: 13.5,
                            fontWeight: (s.theme || "system") === "system" ? 600 : 500,
                          }}
                        >
                          Same as system
                        </span>
                      </button>
                    </div>

                    <div className="settings-footnote-dark" style={{ marginTop: 6 }}>
                      {(s.theme || "system") === "system"
                        ? "Automatically follows your Windows system display mode."
                        : `Current mode: ${s.theme || "system"}.`}
                    </div>
                  </div>
                </div>
              </div>

              {/* Output & Workspace Card */}
              <div className="settings-card-dark">
                <div className="settings-card-left">
                  <h3>Output &amp; Workspace</h3>
                  <p>Location where completed 1080p video renders are saved.</p>
                </div>

                <div className="settings-card-right">
                  <div className="settings-field-dark">
                    <label htmlFor="s-out-dir">Output folder</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        id="s-out-dir"
                        className="settings-input-dark"
                        value={s.output_dir}
                        onChange={(e) => set({ output_dir: e.target.value })}
                        placeholder="Default: AppData\Local\videogen\exports"
                      />
                      <button
                        type="button"
                        className="settings-btn-dark"
                        onClick={async () => {
                          try {
                            const picked = await open({
                              directory: true,
                              multiple: false,
                              defaultPath: s.output_dir || undefined,
                            });
                            if (typeof picked === "string" && picked) {
                              set({ output_dir: picked });
                            }
                          } catch (err) {
                            console.error(err);
                          }
                        }}
                      >
                        <Icon name="folder" size={14} />
                        Browse…
                      </button>
                      <button
                        type="button"
                        className="settings-btn-dark"
                        onClick={() => api.openOutputDir(s.output_dir || null)}
                      >
                        Open
                      </button>
                    </div>
                  </div>

                  <div className="settings-actions-row-dark" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="settings-btn-dark primary"
                      disabled={busy}
                      onClick={save}
                    >
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ==================================================== TAB: STOCK & VIDEO */}
          {activeTab === "stock" && (
            <div className="settings-card-dark">
              <div className="settings-card-left">
                <h3>Stock &amp; Video</h3>
                <p>Settings for rendering, subtitles, and export video composition.</p>
              </div>

              <div className="settings-card-right">
                <div className="settings-info-box-dark">
                  <Icon name="info" size={16} className="info-icon" />
                  <span>
                    Videos are exported in 1080p Full HD (1920x1080) at 30 fps using bundled FFmpeg
                    with synchronized SRT/burn-in subtitles.
                  </span>
                </div>

                <div className="settings-field-dark">
                  <label>Default Video Resolution</label>
                  <select className="settings-select-dark" defaultValue="1080p">
                    <option value="1080p">1080p Full HD (1920 × 1080) — 16:9 Landscape</option>
                    <option value="720p">720p HD (1280 × 720)</option>
                    <option value="shorts">1080 × 1920 — 9:16 Portrait (Shorts/TikTok)</option>
                  </select>
                </div>

                <div className="settings-field-dark">
                  <label>Subtitle Font</label>
                  <select className="settings-select-dark" defaultValue="noto">
                    <option value="noto">Noto Sans Khmer &amp; Inter (Bundled)</option>
                    <option value="system">System Default</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ==================================================== TAB: ABOUT & UPDATES */}
          {activeTab === "about" && (
            <div className="settings-card-dark">
              <div className="settings-card-left">
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
                  <img
                    src="/logo.png"
                    alt="V-Studio Logo"
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 10,
                      objectFit: "contain",
                      background: "#fff",
                      padding: 3,
                      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
                      flexShrink: 0,
                    }}
                  />
                  <div>
                    <h3 style={{ margin: 0, fontSize: 18 }}>About</h3>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", marginTop: 1 }}>V-Studio</div>
                  </div>
                </div>
                <p>V-Studio — narrated explainer videos in Khmer or English.</p>
              </div>

              <div className="settings-card-right">
                <div style={{ color: "var(--muted)", fontSize: 14 }}>
                  Version 0.1.0
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 4 }}>
                  <button
                    type="button"
                    className="settings-btn-dark"
                    disabled={checkingUpdate}
                    onClick={handleCheckForUpdates}
                    style={{ padding: "8px 16px", display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5 }}
                  >
                    <Icon name="refresh" size={15} className={checkingUpdate ? "spin" : ""} />
                    {checkingUpdate ? "Checking for updates…" : "Check for updates"}
                  </button>

                  {updateStatus === "latest" && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "5px 12px",
                        borderRadius: 999,
                        background: "rgba(34, 197, 94, 0.12)",
                        color: "#4ade80",
                        fontSize: 13,
                        fontWeight: 500,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          backgroundColor: "#22c55e",
                          display: "inline-block",
                        }}
                      />
                      You're on the latest version
                    </span>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div
                style={{
                  gridColumn: "1 / -1",
                  marginTop: 18,
                  paddingTop: 16,
                  borderTop: "1px solid var(--line)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  color: "var(--muted)",
                  fontSize: 13,
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <span>this tool is development by Visut @2026</span>
                <span style={{ fontSize: 12, opacity: 0.75 }}>All rights reserved</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Voice Recorder Modal for recording character reference audio */}
      <VoiceRecorderModal
        isOpen={showRecordModal}
        onClose={() => setShowRecordModal(false)}
        title="Record Reference Voice for VoxCPM"
        subtitle="Speak 3 to 10 seconds of clear speech into your microphone for VoxCPM to clone"
        promptText="សួស្តី! នេះគឺជាការសាកល្បងសំឡេងតួអង្គរបស់ខ្ញុំ សម្រាប់គម្រោងវីដេអូថ្មី។"
        onSave={async (audioBase64) => {
          const savedPath = await api.saveVoxcpmRecording(audioBase64);
          set({
            voxcpm_ref_audio: savedPath,
            voxcpm_ref_text: "សួស្តី! នេះគឺជាការសាកល្បងសំឡេងតួអង្គរបស់ខ្ញុំ សម្រាប់គម្រោងវីដេអូថ្មី។",
          });
          setMsg({ text: "Reference voice recorded and saved successfully!", kind: "ok" });
        }}
      />
    </div>
  );
}
