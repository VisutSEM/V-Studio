import { ProjectCard, ScriptTaskStatus, fileUrl } from "./api";
import { fmtDate, langLabel, minutes, sceneLabel, stageMeta } from "./format";
import { Icon } from "./components/icons";

function Thumb({ card, task }: { card: ProjectCard; task?: ScriptTaskStatus }) {
  const isRunning = task?.is_running;
  const canContinue = !isRunning && task?.can_continue;

  return (
    <div className="p-thumb">
      {card.thumb ? (
        <img src={fileUrl(card.dir, card.thumb)} alt="" loading="lazy" />
      ) : (
        <div className="p-thumb-empty">
          <Icon name="image" size={30} />
        </div>
      )}
      {isRunning ? (
        <span
          className="chip warn"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: "#eff6ff",
            color: "#1d4ed8",
            borderColor: "#bfdbfe",
            fontWeight: 600,
          }}
        >
          <Icon name="sparkles" size={12} className="spin" />
          Writing ({task.done}/{task.total})
        </span>
      ) : canContinue ? (
        <span
          className="chip warn"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: "#fef3c7",
            color: "#b45309",
            borderColor: "#fde68a",
            fontWeight: 600,
          }}
          title={task.error || "Generation paused"}
        >
          <Icon name="sparkles" size={12} />
          Paused ({task.done}/{task.total})
        </span>
      ) : (
        <span className={`chip ${stageMeta(card.stage).tone}`}>
          {stageMeta(card.stage).label}
        </span>
      )}
    </div>
  );
}

export default function Projects({
  cards,
  total,
  query,
  loading,
  missing,
  bannerOff,
  scriptTasks,
  onDismissBanner,
  onOpenSettings,
  onRefresh,
  onNew,
  onOpen,
  onDelete,
  onClearSearch,
}: {
  cards: ProjectCard[];
  total: number;
  query: string;
  loading: boolean;
  missing: string[];
  bannerOff: boolean;
  scriptTasks?: Record<string, ScriptTaskStatus>;
  onDismissBanner: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (card: ProjectCard) => void;
  onClearSearch: () => void;
}) {
  const searching = query.trim().length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">
            {searching
              ? `${cards.length} matching ${cards.length === 1 ? "story" : "stories"}`
              : total
                ? `${total} ${total === 1 ? "story" : "stories"} in your library`
                : "Your ghost stories will show up here"}
          </p>
        </div>
        <div className="head-actions">
          <button className="icon-btn" onClick={onRefresh} title="Refresh">
            <Icon name="refresh" size={18} />
          </button>
          <button className="btn primary" onClick={onNew}>
            <Icon name="plus" size={17} />
            New project
          </button>
        </div>
      </div>

      {missing.length > 0 && !bannerOff && (
        <div className="banner">
          <div className="banner-icon">
            <Icon name="sparkles" size={20} />
          </div>
          <div className="banner-body">
            <div className="banner-title">Connect your AI providers</div>
            <div className="banner-text">
              Add {missing.join(", ")} keys to generate scripts, narration and
              artwork. Everything else already works offline.
            </div>
          </div>
          <div className="banner-actions">
            <button className="btn sm" onClick={onOpenSettings}>
              Open settings
            </button>
          </div>
          <button
            className="banner-x"
            onClick={onDismissBanner}
            aria-label="Dismiss"
          >
            <Icon name="x" size={17} />
          </button>
        </div>
      )}

      <div className="section-head">
        <h2>{searching ? "Search results" : "All projects"}</h2>
        <span className="section-count">
          {searching ? `${cards.length} matching` : "Newest first"}
        </span>
      </div>

      {loading ? (
        <div className="grid-cards">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="sk-card" key={i}>
              <div className="sk-thumb" />
              <div className="sk-line" />
              <div className="sk-line short" />
            </div>
          ))}
        </div>
      ) : cards.length ? (
        <div className="grid-cards">
          {cards.map((card) => {
            const task = scriptTasks?.[card.id];
            return (
              <article
                key={card.id}
                className="p-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(card.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(card.id);
                  }
                }}
              >
                <Thumb card={card} task={task} />
                <div>
                  <div className="p-title">{card.name}</div>
                  <div className="p-meta">
                    {task?.is_running ? (
                      <span style={{ color: "#2563eb", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Icon name="sparkles" size={13} className="spin" />
                        Writing script ({task.done}/{task.total})…
                      </span>
                    ) : task?.can_continue ? (
                      <span style={{ color: "#d97706", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Icon name="sparkles" size={13} />
                        Paused ({task.done}/{task.total}) · Click to continue
                      </span>
                    ) : (
                      <>
                        {minutes(card.duration_sec)} min ·{" "}
                        {sceneLabel(card.scene_count)} · {langLabel(card.language)}
                      </>
                    )}
                  </div>
                  {task?.is_running && task.total > 0 && (
                    <div style={{ marginTop: 8, height: 4, background: "var(--line)", borderRadius: 2, overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          background: "#3b82f6",
                          width: `${Math.round((task.done / task.total) * 100)}%`,
                          transition: "width 0.3s ease",
                        }}
                      />
                    </div>
                  )}
                </div>
                <div className="p-foot">
                  <span>Edited {fmtDate(card.updated_at)}</span>
                  <button
                    className="icon-btn danger"
                    title="Delete project"
                    aria-label={`Delete ${card.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(card);
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <div className="empty-icon">
            <Icon name={searching ? "search" : "film"} size={24} />
          </div>
          <h3>{searching ? "No projects found" : "Start your first story"}</h3>
          <p>
            {searching
              ? "Try a different name, or clear the search to see every project."
              : "Describe a ghost story, choose a length, and VideoGen will write the script, record the voice and draw every scene."}
          </p>
          {searching ? (
            <button className="btn" onClick={onClearSearch}>
              Clear search
            </button>
          ) : (
            <button className="btn primary" onClick={onNew}>
              <Icon name="plus" size={17} />
              New project
            </button>
          )}
        </div>
      )}
    </>
  );
}
