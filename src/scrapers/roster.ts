import axios from "axios";
import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { cleanText } from "../utils/text";

const BASE_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const PLAYER_PROFILE_PATH_RE = /\/sport[s]?\/[^/]+\/roster\/(?!coaches\/|staff\/)[^?#]+/i;
const NON_PLAYER_ROLE_RE =
  /\b(coach|director|coordinator|operations|development|analytics|strength|conditioning|trainer|manager|staff|support|volunteer|graduate assistant|ga)\b/i;
const PROFILE_CONTAINER_SELECTOR = [
  ".s-person-card",
  ".s-person-details",
  "tr",
  "li",
  "article",
  "[class*='roster'][class*='player']",
  "[class*='player-card']",
  "[class*='athlete']",
].join(", ");

interface CandidatePlayerRecord {
  profileUrl: string | null;
  name: string | null;
  number: string | null;
  photoUrl: string | null;
  fields: Map<string, string>;
}

export interface ScrapeRosterOptions {
  url: string;
  timeoutMs?: number;
}

export interface ScrapedRosterPlayer {
  key: string;
  profileUrl: string | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  number: string | null;
  photoUrl: string | null;
  position: string | null;
  classYear: string | null;
  height: string | null;
  weight: string | null;
  bats: string | null;
  throws: string | null;
  hometown: string | null;
  from: string | null;
  lastSchool: string | null;
  previousSchool: string | null;
  previousSchools: string[];
  sourceFields: Record<string, string>;
}

export interface ScrapedRosterPayload {
  sourceUrl: string;
  fetchedAt: string;
  pageTitle: string | null;
  teamName: string | null;
  sport: string | null;
  season: string | null;
  playerCount: number;
  parser: {
    strategy: "profile-links" | "table-fallback";
    candidateRecords: number;
    dedupedRecords: number;
  };
  players: ScrapedRosterPlayer[];
}

export async function scrapeRosterPage(options: ScrapeRosterOptions): Promise<ScrapedRosterPayload> {
  const sourceUrl = new URL(options.url).toString();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1_000, Math.floor(options.timeoutMs ?? 0)) : 25_000;

  const response = await axios.get<string>(sourceUrl, {
    headers: BASE_BROWSER_HEADERS,
    timeout: timeoutMs,
    responseType: "text",
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const html = response.data;
  const $ = load(html);
  const pageTitle = cleanText($("title").first().text()) || null;

  const inferred = inferMetaFromPage($, sourceUrl, pageTitle);

  let strategy: "profile-links" | "table-fallback" = "profile-links";
  let candidates = extractPlayersFromProfileLinks($, sourceUrl);
  if (candidates.length === 0) {
    strategy = "table-fallback";
    candidates = extractPlayersFromTables($, sourceUrl);
  }

  const merged = mergeCandidateRecords(candidates);
  await enrichCandidateRecordsFromProfiles(merged, timeoutMs);
  const players = merged
    .map((record) => toScrapedPlayer(record))
    .filter((player): player is ScrapedRosterPlayer => player !== null)
    .sort(comparePlayers);

  return {
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    pageTitle,
    teamName: inferred.teamName,
    sport: inferred.sport,
    season: inferred.season,
    playerCount: players.length,
    parser: {
      strategy,
      candidateRecords: candidates.length,
      dedupedRecords: merged.length,
    },
    players,
  };
}

function extractPlayersFromProfileLinks($: CheerioAPI, pageUrl: string): CandidatePlayerRecord[] {
  const anchors = $("a[href]")
    .toArray()
    .filter((node) => isPlayerProfileHref($(node).attr("href")));

  const seenContainers = new Set<AnyNode>();
  const records: CandidatePlayerRecord[] = [];

  for (const anchor of anchors) {
    const containerElement = resolveClosestPlayerContainer($, anchor);
    if (containerElement && seenContainers.has(containerElement)) {
      continue;
    }

    if (containerElement) {
      seenContainers.add(containerElement);
    }

    const container = containerElement ? $(containerElement) : $(anchor);
    const record = extractCandidateFromContainer($, container, pageUrl);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

function resolveClosestPlayerContainer($: CheerioAPI, anchor: AnyNode): AnyNode | null {
  const closest = $(anchor).closest(PROFILE_CONTAINER_SELECTOR).first();
  if (closest.length > 0) {
    return closest.get(0) ?? null;
  }

  const parent = $(anchor).parent();
  if (parent.length > 0) {
    return parent.get(0) ?? null;
  }

  return null;
}

function extractCandidateFromContainer(
  $: CheerioAPI,
  container: Cheerio<AnyNode>,
  pageUrl: string
): CandidatePlayerRecord | null {
  const profileUrl = findPrimaryProfileUrl($, container, pageUrl);
  if (!profileUrl) {
    return null;
  }

  const fields = extractLabeledFields($, container);
  const name = findPlayerName($, container, profileUrl);
  const numberFromLabel = getFieldValue(fields, isNumberLabel);
  const number = parseJerseyNumber(numberFromLabel) ?? parseJerseyNumber(container.text());
  const photoUrl = extractPhotoUrl(container, pageUrl);

  return {
    profileUrl,
    name,
    number,
    photoUrl,
    fields,
  };
}

function findPrimaryProfileUrl($: CheerioAPI, container: Cheerio<AnyNode>, pageUrl: string): string | null {
  const profileHref = container
    .find("a[href]")
    .toArray()
    .map((node) => cleanText($(node).attr("href")))
    .find((href) => isPlayerProfileHref(href));

  if (!profileHref) {
    return null;
  }

  return toAbsoluteUrl(profileHref, pageUrl);
}

function extractPhotoUrl(container: Cheerio<AnyNode>, pageUrl: string): string | null {
  const image = container.find("img").first();
  if (image.length === 0) {
    return null;
  }

  const raw =
    cleanText(image.attr("src")) ||
    cleanText(image.attr("data-src")) ||
    cleanText(image.attr("data-lazy-src")) ||
    cleanText(image.attr("data-original"));

  if (!raw) {
    const srcset = cleanText(image.attr("srcset"));
    if (!srcset) {
      return null;
    }
    const firstSrcset = srcset.split(",").map((entry) => cleanText(entry.split(" ")[0])).find(Boolean);
    if (!firstSrcset) {
      return null;
    }
    return unwrapSidearmCropUrl(toAbsoluteUrl(firstSrcset, pageUrl), pageUrl);
  }

  return unwrapSidearmCropUrl(toAbsoluteUrl(raw, pageUrl), pageUrl);
}

function unwrapSidearmCropUrl(rawUrl: string, pageUrl: string): string {
  try {
    const parsed = new URL(rawUrl, pageUrl);
    const source = parsed.searchParams.get("url");
    if (!source) {
      return parsed.toString();
    }
    return toAbsoluteUrl(source, pageUrl);
  } catch {
    return rawUrl;
  }
}

function extractLabeledFields($: CheerioAPI, container: Cheerio<AnyNode>): Map<string, string> {
  const fields = new Map<string, string>();

  container.find(".sr-only").each((_, srNode) => {
    const label = cleanText($(srNode).text());
    if (!isLikelyDataLabel(label)) {
      return;
    }

    const parent = $(srNode).parent();
    let value = cleanText(parent.clone().find(".sr-only").remove().end().text());
    value = stripRepeatedLabelPrefix(value, label);

    if (!value) {
      const siblingValue = cleanText(parent.next().text());
      if (siblingValue) {
        value = siblingValue;
      }
    }

    if (!value) {
      return;
    }

    setLabeledField(fields, label, value);
  });

  container.find("dt").each((_, dtNode) => {
    const label = cleanText($(dtNode).text());
    if (!isLikelyDataLabel(label)) {
      return;
    }

    const dd = $(dtNode).next("dd");
    if (dd.length === 0) {
      return;
    }

    const value = cleanText(dd.text());
    if (!value) {
      return;
    }

    setLabeledField(fields, label, value);
  });

  container.find("[class*='field-label']").each((_, labelNode) => {
    const label = cleanText($(labelNode).text());
    if (!isLikelyDataLabel(label)) {
      return;
    }

    const parent = $(labelNode).parent();
    let value =
      cleanText($(labelNode).siblings("[class*='field-value']").first().text()) ||
      cleanText(parent.find("[class*='field-value']").first().text());

    if (!value) {
      value = cleanText(parent.clone().find("[class*='field-label']").remove().end().text());
      value = stripRepeatedLabelPrefix(value, label);
    }

    if (!value) {
      const rowValue = cleanText($(labelNode).closest("li, tr, .columns, .row, div").text());
      value = stripRepeatedLabelPrefix(rowValue, label);
    }

    if (!value) {
      return;
    }

    setLabeledField(fields, label, value);
  });

  return fields;
}

function setLabeledField(fields: Map<string, string>, label: string, value: string): void {
  const existing = fields.get(label);
  if (!existing || value.length > existing.length) {
    fields.set(label, value);
  }
}

function stripRepeatedLabelPrefix(value: string, label: string): string {
  if (!value) {
    return "";
  }

  const escaped = escapeRegExp(label);
  let current = value;

  for (let index = 0; index < 3; index += 1) {
    const stripped = current.replace(new RegExp(`^${escaped}\\s*:?\\s*`, "i"), "").trim();
    if (stripped === current) {
      break;
    }
    current = stripped;
  }

  return current;
}

function isLikelyDataLabel(label: string): boolean {
  if (!label) {
    return false;
  }

  if (/^(for|expand|collapse|open|close)\b/i.test(label)) {
    return false;
  }

  if (/^(phone|email)$/i.test(label)) {
    return false;
  }

  return true;
}

function findPlayerName($: CheerioAPI, container: Cheerio<AnyNode>, profileUrl: string): string | null {
  const headingSelectors = [
    "h1",
    "h2",
    "h3",
    "h4",
    "[itemprop='name']",
    "[data-test-id*='personal-single-line-person-link']",
  ];

  for (const selector of headingSelectors) {
    const text = cleanPersonName(cleanText(container.find(selector).first().text()));
    if (isLikelyPersonName(text)) {
      return text;
    }
  }

  const anchorTexts = container
    .find("a[href]")
    .toArray()
    .filter((node) => isPlayerProfileHref($(node).attr("href")))
    .map((node) => cleanPersonName(cleanText($(node).text())))
    .filter((entry) => isLikelyPersonName(entry));

  if (anchorTexts.length > 0) {
    return anchorTexts[0];
  }

  return inferNameFromProfileUrl(profileUrl);
}

function cleanPersonName(value: string): string {
  const withoutJersey = value.replace(/\bJersey Number\b.*$/i, "");
  return cleanText(withoutJersey);
}

function isLikelyPersonName(value: string): boolean {
  if (!value) {
    return false;
  }

  if (value.length < 2 || value.length > 80) {
    return false;
  }

  if (/^(position|academic year|height|weight|hometown|last school|previous school)$/i.test(value)) {
    return false;
  }

  return /[A-Za-z]/.test(value);
}

function inferNameFromProfileUrl(profileUrl: string): string | null {
  try {
    const parsed = new URL(profileUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const rosterIndex = parts.findIndex((segment) => segment.toLowerCase() === "roster");
    if (rosterIndex < 0 || rosterIndex + 1 >= parts.length) {
      return null;
    }

    const slug = parts[rosterIndex + 1];
    const nameSlug = slug.replace(/\d+$/g, "");
    const tokens = nameSlug
      .split("-")
      .map((token) => cleanText(token))
      .filter(Boolean);
    if (tokens.length === 0) {
      return null;
    }

    return tokens.map(toTitle).join(" ");
  } catch {
    return null;
  }
}

function extractPlayersFromTables($: CheerioAPI, pageUrl: string): CandidatePlayerRecord[] {
  const records: CandidatePlayerRecord[] = [];

  $("table").each((_, tableNode) => {
    const table = $(tableNode);
    const headerRow = table.find("thead tr").first().length ? table.find("thead tr").first() : table.find("tr").first();
    if (headerRow.length === 0) {
      return;
    }

    const headers = headerRow
      .find("th, td")
      .toArray()
      .map((cell) => cleanText($(cell).text()));
    const normalizedHeaders = headers.map((header) => normalizeLabel(header));

    const hasNameColumn = normalizedHeaders.some((header) => header === "name" || header.includes("player"));
    const hasRosterSignals = normalizedHeaders.some(
      (header) =>
        header === "position" ||
        header === "pos" ||
        header.includes("year") ||
        header.includes("class") ||
        header.includes("number") ||
        header === "no"
    );

    if (!hasNameColumn || !hasRosterSignals) {
      return;
    }

    const rows = table.find("tbody tr").length > 0 ? table.find("tbody tr").toArray() : table.find("tr").toArray().slice(1);

    for (const rowNode of rows) {
      const row = $(rowNode);
      const cells = row.find("td").toArray();
      if (cells.length === 0) {
        continue;
      }

      const fields = new Map<string, string>();
      for (let index = 0; index < cells.length && index < headers.length; index += 1) {
        const label = headers[index];
        const value = cleanText($(cells[index]).text());
        if (!label || !value) {
          continue;
        }
        setLabeledField(fields, label, value);
      }

      const link = row
        .find("a[href]")
        .toArray()
        .map((node) => cleanText($(node).attr("href")))
        .find((href) => isPlayerProfileHref(href));

      const profileUrl = link ? toAbsoluteUrl(link, pageUrl) : null;
      const name =
        cleanPersonName(cleanText(row.find("a").first().text())) ||
        getFieldValue(fields, (label) => label === "name" || label.includes("player"));

      if (!name) {
        continue;
      }

      const number = parseJerseyNumber(getFieldValue(fields, isNumberLabel));
      const photoUrl = extractPhotoUrl(row, pageUrl);

      records.push({
        profileUrl,
        name,
        number,
        photoUrl,
        fields,
      });
    }
  });

  return records;
}

function mergeCandidateRecords(records: CandidatePlayerRecord[]): CandidatePlayerRecord[] {
  const byKey = new Map<string, CandidatePlayerRecord>();

  for (const record of records) {
    const key = buildMergeKey(record);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        profileUrl: record.profileUrl,
        name: record.name,
        number: record.number,
        photoUrl: record.photoUrl,
        fields: new Map(record.fields),
      });
      continue;
    }

    if (!existing.profileUrl && record.profileUrl) {
      existing.profileUrl = record.profileUrl;
    }
    if (!existing.name && record.name) {
      existing.name = record.name;
    }
    if (!existing.number && record.number) {
      existing.number = record.number;
    }
    if (!existing.photoUrl && record.photoUrl) {
      existing.photoUrl = record.photoUrl;
    }

    for (const [label, value] of record.fields.entries()) {
      setLabeledField(existing.fields, label, value);
    }
  }

  return Array.from(byKey.values());
}

async function enrichCandidateRecordsFromProfiles(records: CandidatePlayerRecord[], timeoutMs: number): Promise<void> {
  const profiles = records.filter((record) => record.profileUrl);
  if (profiles.length === 0) {
    return;
  }

  await runWithConcurrency(profiles, 6, async (record) => {
    if (!record.profileUrl) {
      return;
    }

    const details = await scrapePlayerProfile(record.profileUrl, timeoutMs);
    if (!details) {
      return;
    }

    if (details.name && !record.name) {
      record.name = details.name;
    }
    if (details.number && !record.number) {
      record.number = details.number;
    }
    if (details.photoUrl && !record.photoUrl) {
      record.photoUrl = details.photoUrl;
    }

    for (const [label, value] of details.fields.entries()) {
      setLabeledField(record.fields, label, value);
    }
  });
}

async function scrapePlayerProfile(profileUrl: string, timeoutMs: number): Promise<CandidatePlayerRecord | null> {
  try {
    const response = await axios.get<string>(profileUrl, {
      headers: BASE_BROWSER_HEADERS,
      timeout: timeoutMs,
      responseType: "text",
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const $ = load(response.data);
    const header = $(".sidearm-roster-player-header").first();
    const detailsContainer = $(".sidearm-roster-player-header-details").first();
    const fieldsContainer = $(".sidearm-roster-player-fields").first();
    const parseRoot = fieldsContainer.length > 0 ? fieldsContainer : detailsContainer.length > 0 ? detailsContainer : header;

    const fields = extractLabeledFields($, parseRoot);
    const name = findProfileName($);
    const number = parseJerseyNumber(findProfileJerseyNumber($)) ?? parseJerseyNumber(getFieldValue(fields, isNumberLabel));
    const photoUrl = extractProfilePhotoUrl($, profileUrl);

    return {
      profileUrl,
      name,
      number,
      photoUrl,
      fields,
    };
  } catch {
    return null;
  }
}

function findProfileName($: CheerioAPI): string | null {
  const firstName = cleanText($(".sidearm-roster-player-first-name").first().text());
  const lastName = cleanText($(".sidearm-roster-player-last-name").first().text());
  const combined = cleanPersonName(`${firstName} ${lastName}`.trim());
  if (isLikelyPersonName(combined)) {
    return combined;
  }

  const fallback = cleanPersonName(cleanText($(".sidearm-roster-player-name").first().text()));
  if (isLikelyPersonName(fallback)) {
    return fallback;
  }

  return null;
}

function findProfileJerseyNumber($: CheerioAPI): string | null {
  const jerseyText = cleanText($(".sidearm-roster-player-jersey-number").first().text());
  if (jerseyText) {
    return jerseyText;
  }

  const labelNode = $(".sidearm-roster-player-field-label")
    .toArray()
    .find((node) => /^(number|jersey number|no\.?)$/i.test(cleanText($(node).text())));
  if (!labelNode) {
    return null;
  }

  return cleanText(
    $(labelNode)
      .siblings("[class*='field-value'], span")
      .not(labelNode)
      .first()
      .text()
  );
}

function extractProfilePhotoUrl($: CheerioAPI, pageUrl: string): string | null {
  const profileImage = $(".sidearm-roster-player-image img").first();
  if (profileImage.length > 0) {
    const raw =
      cleanText(profileImage.attr("src")) ||
      cleanText(profileImage.attr("data-src")) ||
      cleanText(profileImage.attr("data-lazy-src")) ||
      cleanText(profileImage.attr("data-original"));
    if (raw) {
      return unwrapSidearmCropUrl(toAbsoluteUrl(raw, pageUrl), pageUrl);
    }
  }

  return null;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const size = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;

  const runners = Array.from({ length: size }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
}

function buildMergeKey(record: CandidatePlayerRecord): string {
  if (record.profileUrl) {
    return `profile:${record.profileUrl}`;
  }

  const nameKey = cleanText(record.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const numberKey = cleanText(record.number || "");
  return `fallback:${nameKey || "unknown"}:${numberKey || "na"}`;
}

function toScrapedPlayer(record: CandidatePlayerRecord): ScrapedRosterPlayer | null {
  const name = cleanText(record.name || "");
  if (!name) {
    return null;
  }

  const sourceFields = Object.fromEntries(
    Array.from(record.fields.entries())
      .map(([label, value]) => [cleanText(label), cleanText(value)])
      .filter(([label, value]) => label.length > 0 && value.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
  );

  const number = record.number ?? parseJerseyNumber(getFieldValue(record.fields, isNumberLabel));
  const position = cleanNullable(getFieldValue(record.fields, isPositionLabel));
  if (isLikelyNonPlayerRecord(name, position, record.fields, number)) {
    return null;
  }

  const classYear = cleanNullable(getFieldValue(record.fields, isClassLabel));
  const { height, weight } = resolveHeightWeight(record.fields);
  const hometown = cleanNullable(getFieldValue(record.fields, isHometownLabel));
  const lastSchool = cleanNullable(getFieldValue(record.fields, isLastSchoolLabel));
  const previousSchoolRaw = cleanNullable(getFieldValue(record.fields, isPreviousSchoolLabel));

  const handedness = resolveHandedness(record.fields);
  const previousSchools = toPreviousSchoolList(previousSchoolRaw);

  const nameParts = splitPersonName(name);
  const key = buildPlayerKey(record.profileUrl, name, number);

  return {
    key,
    profileUrl: record.profileUrl,
    name,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    number: number ?? null,
    photoUrl: record.photoUrl,
    position,
    classYear,
    height,
    weight,
    bats: handedness.bats,
    throws: handedness.throws,
    hometown,
    from: hometown,
    lastSchool,
    previousSchool: previousSchools.length > 0 ? previousSchools[previousSchools.length - 1] : null,
    previousSchools,
    sourceFields,
  };
}

function isLikelyNonPlayerRecord(
  name: string,
  position: string | null,
  fields: Map<string, string>,
  number: string | null
): boolean {
  const normalizedName = cleanText(name);
  const normalizedPosition = cleanText(position || "");

  if (NON_PLAYER_ROLE_RE.test(normalizedName)) {
    return true;
  }

  if (normalizedPosition && NON_PLAYER_ROLE_RE.test(normalizedPosition)) {
    return true;
  }

  if (isLikelyPlayerPosition(normalizedPosition)) {
    return false;
  }

  const directBats = cleanNullable(getFieldValue(fields, isBatsOnlyLabel));
  const directThrows = cleanNullable(getFieldValue(fields, isThrowsOnlyLabel));
  const combinedRaw = cleanNullable(getFieldValue(fields, isCombinedHandednessLabel)) || "";
  const combined = parseCombinedHandedness(combinedRaw, "bats throws");
  const hasHandedness = Boolean(directBats || directThrows || combined.bats || combined.throws);

  if (!number && !hasHandedness) {
    return true;
  }

  return false;
}

function isLikelyPlayerPosition(position: string): boolean {
  const normalized = cleanText(position || "").toLowerCase();
  if (!normalized) {
    return false;
  }

  if (NON_PLAYER_ROLE_RE.test(normalized)) {
    return false;
  }

  const compact = normalized.replace(/\s+/g, "");
  if (
    /^(rhp|lhp|p|c|1b|2b|3b|ss|inf|of|lf|cf|rf|dh|utl|util)(\/(rhp|lhp|p|c|1b|2b|3b|ss|inf|of|lf|cf|rf|dh|utl|util))*$/i.test(
      compact
    )
  ) {
    return true;
  }

  if (/\b(pitcher|catcher|infielder|outfielder|utility|designated hitter)\b/i.test(normalized)) {
    return true;
  }

  return false;
}

function resolveHandedness(fields: Map<string, string>): { bats: string | null; throws: string | null } {
  let bats: string | null = null;
  let throwsHand: string | null = null;

  for (const [label, rawValue] of fields.entries()) {
    const value = cleanText(rawValue);
    if (!value) {
      continue;
    }

    const normalizedLabel = normalizeLabel(label);
    if (isBatsOnlyLabel(normalizedLabel)) {
      bats = bats ?? normalizeHandValue(value);
      continue;
    }
    if (isThrowsOnlyLabel(normalizedLabel)) {
      throwsHand = throwsHand ?? normalizeHandValue(value);
      continue;
    }

    if (isCombinedHandednessLabel(normalizedLabel)) {
      const parsed = parseCombinedHandedness(value, normalizedLabel);
      bats = bats ?? parsed.bats;
      throwsHand = throwsHand ?? parsed.throws;
    }
  }

  return {
    bats: bats ?? null,
    throws: throwsHand ?? null,
  };
}

function resolveHeightWeight(fields: Map<string, string>): { height: string | null; weight: string | null } {
  let height = cleanNullable(getFieldValue(fields, isHeightLabel));
  let weight = cleanNullable(getFieldValue(fields, isWeightLabel));

  if (!height || !weight) {
    const combinedRaw = cleanNullable(getFieldValue(fields, isCombinedHeightWeightLabel));
    const combined = parseCombinedHeightWeight(combinedRaw);
    height = height ?? combined.height;
    weight = weight ?? combined.weight;
  }

  return { height: height ?? null, weight: weight ?? null };
}

function parseCombinedHeightWeight(rawValue: string | null): { height: string | null; weight: string | null } {
  const value = cleanText(rawValue || "");
  if (!value) {
    return { height: null, weight: null };
  }

  const slashMatch = value.match(/([0-9]{1,2}\s*[-']\s*[0-9]{1,2})\s*(?:\/|\|)\s*([0-9]{2,3})/i);
  if (slashMatch) {
    return {
      height: cleanText(slashMatch[1].replace(/\s+/g, "")),
      weight: cleanText(slashMatch[2]),
    };
  }

  const tokens = value
    .split(/\s*\/\s*|\s*\|\s*|\s+-\s+/)
    .map((entry) => cleanText(entry))
    .filter(Boolean);
  if (tokens.length >= 2) {
    const maybeHeight = tokens[0].match(/[0-9]{1,2}\s*[-']\s*[0-9]{1,2}/) ? cleanText(tokens[0].replace(/\s+/g, "")) : null;
    const maybeWeight = tokens[1].match(/[0-9]{2,3}/) ? cleanText(tokens[1].match(/[0-9]{2,3}/)?.[0] || "") : null;
    return {
      height: maybeHeight,
      weight: maybeWeight,
    };
  }

  return { height: null, weight: null };
}

function parseCombinedHandedness(
  rawValue: string,
  normalizedLabel: string
): { bats: string | null; throws: string | null } {
  const upper = cleanText(rawValue).toUpperCase();
  const match = upper.match(/\b([RLBS])\s*[/|-]\s*([RLBS])\b/);
  if (!match) {
    return { bats: null, throws: null };
  }

  const first = normalizeHandValue(match[1]);
  const second = normalizeHandValue(match[2]);
  if (!first || !second) {
    return { bats: null, throws: null };
  }

  if (normalizedLabel.includes("throws bats")) {
    return { bats: second, throws: first };
  }

  return { bats: first, throws: second };
}

function normalizeHandValue(value: string): string | null {
  const clean = cleanText(value).toLowerCase();
  if (!clean) {
    return null;
  }

  if (clean.startsWith("r")) {
    return "R";
  }
  if (clean.startsWith("l")) {
    return "L";
  }
  if (clean.startsWith("s")) {
    return "S";
  }
  if (clean.startsWith("b")) {
    return "B";
  }

  return null;
}

function toPreviousSchoolList(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  const stripped = raw.replace(/^previous school\s*:\s*/i, "").trim();
  if (!stripped) {
    return [];
  }

  return Array.from(
    new Set(
      stripped
        .split(/\s*;\s*|\s*\|\s*|\s+\/\s+/)
        .map((entry) => cleanText(entry))
        .filter(Boolean)
    )
  );
}

function splitPersonName(name: string): { firstName: string | null; lastName: string | null } {
  const tokens = cleanText(name).split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return { firstName: null, lastName: null };
  }

  if (tokens.length === 1) {
    return { firstName: tokens[0], lastName: null };
  }

  return {
    firstName: tokens.slice(0, -1).join(" "),
    lastName: tokens[tokens.length - 1],
  };
}

function buildPlayerKey(profileUrl: string | null, name: string, number: string | null): string {
  if (profileUrl) {
    return profileUrl;
  }

  const nameKey = cleanText(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const numberKey = cleanText(number || "");
  return `player:${nameKey || "unknown"}:${numberKey || "na"}`;
}

function parseJerseyNumber(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const match = cleanText(value).match(/\b(\d{1,3})\b/);
  if (!match) {
    return null;
  }

  return match[1];
}

function comparePlayers(a: ScrapedRosterPlayer, b: ScrapedRosterPlayer): number {
  const aNumber = toSortNumber(a.number);
  const bNumber = toSortNumber(b.number);
  if (aNumber !== bNumber) {
    return aNumber - bNumber;
  }

  const aLast = cleanText(a.lastName || a.name);
  const bLast = cleanText(b.lastName || b.name);
  const byLast = aLast.localeCompare(bLast);
  if (byLast !== 0) {
    return byLast;
  }

  return cleanText(a.name).localeCompare(cleanText(b.name));
}

function toSortNumber(value: string | null): number {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return Number.MAX_SAFE_INTEGER;
  }

  return parsed;
}

function getFieldValue(fields: Map<string, string>, predicate: (normalizedLabel: string) => boolean): string | null {
  for (const [label, value] of fields.entries()) {
    const normalized = normalizeLabel(label);
    if (predicate(normalized)) {
      return cleanText(value);
    }
  }

  return null;
}

function normalizeLabel(label: string): string {
  return cleanText(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isNumberLabel(normalizedLabel: string): boolean {
  return (
    normalizedLabel === "jersey number" ||
    normalizedLabel === "number" ||
    normalizedLabel === "no" ||
    normalizedLabel === "num"
  );
}

function isPositionLabel(normalizedLabel: string): boolean {
  return normalizedLabel === "position" || normalizedLabel === "pos";
}

function isClassLabel(normalizedLabel: string): boolean {
  return (
    normalizedLabel === "academic year" ||
    normalizedLabel === "class" ||
    normalizedLabel === "year" ||
    normalizedLabel === "yr"
  );
}

function isHeightLabel(normalizedLabel: string): boolean {
  return normalizedLabel === "height" || normalizedLabel === "ht";
}

function isWeightLabel(normalizedLabel: string): boolean {
  return normalizedLabel === "weight" || normalizedLabel === "wt";
}

function isCombinedHeightWeightLabel(normalizedLabel: string): boolean {
  return normalizedLabel === "ht wt" || normalizedLabel === "height weight";
}

function isHometownLabel(normalizedLabel: string): boolean {
  return normalizedLabel === "hometown" || normalizedLabel === "home town" || normalizedLabel === "from";
}

function isLastSchoolLabel(normalizedLabel: string): boolean {
  return (
    normalizedLabel === "last school" ||
    normalizedLabel === "high school" ||
    normalizedLabel.includes("last school") ||
    normalizedLabel.includes("high school")
  );
}

function isPreviousSchoolLabel(normalizedLabel: string): boolean {
  return (
    normalizedLabel === "previous school" ||
    normalizedLabel === "previous schools" ||
    normalizedLabel === "prev school" ||
    normalizedLabel.includes("previous school")
  );
}

function isCombinedHandednessLabel(normalizedLabel: string): boolean {
  return (
    normalizedLabel === "b t" ||
    normalizedLabel === "bats throws" ||
    normalizedLabel === "throws bats" ||
    normalizedLabel === "custom field 1" ||
    normalizedLabel === "custom field" ||
    normalizedLabel === "handedness"
  );
}

function isBatsOnlyLabel(normalizedLabel: string): boolean {
  return normalizedLabel === "bats" || normalizedLabel === "batting hand";
}

function isThrowsOnlyLabel(normalizedLabel: string): boolean {
  return normalizedLabel === "throws" || normalizedLabel === "throwing hand";
}

function inferMetaFromPage(
  $: CheerioAPI,
  sourceUrl: string,
  title: string | null
): { teamName: string | null; sport: string | null; season: string | null } {
  const titleText = cleanText(title || "");
  const titleParts = titleText.split(" - ").map((part) => cleanText(part)).filter(Boolean);

  const firstPart = titleParts[0] || "";
  const seasonMatch = firstPart.match(/\b(19|20)\d{2}\b/);
  const season = seasonMatch ? seasonMatch[0] : null;

  const sport = cleanText(
    firstPart
      .replace(/\b(19|20)\d{2}\b/g, "")
      .replace(/\broster\b/i, "")
  );

  const ogSiteName = cleanText($("meta[property='og:site_name']").attr("content")) || null;
  const teamFromTitle = titleParts.length > 1 ? titleParts[titleParts.length - 1] : null;
  const teamName = teamFromTitle || ogSiteName || inferTeamFromHost(sourceUrl);

  return {
    teamName: teamName || null,
    sport: sport || null,
    season,
  };
}

function inferTeamFromHost(sourceUrl: string): string | null {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    const firstLabel = host.split(".")[0] || "";
    if (!firstLabel) {
      return null;
    }
    return firstLabel
      .split("-")
      .map((token) => toTitle(token))
      .join(" ");
  } catch {
    return null;
  }
}

function toAbsoluteUrl(raw: string, baseUrl: string): string {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function isPlayerProfileHref(href: string | null | undefined): boolean {
  const cleanHref = cleanText(href || "");
  if (!cleanHref || cleanHref.startsWith("#")) {
    return false;
  }

  let path = cleanHref;
  try {
    path = new URL(cleanHref, "https://example.com").pathname;
  } catch {
    path = cleanHref;
  }

  if (!PLAYER_PROFILE_PATH_RE.test(path)) {
    return false;
  }

  return !/\/roster\/(?:coaches|staff)\//i.test(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTitle(value: string): string {
  return String(value)
    .toLowerCase()
    .split(/(\s+|-|')/)
    .map((token) => (/^[\s-']+$/.test(token) ? token : token.charAt(0).toUpperCase() + token.slice(1)))
    .join("");
}

function cleanNullable(value: string | null): string | null {
  const clean = cleanText(value || "");
  if (!clean || clean === "-" || /^n\/a$/i.test(clean)) {
    return null;
  }
  return clean;
}
