# Wire Gauge / Metric / Standard Drill Bit Conversion Chart

A single, self-contained static HTML page for converting between drill-bit sizing
systems — number/letter **wire gauge**, **fractional-inch** (standard), and
**metric** — and for finding the nearest *available* bit when there's no exact match.

**Live:** https://avramd.github.io/wire-gauge-converter/

## Features

- A merged, sorted chart of all three systems, with gaps where a system has no
  equivalent size within tolerance.
- Per-row **relative-size bars**: the nearest smaller and larger bit in each system,
  sorted smallest→largest, scaled against the row's diameter, with the row's own
  size shown as an underlined baseline (and any cross-system equivalents folded in).
- A **"Nearest equivalent" calculator** — enter a size as `#` (AWG), inch, or mm.
- Page-wide **"Closest" menus** (imperial denomination + metric step) that filter
  both the chart and the calculator down to the bit sizes you actually own.
- Metric sizes are a curated list of real, commonly-sold drills, so every
  equivalence offered is also a first-class row you can look up.

No build step, no dependencies, no network calls — just one HTML file.

## Files

| File | Purpose |
|------|---------|
| `wire-gauge-drill-chart.html` | The entire app. |
| `index.html` | Redirects to the chart (entry point for the Pages root URL). |
| `test.js` | Invariant tests (sort order, metric consistency). |
| `deploy.sh` | Optional `scp` deploy driven by a local `.env`. |

## Tests

```sh
node test.js
```

Renders the chart headlessly and asserts that every row's options read
smallest→largest, the baseline sits in its sorted position, and no metric size is
offered that isn't a real chart row.

## Deploy (optional)

`deploy.sh` copies the page to a static host via `scp`. Configure it with a local
`.env` (gitignored):

```sh
HOSTNAME=example.org        # required — ssh host
SITE_DIR=example.org        # required — site root on the host
DEST_DIR=wire-gauge         # optional — subdirectory (omitted from the path if empty)
FILE_NAME=index.html        # optional — remote filename (default: index.html)
```

Then:

```sh
./deploy.sh
```
