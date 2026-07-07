import { XMLParser } from "fast-xml-parser";
import type { Logger } from "pino";
import {
  type Connector,
  type ConnectorListOptions,
  type ConnectorListResult,
  type SourceDocument,
  ValidationError,
} from "@rag/core";
import { EcfrPart4Config, type EcfrPart4Config as Config } from "./config.js";

// See docs/ECFR-CONNECTOR-SPIKE.md: the REST versioner API is unreliable
// (503s up to 40s+ observed) regardless of headers, so this connector reads
// the static govinfo.gov bulk XML mirror exclusively -- no REST fallback.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface EcfrNode {
  "@_N"?: string;
  "@_TYPE"?: string;
  HEAD?: string;
  [key: string]: unknown;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// The real document nests DIV5 (part) under DIV1 (title) -> DIV3 (chapter),
// not at a fixed shallow path, so this walks the whole tree looking for a
// DIV5 with TYPE="PART" and a matching N.
function findPart(node: unknown, part: string): EcfrNode | undefined {
  if (node === null || typeof node !== "object") return undefined;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("@_")) continue;
    for (const candidate of asArray(value as EcfrNode | EcfrNode[])) {
      if (typeof candidate !== "object" || candidate === null) continue;
      if (
        key === "DIV5" &&
        candidate["@_TYPE"] === "PART" &&
        candidate["@_N"] === part
      ) {
        return candidate;
      }
      const found = findPart(candidate, part);
      if (found) return found;
    }
  }
  return undefined;
}

// Section-level DIV8 elements sit under intermediate DIV6 (subpart) nodes,
// so this recursively collects every DIV8/SECTION descendant instead of
// assuming DIV8 is a direct child of the matched part.
function collectSections(node: unknown, out: EcfrNode[]): void {
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("@_")) continue;
    for (const candidate of asArray(value as EcfrNode | EcfrNode[])) {
      if (typeof candidate !== "object" || candidate === null) continue;
      if (key === "DIV8" && candidate["@_TYPE"] === "SECTION") {
        out.push(candidate);
      } else {
        collectSections(candidate, out);
      }
    }
  }
}

function stripXmlToText(node: EcfrNode): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") parts.push(item);
        else if (typeof item === "object" && item !== null) {
          parts.push(stripXmlToText(item as EcfrNode));
        }
      }
    } else if (typeof value === "object" && value !== null) {
      parts.push(stripXmlToText(value as EcfrNode));
    }
  }
  return parts.join("\n").trim();
}

function toSectionId(rawN: string | undefined): string {
  return (rawN ?? "unknown").replace(/^§\s*/, "").trim();
}

interface FetchedXml {
  xml: string;
  lastModified: string;
}

export class EcfrPart4Connector implements Connector {
  readonly kind = "ecfr-part4";
  private readonly config: Config;
  private readonly parser = new XMLParser({ ignoreAttributes: false });

  constructor(
    rawConfig: Record<string, unknown>,
    private readonly logger: Logger,
  ) {
    this.config = EcfrPart4Config.parse(rawConfig);
  }

  private buildUrl(): string {
    return `https://www.govinfo.gov/bulkdata/ECFR/title-${this.config.title}/ECFR-title${this.config.title}.xml`;
  }

  private async fetchXml(): Promise<FetchedXml> {
    const res = await fetch(this.buildUrl(), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.status === 429 || res.status >= 500) {
      throw new Error(
        `ecfr-part4: transient error fetching bulk XML (${res.status})`,
      );
    }
    if (!res.ok) {
      throw new ValidationError(
        `ecfr-part4 connector: unexpected response fetching bulk XML (${res.status})`,
      );
    }
    const lastModified = res.headers.get("last-modified") ?? "";
    const xml = await res.text();
    return { xml, lastModified };
  }

  async validate(): Promise<void> {
    await this.fetchXml();
  }

  private parseSections(xml: string): SourceDocument[] {
    const doc = this.parser.parse(xml);
    const targetPart = findPart(doc, this.config.part);
    if (!targetPart) {
      this.logger.warn(
        { title: this.config.title, part: this.config.part },
        "ecfr-part4: target part not found in title XML",
      );
      return [];
    }

    const sections: EcfrNode[] = [];
    collectSections(targetPart, sections);

    return sections.map((section) => {
      const sectionId = toSectionId(section["@_N"]);
      const heading = section.HEAD ?? `Section ${sectionId}`;
      return {
        externalId: sectionId,
        title: heading,
        modifiedAt: new Date().toISOString(),
        mimeType: "text/plain",
        content: Buffer.from(stripXmlToText(section), "utf-8"),
        metadata: {
          title: heading,
          mimeType: "text/plain",
          extra: {
            title: this.config.title,
            part: this.config.part,
            section: sectionId,
          },
        },
      } satisfies SourceDocument;
    });
  }

  async list(options?: ConnectorListOptions): Promise<ConnectorListResult> {
    const { xml, lastModified } = await this.fetchXml();
    if (options?.cursor && options.cursor === lastModified) {
      return { documents: [], nextCursor: lastModified, done: true };
    }
    const documents = this.parseSections(xml);
    return { documents, nextCursor: lastModified, done: true };
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    const { xml } = await this.fetchXml();
    const documents = this.parseSections(xml);
    const match = documents.find((d) => d.externalId === externalId);
    if (!match) {
      throw new Error(`ecfr-part4: section ${externalId} not found`);
    }
    return match;
  }
}
