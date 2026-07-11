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
 *      smallest -> largest, and an exact match collapses to a single "exact" line.
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
// strip rows -> {label, dia, rel, isTarget}; label is the bit ("1/8\"", "3 mm", "#30")
function parseStrip(card){
  return [...card.querySelectorAll(".cstrip .srow")].map(row => {
    const lab = row.querySelector(".lab");
    const m = lab.textContent.match(/(\d+\.\d{4})″/);
    const rel = lab.querySelector(".rel");
    return { isTarget: row.classList.contains("tline"),
             label: lab.querySelector("b").textContent,
             dia: m ? parseFloat(m[1]) : NaN,
             rel: rel ? rel.textContent : (/\bexact\b/.test(lab.textContent) ? "exact" : "") };
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
}

/* =========================================================================
 * Calculator: conversions
 * =======================================================================*/
console.log("\n# calculator: conversions");
{
  const { win, doc } = newPage();
  const card = cards(doc)[0];

  // 1/8" — exact standard match collapses to one line; gauge/metric bracket it
  runCard(win, card, "1/8");
  let strip = parseStrip(card);
  const target = strip.find(r => r.isTarget);
  ok(!!target && target.dia === 0.125,             `target line shows 0.1250″ (got ${target && target.dia})`);
  ok(/3\.18 mm/.test(card.textContent),            "target line shows the mm conversion (3.18 mm)");
  const dias = strip.map(r => r.dia);
  ok(dias.every((d,i) => !i || d >= dias[i-1] - 1e-9), "strip is sorted smallest→largest");
  const byLabel = Object.fromEntries(strip.filter(r => !r.isTarget).map(r => [r.label, r]));
  ok(byLabel['1/8"'] && byLabel['1/8"'].rel === "exact", `standard 1/8" is a single "exact" line`);
  ok(stripLabels(card).filter(l => l === '1/8"').length === 1, "exact match is NOT duplicated as ≤ and ≥");
  ok(byLabel["#31"] && byLabel["#30"],             "gauge brackets 1/8\" with #31 below and #30 above");
  ok(byLabel["3 mm"] && byLabel["3.2 mm"],         "metric brackets 1/8\" with 3 mm and 3.2 mm");
  ok(byLabel["3.2 mm"].rel === "+0.8%",            `3.2 mm is +0.8% (got ${byLabel["3.2 mm"] && byLabel["3.2 mm"].rel})`);

  // #30 via the gauge unit — target is the bit's own diameter
  const unit = card.querySelector(".calc-unit");
  typeInto(win, card.querySelector(".calc-val"), "#30");
  ok(unit.value === "gauge",                        "typing # switches the unit to gauge");
  ok(card.querySelector(".calc-val").value === "30","# is stripped from the field");
  card.querySelector(".calc-go").click();
  strip = parseStrip(card);
  ok(strip.find(r => r.isTarget).dia === 0.1285,    "gauge #30 → target 0.1285″");
  ok(stripLabels(card).includes('1/8"'),            "#30's standard bracket includes 1/8\" below");

  // 3.2mm typed with unit — Enter runs it, m sets the unit menu
  const val = card.querySelector(".calc-val");
  typeInto(win, val, "3.2mm");
  ok(unit.value === "mm",                           "typing m switches the unit to mm");
  ok(val.value === "3.2",                           "letters are stripped from the field");
  pressEnter(win, val);
  ok(parseStrip(card).some(r => r.label === "3.2 mm" && r.rel === "exact"), "Enter runs the calc; 3.2 mm is exact");

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
