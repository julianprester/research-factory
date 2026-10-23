# Analysis image (`ctc-analysis:1`)

The container that explanation analysis scripts run in. Workers do not call
`docker`; the `run_analysis` tool starts it through `analysis/run.ts`, with no
network, the run's exploration split mounted read-only at `/data`, and the node's
`workspace/scripts` (read) and `workspace/output` (write) mounted. Scripts run
from `/work/scripts`, and `CTC_OUT=/work/output`.

## Build

From the repository root:

```sh
docker build -t ctc-analysis:1 harness/analysis/
```

The base is `rocker/r-ver:4.5.1@sha256:03b0…2aa` (Ubuntu 24.04), pinned by tag
and digest. Its Rprofile pins the Posit Package Manager snapshot, so the R packages
are dated binaries and the build does not compile them. The Python packages are
pinned with `==` in `requirements.txt` and install into `/opt/venv`.

The image holds R: data.table, dplyr, stringr, ggplot2, arrow, lme4, igraph,
quanteda, topicmodels; and Python: pandas, numpy, scipy, statsmodels,
scikit-learn, networkx, gensim, matplotlib, pyarrow.

## The helpers

Both languages expose the same API and write the same files under `$CTC_OUT`.

| Call | Effect |
| --- | --- |
| `rec(key, value, note = "")` | Record a number for the next `save_numbers`. A key may be recorded once per section; the value must be finite. |
| `save_numbers(section)` | Write `numbers/<section>.csv` (`name,value,note`), then clear. Integers print bare; other numbers with 10 significant digits. |
| `reg(file, key)` | The value under `key` in `numbers/<file>.csv`. Stops unless exactly one row has that name. |
| `put_var(variable, value, source, rendered = None)` | Set a manuscript variable. `source` must be `output/numbers/<section>.csv#<key>`, and `rendered` defaults to the number as formatted above. |
| `write_variables()` | Write `assets/_variables.yml` (`name: "rendered"`) and `assets/variables_sources.csv`, then clear. |

Python: `import ctc` (`PYTHONPATH=/opt/ctc` is set in the image).
R: `source("/opt/ctc/ctc.R")`.

## Tests

`harness/test/analysis-lib.test.ts` runs the Python helper on the host's `python3`.
The R tests, and the matplotlib import check, run inside `ctc-analysis:1` with the
run flags (`--read-only --tmpfs /tmp --network none --user <uid>`). They are skipped,
with a reason, when that image is not built. One fixture is run through both
languages and must produce byte-identical files.
