const EASTERN_TZ = "America/New_York";

export function normalizeScoreDate(input?: string): string {
  if (!input || input.trim().length === 0) {
    return todayInEastern();
  }

  const clean = input.trim();
  if (/^\d{8}$/.test(clean)) {
    return clean;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean.replace(/-/g, "");
  }

  throw new Error("Invalid date format. Use YYYYMMDD or YYYY-MM-DD.");
}

function todayInEastern(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = findPart(parts, "year");
  const month = findPart(parts, "month");
  const day = findPart(parts, "day");

  return `${year}${month}${day}`;
}

function findPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const found = parts.find((part) => part.type === type);
  if (!found) {
    throw new Error(`Date part not found: ${type}`);
  }

  return found.value;
}
