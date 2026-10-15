/**
 * HTML of nwo.nl and zonmw.nl as captured live (Oct 2026) and trimmed: menus,
 * cookie banners and icons removed, the markup around the parsed parts kept as
 * served (class names, attributes, <time datetime>, facet ids, pager). Titles and
 * texts are replaced by neutral examples; contact blocks hold placeholder names
 * only, so tests can check that they never reach the output.
 */

const STATUS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="24px" height="24px" viewBox="0 0 24 24" version="1.1"><g style="stroke: none; fill: none; fill-rule: evenodd"><path d="M3,3 L12.2102946,3 C12.7035709,3 13.1794472,3.18229136 13.5464827,3.51184631 Z" style="fill: currentColor" />\n        \n    </g></svg>';

export interface NwoCardFixture {
  href: string;
  title: string;
  summary?: string;
  status: string;
  budget?: string;
  closed?: boolean;
}

function nwoCard(c: NwoCardFixture): string {
  const budget = c.budget
    ? `
              <li>
          <span>Budget</span>
          ${c.budget}
        </li>
      `
    : "";
  return `<li class="list-item reveal reveal-slideup">
<div class="card${c.closed ? " card--closed" : " "}">
  <div class="card__info">
    <h3 class="card__title"><a href="${c.href}">${c.title}</a></h3>
      <p>${c.summary ?? "Een korte omschrijving van de call…"}</p>





    <ul class="listing labels">

              <li>
          <span>Status</span>
         <div class="status--${c.closed ? "closed" : "other"}">${STATUS_ICON}${c.status}</div>
        </li>

      ${budget}
    </ul>

      </div>

  <div class="card__icons">
          <svg xmlns="http://www.w3.org/2000/svg" class="internal-icon" viewBox="0 0 24 24"><path d="m12 4 8 8-8 8m-8-8h16" /></svg>
      </div>
</div>


</li>
  `;
}

function nwoFacetItem(tid: string, label: string, count: number, children = ""): string {
  return `<li class="facet-item${children ? " facet-item--expanded" : ""} form-item js-form-type-checkbox form-type-checkbox">
                <div class="facet-wrapper">
<div class="js-form-item form-item js-form-type-checkbox form-type-checkbox js-form-item-calls-bw-call-status-${tid} form-item-calls-bw-call-status-${tid}">
        <input data-f="@@calls?f%5B0%5D=calls_bw_call_status%3A${tid}" data-filter-url="/calls?f%5B0%5D=calls_bw_call_status%3A${tid}" type="checkbox" id="calls-bw-call-status-${tid}" name="calls-bw-call-status-${tid}" value="1" class="form-checkbox" />
          <label for="calls-bw-call-status-${tid}" class="option"><span class="sticky-tail">${label} <span class="count">${count}</span></span>
</label>
      </div>
                  <span class="checkbox"></span>
                                  </div>${children ? `
                <div id="filter__wrapper_calls-bw-call-status-${tid}-li" class="filter__wrapper collapse" role="region" aria-labelledby="facet-title-call_status">
                                    <ul>
                      ${children}
                  </ul>
                </div>` : ""}
                            </li>`;
}

/** Live counts of 15 Oct 2026 unless overridden. */
export const NWO_FACET_COUNTS: Record<string, number> = {
  "1867": 175,
  "62286": 17,
  "1866": 21,
  "62163": 3,
  "1868": 12,
  "62164": 10,
  "62162": 12,
  "1869": 5,
  "62165": 18,
};

function nwoStatusFacet(counts: Record<string, number>, extra = ""): string {
  const item = (tid: string, label: string, children = "") =>
    counts[tid] === undefined ? "" : nwoFacetItem(tid, label, counts[tid], children);
  const children = [item("1866", "Open voor aanvragen"), item("62163", "Open voor intentieverklaring"), item("1868", "Doorlopend")].join("\n");
  return `<li  class="block-facet--nwo-checkbox block block-facets block-facet-blockcall-status fieldset-wrapper js_loadmore filter" data-drupal-block-facet-id="call_status">
  <div class="block-facet__wrapper facet-inactive block-facets-ajax js-facet-block-id-facet-block--call-status" id="facet-block-call-status--tn5R5pa-xok"><fieldset aria-labelledby="facet-title-call_status"><legend id="facet-title-call_status">
      <button class="filter__toggle" aria-controls="call_status-wrapper">Status</button></legend>
  <div id="call_status-wrapper">
          <ul role="group" aria-labelledby="facet-title-call_status" data-drupal-facet-id="call_status" data-drupal-facet-alias="calls_bw_call_status" class="facet-inactive js-facets-nwo-checkboxes item-list__ form-checkboxes item-list__checkbox">
                          ${item("1867", "Gesloten")}
                          ${item("62286", "Open calls", children)}
                          ${item("62164", "Open voor vooraanmelding")}
                          ${item("62162", "In voorbereiding")}
                          ${item("1869", "Opent binnenkort")}
                          ${item("62165", "Procedure loopt")}
                          ${extra}
                      </ul>
              </div>
  </fieldset>
</div>
</li>`;
}

const NWO_SORT = `<div class="searchSorting">
          <div>
<span class="searchSorting-sort">Sorteren op</span>
<div class="js-form-item form-item js-form-type-select form-type-select js-form-item-sort-bef-combine form-item-sort-bef-combine form-no-label"><select data-drupal-selector="edit-sort-bef-combine" id="edit-sort-bef-combine--A3pztSPYYvQ" name="sort_bef_combine" class="form-select"><option value="nwo_entity_title_ASC">Titel A-Z</option><option value="nwo_entity_title_DESC">Titel Z-A</option><option value="bw_call_start_date_DESC">Datum geopend (nieuw-oud)</option><option value="bw_call_start_date_ASC">Datum geopend (oud-nieuw)</option><option value="bw_call_end_date_ASC" selected="selected">Sluitingsdatum (eerder-later)</option><option value="bw_call_end_date_DESC">Sluitingsdatum (later-eerder)</option><option value="search_api_relevance_DESC">Relevantie (meest-minst)</option><option value="search_api_relevance_ASC">Relevantie (minst-meest)</option></select>
</div>
      </div>
      </div>`;

function nwoPager(hasNext: boolean): string {
  return `<nav class="pager" aria-labelledby="pagination-heading--SNxm7I1_1n8">
    <h4 id="pagination-heading--SNxm7I1_1n8" class="visually-hidden">Paginering</h4>
    <ul class="pager__items js-pager__items">
                                                        <li class="pager__item is-active">
                                          <a href="?page=0">
            <span class="visually-hidden">
              Huidige pagina
            </span>1</a>
        </li>${hasNext ? `
                          <li class="pager__item pager__item--next">
          <a href="?page=1" rel="next">
            <span class="visually-hidden">Volgende pagina</span>
            <span aria-hidden="true">Volgende</span>
          </a>
        </li>` : ""}
          </ul>
  </nav>`;
}

/** One overview page of www.nwo.nl/calls. */
export function nwoListingHtml(opts: {
  cards: NwoCardFixture[];
  counts?: Record<string, number>;
  hasNext?: boolean;
  extraFacet?: string;
  withFacet?: boolean;
}): string {
  const list = opts.cards.length
    ? opts.cards.map(nwoCard).join("")
    : `                                <li class="view-empty">
              <p>
                Geen resultaten gevonden voor calls
              </p>
                          </li>`;
  return `<!DOCTYPE html>
<html lang="nl" dir="ltr"><head><meta charset="utf-8" /><title>Calls | NWO</title></head><body>
  <main class="main-container no-hero">
<article class="view view-calls view-id-calls view-display-id-page mainContent overview">
  <header class="overviewHead">
      <form action="/calls" method="get" id="views-exposed-form-calls-page" accept-charset="UTF-8">
<input placeholder="Vind calls" data-drupal-selector="edit-input" class="form-autocomplete form-text" type="text" name="input" value="" size="30" maxlength="128" />
  ${NWO_SORT}
</form>
  </header>
  <div class="overviews__filters"><aside><ul class="filters__list">
${opts.withFacet === false ? "" : nwoStatusFacet(opts.counts ?? NWO_FACET_COUNTS, opts.extraFacet)}
  </ul></aside></div>
      <div class="overviewContent">
              <ul class="listing listing-cards">
                        ${list}
                            </ul>
                      ${nwoPager(opts.hasNext ?? false)}

          </div>
</article>
  </main>
</body></html>`;
}

/** Twelve neutral NWO cards; `prefix` keeps the pages apart. */
export function nwoCards(prefix: string, n = 12, status = "Open voor aanvragen"): NwoCardFixture[] {
  return Array.from({ length: n }, (_, i) => ({
    href: `/calls/${prefix}-${i + 1}`,
    title: `${prefix} call ${i + 1}`,
    status,
    budget: "&euro;1.000.000",
  }));
}

export interface ZonmwCardFixture {
  slug: string;
  nid: string;
  title: string;
  programme?: string;
  start?: { iso: string; text: string };
  deadline?: { iso: string; text: string };
  forWhom?: string;
}

function zonmwCard(c: ZonmwCardFixture): string {
  const feature = (label: string, t?: { iso: string; text: string }) =>
    t
      ? `
                    <li>
            <strong class="title">${label}:</strong>
            <time datetime="${t.iso}" class="datetime">${t.text}</time>
          </li>`
      : "";
  return `<li>  <div class="card">
    <div class="card__content">
      <h2 class="h3 card__title">
        <a href="/nl/subsidie/${c.slug}" rel="bookmark">    <span class="field field--name-title field--type-string field--label-hidden">
          ${c.title}
    </span>
</a>
      </h2>
              <div class="card__introduction">
            <div class="clearfix text-formatted field field--name-field-introduction-formatted field--type-text-long field--label-hidden field__item">  <p><span lang="NL" dir="ltr">Deze subsidieoproep stimuleert praktijkgericht onderzoek naar ${c.title.toLowerCase()}...</span></p>
</div>
        </div>
            <div class="features">
        <ul class="features-description-list">
                      <li>
              <strong class="title">Programma:</strong>
  ${c.programme ?? "Voorbeeldprogramma Zorginnovatie"}
            </li>${feature("Start", c.start)}${feature("Deadline", c.deadline)}${c.forWhom ? `
                    <li>
              <strong class="title">Voor wie:</strong>
              <div class="field field--name-field-taxonomy-for-whom field--type-entity-reference field--label-hidden field__item">${c.forWhom}</div>
            </li>` : ""}
          <li>
                          <span class="entity-data-status" data-href="/nl/entity-date-status/${c.nid}/full"></span>
                      </li>
                  </ul>
      </div>
    </div>
    <div class="card__shape"></div>
    <div class="card__icon">
    </div>
  </div>
</li>
          `;
}

/** One overview page of www.zonmw.nl/nl/subsidies (sorted by deadline, latest first). */
export function zonmwListingHtml(opts: { total: number; cards: ZonmwCardFixture[]; sort?: string }): string {
  const sort = opts.sort ?? "field_subsidy_date_end_DESC";
  const options = [
    ["field_subsidy_date_start_DESC", "Startdatum Nieuw - Oud"],
    ["field_subsidy_date_start_ASC", "Startdatum Oud - Nieuw"],
    ["field_subsidy_date_end_DESC", "Einddatum Nieuw - Oud"],
    ["field_subsidy_date_end_ASC", "Einddatum Oud - Nieuw"],
    ["title_ASC", "Titel A - Z"],
  ]
    .map(([v, l]) => `<option value="${v}"${v === sort ? ' selected="selected"' : ""}>${l}</option>`)
    .join("");
  const content = opts.cards.length
    ? `<div class="item-list">
  <ul class="listing listing-overview listing-cards">
          ${opts.cards.map(zonmwCard).join("")}
      </ul>
</div>
    <nav class="pager" role="navigation" aria-labelledby="pagination-heading"><ul class="pager__items js-pager__items"><li class="pager__item is-active"><a href="?page=0">1</a></li></ul></nav>`
    : `
          <div class="view-empty">
        <p>
          Geen resultaten gevonden voor subsidies
        </p>
              </div>
    `;
  return `<!DOCTYPE html>
<html lang="nl" dir="ltr"><head><meta charset="utf-8" /><title>Financiering vinden | ZonMw</title></head><body>
<article  data-piwik-datalayer="{&quot;subContentType&quot;:&quot;subsidies_overview&quot;,&quot;searchResults&quot;:${opts.total}}" class="view view-subsidies-overview view-id-subsidies_overview view-display-id-page mainContent">
  <header class="overviewHead">
    <div class="js_results">
      <div class="results-wrapper">
        <div class="item first">
                      <strong aria-live="polite" role="status">${opts.total}</strong>
            resultaten                            </div>
      </div>
      <form action="/nl/subsidies" method="get" id="views-exposed-form-subsidies-overview-sorting" accept-charset="UTF-8">
<input data-drupal-selector="edit-input" class="form-autocomplete form-control" type="text" id="edit-input" name="input" value="" size="30" maxlength="128" />
        <select data-drupal-selector="edit-sort-bef-combine" id="edit-sort-bef-combine" name="sort_bef_combine" class="form-select">${options}</select>
</form>
    </div>
  </header>
  <div class="overviewContent">
    ${content}
  </div>
</article>
</body></html>`;
}

/** `/nl/entity-date-status/<nid>/full` as served. */
export function zonmwStatusBlockHtml(cls: "open" | "expected" | "closed"): string {
  const label = { open: "Open", expected: "Verwacht", closed: "Gesloten" }[cls];
  return `<strong class="title">Status:</strong>\n<span class="status--${cls}">${label}</span>\n`;
}

/** Placeholder names in the contact blocks; they must never appear in the output. */
export const CONTACT_NAME = "Contactpersoon Voorbeeld";
export const CONTACT_PHONE = "+31 6 00000000";

/** A call page of www.nwo.nl (layout of 15 Oct 2026). */
export function nwoCallPageHtml(opts: {
  title: string;
  statusAnchors: Array<{ tid: string; label: string }>;
  dates?: Array<{ label: string; iso: string; text: string; time?: string }>;
  plainFeatures?: Array<{ label: string; value: string }>;
  budget?: string;
  extraBody?: string;
}): string {
  const status = `<div class="mb-4">
    <h6 class="strong">Status</h6>
    ${opts.statusAnchors.map((a) => `<a href="/calls?f%5B0%5D=calls_bw_call_status%3A${a.tid}" hreflang="nl">${a.label}</a>`).join("\n")}
  </div>`;
  const dates = (opts.dates ?? [])
    .map(
      (d) => `  <div class="mb-4">
              <h6 class="strong">${d.label}</h6>
        <time datetime="${d.iso}" class="datetime">${d.text}</time>
 ${d.time ?? "14:00 uur"}
  </div>`,
    )
    .join("\n");
  const plain = (opts.plainFeatures ?? [])
    .map((f) => `  <div class="mb-4">
    <h6 class="strong">${f.label}</h6>
    ${f.value}
  </div>`)
    .join("\n");
  const budget = opts.budget
    ? `  <div class="mb-4">
    <h6 class="strong">Budget</h6>
    ${opts.budget}
  </div>`
    : "";
  return `<!DOCTYPE html>
<html lang="nl" dir="ltr"><head><meta charset="utf-8" /><title>${opts.title} | NWO</title></head><body>
  <main class="main-container no-hero">
<article class="mainContent single" id="main-content">
  <nav aria-labelledby="system-breadcrumb"><h2 id="system-breadcrumb" class="visually-hidden">Kruimelpad</h2><ol class="breadcrumb"><li><a href="/">Home</a></li><li><a href="/calls">Calls</a></li></ol></nav>
            <header class="articleHead">
              <div class="articleHead__content">
                <h1 class="articleHead__title">
                  ${opts.title}
                </h1>
                <div class="articleHead__intro">
                  <p>Met deze call ondersteunt NWO onderzoek naar waterstof in de energietransitie.</p>
                </div>
              </div>
            </header>
            <div class="articleContent rs_preserve">
                <div class="call-tabs">
                  <nav role="tablist">
                    <div class="nav nav-tabs nav-fill" id="nav-tab">
                        <button class="nav-link active" id="nav-finance-orient" type="button" role="tab"><span class="nav-link__number">1</span><span class="nav-link__text">Oriënteren</span></button>
                        <button class="nav-link " id="nav-finance-request" type="button" role="tab"><span class="nav-link__number">3</span><span class="nav-link__text">Indienen</span></button>
                    </div>
                  </nav>
                  <div class="tab-content" id="nav-tab-content">
                      <div class="tab-pane fade show active" id="nav-finance-orient-tab" role="tabpanel">
                        <div class="tab-pane-content">
  <div class="paragraph paragraph--type--expanders-list paragraph--view-mode--default">
      <div class="accordion" id="accordion-924896">
<div class="accordion-item accordion-item--paragraph" id="accordion-item-waarvoor">
  <h2 class="accordion-heading" id="accordion-item-924887-heading">
    <button
      class="accordion-button collapsed"
      type="button"
      data-bs-toggle="collapse"
      aria-controls="accordion-item-924887-content">
      <span class="accordion-title">
        Waarvoor
              </span>
      <span class="accordion-icons"><span class="accordion-icons__plus"></span><span class="accordion-icons__min"></span></span>
    </button>
  </h2>
  <div id="accordion-item-924887-content" class="accordion-collapse collapse">
    <div class="accordion-body"><p>De call financiert onderzoek naar de opslag van waterstof.</p></div>
  </div>
</div>
</div></div>
          ${opts.extraBody ?? ""}
          <h2 id="criteria" class="nwo-anchor">Criteria</h2><ol><li><span>Wetenschappelijke kwaliteit (weging: 50%).</span></li><li><span>Kennisbenutting (weging: 50%).</span></li></ol>
  <ul class="listing listing-files">
          <li><article class="media media--type-file media--view-mode-paragraph">
        <div  class="file file--mime-application-pdf file--application-pdf">
    <ul class="listing listing-files">
      <li class='list_item'>
        <a href="/sites/nwo/files/media-files/Call-for-proposals-waterstof-2026.pdf" target="_blank" download>
          <div class="info">
                          <h5>Waterstof 2026 | call for proposals</h5>
                        <span class="file-info"> <span>PDF</span> <span class="line">|</span> <span>603.29 kB</span></span>
          </div>
        </a>
      </li>
    </ul>
  </div>
  </article>
</li>
  </ul>
                        </div>
                      </div>
                  </div>
                </div>
            </div>
      <div class="col col-lg-30 col-sidebar">
        <aside>
                <ul class="listing listing-files">
                  <li class="list-item">
                    <div class="info">
                      <a href="/sites/nwo/files/media-files/Aanvraagformulier-waterstof-2026.docx">
                        <h5>Download aanvraagformulier</h5>
                      </a>
                    </div>
                  </li>
                </ul>
                          <div class="sidebar--content">
                <h3 class="title">Kenmerken</h3>
                ${status}
${dates}
${plain}
${budget}
  <div class="mb-4">
    <h6 class="strong">Onderzoeksprogramma</h6>
    Waterstofprogramma
  </div>
              </div>
      <div id="contact-onze-medewerkers-helpen-u-graag-verder" class="js--anchor__inside paragraph paragraph--type--contact paragraph--view-mode--default sidebar col-12 multiple reveal reveal-slideup">
                  <h3 class="contact__title">
            Onze medewerkers helpen u graag verder
          </h3>
                          <div class="contact__wrapper"><div class="contact__info">
  <div class="contact__content">
    <div class="block">
      <div class="mb-4">
              <h6 class="strong">
          ${CONTACT_NAME}
        </h6>
                        <span class="function">
            Programmamanager
          </span>
              </div>
      <div class="mb-4">
                    <div class="contact__phone"><a href="tel:+31600000000">${CONTACT_PHONE}</a></div>
                    <div class="contact__email"><a href="mailto:programma@example.org">Verstuur e-mail</a></div>
                      </div>
    </div>
  </div>
</div></div></div>
        </aside>
      </div>
</article>
      </main>
</body></html>`;
}

/** A subsidy page of www.zonmw.nl (layout of 15 Oct 2026). */
export function zonmwCallPageHtml(opts: {
  title: string;
  nid: string;
  deadline: { iso: string; text: string };
  opening?: string;
  budget?: string;
  perApplication?: string;
  programmes?: string[];
  metadataStatus?: string;
}): string {
  const li = (label: string, value?: string) =>
    value
      ? `
                                    <li>
                    <strong class="title">${label}:</strong>
                    ${value}
                  </li>`
      : "";
  const programmes = opts.programmes?.length
    ? `
                    <li>
                      <strong class="block title">Gerelateerde programma's:</strong>
      <ul class="field field--name-field-related-programs field--type-entity-reference field--label-hidden field__items">
              ${opts.programmes.map((p) => `<li  class="field__item"><a href="/nl/programma/voorbeeld" hreflang="nl">${p}</a></li>`).join("\n              ")}
          </ul>
                    </li>`
    : "";
  return `<!DOCTYPE html>
<html lang="nl" dir="ltr"><head><meta charset="utf-8" /><title>${opts.title} | ZonMw</title></head><body>
    <main data-piwik-datalayer="{&quot;contentType&quot;:&quot;subsidy&quot;,&quot;pageLanguage&quot;:&quot;nl&quot;,&quot;publicationDate&quot;:&quot;2026-10-14&quot;,&quot;status&quot;:&quot;${opts.metadataStatus ?? "open"}&quot;}" id="main-content">
<article about="/nl/subsidie/voorbeeld" class="node node--type-subsidy node--default has-sidebar">
  <div class="row">
    <div class="node__main col-12 col-lg-8 ">
      <div class="node__main-wrapper">
        <div class="node__head">
    <nav aria-labelledby="system-breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="/nl">Home</a></li></ol></nav>
          <h1 class="node__head-title">    <span class="field field--name-title field--type-string field--label-hidden">
          ${opts.title}
    </span>
</h1>
          <span class="node__head-subtitle">
                          <span class="entity-data-status" data-href="/nl/entity-date-status/${opts.nid}/icon"></span>
                        <span class="deadline__text">Deadline:</span>
            <span class="deadline__date"><time datetime="${opts.deadline.iso}" class="datetime">${opts.deadline.text}</time>
</span>
          </span>
              <div class="field__item"><a href="/sites/zonmw/files/2026-10/Subsidieoproep-voorbeeld.pdf"  class="btn btn-primary subsidy-download-all btn-download-all" download target="_blank">
  Download volledige subsidieoproep
</a>
</div>
        </div>
        <div class="node__content">
                      <div class="node__introduction">
            <div class="clearfix text-formatted field field--name-field-introduction-formatted field--type-text-long field--label-hidden field__item"><p>Deze subsidieoproep stimuleert zorginnovatie in de wijk.</p>
</div>
            </div>
                <div class="tab-pane fade show active" id="nav-orientate" role="tabpanel" aria-labelledby="nav-orientate-tab">
                    <div class="node__toc node__toc--subsidy node__toc--page">
                      <span class="node__toc-title">Op deze pagina</span>
                      <ul class="listing theme-menu node__toc-listing">
                          <li class="list-item">
                            <a href="#orientate-who"> Wie kan aanvragen</a>
                          </li>
                      </ul>
                    </div>
                    <div class="orientate-block" id="orientate-who">
                      <h2 class="h2">Wie kan aanvragen</h2>
            <div class="clearfix text-formatted field field--name-field-orientate-who field--type-text-long field--label-hidden field__item"><p>Een samenwerkingsverband van een zorgorganisatie en een kennisinstelling.</p></div>
                    </div>
                    <div class="orientate-block" id="orientate-what">
                      <h2 class="h2">Wat aanvragen</h2>
            <div class="clearfix text-formatted field field--name-field-orientate-what field--type-text-long field--label-hidden field__item"><p>U kunt maximaal € 30.000,- per project aanvragen.</p></div>
                    </div>
                </div>
                <div class="tab-pane fade" id="nav-apply" role="tabpanel" aria-labelledby="nav-apply-tab">
    <h2 class="field__label">Relevante informatie</h2>
    <p><a href="/sites/zonmw/files/2026-01/Algemene-subsidiebepalingen-ZonMw-2026.pdf">Algemene subsidiebepalingen</a></p>
                </div>
        </div>
      </div>
    </div>
          <div class="node__sidebar col-12 col-lg-4">
        <div class="node__sidebar-inner">
                    <div class="node__sidebar-bottom">
            <div class="features">
              <h2 class="h3 features__title">
                Kenmerken              </h2>
              <div class="features__block">
                <ul class="features-description-list">
                  <li>
                                          <span class="entity-data-status" data-href="/nl/entity-date-status/${opts.nid}/full"></span>
                                      </li>${li("Openingsdatum", opts.opening)}${li("Budget subsidieronde", opts.budget)}${li("Budget per aanvraag", opts.perApplication)}${programmes}
                                  </ul>
              </div>
            </div>
      <div class="field field--name-field-page-sidebar-paragraphs field--type-entity-reference-revisions field--label-hidden field__items">
              <div class="field__item">  <div class="paragraph paragraph--type--contacts paragraph--view-mode--default">
<h2 class="h3">Contact</h2>
      <div class="card">
            <div class="card__content">
        <h2 class="h4 card__title">
          ${CONTACT_NAME}
        </h2>
        <p><a href="tel:+31600000000">${CONTACT_PHONE}</a></p>
      </div>
      </div>
  </div></div>
      </div>
          </div>
        </div>
      </div>
  </div>
</article>
    </main>
</body></html>`;
}
