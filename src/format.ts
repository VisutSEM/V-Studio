export type Tone = "neutral" | "amber" | "blue" | "done";

export function fmtDate(raw: string): string {
  const s = raw?.trim();
  if (!s) return "—";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function stageMeta(stage: string): { label: string; tone: Tone } {
  switch (stage) {
    case "Rendered": return { label: "Done", tone: "done" };
    case "Editing": return { label: "Editing", tone: "blue" };
    case "ImagesReady": return { label: "Ready to edit", tone: "blue" };
    case "VoiceReady": return { label: "Voice ready", tone: "amber" };
    case "ScriptReady": return { label: "Script ready", tone: "amber" };
    default: return { label: "Draft", tone: "neutral" };
  }
}

export const langLabel = (code: string) => (code === "km" ? "Khmer" : "English");

export const minutes = (sec: number) => Math.max(1, Math.round(sec / 60));

export const sceneLabel = (n: number) => `${n} scene${n === 1 ? "" : "s"}`;

export function stageName(stage: string): string {
  switch (stage) {
    case "script": return "Writing script";
    case "voice": return "Recording voice";
    case "images": return "Drawing visuals";
    case "render": return "Rendering clips";
    case "encode": return "Encoding video";
    default: return stage;
  }
}
