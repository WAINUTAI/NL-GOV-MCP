import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenderNedSource, parseEuroAmount, parseNoticeHtml } from "../src/sources/tenderned.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { buildSamplePdf } from "./helpers/pdf-fixture.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

const row = (label: string, value: string) =>
  `<tr>\n <td><span class="label">${label}</span><span class="text">: </span></td>\n <td><span class="value" aria-label="${label}">${value}</span></td>\n</tr>`;
const amount = (label: string, value: string) =>
  `<tr>\n <td><span class="label">${label}</span><span class="text">: </span></td>\n <td><span class="value">${value}</span><span class="text"> </span><span class="dynamic-label">Euro</span></td>\n</tr>`;
const only = (label: string) => `<tr>\n <td colspan="2"><span class="label">${label}</span><span class="text">:</span></td>\n</tr>`;
const header = (level: 1 | 2 | 3, text: string) => `<tr class="header${level}">\n <th colspan="2">${text}</th>\n</tr>`;

/** Shaped like TenderNed's eForms rendering of award notice 470012, with a second lot added. */
const EFORMS_AWARD_HTML = [
  "<table><tbody>",
  header(1, '1. <span class="label">Koper</span>'),
  row("Offici&euml;le naam", "Gemeente Harderwijk"),
  header(1, '2. <span class="label">Procedure</span>'),
  header(3, '2.1.3 <span class="label">Waarde</span>'),
  amount("Geraamde waarde exclusief btw", "800 000"),
  header(1, '5. <span class="label">Perceel</span>'),
  header(2, '5.1 <span class="label">Technische ID van het kavel</span><span class="text">: </span><span class="value">LOT-0000</span>'),
  amount("Geraamde waarde exclusief btw", "700 000"),
  header(1, '6. <span class="label">Resultaten</span>'),
  amount("Waarde van alle contracten toegekend in deze kennisgeving", "800 001"),
  header(2, '6.1 <span class="label">ID resultaat perceel</span><span class="text">: </span><span class="value">LOT-0000</span>'),
  header(3, '6.1.2 <span class="label">Informatie over winnaars</span>'),
  only("Winnaar"),
  row("Officiële naam", "Voorbeeld Software B.V."),
  only("Inschrijving"),
  row("Identificatiecode van het perceel of de groep percelen", "LOT-0000"),
  amount("Waarde van de aanbesteding", "800 000"),
  only("Informatie over het contract"),
  row("Datum waarop de winnaar is gekozen", "15/05/2026"),
  row("Datum van sluiting van het contract", "01/06/2026"),
  row("Organisatie die het contract ondertekent", "Gemeente Harderwijk"),
  header(3, '6.1.4 <span class="label">Statistische informatie</span>'),
  row("Aantal ontvangen inschrijvingen of verzoeken tot deelname", "2"),
  header(2, '6.1 <span class="label">ID resultaat perceel</span><span class="text">: </span><span class="value">LOT-0001</span>'),
  header(3, '6.1.2 <span class="label">Informatie over winnaars</span>'),
  only("Winnaar"),
  row("Officiële naam", "Jansen Advies"),
  amount("Waarde van de aanbesteding", "1"),
  header(1, '8. <span class="label">Organisaties</span>'),
  row("Officiële naam", "Voorbeeld Software B.V."),
  "</tbody></table>",
].join("\n");

/** Section V of TenderNed's rendering of the older standard form SF03 (notice 285501). */
const LEGACY_AWARD_HTML =
  '<div id="publicatie"><h3 class="section-header-1">Afdeling I: <span>Aanbestedende dienst</span></h3>' +
  "<dl><dt>Officiële benaming:</dt><dd>Gemeente Harderwijk</dd></dl>" +
  '<h3 id="detail-publicatie:linkS5" class="section-header-1" data-pdfTocTitle="V.">Afdeling V: <span>Gunning van een opdracht</span></h3>' +
  '<p class="subsection-content"><span class="section-header-3">Opdracht nr.: </span>-<br /><span class="section-header-3">Perceel nr.: </span>-<br /><span class="section-header-3">Benaming: </span>EOA ICT Omgeving</p>' +
  '<p class="subsection-content">Een opdracht/perceel wordt gegund: ja</p>' +
  '<h4 class="section-header-2">V.2) <span>Gunning van een opdracht</span></h4>' +
  '<h5 class="subsection"><span class="subsection-number">V.2.1)</span> <span class="section-header-3">Datum van de sluiting van de overeenkomst: </span></h5><p class="subsection-content">20/10/2022</p>' +
  '<h5 class="subsection"><span class="subsection-number">V.2.3)</span> <span class="section-header-3">Naam en adres van de contractant</span></h5>' +
  '<dl class="subsection"><dt>Offici&euml;le benaming:</dt><dd>Voorbeeld ICT Groep B.V.</dd><dt>Plaats:</dt><dd>Ede</dd></dl>' +
  '<h5 class="subsection"><span class="subsection-number">V.2.4)</span> <span class="section-header-3">Inlichtingen over de waarde van de opdracht/het perceel</span></h5>' +
  '<p class="subsection-content">Aanvankelijk geraamde totale waarde van de opdracht/het perceel: <br />1,00</p>' +
  '<p class="subsection-content">Totale waarde van de opdracht/het perceel: 1,00</p><p class="subsection-content">Munt: EUR</p>' +
  '<h3 class="section-header-1">Afdeling VI: <span>Aanvullende inlichtingen</span></h3>' +
  "<dl><dt>Officiële benaming:</dt><dd>Rechtbank Gelderland</dd></dl></div>";

const detail = {
  publicatieId: 450123,
  kenmerk: 620011,
  aanbestedingNaam: "Marktconsultatie Afvalinzameling",
  opdrachtgeverNaam: "Gemeente Harderwijk",
  opdrachtBeschrijving: "Voorbereiding op GFT\u2011inzameling bij hoogbouw &amp; omgekeerd inzamelen.",
  publicatieDatum: "2026-09-10T10:26:00.637087",
  sluitingsDatumMarktconsultatie: "2026-10-15",
  typePublicatie: "Marktconsultatie",
  publicatieCode: "EFE1",
  aankondigingCode: { code: "MAC", omschrijving: "Marktconsultatie" },
  nationaalOfEuropeesCode: { code: "NL", omschrijving: "Nationaal" },
  typeOpdrachtCode: { code: "D", omschrijving: "Diensten" },
  procedureCode: { code: "MAC", omschrijving: "Marktconsultatie" },
  isGegund: false,
  formType: "consultation",
};

const awardDetail = {
  ...detail,
  publicatieId: 470012,
  aanbestedingNaam: "Europees openbare aanbesteding - ERP-systeem",
  opdrachtBeschrijving: "ERP-systeem",
  publicatieDatum: "2026-06-12T04:07:17.215349",
  sluitingsDatumMarktconsultatie: undefined,
  sluitingsDatum: "2026-04-14T11:00:00",
  typePublicatie: "Aankondiging gegunde opdracht - algemene richtlijn, standaardregeling",
  publicatieCode: "EF29",
  aankondigingCode: { code: "AGO", omschrijving: "Aankondiging gegunde opdracht" },
  nationaalOfEuropeesCode: { code: "EU", omschrijving: "Europees" },
  isGegund: true,
  formType: "result",
};

type Routes = Partial<Record<"detail" | "gerelateerd" | "html" | "pdf", () => Response | Promise<Response>>>;

function routed(routes: Routes) {
  return vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/gerelateerd")) return routes.gerelateerd?.() ?? jsonResponse([]);
    if (path.endsWith("/html")) return routes.html?.() ?? jsonResponse({ html: `<table>${header(1, "1. Koper")}</table>` });
    if (path.endsWith("/pdf")) return routes.pdf?.() ?? new Response("nope", { status: 500 });
    return routes.detail?.() ?? jsonResponse(detail);
  });
}

function pdfResponse(text: string): Response {
  return new Response(buildSamplePdf(text).buffer as ArrayBuffer, {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });
}

describe("parseNoticeHtml", () => {
  it("reads estimate, total, winners, lots and dates from the eForms rendering", () => {
    const parsed = parseNoticeHtml(EFORMS_AWARD_HTML);
    expect(parsed.format).toBe("eforms");
    expect(parsed.geraamdeWaarde).toEqual({ tekst: "800 000 Euro", euro: 800000, placeholder: false });
    expect(parsed.gunning?.bron).toBe("eforms");
    expect(parsed.gunning?.totaleWaarde).toEqual({ tekst: "800 001 Euro", euro: 800001, placeholder: false });
    expect(parsed.gunning?.winnaars).toEqual([
      {
        naam: "Voorbeeld Software B.V.",
        perceel: "LOT-0000",
        waarde: { tekst: "800 000 Euro", euro: 800000, placeholder: false },
        datumWinnaarGekozen: "2026-05-15",
        datumContract: "2026-06-01",
      },
      {
        naam: "Jansen Advies",
        perceel: "LOT-0001",
        waarde: { tekst: "1 Euro", euro: 1, placeholder: true },
        datumWinnaarGekozen: "",
        datumContract: "",
      },
    ]);
  });

  it("uses a lot estimate only when the notice has a single lot", () => {
    const withoutProcedureEstimate = EFORMS_AWARD_HTML.replace(amount("Geraamde waarde exclusief btw", "800 000"), "");
    expect(parseNoticeHtml(withoutProcedureEstimate).geraamdeWaarde?.euro).toBe(700000);

    const twoLots = withoutProcedureEstimate.replace(
      header(1, '6. <span class="label">Resultaten</span>'),
      header(2, '5.1 <span class="label">Technische ID van het kavel</span>: LOT-0001') +
        amount("Geraamde waarde exclusief btw", "50 000") +
        header(1, '6. <span class="label">Resultaten</span>'),
    );
    expect(parseNoticeHtml(twoLots).geraamdeWaarde).toBeNull();
  });

  it("reads the contractor, contract date and value of the older standard forms", () => {
    const parsed = parseNoticeHtml(LEGACY_AWARD_HTML);
    expect(parsed.format).toBe("standaardformulier");
    expect(parsed.geraamdeWaarde).toBeNull();
    expect(parsed.gunning).toEqual({
      bron: "standaardformulier",
      totaleWaarde: { tekst: "1,00 EUR", euro: 1, placeholder: true },
      winnaars: [
        {
          naam: "Voorbeeld ICT Groep B.V.",
          perceel: "EOA ICT Omgeving",
          waarde: { tekst: "1,00 EUR", euro: 1, placeholder: true },
          datumWinnaarGekozen: "",
          datumContract: "2022-10-20",
        },
      ],
    });
  });

  it("does not present one lot's value as the total of a multi-lot standard form", () => {
    const secondLot = LEGACY_AWARD_HTML.slice(
      LEGACY_AWARD_HTML.indexOf('<h3 id="detail-publicatie:linkS5"'),
      LEGACY_AWARD_HTML.indexOf('<h3 class="section-header-1">Afdeling VI'),
    ).replace("<p class=\"subsection-content\">Totale waarde van de opdracht/het perceel: 1,00</p>", "");
    const html = LEGACY_AWARD_HTML.replace('<h3 class="section-header-1">Afdeling VI', `${secondLot}<h3 class="section-header-1">Afdeling VI`);
    const parsed = parseNoticeHtml(html);
    expect(parsed.gunning?.winnaars).toHaveLength(2);
    expect(parsed.gunning?.totaleWaarde).toBeNull();
  });

  it("returns nothing rather than guessing for an unknown layout", () => {
    expect(parseNoticeHtml("<div><p>Iets anders</p></div>")).toEqual({
      format: "unknown",
      taal: null,
      geraamdeWaarde: null,
      gunning: null,
      nietGelezen: [],
    });
  });
});

describe("parseEuroAmount", () => {
  it("handles the separators TenderNed prints", () => {
    expect(parseEuroAmount("800 000 Euro")).toBe(800000);
    expect(parseEuroAmount("1,00 EUR")).toBe(1);
    expect(parseEuroAmount("1.250.000,50 EUR")).toBe(1250000.5);
    expect(parseEuroAmount("1 234 567.89 Euro")).toBe(1234567.89);
    expect(parseEuroAmount("€ 2.500")).toBe(2500);
  });

  it("refuses amounts that are not in euro", () => {
    expect(parseEuroAmount("1 000 GBP")).toBeNull();
    expect(parseEuroAmount("Euro")).toBeNull();
  });
});

describe("TenderNedSource.get", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("derives type and closing date from the same fields as search", async () => {
    vi.stubGlobal("fetch", routed({}));
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "450123" });

    expect(item).toMatchObject({
      typePublicatie: "Marktconsultatie",
      typePublicatieCode: "MAC",
      publicatieCode: "EFE1",
      publicatieCodeOmschrijving: "Marktconsultatie",
      sluitingsDatum: "2026-10-15",
      sluitingsDatumBron: "sluitingsDatumMarktconsultatie",
      sluitingsDatumPlaceholder: false,
      europees: false,
      beschrijving: "Voorbereiding op GFT\u2011inzameling bij hoogbouw & omgekeerd inzamelen.",
    });
  });

  it("reports the award notice type, not the eForms form, as typePublicatie", async () => {
    vi.stubGlobal("fetch", routed({ detail: () => jsonResponse(awardDetail) }));
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "470012" });
    expect(item.typePublicatie).toBe("Aankondiging gegunde opdracht");
    expect(item.typePublicatieCode).toBe("AGO");
    expect(item.publicatieCode).toBe("EF29");
    expect(item.publicatieCodeOmschrijving).toBe("Aankondiging gegunde opdracht - algemene richtlijn, standaardregeling");
  });

  it("leaves europees unknown when TenderNed does not say", async () => {
    vi.stubGlobal("fetch", routed({ detail: () => jsonResponse({ ...detail, nationaalOfEuropeesCode: undefined }) }));
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "450123" });
    expect(item.europees).toBeNull();
  });

  it("lists related publications from the /gerelateerd endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      routed({
        gerelateerd: () =>
          jsonResponse([
            { publicatieId: 461234, kenmerk: 540012, formType: "result", publicatieDatum: "2026-05-14T15:24:38", typePublicatie: "Aankondiging gegunde opdracht - algemene richtlijn, standaardregeling" },
            { publicatieId: 450123, kenmerk: 540012, formType: "competition", publicatieDatum: "2025-06-29", typePublicatie: "zichzelf" },
          ]),
      }),
    );
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "450123" });
    expect(item.gerelateerdePublicaties).toEqual([
      { id: "461234", datum: "2026-05-14T15:24:38", type: "Aankondiging gegunde opdracht - algemene richtlijn, standaardregeling", kenmerk: "540012", formType: "result" },
    ]);
    expect(item.gerelateerdePublicaties_unavailable_reason).toBeUndefined();
  });

  it("points a contract notice of an awarded procedure to its award notice", async () => {
    vi.stubGlobal(
      "fetch",
      routed({
        detail: () => jsonResponse({ ...awardDetail, publicatieId: 390012, formType: "competition", aankondigingCode: { code: "AAO", omschrijving: "Aankondiging opdracht" } }),
        gerelateerd: () => jsonResponse([{ publicatieId: 461234, formType: "result", publicatieDatum: "2026-05-14", typePublicatie: "x" }]),
      }),
    );
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "390012" });
    expect(out.access_note).toContain("gunningspublicatie 461234");
    expect(out.item.gunning_unavailable_reason).toBeUndefined();
  });

  it("says so when related publications cannot be fetched, and keeps the record", async () => {
    vi.stubGlobal("fetch", routed({ gerelateerd: () => new Response("kapot", { status: 404 }) }));
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "450123" });
    expect(out.item.title).toBe("Marktconsultatie Afvalinzameling");
    expect(out.item.gerelateerdePublicaties).toEqual([]);
    expect(out.item.gerelateerdePublicaties_unavailable_reason).toBe("fetch_failed");
    expect(out.access_note).toContain("Gerelateerde publicaties konden niet worden opgehaald");
  });

  it("adds winners, values and placeholder flags from the HTML rendering", async () => {
    vi.stubGlobal(
      "fetch",
      routed({ detail: () => jsonResponse(awardDetail), html: () => jsonResponse({ html: EFORMS_AWARD_HTML }) }),
    );
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "470012" });
    expect(out.item.geraamdeWaarde?.euro).toBe(800000);
    expect(out.item.gunning?.winnaars.map((w) => w.naam)).toEqual(["Voorbeeld Software B.V.", "Jansen Advies"]);
    expect(out.item.gunning?.winnaars[1].waarde?.placeholder).toBe(true);
    expect(out.access_note).toContain("plaatshouders of tarieven");
    expect(out.params.include_award).toBe("true");
  });

  it("flags an award notice whose rendering names no winner", async () => {
    vi.stubGlobal(
      "fetch",
      routed({ detail: () => jsonResponse(awardDetail), html: () => jsonResponse({ html: header(1, "6. Resultaten") }) }),
    );
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "470012" });
    expect(out.item.gunning).toBeNull();
    expect(out.item.gunning_unavailable_reason).toBe("no_winner_in_notice");
    expect(out.access_note).toContain("geen winnaar");
  });

  it("keeps the record and explains when the HTML rendering fails", async () => {
    vi.stubGlobal("fetch", routed({ detail: () => jsonResponse(awardDetail), html: () => new Response("", { status: 404 }) }));
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "470012" });
    expect(out.item.title).toBe("Europees openbare aanbesteding - ERP-systeem");
    expect(out.item.gunning_unavailable_reason).toBe("fetch_failed");
    expect(out.access_note).toContain("Waarde- en gunningsgegevens konden niet worden opgehaald");
  });

  it("says so when an award notice's HTML layout is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      routed({ detail: () => jsonResponse(awardDetail), html: () => jsonResponse({ html: "<div><p>Nieuwe opmaak</p></div>" }) }),
    );
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "470012" });
    expect(out.item.gunning).toBeNull();
    expect(out.item.gunning_unavailable_reason).toBe("format_unrecognized");
    expect(out.access_note).toContain("onbekende opmaak");
  });

  it("reports a malformed HTML response with a typed reason", async () => {
    vi.stubGlobal("fetch", routed({ detail: () => jsonResponse(awardDetail), html: () => jsonResponse({ geenHtml: true }) }));
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "470012" });
    expect(out.item.gunning_unavailable_reason).toBe("malformed_response");
  });

  it("skips the HTML request when include_award is false", async () => {
    const fetchMock = routed({ detail: () => jsonResponse(awardDetail) });
    vi.stubGlobal("fetch", fetchMock);
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "470012", include_award: false });
    const paths = fetchMock.mock.calls.map((call) => new URL((call as unknown as [string])[0]).pathname);
    expect(paths.some((p) => p.endsWith("/html"))).toBe(false);
    expect(out.item.gunning).toBeUndefined();
    expect(out.params.include_award).toBe("false");
  });

  it("flags a placeholder closing date", async () => {
    vi.stubGlobal(
      "fetch",
      routed({ detail: () => jsonResponse({ ...awardDetail, aankondigingCode: { code: "AAO", omschrijving: "Aankondiging opdracht" }, sluitingsDatum: "2125-12-31T13:00:00", formType: "competition", isGegund: false }) }),
    );
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "410077" });
    expect(out.item.sluitingsDatumPlaceholder).toBe(true);
    expect(out.access_note).toContain("2125-12-31T13:00:00 is een plaatshouder");
  });

  it("shows TenderNed's text when the looptijd has no closing date", async () => {
    vi.stubGlobal("fetch", routed({ detail: () => jsonResponse({ ...detail, looptijdCode: { code: "OBP", omschrijving: "Onbepaald" } }) }));
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "450123" });
    expect(item.sluitingsDatumOpmerking).toBe("Onbepaald");
  });

  it("restores characters the notice PDF draws as '#' from the description", async () => {
    vi.stubGlobal(
      "fetch",
      routed({ pdf: () => pdfResponse("Beschrijving: Voorbereiding op GFT#inzameling bij hoogbouw. Zie www.example.nl/a#b") }),
    );
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "450123", include_text: true });
    expect(out.item.pdf_text).toContain("GFT-inzameling");
    expect(out.item.pdf_text).toContain("www.example.nl/a#b");
    expect(out.item.pdf_text_restored_chars).toBe(1);
    expect(out.access_note).toContain("1 teken(s) die de TenderNed-PDF als '#' toont");
    expect(out.access_note).toContain("1 '#'-teken(s) midden in een woord");
  });

  it("names max_chars and the full length when pdf_text is truncated", async () => {
    vi.stubGlobal("fetch", routed({ pdf: () => pdfResponse("abcdefghijklmnopqrstuvwxyz") }));
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "450123", include_text: true, max_chars: 10 });
    expect(out.item.pdf_text).toBe("abcdefghij");
    expect(out.item.pdf_text_truncated).toBe(true);
    expect(out.item.pdf_text_chars).toBe(10);
    expect(out.item.pdf_text_total_chars).toBe(26);
    expect(out.access_note).toContain("afgekapt op 10 van 26 tekens");
    expect(out.access_note).toContain("max_chars");
  });
});
