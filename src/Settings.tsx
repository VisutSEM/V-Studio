import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { api, GpuInfo, onUpdateDownloadProgress, Settings as S, SettingsView, TtsRoute, UpdateCheckResult } from "./api";
import { Icon } from "./components/icons";
import { applyTheme } from "./theme";

type Kind = S["llm_kind"];
type TtsKind = S["tts_kind"];
type Msg = { text: string; kind: "ok" | "error" } | null;
type TestKey = "llm" | "voice" | "cf";
type TestMsg = { which: TestKey; text: string; ok: boolean } | null;
type SettingsTab = "general" | "ai" | "voice" | "images" | "stock" | "about";

const DEFAULT_MODEL: Record<Kind, string> = {
  gemini: "gemini-3.8-flash",
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
  const [testVoiceText] = useState("ការសាកសំឡេង");
  const [route, setRoute] = useState<TtsRoute | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<"latest" | "available" | null>(null);
  const [latestVersion, setLatestVersion] = useState("0.2.3");
  const [downloadUrl, setDownloadUrl] = useState("https://github.com/VisutSEM/V-Studio/releases");
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    percent: number;
    downloadedMb: number;
    totalMb: number;
  } | null>(null);
  const [downloadReadyPath, setDownloadReadyPath] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true);
    setDownloadError(null);
    try {
      const res = await api.checkForUpdates();
      setUpdateResult(res);
      setLatestVersion(res.latest_version);
      setUpdateStatus(res.has_update ? "available" : "latest");
      if (res.download_url) setDownloadUrl(res.download_url);
    } catch {
      setUpdateStatus("latest");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleStartInAppUpdate = async () => {
    if (!updateResult) return;
    const targetUrl = updateResult.installer_url || updateResult.download_url;
    setDownloadingUpdate(true);
    setDownloadError(null);
    const estMb = updateResult.installer_size ? Math.round(updateResult.installer_size / 1024 / 1024) : 98;
    setDownloadProgress({ percent: 0, downloadedMb: 0, totalMb: estMb });

    try {
      const unlisten = await onUpdateDownloadProgress((p) => {
        const dMb = Math.round((p.downloaded_bytes / (1024 * 1024)) * 10) / 10;
        const tMb = Math.round((p.total_bytes / (1024 * 1024)) * 10) / 10;
        setDownloadProgress({ percent: p.percent, downloadedMb: dMb, totalMb: tMb });
        if (p.error) {
          setDownloadError(p.error);
          setDownloadingUpdate(false);
        }
      });

      const installerPath = await api.downloadUpdateInstaller(targetUrl, updateResult.latest_version);
      unlisten();
      setDownloadingUpdate(false);
      setDownloadReadyPath(installerPath);
    } catch (err: any) {
      setDownloadingUpdate(false);
      setDownloadError(err?.message || String(err));
    }
  };

  const handleRestartAndInstall = async () => {
    if (!downloadReadyPath) return;
    try {
      await api.runInstallerAndExit(downloadReadyPath);
    } catch (err: any) {
      setDownloadError(err?.message || String(err));
    }
  };

  useEffect(() => {
    api
      .getSettings()
      .then(setS)
      .catch((e) => setMsg({ text: String(e), kind: "error" }));
    api.getTtsRoute().then(setRoute).catch(() => {});
    api.getGpuInfo().then(setGpu).catch(() => {});
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
      api.getTtsRoute().then(setRoute).catch(() => {});
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
        ? (testVoiceText.trim() || "សួស្តី! នេះគឺជាការសាកល្បងសំឡេងខ្មែរយ៉ាងច្បាស់។")
        : "Hello! This is a voice preview for narration.";
    runTest(
      "voice",
      "test_tts",
      lang === "km" ? "Preview Khmer" : "Preview English",
      s.tts_kind === "azure" ? keys.azure : s.tts_kind === "kiri_tts" ? keys.kiri : "",
      () => `Playing ${lang === "km" ? "Khmer" : "English"} sample (Crystal-Clear Voice)`,
      { text },
    );
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
              {/* Card 1: Voice */}
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
                      className="settings-select-dark voice-engine-select"
                      value={s.tts_kind}
                      onChange={(e) => set({ tts_kind: e.target.value as TtsKind })}
                    >
                      <option value="edge_tts">Edge TTS (free, unofficial)</option>
                      <option value="voxcpm">VoxCPM2 (local, your GPU)</option>
                      <option value="auto">Auto (GPU routing — VoxCPM 2 or Edge TTS)</option>
                      <option value="azure">Azure Speech</option>
                      <option value="kiri_tts">Kiri TTS</option>
                      <option value="meta_mms">Meta MMS (Fast Offline Khmer)</option>
                      <option value="gpt_sovits">GPT-SoVITS (Local Voice Clone)</option>
                    </select>
                  </div>

                  {s.tts_kind === "edge_tts" && (
                    <>
                      <div className="voice-two-col-grid">
                        <div className="settings-field-dark">
                          <label htmlFor="s-edge-km">Khmer voice</label>
                          <select
                            id="s-edge-km"
                            className="settings-select-dark"
                            value={s.edge_voice_km || "km-KH-SreymomNeural"}
                            onChange={(e) => set({ edge_voice_km: e.target.value })}
                          >
                            <option value="km-KH-SreymomNeural">Sreymom (female)</option>
                            <option value="km-KH-PisethNeural">Piseth (male)</option>
                          </select>
                        </div>
                        <div className="settings-field-dark">
                          <label htmlFor="s-edge-en">English voice</label>
                          <select
                            id="s-edge-en"
                            className="settings-select-dark"
                            value={s.edge_voice_en || "en-US-AvaNeural"}
                            onChange={(e) => set({ edge_voice_en: e.target.value })}
                          >
                            <option value="en-US-AvaNeural">Ava (female)</option>
                            <option value="en-US-JennyNeural">Jenny (female)</option>
                            <option value="en-US-AriaNeural">Aria (female)</option>
                            <option value="en-US-GuyNeural">Guy (male)</option>
                          </select>
                        </div>
                      </div>

                      <div className="voice-two-col-grid">
                        <div className="voice-slider-field">
                          <label>Speed · {(s.edge_speed ?? 0) > 0 ? `+${s.edge_speed}` : (s.edge_speed ?? 0)}%</label>
                          <input
                            type="range"
                            min={-50}
                            max={50}
                            step={1}
                            value={s.edge_speed ?? 0}
                            onChange={(e) => set({ edge_speed: Number(e.target.value) })}
                            className="voice-range-slider"
                          />
                        </div>
                        <div className="voice-slider-field">
                          <label>Pitch · {(s.edge_pitch ?? 0) > 0 ? `+${s.edge_pitch}` : (s.edge_pitch ?? 0)} Hz</label>
                          <input
                            type="range"
                            min={-50}
                            max={50}
                            step={1}
                            value={s.edge_pitch ?? 0}
                            onChange={(e) => set({ edge_pitch: Number(e.target.value) })}
                            className="voice-range-slider"
                          />
                        </div>
                      </div>

                      <div className="voice-subtext">Speed and pitch apply to Edge TTS.</div>
                    </>
                  )}

                  {s.tts_kind === "voxcpm" && (
                    <div className="settings-info-box-dark">
                      <Icon name="info" size={16} className="info-icon" />
                      <span>
                        Local voices run on your graphics card: free and offline. Install the model and make or
                        choose a voice in “Local voices” below.
                      </span>
                    </div>
                  )}

                  {s.tts_kind === "auto" && (
                    <div className="settings-info-box-dark">
                      <Icon name="info" size={16} className="info-icon" />
                      <span>
                        Auto routing picks VoxCPM 2 when the GPU has at least 5.4 GB VRAM, otherwise Edge TTS. {route ? route.reason : ""}
                      </span>
                    </div>
                  )}

                  {s.tts_kind === "azure" && (
                    <div className="voice-two-col-grid">
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
                  )}

                  {s.tts_kind === "kiri_tts" && (
                    <div className="voice-two-col-grid">
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
                  )}

                  <div className="settings-actions-row-dark">
                    <button
                      type="button"
                      className="settings-btn-dark"
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

                  {s.tts_kind === "edge_tts" && (
                    <div className="settings-info-box-dark">
                      <Icon name="info" size={16} className="info-icon" />
                      <span>
                        Changing the voice marks existing scene voices as outdated; they are
                        regenerated on the next run.
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Card 2: Local voices */}
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
                  <div className="gpu-badge-line">
                    <Icon name="cpu" size={16} />
                    <span>{gpu?.name || "NVIDIA GeForce RTX 3050 Laptop GPU"}</span>
                    <span className="vram-pill">
                      {((gpu?.vram_mb || 4096) / 1024).toFixed(1)} GB video memory
                    </span>
                  </div>

                  <div className="settings-info-box-dark">
                    <Icon name="info" size={16} className="info-icon" />
                    <span>
                      {gpu && gpu.has_nvidia && gpu.vram_mb >= 5529
                        ? `Local voices run with CUDA GPU acceleration on your ${gpu.name || "graphics card"} (${(gpu.vram_mb / 1024).toFixed(1)} GB VRAM).`
                        : "Local voices need a graphics card with at least 5.4 GB of memory. Use Edge TTS or Gemini TTS instead."}
                    </span>
                  </div>

                  <div className="voice-footer-meta">
                    Engine: audio.cpp v0.9.0 (Vulkan) (Apache-2.0) · Model: VoxCPM2 (Apache-2.0)
                  </div>
                </div>
              </div>
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
                        {["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"].map((m) => (
                          <button
                            key={m}
                            type="button"
                            className="settings-btn-dark"
                            style={{
                              padding: "2px 8px",
                              fontSize: 11,
                              borderColor: s.llm_model === m ? "#e05e46" : undefined,
                              color: s.llm_model === m ? "#ffffff" : undefined,
                            }}
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
                          (r) => {
                            const reply = typeof r === "string" ? r : r?.reply || "OK";
                            return `${s.llm_model} connected successfully — response: "${reply.trim()}"`;
                          },
                        )
                      }
                    >
                      {testing === "llm" ? "Testing…" : "Test Key"}
                    </button>
                  </div>
                  {testMsg && testMsg.which === "llm" && (
                    <div
                      style={{
                        padding: "8px 12px",
                        borderRadius: 8,
                        marginTop: 6,
                        background: testMsg.ok ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)",
                        color: testMsg.ok ? "#4ade80" : "#f87171",
                        border: `1px solid ${testMsg.ok ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Icon name={testMsg.ok ? "sparkles" : "info"} size={14} />
                      <span>{testMsg.text}</span>
                    </div>
                  )}
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
                  {testMsg && testMsg.which === "cf" && (
                    <div
                      style={{
                        padding: "8px 12px",
                        borderRadius: 8,
                        marginTop: 6,
                        background: testMsg.ok ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)",
                        color: testMsg.ok ? "#4ade80" : "#f87171",
                        border: `1px solid ${testMsg.ok ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Icon name={testMsg.ok ? "sparkles" : "info"} size={14} />
                      <span>{testMsg.text}</span>
                    </div>
                  )}
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
                    Videos are exported in 1080p Full HD (1920x1080) at 30 fps using bundled FFmpeg.
                    Subtitles can be burned into video or saved as standalone SRT.
                  </span>
                </div>

                <div className="settings-field-dark">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <label htmlFor="s-subtitles-enabled" style={{ margin: 0, fontWeight: 600 }}>Burn-in Subtitles in Video</label>
                      <div className="settings-footnote-dark" style={{ marginTop: 2 }}>
                        Burn synchronized subtitles permanently into video frames. Turn OFF for clean video without text.
                      </div>
                    </div>
                    <button
                      type="button"
                      id="s-subtitles-enabled"
                      onClick={() => set({ subtitles_enabled: !(s.subtitles_enabled ?? true) })}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 6,
                        border: "1px solid",
                        borderColor: (s.subtitles_enabled ?? true) ? "#6366f1" : "var(--border-subtle, #334155)",
                        background: (s.subtitles_enabled ?? true) ? "rgba(99, 102, 241, 0.15)" : "transparent",
                        color: (s.subtitles_enabled ?? true) ? "var(--accent-primary, #6366f1)" : "var(--text-secondary, #94a3b8)",
                        cursor: "pointer",
                        fontWeight: 700,
                        fontSize: 13,
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
                          background: (s.subtitles_enabled ?? true) ? "#22c55e" : "#94a3b8",
                          display: "inline-block",
                        }}
                      />
                      {(s.subtitles_enabled ?? true) ? "ON" : "OFF"}
                    </button>
                  </div>
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

                <div className="settings-actions-row-dark" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="settings-btn-dark primary"
                    disabled={busy}
                    onClick={save}
                  >
                    {busy ? "Saving…" : "Save settings"}
                  </button>
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
                  Version 0.2.3
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

                  {updateStatus === "available" && (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        padding: "10px 14px",
                        borderRadius: 8,
                        background: "rgba(249, 115, 22, 0.15)",
                        border: "1px solid rgba(249, 115, 22, 0.4)",
                        color: "#fb923c",
                        fontSize: 13,
                        fontWeight: 500,
                        width: "100%",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                        <span>Update available: <strong>v{latestVersion}</strong>! Please update to the latest version.</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {downloadReadyPath ? (
                            <button
                              type="button"
                              className="settings-btn-dark primary"
                              style={{ padding: "5px 12px", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
                              onClick={handleRestartAndInstall}
                            >
                              <Icon name="sparkles" size={13} />
                              Restart &amp; Install
                            </button>
                          ) : downloadingUpdate ? (
                            <button
                              type="button"
                              className="settings-btn-dark"
                              disabled
                              style={{ padding: "5px 12px", fontSize: 12, opacity: 0.85, cursor: "wait", display: "inline-flex", alignItems: "center", gap: 6 }}
                            >
                              <Icon name="refresh" size={12} className="spin" />
                              Downloading…
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="settings-btn-dark primary"
                                style={{ padding: "5px 12px", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
                                onClick={handleStartInAppUpdate}
                              >
                                <Icon name="sparkles" size={13} />
                                Update now (In-App)
                              </button>
                              <button
                                type="button"
                                className="settings-btn-dark"
                                style={{ padding: "5px 10px", fontSize: 12 }}
                                onClick={() => openUrl(downloadUrl)}
                              >
                                Browser
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {downloadingUpdate && downloadProgress && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          <div
                            style={{
                              width: "100%",
                              height: 6,
                              background: "rgba(255, 255, 255, 0.15)",
                              borderRadius: 4,
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.max(4, downloadProgress.percent)}%`,
                                height: "100%",
                                background: "linear-gradient(90deg, #f97316, #fb923c)",
                                borderRadius: 4,
                                transition: "width 0.2s ease",
                              }}
                            />
                          </div>
                          <span style={{ fontSize: 12, color: "rgba(255, 255, 255, 0.75)" }}>
                            Downloading v{latestVersion}… {downloadProgress.percent}% ({downloadProgress.downloadedMb} / {downloadProgress.totalMb} MB)
                          </span>
                        </div>
                      )}

                      {downloadReadyPath && (
                        <span style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>
                          ✓ Installer downloaded to disk. Click "Restart &amp; Install" to finish update.
                        </span>
                      )}

                      {downloadError && (
                        <span style={{ fontSize: 12, color: "#f87171" }}>
                          ⚠️ In-app download failed: {downloadError}. You can click "Browser" to download manually.
                        </span>
                      )}
                    </div>
                  )}

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
                      You're on the latest version (v0.2.3)
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
    </div>
  );
}
