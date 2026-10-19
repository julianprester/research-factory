---
name: deepis
description: "Use when searching the literature with deepis — bounded search, progressive disclosure, websearch syntax and the cite-only-what-you-read rule."
---

# deepis

`deepis` is the literature database: academic papers split into chunks with
numeric ids. Every literature claim needs a chunk id, and you may only cite a
chunk you actually read.

## Boundedness first

An earlier run's 20 parallel unbounded searchers reached 257k tokens. Every
command below is capped, timed out and compacted.

- `timeout 60` on every call. If a call hangs or crashes, do not raise the
  timeout or widen the query: retry the same query with `--no-rerank`, and if
  that fails too, record the dead end in `rounds.md`.
- `-n` at most 15. You want the two or three passages that state a prediction,
  not a reading list.
- `-f json`, piped through `jq`, content truncated. A result's `content` is a
  whole chunk; printing it unread is how the tokens go.
- Reranking is on by default and is the step that crashes or times out on long
  chunks. On failure rerun the same query with `--no-rerank` and say so in
  `rounds.md`; never report a search as empty if only the reranker failed.

## Progressive disclosure: search → context → metadata

1. **Search** for candidates (hybrid is the default and paper-level: one best
   chunk per paper):

   ```bash
   timeout 60 deepis search "algorithmic governance of documentation" -n 10 -f json \
     | jq -r '.results[] | "\(.chunk_id): \(.content[0:200])"'
   ```

   Shape: `{"mode", "reranked", "results": [{"chunk_id", "score", "content"}]}`.

2. **Read around** the picked chunk; `target` marks what you searched:

   ```bash
   timeout 60 deepis context <chunk_id> -f json \
     | jq -r '.chunks[] | "\(.chunk_index): \(.content[0:300])"'
   ```

   Shape: `{"chunk_id", "paper_id", "before", "after", "chunks":
   [{"chunk_id", "chunk_index", "content", "target"}]}`. This, not the search
   snippet, is what you are allowed to cite.

3. **Confirm the paper.** Batch ids (comma-separated, up to 50); unknown ids
   are simply absent and deepis still exits 0:

   ```bash
   timeout 60 deepis metadata <id1,id2,id3> -f json \
     | jq -c '.papers[] | {paper_id, title, year, journal, chunk_ids}'
   ```

   Shape: `{"papers": [{"paper_id", "title", "year", "journal", "chunk_ids",
   ...}]}`, where `chunk_ids` holds only the ids that exist — so a citation
   whose id never appears is broken.

## Query syntax (`--fts`)

`--fts` takes PostgreSQL web-search syntax; the positional query is hybrid.

```bash
timeout 60 deepis search --fts '"algorithmic control" OR "algorithmic management" -platform' \
  -n 10 -f json --no-rerank | jq -r '.results[] | "\(.chunk_id): \(.content[0:200])"'
```

- `"..."` quotes a phrase. Quote a hyphenated term you mean literally
  (`'"socio-technical"'`) so the hyphen is not misread.
- `OR` (upper case) widens; a space between terms narrows (they are ANDed).
- `-term` excludes, and only as a separate word. A hyphen inside a word is not
  an exclusion.
- Not supported: proximity operators (`term/k term`) return nothing, silently,
  and wildcard prefixes ignore the star. Use a quoted phrase instead.
- `--vector "..."` is the semantic leg; combine both flags to word the legs
  differently, and add `--chunk-level` for several chunks of one paper.

## Rules

- **Cite only what you read.** A citation is a chunk you read with
  `deepis context`; a search snippet alone is not enough, because it may be
  truncated mid-claim. One line per result in your notes: `chunk_id — what it
  says in one clause`.
- At least 6 distinct searches before you commit to an entry, spread over the
  area's theories rather than rewordings of one query. If two searches return
  the same chunks, the query is not new.
- Run `node
  ./harness/tools/check-citations.ts` on
  your file before you finish: exit 0 means every `[@id]` resolves, exit 1
  names the ids that do not, exit 2 means deepis itself is unreachable (retry,
  then BLOCKED).
