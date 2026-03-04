import type { MCPRecord } from "../types.js";

interface RelatedLink {
  target_connector: string;
  target_id: string;
  relationship: "references_law" | "about_municipality" | "related_record";
  url?: string;
}

interface Identifier {
  kind: "ecli" | "bwb_id" | "document_id" | "gemeentecode" | "url";
  value: string;
}

function normalize(value: string): string {
  return value.trim();
}

function addIdentifier(target: Identifier[], kind: Identifier["kind"], value: unknown): void {
  if (typeof value !== "string") return;
  const clean = normalize(value);
  if (!clean) return;
  target.push({ kind, value: clean });
}

function extractFromText(text: string): Identifier[] {
  const out: Identifier[] = [];

  const ecliMatches = text.match(/ECLI:[A-Z]{2}:[A-Z0-9]+:[0-9]{4}:[A-Z0-9.:-]+/gi) ?? [];
  for (const m of ecliMatches) out.push({ kind: "ecli", value: normalize(m.toUpperCase()) });

  const bwbMatches = text.match(/BWBR[0-9]{7,}/gi) ?? [];
  for (const m of bwbMatches) out.push({ kind: "bwb_id", value: normalize(m.toUpperCase()) });

  return out;
}

function extractIdentifiers(record: MCPRecord): Identifier[] {
  const ids: Identifier[] = [];
  const data = (record.data ?? {}) as Record<string, unknown>;

  addIdentifier(ids, "ecli", data.ecli);
  addIdentifier(ids, "bwb_id", data.bwb_id);
  addIdentifier(ids, "bwb_id", data.bwbId);
  addIdentifier(ids, "document_id", data.document_id);
  addIdentifier(ids, "document_id", data.documentId);
  addIdentifier(ids, "gemeentecode", data.gemeentecode);
  addIdentifier(ids, "gemeentecode", data.gemeente_code);
  addIdentifier(ids, "gemeentecode", data.regiocode);

  if (record.canonical_url) ids.push({ kind: "url", value: record.canonical_url });

  const textBlob = `${record.title ?? ""} ${record.snippet ?? ""}`;
  ids.push(...extractFromText(textBlob));

  if (typeof data.url === "string") ids.push({ kind: "url", value: data.url });

  const unique = new Map<string, Identifier>();
  for (const id of ids) {
    const key = `${id.kind}:${id.value.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, id);
  }

  return Array.from(unique.values());
}

function linkKey(link: RelatedLink): string {
  return `${link.target_connector}|${link.target_id}|${link.relationship}|${link.url ?? ""}`;
}

export function enrichRelatedLinks(records: MCPRecord[]): MCPRecord[] {
  const identifiersPerRecord = records.map((r) => extractIdentifiers(r));
  const occurrences = new Map<string, number[]>();

  for (let i = 0; i < identifiersPerRecord.length; i += 1) {
    for (const id of identifiersPerRecord[i]) {
      const key = `${id.kind}:${id.value.toLowerCase()}`;
      const arr = occurrences.get(key) ?? [];
      arr.push(i);
      occurrences.set(key, arr);
    }
  }

  return records.map((record, idx) => {
    const links: RelatedLink[] = [];

    for (const id of identifiersPerRecord[idx]) {
      const key = `${id.kind}:${id.value.toLowerCase()}`;
      const matchIndices = occurrences.get(key) ?? [];

      for (const otherIdx of matchIndices) {
        if (otherIdx === idx) continue;
        const other = records[otherIdx];
        links.push({
          target_connector: other.source_name,
          target_id: id.value,
          relationship: id.kind === "bwb_id" ? "references_law" : id.kind === "gemeentecode" ? "about_municipality" : "related_record",
          url: other.canonical_url,
        });
      }

      // Add direct cross-reference targets even if not present in current result set.
      if (id.kind === "bwb_id") {
        links.push({
          target_connector: "officiele_bekendmakingen",
          target_id: id.value,
          relationship: "references_law",
          url: `https://wetten.overheid.nl/${encodeURIComponent(id.value)}`,
        });
      }

      if (id.kind === "gemeentecode" && record.source_name.toLowerCase().includes("cbs")) {
        links.push({
          target_connector: "bag_linked_data",
          target_id: id.value,
          relationship: "about_municipality",
          url: `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?fq=gemeentecode:${encodeURIComponent(id.value)}`,
        });
      }
    }

    if (!links.length) return record;

    const unique = new Map<string, RelatedLink>();
    for (const link of links) unique.set(linkKey(link), link);

    const data = { ...(record.data ?? {}) } as Record<string, unknown>;
    data.related_links = Array.from(unique.values());

    return {
      ...record,
      data,
    };
  });
}
