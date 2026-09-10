import { ProductError, type Source } from "./product-types";

export type PublicSearchResult = {
  title: string;
  url: string;
  content: string;
};
type Fetcher = typeof fetch;

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

export function isOfficialUrl(url: URL): boolean {
  return (
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
  if (!apiKey) return discoverPublicPages(query, signal, fetcher);
  const response = await fetcher("https://api.tavily.com/search", {
    method: "POST",
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
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProductError(
      503,
      "Live search could not complete. Try again or share an official school webpage.",
      "search_unavailable",
    );
  }
  const body: unknown = JSON.parse(await readBoundedText(response, 200_000));
  if (!body || typeof body !== "object" || !("results" in body))
    throw new ProductError(503, "Search returned an unreadable response.");
  if (!Array.isArray(body.results))
    throw new ProductError(503, "Search returned an unreadable response.");
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

async function discoverPublicPages(
  query: string,
  signal: AbortSignal | undefined,
  fetcher: Fetcher,
): Promise<PublicSearchResult[]> {
  // html.duckduckgo.com explicitly allows crawling in its own robots.txt.
  // No authentication, challenge bypass, user-agent impersonation, or retry loop.
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetcher(url.href, {
    headers: {
      Accept: "text/html",
      "User-Agent": "Outpredict/1.0 (public source discovery)",
    },
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(12_000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProductError(
      503,
      "Public source discovery is temporarily unavailable. Share an official URL or try again later.",
      "search_unavailable",
    );
  }
  const html = await readBoundedText(response, 500_000);
  const results = parseSearchLinks(html);
  if (!results.length && !/no results/i.test(html))
    throw new ProductError(
      503,
      "Public source discovery could not complete. No current information was verified.",
      "search_unavailable",
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

export async function fetchPublicPage(
  value: unknown,
  permittedUrls: ReadonlySet<string>,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<{ title: string; url: string; text: string; truncated: boolean }> {
  let url = validatePublicUrl(value);
  if (!permittedUrls.has(url.href))
    throw new ProductError(
      400,
      "Search for this public page before reading it.",
    );
  const allowedHost = url.hostname;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetcher(url.href, {
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
      throw new ProductError(
        422,
        "This source could not be read. Use another official source.",
      );
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/text\/(?:html|plain)|application\/xhtml\+xml/i.test(type)) {
      await response.body?.cancel();
      throw new ProductError(422, "The source is not a readable webpage.");
    }
    const body = await readBoundedText(response);
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
    };
  }
  throw new ProductError(422, "The source redirected too many times.");
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
