import { createAuthClient } from "better-auth/react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  Attachment,
  Chat,
  Evidence,
  Message,
  Source,
  VerifiedUser,
} from "../src/product-types";
import "./product.css";

const auth = createAuthClient();
const DRAFT_KEY = "outpredict-draft";
type Setup = { googleSignIn: boolean; environment: string };
type Conversation = {
  chat: Chat;
  messages: Message[];
  attachments: Attachment[];
};
type Upload = Omit<Attachment, "status"> & {
  status: Attachment["status"] | "uploading";
};
type Corpus = {
  totalProfiles: number;
  sourceCoverage: { source: string; profiles: number }[];
  cycles: { cycle: string; profiles: number }[];
  reviewedAt: string | null;
  release: string | null;
  limitations: string[];
};
type Progress = { id: string; stage: string; title: string; detail?: string };
type Panel = { evidence: Evidence; sourceId?: string };
type ProfileDetail = {
  publicHandle: string;
  cycle: string;
  gpa: number | null;
  scienceGpa: number | null;
  mcat: number | null;
  residence: string | null;
  summary: string;
  notes: string[];
  reviewStatus: string;
  timingStatus: string;
  extractionConfidence: string;
  activities: {
    category: string;
    description: string;
    timing: string;
    confidence: string;
    hours: { min: number | null; max: number | null; precision: string };
  }[];
  outcomes: {
    status: string;
    school: string | null;
    program: string;
    cycle: string;
    reportedCount: number | null;
    countKind: string;
    evidence: string;
    conditional?: boolean;
  }[];
};
type IconName =
  | "new"
  | "search"
  | "file"
  | "menu"
  | "panel"
  | "arrow"
  | "stop"
  | "trash"
  | "close"
  | "logout"
  | "check"
  | "alert"
  | "book"
  | "spark"
  | "copy"
  | "download"
  | "external"
  | "info"
  | "clip"
  | "chevron"
  | "clock"
  | "graduate";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    new: (
      <>
        <path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7" />
        <path d="m17 3 4 4-10 10-5 1 1-5Z" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    file: (
      <>
        <path d="M14 3H5v18h14V8Z" />
        <path d="M14 3v5h5M8 12h8M8 16h6" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M15 4v16" />
      </>
    ),
    arrow: <path d="M12 20V4m-6 6 6-6 6 6" />,
    stop: (
      <rect
        x="6"
        y="6"
        width="12"
        height="12"
        rx="2"
        fill="currentColor"
        stroke="none"
      />
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    logout: (
      <>
        <path d="M10 4H4v16h6M10 12h11m-4-4 4 4-4 4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    alert: (
      <>
        <path d="m12 3 10 18H2Z" />
        <path d="M12 9v5m0 3v.2" />
      </>
    ),
    book: (
      <>
        <path d="M4 3h14a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2Z" />
        <path d="M4 17h16M8 7h8M8 11h7" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M15 8V3H3v13h5" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v.2" />
      </>
    ),
    clip: <path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2" />,
    chevron: <path d="m8 4 8 8-8 8" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </>
    ),
    graduate: (
      <>
        <path d="m2 8 10-5 10 5-10 5ZM6 10v7c4 3 8 3 12 0v-7M22 8v8" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

class RequestError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "request_failed",
  ) {
    super(message);
  }
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new RequestError(
      "The server returned an unreadable response. Please try again.",
      response.status,
    );
  }
  if (!response.ok) {
    const error =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : "This request failed. Please try again.";
    const code =
      data &&
      typeof data === "object" &&
      "code" in data &&
      typeof data.code === "string"
        ? data.code
        : "request_failed";
    throw new RequestError(error, response.status, code);
  }
  return data as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
function currentChat() {
  return new URLSearchParams(window.location.search).get("chat");
}
function storedDraft() {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveDraft(value: string) {
  try {
    sessionStorage.setItem(DRAFT_KEY, value);
  } catch {
    /* Browsers may disable session storage. */
  }
}
function number(value: number) {
  return value.toLocaleString();
}
function resizeTextarea(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  const styles = window.getComputedStyle(input);
  const minimum = Number.parseFloat(styles.minHeight) || 0;
  const maximum = Number.parseFloat(styles.maxHeight) || 180;
  const contentHeight = input.scrollHeight;
  input.style.height = `${Math.max(minimum, Math.min(maximum, contentHeight))}px`;
  input.style.overflowY = contentHeight > maximum ? "auto" : "hidden";
}
function friendly(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase())
    .replace(/Gpa/i, "GPA")
    .replace(/Mcat/i, "MCAT");
}
function safeLink(value?: string) {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function useNarrow() {
  const [narrow, setNarrow] = useState(
    window.matchMedia("(max-width: 1000px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1000px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

function Modal({
  title,
  children,
  close,
  className = "",
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className={`op-modal ${className}`}
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="op-modal-header">
        <h2>{title}</h2>
        <button
          type="button"
          className="op-icon-button"
          onClick={close}
          aria-label={`Close ${title}`}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="op-modal-body">{children}</div>
    </dialog>
  );
}

function CalculationReceipt({ excerpt }: { excerpt: string }) {
  let receipt: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(excerpt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      receipt = parsed as Record<string, unknown>;
  } catch {
    // Older saved summaries may have been truncated; keep their details visible.
  }
  return (
    <div className="op-calculation-receipt">
      {typeof receipt?.verifiedStatement === "string" ? (
        <p className="op-source-excerpt">{receipt.verifiedStatement}</p>
      ) : typeof receipt?.result === "number" ? (
        <p className="op-source-excerpt">
          Calculated result: {number(receipt.result)}
        </p>
      ) : (
        <p className="op-source-excerpt">
          Saved calculation details are available below.
        </p>
      )}
      {typeof receipt?.calendarLimit === "string" && (
        <p className="op-fine-print">{receipt.calendarLimit}</p>
      )}
      <details>
        <summary>Inspect calculation data</summary>
        <pre>{receipt ? JSON.stringify(receipt, null, 2) : excerpt}</pre>
      </details>
    </div>
  );
}

function SourceCard({
  source,
  selected,
}: {
  source: Source;
  selected: boolean;
}) {
  const url = safeLink(source.url);
  const ref = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  async function inspect() {
    setExpanded(!expanded);
    if (!expanded && !profile && source.profileId) {
      setFailure(null);
      try {
        const result = await requestJson<{ profile: ProfileDetail }>(
          `/api/corpus/profiles/${encodeURIComponent(source.profileId)}`,
        );
        setProfile(result.profile);
      } catch (error) {
        setFailure(errorMessage(error));
      }
    }
  }
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "nearest",
      });
  }, [selected]);
  return (
    <article
      ref={ref}
      className={`op-source-card ${selected ? "is-selected" : ""}`}
    >
      <div className="op-source-top">
        <span className="op-source-id">{source.id}</span>
        <span>
          {source.kind === "profile"
            ? "Reported applicant profile"
            : source.kind === "web" || source.kind === "official"
              ? "Saved website source"
              : friendly(source.kind)}
        </span>
      </div>
      <h3>{source.title}</h3>
      {source.excerpt &&
        (source.kind === "calculation" ? (
          <CalculationReceipt excerpt={source.excerpt} />
        ) : (
          <p className="op-source-excerpt">{source.excerpt}</p>
        ))}
      {source.observedAt && (
        <p className="op-source-date">Observed {source.observedAt}</p>
      )}
      {url && (
        <a
          className="op-source-link"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          View original <Icon name="external" size={13} />
        </a>
      )}
      {source.kind === "attachment" && (
        <span className="op-source-date">Private material you supplied</span>
      )}
      {(source.kind === "web" || source.kind === "official") && (
        <span className="op-source-date">
          Saved with an earlier answer. New answers use the applicant corpus and
          your own inputs.
        </span>
      )}
      {source.profileId && (
        <button
          type="button"
          className="op-inspect-profile"
          aria-expanded={expanded}
          onClick={() => void inspect()}
        >
          {expanded ? "Hide profile details" : "Inspect reported profile"}
          <Icon name="chevron" size={12} />
        </button>
      )}
      {expanded && (
        <div className="op-profile-detail">
          {failure ? (
            <p role="alert">{failure}</p>
          ) : !profile ? (
            <p role="status">Loading reported profile…</p>
          ) : (
            <>
              <p className="op-profile-cycle">
                {profile.cycle} cycle · {profile.publicHandle}
              </p>
              <dl className="op-profile-academics">
                {[
                  ["GPA", profile.gpa],
                  ["Science GPA", profile.scienceGpa],
                  ["MCAT", profile.mcat],
                  ["Residence", profile.residence],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value ?? "Unreported"}</dd>
                  </div>
                ))}
              </dl>
              <h4>Reported activities</h4>
              {profile.activities.map((activity) => (
                <div
                  className="op-profile-activity"
                  key={`${activity.category}-${activity.description}`}
                >
                  <strong>{friendly(activity.category)}</strong>
                  <span>
                    {activity.category !== "publications" && (
                      <>
                        {activity.hours.min === null
                          ? "Hours unreported"
                          : activity.hours.min === activity.hours.max
                            ? `${activity.hours.min} hours`
                            : activity.hours.max === null
                              ? `At least ${activity.hours.min} hours`
                              : `${activity.hours.min}–${activity.hours.max} hours`}
                        {activity.hours.min !== null &&
                          ` · ${friendly(activity.hours.precision)}`}{" "}
                        ·{" "}
                      </>
                    )}
                    {friendly(activity.timing)}
                  </span>
                  <p>{activity.description}</p>
                </div>
              ))}
              <h4>Reported outcomes</h4>
              {profile.outcomes.map((outcome) => (
                <div
                  className="op-profile-outcome"
                  key={`${outcome.status}-${outcome.school}-${outcome.evidence}`}
                >
                  <strong>
                    {friendly(outcome.status)}
                    {outcome.conditional ? " (conditional)" : ""}
                  </strong>
                  <span>
                    {outcome.school ??
                      (outcome.reportedCount !== null
                        ? `${outcome.reportedCount} ${outcome.countKind.replace(/_/g, " ")}`
                        : "School not reported")}{" "}
                    ·{" "}
                    {outcome.program === "unknown"
                      ? "Program unreported"
                      : outcome.program}{" "}
                    · {outcome.cycle}
                  </span>
                  <p>{outcome.evidence}</p>
                </div>
              ))}
              <p className="op-fine-print">
                Review: {friendly(profile.reviewStatus)}. Extraction confidence:{" "}
                {friendly(profile.extractionConfidence)}. Timing:{" "}
                {friendly(profile.timingStatus)}. Reported outcomes may not
                cover the final cycle.
              </p>
              {profile.notes.map((note) => (
                <p className="op-fine-print" key={note}>
                  {note}
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function Statistics({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="op-statistics">
      {Object.entries(data).map(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return null;
        const metric = value as Record<string, unknown>;
        return (
          <div className="op-statistic" key={key}>
            <strong>{friendly(key)}</strong>
            <span>
              Median{" "}
              {typeof metric.median === "number"
                ? metric.median.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })
                : "not available"}
            </span>
            <small>
              {typeof metric.n === "number" ? `${metric.n} included` : ""}
              {typeof metric.missing === "number"
                ? ` · ${metric.missing} excluded from numeric summary`
                : ""}
            </small>
            {typeof metric.min === "number" &&
              typeof metric.max === "number" && (
                <small>
                  Range {metric.min}–{metric.max}
                </small>
              )}
          </div>
        );
      })}
    </div>
  );
}

function EvidenceContent({ panel }: { panel: Panel }) {
  const { evidence, sourceId } = panel;
  const cohort = evidence.cohort;
  return (
    <div className="op-evidence-content">
      {cohort && (
        <section className="op-cohort">
          <h3>Profiles behind this answer</h3>
          <dl className="op-counts">
            {[
              ["Available in the corpus", cohort.totalProfiles],
              ["Matched your filters", cohort.matchedProfiles],
              ["Retrieved for this question", cohort.examinedProfiles],
              ["Supporting this answer", cohort.supportingProfiles],
              ["Matched with reported outcomes", cohort.profilesWithOutcomes],
            ].map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{typeof count === "number" ? number(count) : count}</dd>
              </div>
            ))}
          </dl>
          <p className="op-fine-print">
            Counts refer to distinct source accounts. Matching a filter does not
            mean the model reviewed every matching profile.
          </p>
          <details open>
            <summary>Filters & coverage</summary>
            <dl className="op-filters">
              {Object.entries(cohort.filters)
                .filter(([, value]) => value !== null)
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{friendly(key)}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
            {Object.keys(cohort.filters).length === 0 && (
              <p>No restrictive cohort filters were applied.</p>
            )}
            {cohort.coverage && (
              <p className="op-fine-print">
                {cohort.coverage.sources.join(", ")}
                <br />
                Cycles: {cohort.coverage.cycles.join(", ")}
              </p>
            )}
          </details>
          {cohort.statistics && (
            <details>
              <summary>Computed comparisons</summary>
              <Statistics data={cohort.statistics} />
            </details>
          )}
          {!!cohort.limitations.length && (
            <details>
              <summary>Missing information & limits</summary>
              <ul>
                {cohort.limitations.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {!!evidence.notes?.length && (
        <div className="op-evidence-notes">
          {evidence.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
      <section>
        <div className="op-section-label">
          Sources <span>{evidence.sources.length}</span>
        </div>
        {evidence.sources.length ? (
          evidence.sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              selected={source.id === sourceId}
            />
          ))
        ) : (
          <p className="op-muted">
            No saved evidence was attached to this answer.
          </p>
        )}
      </section>
    </div>
  );
}

function Answer({
  message,
  showEvidence,
}: {
  message: Message;
  showEvidence: (evidence: Evidence, sourceId?: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const evidence = message.evidence;
  const ids = new Set(evidence?.sources.map((source) => source.id) ?? []);
  const content = message.content.replace(
    /\[([A-Za-z][A-Za-z0-9_-]{0,30}(?:\s*,\s*[A-Za-z][A-Za-z0-9_-]{0,30})*)\](?!\()/g,
    (match, group: string) => {
      const citations = group.split(",").map((id) => id.trim());
      return citations.every((id) => ids.has(id))
        ? citations.map((id) => `[${id}](#source-${id})`).join(" ")
        : match;
    },
  );
  return (
    <>
      {message.content && (
        <div className="op-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) =>
                href?.startsWith("#source-") && evidence ? (
                  <button
                    className="op-citation"
                    type="button"
                    onClick={() => showEvidence(evidence, href.slice(8))}
                  >
                    {children}
                  </button>
                ) : safeLink(href) ? (
                  <a
                    href={safeLink(href)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                ),
              table: ({ children }) => (
                <div className="op-table-scroll">
                  <table>{children}</table>
                </div>
              ),
              img: ({ src, alt }) =>
                safeLink(src) ? (
                  <a
                    href={safeLink(src)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {alt || "View referenced image"}
                  </a>
                ) : (
                  <span>{alt}</span>
                ),
            }}
          >
            {content}
          </Markdown>
        </div>
      )}
      {message.content && (
        <div className="op-answer-actions">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(message.content)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch(() => setCopied(false));
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={13} />
            {copied ? "Copied" : "Copy"}
          </button>
          {evidence && (evidence.sources.length > 0 || evidence.cohort) && (
            <button type="button" onClick={() => showEvidence(evidence)}>
              <Icon name="book" size={13} />
              {evidence.cohort
                ? `${number(evidence.cohort.supportingProfiles)} supporting profiles`
                : `${evidence.sources.length} ${evidence.sources.length === 1 ? "source" : "sources"}`}
              <Icon name="chevron" size={11} />
            </button>
          )}
        </div>
      )}
    </>
  );
}

const prompts: {
  title: string;
  description: string;
  prompt: string;
  icon: IconName;
  color: string;
}[] = [
  {
    title: "Make a one-year plan",
    description:
      "Turn your experience and goals into clear priorities for the year ahead.",
    prompt:
      "I have one year before applying to medical school. Help me prioritize academics, clinical experience, research, and volunteering. What would you need to know about me?",
    icon: "clock",
    color: "blue",
  },
  {
    title: "Find applicants like you",
    description:
      "Explore comparable profiles, reported experiences, and school-specific outcomes.",
    prompt:
      "Help me compare my experience with similar medical-school applicants. What information would make the comparison useful?",
    icon: "search",
    color: "pink",
  },
  {
    title: "Explore schools in the corpus",
    description:
      "See which schools comparable applicants named and the outcomes they reported.",
    prompt:
      "Using the applicant corpus, help me explore schools named in comparable profiles. Keep each school's reported acceptance, rejection, interview, and waitlist separate, and explain gaps in coverage. Ask for the background needed to make a useful comparison.",
    icon: "graduate",
    color: "violet",
  },
  {
    title: "Strengthen an activity description",
    description:
      "Make your role, contribution, and reflection clearer in your own voice.",
    prompt:
      "Help me improve an AMCAS activity description while keeping my voice and reported facts. What should a strong description accomplish?",
    icon: "new",
    color: "green",
  },
  {
    title: "Compare reported outcomes",
    description:
      "Compare experiences described in profiles with explicit acceptances and rejections.",
    prompt:
      "What experiences did applicants with reported acceptances or rejections describe in the corpus? Separate school-specific outcomes, keep completed and planned hours distinct, and show how many comparable profiles support each observation.",
    icon: "book",
    color: "orange",
  },
];

async function consumeEvents(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
) {
  if (!response.body)
    throw new Error("The answer stream did not start. Please retry.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      if (pending.length > 1_000_000)
        throw new Error(
          "The answer stream was too large. Please reload the saved conversation.",
        );
      let index = pending.indexOf("\n\n");
      while (index !== -1) {
        const block = pending.slice(0, index);
        pending = pending.slice(index + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        const named = block
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        if (data) {
          const event: unknown = JSON.parse(data);
          if (event && typeof event === "object" && !Array.isArray(event)) {
            const payload = event as Record<string, unknown>;
            if (!payload.type && named) payload.type = named;
            if (payload.type === "done" || payload.type === "error")
              terminal = true;
            onEvent(payload);
          }
        }
        if (pending.length > 1_000_000)
          throw new Error(
            "The answer stream was too large. Please reload the saved conversation.",
          );
        index = pending.indexOf("\n\n");
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!terminal)
    throw new Error(
      "The connection was interrupted. Your saved progress is below; retry to finish the answer.",
    );
}

export function ProductApp() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [account, setAccount] = useState<VerifiedUser | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(currentChat);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const [draft, setDraft] = useState(storedDraft);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [error, setError] = useState<string | null>(
    new URLSearchParams(window.location.search).has("error")
      ? "Google sign-in was not completed. Your draft is still here; please try again."
      : null,
  );
  const [panel, setPanel] = useState<Panel | null>(null);
  const [modal, setModal] = useState<"corpus" | "files" | "privacy" | null>(
    null,
  );
  const [drawer, setDrawer] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [corpus, setCorpus] = useState<Corpus | null>(null);
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const reloadFileList = useRef<(() => void) | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [libraryTab, setLibraryTab] = useState<"prompts" | "tips">("prompts");
  const narrow = useNarrow();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const bindTextarea = useCallback((input: HTMLTextAreaElement | null) => {
    textarea.current = input;
    if (!input) return;
    let width = input.clientWidth;
    resizeTextarea(input);
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resizeTextarea(input);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const followScroll = useRef(true);
  const activeRef = useRef(activeId);
  const streamController = useRef<AbortController | null>(null);
  const streamGenerationId = useRef<string | null>(null);
  const conversationEpoch = useRef(0);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const uploadEpoch = useRef(0);
  const skipLoad = useRef<string | null>(null);
  const stopRequested = useRef(false);
  const autoOpenedEvidence = useRef(false);
  const authEpoch = useRef(0);
  const latest = conversation?.messages.at(-1);
  const externallyRunning =
    !streaming && latest?.role === "assistant" && latest.status === "running";
  const busy = streaming || externallyRunning;
  const uploading = uploads.some((file) => file.status === "uploading");
  const progressDetail =
    progress.at(-1)?.detail ??
    (progress.length
      ? null
      : externallyRunning
        ? "Checking saved progress. You can stop this response below."
        : "Choosing the information that will help answer it.");
  activeRef.current = activeId;
  if (!streaming)
    streamGenerationId.current =
      latest?.status === "running" ? latest.id : null;

  const refreshChats = useCallback(async () => {
    const epoch = authEpoch.current;
    const data = await requestJson<{ chats: Chat[] }>("/api/chats");
    if (authEpoch.current === epoch) setChats(data.chats);
    return data.chats;
  }, []);
  const reload = useCallback(async (id: string) => {
    const epoch = conversationEpoch.current;
    const identityEpoch = authEpoch.current;
    const result = await requestJson<Conversation>(
      `/api/chats/${encodeURIComponent(id)}`,
    );
    if (
      activeRef.current === id &&
      conversationEpoch.current === epoch &&
      authEpoch.current === identityEpoch
    )
      setConversation(result);
    return result;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function initialize() {
      try {
        const state = await requestJson<Setup>("/api/setup", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSetup(state);
        if (state.googleSignIn) {
          try {
            const result = await requestJson<{ user: VerifiedUser }>(
              "/api/me",
              { signal: controller.signal },
            );
            if (controller.signal.aborted) return;
            setAccount(result.user);
            await refreshChats();
          } catch (failure) {
            if (!(failure instanceof RequestError && failure.status === 401))
              throw failure;
          }
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setInitializing(false);
      }
    }
    void initialize();
    void requestJson<Corpus>("/api/corpus/stats", { signal: controller.signal })
      .then(setCorpus)
      .catch(() => {
        /* Corpus details can be reloaded from the panel. */
      });
    return () => {
      controller.abort();
      streamController.current?.abort();
    };
  }, [refreshChats]);

  useEffect(() => {
    const update = () => {
      const leavingId = activeRef.current;
      const generationId = streamGenerationId.current;
      stopRequested.current = true;
      if (leavingId && generationId)
        void requestJson(`/api/chats/${leavingId}/cancel`, {
          method: "POST",
          body: JSON.stringify({ generationId }),
          keepalive: true,
        }).catch(() => undefined);
      streamController.current?.abort();
      conversationEpoch.current += 1;
      uploadEpoch.current += 1;
      setStreaming(false);
      setUploads([]);
      setPanel(null);
      setProgress([]);
      setDrawer(false);
      setActiveId(currentChat());
    };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    saveDraft(draft);
  }, [draft]);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input || input.value !== draft) return;
    resizeTextarea(input);
  }, [draft]);
  useEffect(() => {
    if (!activeId || !account) {
      setConversation(null);
      return;
    }
    if (skipLoad.current === activeId) {
      skipLoad.current = null;
      return;
    }
    const controller = new AbortController();
    setLoadingChat(true);
    setConversation(null);
    setPanel(null);
    setError(null);
    followScroll.current = true;
    void requestJson<Conversation>(
      `/api/chats/${encodeURIComponent(activeId)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setConversation(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingChat(false);
      });
    return () => controller.abort();
  }, [activeId, account]);
  useEffect(() => {
    if (!externallyRunning || !activeId) return;
    const interval = setInterval(() => {
      void reload(activeId).catch((failure) => setError(errorMessage(failure)));
    }, 3000);
    return () => clearInterval(interval);
  }, [externallyRunning, activeId, reload]);
  useEffect(() => {
    if ((conversation || progress.length) && followScroll.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "instant",
      });
  }, [conversation, progress]);
  useEffect(() => {
    if (modal !== "files" || !account) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setFiles(null);
    async function load() {
      clearTimeout(timer);
      setModalError(null);
      try {
        const data = await requestJson<{ attachments: Attachment[] }>(
          "/api/attachments",
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setFiles(data.attachments);
        if (data.attachments.some((file) => file.status === "processing"))
          timer = setTimeout(() => void load(), 5000);
      } catch (failure) {
        if (!controller.signal.aborted) setModalError(errorMessage(failure));
      }
    }
    reloadFileList.current = () => void load();
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      reloadFileList.current = null;
    };
  }, [modal, account]);

  async function signIn() {
    saveDraft(draft);
    setSigningIn(true);
    setError(null);
    try {
      const result = await auth.signIn.social({
        provider: "google",
        callbackURL: `${window.location.origin}/${activeId ? `?chat=${encodeURIComponent(activeId)}` : ""}`,
        errorCallbackURL: `${window.location.origin}/?error=sign-in${activeId ? `&chat=${encodeURIComponent(activeId)}` : ""}`,
      });
      if (result.error)
        throw new Error("Google sign-in could not start. Please try again.");
    } catch (failure) {
      setError(errorMessage(failure));
      setSigningIn(false);
    }
  }

  async function stop() {
    stopRequested.current = true;
    const id = activeRef.current;
    const controller = streamController.current;
    const generationId =
      streamGenerationId.current ??
      (latest?.status === "running" && !latest.id.startsWith("draft-")
        ? latest.id
        : null);
    if (id && generationId) {
      try {
        await requestJson(`/api/chats/${id}/cancel`, {
          method: "POST",
          body: JSON.stringify({ generationId }),
        });
      } catch (failure) {
        if (
          activeRef.current === id &&
          (!streamController.current || streamController.current === controller)
        )
          setError(`Could not confirm cancellation: ${errorMessage(failure)}`);
      }
    }
    controller?.abort();
    if (streamController.current && streamController.current !== controller)
      return;
    if (id) await reload(id).catch(() => undefined);
    if (!streamController.current || streamController.current === controller)
      setStreaming(false);
  }

  async function navigate(id: string | null) {
    if (busy) await stop();
    conversationEpoch.current += 1;
    uploadEpoch.current += 1;
    setUploads([]);
    setPanel(null);
    setProgress([]);
    setError(null);
    setDrawer(false);
    history.pushState({}, "", id ? `/?chat=${encodeURIComponent(id)}` : "/");
    setActiveId(id);
    if (!id) setConversation(null);
    setTimeout(() => textarea.current?.focus(), 0);
  }

  async function send(retryMessage?: Message) {
    if (busy || streamController.current) return;
    const original = retryMessage
      ? conversation?.messages.find(
          (message) => message.id === retryMessage.replyToId,
        )
      : null;
    const content = retryMessage ? (original?.content ?? "") : draft.trim();
    if (!content) return;
    if (!account) {
      await signIn();
      return;
    }
    if (!retryMessage && uploads.some((file) => file.status !== "ready")) {
      setError(
        "Wait for file extraction, or remove files that could not be read, before sending.",
      );
      return;
    }
    if (content.length > 20_000) {
      setError("Please keep your question under 20,000 characters.");
      return;
    }
    setError(null);
    setProgress([]);
    setStreaming(true);
    followScroll.current = true;
    stopRequested.current = false;
    autoOpenedEvidence.current = false;
    const controller = new AbortController();
    const epoch = ++conversationEpoch.current;
    streamController.current = controller;
    streamGenerationId.current = null;
    let receivedMeta = false;
    let chatId = activeId;
    let assistantId = retryMessage?.id ?? `draft-${crypto.randomUUID()}`;
    let userId = original?.id ?? `draft-${crypto.randomUUID()}`;
    const requestId = original?.requestId ?? crypto.randomUUID();
    const sentFiles = retryMessage
      ? []
      : uploads.filter((file): file is Attachment => file.status === "ready");
    try {
      let chat = conversation?.chat;
      if (!chatId) {
        const result = await requestJson<{ chat: Chat }>("/api/chats", {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        });
        chat = result.chat;
        chatId = chat.id;
        skipLoad.current = chat.id;
        history.pushState({}, "", `/?chat=${chat.id}`);
        activeRef.current = chat.id;
        setActiveId(chat.id);
      }
      if (!chat)
        throw new Error(
          "Reload this conversation before sending another question.",
        );
      const now = Date.now();
      const userMessage: Message = original ?? {
        id: userId,
        chatId,
        role: "user",
        content,
        status: "complete",
        requestId,
        replyToId: null,
        evidence: null,
        createdAt: now,
        updatedAt: now,
      };
      const assistantMessage: Message = {
        id: assistantId,
        chatId,
        role: "assistant",
        content: "",
        status: "running",
        requestId: null,
        replyToId: userId,
        evidence: null,
        createdAt: retryMessage?.createdAt ?? now,
        updatedAt: now,
      };
      setConversation(
        (previous) =>
          ({
            chat,
            messages: retryMessage
              ? (previous?.messages ?? []).map((message) =>
                  message.id === retryMessage.id ? assistantMessage : message,
                )
              : [...(previous?.messages ?? []), userMessage, assistantMessage],
            attachments: [
              ...(previous?.attachments ?? []),
              ...sentFiles.map((file) => ({
                ...file,
                chatId,
                messageId: userId,
              })),
            ],
          }) as Conversation,
      );
      if (!retryMessage) {
        setDraft("");
        setUploads([]);
      }
      const response = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          requestId,
          attachmentIds: sentFiles.map((file) => file.id),
          retry: Boolean(retryMessage),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          error?: unknown;
        };
        throw new RequestError(
          "error" in failure && typeof failure.error === "string"
            ? failure.error
            : "Your question could not be sent. Please retry.",
          response.status,
        );
      }
      let streamError: string | null = null;
      await consumeEvents(response, (event) => {
        if (activeRef.current !== chatId) return;
        if (event.type === "meta") {
          receivedMeta = true;
          const previousAssistant = assistantId;
          const previousUser = userId;
          if (typeof event.assistantMessageId === "string")
            assistantId = event.assistantMessageId;
          streamGenerationId.current = assistantId;
          if (typeof event.userMessageId === "string")
            userId = event.userMessageId;
          setConversation((previous) =>
            previous
              ? {
                  ...previous,
                  messages: previous.messages.map((message) =>
                    message.id === previousAssistant
                      ? { ...message, id: assistantId, replyToId: userId }
                      : message.id === previousUser
                        ? { ...message, id: userId }
                        : message,
                  ),
                  attachments: previous.attachments.map((file) =>
                    file.messageId === previousUser
                      ? { ...file, messageId: userId }
                      : file,
                  ),
                }
              : previous,
          );
        }
        if (event.type === "progress" && typeof event.title === "string")
          setProgress((previous) =>
            [
              ...previous,
              {
                id: crypto.randomUUID(),
                stage: String(event.stage ?? "working"),
                title: event.title as string,
                detail:
                  typeof event.detail === "string" ? event.detail : undefined,
              },
            ].slice(-12),
          );
        if (event.type === "delta" && typeof event.text === "string")
          setConversation((previous) =>
            previous
              ? {
                  ...previous,
                  messages: previous.messages.map((message) =>
                    message.id === assistantId
                      ? { ...message, content: message.content + event.text }
                      : message,
                  ),
                }
              : previous,
          );
        if (
          event.type === "evidence" &&
          event.evidence &&
          typeof event.evidence === "object"
        ) {
          const evidence = event.evidence as Evidence;
          setConversation((previous) =>
            previous
              ? {
                  ...previous,
                  messages: previous.messages.map((message) =>
                    message.id === assistantId
                      ? { ...message, evidence }
                      : message,
                  ),
                }
              : previous,
          );
          const openAutomatically =
            !narrow &&
            !autoOpenedEvidence.current &&
            (evidence.sources.length > 0 || Boolean(evidence.cohort));
          if (openAutomatically) autoOpenedEvidence.current = true;
          setPanel((previous) =>
            previous
              ? { evidence, sourceId: previous.sourceId }
              : openAutomatically
                ? { evidence }
                : null,
          );
        }
        if (event.type === "error")
          streamError =
            typeof event.error === "string"
              ? event.error
              : "This answer could not be completed. You can retry below.";
      });
      if (streamError) setError(streamError);
    } catch (failure) {
      const stillCurrent =
        streamController.current === controller &&
        (!chatId || activeRef.current === chatId);
      if (!controller.signal.aborted && stillCurrent)
        setError(errorMessage(failure));
      if (!receivedMeta && !retryMessage && stillCurrent) {
        setDraft(content);
        setUploads(sentFiles);
      }
      setConversation((previous) =>
        previous
          ? {
              ...previous,
              messages: previous.messages.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      status: controller.signal.aborted
                        ? "cancelled"
                        : "failed",
                    }
                  : message,
              ),
            }
          : previous,
      );
    } finally {
      const stillCurrent = streamController.current === controller;
      if (stillCurrent) {
        streamController.current = null;
        streamGenerationId.current = null;
        setStreaming(false);
      }
      if (chatId && activeRef.current === chatId && stillCurrent) {
        try {
          const saved = await reload(chatId);
          if (
            !receivedMeta &&
            !retryMessage &&
            conversationEpoch.current === epoch &&
            saved.messages.some((message) => message.requestId === requestId)
          ) {
            setDraft((previous) => (previous === content ? "" : previous));
            setUploads([]);
          }
          await refreshChats();
        } catch (failure) {
          if (!controller.signal.aborted) setError(errorMessage(failure));
        }
      }
    }
  }

  async function uploadFiles(selected: FileList | null) {
    if (!selected?.length) return;
    if (uploading) {
      setError(
        "Wait for the selected files to finish processing before adding more.",
      );
      return;
    }
    if (!account) {
      setError(
        "Sign in to attach private files. Your question will stay here.",
      );
      return;
    }
    if (uploads.length + selected.length > 4) {
      setError("Attach at most four files to a question.");
      return;
    }
    setError(null);
    const epoch = uploadEpoch.current;
    const identityEpoch = authEpoch.current;
    for (const file of Array.from(selected)) {
      if (epoch !== uploadEpoch.current || identityEpoch !== authEpoch.current)
        break;
      if (file.size > 8 * 1024 * 1024) {
        setError(`${file.name} exceeds the 8 MiB file limit.`);
        continue;
      }
      if (!/\.(pdf|docx|txt|md|png|jpe?g)$/i.test(file.name)) {
        setError(
          `${file.name} is unsupported. Use PDF, DOCX, TXT, Markdown, PNG, or JPEG.`,
        );
        continue;
      }
      const id = crypto.randomUUID();
      const controller = new AbortController();
      uploadControllers.current.set(id, controller);
      setUploads((previous) => [
        ...previous,
        {
          id,
          name: file.name,
          type: file.type,
          size: file.size,
          status: "uploading",
          error: null,
          chatId: activeId,
          messageId: null,
          createdAt: Date.now(),
        },
      ]);
      const form = new FormData();
      form.set("file", file);
      if (activeId) form.set("chatId", activeId);
      try {
        const result = await requestJson<{ attachment: Attachment }>(
          "/api/attachments",
          { method: "POST", body: form, signal: controller.signal },
        );
        if (!controller.signal.aborted && identityEpoch === authEpoch.current) {
          setUploads((previous) =>
            previous.map((item) => (item.id === id ? result.attachment : item)),
          );
          setFiles((previous) =>
            previous
              ? previous.some((item) => item.id === result.attachment.id)
                ? previous.map((item) =>
                    item.id === result.attachment.id ? result.attachment : item,
                  )
                : [result.attachment, ...previous]
              : null,
          );
        }
      } catch (failure) {
        if (!controller.signal.aborted && identityEpoch === authEpoch.current)
          setUploads((previous) =>
            previous.map((item) =>
              item.id === id
                ? {
                    ...item,
                    status: "failed",
                    error:
                      failure instanceof RequestError
                        ? errorMessage(failure)
                        : "The upload status is unknown. Check Your files before retrying.",
                  }
                : item,
            ),
          );
      } finally {
        uploadControllers.current.delete(id);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  async function removeFile(file: Upload | Attachment) {
    if (file.status === "uploading" || uploadControllers.current.has(file.id)) {
      setError(
        "Wait for this file to finish processing before removing it. You can also manage saved uploads in Your files.",
      );
      return;
    }
    try {
      await requestJson(`/api/attachments/${file.id}`, {
        method: "DELETE",
      }).catch((failure) => {
        if (!(failure instanceof RequestError && failure.status === 404))
          throw failure;
      });
      setUploads((previous) => previous.filter((item) => item.id !== file.id));
      setFiles(
        (previous) => previous?.filter((item) => item.id !== file.id) ?? null,
      );
      setConversation((previous) =>
        previous
          ? {
              ...previous,
              attachments: previous.attachments.filter(
                (item) => item.id !== file.id,
              ),
            }
          : previous,
      );
      setPanel(null);
      if (file.chatId === activeId && activeId) await reload(activeId);
    } catch (failure) {
      setError(errorMessage(failure));
      if (modal === "files") setModalError(errorMessage(failure));
    }
  }

  function selectSavedFile(file: Attachment) {
    if (
      !account ||
      busy ||
      uploading ||
      file.status !== "ready" ||
      file.messageId ||
      (file.chatId && file.chatId !== activeId)
    )
      return;
    if (uploads.some((item) => item.id === file.id)) {
      setModal(null);
      return;
    }
    if (uploads.length >= 4) {
      setModalError(
        "Attach at most four files to a question. Remove a selected file before choosing another.",
      );
      return;
    }
    setUploads((previous) => [...previous, file]);
    setModal(null);
    setError(null);
    setTimeout(() => textarea.current?.focus(), 0);
  }

  async function removeChat(chat: Chat) {
    try {
      if (chat.id === activeId && busy) await stop();
      await requestJson(`/api/chats/${chat.id}`, { method: "DELETE" });
      if (chat.id === activeId) await navigate(null);
      await refreshChats();
    } catch (failure) {
      try {
        const refreshed = await refreshChats();
        if (!refreshed.some((item) => item.id === chat.id)) {
          if (chat.id === activeId) await navigate(null);
          return;
        }
      } catch {
        /* The pending row can be retried from the next history load. */
      }
      setError(
        `${errorMessage(failure)} Removal is still pending; use the conversation's delete button to retry.`,
      );
    }
  }

  async function signOut() {
    try {
      if (busy) await stop();
      const result = await auth.signOut();
      if (result.error) throw new Error("Sign-out failed. Please try again.");
      authEpoch.current += 1;
      setAccount(null);
      setChats([]);
      setConversation(null);
      setUploads([]);
      setFiles(null);
      setModal(null);
      setModalError(null);
      setDraft("");
      saveDraft("");
      setAccountMenu(false);
      await navigate(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function openCorpus() {
    setModal("corpus");
    setModalError(null);
    setDrawer(false);
    void requestJson<Corpus>("/api/corpus/stats")
      .then(setCorpus)
      .catch((failure) => setModalError(errorMessage(failure)));
  }
  function showEvidence(evidence: Evidence, sourceId?: string) {
    setPanel({ evidence, sourceId });
  }
  const sidebar = (
    <>
      <a
        className="op-wordmark"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          void navigate(null);
        }}
      >
        outpredict
        <span className="op-logo-dot" />
      </a>
      <nav className="op-nav" aria-label="Main navigation">
        <button
          className={!activeId ? "is-current" : ""}
          type="button"
          onClick={() => void navigate(null)}
        >
          <Icon name="new" />
          New chat
        </button>
        <button type="button" onClick={openCorpus}>
          <Icon name="search" />
          Sources & corpus
        </button>
        <button
          type="button"
          onClick={() => {
            setModal("files");
            setDrawer(false);
          }}
        >
          <Icon name="file" />
          Your files
        </button>
      </nav>
      <div className="op-history">
        <div className="op-section-label">Chats</div>
        {!account && (
          <p className="op-history-empty">
            Sign in to save your conversations.
          </p>
        )}
        {account && !chats.length && (
          <p className="op-history-empty">
            Your conversations will appear here.
          </p>
        )}
        {account &&
          chats.map((chat) => (
            <div
              className={`op-history-row ${activeId === chat.id ? "is-current" : ""}`}
              key={chat.id}
            >
              <button
                type="button"
                title={chat.title}
                onClick={() =>
                  void (chat.deletionPending
                    ? removeChat(chat)
                    : navigate(chat.id))
                }
              >
                {chat.deletionPending
                  ? `Removal pending: ${chat.title}`
                  : chat.title}
              </button>
              <button
                type="button"
                className="op-history-delete"
                onClick={() => void removeChat(chat)}
                aria-label={`${chat.deletionPending ? "Retry removal of" : "Delete conversation"}: ${chat.title}`}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
      </div>
      <div className="op-account-area">
        {accountMenu && (
          <div className="op-account-menu">
            <button
              type="button"
              onClick={() => {
                setModal("privacy");
                setAccountMenu(false);
              }}
            >
              <Icon name="info" size={16} />
              Privacy & usage
            </button>
            <button type="button" onClick={() => void signOut()}>
              <Icon name="logout" size={16} />
              Sign out
            </button>
          </div>
        )}
        {account ? (
          <button
            className="op-account"
            type="button"
            onClick={() => setAccountMenu(!accountMenu)}
            aria-expanded={accountMenu}
          >
            <span className="op-avatar">
              {account.name.charAt(0).toUpperCase()}
            </span>
            <span>
              <strong>{account.name}</strong>
              <small>{account.email}</small>
            </span>
            <Icon name="chevron" size={13} />
          </button>
        ) : (
          <button
            className="op-signin"
            type="button"
            onClick={() => void signIn()}
            disabled={!setup?.googleSignIn || signingIn || initializing}
          >
            {signingIn ? "Opening Google…" : "Continue with Google"}
          </button>
        )}
        <div className="op-account-caption">
          Free advice. Your next step, clearer.
        </div>
      </div>
    </>
  );

  const composer = (
    <div className="op-composer-shell">
      {!!uploads.length && (
        <div className="op-upload-list">
          {uploads.map((file) => (
            <div
              className={`op-upload ${file.status === "failed" ? "has-error" : ""}`}
              key={file.id}
            >
              <Icon name={file.status === "failed" ? "alert" : "file"} />
              <div>
                <strong>{file.name}</strong>
                <small>
                  {file.status === "uploading" || file.status === "processing"
                    ? "Reading your file… Remove after processing."
                    : file.status === "ready"
                      ? "Ready to use"
                      : file.error || "Could not read this file"}
                </small>
              </div>
              <button
                type="button"
                className="op-icon-button"
                onClick={() => void removeFile(file)}
                disabled={file.status === "uploading"}
                title={
                  file.status === "uploading"
                    ? "Wait for processing to finish before removing this file."
                    : undefined
                }
                aria-label={`Remove ${file.name}`}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className="op-composer"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="op-sr-only" htmlFor="question">
          Your question
        </label>
        <textarea
          ref={bindTextarea}
          id="question"
          placeholder={
            activeId
              ? "Ask a follow-up…"
              : "How can I become a stronger applicant in the next year?"
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          maxLength={20_000}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !narrow
            ) {
              event.preventDefault();
              if (!busy) void send();
            }
          }}
        />
        <div className="op-composer-controls">
          <div>
            <button
              type="button"
              className="op-icon-button"
              onClick={() => fileInput.current?.click()}
              disabled={busy || uploading || !account || uploads.length >= 4}
              aria-label="Attach a PDF, DOCX, text document, or image"
              title={
                account
                  ? "Attach a file (up to 8 MiB)"
                  : "Sign in to attach a private file"
              }
            >
              <Icon name="clip" />
            </button>
            <span className="op-composer-mode">
              <Icon name="spark" size={14} />
              Ask anything
            </span>
          </div>
          {busy ? (
            <button
              className="op-send op-stop"
              type="button"
              onClick={() => void stop()}
              aria-label="Stop response"
            >
              <Icon name="stop" size={17} />
            </button>
          ) : (
            <button
              className="op-send"
              type="submit"
              aria-label={
                account ? "Send question" : "Sign in to send question"
              }
              disabled={
                !draft.trim() ||
                initializing ||
                signingIn ||
                (!account && !setup?.googleSignIn) ||
                uploads.some((file) => file.status !== "ready")
              }
            >
              <Icon name="arrow" size={19} />
            </button>
          )}
        </div>
      </form>
      <input
        className="op-sr-only"
        tabIndex={-1}
        aria-hidden="true"
        ref={fileInput}
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg"
        onChange={(event) => void uploadFiles(event.target.files)}
      />
    </div>
  );

  return (
    <div className={`op-app ${panel && !narrow ? "has-evidence" : ""}`}>
      <aside className="op-sidebar">{sidebar}</aside>
      {drawer && (
        <Modal
          title="Outpredict"
          className="op-sidebar-dialog"
          close={() => setDrawer(false)}
        >
          {sidebar}
        </Modal>
      )}
      <main className="op-workspace">
        <header className="op-topbar">
          <button
            type="button"
            className="op-icon-button op-mobile-menu"
            onClick={() => setDrawer(true)}
            aria-label="Open navigation"
          >
            <Icon name="menu" />
          </button>
          <span>
            {activeId ? (conversation?.chat.title ?? "Conversation") : ""}
          </span>
          <div>
            {setup?.environment === "staging" && (
              <span className="op-staging">Staging</span>
            )}
            {activeId && (
              <button
                type="button"
                className={`op-icon-button ${panel ? "is-current" : ""}`}
                aria-label={
                  panel ? "Close evidence panel" : "Open evidence panel"
                }
                onClick={() =>
                  panel
                    ? setPanel(null)
                    : setPanel({
                        evidence: [...(conversation?.messages ?? [])]
                          .reverse()
                          .find((message) => message.evidence)?.evidence ?? {
                          sources: [],
                        },
                      })
                }
              >
                <Icon name="panel" />
              </button>
            )}
          </div>
        </header>
        <div className="op-chat-layout">
          <div className="op-conversation-pane">
            {!activeId ? (
              <div className="op-home-scroll">
                <div className="op-home">
                  <h1>What can I help you with?</h1>
                  {composer}
                  <button
                    type="button"
                    className="op-corpus-ribbon"
                    onClick={openCorpus}
                  >
                    <span>
                      <span className="op-source-avatars">
                        <i>R</i>
                        <i>S</i>
                        <i>M</i>
                      </span>
                      {corpus
                        ? `${number(corpus.totalProfiles)} public profiles`
                        : "Explore the applicant corpus"}
                    </span>
                    <span>
                      <Icon name="book" size={12} />
                      Corpus & your inputs
                    </span>
                  </button>
                  {!account && !initializing && (
                    <p className="op-signin-hint">
                      {setup?.googleSignIn
                        ? "Ask your question, then sign in with Google to save the conversation."
                        : "Google sign-in is being connected. You can explore the corpus while setup finishes."}
                    </p>
                  )}
                  {error && (
                    <div className="op-error" role="alert">
                      <Icon name="alert" size={16} />
                      <span>{error}</span>
                      <button
                        type="button"
                        onClick={() => setError(null)}
                        aria-label="Dismiss error"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  )}
                  <section className="op-library" aria-label="Prompt library">
                    <div className="op-library-tabs">
                      <button
                        type="button"
                        className={libraryTab === "prompts" ? "active" : ""}
                        aria-pressed={libraryTab === "prompts"}
                        onClick={() => setLibraryTab("prompts")}
                      >
                        <Icon name="book" size={14} />
                        Prompt library
                      </button>
                      <button
                        type="button"
                        className={libraryTab === "tips" ? "active" : ""}
                        aria-pressed={libraryTab === "tips"}
                        onClick={() => setLibraryTab("tips")}
                      >
                        <Icon name="spark" size={14} />
                        Prompting tips
                      </button>
                    </div>
                    {libraryTab === "prompts" ? (
                      prompts.map((prompt) => (
                        <article className="op-prompt-row" key={prompt.title}>
                          <span className={`op-prompt-icon ${prompt.color}`}>
                            <Icon name={prompt.icon} size={20} />
                          </span>
                          <div>
                            <h2>{prompt.title}</h2>
                            <p>{prompt.description}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setDraft(prompt.prompt);
                              textarea.current?.focus();
                            }}
                          >
                            Use prompt
                          </button>
                        </article>
                      ))
                    ) : (
                      <div className="op-tips">
                        <h2>Start wherever you are.</h2>
                        <p>
                          A question is enough. You do not need a résumé or a
                          complete profile to get useful guidance.
                        </p>
                        <h2>Add details that change the answer.</h2>
                        <p>
                          Your timing, goals, reported scores, and completed
                          experience can make comparisons more relevant. Mark
                          future hours as planned.
                        </p>
                        <h2>Ask for the evidence.</h2>
                        <p>
                          Open Sources to inspect reported profiles,
                          calculations, your documents, and coverage
                          limitations. Follow up when something needs
                          explanation.
                        </p>
                      </div>
                    )}
                  </section>
                </div>
              </div>
            ) : (
              <>
                <div
                  className="op-messages-scroll"
                  ref={scroll}
                  onScroll={() => {
                    const node = scroll.current;
                    if (node)
                      followScroll.current =
                        node.scrollHeight - node.scrollTop - node.clientHeight <
                        120;
                  }}
                >
                  <div className="op-messages">
                    {loadingChat && (
                      <div className="op-empty-state" role="status">
                        <span className="op-spinner" />
                        Opening conversation…
                      </div>
                    )}
                    {!loadingChat && !account && (
                      <div className="op-empty-state">
                        <h1>Your conversations are private.</h1>
                        <p>
                          Sign in with your Google account to open this
                          conversation.
                        </p>
                        <button
                          className="op-primary-button"
                          type="button"
                          disabled={!setup?.googleSignIn || signingIn}
                          onClick={() => void signIn()}
                        >
                          Continue with Google
                        </button>
                      </div>
                    )}
                    {!loadingChat &&
                      account &&
                      conversation &&
                      !conversation.messages.length && (
                        <div className="op-empty-state">
                          <h1>A fresh start.</h1>
                          <p>
                            Ask any question below. An attachment is optional.
                          </p>
                        </div>
                      )}
                    {conversation?.messages.map((message, index) => (
                      <article
                        className={`op-message op-message-${message.role}`}
                        aria-label={
                          message.role === "user"
                            ? "Your question"
                            : "Outpredict response"
                        }
                        key={message.id}
                      >
                        {message.role === "user" ? (
                          <>
                            <div className="op-user-bubble">
                              {message.content}
                            </div>
                            {conversation.attachments
                              .filter((file) => file.messageId === message.id)
                              .map((file) => (
                                <a
                                  key={file.id}
                                  className="op-message-file"
                                  href={`/api/attachments/${file.id}?download=1`}
                                >
                                  <Icon name="file" size={14} />
                                  {file.name}
                                  <Icon name="download" size={13} />
                                </a>
                              ))}
                          </>
                        ) : (
                          <>
                            <Answer
                              message={message}
                              showEvidence={showEvidence}
                            />
                            {message.status === "running" &&
                              index === conversation.messages.length - 1 && (
                                <div className="op-progress" role="status">
                                  <span className="op-spinner" />
                                  <div>
                                    <strong>
                                      {progress.at(-1)?.title ??
                                        (externallyRunning
                                          ? "An answer is still in progress"
                                          : "Working on your question")}
                                    </strong>
                                    {progressDetail && <p>{progressDetail}</p>}
                                    {progress.length > 1 && (
                                      <details>
                                        <summary>View evidence steps</summary>
                                        <ol>
                                          {progress.map((step) => (
                                            <li key={step.id}>
                                              <strong>{step.title}</strong>
                                              {step.detail && (
                                                <span>{step.detail}</span>
                                              )}
                                            </li>
                                          ))}
                                        </ol>
                                      </details>
                                    )}
                                  </div>
                                </div>
                              )}
                            {(message.status === "failed" ||
                              message.status === "cancelled") && (
                              <div className="op-partial">
                                <Icon
                                  name={
                                    message.status === "cancelled"
                                      ? "stop"
                                      : "alert"
                                  }
                                  size={14}
                                />
                                <span>
                                  {message.status === "cancelled"
                                    ? "Response stopped."
                                    : "This response was interrupted."}
                                  {message.content &&
                                    " The text above is a partial answer."}
                                </span>
                                {index === conversation.messages.length - 1 && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void send(message)}
                                  >
                                    Retry
                                  </button>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </article>
                    ))}
                  </div>
                </div>
                <div className="op-chat-composer">
                  {error && (
                    <div className="op-error" role="alert">
                      <Icon name="alert" size={16} />
                      <span>{error}</span>
                      <button
                        type="button"
                        onClick={() => setError(null)}
                        aria-label="Dismiss error"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  )}
                  {composer}
                  <p className="op-disclaimer">
                    Outpredict can make mistakes. Review the cited profiles and
                    keep reported outcomes in context.
                  </p>
                </div>
              </>
            )}
          </div>
          {panel && !narrow && (
            <aside
              className="op-evidence-panel"
              aria-label="Evidence and sources"
            >
              <div className="op-evidence-header">
                <h2>Evidence & sources</h2>
                <button
                  type="button"
                  className="op-icon-button"
                  aria-label="Close evidence panel"
                  onClick={() => setPanel(null)}
                >
                  <Icon name="panel" />
                </button>
              </div>
              <EvidenceContent panel={panel} />
            </aside>
          )}
        </div>
      </main>
      {panel && narrow && (
        <Modal
          title="Evidence & sources"
          className="op-evidence-modal"
          close={() => setPanel(null)}
        >
          <EvidenceContent panel={panel} />
        </Modal>
      )}
      {modal === "corpus" && (
        <Modal
          title="A small corpus. Clear provenance."
          close={() => setModal(null)}
        >
          <p className="op-modal-intro">
            Explore publicly reported applicant experience and outcomes. These
            profiles help make comparisons concrete; they do not predict your
            odds of admission.
          </p>
          <p className="op-modal-intro">
            Answers draw on this scraped corpus and your own messages and files.
            The source counts and application cycles below show its actual
            coverage. Missing reports cannot establish an applicant's outcome.
          </p>
          {corpus ? (
            <>
              <div className="op-corpus-total">
                <strong>{number(corpus.totalProfiles)}</strong>
                <span>reviewed public source profiles</span>
              </div>
              <div className="op-coverage-grid">
                <section>
                  <h3>Source coverage</h3>
                  <dl>
                    {corpus.sourceCoverage.map((source) => (
                      <div key={source.source}>
                        <dt>
                          {source.source === "sdn"
                            ? "Student Doctor Network"
                            : source.source === "mdapplicants"
                              ? "MDApplicants"
                              : "Reddit"}
                        </dt>
                        <dd>{source.profiles}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
                <section>
                  <h3>Application cycles</h3>
                  <dl>
                    {corpus.cycles.map((cycle) => (
                      <div key={cycle.cycle}>
                        <dt>{cycle.cycle}</dt>
                        <dd>{cycle.profiles}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </div>
              {corpus.reviewedAt && (
                <p className="op-fine-print">
                  Last reviewed: {corpus.reviewedAt}
                </p>
              )}
              <h3>What to keep in mind</h3>
              <ul className="op-limitations">
                {corpus.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </>
          ) : modalError ? (
            <div className="op-error" role="alert">
              {modalError}
              <button type="button" onClick={openCorpus}>
                Retry
              </button>
            </div>
          ) : (
            <p role="status">Loading the current corpus…</p>
          )}
        </Modal>
      )}
      {modal === "files" && (
        <Modal title="Your files" close={() => setModal(null)}>
          <p className="op-modal-intro">
            Private documents and images you have uploaded. Remove a file to
            delete its original and extracted text. Earlier answers can still
            contain quotations; delete their conversation to remove those
            answers.
          </p>
          <p className="op-modal-intro">
            Uploads can finish here after you switch conversations. If a
            connection was interrupted, check this list before uploading again.
          </p>
          {!account ? (
            <p>Sign in to manage your private files.</p>
          ) : modalError ? (
            <div className="op-error" role="alert">
              {modalError}
              <button type="button" onClick={() => reloadFileList.current?.()}>
                Retry
              </button>
            </div>
          ) : !files ? (
            <p role="status">Loading your files…</p>
          ) : !files.length ? (
            <div className="op-empty-state">
              <Icon name="file" size={30} />
              <h3>No files yet</h3>
              <p>You can ask a question with or without an attachment.</p>
            </div>
          ) : (
            <div className="op-file-manager">
              {files.map((file) => (
                <div key={file.id}>
                  <Icon name="file" />
                  <span>
                    <strong>{file.name}</strong>
                    <small>
                      {file.status === "ready"
                        ? `${Math.max(1, Math.round(file.size / 1024))} KB · Ready`
                        : (file.error ?? "Processing")}
                    </small>
                  </span>
                  {file.status === "ready" &&
                    !file.messageId &&
                    (!file.chatId || file.chatId === activeId) && (
                      <button
                        type="button"
                        className="op-use-file"
                        disabled={busy || uploading}
                        onClick={() => selectSavedFile(file)}
                      >
                        {uploads.some((item) => item.id === file.id)
                          ? "Selected"
                          : "Use file"}
                      </button>
                    )}
                  <a
                    className="op-icon-button"
                    aria-label={`Download ${file.name}`}
                    href={`/api/attachments/${file.id}?download=1`}
                  >
                    <Icon name="download" size={16} />
                  </a>
                  <button
                    type="button"
                    className="op-icon-button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => void removeFile(file)}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
      {modal === "privacy" && (
        <Modal title="Privacy & usage" close={() => setModal(null)}>
          <div className="op-privacy">
            <h3>Your conversations belong to you.</h3>
            <p>
              Your Google account controls access to saved chats and files.
              Uploaded originals are stored privately and read to answer your
              questions. Other users cannot open them.
            </p>
            <h3>You control what stays.</h3>
            <p>
              Delete a conversation from the sidebar to remove its saved
              messages and attached originals. Remove an individual file from
              Your files to exclude its extracted text from future answers.
              Previously generated answers may still quote a removed file.
            </p>
            <h3>The corpus and your own inputs.</h3>
            <p>
              Outpredict uses Cloudflare Workers AI to process questions and
              documents, compare scraped applicant profiles, and compute
              summaries. Your messages and optional files supply your personal
              context. The evidence panel shows the profiles, calculations, and
              documents behind each answer.
            </p>
            <h3>Free, with sensible limits.</h3>
            <p>
              Up to 50 answer requests per day, 100 saved conversations, and 40
              files totaling 64 MiB. Each question accepts up to four files, no
              larger than 8 MiB each. There are no subscriptions or paid tiers.
            </p>
            <p>
              Up to 20 accepted file uploads per day. Upload and answer limits
              reset at midnight UTC; failed file conversions still count toward
              the upload limit.
            </p>
            <h3>Evidence has limits.</h3>
            <p>
              Public profiles are self-reported and incomplete. Outcomes are not
              probabilities, and comparable applicants are not a representative
              sample of everyone who applied.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
