import type { gmail_v1 } from "googleapis";

/** Build a case-insensitive header lookup map from a Gmail message part. */
export function headersToMap(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers ?? []) {
    if (h.name && h.value) m.set(h.name.toLowerCase(), h.value);
  }
  return m;
}

/** Split a comma-separated address list header into an array. */
export function parseAddressList(
  value: string | undefined,
): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalize a Date-header string to ISO. Returns undefined on bad input. */
export function toIso(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Recursively pull out the first body matching the given mime type. */
export function collectPart(
  part: gmail_v1.Schema$MessagePart,
  mime: string,
): string {
  if (part.mimeType === mime && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = collectPart(child, mime);
    if (found) return found;
  }
  return "";
}
