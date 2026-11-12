# `skill-diag` — Implementation Plan (canonical)

This is the single canonical plan for the project. The specification lives at
[`docs/spec.md`](spec.md). Where this plan and the spec disagree, the spec wins on
behaviour and this plan wins on sequencing.

## v0.1 — ship target

v0.1 is **static linter + routing survival model**, and ships **Phases 0–4 plus
Phase 5a**.

- **Static linter — parity.** Phases 1–3 rebuild the mechanical layer
  `claude-skills-doctor` v0.7.0 already ships: frontmatter / name / description
  validity, the 1,536-char per-entry cap, the listing budget against 1% of
  context, `duplicate-name`, `description-collision`, the `budget` and
  `collisions` commands, and `--json` / `--strict` / `--fix`. This is **parity,
  not a differentiator** — a replacement for an incumbent, not an invention. It
  earns the right to be installed; it does not win the argument. Phase 4 (SARIF
  + GitHub Action) is the distribution multiplier: without it the tool is a
  `curl` with no marketplace.
- **Routing survival model — differentiator.** Phase 5a ships `P̂_top-1(N)`, the
  break point `N*(p)`, and `routing-health-at-risk` — the analysis no incumbent
  has, in any form. It is static and offline, so it does not have to wait for
  runtime evidence and it belongs in v0.1 rather than behind the OTEL work.

## v0.2 — differentiator (runtime + reach)

Phases 5b–7 are **not** "expansion work" bolted onto v0.1. They carry the
evidence the static model can only predict: the OTEL runtime join, the MCP
surface, and multi-host contracts. Scoped as **v0.2**, a separate release with
its own acceptance criteria. Do not let v0.1 scope absorb them, and do not
describe them as optional polish.

## Roadmap

| Phase | Release | Name | Contents |
|---|---|---|---|
| 0 | v0.1 | Foundation | Repo, toolchain, contracts skeleton, dependency install |
| 0.5 | v0.1 | Corpus preparation | Deduplicate the skill corpus; establish the real `N` |
| 1 | v0.1 | The wedge | Discovery + strict parser + Claude Code contract + Tier 1 checks + human/JSON output + `--why <skill>` |
| 2 | v0.1 | Budget + drop simulation | Effective-char budget, overhead, per-entry cap, `budget`/`collisions` commands |
| 3 | v0.1 | Tier 2 | Heuristic warnings incl. `description-collision`, `zero-activation` |
| 4 | v0.1 | Distribution | SARIF output + GitHub Action |
| 5a | **v0.1** | Routing survival model | `P̂_top-1(N)`, break-point `N*(p)`, `routing-health-at-risk`; static only, no runtime evidence |
| 5b | **v0.2** | Runtime join | `runtime ingest --otel`, `runtime report`, static-to-runtime join |
| 6 | **v0.2** | MCP surface | `mcp` server exposing the capability model to coding agents |
| 7 | **v0.2** | Cross-host + `--fix` | Codex/Cursor/Gemini/OpenClaw contracts, `--fix`, `--llm`, `graph` |

## Phase 0 — Foundation (in progress)

- [x] `git init -b main`
- [x] Spec moved to `docs/spec.md`
- [x] Conversion damage repaired (see "Spec repair" below)
- [x] `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`
- [x] Dependencies installed from spec §20
- [x] `tsc --noEmit` clean
- [x] `claude-skills-doctor` baseline — run via `uvx` against the deduplicated
      1,115 corpus. Artifact: `test/baselines/claude-skills-doctor-1115.json`.
      Exit 1 (errors present); 18.3 s median of three byte-identical runs;
      259 errors / 21 warnings / 0 info; `budget-exceeded` (220,423 chars vs an
      8,000-char limit); 0 `description-collision`. Detail below.

### Phase 0 findings — `claude-skills-doctor`

The earlier "does not exist" finding was wrong: it came from searching **npm
only**. The package is a **Python** package on **PyPI**.

Verified from `https://pypi.org/pypi/claude-skills-doctor/json` (HTTP 200):

| Field | Value |
|---|---|
| Name | `claude-skills-doctor` |
| Latest version | `0.7.0` |
| Releases | 8 — `0.1.0` … `0.7.0`, uploaded 2026-07-23 → 2026-07-31 |
| Author | Mehmet Eren Gülmez |
| License | MIT |
| Requires-Python | `>=3.10` |
| Dependencies | `pyyaml>=6.0`, `rich>=13.0`, `typer>=0.12` |
| Repo | `github.com/gulmezeren2-byte/claude-skills-doctor` |
| Entry points | `skilldoctor`, `claude-skills-doctor` |

**Check coverage — 28 finding ids**, read from `src/skilldoctor/{checks,security,budget}.py`:

| Severity | Ids |
|---|---|
| ERROR | `frontmatter-invalid`, `missing-name`, `empty-name`, `missing-description`, `empty-description`, `name-format`, `name-folder-mismatch`, `description-angle-brackets`, `description-too-long`, `duplicate-name`, `budget-exceeded` |
| WARNING | `description-vague`, `description-is-workflow`, `description-capped`, `description-collision`, `budget-near`, `compatibility-too-long`, `body-empty`, `body-too-large`, `absolute-path`, `human-docs`, `allowed-tools-body`, `reference-chain`, `hidden-instruction`, `script-network-call`, `internal-error`, `yaml-truthy-key` |
| INFO | `unexpected-frontmatter-key` |

Constants it encodes (same as the spec): `PER_ENTRY_CAP = 1536`,
`DEFAULT_BUDGET_FRACTION = 0.01`, `DEFAULT_CONTEXT_TOKENS = 200_000`,
`WARN_RATIO = 0.8`, `NAME_MAX = 64`, `DESCRIPTION_MAX = 1024`,
`COLLISION_THRESHOLD = 0.6`, `BODY_LARGE_CHARS = 20_000`.

**Overlap with `skill-diag` is substantial and must be resolved before Phase 2.**
It already ships: listing budget against 1% of context window, the 1,536-char
per-entry cap, `description-collision`, `duplicate-name`, `name-folder-mismatch`,
`description-capped`, plus a `budget` subcommand, `--json`, `--strict`, `--fix`,
and a GitHub Action. It reads real settings (`skillListingBudgetFraction`,
`skillListingMaxDescChars`, `skillOverrides`).

Where it does **not** reach, and where `skill-diag` still has a reason to exist:

- No routing-survival model. It reports the budget as a bar, not `P̂_top-1(N)`,
  and has no break-point analysis. This is `skill-diag` Phase 5a's core — the
  routing survival model — and it is not present in any form.
- No runtime join. No OTEL ingest, no `runtime report`, no static-to-runtime
  reconciliation. Phase 5b.
- No MCP surface. Phase 6.
- Single host. Claude Code only — no Codex/Cursor/Gemini/OpenClaw contracts and
  no contracts-as-data. Phase 7.
- Security scanning is a hygiene warning (`hidden-instruction`,
  `script-network-call`), explicitly not an audit. `skill-diag` deliberately
  does not compete here.

Consequence: **Phase 1 acceptance stays deferred** until its report output is
diffed against `skill-diag`'s Tier 1 set. No spec-derived fixture set is
substituted for the baseline. Substitution happens only on explicit approval
after the failure is seen.

The tool is Python, so it does not enter `skill-diag`'s npm dependency graph and
does not consume the ≤6 runtime-dependency budget. It is run with
`uvx claude-skills-doctor` — ephemeral, no permanent install, no Python
environment mutated.

### Phase 0 baseline — `claude-skills-doctor` v0.7.0 on 1,115 live skills

The tool's own discovery walks `~/.claude/plugins/**/skills/*/SKILL.md` with no
version dedupe and no enabled-plugin filter, so run against the real home it
scans 2,290 skills (every cached version) and counts 905 slash-commands. To
measure the corpus the plan actually uses, the 1,115 live skills were materialised
as hardlinks into a synthetic home preserving source kind (1,102 plugin, 13 user)
and linted with `--home`. Its discovery then reports exactly 1,115 skills.

| Measure | Value |
|---|---|
| Exit code | `1` (errors present; `ok: false`) |
| Runtime | 13.4 / 18.3 / 20.7 s, three byte-identical runs (median 18.3 s) |
| Skills / commands scanned | 1,115 / 0 |
| Errors / warnings / info | 259 / 21 / 0 (280 findings) |
| `budget-exceeded` | yes — 220,423 chars against 8,000 (2755%) |
| `description-collision` | 0 |
| `budget` subcommand | 220,423 / 8,000 chars (2755%), 1,115 contributors |

Check ids actually emitted: `duplicate-name` 257, `script-network-call` 14,
`reference-chain` 5, `body-too-large` 2, `frontmatter-invalid` 1,
`budget-exceeded` 1. All 28 ids enumerated from source were reproduced by AST
extraction — no drift. Reproduce with the `--home` corpus described above.

### Competitive findings — where `claude-skills-doctor` stops

Measured, not assumed. Each item is checkable against the committed baseline and
the package source.

**1. The full check set is withheld from plugin skills.** `check_all` sets
`full = s.source != SOURCE_PLUGIN`; plugin skills get `check_skill(full=False)`
(load-breakers only), `scan_security` and `check_description_cap`, and skip
`check_reference_chain`. On the 1,115 corpus that silences **22 of the 28 ids** —
only 6 fired. `check_collisions` is called with
`[s for s in skills if s.source != SOURCE_PLUGIN]`, so **`description-collision`
structurally cannot fire on plugin skills** (0 reported against 1,102 of them),
and `name-folder-mismatch` is unreachable for them because the function returns
before that check. Plugin skills are the overwhelming majority of a real install:
1,102 of 1,115 here (2,275 of 2,290 on the raw home scan). This is the blind spot
v0.1 covers.

**2. The budget limit itself is ambiguous.** Their tool derives **8,000 chars**
(1% of a 200,000-token window at 4 chars/token, `exact: false`). Spec §2.1 states
the Claude Code default is **15,000 chars (~4,000 tokens)**, controlled by
`SLASH_COMMAND_TOOL_CHAR_BUDGET`. Both numbers are defensible under different
model and setting assumptions, which is exactly why neither should be hard-coded
silently. **Phase 2 calibration resolves this** — report the limit with its
provenance and prefer the measured path.

**3. Commands share the discovery budget.** On the real machine, 905
slash-commands contribute **75,073 chars** against 466,070 for skills — 541,143
total. Our 1,115-skill baseline counts skills only (`commands: 0`), so its
**220,423 chars is a lower bound** on what this machine actually lists.

**4. Runtime.** 18.3 s median warm on 1,115 skills. The spec's target is under
200 ms warm, stated for a 100-skill directory — so this is directional rather
than a like-for-like comparison, but the gap is large enough that warm-run cost
stays a design constraint, not a detail.

**5. Phase 1 acceptance, restated.** **Parity on the 13 user skills** (the set
their tool checks fully, where matching them is the bar) **plus coverage on the
1,102 plugin skills** (the set their tool reduces checks for, which is where
`skill-diag` must be strictly better rather than equal). Parity alone is not
acceptance; it is the floor.

### Phase 0.5 — Corpus deduplication

Measured on `~/.claude/plugins` and `~/.claude/skills`:

| Measure | Count |
|---|---|
| Raw `SKILL.md` files under `~/.claude/plugins` | 2,313 |
| Distinct content (SHA-1 of file bytes) | 1,212 |
| Distinct `(marketplace, plugin, version)` | 409 |
| Distinct `(plugin, skill)` ignoring version | 1,333 |
| **Live skills: enabled plugins, latest version each** | **1,102** |
| Live skills in `~/.claude/skills` | 13 |
| **Live total the router actually sees** | **1,115** |

The 2,313 figure is inflated by (a) multiple cached versions of the same plugin
and (b) two directory layouts (`cache/` and `marketplaces/`) carrying the same
content. 1,039 content groups are duplicated; 2,140 files sit inside those
groups.

**Consequence for the headline claim.** The routing-survival model puts the
top-1 break point at `N*(0.50) ≈ 1,950`. The live corpus is **1,115** — about
57% of the way there, roughly 835 skills of headroom. The "surprise finding"
that this machine is past the break point is **an artifact of the raw 2,313
count**. It is not currently true.

Do not write `2,313` into any acceptance criterion, README, or marketing
surface. The defensible number is **1,115 live**, stated with its derivation.

**1,115 is a valid test case, not a headline.** It is the correct `N` to feed
the budget, collision and routing phases, and it is large enough to make every
one of those phases exercise real scale on real data rather than on fixtures.
State it as *the corpus this benchmark runs against* and always with its
derivation (live skills = enabled plugins at latest version + `~/.claude/skills`),
never as a claim about Claude Code at large.

**At N = 1,115 the model already predicts degradation.** With the spec defaults
`r = 0.867`, `p = 2.83 × 10⁻⁴`:

```
P̂_top-1(1115) = 0.867 · e^(−2.83e−4 · 1114) ≈ 0.63
```

So top-1 routing accuracy is predicted at **≈ 0.63** on this machine — roughly
one request in three reaching the wrong skill — against the `r = 0.867`
single-skill baseline. `N*(0.50) ≈ 1,950` is the point where it crosses even
odds; the machine is not there yet, but it is already measurably below the
baseline. That makes Phase 5's routing phase testable end-to-end on the user's
own machine with no synthetic corpus: there is a live, non-degenerate prediction
to confirm or falsify against ingested `claude_code.skill_activated` events.

### Phase 0 substitutions and omissions

| Item | Status |
|---|---|
| `better-sqlite3` | Deliberately omitted. Native build on Windows; spec permits the JSONL fallback. |
| `bun build --compile` single-file binary | Not attempted in Phase 0. |
| Runtime dependencies | 4 (`ajv`, `commander`, `picocolors`, `yaml`) against a budget of ≤6. |

### Spec repair

The source markdown was a rich-text conversion that lost all indentation,
inserted one blank line after every content line, and backslash-escaped markdown
metacharacters. Repairs applied:

- Unescaped `` \` `` `\*` `\_` `\#` `\[` `\]` `\-` `\.` `\>` `\|` while leaving
  LaTeX (`\times`, `\hat`, `\(`, `\[`) intact.
- Removed the injected blank lines, including the 98 that had split table rows —
  this was the real cause of the apparent "missing row" in §7.1. All 11 Tier 1
  rows were present; none was lost.
- Re-indented the three flattened YAML blocks: `action.yml` (§15),
  `.pre-commit-config.yaml` (§18.5), GitLab CI (§18.6). §18.5 was not on the
  original list but had the same defect.
- Re-padded the architecture diagram box art and the §20 file tree.
- §23 line 923: an inline code span was **empty in the source** — the content is
  genuinely lost and unrecoverable. It is marked in place as
  `⟨inline-code content lost in conversion⟩` and needs the author to supply the
  original term.

The pre-repair copy is preserved at `docs/spec.original-damaged.md`. Repair
script: `~/.claude/spec-repair/repair.mjs` (kept outside the repo; takes
input/output paths as arguments).

## Phase 1 — The wedge (v0.1)

Per Override 4, `--why <skill>` ships in Phase 1. It is the primary
individual-developer workflow (spec §18.1) and the tool's own headline question:
*why isn't my skill firing?* A v0.1 without it does not answer its own pitch.

Acceptance for Phase 1 is **deferred** until the `claude-skills-doctor` baseline
question is resolved.

## Non-goals

Per spec §23 — no description grading by default, no security scanning, no
auto-rewrite, no cloud dependency, no claim that routing health is a
measurement.
