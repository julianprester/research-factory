# Paper image (`ctc-paper:1`)

The container that a paper's Quarto render and a theory diagram's Graphviz run in. Workers do not call
`docker`: the `render_diagram` tool (and the check-paper render) start it through `paper/render.ts`, with no
network, read-only root, `/tmp` as tmpfs, and the host uid.

## Build

From the repository root:

```sh
docker build -t ctc-paper:1 harness/paper/
```

The base is `ghcr.io/quarto-dev/quarto`, pinned by digest (Ubuntu 22.04, Quarto 1.9.37, with its bundled
pandoc). Graphviz is installed with apt on top. `HOME=/tmp`, so Quarto's state goes to the tmpfs.

## Runs

| Run | Command | Writable mount |
| --- | --- | --- |
| Paper render | `quarto render paper.qmd --to html --to docx --output-dir checks/render` | the paper's `workspace/` at `/work` |
| Diagram | `dot -Tpng -o <name>.png <name>.dot` | the paper's `workspace/embeds/diagrams/` at `/work` |

Both run `--network none --read-only --tmpfs /tmp --user <uid>:<gid>`. The timeout (`paperTimeoutMs`) kills
the named container, not only the docker client.

## Tests

`harness/test/render.test.ts` and `harness/test/diagram.test.ts` run the real image when `ctc-paper:1` exists
and skip with the reason otherwise.
