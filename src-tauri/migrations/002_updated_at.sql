ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE projects SET updated_at = created_at WHERE updated_at = '';
