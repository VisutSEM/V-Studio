import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Project {
  id: string; name: string; prompt: string; duration_sec: number; style: string;
  language: string; voice: string; character_sheet: string; stage: string;
  updated_at: string; created_at: string;
}
export interface ProjectCard {
  id: string; name: string; duration_sec: number; language: string; stage: string;
  updated_at: string; scene_count: number; thumb: string | null; dir: string;
}
export interface Scene {
  id: number; project_id: string; idx: number; narration: string; image_prompt: string;
  audio_path: string | null; image_path: string | null; audio_ms: number | null;
}
export interface Cue { idx: number; start_ms: number; end_ms: number; text: string }
export interface Detail { project: Project; scenes: Scene[]; dir: string; has_final: boolean }
export interface Progress { project_id: string; stage: string; done: number; total: number; message: string | null }

export interface Settings {
  llm_kind: "gemini" | "open_ai" | "anthropic" | "open_ai_compatible";
  llm_model: string; llm_base_url: string;
  cf_account_id: string; cf_image_model: string;
  tts_kind: "azure" | "gpt_sovits" | "edge_tts" | "meta_mms" | "kiri_tts";
  azure_region: string;
  kiri_base_url: string; kiri_model: string; kiri_voice: string; kiri_speed: number;
  gpt_sovits_url: string; gpt_sovits_ref_audio: string; gpt_sovits_prompt_text: string;
  gpt_sovits_prompt_lang: string; gpt_sovits_text_lang: string; gpt_sovits_speed: number;
  subtitles_enabled: boolean;
  output_dir: string;
  theme: "system" | "light" | "dark";
}
export interface SettingsView extends Settings {
  has_llm_key: boolean; has_cf_token: boolean; has_azure_key: boolean; has_kiri_key: boolean;
}

export const api = {
  list: () => invoke<Project[]>("list_projects"),
  listCards: () => invoke<ProjectCard[]>("list_project_cards"),
  create: (name: string) => invoke<Project>("create_project", { name }),
  update: (id: string, p: { prompt: string; durationSec: number; style: string; language: string; voice: string }) =>
    invoke<void>("update_project", { id, ...p }),
  get: (id: string) => invoke<Detail>("get_project", { id }),
  remove: (id: string) => invoke<void>("delete_project", { id }),
  estimate: (durationSec: number) => invoke<{ scene_len: number; scenes: number }>("estimate", { durationSec }),
  clearAsset: (sceneId: number, kind: "image" | "audio") => invoke<void>("clear_asset", { sceneId, kind }),
  script: (id: string) => invoke<number>("generate_script", { id }),
  voice: (id: string) => invoke<number>("generate_voice", { id }),
  images: (id: string) => invoke<number>("generate_images", { id }),
  buildSubs: (id: string) => invoke<Cue[]>("build_subtitles", { id }),
  getSubs: (id: string) => invoke<Cue[]>("get_subtitles", { id }),
  saveSubs: (id: string, cues: Cue[]) => invoke<void>("save_subtitles", { id, cues }),
  renameProject: (id: string, name: string) => invoke<void>("rename_project", { id, name }),
  updateProjectStory: (id: string, prompt: string, characterSheet: string) =>
    invoke<void>("update_project_story", { id, prompt, characterSheet }),
  updateScene: (sceneId: number, narration: string, imagePrompt: string) =>
    invoke<void>("update_scene", { sceneId, narration, imagePrompt }),
  addScene: (projectId: string, narration: string, imagePrompt: string) =>
    invoke<Scene>("add_scene", { projectId, narration, imagePrompt }),
  deleteScene: (sceneId: number) =>
    invoke<void>("delete_scene", { sceneId }),
  generateSceneVoice: (sceneId: number) => invoke<void>("generate_scene_voice", { sceneId }),
  generateSceneImage: (sceneId: number) => invoke<void>("generate_scene_image", { sceneId }),
  render: (id: string, ambient: string | null, subtitles?: boolean | null) =>
    invoke<string | null>("render_video", { id, ambient, subtitles: subtitles ?? null }),
  exportVideo: (id: string, dest?: string | null) => invoke<string>("export_video", { id, dest: dest ?? null }),
  saveSceneRecording: (sceneId: number, audioBase64: string) =>
    invoke<number>("save_scene_recording", { sceneId, audioBase64 }),
  openOutputDir: (path?: string | null) => invoke<void>("open_output_dir", { path: path ?? null }),
  getSettings: () => invoke<SettingsView>("get_settings"),
  saveSettings: (
    settings: Settings,
    keys: { llmApiKey?: string | null; cfApiToken?: string | null; azureTtsKey?: string | null; kiriTtsKey?: string | null },
  ) => invoke<void>("save_settings", { settings, ...keys }),
};

export const onProgress = (cb: (p: Progress) => void) => listen<Progress>("pipeline-progress", (e) => cb(e.payload));

export const fileUrl = (dir: string, rel: string) => convertFileSrc(`${dir.replace(/\\/g, "/")}/${rel}`);

// Same rounding as the backend (whole frames at 30 fps)
export const sceneMs = (ms: number) => Math.floor((Math.ceil((ms * 30) / 1000) * 1000) / 30);
