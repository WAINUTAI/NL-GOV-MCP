import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenderNedSource, parseNoticeHtml } from "../src/sources/tenderned.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

// Row builders shaped like TenderNed's eForms rendering (/publicaties/{id}/html).
const row = (label: string, value: string) =>
  `<tr>\n <td><span class="label">${label}</span><span class="text">: </span></td>\n <td><span class="value">${value}</span></td>\n</tr>`;
const amount = (label: string, value: string, unit = "Euro") =>
  `<tr>\n <td><span class="label">${label}</span><span class="text">: </span></td>\n <td><span class="value">${value}</span><span class="text"> </span><span class="dynamic-label">${unit}</span></td>\n</tr>`;
const only = (label: string) => `<tr>\n <td colspan="2"><span class="label">${label}</span><span class="text">:</span></td>\n</tr>`;
const header = (level: 1 | 2 | 3, text: string) => `<tr class="header${level}">\n <th colspan="2">${text}</th>\n</tr>`;
const table = (...rows: string[]) => ["<table><tbody>", ...rows, "</tbody></table>"].join("\n");

/** Labels TenderNed used from about Nov 2023 to early 2025 (notices 318746, 351350, 369441). */
const OLDER_DUTCH_HTML = table(
  header(1, "1. Koper"),
  row("Officiële naam", "[N.V. Nederlandse Gasunie] ---"),
  header(1, "6. Resultaten"),
  row("Waarde van alle in het kader van deze procedure gegunde opdrachten", "3 583 200 EUR"),
  header(2, "6.1 Resultaat Lot Identifier: LOT-0000"),
  only("Er is ten minste één winnaar gekozen."),
  header(3, "6.1.2 Informatie over winnaars"),
  only("Winnaar"),
  row("Officiële naam", "[ Marsh B.V. ] ---"),
  only("Inschrijver"),
  row("Identificatiecode van het perceel of de groep percelen", "LOT-0000"),
  row("Waarde van het resultaat", "3 583 200 EUR"),
  only("Informatie over het contract"),
  row("Datum van sluiting van het contract", "2023-06-26+02:00"),
  row("Organisatie die het contract ondertekent", "[N.V. Nederlandse Gasunie] ---"),
  header(1, "8. Organisaties"),
  row("Officiële naam", "Marsh B.V."),
);

/** An English-language award of a framework agreement (notice 442381, EBN). */
const ENGLISH_HTML = table(
  header(1, "1. Buyer"),
  row("Official name", "EBN Capital B.V."),
  header(1, "2. Procedure"),
  header(3, "2.1.3 Value"),
  amount("Estimated value excluding VAT", "3 100 000"),
  header(1, "5. Lot"),
  header(2, "5.1 Lot technical ID: LOT-0000"),
  amount("Estimated value excluding VAT", "3 100 000"),
  header(1, "6. Results"),
  amount("Maximum value of the framework agreements in this notice", "3 100 000"),
  amount("Approximate value of the framework agreements", "3 100 000"),
  header(2, "6.1 Result lot ldentifier: LOT-0000"),
  only("At least one winner was chosen."),
  only("Framework agreement"),
  amount("Maximum value of the framework agreement", "3 100 000"),
  amount("Re-estimated value of the framework agreement", "3 100 000"),
  header(3, "6.1.2 Information about winners"),
  only("Winner"),
  row("Official name", "TotalEnergies EP Nederland B.V."),
  only("Tender"),
  row("Identifier of lot or group of lots", "LOT-0000"),
  amount("Value of the tender", "3 100 000"),
  only("Contract information"),
  row("Date on which the winner was chosen", "15/09/2026"),
  row("Date of the conclusion of the contract", "30/09/2026"),
  header(3, "6.1.4 Statistical information"),
  amount("Value of the lowest admissible tender", "3 000 000"),
  header(1, "8. Organisations"),
  row("Official name", "TotalEnergies EP Nederland B.V."),
);

/** A two-lot framework award: only maximum values, no contract value (notice 442386). */
const FRAMEWORK_HTML = table(
  header(1, "1. Koper"),
  header(1, "6. Resultaten"),
  amount("Maximumwaarde van de raamovereenkomsten in deze aankondiging", "115 000 000"),
  header(2, "6.1 ID resultaat perceel: LOT-0001"),
  only("Raamovereenkomst"),
  amount("Maximumwaarde van de raamovereenkomst", "100 000 000"),
  header(3, "6.1.2 Informatie over winnaars"),
  only("Winnaar"),
  row("Officiële naam", "Mainpress BV"),
  row("Identificatiecode van het perceel of de groep percelen", "LOT-0001"),
  row("Datum waarop de winnaar is gekozen", "25/08/2026"),
  row("Datum van sluiting van het contract", "24/09/2026"),
  header(3, "6.1.4 Statistische informatie"),
  header(2, "6.1 ID resultaat perceel: LOT-0002"),
  only("Raamovereenkomst"),
  amount("Maximumwaarde van de raamovereenkomst", "15 000 000"),
  header(3, "6.1.2 Informatie over winnaars"),
  only("Winnaar"),
  row("Officiële naam", "Bobbe International B.V."),
  row("Identificatiecode van het perceel of de groep percelen", "LOT-0002"),
  header(1, "8. Organisaties"),
);

/** A rendering in a language the parser does not read. */
const GERMAN_HTML = table(
  header(1, "1. Käufer"),
  header(1, "6. Ergebnisse"),
  amount("Wert aller in dieser Bekanntmachung vergebenen Verträge", "500 000"),
  only("Gewinner"),
  row("Offizielle Bezeichnung", "Beispiel GmbH"),
);

/** A concession award: revenue amounts no known label covers, and a winner without a value. */
const CONCESSION_HTML = table(
  header(1, "1. Koper"),
  header(1, "6. Resultaten"),
  amount("Geraamde inkomsten afkomstig van de gebruikers van de concessie", "12 000"),
  header(2, "6.1 ID resultaat perceel: LOT-0000"),
  header(3, "6.1.2 Informatie over winnaars"),
  only("Winnaar"),
  row("Officiële naam", "Exploitant B.V."),
  only("Winnaar"),
  row("Identificatiecode van het perceel of de groep percelen", "LOT-0000"),
);

/** Section V of an older standard form whose one lot went to a group of contractors (notice 265637). */
const LEGACY_SHARED_HTML =
  '<div id="publicatie"><h3 class="section-header-1">Afdeling I: <span>Aanbestedende dienst</span></h3>' +
  '<h3 class="section-header-1">Afdeling V: <span>Gunning van een opdracht</span></h3>' +
  '<p class="subsection-content"><span class="section-header-3">Opdracht nr.: </span>1<br /><span class="section-header-3">Perceel nr.: </span>-<br /><span class="section-header-3">Benaming: </span>Diagnostiek en behandeling Ernstige Dyslexie</p>' +
  '<h5 class="subsection"><span class="subsection-number">V.2.1)</span> <span class="section-header-3">Datum van de sluiting van de overeenkomst: </span></h5><p class="subsection-content">24/06/2022</p>' +
  '<p class="subsection-content">De opdracht is gegund aan een groep ondernemers: ja</p>' +
  '<h5 class="subsection"><span class="subsection-number">V.2.3)</span> <span class="section-header-3">Naam en adres van de contractant</span></h5>' +
  '<dl class="subsection"><dt>Officiële benaming:</dt><dd>ECLG expertisecentrum leren &amp; gedrag</dd><dt>Plaats:</dt><dd>Maastricht</dd></dl>' +
  '<h5 class="subsection"><span class="subsection-number">V.2.3)</span> <span class="section-header-3">Naam en adres van de contractant</span></h5>' +
  '<dl class="subsection"><dt>Officiële benaming:</dt><dd>Berkel-B B.V.</dd><dt>Plaats:</dt><dd>Lochem</dd></dl>' +
  '<h5 class="subsection"><span class="subsection-number">V.2.4)</span> <span class="section-header-3">Inlichtingen over de waarde van de opdracht/het perceel (exclusief btw)</span></h5>' +
  '<p class="subsection-content">Totale waarde van de opdracht/het perceel: 1 800 000,00</p><p class="subsection-content">Munt: EUR</p>' +
  '<h3 class="section-header-1">Afdeling VI: <span>Aanvullende inlichtingen</span></h3></div>';

const eur = (tekst: string, euro: number) => ({ tekst, euro, placeholder: false });

describe("parseNoticeHtml label variants", () => {
  it("reads the older Dutch labels, bracketed names and ISO dates with an offset", () => {
    const parsed = parseNoticeHtml(OLDER_DUTCH_HTML);
    expect(parsed).toMatchObject({ format: "eforms", taal: "nl", nietGelezen: [] });
    expect(parsed.gunning).toEqual({
      bron: "eforms",
      totaleWaarde: eur("3 583 200 EUR", 3583200),
      winnaars: [
        {
          naam: "Marsh B.V.",
          perceel: "LOT-0000",
          waarde: eur("3 583 200 EUR", 3583200),
          datumWinnaarGekozen: "",
          datumContract: "2023-06-26",
        },
      ],
    });
  });

  it("reads English renderings, framework maxima and lot-level values", () => {
    const parsed = parseNoticeHtml(ENGLISH_HTML);
    expect(parsed).toMatchObject({ format: "eforms", taal: "en", nietGelezen: [] });
    expect(parsed.geraamdeWaarde).toEqual(eur("3 100 000 Euro", 3100000));
    expect(parsed.gunning).toEqual({
      bron: "eforms",
      totaleWaarde: null,
      raamovereenkomstMaximum: eur("3 100 000 Euro", 3100000),
      raamovereenkomstWaardeBijBenadering: eur("3 100 000 Euro", 3100000),
      percelen: [{ perceel: "LOT-0000", raamovereenkomstMaximum: eur("3 100 000 Euro", 3100000), winnaars: ["TotalEnergies EP Nederland B.V."] }],
      winnaars: [
        {
          naam: "TotalEnergies EP Nederland B.V.",
          perceel: "LOT-0000",
          waarde: eur("3 100 000 Euro", 3100000),
          datumWinnaarGekozen: "2026-09-15",
          datumContract: "2026-09-30",
        },
      ],
    });
  });

  it("keeps a framework's per-lot maximum at lot level, not on the winner", () => {
    const parsed = parseNoticeHtml(FRAMEWORK_HTML);
    expect(parsed.gunning?.totaleWaarde).toBeNull();
    expect(parsed.gunning?.raamovereenkomstMaximum?.euro).toBe(115_000_000);
    expect(parsed.gunning?.percelen).toEqual([
      { perceel: "LOT-0001", raamovereenkomstMaximum: eur("100 000 000 Euro", 100_000_000), winnaars: ["Mainpress BV"] },
      { perceel: "LOT-0002", raamovereenkomstMaximum: eur("15 000 000 Euro", 15_000_000), winnaars: ["Bobbe International B.V."] },
    ]);
    expect(parsed.gunning?.winnaars.map((w) => [w.naam, w.perceel, w.waarde])).toEqual([
      ["Mainpress BV", "LOT-0001", null],
      ["Bobbe International B.V.", "LOT-0002", null],
    ]);
  });

  it("does not read labels in another language, and says which language it is not", () => {
    expect(parseNoticeHtml(GERMAN_HTML)).toEqual({ format: "eforms", taal: null, geraamdeWaarde: null, gunning: null, nietGelezen: [] });
  });

  it("lists result amounts and winners it could not map", () => {
    const parsed = parseNoticeHtml(CONCESSION_HTML);
    expect(parsed.gunning?.winnaars.map((w) => w.naam)).toEqual(["Exploitant B.V."]);
    expect(parsed.nietGelezen).toEqual([
      "Geraamde inkomsten afkomstig van de gebruikers van de concessie: 12 000 Euro",
      "1 winnaar(s) zonder officiële naam",
    ]);
  });

  it("does not give each contractor of a jointly awarded lot the whole lot value", () => {
    const parsed = parseNoticeHtml(LEGACY_SHARED_HTML);
    expect(parsed.format).toBe("standaardformulier");
    expect(parsed.gunning).toEqual({
      bron: "standaardformulier",
      totaleWaarde: eur("1 800 000,00 EUR", 1_800_000),
      percelen: [
        {
          perceel: "Diagnostiek en behandeling Ernstige Dyslexie",
          waarde: eur("1 800 000,00 EUR", 1_800_000),
          winnaars: ["ECLG expertisecentrum leren & gedrag", "Berkel-B B.V."],
        },
      ],
      winnaars: [
        { naam: "ECLG expertisecentrum leren & gedrag", perceel: "Diagnostiek en behandeling Ernstige Dyslexie", waarde: null, datumWinnaarGekozen: "", datumContract: "2022-06-24" },
        { naam: "Berkel-B B.V.", perceel: "Diagnostiek en behandeling Ernstige Dyslexie", waarde: null, datumWinnaarGekozen: "", datumContract: "2022-06-24" },
      ],
    });
  });
});

const awardDetail = {
  publicatieId: 442381,
  aanbestedingNaam: "Technical services agreement",
  opdrachtgeverNaam: "EBN Capital B.V.",
  publicatieDatum: "2026-10-02T09:00:00",
  aankondigingCode: { code: "AGO", omschrijving: "Aankondiging gegunde opdracht" },
  publicatieCode: "EF29",
  isGegund: true,
  formType: "result",
};

function withHtml(html: string) {
  return vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/gerelateerd")) return jsonResponse([]);
    if (path.endsWith("/html")) return jsonResponse({ html });
    return jsonResponse(awardDetail);
  });
}

describe("TenderNedSource.get award notes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  const get = async (html: string) => {
    vi.stubGlobal("fetch", withHtml(html));
    return new TenderNedSource(testConfig).get({ publicatieId: "442381" });
  };

  it("reads an English award notice instead of claiming it names no winner", async () => {
    const out = await get(ENGLISH_HTML);
    expect(out.item.gunning_unavailable_reason).toBeUndefined();
    expect(out.item.gunning?.winnaars[0].naam).toBe("TotalEnergies EP Nederland B.V.");
    expect(out.item.geraamdeWaarde?.euro).toBe(3_100_000);
    expect(out.access_note).not.toContain("geen winnaar");
    expect(out.access_note).toContain("raamovereenkomstWaardeBijBenadering is de verwachte waarde; geen van beide is een gegund of besteed bedrag");
  });

  it("explains that a framework maximum is a ceiling and that no contract value is given", async () => {
    const out = await get(FRAMEWORK_HTML);
    expect(out.access_note).toContain("raamovereenkomstMaximum (in gunning en gunning.percelen) is het plafond van de raamovereenkomst(en)");
    expect(out.access_note).toContain("van de raamovereenkomst(en); dat is geen gegund of besteed bedrag.");
    expect(out.access_note).toContain("Een totale contractwaarde (totaleWaarde) noemt de publicatie niet");
    expect(out.access_note).not.toContain("geen gegunde waarde");
  });

  it("reports an unsupported language instead of 'no winner'", async () => {
    const out = await get(GERMAN_HTML);
    expect(out.item.gunning).toBeNull();
    expect(out.item.gunning_unavailable_reason).toBe("language_unsupported");
    expect(out.access_note).toContain("niet in het Nederlands of Engels");
    expect(out.access_note).not.toContain("geen winnaar");
  });

  it("says when winners come without any value, and names what it could not read", async () => {
    const out = await get(CONCESSION_HTML);
    expect(out.access_note).toContain("noemt in de HTML-weergave geen gegunde waarde");
    expect(out.access_note).toContain("Niet ingelezen uit de resultatensectie");
    expect(out.access_note).toContain("Geraamde inkomsten afkomstig van de gebruikers van de concessie: 12 000 Euro");
  });

  it("says a lot value is shared by its contractors", async () => {
    const out = await get(LEGACY_SHARED_HTML);
    expect(out.item.gunning?.winnaars.every((w) => w.waarde === null)).toBe(true);
    expect(out.access_note).toContain("gezamenlijk gegund aan meerdere opdrachtnemers");
  });

  it("adds no value notes when the notice gives its contract value", async () => {
    const out = await get(OLDER_DUTCH_HTML);
    expect(out.item.gunning?.totaleWaarde?.euro).toBe(3_583_200);
    expect(out.access_note ?? "").not.toMatch(/geen gegunde waarde|Niet ingelezen|Raamovereenkomst/);
  });
});
