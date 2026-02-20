import he from "he";

export function cleanText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  return he
    .decode(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseInteger(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const clean = cleanText(value).replace(/,/g, "");
  if (!/^-?\d+$/.test(clean)) {
    return null;
  }

  return Number.parseInt(clean, 10);
}

export function parseBoolean(value: string | null | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
