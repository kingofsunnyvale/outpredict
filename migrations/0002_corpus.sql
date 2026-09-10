CREATE TABLE corpus_accounts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('reddit','sdn','mdapplicants')),
  source_account_id TEXT NOT NULL,
  public_handle TEXT NOT NULL,
  UNIQUE(source, source_account_id)
);
CREATE TABLE corpus_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES corpus_accounts(id),
  cycle TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
  review_status TEXT NOT NULL CHECK(review_status IN ('reviewed','needs_review','excluded')),
  observed_at TEXT NOT NULL,
  gpa REAL CHECK(gpa IS NULL OR gpa BETWEEN 0 AND 4),
  science_gpa REAL CHECK(science_gpa IS NULL OR science_gpa BETWEEN 0 AND 4),
  mcat INTEGER CHECK(mcat IS NULL OR mcat BETWEEN 472 AND 528),
  residence TEXT,
  summary TEXT NOT NULL,
  timing_status TEXT NOT NULL,
  activities_json TEXT NOT NULL CHECK(json_valid(activities_json)),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  content_sha256 TEXT NOT NULL,
  UNIQUE(account_id, cycle, version)
);
CREATE UNIQUE INDEX corpus_one_current_version ON corpus_profiles(account_id, cycle) WHERE is_current=1;
CREATE INDEX corpus_profile_filters ON corpus_profiles(review_status,is_current,cycle,gpa,mcat);
CREATE TABLE corpus_outcomes (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES corpus_profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES corpus_accounts(id),
  cycle TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted','rejected','interview','waitlisted','withdrawn','pending','unknown')),
  program TEXT NOT NULL,
  school TEXT,
  reported_count INTEGER,
  count_kind TEXT NOT NULL,
  conditional INTEGER NOT NULL DEFAULT 0 CHECK(conditional IN (0,1)),
  source_url TEXT NOT NULL,
  evidence TEXT NOT NULL
);
CREATE INDEX corpus_outcome_filters ON corpus_outcomes(profile_id,cycle,status);
CREATE TABLE corpus_imports (
  release TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  profile_count INTEGER NOT NULL,
  account_count INTEGER NOT NULL
);
