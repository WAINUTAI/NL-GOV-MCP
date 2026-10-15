import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTES } from "../src/router/routes.js";
import { logger } from "../src/utils/logger.js";
import { asTraced, createAskHarness, type AskTrace } from "./helpers/route-trace.js";
import { ADVERSARIAL_NON_DSO, DSO_QUESTIONS, LEFT_TO_OTHER_ROUTES, NON_DSO_QUESTIONS, NOT_THIS_ROUTE, ROUND_FOUR, ROUND_THREE, ROUND_TWO_NON_DSO, SUBSIDIE_QUESTIONS } from "./helpers/router-corpus.js";

/* ------------------------------------------------------------------ */
/*  The routing check of nl_gov_ask over the labelled corpus.         */
/*  1. dryRun plans the source the execution asks first: every        */
/*     question runs for real with fetch stubbed (empty answers), and */
/*     the first request(s) must be the planned source(s).            */
/*  2. The first route asks the source the question's label names.    */
/*     Known mismatches are listed below: a new one fails the test,   */
/*     and so does a listed one that now routes right (remove it).    */
/* ------------------------------------------------------------------ */

/** The source each label is for, as dryRun names it; a route that asks it first (or alongside others) passes. */
const LABEL_SOURCES: Record<string, readonly string[]> = {
  cbs: ["cbs"],
  tweedeKamer: ["tk", "tweede_kamer_debatten"],
  tk: ["tk", "tweede_kamer_debatten"],
  bekendmakingen: ["ob"],
  ob: ["ob"],
  verordeningen: ["ob"],
  verordening: ["ob"],
  // Disciplinary rulings are case law too, in their own collection.
  rechtspraak: ["rechtspraak", "tuchtrecht"],
  knmi: ["knmi"],
  raad: ["ori"],
  // ORI holds the records of provinces as well.
  staten: ["ori"],
  tenders: ["tenderned"],
  algoritmes: ["algoritmeregister"],
  algoritme: ["algoritmeregister"],
  apiRegister: ["api"],
  api: ["api"],
  begroting: ["budget"],
  rijksoverheid: ["rijk"],
  rijk: ["rijk"],
  eu: ["eu_cellar"],
  duo: ["duo"],
  lucht: ["luchtmeetnet"],
  verkiezingen: ["verkiezingsuitslagen"],
  gewas: ["brp_gewaspercelen"],
  catalogi: ["samenwerkende_catalogi"],
  // Organisation and policy questions: the document search (ORI, publications, Tweede Kamer, Rijksoverheid).
  beleid: ["ori", "ob", "tk", "rijk"],
  datasets: ["data_overheid"],
  dso: ["dso_omgevingsdocumenten"],
  // A ruling named by its ECLI, an artikel of a named law, a research body's publications.
  uitspraak: ["rechtspraak_uitspraak"],
  wetArtikel: ["wetten_bwb"],
  rekenkamer: ["rekenkamer"],
  scp: ["scp"],
  wodc: ["wodc"],
  // Subsidies and funding calls, by funder.
  subsidiesRvo: ["rvo_subsidies"],
  subsidiesEu: ["eu_funding"],
  subsidiesOnderzoek: ["nl_onderzoekscalls"],
};

/**
 * Labels for a source nl_gov_ask has no route to (addresses, vehicles, laws,
 * permits, plans, ...): it should end on the data.overheid.nl catalogue, not
 * on a route that answers another question.
 */
const NO_ROUTE_LABELS = [
  "adressen", "adres", "rdw", "bestemmingsplannen", "bestemmingsplan", "vergunningen", "vergunning", "wetten",
  "energielabels", "energielabel", "politie", "ongevallen", "ov", "water", "bodem", "zorg", "dnb", "rivm",
  "organisaties", "eurostat",
];

/** Labels that name a test aim (tricky wording, a DSO word for another source), not a source: consistency only. */
const AIM_LABELS = [
  "overig", "dsoWoordAndereBron", "tricky", "falseAddress", "omgevingswetLawPolicy", "documentWordOtherSource",
  "ontwerpTerInzage", "lawDocumentWord", "plainNonDso", "adversarial", "leftToOther",
];

/**
 * Questions whose first route does not ask the labelled source: routing bugs
 * or labels to correct. "label | question -> planned sources".
 */
const KNOWN_LABEL_MISMATCHES: string[] = [
  // The question's words are missing from its route's term list or intent (plural, compound, synonym).
  "begroting | Wat kost de invoering van de Omgevingswet? -> data_overheid",
  "cbs | Hoeveel mensen wonen er in de wijk Lunetten in Utrecht? -> data_overheid",
  "knmi | Hoe warm was het gisteren in Maastricht? -> data_overheid",
  "begroting | Wat kost het DSO per jaar? -> data_overheid",
  "begroting | Hoeveel geld gaat naar woningbouw in 2025? -> data_overheid",
  "eu | Europese regels voor natuurherstel -> data_overheid",
  "verkiezingen | Hoeveel stemmen kreeg de VVD in Amersfoort? -> data_overheid",
  "gewas | Welke gewassen worden geteeld in de Noordoostpolder? -> data_overheid",
  "gewas | Gewaspercelen rond Dronten -> data_overheid",
  // Provincial councils (Provinciale/Gedeputeerde Staten) have no council route: they end on the catalogue or the national document search.
  "raad | Wat hebben Gedeputeerde Staten van Gelderland besloten over windmolens? -> data_overheid",
  "raad | Welke programma's heeft Gedeputeerde Staten van Utrecht vastgesteld? -> data_overheid",
  "staten | Wat besloten Provinciale Staten van Utrecht over de omgevingsverordening? -> data_overheid",
  "staten | Gedeputeerde Staten van Gelderland over windmolens -> data_overheid",
  "staten | Statenvoorstel omgevingsverordening Noord-Holland -> data_overheid",
  "staten | Statenleden over de omgevingsvisie van Drenthe -> ob,tk,rijk",
  "staten | Provinciale Staten Zuid-Holland omgevingsvisie vaststelling -> ob,tk,rijk",
  "staten | Wat zei Gedeputeerde Staten van Fryslân over het omgevingsprogramma? -> data_overheid",
  "staten | Statenvergadering over de omgevingsverordening van Overijssel -> data_overheid",
  "staten | Statenbrief omgevingsverordening Utrecht -> data_overheid",
  // A broad term list takes a question for a source nl_gov_ask has no route to (CBS: 'woningen', 'statistieken', 'werkloosheid'; DUO: 'scholen').
  "energielabels | Hoeveel woningen hebben energielabel A in Utrecht? -> cbs",
  "energielabel | Hoeveel woningen in Amersfoort hebben label C of slechter? -> cbs",
  "energielabel | Energielabels van scholen in Utrecht -> duo",
  "dnb | DNB statistieken hypotheken 2025 -> cbs",
  "eurostat | Eurostat werkloosheid in de eurozone -> cbs",
  // The document search (ORI, publications, Tweede Kamer, Rijksoverheid) takes questions about laws, organisations or plans.
  "bestemmingsplannen | Welke ruimtelijke plannen gelden er in Amersfoort? -> ori",
  "bestemmingsplan | Ruimtelijke plannen bij Damrak 1 Amsterdam -> ob,tk,rijk",
  "bestemmingsplan | Bestemmingsplannen in de provincie Utrecht -> ob,tk,rijk",
  "wetten | Hoe regelt de Omgevingswet de omgevingsvisie? -> ob,tk,rijk",
  "organisaties | Wat doet de Omgevingsdienst Haaglanden? -> ob,tk,rijk",
  "organisaties | Welke ministeries zijn er? -> ob,tk,rijk",
  // Policy questions without a policy signal the detector knows, or with an enforcement word that picks another route.
  "beleid | Hoe verliep de Omgevingswet invoering 2024 in Utrecht? -> data_overheid",
  "beleid | omgevingsdienst Utrecht handhaving -> rechtspraak",
  "beleid | Wat is de rol van de omgevingsdienst bij bodemsanering? -> data_overheid",
  "beleid | Hoe staat het met de woningbouw in Utrecht? -> data_overheid",
  "beleid | Welke regels gelden op Koningsdag 2026 in Amsterdam? -> data_overheid",
  "beleid | Hoe staat het met de energietransitie in Arnhem? -> data_overheid",
  // Without OVERHEID_API_KEY the API register is left out of the multi-source plan.
  "api | Welke API heeft de overheid voor bekendmakingen? -> ob",
];

interface Case {
  label: string;
  question: string;
  dsoKey: boolean;
}

const cases: Case[] = [
  ...Object.entries(NON_DSO_QUESTIONS).flatMap(([label, qs]) => qs.map((question) => ({ label, question, dsoKey: false }))),
  ...Object.entries(ROUND_TWO_NON_DSO).flatMap(([label, qs]) => qs.map((question) => ({ label, question, dsoKey: false }))),
  ...Object.entries(ROUND_THREE).flatMap(([label, qs]) => qs.map((question) => ({ label, question, dsoKey: false }))),
  ...Object.entries(ROUND_FOUR).flatMap(([label, qs]) => qs.map((question) => ({ label, question, dsoKey: false }))),
  ...Object.entries(SUBSIDIE_QUESTIONS).flatMap(([label, qs]) => qs.map((question) => ({ label, question, dsoKey: false }))),
  ...ADVERSARIAL_NON_DSO.map((question) => ({ label: "adversarial", question, dsoKey: false })),
  // With the key: these are the questions the DSO route takes, or leaves on purpose.
  ...LEFT_TO_OTHER_ROUTES.map((question) => ({ label: "leftToOther", question, dsoKey: true })),
  ...DSO_QUESTIONS.map((question) => ({ label: "dso", question, dsoKey: true })),
];

const results: Array<Case & { planned: string[]; trace: AskTrace }> = [];

describe("nl_gov_ask route chain", () => {
  it("is tried by the handler in the order dryRun plans it", () => {
    // The handler enters each route with takes("<id>"), in the order it tries them.
    const handler = readFileSync(new URL("../src/router/nl-gov-ask.ts", import.meta.url), "utf8");
    const tried = [...handler.matchAll(/\btakes\("([a-z_]+)"\)/g)].map((m) => m[1]);
    // data.overheid.nl ends the handler without a condition.
    expect(tried).toEqual(ROUTES.map((route) => route.id).filter((id) => id !== "data_overheid"));
  });
});

describe("nl_gov_ask routing over the labelled corpus", () => {
  const harness = createAskHarness();
  const logLevel = logger.level;

  beforeAll(async () => {
    logger.level = "warn";
    // No keys from the environment: the plan and the routes depend on them.
    vi.stubEnv("OVERHEID_API_KEY", "");
    vi.stubEnv("KNMI_API_KEY", "");
    for (const c of cases) {
      vi.stubEnv("DSO_API_KEY", c.dsoKey ? "test-key" : "");
      const plan = await harness.plan(c.question);
      results.push({ ...c, planned: plan.estimated_sources as string[], trace: await harness.trace(c.question) });
    }
  }, 60_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    logger.level = logLevel;
  });

  it("knows every label of the corpus", () => {
    const known = new Set([...Object.keys(LABEL_SOURCES), ...NO_ROUTE_LABELS, ...AIM_LABELS]);
    expect([...new Set(cases.map((c) => c.label))].filter((label) => !known.has(label))).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(887);
  });

  it("plans the source(s) the execution asks first", () => {
    expect(results).toHaveLength(cases.length);
    const inconsistent = results
      .filter((r) => JSON.stringify(asTraced(r.planned)) !== JSON.stringify(asTraced(r.trace.firstSources)))
      .map((r) => `${r.label} | ${r.question}: dryRun ${r.planned.join(",")}, execution ${r.trace.firstSources.join(",") || r.trace.error || "-"}`);
    expect(inconsistent).toEqual([]);
  });

  it("routes each question to the source its label names, apart from the known mismatches", () => {
    const mismatches = results
      .filter((r) => !AIM_LABELS.includes(r.label))
      .filter((r) => {
        const expected = NO_ROUTE_LABELS.includes(r.label) ? ["data_overheid"] : LABEL_SOURCES[r.label];
        return !r.planned.some((source) => expected.includes(source));
      })
      .map((r) => `${r.label} | ${r.question} -> ${r.planned.join(",")}`);
    const added = mismatches.filter((m) => !KNOWN_LABEL_MISMATCHES.includes(m));
    const resolved = KNOWN_LABEL_MISMATCHES.filter((m) => !mismatches.includes(m));
    expect({ added, resolved }, "new mismatches are routing bugs or wrong labels; resolved ones leave KNOWN_LABEL_MISMATCHES").toEqual({ added: [], resolved: [] });
  });

  it("keeps the near misses of the round-three routes off those routes", async () => {
    const taken: string[] = [];
    for (const [source, questions] of Object.entries(NOT_THIS_ROUTE)) {
      for (const question of questions) {
        vi.stubEnv("DSO_API_KEY", "");
        const planned = (await harness.plan(question)).estimated_sources as string[];
        if (planned.includes(source)) taken.push(`${source} | ${question}`);
      }
    }
    expect(taken).toEqual([]);
  });
});
