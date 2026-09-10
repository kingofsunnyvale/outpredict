import officialSiteDirectory from "../data/official-sites.json";
import { ProductError, type Source } from "./product-types";

export type PublicSearchResult = {
  title: string;
  url: string;
  content: string;
  method?: "official_site" | "web_search";
  discoveredFrom?: string;
  discoveredAt?: string;
};
type Fetcher = typeof fetch;

type ResearchProvider = "duckduckgo" | "tavily" | "publisher";

function researchFailure(
  provider: ResearchProvider,
  code: string,
  message: string,
  details: { status?: number; kind?: string } = {},
): ProductError {
  // Do not log queries, URLs, headers, credentials, response bodies, or private
  // context. These fixed categories distinguish edge/network/provider failures.
  console.warn(
    JSON.stringify({
      event: "public_research_failure",
      provider,
      code,
      ...details,
    }),
  );
  return new ProductError(503, message, code);
}

async function researchFetch(
  provider: ResearchProvider,
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const kind = ["TypeError", "TimeoutError", "AbortError"].includes(name)
      ? name
      : "Error";
    const timeout = kind === "TimeoutError";
    throw researchFailure(
      provider,
      timeout ? "research_timeout" : "research_network_error",
      `${provider === "publisher" ? "The source page" : "Public source discovery"} ${timeout ? "timed out" : `could not connect (${kind})`}. No current information was verified by this request.`,
      { kind },
    );
  }
}

async function researchText(
  provider: ResearchProvider,
  response: Response,
  limit: number,
): Promise<string> {
  try {
    return await readBoundedText(response, limit);
  } catch (error) {
    if (error instanceof ProductError) throw error;
    throw researchFailure(
      provider,
      "research_body_error",
      "The public source response was interrupted before it could be read.",
      { status: response.status },
    );
  }
}

export const PUBLIC_INSTITUTIONS = [
  "AAMC",
  "AACOM",
  "AMCAS",
  "AACOMAS",
  "Stanford",
  "Harvard",
  "Johns Hopkins",
  "Yale",
  "Columbia",
  "Cornell",
  "NYU",
  "University of Pennsylvania",
  "Duke",
  "Vanderbilt",
  "Washington University",
  "Northwestern",
  "University of Chicago",
  "University of Michigan",
  "University of Pittsburgh",
  "Case Western Reserve",
  "Cleveland Clinic",
  "Mayo Clinic",
  "Baylor",
  "UT Southwestern",
  "UT Austin Dell",
  "UT Houston McGovern",
  "UT San Antonio",
  "UT Medical Branch",
  "Texas Tech",
  "Texas A&M",
  "University of Houston",
  "TCU",
  "UT Rio Grande Valley",
  "UCLA",
  "UCSF",
  "UC San Diego",
  "UC Davis",
  "UC Irvine",
  "UC Riverside",
  "USC Keck",
  "Kaiser Permanente",
  "Loma Linda",
  "California University of Science and Medicine",
  "California Northstate",
  "Charles Drew",
  "University of Washington",
  "Washington State",
  "Oregon Health and Science",
  "University of Colorado",
  "University of Utah",
  "University of Arizona",
  "University of Nevada",
  "UNLV",
  "University of New Mexico",
  "University of Hawaii",
  "University of Oklahoma",
  "University of Kansas",
  "University of Nebraska",
  "Creighton",
  "University of Iowa",
  "University of Minnesota",
  "University of Wisconsin",
  "Medical College of Wisconsin",
  "Indiana University",
  "Ohio State",
  "University of Cincinnati",
  "University of Toledo",
  "Wright State",
  "NEOMED",
  "Michigan State",
  "Wayne State",
  "Oakland University",
  "Western Michigan",
  "Central Michigan",
  "University of Illinois",
  "Rush",
  "Loyola Chicago",
  "Rosalind Franklin",
  "Southern Illinois",
  "Saint Louis University",
  "University of Missouri",
  "University of Kentucky",
  "University of Louisville",
  "University of Tennessee",
  "East Tennessee State",
  "Meharry",
  "University of Alabama",
  "University of South Alabama",
  "University of Mississippi",
  "LSU",
  "Tulane",
  "University of Arkansas",
  "University of Florida",
  "University of Miami",
  "University of South Florida",
  "University of Central Florida",
  "Florida Atlantic",
  "Florida International",
  "Florida State",
  "Nova Southeastern",
  "Emory",
  "Morehouse",
  "Mercer",
  "Medical College of Georgia",
  "Medical University of South Carolina",
  "University of South Carolina",
  "University of North Carolina",
  "East Carolina",
  "Wake Forest",
  "University of Virginia",
  "Virginia Commonwealth",
  "Virginia Tech",
  "Eastern Virginia",
  "Georgetown",
  "George Washington",
  "Howard",
  "Uniformed Services",
  "University of Maryland",
  "West Virginia University",
  "Marshall",
  "Thomas Jefferson",
  "Temple",
  "Drexel",
  "Penn State",
  "Geisinger",
  "University of Rochester",
  "University at Buffalo",
  "SUNY Upstate",
  "SUNY Downstate",
  "Stony Brook",
  "Albany Medical College",
  "New York Medical College",
  "Albert Einstein",
  "Mount Sinai",
  "Hofstra",
  "Rutgers",
  "Cooper Rowan",
  "Seton Hall Hackensack",
  "Boston University",
  "Tufts",
  "UMass Chan",
  "Brown",
  "Dartmouth",
  "University of Vermont",
  "University of Connecticut",
  "Quinnipiac",
  "University of North Dakota",
  "University of South Dakota",
  "University of Puerto Rico",
  "Ponce",
  "San Juan Bautista",
  "AT Still",
  "Arizona College of Osteopathic Medicine",
  "Chicago College of Osteopathic Medicine",
  "Des Moines University",
  "Kansas City University",
  "Lake Erie College of Osteopathic Medicine",
  "Philadelphia College of Osteopathic Medicine",
  "Rowan Osteopathic",
  "Touro",
  "Western University of Health Sciences",
  "Campbell",
  "Marian",
  "Liberty",
  "Edward Via",
  "Lincoln Memorial",
  "Rocky Vista",
  "Burrell",
  "Idaho College of Osteopathic Medicine",
  "William Carey",
  "Arkansas College of Osteopathic Medicine",
  "NYITCOM",
  "Oklahoma State Osteopathic",
  "Ohio University Heritage",
  "University of New England",
  "Pacific Northwest University",
] as const;

export const PUBLIC_TOPICS = [
  "academic requirements and prerequisites",
  "application deadlines and timeline",
  "MCAT policy",
  "letters of recommendation",
  "application essays and activity descriptions",
  "interview process",
  "tuition and financial aid",
  "residency and citizenship eligibility",
  "clinical experience and shadowing",
  "research opportunities",
  "community service and mission",
  "application fees and fee assistance",
  "application process",
  "curriculum and degree programs",
  "admissions contact information",
  "school directory and accreditation",
  "applicant competencies",
] as const;

/** This finite schema prevents names or facts extracted from private files
 * from becoming outbound search requests, regardless of model instructions. */
export function buildPublicQuery(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ProductError(
      400,
      "Choose a public institution and admissions topic.",
    );
  const args = input as Record<string, unknown>;
  if (
    Object.keys(args).some((key) => key !== "institution" && key !== "topic") ||
    typeof args.topic !== "string" ||
    !(PUBLIC_TOPICS as readonly string[]).includes(args.topic) ||
    (args.institution !== undefined &&
      (typeof args.institution !== "string" ||
        !(PUBLIC_INSTITUTIONS as readonly string[]).includes(args.institution)))
  )
    throw new ProductError(
      400,
      "Search accepts only the listed public institutions and topics; applicant details cannot be sent.",
      "private_search_query",
    );
  return `${args.institution ?? "AAMC"} medical school admissions ${args.topic}`;
}

const officialHosts = ["aamc.org", "aacom.org", "amcas.org", "lcme.org"];
const directoryHosts = new Set(
  officialSiteDirectory.flatMap((entry) =>
    entry.urls.map((url) => new URL(url).hostname),
  ),
);

export function isOfficialUrl(url: URL): boolean {
  return (
    directoryHosts.has(url.hostname) ||
    url.hostname.endsWith(".edu") ||
    url.hostname.endsWith(".gov") ||
    officialHosts.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  );
}

/** Fetch only public HTTPS documents. Never forward a user's cookies or headers. */
export function validatePublicUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048)
    throw new ProductError(400, "Use a valid public webpage URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProductError(400, "Use a valid public webpage URL.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !/^[a-z0-9.-]+$/.test(host) ||
    !host.includes(".") ||
    host.endsWith(".") ||
    /^\d+(?:\.\d+)*$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host) ||
    /(?:^|\.)(?:nip\.io|sslip\.io|localtest\.me)$/.test(host)
  )
    throw new ProductError(400, "Only public HTTPS webpages are supported.");
  url.hash = "";
  return url;
}

/** Keep search public: private chats/documents stay in the Workers AI context. */
export function validateSearchQuery(value: unknown): string {
  if (typeof value !== "string")
    throw new ProductError(
      400,
      "A public-information search query is required.",
    );
  const query = value.trim().replace(/\s+/g, " ");
  if (
    query.length < 3 ||
    query.length > 350 ||
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(query) ||
    /\b(?:my|mine|i am|i have|resume|résumé|ssn|social security)\b/i.test(
      query,
    ) ||
    /\b[0-4]\.\d{1,3}\b/.test(query) ||
    /\b(?:4[7-9]\d|5[01]\d|52[0-8])\b/.test(query) ||
    /(?:\d[\s().+-]*){9,}/.test(query)
  )
    throw new ProductError(
      400,
      "Search using a school name or public topic, without applicant details.",
      "private_search_query",
    );
  return query;
}

export async function readBoundedText(
  response: Response,
  maxBytes = 1_000_000,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    await response.body?.cancel();
    throw new ProductError(422, "This webpage is too large to read.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new ProductError(422, "This webpage is too large to read.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function publicSearch(
  apiKey: string | undefined,
  queryInput: unknown,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<PublicSearchResult[]> {
  const query = validateSearchQuery(queryInput);
  if (!apiKey) return discoverOfficialPages(query, signal, fetcher);
  const response = await researchFetch(
    "tavily",
    fetcher,
    "https://api.tavily.com/search",
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        auto_parameters: false,
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(15_000),
        ...(signal ? [signal] : []),
      ]),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw researchFailure(
      "tavily",
      response.status >= 300 && response.status < 400
        ? "search_redirect"
        : "search_unavailable",
      `Live search returned HTTP ${response.status}. Share an official school webpage or try again later.`,
      { status: response.status },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(await researchText("tavily", response, 200_000));
  } catch (error) {
    if (error instanceof ProductError) throw error;
    throw researchFailure(
      "tavily",
      "search_invalid_response",
      "Search returned an unreadable response.",
      { status: response.status },
    );
  }
  if (!body || typeof body !== "object" || !("results" in body))
    throw researchFailure(
      "tavily",
      "search_invalid_response",
      "Search returned an unreadable response.",
      { status: response.status },
    );
  if (!Array.isArray(body.results))
    throw researchFailure(
      "tavily",
      "search_invalid_response",
      "Search returned an unreadable response.",
      { status: response.status },
    );
  const results: PublicSearchResult[] = [];
  for (const row of body.results.slice(0, 5)) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.url !== "string" ||
      typeof row.title !== "string"
    )
      continue;
    try {
      const url = validatePublicUrl(row.url);
      results.push({
        url: url.href,
        title: row.title.slice(0, 250),
        content:
          typeof row.content === "string" ? row.content.slice(0, 2500) : "",
      });
    } catch {
      // An unsafe search result is never made available as a fetch target.
    }
  }
  return results;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&#(\d{1,6});/g, (_, code: string) =>
      Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : "",
    );
}

/** Link discovery only: do not reproduce the search service's results or snippets. */
export function parseSearchLinks(html: string): PublicSearchResult[] {
  const results: PublicSearchResult[] = [];
  for (const match of html.matchAll(
    /<a\b([^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'][^>]*)>[\s\S]*?<\/a>/gi,
  )) {
    const href = match[1]?.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const link = new URL(decodeEntities(href), "https://duckduckgo.com");
      const target =
        link.hostname === "duckduckgo.com" && link.pathname === "/l/"
          ? link.searchParams.get("uddg")
          : link.href;
      const url = validatePublicUrl(target);
      if (
        url.hostname === "duckduckgo.com" ||
        results.some((result) => result.url === url.href)
      )
        continue;
      results.push({ title: url.hostname, url: url.href, content: "" });
    } catch {
      // Invalid or non-public links are discarded, never followed.
    }
    if (results.length === 5) break;
  }
  return results;
}

export async function discoverDuckDuckGoPages(
  query: string,
  signal: AbortSignal | undefined,
  fetcher: Fetcher,
): Promise<PublicSearchResult[]> {
  // html.duckduckgo.com explicitly allows crawling in its own robots.txt.
  // No authentication, challenge bypass, user-agent impersonation, or retry loop.
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await researchFetch("duckduckgo", fetcher, url.href, {
    headers: {
      Accept: "text/html",
      "User-Agent": "Outpredict/1.0 (public source discovery)",
    },
    redirect: "manual",
    signal: AbortSignal.any([
      AbortSignal.timeout(12_000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw researchFailure(
      "duckduckgo",
      "search_redirect",
      `Public source discovery returned an unexpected redirect (HTTP ${response.status}). No current information was verified.`,
      { status: response.status },
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw researchFailure(
      "duckduckgo",
      "search_unavailable",
      `Public source discovery returned HTTP ${response.status}. Share an official URL or try again later.`,
      { status: response.status },
    );
  }
  const html = await researchText("duckduckgo", response, 500_000);
  if (/anomaly-modal|challenge-form|bots use DuckDuckGo/i.test(html))
    throw researchFailure(
      "duckduckgo",
      "search_challenge",
      "Public source discovery returned a verification challenge. No current information was verified.",
      { status: response.status },
    );
  const results = parseSearchLinks(html);
  if (!results.length && !/no results/i.test(html))
    throw researchFailure(
      "duckduckgo",
      "search_unreadable",
      "Public source discovery could not complete. No current information was verified.",
      { status: response.status },
    );
  return results;
}

export function extractHtmlText(html: string): { title: string; text: string } {
  const title = decodeEntities(
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "Public webpage",
  ).slice(0, 250);
  const text = decodeEntities(
    html
      .replace(
        /<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi,
        " ",
      )
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|section)>|<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
  return { title, text };
}

async function fetchPublicDocument(
  value: unknown,
  permittedUrls: ReadonlySet<string>,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<{
  title: string;
  url: string;
  text: string;
  truncated: boolean;
  html: string | null;
}> {
  let url = validatePublicUrl(value);
  if (!permittedUrls.has(url.href))
    throw new ProductError(
      400,
      "Search for this public page before reading it.",
    );
  const allowedHost = url.hostname;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await researchFetch("publisher", fetcher, url.href, {
      redirect: "manual",
      headers: {
        Accept: "text/html,text/plain,application/xhtml+xml",
        "User-Agent": "Outpredict/1.0 (public admissions information)",
      },
      signal: AbortSignal.any([
        AbortSignal.timeout(12_000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location)
        throw new ProductError(
          422,
          "The page redirected without a destination.",
        );
      url = validatePublicUrl(new URL(location, url).href);
      if (url.hostname !== allowedHost && !permittedUrls.has(url.href))
        throw new ProductError(
          422,
          "The page redirected outside the verified source.",
        );
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw researchFailure(
        "publisher",
        response.status === 404 || response.status === 410
          ? "source_gone"
          : "source_http_error",
        `This source returned HTTP ${response.status} and could not be read. Use another official source.`,
        { status: response.status },
      );
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/text\/(?:html|plain)|application\/xhtml\+xml/i.test(type)) {
      await response.body?.cancel();
      throw new ProductError(422, "The source is not a readable webpage.");
    }
    const body = await researchText("publisher", response, 1_000_000);
    const extracted = /html/i.test(type)
      ? extractHtmlText(body)
      : { title: url.hostname, text: body };
    if (extracted.text.length < 80)
      throw new ProductError(
        422,
        "The page has too little readable text; it may require JavaScript or sign-in.",
      );
    return {
      title: extracted.title,
      url: url.href,
      text: extracted.text.slice(0, 16_000),
      truncated: extracted.text.length > 16_000,
      html: /html/i.test(type) ? body : null,
    };
  }
  throw new ProductError(422, "The source redirected too many times.");
}

export async function fetchPublicPage(
  value: unknown,
  permittedUrls: ReadonlySet<string>,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<{ title: string; url: string; text: string; truncated: boolean }> {
  const { title, url, text, truncated } = await fetchPublicDocument(
    value,
    permittedUrls,
    signal,
    fetcher,
  );
  return { title, url, text, truncated };
}

/** Discover current links on a verified official entry page, not policy from memory. */
export function parseOfficialLinks(
  html: string,
  from: string,
  topic: string,
): PublicSearchResult[] {
  const base = validatePublicUrl(from);
  const words = topic
    .toLowerCase()
    .split(/\W+/)
    .filter(
      (word) =>
        word.length > 2 &&
        !["and", "the", "for", "medical", "school"].includes(word),
    );
  if (/academic|prerequisite|requirements/.test(topic))
    words.push("eligib", "prepar", "prereq", "require");
  if (/deadline|timeline/.test(topic))
    words.push("date", "deadline", "timeline");
  const ranked = new Map<
    string,
    { result: PublicSearchResult; score: number }
  >();
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    try {
      const url = validatePublicUrl(
        new URL(decodeEntities(match[1] ?? ""), base).href,
      );
      if (
        url.hostname !== base.hostname ||
        /\.(?:pdf|jpe?g|png|zip|docx?|xlsx?)$/i.test(url.pathname) ||
        url.href === base.href
      )
        continue;
      const title = decodeEntities((match[2] ?? "").replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      if (!title) continue;
      const search = `${title} ${url.pathname}`.toLowerCase();
      let score = words.reduce(
        (total, word) => total + (search.includes(word) ? 5 : 0),
        0,
      );
      if (/admission|apply|applicant/.test(search)) score += 3;
      if (/residency|fellowship|postdoc|graduate-program|nursing/.test(search))
        score -= 5;
      if (score <= 0) continue;
      const result: PublicSearchResult = {
        title,
        url: url.href,
        content: "",
        method: "official_site",
        discoveredFrom: base.href,
        discoveredAt: new Date().toISOString(),
      };
      if ((ranked.get(url.href)?.score ?? -Infinity) < score)
        ranked.set(url.href, { result, score });
    } catch {
      /* Unsafe or non-web links never become fetch permissions. */
    }
  }
  return [...ranked.values()]
    .sort(
      (a, b) => b.score - a.score || a.result.url.localeCompare(b.result.url),
    )
    .slice(0, 5)
    .map((row) => row.result);
}

export async function discoverOfficialPages(
  query: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<PublicSearchResult[]> {
  const entry = [...officialSiteDirectory]
    .sort((a, b) => b.institution.length - a.institution.length)
    .find((row) => query.startsWith(`${row.institution} `));
  if (!entry)
    throw new ProductError(
      503,
      "An official entry page is not yet verified for this institution. Share its official admissions URL so it can be read directly.",
      "official_entry_unavailable",
    );
  const results = new Map<string, PublicSearchResult>();
  const entryUrls = entry.urls.map((url) => validatePublicUrl(url).href);
  let lastError: unknown;
  for (const entryUrl of entryUrls.slice(0, 2)) {
    try {
      let page: Awaited<ReturnType<typeof fetchPublicDocument>>;
      try {
        page = await fetchPublicDocument(
          entryUrl,
          new Set(entryUrls),
          signal,
          fetcher,
        );
      } catch (error) {
        const root = `${new URL(entryUrl).origin}/`;
        if (
          !(error instanceof ProductError) ||
          error.code !== "source_gone" ||
          root === entryUrl
        )
          throw error;
        // A stale directory path permits one same-host root fallback, never a
        // challenge/timeout retry or a manufactured cross-host destination.
        page = await fetchPublicDocument(
          root,
          new Set([root]),
          signal,
          fetcher,
        );
      }
      for (const result of parseOfficialLinks(
        page.html ?? "",
        page.url,
        query.slice(entry.institution.length),
      ).slice(0, 4))
        results.set(result.url, result);
      results.set(page.url, {
        title: page.title,
        url: page.url,
        content: "",
        method: "official_site",
        discoveredFrom: page.url,
        discoveredAt: new Date().toISOString(),
      });
    } catch (error) {
      lastError = error;
    }
  }
  if (!results.size)
    throw (
      lastError ??
      new ProductError(
        503,
        "No readable official entry page was available.",
        "official_entry_unavailable",
      )
    );
  return [...results.values()].slice(0, 5);
}

export function webSource(
  id: string,
  result: PublicSearchResult,
  observedAt = new Date().toISOString(),
): Source {
  return {
    id,
    kind: isOfficialUrl(new URL(result.url)) ? "official" : "web",
    title: result.title,
    url: result.url,
    excerpt: result.content,
    observedAt,
  };
}
