# The analysis image: the R and Python that an analysis script can use. run_analysis
# runs scripts in it with no network, the exploration split read-only and the node's
# output writable. Build it from the repository root:
#   docker build -t ctc-analysis:1 harness/analysis/
#
# The base is pinned by tag and digest. The tag fixes R, Ubuntu and rocker's Posit
# Package Manager snapshot date, so the R packages come from one dated snapshot as
# binaries (no compiling). The digest keeps that tag from ever resolving to another image.
FROM rocker/r-ver:4.5.1@sha256:03b023fbf7b1b24ac1bb8b2ac5fd7e15a767e67b40ff50c155e328110981c2aa

# Python 3.12 (Ubuntu 24.04's python3) in a venv, so pip works without PEP 668 trouble.
# libglpk40 and libgsl27 are the shared libraries the binary igraph and topicmodels need.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv libglpk40 libgsl27 \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt

RUN Rscript -e 'pkgs <- c("data.table", "dplyr", "stringr", "ggplot2", "arrow", "lme4", "igraph", "quanteda", "topicmodels"); \
  install.packages(pkgs, Ncpus = 4); \
  missing <- pkgs[!vapply(pkgs, requireNamespace, logical(1), quietly = TRUE)]; \
  if (length(missing) > 0) stop("not installed: ", paste(missing, collapse = ", "))'

# The shared helpers: `import ctc` in Python, source("/opt/ctc/ctc.R") in R.
COPY lib/ctc.py lib/ctc.R /opt/ctc/

# The container runs read-only with /tmp as tmpfs and as an arbitrary uid, so every
# cache and config path points into /tmp: matplotlib and friends stay quiet.
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/opt/ctc \
    PYTHONDONTWRITEBYTECODE=1 \
    MPLCONFIGDIR=/tmp/mpl \
    XDG_CACHE_HOME=/tmp/.cache \
    HOME=/tmp
WORKDIR /work
