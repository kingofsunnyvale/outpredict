import type { CorpusCoverageStats } from "./product-types";

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
export const MEDICAL_PROGRAMS = [
  "MD",
  "DO",
  "MD-PhD",
  "MD_PhD",
  "unknown",
  "unspecified_medical",
] as const;
export function isMedicalProgram(program: string): boolean {
  return (MEDICAL_PROGRAMS as readonly string[]).includes(program);
}
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
  evidenceTier?: "reviewed_outcome_report" | "reviewed_profile";
  reviewMethod?: string;
  missingFields?: string[];
  unavailableNumericFields?: string[];
  academicMeasurements?: Partial<
    Record<"gpa" | "scienceGpa" | "mcat", Measurement>
  >;
  evidenceSpans?: {
    field: string;
    postId: string;
    sourceUrl: string;
    sourceArtifactSha256: string;
    start: number;
    end: number;
    quote: string;
  }[];
  sourceSnapshotAt?: string | null;
  humanReviewed?: boolean;
  categoryHourTotals?: Record<
    string,
    {
      hours: Measurement;
      eligibility: "reviewed_complete_nonoverlapping";
      timing: "application_cycle" | "source_snapshot";
    }
  >;
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
    withAnyReportedOutcomes: number;
    withoutReportedOutcomes: number;
    withKnownCycle: number;
    withReportedGpa: number;
    withReportedMcat: number;
    withUsableGpa: number;
    withUsableMcat: number;
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
      if (list.some((cycle) => cycle !== "unknown" && !isKnownCycle(cycle)))
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
const SNAPSHOT_ORDER =
  "CASE WHEN p.cycle='unknown' THEN 1 ELSE 0 END,p.cycle DESC,p.observed_at DESC,p.id";
const MATCH_ORDER = "CASE WHEN cycle='unknown' THEN 1 ELSE 0 END,cycle DESC,id";
const MEDICAL_PROGRAM_SQL = `o.program IN (${MEDICAL_PROGRAMS.map((program) => `'${program}'`).join(",")})`;
const ACTUAL_AR = `o.conditional=0 AND o.status IN ('accepted','rejected') AND ${MEDICAL_PROGRAM_SQL}`;
const KNOWN_CYCLE = "cycle<>'unknown' AND cycle GLOB '20[0-9][0-9]-[0-9][0-9]'";

function usableAcademic(key: "gpa" | "scienceGpa" | "mcat", prefix = "") {
  const column = key === "scienceGpa" ? "science_gpa" : key;
  return `${prefix}${column} IS NOT NULL AND COALESCE(json_extract(${prefix}profile_json,'$.academicMeasurements.${key}.precision'),'reported')='reported'`;
}
function reportedAcademic(key: "gpa" | "scienceGpa" | "mcat", prefix = "") {
  const column = key === "scienceGpa" ? "science_gpa" : key;
  return `(${prefix}${column} IS NOT NULL OR (json_extract(${prefix}profile_json,'$.academicMeasurements.${key}.precision') IN ('reported','approximate','range','lower_bound','upper_bound') AND (json_extract(${prefix}profile_json,'$.academicMeasurements.${key}.min') IS NOT NULL OR json_extract(${prefix}profile_json,'$.academicMeasurements.${key}.max') IS NOT NULL)))`;
}
export function exactAcademic(
  profile: CorpusProfile,
  key: "gpa" | "scienceGpa" | "mcat",
): number | null {
  const measurement = profile.academicMeasurements?.[key];
  return measurement && measurement.precision !== "reported"
    ? null
    : profile[key];
}

export function isKnownCycle(cycle: string): boolean {
  return (
    /^20\d{2}-\d{2}$/.test(cycle) &&
    Number(cycle.slice(5)) === (Number(cycle.slice(0, 4)) + 1) % 100
  );
}

function categoryHours(
  row: {
    activities_json: string;
    timing_status: string;
    evidence_tier: string | null;
    category_totals_json: string | null;
  },
  category: string,
): number | null {
  if (!["cycle_report", "source_snapshot"].includes(row.timing_status))
    return null;
  if (row.evidence_tier) {
    const totals = JSON.parse(
      row.category_totals_json ?? "{}",
    ) as CorpusProfile["categoryHourTotals"];
    const total = totals?.[category];
    if (
      total?.eligibility !== "reviewed_complete_nonoverlapping" ||
      (row.timing_status === "cycle_report"
        ? total.timing !== "application_cycle"
        : total.timing !== "source_snapshot")
    )
      return null;
    const h = total.hours;
    return ["reported", "explicit_absence"].includes(h.precision) &&
      h.min !== null &&
      h.min === h.max
      ? h.min
      : null;
  }
  // Legacy reviewed records contain category aggregates. Do not choose the first
  // row if a later release accidentally supplies separate roles without v2 metadata.
  const activities = (
    JSON.parse(row.activities_json) as CorpusActivity[]
  ).filter((a) => a.category === category);
  const activity = activities[0];
  if (
    activities.length !== 1 ||
    !activity ||
    activity.timing !== "cycle_report" ||
    !["reported", "explicit_absence"].includes(activity.hours.precision)
  )
    return null;
  return activity.hours.min === activity.hours.max ? activity.hours.min : null;
}
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
    if (filters[key] !== undefined) {
      clauses.push(`p.${column}${operator}${parameter(filters[key])}`);
      clauses.push(usableAcademic(column, "p."));
    }
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
      MEDICAL_PROGRAM_SQL,
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
  const cte = `WITH candidates AS (SELECT p.*,a.source,ROW_NUMBER() OVER(PARTITION BY p.account_id ORDER BY ${SNAPSHOT_ORDER}) AS applicant_row FROM corpus_profiles p JOIN corpus_accounts a ON a.id=p.account_id WHERE ${clauses.join(" AND ")}), matched AS (${DISTINCT_MATCH})`;
  const bind = (sql: string) => db.prepare(`${cte} ${sql}`).bind(...args);
  const [totalRow, countRow, profileRows, summaryRows, sourceRows, cycleRows] =
    await Promise.all([
      db
        .prepare(
          `SELECT COUNT(DISTINCT account_id) AS n FROM corpus_profiles p WHERE ${BASE}`,
        )
        .first<{ n: number }>(),
      bind(
        `SELECT COUNT(*) AS n,
          SUM(CASE WHEN ${KNOWN_CYCLE} AND EXISTS(SELECT 1 FROM corpus_outcomes o WHERE o.profile_id=matched.id AND o.cycle=matched.cycle AND ${ACTUAL_AR}) THEN 1 ELSE 0 END) AS outcome_n,
          SUM(CASE WHEN EXISTS(SELECT 1 FROM corpus_outcomes o WHERE o.profile_id=matched.id AND ${ACTUAL_AR}) THEN 1 ELSE 0 END) AS any_outcome_n,
          SUM(CASE WHEN ${KNOWN_CYCLE} THEN 1 ELSE 0 END) AS known_cycle_n,
          SUM(CASE WHEN ${reportedAcademic("gpa")} THEN 1 ELSE 0 END) AS gpa_n,
          SUM(CASE WHEN ${reportedAcademic("mcat")} THEN 1 ELSE 0 END) AS mcat_n,
          SUM(CASE WHEN ${usableAcademic("gpa")} THEN 1 ELSE 0 END) AS usable_gpa_n,
          SUM(CASE WHEN ${usableAcademic("mcat")} THEN 1 ELSE 0 END) AS usable_mcat_n FROM matched`,
      ).first<{
        n: number;
        outcome_n: number | null;
        any_outcome_n: number | null;
        known_cycle_n: number | null;
        gpa_n: number;
        mcat_n: number;
        usable_gpa_n: number | null;
        usable_mcat_n: number | null;
      }>(),
      bind(
        `SELECT profile_json FROM matched ORDER BY ${MATCH_ORDER} LIMIT ${filters.limit}`,
      ).all<{ profile_json: string }>(),
      bind(
        `SELECT CASE WHEN ${usableAcademic("gpa")} THEN gpa ELSE NULL END AS gpa,CASE WHEN ${usableAcademic("mcat")} THEN mcat ELSE NULL END AS mcat,activities_json,timing_status,json_extract(profile_json,'$.evidenceTier') AS evidence_tier,json_extract(profile_json,'$.categoryHourTotals') AS category_totals_json FROM matched ORDER BY ${MATCH_ORDER} LIMIT 1000`,
      ).all<{
        gpa: number | null;
        mcat: number | null;
        activities_json: string;
        timing_status: string;
        evidence_tier: string | null;
        category_totals_json: string | null;
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
    return numericSummary(summaries.map((row) => categoryHours(row, category)));
  }
  return {
    counts: {
      total: totalRow?.n ?? 0,
      matched: countRow?.n ?? 0,
      examined: profiles.length,
      withReportedOutcomes: countRow?.outcome_n ?? 0,
      withAnyReportedOutcomes: countRow?.any_outcome_n ?? 0,
      withoutReportedOutcomes:
        (countRow?.n ?? 0) - (countRow?.any_outcome_n ?? 0),
      withKnownCycle: countRow?.known_cycle_n ?? 0,
      withReportedGpa: countRow?.gpa_n ?? 0,
      withReportedMcat: countRow?.mcat_n ?? 0,
      withUsableGpa: countRow?.usable_gpa_n ?? 0,
      withUsableMcat: countRow?.usable_mcat_n ?? 0,
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
      "Hours exclude ranges, estimates, unreported values, projections, mixed/unknown timing, and unestablished or overlapping category totals; zero is included only when explicitly reported.",
      "Academic filters and numerical summaries use exact supported scalar values only. Reported approximations, bounds and ranges remain visible but are excluded from exact numerical comparisons; they are not wholly unreported.",
      "Known-cycle outcome counts require actual unconditional acceptance/rejection in the selected known cycle. Any-outcome counts also include reports whose cycle is unknown; no reported acceptance/rejection does not mean none occurred.",
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

export async function getCorpusStats(
  db: D1Database,
): Promise<CorpusCoverageStats> {
  const cte = `WITH candidates AS (SELECT p.*,a.source,ROW_NUMBER() OVER(PARTITION BY p.account_id ORDER BY ${SNAPSHOT_ORDER}) AS applicant_row FROM corpus_profiles p JOIN corpus_accounts a ON a.id=p.account_id WHERE ${BASE}), matched AS (${DISTINCT_MATCH})`;
  const query = (sql: string) => db.prepare(`${cte} ${sql}`);
  const [totals, sources, cycles, tiers, methods, lastImport] =
    await Promise.all([
      query(`SELECT COUNT(*) AS total,MAX(json_extract(profile_json,'$.reviewedAt')) AS reviewed_at,
      SUM(CASE WHEN ${reportedAcademic("gpa")} THEN 1 ELSE 0 END) AS gpa_n,
      SUM(CASE WHEN ${reportedAcademic("scienceGpa")} THEN 1 ELSE 0 END) AS science_gpa_n,
      SUM(CASE WHEN ${reportedAcademic("mcat")} THEN 1 ELSE 0 END) AS mcat_n,
      SUM(CASE WHEN ${usableAcademic("gpa")} THEN 1 ELSE 0 END) AS usable_gpa_n,
      SUM(CASE WHEN ${usableAcademic("scienceGpa")} THEN 1 ELSE 0 END) AS usable_science_gpa_n,
      SUM(CASE WHEN ${usableAcademic("mcat")} THEN 1 ELSE 0 END) AS usable_mcat_n,
      SUM(CASE WHEN ${KNOWN_CYCLE} THEN 1 ELSE 0 END) AS cycle_n,
      SUM(CASE WHEN json_array_length(activities_json)>0 THEN 1 ELSE 0 END) AS activities_n,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM corpus_outcomes o WHERE o.profile_id=matched.id AND ${ACTUAL_AR}) THEN 1 ELSE 0 END) AS outcome_n,
      SUM(CASE WHEN ${KNOWN_CYCLE} AND EXISTS(SELECT 1 FROM corpus_outcomes o WHERE o.profile_id=matched.id AND o.cycle=matched.cycle AND ${ACTUAL_AR}) THEN 1 ELSE 0 END) AS aligned_n,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(profile_json,'$.categoryHourTotals'),'{}')) t WHERE json_extract(t.value,'$.eligibility')='reviewed_complete_nonoverlapping' AND json_extract(t.value,'$.timing')='application_cycle') AND timing_status='cycle_report' THEN 1 ELSE 0 END) AS application_hours_n
      FROM matched`).first<{
        total: number;
        reviewed_at: string | null;
        gpa_n: number;
        science_gpa_n: number;
        mcat_n: number;
        cycle_n: number | null;
        activities_n: number | null;
        outcome_n: number | null;
        aligned_n: number | null;
        application_hours_n: number | null;
        usable_gpa_n: number | null;
        usable_science_gpa_n: number | null;
        usable_mcat_n: number | null;
      }>(),
      query(
        "SELECT source,COUNT(*) AS profiles FROM matched GROUP BY source ORDER BY source",
      ).all<{ source: string; profiles: number }>(),
      query(
        `SELECT cycle,COUNT(*) AS profiles FROM matched GROUP BY cycle ORDER BY CASE WHEN cycle='unknown' THEN 1 ELSE 0 END,cycle DESC`,
      ).all<{ cycle: string; profiles: number }>(),
      query(
        "SELECT COALESCE(json_extract(profile_json,'$.evidenceTier'),'legacy_reviewed_outcome_report') AS tier,COUNT(*) AS profiles FROM matched GROUP BY tier ORDER BY tier",
      ).all<{ tier: string; profiles: number }>(),
      query(
        "SELECT COALESCE(json_extract(profile_json,'$.reviewMethod'),'legacy_single_reviewer') AS method,COUNT(*) AS profiles FROM matched GROUP BY method ORDER BY method",
      ).all<{ method: string; profiles: number }>(),
      db
        .prepare(
          `SELECT COALESCE(
            (SELECT release FROM corpus_active_release WHERE id=1),
            (SELECT i.release FROM corpus_imports i
             WHERE NOT EXISTS(SELECT 1 FROM corpus_collection_runs r WHERE r.release=i.release)
             ORDER BY i.imported_at DESC LIMIT 1)
          ) AS release`,
        )
        .first<{ release: string | null }>(),
    ]);
  const total = totals?.total ?? 0;
  const any = totals?.outcome_n ?? 0;
  return {
    totalProfiles: total,
    sourceCoverage: sources.results,
    cycles: cycles.results,
    reviewedAt: totals?.reviewed_at ?? null,
    release: lastImport?.release ?? null,
    knownOutcomeProfiles: any,
    alignedOutcomeProfiles: totals?.aligned_n ?? 0,
    profileOnlyCount: total - any,
    missingness: {
      gpa: total - (totals?.gpa_n ?? 0),
      scienceGpa: total - (totals?.science_gpa_n ?? 0),
      mcat: total - (totals?.mcat_n ?? 0),
      cycle: total - (totals?.cycle_n ?? 0),
      activities: total - (totals?.activities_n ?? 0),
      acceptanceOrRejection: total - any,
      // Even legacy cycle reports do not prove exact primary-submission timing.
      applicationTimeActivityHours: total - (totals?.application_hours_n ?? 0),
    },
    numericEligibility: {
      gpa: totals?.usable_gpa_n ?? 0,
      scienceGpa: totals?.usable_science_gpa_n ?? 0,
      mcat: totals?.usable_mcat_n ?? 0,
    },
    evidenceTierCoverage: tiers.results,
    reviewMethodCoverage: methods.results,
    limitations: [
      "Counts identify distinct public source accounts; cross-site identity is not inferred. One selected snapshot per account is counted, with known cycles before unknown cycles.",
      "Self-selected reports do not represent all applicants or provide admissions probabilities.",
      "A reported acceptance or rejection does not establish a complete final cycle; missing outcomes do not establish that no acceptance occurred.",
      "Source-date hours are not automatically hours at application. Ranges, estimates, missing values, projections, overlap and unestablished timing remain distinct.",
      "Review methods describe source-supported extraction, not verified application files or uniformly human-reviewed records.",
    ],
  };
}
