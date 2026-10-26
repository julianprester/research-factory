# The paper image (`ctc-paper:1`): Quarto, to render a paper to HTML and Word, and Graphviz (`dot`), to draw a
# theory diagram. The render_diagram and check-paper render run it with no network, the paper's workspace (or
# its diagrams folder) the only writable mount, and the host uid. Build it from the repository root:
#   docker build -t ctc-paper:1 harness/paper/
#
# The base is pinned by digest, so the tag `latest` can never resolve to another Quarto under the same name.
FROM ghcr.io/quarto-dev/quarto@sha256:966609c3b165de4a3f259527549c6f750cbe5298a1d35aac39313a37954578ff

# Graphviz is the only addition. The package lists are removed so the layer stays small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends graphviz \
 && rm -rf /var/lib/apt/lists/*

# The container runs read-only with /tmp as tmpfs and as an arbitrary uid, so every cache and home path
# points into /tmp (Quarto and pandoc write their state under $HOME).
ENV HOME=/tmp
WORKDIR /work
