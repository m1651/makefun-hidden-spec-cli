# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/m1651/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/m1651/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node-22-green.svg)](https://nodejs.org/)
[![Practice score](https://img.shields.io/badge/practice-1000%2F1000-brightgreen.svg)](https://github.com/m1651/makefun-hidden-spec-cli)

`mend` applies AI-written edits in four formats to a tree of text files,
atomically — every file changes or none does. It is the entry for the
[make.fun](https://make.fun/c/hidden-spec-cli-01-run-20261122) competition
**hidden-spec-cli-01-run-20261122** ("Build mend, one patch tool for every
AI edit format"), built to
[SPEC.md](https://make.fun/c/hidden-spec-cli-01-run-20261122/kit) (257 lines,
version 1).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` absent or `-` means stdin. `--format` is `auto` (the default),
`unified`, `search-replace`, `v4a` or `json`. `--check` reports what would
change without writing anything. `--strict` matches old lines exactly,
with no fuzzy tiers. Node 22, standard library alone.

## The four formats

- **Unified diff** — `diff --git` / `---` / `+++` sections with `@@` hunks.
  Wrong line numbers are tolerated: each hunk lands on the occurrence
  nearest its stated position, and empty old sides insert after the stated
  line. Creates, deletes and renames (`rename from`/`to`, or `---`/`+++`
  with different paths) are supported, including moves reported as
  `R old -> new`.
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks, with the path taken from the nearest non-blank, non-fence line
  above the block (or the previous block's path). An empty old side
  creates the file.
- **V4A patch** — `*** Begin Patch` / `*** Add File:` / `*** Delete File:` /
  `*** Update File:` with `@@` anchors, `*** Move to:` and
  `*** End of File` chunks applied in order with a moving cursor.
- **JSON** — one JSON array of edit objects, or JSON Lines: `create`,
  `str_replace` (exactly once, CRLF-aware) and `insert` (by line number).

## Matching and safety

Old lines match at the first of three tiers that has an occurrence — exact,
trailing whitespace ignored, then leading and trailing whitespace ignored —
and a tier-2 match re-indents the new lines to the file's own indentation.
Context lines are always written as the file's own matched lines, never the
patch's. Paths are rejected when unsafe (empty, absolute, backslashes, or
`.` / `..` segments). CRLF vs LF line breaks are preserved per file, as is
each file's final line break, except where the spec says otherwise for
unified hunks. Exit codes: `0` with one line per changed path and
`ok: N files`, `1` with one `error: <code> <path>` per failed edit and a
`failed: K of N edits` summary (nothing is written), `2` for usage,
no-patch, format and parse errors.

## Files

- `main.ts` — the whole CLI (hand-written in the building session).
- `runner.ts` — the kit's trial runner, kept as is; it hands a trial over
  when `MAKEFUN_ENV_URL` is set.
- `LICENSE` — MIT.

## Practice score

The kit's practice set (100 checks across unified, SEARCH/REPLACE, V4A,
JSON and CLI families) passes **100 of 100 — practice score 1000**, up from
the starter's 24 of 100 (score 240):

```sh
node check.ts <kit>/program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

The scored checks are drawn after the deadline from a sealed pool of 300
that includes kinds the practice set does not show, so the implementation
follows SPEC.md sentence by sentence rather than fitting the practice
cases.

## License

MIT — see [LICENSE](LICENSE).
