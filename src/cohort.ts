export const OUTCOMES = [
  "accepted",
  "rejected",
  "interview",
  "waitlisted",
  "withdrawn",
  "pending",
  "unknown",
] as const;
export const CORPUS_SOURCES = ["reddit", "sdn", "mdapplicants"] as const;
export type OutcomeStatus = (typeof OUTCOMES)[number];
export type CorpusSource = (typeof CORPUS_SOURCES)[number];
export interface Measurement {
  min: number | null;
  max: number | null;
  precision:
    | "reported"
    | "approximate"
    | "explicit_absence"
    | "unreported"
    | "range"
    | "lower_bound"
    | "upper_bound";
}
export interface CorpusActivity {
  category: string;
  description: string;
  hours: Measurement;
  timing: string;
  confidence: string;
}
export interface CorpusOutcome {
  status: OutcomeStatus;
  program: string;
  school: string | null;
  cycle: string;
  reportedCount: number | null;
  countKind: string;
  evidence: string;
  sourceUrl: string;
  conditional?: boolean;
}
export interface CorpusProfile {
  id: string;
  accountId: string;
  source: CorpusSource;
  sourceAccountId: string;
  publicHandle: string;
  cycle: string;
  gpa: number | null;
  scienceGpa: number | null;
  mcat: number | null;
  residence: string | null;
  summary: string;
  activities: CorpusActivity[];
  outcomes: CorpusOutcome[];
  sourceUrls: string[];
  observedAt: string;
  authoredAt: string | null;
  reviewStatus: string;
  extractionConfidence: "high" | "mixed";
  reviewedAt: string;
  timingStatus: string;
  notes: string[];
  academics: Record<string, string | null>;
  provenance: {
    method: string;
    sourceContentSha256: string;
    sourceArtifactKey: string;
    auditInventory: string;
  };
}
export interface CohortFilters {
  gpaMin?: number;
  gpaMax?: number;
  mcatMin?: number;
  mcatMax?: number;
  cycles?: string[];
  sources?: CorpusSource[];
  outcomes?: OutcomeStatus[];
  activity?: string;
  school?: string;
  limit: number;
}
export interface NumericSummary {
  n: number;
  missing: number;
  min: number | null;
  max: number | null;
  median: number | null;
}
export interface CohortResult {
  counts: {
    total: number;
    matched: number;
    examined: number;
    withReportedOutcomes: number;
    summarized: number;
  };
  filters: CohortFilters;
  profiles: CorpusProfile[];
  coverage: {
    sources: { value: string; count: number }[];
    cycles: { value: string; count: number }[];
  };
  statistics: {
    gpa: NumericSummary;
    mcat: NumericSummary;
    clinicalHours: NumericSummary;
    researchHours: NumericSummary;
    nonclinicalHours: NumericSummary;
  };
  limitations: string[];
}

export function validateCohortFilters(input: unknown): CohortFilters {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Cohort filters must be an object.");
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "gpaMin",
    "gpaMax",
    "mcatMin",
    "mcatMax",
    "cycles",
    "sources",
    "outcomes",
    "activity",
    "school",
    "limit",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Unsupported cohort filter.");
  const filters: CohortFilters = { limit: 12 };
  for (const key of [
    "gpaMin",
    "gpaMax",
    "mcatMin",
    "mcatMax",
    "limit",
  ] as const) {
    const n = value[key];
    if (n === undefined) continue;
    const min = key === "limit" ? 1 : key.startsWith("mcat") ? 472 : 0;
    const max = key === "limit" ? 20 : key.startsWith("mcat") ? 528 : 4;
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      ((key === "limit" || key.startsWith("mcat")) && !Number.isInteger(n))
    )
      throw new Error(`Invalid ${key}.`);
    filters[key] = n;
  }
  if (
    (filters.gpaMin ?? 0) > (filters.gpaMax ?? 4) ||
    (filters.mcatMin ?? 472) > (filters.mcatMax ?? 528)
  )
    throw new Error("Minimum filter exceeds maximum.");
  for (const key of ["cycles", "sources", "outcomes"] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.length > 10 ||
      list.some((item) => typeof item !== "string")
    )
      throw new Error(`Invalid ${key}.`);
    if (key === "cycles") {
      if (
        list.some(
          (cycle) =>
            !/^20\d{2}-\d{2}$/.test(cycle) ||
            Number(cycle.slice(5)) !== (Number(cycle.slice(0, 4)) + 1) % 100,
        )
      )
        throw new Error("Invalid application cycle.");
      filters.cycles = [...new Set<string>(list)];
    } else if (key === "sources") {
      if (list.some((source) => !CORPUS_SOURCES.includes(source)))
        throw new Error("Invalid source.");
      filters.sources = [...new Set<CorpusSource>(list)];
    } else {
      if (list.some((status) => !OUTCOMES.includes(status)))
        throw new Error("Invalid outcome.");
      filters.outcomes = [...new Set<OutcomeStatus>(list)];
    }
  }
  for (const key of ["activity", "school"] as const) {
    const text = value[key];
    if (text === undefined) continue;
    if (typeof text !== "string" || text.trim().length < 2 || text.length > 100)
      throw new Error(`Invalid ${key} search.`);
    filters[key] = text.trim();
  }
  return filters;
}

export function numericSummary(values: (number | null)[]): NumericSummary {
  const known = values
    .filter((n): n is number => n !== null && Number.isFinite(n))
    .sort((a, b) => a - b);
  const n = known.length;
  const midpoint = Math.floor(n / 2);
  const median =
    n === 0
      ? null
      : n % 2
        ? (known[midpoint] ?? null)
        : ((known[midpoint - 1] ?? 0) + (known[midpoint] ?? 0)) / 2;
  return {
    n,
    missing: values.length - n,
    min: known[0] ?? null,
    max: known[n - 1] ?? null,
    median,
  };
}

const BASE = "p.is_current=1 AND p.review_status='reviewed'";
const DISTINCT_MATCH = "SELECT * FROM candidates WHERE applicant_row=1";
export async function searchCohort(
  db: D1Database,
  input: unknown,
): Promise<CohortResult> {
  const filters = validateCohortFilters(input);
  const clauses = [BASE];
  const args: (string | number)[] = [];
  function parameter(value: string | number) {
    args.push(value);
    return `?${args.length}`;
  }
  for (const [key, column, operator] of [
    ["gpaMin", "gpa", ">="],
    ["gpaMax", "gpa", "<="],
    ["mcatMin", "mcat", ">="],
    ["mcatMax", "mcat", "<="],
  ] as const) {
    if (filters[key] !== undefined)
      clauses.push(`p.${column}${operator}${parameter(filters[key])}`);
  }
  for (const [list, column] of [
    [filters.cycles, "p.cycle"],
    [filters.sources, "a.source"],
  ] as const) {
    if (list) clauses.push(`${column} IN (${list.map(parameter).join(",")})`);
  }
  const literalLike = (s: string) =>
    `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (filters.outcomes || filters.school) {
    const outcomeClauses = [
      "o.profile_id=p.id",
      "o.cycle=p.cycle",
      "o.conditional=0",
    ];
    if (filters.outcomes)
      outcomeClauses.push(
        `o.status IN (${filters.outcomes.map(parameter).join(",")})`,
      );
    if (filters.school)
      outcomeClauses.push(
        `o.school LIKE ${parameter(literalLike(filters.school))} ESCAPE '\\'`,
      );
    // A requested school and decision must describe the same event. An
    // acceptance elsewhere never satisfies a rejection at this school.
    clauses.push(
      `EXISTS (SELECT 1 FROM corpus_outcomes o WHERE ${outcomeClauses.join(" AND ")})`,
    );
  }
  if (filters.activity)
    clauses.push(
      `p.activities_json LIKE ${parameter(literalLike(filters.activity))} ESCAPE '\\'`,
    );
  const cte = `WITH candidates AS (SELECT p.*,a.source,ROW_NUMBER() OVER(PARTITION BY p.account_id ORDER BY p.cycle DESC,p.observed_at DESC,p.id) AS applicant_row FROM corpus_profiles p JOIN corpus_accounts a ON a.id=p.account_id WHERE ${clauses.join(" AND ")}), matched AS (${DISTINCT_MATCH})`;
  const bind = (sql: string) => db.prepare(`${cte} ${sql}`).bind(...args);
  const [totalRow, countRow, profileRows, summaryRows, sourceRows, cycleRows] =
    await Promise.all([
      db
        .prepare(
          `SELECT COUNT(DISTINCT account_id) AS n FROM corpus_profiles p WHERE ${BASE}`,
        )
        .first<{ n: number }>(),
      bind(
        "SELECT COUNT(*) AS n, SUM(CASE WHEN EXISTS(SELECT 1 FROM corpus_outcomes o WHERE o.profile_id=matched.id AND o.cycle=matched.cycle AND o.conditional=0 AND o.status IN ('accepted','rejected')) THEN 1 ELSE 0 END) AS outcome_n FROM matched",
      ).first<{ n: number; outcome_n: number | null }>(),
      bind(
        `SELECT profile_json FROM matched ORDER BY cycle DESC,id LIMIT ${filters.limit}`,
      ).all<{ profile_json: string }>(),
      bind(
        "SELECT gpa,mcat,activities_json,timing_status FROM matched ORDER BY cycle DESC,id LIMIT 1000",
      ).all<{
        gpa: number | null;
        mcat: number | null;
        activities_json: string;
        timing_status: string;
      }>(),
      bind(
        "SELECT source AS value,COUNT(*) AS count FROM matched GROUP BY source ORDER BY source",
      ).all<{ value: string; count: number }>(),
      bind(
        "SELECT cycle AS value,COUNT(*) AS count FROM matched GROUP BY cycle ORDER BY cycle DESC",
      ).all<{ value: string; count: number }>(),
    ]);
  const profiles = profileRows.results.map(
    (row) => JSON.parse(row.profile_json) as CorpusProfile,
  );
  const summaries = summaryRows.results;
  function hours(category: string) {
    return numericSummary(
      summaries.map((row) => {
        if (row.timing_status === "retrospective_mixed") return null;
        const activity = (
          JSON.parse(row.activities_json) as CorpusActivity[]
        ).find((a) => a.category === category);
        if (
          !activity ||
          !["reported", "explicit_absence"].includes(
            activity.hours.precision,
          ) ||
          activity.timing === "after_submission" ||
          activity.timing === "projected"
        )
          return null;
        return activity.hours.min === activity.hours.max
          ? activity.hours.min
          : null;
      }),
    );
  }
  return {
    counts: {
      total: totalRow?.n ?? 0,
      matched: countRow?.n ?? 0,
      examined: profiles.length,
      withReportedOutcomes: countRow?.outcome_n ?? 0,
      summarized: summaries.length,
    },
    filters,
    profiles,
    coverage: { sources: sourceRows.results, cycles: cycleRows.results },
    statistics: {
      gpa: numericSummary(summaries.map((r) => r.gpa)),
      mcat: numericSummary(summaries.map((r) => r.mcat)),
      clinicalHours: hours("clinical"),
      researchHours: hours("research"),
      nonclinicalHours: hours("nonclinical"),
    },
    limitations: [
      "Counts identify distinct public source accounts, not verified distinct people across sites.",
      "Matching is deterministic; the model receives only the examined profile sample, ordered by cycle then ID.",
      `Numerical summaries use ${summaries.length} matching accounts (maximum 1,000), separate from the ${profiles.length} retrieved profiles.`,
      "Hours exclude ranges, estimates, unreported values, projections, and profiles with mixed timing; zero is included only when explicitly reported.",
      "Self-selected reports are not representative. A reported outcome does not establish a fully observed final cycle or an admissions probability.",
    ],
  };
}

export async function inspectProfile(
  db: D1Database,
  id: string,
): Promise<CorpusProfile | null> {
  if (typeof id !== "string" || id.length > 160 || !/^[a-z0-9_-]+$/.test(id))
    throw new Error("Invalid profile identifier.");
  const row = await db
    .prepare(
      `SELECT profile_json FROM corpus_profiles p WHERE id=?1 AND ${BASE}`,
    )
    .bind(id)
    .first<{ profile_json: string }>();
  return row ? (JSON.parse(row.profile_json) as CorpusProfile) : null;
}

export async function getCorpusStats(db: D1Database) {
  const [total, sources, cycles, lastImport] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(DISTINCT account_id) AS n,MAX(json_extract(profile_json,'$.reviewedAt')) AS reviewed_at FROM corpus_profiles p WHERE ${BASE}`,
      )
      .first<{ n: number; reviewed_at: string | null }>(),
    db
      .prepare(
        `SELECT a.source,COUNT(DISTINCT p.account_id) AS profiles FROM corpus_profiles p JOIN corpus_accounts a ON a.id=p.account_id WHERE ${BASE} GROUP BY a.source ORDER BY a.source`,
      )
      .all<{ source: CorpusSource; profiles: number }>(),
    db
      .prepare(
        `SELECT p.cycle,COUNT(DISTINCT p.account_id) AS profiles FROM corpus_profiles p WHERE ${BASE} GROUP BY p.cycle ORDER BY p.cycle DESC`,
      )
      .all<{ cycle: string; profiles: number }>(),
    db
      .prepare(
        "SELECT release FROM corpus_imports ORDER BY imported_at DESC LIMIT 1",
      )
      .first<{ release: string }>(),
  ]);
  return {
    totalProfiles: total?.n ?? 0,
    sourceCoverage: sources.results,
    cycles: cycles.results,
    reviewedAt: total?.reviewed_at ?? null,
    release: lastImport?.release ?? null,
    limitations: [
      "Profiles are distinct public source accounts; cross-site identity is not inferred.",
      "Self-selected reports do not represent all applicants or provide admissions probabilities.",
      "An explicit acceptance or rejection does not establish a complete final cycle.",
      "Range, approximate, missing, and later-cycle activity hours are kept distinct.",
    ],
  };
}
