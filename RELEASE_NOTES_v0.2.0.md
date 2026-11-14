# skill-diag v0.2.0

Local-first, deterministic diagnostics for AI coding agent skills. v0.2.0
keeps the v0.1.0 promise — nothing leaves the machine, every finding is
reproducible from the files on disk — and adds the two things users asked for
first: a way to fix the mechanical problems, and a way to hear a second
opinion on the semantic ones.

## What's new in v0.2.0

### `--fix` — mechanical repairs, printed as a diff

`skill-diag --fix` applies the unambiguous fixes and nothing else:

- a `name:` frontmatter field that disagrees with its folder is rewritten to
  the folder name. The folder is the identity the host keys on, and the
  check's own fix metadata has always pointed here; a one-line file edit is
  reviewable and reversible where a directory move is neither.
- a description that overruns the 1,536-character listing cap (or the
  1,024-character field limit) is trimmed to the largest length that
  satisfies both limits at once — but only when the description itself is
  the overrun. If `when_to_use` drives the overage, the file is left alone:
  shortening a description that fits is not a mechanical fix.

Everything else stays untouched. YAML errors, missing fields, collisions and
routing are reported, never auto-fixed — a fix that would have to invent
content is not a fix. Plugin-owned files are never rewritten; they belong to
the plugin checkout. The rewrite is byte-preserving outside the one line it
changes (CRLF endings and trailing newlines survive), and the diff of every
change prints to the terminal. Files are written to disk for your review;
skill-diag never commits.

### `--llm` — optional semantic grading through your own CLI

`skill-diag --llm` asks a local CLI — `claude -p`, falling back to
`codex exec`, overridable with `SKILL_DIAG_LLM_BIN` — one question per
description: is this a trigger clause a router can match against, or a
step-by-step summary? Verdicts land as `info`-severity findings
(`llm-description`), so they inform but never move the exit code. No CLI on
the machine? A warning, not an error. There is no SDK and no network code in
skill-diag itself: the spawned process is the user's own agent, and the flag
is opt-in.

### OTEL runtime join (Phase 4a)

`runtime ingest` reads OTEL JSONL activation logs into a local store;
`runtime report` joins the static corpus with what actually fired —
zero-activation skills, theft suspects, top firing. `--why` and the MCP tool
attach the same evidence when the store has observed sessions. The report
never gates: it is evidence, not a check.

### MCP server (Phase 4b)

`skill-diag mcp` runs a stdio MCP server exposing one tool,
`diagnose_skills`, so the agent can ask "why isn't my skill firing?"
mid-run and get the same structured answer `skill-diag --json` would give —
same pipeline, same findings, no drift between the two surfaces.

### Multi-host support (Phase 4c)

`--host cursor`, `--host codex` and `--host gemini-cli` validate Cursor
`.mdc` rules, Codex `SKILL.md` skills and Gemini CLI `GEMINI.md` context
files against their own contracts — required fields, allowed fields,
discovery roots — with the same finding taxonomy as the Claude Code host.

## What it does

skill-diag reads the skills a host would load, checks them against the
host's contract (frontmatter shape, naming, description length, listing
budget, routing health), and reports what it finds — in the terminal, as
JSON, or as SARIF for GitHub Code Scanning. `--why` explains one skill's
findings; `budget` shows who eats the listing budget. Every run is local and
deterministic: same files in, same findings out.

## What's not in v0.2.0

- No dependency graph between skills (a later phase).
- No network calls from skill-diag itself. `--llm` spawns a CLI you already
  have; whatever that process sends travels under your credentials, not
  ours, and only when you pass the flag.
- No auto-committing. `--fix` writes files for your review; git stays yours.
- No rewriting of semantic issues. Descriptions are never invented — only
  trimmed when a deterministic limit is provably exceeded.

## Install

```
npm install -g skill-diag
# or run it without installing:
npx skill-diag
```

## CI usage

```
skill-diag --json --strict
skill-diag --sarif results.sarif
skill-diag --fix --json        # mechanical fixes applied; diff on stderr
```

The exit code still gates on deterministic findings only: `--llm` verdicts
are advisory and never fail a build.

## Known limitations

- `--llm` probes `claude` and `codex` as plain executables. On Windows, CLIs
  installed as `.cmd` shims are not spawnable without a shell; set
  `SKILL_DIAG_LLM_BIN` to a full path if the probe comes up empty.
- `--llm` spawns one process per description. Large corpora grade slowly;
  the flag is opt-in for that reason.
- The listing budget stays an estimate where the host has not published
  exact numbers (unchanged from v0.1.0).
