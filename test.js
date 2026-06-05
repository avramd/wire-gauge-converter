/* Tests for wire-gauge-drill-chart.html
 *
 * Run:  node test.js
 *
 * These guard the invariants we keep getting wrong:
 *   1. SORT ORDER — within every chart row, the list of drill-bit options (the bars,
 *      including the underlined current-row baseline) must read smallest -> largest,
 *      the same direction the chart itself is sorted. A human picking "smaller" or
 *      "larger" must never have to re-sort the options by eye.
 *   2. METRIC CONSISTENCY — every metric size offered as an equivalence/bracket must be
 *      a real first-class metric row in the chart (no phantom sizes you can't look up).
 *   3. The baseline is the current row, underlined (not italic), and sits in its
 *      natural sorted position (smaller options above it, larger below).
 */
const fs = require("fs");

const html = fs.readFileSync(__dirname + "/wire-gauge-drill-chart.html", "utf8");
const js   = html.split("<script>")[1].split("</script>")[0];

// Render the chart headlessly with a given Closest-menu state, return tbody HTML.
function render(frac = "any", metric = "any"){
  const els = {};
  const mk = id => ({
    id, value: ({calcFrac:frac, calcMetric:metric, calcUnit:"in"}[id]) || "",
    innerHTML:"", textContent:"", dataset:{}, style:{}, addEventListener(){},
    querySelectorAll(){ return [...this.innerHTML.matchAll(/data-s="([^"]*)"/g)].map(m => ({dataset:{s:m[1]}, style:{}})); },
  });
  global.document = { getElementById: id => els[id] || (els[id] = mk(id)) };
  eval(js);
  return els.rows.innerHTML;
}

// Parse a tbody into rows: each row has its bars (dia, label, isBase) and its column cells.
function parseRows(tbodyHtml){
  return tbodyHtml.split("<tr ").slice(1).map(tr => {
    const cellVal = sys => {
      const m = tr.match(new RegExp(`<td class="${sys} num"><span class="(val|gap)">([^<]*)</span>`));
      return (m && m[1] === "val") ? m[2] : null;
    };
    const barsCell = (tr.split('<td><div class="bars"')[1] || "").split("</td>")[0];
    const bars = barsCell.split('<div class="row">').slice(1).map(seg => {
      const inch = seg.match(/(\d\.\d{4})&Prime;/);
      const label = seg.match(/<b>([^<]+)<\/b>/);
      return { dia: inch ? parseFloat(inch[1]) : NaN, label: label ? label[1] : "", isBase: /class="lab base"/.test(seg) };
    });
    const allLabels = [...barsCell.matchAll(/<b>([^<]+)<\/b>/g)].map(m => m[1]); // includes folded equivalencies
    return { gauge: cellVal("gauge"), std: cellVal("std"), metric: cellVal("metric"), bars, allLabels };
  });
}

let failures = 0, checks = 0;
function ok(cond, msg){ checks++; if(!cond){ failures++; console.error("  ✗ " + msg); } }

function run(label, frac, metric){
  console.log(`\n# ${label}  (closest = ${frac} / ${metric})`);
  const rows = parseRows(render(frac, metric));
  ok(rows.length > 120, `rendered a full chart (${rows.length} rows)`);

  // metric sizes that are real chart rows
  const metricRowSet = new Set(rows.map(r => r.metric).filter(Boolean));

  let badSort = 0, badBaselinePos = 0, multiBase = 0, phantomMetric = 0, fracOnlyChecked = 0;
  for(const r of rows){
    const dias = r.bars.map(b => b.dia);

    // (1) non-decreasing top -> bottom
    for(let i=1;i<dias.length;i++) if(dias[i] < dias[i-1] - 1e-9) badSort++;

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

// static (CSS/markup) guards
console.log("# static markup");
ok(/\.bars \.lab\.base\{text-decoration:underline\}/.test(html), "baseline is underlined");
ok(!/\.bars \.lab\.base\{font-style:italic\}/.test(html),       "baseline is NOT italic");
ok(/const REF_PX = 30\b/.test(js),                              "reference marker width is 30px");
ok(/--ref:30px/.test(render()),                                 "rendered rows use --ref:30px");

run("default",        "any", "any");
run("coarse imperial","16",  "any");
run("whole-mm metric","any", "1");

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
