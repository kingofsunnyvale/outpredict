CREATE TABLE corpus_collection_runs (
  release TEXT PRIMARY KEY REFERENCES corpus_imports(release),
  as_of TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  imported_at TEXT NOT NULL
);

-- Track the most recently activated release and exact prior current snapshots.
-- These tables are additive; the v1 runtime continues reading corpus_profiles.
CREATE TABLE corpus_active_release (
  id INTEGER PRIMARY KEY CHECK(id=1),
  release TEXT NOT NULL REFERENCES corpus_imports(release),
  content_sha256 TEXT NOT NULL
);
CREATE TABLE corpus_release_activation (
  release TEXT PRIMARY KEY REFERENCES corpus_imports(release) DEFERRABLE INITIALLY DEFERRED,
  previous_release TEXT REFERENCES corpus_imports(release)
);
CREATE TABLE corpus_release_changes (
  release TEXT NOT NULL REFERENCES corpus_imports(release) DEFERRABLE INITIALLY DEFERRED,
  profile_id TEXT NOT NULL,
  previous_current_id TEXT,
  PRIMARY KEY(release,profile_id)
);
CREATE TABLE corpus_release_guard (
  release TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid=1)
);
