/**
 * Ad-hoc live check for the connectors added in this change set.
 *
 * Calls every new source against its real upstream and prints a compact
 * pass/fail line per case. Not part of `npm test` (that suite is offline and
 * mocked); run it manually while validating connectors:
 *
 *   npx tsx scripts/live-check-new.ts
 */
import { loadConfig } from "../src/config.js";
import { TenderNedSource } from "../src/sources/tenderned.js";
import { KoopCollectieSource } from "../src/sources/koop-collecties.js";
import { BrpGewasperceelSource } from "../src/sources/brp-gewaspercelen.js";
import { VerkiezingsuitslagenSource } from "../src/sources/verkiezingsuitslagen.js";
import { DuoSource } from "../src/sources/duo.js";
import { TweedeKamerSource } from "../src/sources/tweede-kamer.js";

const config = loadConfig();
const tenderned = new TenderNedSource(config);
const tuchtrecht = new KoopCollectieSource(config, "tuchtrecht");
const catalogi = new KoopCollectieSource(config, "samenwerkendecatalogi");
const brp = new BrpGewasperceelSource(config);
const kiesraad = new VerkiezingsuitslagenSource(config);
const duo = new DuoSource(config);
const tk = new TweedeKamerSource(config);

let failures = 0;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`PASS  ${name.padEnd(42)} ${String(Date.now() - started).padStart(5)}ms  ${detail}`);
  } catch (error) {
    failures += 1;
    console.log(
      `FAIL  ${name.padEnd(42)} ${String(Date.now() - started).padStart(5)}ms  ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

await check("tenderned search (keyword)", async () => {
  const out = await tenderned.search({ query: "fietsbrug", rows: 5 });
  assert(out.items.length > 0, "no items");
  assert(out.total > 0, "no total");
  assert(out.items[0].opdrachtgever, "missing opdrachtgever");
  return `${out.items.length}/${out.total} — ${out.items[0].title.slice(0, 40)}`;
});

await check("tenderned search (filters)", async () => {
  const out = await tenderned.search({
    query: "onderhoud",
    typeOpdracht: "werken",
    datumVanaf: "2026-01-01",
    rows: 5,
  });
  assert(out.items.length > 0, "no items");
  assert(
    out.items.every((i) => i.typeOpdracht.includes("Werken")),
    "typeOpdracht filter not applied",
  );
  assert(
    out.items.every((i) => i.publicatieDatum >= "2026-01-01"),
    "date filter not applied",
  );
  return `${out.items.length} werken sinds 2026-01-01`;
});

await check("tenderned detail + pdf text", async () => {
  const list = await tenderned.search({ rows: 1 });
  const id = list.items[0].id;
  const out = await tenderned.get({ publicatieId: id, include_text: true, max_chars: 2000 });
  assert(out.item.id === id, "id mismatch");
  assert(out.item.cpvCodes.length >= 0, "cpv missing");
  assert(out.item.pdf_text && out.item.pdf_text.length > 100, `no pdf text (${out.item.pdf_text_unavailable_reason ?? "?"})`);
  return `${id}: ${out.item.pdf_pages} pagina's, ${out.item.pdf_text_chars} tekens`;
});

await check("tuchtrecht search", async () => {
  const out = await tuchtrecht.search({ query: "medicatiefout", maximumRecords: 5 });
  assert(out.items.length > 0, "no items");
  const first = out.items[0] as { identifier: string; canonical_url: string; college: string };
  assert(first.identifier.startsWith("ECLI:"), `no ECLI: ${first.identifier}`);
  assert(first.canonical_url.includes("tuchtrecht.overheid.nl"), "bad canonical url");
  return `${out.items.length}/${out.total} — ${first.identifier} (${first.college.slice(0, 30)})`;
});

await check("tuchtrecht date filter", async () => {
  const out = await tuchtrecht.search({ date_from: "2024-01-01", maximumRecords: 3 });
  assert(out.items.length > 0, "no items");
  return `${out.total} uitspraken sinds 2024-01-01`;
});

await check("samenwerkende catalogi search", async () => {
  const out = await catalogi.search({ query: "paspoort", maximumRecords: 5 });
  assert(out.items.length > 0, "no items");
  const first = out.items[0] as { title: string; organisatie: string };
  assert(first.organisatie, "no organisatie");
  return `${out.items.length}/${out.total} — ${first.title.slice(0, 30)} (${first.organisatie})`;
});

await check("samenwerkende catalogi org filter", async () => {
  const out = await catalogi.search({ organisatie: "Amsterdam", maximumRecords: 3 });
  assert(out.items.length > 0, "no items");
  assert(
    out.items.every((i) => (i as { organisatie: string }).organisatie === "Amsterdam"),
    "org filter not applied",
  );
  return `${out.total} producten van Amsterdam`;
});

await check("brp gewaspercelen (gemeente)", async () => {
  const out = await brp.search({ gemeente: "Dronten", categorie: "all", includeGeometry: false, rows: 5 });
  assert(out.items.length > 0, `no items: ${out.access_note ?? ""}`);
  assert(out.items[0].oppervlakteHa !== null, "no area computed");
  return `${out.items.length}/${out.total} — ${out.items[0].gewas} (${out.items[0].oppervlakteHa} ha)`;
});

await check("brp gewaspercelen (categorie filter)", async () => {
  const out = await brp.search({ gemeente: "Dronten", categorie: "bouwland", includeGeometry: false, rows: 5 });
  assert(out.items.length > 0, `no items: ${out.access_note ?? ""}`);
  assert(out.items.every((i) => i.categorie === "Bouwland"), "categorie filter not applied");
  return `${out.items.length} bouwland-percelen`;
});

await check("brp gewaspercelen (bad bbox)", async () => {
  const out = await brp.search({ bbox: "0,0,1,1", categorie: "all", includeGeometry: false, rows: 5 });
  assert(out.items.length === 0, "expected no items");
  assert((out.access_note ?? "").includes("Ongeldige bbox"), "missing validation note");
  return "afgewezen zoals verwacht";
});

await check("verkiezingen list", async () => {
  const out = await kiesraad.listVerkiezingen();
  assert(out.items.length > 0, "no elections");
  assert(/^[A-Z]{2}\d{8}$/.test(out.items[0].code), "bad code");
  return `${out.items.length} verkiezingen — nieuwste ${out.items[0].code}`;
});

await check("verkiezingsuitslag landelijk", async () => {
  const out = await kiesraad.uitslag({ verkiezing: "TK20251029" });
  assert(out.uitslag, "no result");
  assert(out.uitslag!.partijen.length > 5, "too few parties");
  assert(out.uitslag!.partijen[0].aantalStemmen! > 1000, "votes not parsed");
  assert(out.uitslag!.opkomstPercentage! > 50, "turnout not parsed");
  return `${out.uitslag!.partijen.length} partijen, opkomst ${out.uitslag!.opkomstPercentage}%`;
});

await check("verkiezingsuitslag gemeente", async () => {
  const out = await kiesraad.uitslag({ verkiezing: "TK20251029", gebied: "Tilburg" });
  assert(out.uitslag?.gebied === "Tilburg", `wrong area: ${out.uitslag?.gebied}`);
  assert(out.uitslag!.niveau === "gemeente", "wrong level");
  assert(out.uitslag!.partijen.length > 5, "too few parties");
  return `Tilburg: ${out.uitslag!.partijen[0].partij} ${out.uitslag!.partijen[0].percentage}%`;
});

await check("verkiezingsuitslag provincie", async () => {
  const out = await kiesraad.uitslag({ verkiezing: "TK20251029", gebied: "Fryslân" });
  assert(out.uitslag?.niveau === "provincie", `wrong level: ${out.uitslag?.niveau}`);
  return `${out.uitslag!.gebied}: ${out.uitslag!.partijen.length} partijen`;
});

await check("verkiezingsuitslag zonder code", async () => {
  const out = await kiesraad.uitslag({});
  assert(out.uitslag, "no result");
  return `${out.uitslag!.verkiezingNaam} ${out.uitslag!.verkiezingDatum}`;
});

await check("duo scholen (gemeente po)", async () => {
  const out = await duo.getSchools({ municipality: "Tilburg", sector: "po", top: 5 });
  assert(out.items.length > 0, "no schools");
  assert(out.items.every((s) => s.gemeente === "TILBURG"), "gemeente filter not applied");
  assert(out.items[0].postcode, "no postcode");
  return `${out.items.length}/${out.total} — ${out.items[0].naam}`;
});

await check("duo scholen (naam vo)", async () => {
  const out = await duo.getSchools({ name: "Beatrix", sector: "vo", top: 5 });
  assert(out.items.length > 0, "no schools");
  return `${out.items.length}/${out.total} — ${out.items[0].naam} (${out.items[0].plaats})`;
});

await check("duo scholen (mbo + ho)", async () => {
  const mbo = await duo.getSchools({ sector: "mbo", top: 3 });
  const ho = await duo.getSchools({ sector: "ho", top: 3 });
  assert(mbo.items.length > 0 && ho.items.length > 0, "empty sector");
  return `mbo ${mbo.total}, ho ${ho.total}`;
});

await check("duo examenresultaten (gemeente + sort)", async () => {
  const out = await duo.getExamResults({ municipality: "Tilburg", year: 2017, sortByScore: true, top: 5 });
  assert(out.items.length > 0, "no results");
  assert(out.items[0].slagingspercentage !== null, "no pass rate");
  assert(
    out.items[0].slagingspercentage! >= out.items[out.items.length - 1].slagingspercentage!,
    "sort not applied",
  );
  return `${out.items.length}/${out.total} — beste: ${out.items[0].school} ${out.items[0].slagingspercentage}%`;
});

await check("duo examenresultaten (onderwijstype)", async () => {
  const out = await duo.getExamResults({ onderwijstype: "vwo", year: 2017, top: 5 });
  assert(out.items.length > 0, "no results");
  assert(out.items.every((i) => i.onderwijstype === "VWO"), "type filter not applied");
  return `${out.total} VWO-resultaten in 2017`;
});

await check("tweede kamer pdf tekst", async () => {
  const list = await tk.search({
    entity: "Document",
    query: "",
    top: 3,
    filter: "ContentType eq 'application/pdf'",
    orderby: "Datum desc",
  });
  const id = String((list.items[0] ?? {}).Id ?? "");
  assert(id, "no pdf document found");
  const out = await tk.getDocument({ id, include_text: true, max_chars: 1500 });
  const preview = out.item.text_preview;
  assert(
    typeof preview === "string" && preview.length > 50,
    `no text extracted (${String(out.item.text_preview_unavailable_reason ?? "?")})`,
  );
  return `${id.slice(0, 8)}: ${out.item.resource_pages} pagina's, ${out.item.text_preview_chars} tekens`;
});

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll live checks passed");
process.exit(failures ? 1 : 0);
