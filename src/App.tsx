import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ProjectCard, SettingsView } from "./api";
import { Icon } from "./components/icons";
import Wizard from "./Wizard";
import Pipeline from "./Pipeline";
import Editor from "./Editor";
import Settings from "./Settings";
import Projects from "./Projects";
import { initThemeListener, applyTheme } from "./theme";

type Page =
  | { name: "projects" }
  | { name: "wizard" }
  | { name: "settings" }
  | { name: "pipeline"; id: string }
  | { name: "editor"; id: string };

const BANNER_KEY = "videogen.bannerOff";

export default function App() {
  const [page, setPage] = useState<Page>({ name: "projects" });
  const [cards, setCards] = useState<ProjectCard[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [bannerOff, setBannerOff] = useState(
    () => localStorage.getItem(BANNER_KEY) === "1",
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setCards(await api.listCards());
    } catch {
      /* leave the previous list in place */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unbind = initThemeListener();
    return () => unbind();
  }, []);

  useEffect(() => {
    refresh();
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (s.theme) applyTheme(s.theme);
      })
      .catch(() => {});
  }, [page, refresh]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [page]);

  // Ctrl/Cmd+K focuses the project search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.language.toLowerCase().includes(q) ||
        (c.language === "km" ? "khmer" : "english").includes(q),
    );
  }, [cards, query]);

  const recent = filtered.slice(0, 7);
  const onProjects = page.name === "projects" || page.name === "pipeline" || page.name === "editor";

  const remove = async (card: ProjectCard) => {
    if (!confirm(`Delete "${card.name}" and all its files?`)) return;
    await api.remove(card.id);
    refresh();
  };

  const missing = settings
    ? [
        !settings.has_llm_key ? "script" : "",
        !settings.has_azure_key ? "voice" : "",
        !settings.has_cf_token ? "images" : "",
      ].filter(Boolean)
    : [];
  const keySummary = !settings
    ? "Checking providers…"
    : missing.length
      ? `${3 - missing.length} of 3 providers connected`
      : "All providers connected";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => setPage({ name: "projects" })} style={{ cursor: "pointer" }}>
          <img
            src="/logo.png"
            alt="V-Studio"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              objectFit: "contain",
              background: "#fff",
              padding: 2,
              boxShadow: "0 2px 6px rgba(0, 0, 0, 0.18)",
              flexShrink: 0,
            }}
          />
          <div className="brand-name" style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>V-Studio</div>
        </div>

        <div className="side-search">
          <Icon name="search" size={17} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
              if (v && page.name !== "projects") setPage({ name: "projects" });
            }}
            placeholder="Search projects"
            aria-label="Search projects"
          />
          <span className="kbd">Ctrl K</span>
        </div>

        <div className="side-label" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, fontWeight: 700 }}>
          Essentials
        </div>
        <nav className="side-nav">
          <button
            className={`nav-item${onProjects ? " active" : ""}`}
            onClick={() => setPage({ name: "projects" })}
          >
            <Icon name="grid" size={18} />
            Projects
          </button>
          <button
            className={`nav-item${page.name === "wizard" ? " active" : ""}`}
            onClick={() => setPage({ name: "wizard" })}
          >
            <Icon name="plus" size={18} />
            New project
          </button>
          <button
            className={`nav-item${page.name === "settings" ? " active" : ""}`}
            onClick={() => setPage({ name: "settings" })}
          >
            <Icon name="settings" size={18} />
            Settings
          </button>
        </nav>

        <div className="side-label" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, fontWeight: 700 }}>
          Recent
        </div>
        <div className="side-recent">
          {recent.map((c) => {
            const isCurrent = page.name === "pipeline" && page.id === c.id;
            return (
              <button
                key={c.id}
                className={`recent-item${isCurrent ? " active" : ""}`}
                onClick={() => setPage({ name: "pipeline", id: c.id })}
                title={c.name}
              >
                <span style={{ color: isCurrent ? "#f97316" : "var(--muted)", display: "inline-flex" }}>
                  <Icon name={c.stage === "Rendered" ? "check" : "doc"} size={16} />
                </span>
                <span className="truncate">{c.name}</span>
              </button>
            );
          })}
          {!recent.length && (
            <div className="recent-empty">
              {query.trim() ? "Nothing matches that search." : "No projects yet."}
            </div>
          )}
        </div>

        <button className="side-foot" onClick={() => setPage({ name: "settings" })}>
          <Icon name="key" size={17} />
          <span className="truncate">{keySummary}</span>
        </button>
      </aside>

      <main className="main">
        <div className="main-scroll" ref={scrollRef}>
          {page.name === "projects" && (
            <Projects
              cards={filtered}
              total={cards.length}
              query={query}
              loading={loading}
              missing={missing}
              bannerOff={bannerOff}
              onDismissBanner={() => {
                localStorage.setItem(BANNER_KEY, "1");
                setBannerOff(true);
              }}
              onOpenSettings={() => setPage({ name: "settings" })}
              onRefresh={refresh}
              onNew={() => setPage({ name: "wizard" })}
              onOpen={(id) => setPage({ name: "pipeline", id })}
              onDelete={remove}
              onClearSearch={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            />
          )}

          {page.name === "wizard" && (
            <Wizard
              onCancel={() => setPage({ name: "projects" })}
              onDone={(id) => setPage({ name: "pipeline", id })}
            />
          )}

          {page.name === "pipeline" && (
            <Pipeline
              id={page.id}
              onBack={() => setPage({ name: "projects" })}
              onEditor={() => setPage({ name: "editor", id: page.id })}
            />
          )}

          {page.name === "editor" && (
            <Editor
              id={page.id}
              onBack={() => setPage({ name: "pipeline", id: page.id })}
              onProjects={() => setPage({ name: "projects" })}
            />
          )}

          {page.name === "settings" && <Settings />}
        </div>
      </main>
    </div>
  );
}
