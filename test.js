/* Tests for wire-gauge-drill-chart.html
 *
 * Run:  npm test   (or: node test.js — needs `npm install` once for jsdom)
 *
 * The page runs UNMODIFIED inside jsdom (a real DOM implementation), so everything is
 * exercised the way a browser would: scripts execute on load, buttons are clicked,
 * events are dispatched. No stubs, no eval-slicing.
 *
 * Chart invariants — the ones we keep getting wrong:
 *   1. SORT ORDER — within every chart row, the list of drill-bit options (the bars,
 *      including the underlined current-row baseline) must read smallest -> largest,
 *      the same direction the chart itself is sorted. A human picking "smaller" or
 *      "larger" must never have to re-sort the options by eye.
 *   2. METRIC CONSISTENCY — every metric size offered as an equivalence/bracket must be
 *      a real first-class metric row in the chart (no phantom sizes you can't look up).
 *   3. The baseline is the current row, underlined (not italic), and sits in its
 *      natural sorted position (smaller options above it, larger below).
 *
 * Calculator behavior:
 *   4. One card on load; the first card has no [-]; [+] inserts a copy right after the
 *      clicked card; [-] removes exactly that card.
 *   5. Known conversions come out right (1/8", #30, 3.2mm), the strip is sorted
 *      smallest -> largest, and a TRUE exact match (no tolerance) wears the dashed
 *      requested-size border itself — both bits when two systems match exactly — while
 *      the empty dashed marker appears only when nothing matches exactly.
 *   6. Typing #, ", or m sets the unit menu and is stripped from the field; Enter runs
 *      the calc; bad input shows the error line, not a crash.
 *   7. The Closest menus re-run EVERY live card (and none of the deleted ones).
 */
const fs   = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "wire-gauge-drill-chart.html"), "utf8");
const js   = html.split("<script>")[1].split("</script>")[0];

let failures = 0, checks = 0;
function ok(cond, msg){ checks++; if(!cond){ failures++; console.error("  ✗ " + msg); } }

/* ---------- page + event helpers ---------- */

function newPage(){
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(e));
  const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole: vc });
  return { win: dom.window, doc: dom.window.document, errors };
}
function fire(win, el, type){ el.dispatchEvent(new win.Event(type, { bubbles: true })); }
function typeInto(win, input, text){ input.value = text; fire(win, input, "input"); }
function pressEnter(win, input){
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}
function setSelect(win, sel, value){ sel.value = value; fire(win, sel, "change"); }

/* ---------- chart parsing (real DOM queries) ---------- */

function parseRows(doc){
  return [...doc.querySelectorAll("#rows tr")].map(tr => {
    const cellVal = sys => {
      const span = tr.querySelector(`td.${sys} span`);
      return span && span.classList.contains("val") ? span.textContent : null;
    };
    const bars = [...tr.querySelectorAll(".bars .row")].map(row => {
      const lab = row.querySelector(".lab");
      const m = lab.textContent.match(/(\d+\.\d{4})″/);          // first ″ value = this bar's dia
      return { dia: m ? parseFloat(m[1]) : NaN,
               label: lab.querySelector("b").textContent,
               isBase: lab.classList.contains("base") };
    });
    const allLabels = [...tr.querySelectorAll(".bars b")].map(b => b.textContent); // incl. folded equivalencies
    return { gauge: cellVal("gauge"), std: cellVal("std"), metric: cellVal("metric"), bars, allLabels };
  });
}

function checkChart(label, doc, frac, metric){
  console.log(`\n# chart: ${label}  (closest = ${frac} / ${metric})`);
  const rows = parseRows(doc);
  ok(rows.length > 120, `rendered a full chart (${rows.length} rows)`);

  // metric sizes that are real chart rows
  const metricRowSet = new Set(rows.map(r => r.metric).filter(Boolean));

  let badSort = 0, badBaselinePos = 0, multiBase = 0, phantomMetric = 0, fracOnlyChecked = 0;
  for(const r of rows){
    const dias = r.bars.map(b => b.dia);

    // (1) non-decreasing top -> bottom
    for(let i = 1; i < dias.length; i++) if(dias[i] < dias[i-1] - 1e-9) badSort++;

    // (3) at most one baseline, correctly positioned
    const baseIdx = r.bars.findIndex(b => b.isBase);
    if(r.bars.filter(b => b.isBase).length > 1) multiBase++;
    if(baseIdx >= 0){
      const bd = r.bars[baseIdx].dia;
      if(r.bars.slice(0, baseIdx).some(b => b.dia > bd + 1e-9)) badBaselinePos++;
      if(r.bars.slice(baseIdx + 1).some(b => b.dia < bd - 1e-9)) badBaselinePos++;
    }

    // (2) every metric bit shown must be a real metric row
    for(const lab of r.allLabels)
      if(/\bmm$/.test(lab) && !metricRowSet.has(lab)) phantomMetric++;

    // (concrete shape) a fractional-only row: smaller options, baseline, larger options
    if(r.std && !r.gauge && !r.metric && baseIdx >= 0){
      fracOnlyChecked++;
      ok(r.bars[baseIdx].label === r.std, `fraction-only row: baseline is the fraction (${r.std})`);
      ok(baseIdx > 0,                      `fraction-only row ${r.std}: has a smaller option above the baseline`);
      ok(baseIdx < r.bars.length - 1,      `fraction-only row ${r.std}: has a larger option below the baseline`);
    }
  }
  ok(badSort === 0,        `every row's options are sorted smallest→largest (${badSort} out-of-order)`);
  ok(badBaselinePos === 0, `baseline always sits in its sorted position (${badBaselinePos} misplaced)`);
  ok(multiBase === 0,      `at most one baseline per row (${multiBase} rows with >1)`);
  ok(phantomMetric === 0,  `no metric equivalence is offered that isn't a chart row (${phantomMetric} phantom)`);
  ok(fracOnlyChecked > 0,  `found fraction-only rows to check the canonical shape (${fracOnlyChecked})`);
}

/* ---------- calculator parsing ---------- */

const cards = doc => [...doc.querySelectorAll("#calcs .calc")];

function runCard(win, card, text){
  typeInto(win, card.querySelector(".calc-val"), text);
  card.querySelector(".calc-go").click();
}
// strip rows -> {label, dia, rel, isTarget, exactHit}; label is the bit ("1/8\"", "3 mm", "#30")
function parseStrip(card){
  return [...card.querySelectorAll(".cstrip .srow")].map(row => {
    const lab = row.querySelector(".lab");
    const m = lab.textContent.match(/(\d+\.\d{4})″/);
    const rel = lab.querySelector(".rel");
    const bar = row.querySelector(".cbar, .tgt");
    return { isTarget: bar.classList.contains("tgt"),   // empty dashed marker (no exact match)
             exactHit: bar.classList.contains("req"),   // a bit wearing the requested-size border
             title: bar.getAttribute("title") || "",
             label: lab.querySelector("b").textContent,
             dia: m ? parseFloat(m[1]) : NaN,
             rel: rel ? rel.textContent : "" };
  });
}
const stripLabels = card => parseStrip(card).filter(r => !r.isTarget).map(r => r.label);

/* =========================================================================
 * Chart invariants under each Closest-menu combination
 * =======================================================================*/
{
  const { win, doc, errors } = newPage();
  ok(errors.length === 0, `page loads without script errors (${errors.map(e=>e.message)})`);

  checkChart("default", doc, "any", "any");

  setSelect(win, doc.getElementById("calcFrac"), "16");
  checkChart("coarse imperial", doc, "16", "any");

  setSelect(win, doc.getElementById("calcFrac"), "any");
  setSelect(win, doc.getElementById("calcMetric"), "1");
  checkChart("whole-mm metric", doc, "any", "1");
}

/* =========================================================================
 * Static (CSS/markup) guards
 * =======================================================================*/
console.log("\n# static markup");
ok(/\.bars \.lab\.base\{text-decoration:underline\}/.test(html), "baseline is underlined");
ok(!/\.bars \.lab\.base\{font-style:italic\}/.test(html),        "baseline is NOT italic");
ok(/const REF_PX = 30\b/.test(js),                               "reference marker width is 30px");
{
  const { doc } = newPage();
  ok(/--ref:30px/.test(doc.querySelector("#rows .bars").getAttribute("style")), "rendered rows use --ref:30px");
  ok(["wire gauge", "standard (fractional inch)", "metric"]
       .some(s => (doc.querySelector("#rows .bars .bar").getAttribute("title") || "").startsWith(s)),
     "chart bars carry system-name hover text");

  // strip legend sits between the calculators and the chart, and explains the dashed border
  const legend = doc.querySelector(".calc-legend");
  ok(!!legend && /Requested size/.test(legend.textContent) && !!legend.querySelector(".sw-req"),
     "legend includes the dashed requested-size swatch");
  ok(!!legend && (legend.compareDocumentPosition(doc.getElementById("calcs")) & 2)   // 2 = PRECEDING
              && (legend.compareDocumentPosition(doc.querySelector(".wrap")) & 4),   // 4 = FOLLOWING
     "legend sits between the calculators and the chart");
  ok(/\.sw-req\{[^}]*dashed/.test(html), "requested-size swatch is drawn with a dashed border");

  // embedded license: header link opens it in a new tab; :target reveals it
  const lic = doc.getElementById("license");
  ok(!!lic && /TL;DR/.test(lic.textContent),                     "license section with a TL;DR is embedded");
  ok(/credit\s/.test(lic.textContent) && /Avram Dorfman/.test(lic.textContent) && /est\.org/.test(lic.textContent),
     "TL;DR requires credit to Avram Dorfman and est.org");
  ok(!!lic.querySelector('a[href="https://est.org/wire-gauge-converter/"]'), "license links back to the original URL");
  ok(!!lic.querySelector('a[href="https://creativecommons.org/licenses/by/4.0/"]') &&
     /CC\sBY\s4\.0/.test(lic.textContent),                       // \s matches the &nbsp; in "CC BY 4.0"
     "license is CC BY 4.0 with a link to the deed");
  const link = doc.querySelector(".copyright a");
  ok(!!link && link.getAttribute("href") === "#license" && link.getAttribute("target") === "_blank",
     "copyright link under the header opens #license in a new tab");
  ok(/\.license\{display:none/.test(html) && /\.license:target\{display:block\}/.test(html),
     "license is hidden until targeted");

  // provenance markers: id sprinkled through head/CSS/JS, meta tags, runtime origin stamp
  const marks = (html.match(/wgc-7f3e91/g) || []).length;
  ok(marks >= 5, `provenance id appears throughout the source (${marks} occurrences)`);
  ok(doc.querySelector('meta[name="author"]') && doc.querySelector('meta[name="source"]'),
     "author and source meta tags are present");
  ok(doc.documentElement.dataset.origin === "https://est.org/wire-gauge-converter/",
     "the running page stamps data-origin on the root element");
}

/* =========================================================================
 * Calculator: conversions
 * =======================================================================*/
console.log("\n# calculator: conversions");
{
  const { win, doc } = newPage();
  const card = cards(doc)[0];

  // 1/8" — at the default 0.5% tolerance only the true match wears the border;
  // 3.2 mm (+0.8%) stays an ordinary bracket line
  runCard(win, card, "1/8");
  let strip = parseStrip(card);
  ok(strip.every(r => !r.isTarget),                "no separate dashed marker when an exact match exists");
  const hits = strip.filter(r => r.exactHit);
  ok(hits.length === 1 && hits[0].label === '1/8"' && hits[0].dia === 0.125,
     `only 1/8" wears the border at the default 0.5% (got ${hits.map(r => r.label)})`);
  ok(stripLabels(card).filter(l => l === '1/8"').length === 1, "the exact match appears once, not twice");
  ok(/3\.175 mm/.test(card.textContent),           "exact-match line shows the mm conversion at 3 decimals (3.175 mm)");
  ok(!/your size|standard|metric|gauge/i.test(card.querySelector(".cstrip").textContent),
     "no measurement-system words in the strip text");
  const dias = strip.map(r => r.dia);
  ok(dias.every((d,i) => !i || d >= dias[i-1] - 1e-9), "strip is sorted smallest→largest");
  const byLabel = Object.fromEntries(strip.map(r => [r.label, r]));
  ok(byLabel["#31"] && byLabel["#30"],             "gauge brackets 1/8\" with #31 below and #30 above");
  ok(byLabel["3 mm"] && byLabel["3.2 mm"],         "metric shows 3 mm and 3.2 mm");
  ok(byLabel["3.2 mm"].rel === "+0.8%" && !byLabel["3.2 mm"].exactHit,
     `3.2 mm is an ordinary +0.8% bracket at 0.5% (got ${byLabel["3.2 mm"] && byLabel["3.2 mm"].rel})`);
  ok(byLabel['1/8"'].rel === "",                   "the strictly equal bit shows no ±%");
  ok(byLabel['1/8"'].title === "standard (fractional inch) — exact match",
     `exact bar hover names the system + exact match (got "${byLabel['1/8"'].title}")`);
  ok(byLabel["#31"].title === "wire gauge",        `bracket bar hover names the system (got "${byLabel["#31"].title}")`);

  // 1/4" — TWO strictly exact matches (1/4" and letter E are both 0.250") -> both get borders
  runCard(win, card, "1/4");
  strip = parseStrip(card);
  const both = strip.filter(r => r.exactHit).map(r => r.label).sort();
  ok(both.length === 2 && both[0] === '1/4"' && both[1] === "E",
     `1/4" borders both exact matches, 1/4" and E (got ${both})`);
  ok(strip.every(r => !r.isTarget),                "still no separate dashed marker with two exact matches");

  // 0.13" — only 3.3 mm (0.12992", off by 0.00008") is within TOL -> it wears the border
  runCard(win, card, "0.13");
  strip = parseStrip(card);
  const tolHit = strip.filter(r => r.exactHit);
  ok(tolHit.length === 1 && tolHit[0].label === "3.3 mm" && tolHit[0].rel === "−0.1%",
     `0.13" pulls TOL-close 3.3 mm into the border, ±% kept (got ${tolHit.map(r => r.label + " " + r.rel)})`);
  ok(strip.every(r => !r.isTarget),                "TOL-close match suppresses the empty marker");

  // 0.132" — nothing within TOL of anything -> the empty dashed marker returns
  runCard(win, card, "0.132");
  strip = parseStrip(card);
  ok(strip.filter(r => r.isTarget).length === 1 && strip.every(r => !r.exactHit),
     "no match within TOL -> exactly one empty dashed requested-size marker");
  const marker = strip.find(r => r.isTarget);
  ok(marker.dia === 0.132,                          "the marker carries the requested size (0.1320″)");
  ok(marker.title === "requested size",             `marker hover says "requested size" (got "${marker.title}")`);

  // #30 via the gauge unit — the bit itself is the requested size
  const unit = card.querySelector(".calc-unit");
  typeInto(win, card.querySelector(".calc-val"), "#30");
  ok(unit.value === "gauge",                        "typing # switches the unit to gauge");
  ok(card.querySelector(".calc-val").value === "30","# is stripped from the field");
  card.querySelector(".calc-go").click();
  strip = parseStrip(card);
  ok(strip.some(r => r.exactHit && r.label === "#30" && r.dia === 0.1285),
     "gauge #30 wears the border at its own 0.1285″");
  ok(stripLabels(card).includes('1/8"'),            "#30's standard bracket includes 1/8\" below");

  // 3.2mm typed with unit — Enter runs it, m sets the unit menu
  const val = card.querySelector(".calc-val");
  typeInto(win, val, "3.2mm");
  ok(unit.value === "mm",                           "typing m switches the unit to mm");
  ok(val.value === "3.2",                           "letters are stripped from the field");
  pressEnter(win, val);
  ok(parseStrip(card).some(r => r.exactHit && r.label === "3.2 mm"), "Enter runs the calc; 3.2 mm wears the border");

  // 4.5mm regression: #16 (0.1770" = 4.4958 mm) borders at −0.1%; at 3 decimals the strip
  // must show 4.496 mm — visibly different from the request, matching its own ±%
  typeInto(win, val, "4.5mm");
  pressEnter(win, val);
  const g16 = parseStrip(card).find(r => r.label === "#16");
  ok(g16 && g16.exactHit && g16.rel === "−0.1%",    `#16 borders 4.5 mm at −0.1% (got ${g16 && g16.rel})`);
  const g16row = [...card.querySelectorAll(".cstrip .lab")].find(l => l.querySelector("b").textContent === "#16");
  ok(g16row && /4\.496 mm/.test(g16row.textContent),
     `#16's mm reads 4.496, not a misleading 4.50 (got "${g16row && g16row.textContent.trim()}")`);

  // shared sniffing: i means inches everywhere; % is stripped here without setting a unit
  typeInto(win, val, "5/16i");
  ok(unit.value === "in" && val.value === "5/16",   "typing i sets the calculator unit to inches");
  typeInto(win, val, "3%");
  ok(unit.value === "in" && val.value === "3",      "% is stripped in the calculator without changing the unit");

  // bad input → error line, not a crash
  typeInto(win, val, "");
  card.querySelector(".calc-go").click();
  ok(!!card.querySelector(".calc-out .err"),        "empty input shows the error message");
}

/* =========================================================================
 * Calculator: cards ([+] / [-] / labels / shared Closest menus)
 * =======================================================================*/
console.log("\n# calculator: cards");
{
  const { win, doc, errors } = newPage();
  ok(cards(doc).length === 1,                       "exactly one card on load");
  const first = cards(doc)[0];
  ok(!first.querySelector(".mini.del"),             "the first card has no [-] button");
  ok(!!first.querySelector(".calc-label"),          "cards have a label field");

  // [+] on the first card appends a second card right after it
  first.querySelector(".mini.add").click();
  ok(cards(doc).length === 2,                       "[+] adds a card");
  const second = cards(doc)[1];
  ok(second !== first && !!second.querySelector(".mini.del"), "the added card has a [-] button");
  ok(doc.activeElement === second.querySelector(".calc-val"), "the added card's size field gets focus");

  // [+] on the FIRST card again inserts between first and second
  first.querySelector(".mini.add").click();
  ok(cards(doc).length === 3 && cards(doc)[1] !== second && cards(doc)[2] === second,
     "[+] inserts the new card right after the clicked card, not at the end");
  const middle = cards(doc)[1];

  // label fields are free text, independent per card
  typeInto(win, first.querySelector(".calc-label"),  "shelf pins");
  typeInto(win, middle.querySelector(".calc-label"), "M4 tap");
  ok(first.querySelector(".calc-label").value === "shelf pins" &&
     middle.querySelector(".calc-label").value === "M4 tap" &&
     second.querySelector(".calc-label").value === "",
     "labels are per-card free text");

  // Closest menus re-run every live card
  runCard(win, first,  "1/8");
  runCard(win, middle, "1/4");
  ok(stripLabels(first).includes("3.2 mm") && stripLabels(middle).includes("6.5 mm"),
     "both cards computed with the full metric pool");
  setSelect(win, doc.getElementById("calcMetric"), "1");
  ok(stripLabels(first).includes("4 mm") && !stripLabels(first).includes("3.2 mm"),
     "Closest change re-ran card 1 (1/8\" now brackets to 3/4 mm)");
  ok(stripLabels(middle).includes("7 mm") && !stripLabels(middle).includes("6.5 mm"),
     "Closest change re-ran card 2 (1/4\" now brackets to 6/7 mm)");
  ok(second.querySelector(".cstrip") === null,      "a card with no input stays empty");

  // [-] removes exactly that card, and it stops being re-run
  middle.querySelector(".mini.del").click();
  ok(cards(doc).length === 2 && cards(doc)[0] === first && cards(doc)[1] === second,
     "[-] removes exactly the clicked card");
  setSelect(win, doc.getElementById("calcMetric"), "any");
  ok(stripLabels(first).includes("3.2 mm"),         "surviving cards still update after a delete");
  ok(errors.length === 0,                           `no script errors during card add/remove (${errors.map(e=>e.message)})`);
}

/* =========================================================================
 * Exact-match tolerance control (drives chart merging AND calculator borders)
 * =======================================================================*/
console.log("\n# tolerance control");
{
  const { win, doc, errors } = newPage();
  const card = cards(doc)[0];
  const tolVal  = doc.getElementById("tolVal");
  const tolUnit = doc.getElementById("tolUnit");
  ok(tolVal.value === "0.5" && tolUnit.value === "%", "tolerance defaults to 0.5%");

  // at 0.5%, #53 (0.0595") and 1.5 mm (0.05906", 0.75% apart) hold separate chart rows —
  // under the old absolute 0.001" they merged
  const rowOf = label => parseRows(doc).find(r => [r.gauge, r.std, r.metric].includes(label));
  ok(rowOf("#53") && rowOf("#53").metric === null,   "at 0.5%: #53's row has no metric partner");

  // widen to 1%: 3.2 mm (+0.8% off 1/8") now merges in the chart AND wears the border
  typeInto(win, tolVal, "1");
  ok(rowOf('1/8"') && rowOf('1/8"').metric === "3.2 mm", `at 1%: 1/8" and 3.2 mm share a chart row`);
  runCard(win, card, "1/8");
  ok(parseStrip(card).filter(r => r.exactHit).map(r => r.label).sort().join() === '1/8",3.2 mm',
     `at 1%: both 1/8" and 3.2 mm wear the border`);

  // absolute inches via the "i" suffix: 0.001i restores the old absolute-tolerance merges
  typeInto(win, tolVal, "0.001i");
  ok(tolUnit.value === "in" && tolVal.value === "0.001", "typing i sets the unit to inches and is stripped");
  ok(rowOf("#53") && rowOf("#53").metric === "1.5 mm",   `at 0.001": #53 and 1.5 mm merge again`);

  // % sets the percent unit; a cleared field keeps the last good tolerance
  typeInto(win, tolVal, "0.5%");
  ok(tolUnit.value === "%" && tolVal.value === "0.5",    "typing % sets the percent unit");
  typeInto(win, tolVal, "");
  ok(rowOf("#53") && rowOf("#53").metric === null,       "cleared field keeps the last good tolerance (0.5%)");
  ok(errors.length === 0, `no script errors while re-merging (${errors.map(e=>e.message)})`);
}

/* =========================================================================
 * Chart filter
 * =======================================================================*/
console.log("\n# chart filter");
{
  const { win, doc } = newPage();
  const filter = doc.getElementById("filter");
  const visible = () => [...doc.querySelectorAll("#rows tr")].filter(tr => tr.style.display !== "none").length;
  const total = visible();
  typeInto(win, filter, "#30");
  ok(visible() > 0 && visible() < total,            `filter narrows the chart (${visible()} of ${total})`);
  ok(new RegExp(`^${visible()} of ${total} rows$`).test(doc.getElementById("count").textContent),
     "row count reflects the filter");
  typeInto(win, filter, "");
  ok(visible() === total,                           "clearing the filter restores every row");
}

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
