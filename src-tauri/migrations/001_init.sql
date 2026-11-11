CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  prompt          TEXT NOT NULL DEFAULT '',
  duration_sec    INTEGER NOT NULL DEFAULT 60,
  style           TEXT NOT NULL DEFAULT '2d_horror',
  language        TEXT NOT NULL DEFAULT 'km',
  voice           TEXT NOT NULL DEFAULT 'km-KH-SreymomNeural',
  character_sheet TEXT NOT NULL DEFAULT '',
  stage           TEXT NOT NULL DEFAULT 'Draft',
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE scenes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  narration    TEXT NOT NULL,
  image_prompt TEXT NOT NULL,
  audio_path   TEXT,
  image_path   TEXT,
  audio_ms     INTEGER,
  UNIQUE(project_id, idx)
);

CREATE TABLE subtitles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  text       TEXT NOT NULL
);
CREATE INDEX idx_subs_project ON subtitles(project_id, idx);
