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

**5. Command cost is understated by the `plugin:` namespace.** They cost each
command by its bare stem: 905 commands, **75,073 chars**. The host lists plugin
commands namespaced (`plugin:command`), so the same 905 commands cost
**83,768 chars**. **Delta 8,713 chars (11.6%)** — their budget total for this
machine (541,143) is a lower bound on the real listing. Our stem-based figure
(75,055) agrees with theirs to within 18 chars, which is what makes the delta
attributable to namespacing rather than to parsing.

**6. Routing health has no incumbent equivalent.** As of 2b, `skill-diag`
produces a scale-aware routing health estimate no incumbent produces. The
estimate uses published parameters from the Curse of Skills study; it does not
require the host or OTEL data; it works entirely from static description
similarity and skill count. Nobody else reports what the 1,000th skill does to
top-1, or how many skills of headroom remain before routing degrades.

**7. Phase 1 acceptance, restated.** **Parity on the 13 user skills** (the set
their tool checks fully, where matching them is the bar) **plus coverage on the
1,102 plugin skills** (the set their tool reduces checks for, which is where
`skill-diag` must be strictly better rather than equal). Parity alone is not
acceptance; it is the floor.

#### Classification of the 22 silent finding ids

The baseline run left 22 of their 28 ids silent. Silent is not the same as
withheld: only six per-skill checks run for plugin-source skills before
`check_all` returns (`frontmatter-invalid`, `missing-name`, `empty-name`,
`missing-description`, `empty-description`, `yaml-truthy-key`), plus the
corpus-level `duplicate-name`/`budget-exceeded`, `scan_security` and
`check_description_cap`. The rest are structurally unreachable for the 1,102
plugin skills.

| Bucket | Count | Ids |
|---|---|---|
| **(a)** Semantically valid on plugin skills | **18** | `missing-name`, `empty-name`, `missing-description`, `empty-description`, `name-format`, `name-folder-mismatch`, `description-angle-brackets`, `description-too-long`, `description-capped`, `budget-near`, `compatibility-too-long`, `body-empty`, `absolute-path`, `human-docs`, `allowed-tools-body`, `yaml-truthy-key`, `unexpected-frontmatter-key`, `description-collision` |
| **(b)** Needs plugin-specific context | **1** | `internal-error` — a tool-internal crash sentinel, not a property of a skill |
| **(c)** Out of scope | **3** | `hidden-instruction` (security), `description-vague`, `description-is-workflow` (Tier 3 semantic — `skill-issue`'s job per §23) |

**The coverage gap is 11 of the 18.** Those are the bucket-(a) ids the incumbent
withholds from plugin skills: `name-format`, `name-folder-mismatch`,
`description-angle-brackets`, `description-too-long`, `description-collision`,
`compatibility-too-long`, `body-empty`, `absolute-path`, `human-docs`,
`allowed-tools-body`, `unexpected-frontmatter-key`. The other seven in (a) it
already runs on plugins, so matching them is parity, not coverage.

| Split of the 11 | Count | Where |
|---|---|---|
| Tier 1 — shipped in Phase 1 (`name-format`→`name-invalid`, `name-folder-mismatch`, `description-too-long`, `unexpected-frontmatter-key`→`unknown-field`) | 4 | Phase 1 |
| Tier 2 or outside §7.1 (`description-collision`, `description-angle-brackets`, `compatibility-too-long`, `body-empty`, `absolute-path`, `human-docs`, `allowed-tools-body`) | 7 | Phase 3 |

Measured on the 1,115 corpus: the four shipped checks produce **544 findings on
plugin skills** the incumbent cannot produce — `unknown-field` 532,
`name-folder-mismatch` 11, `name-invalid` 1. That 544 is the coverage number; the
remaining 256 plugin findings (`exact-name-collision` 255, `yaml-invalid` 1) are
checks the incumbent also reaches, and `yaml-invalid` matches it on the same
skill (`mem-search`) for parity.

One deliberate divergence, not a defect: collisions are grouped by resolved
command name, and plugin skills are namespaced `plugin:skill` (§4.2). Global
grouping yields 257 groups; namespaced yields 255. The two extra are names that
only repeat across different plugins (`design-system`, `handoff`, `tdd`, `teach`),
which do not shadow each other in the host.

#### Phase 1 headline disclosure

- **544 incumbent-blind findings on the 1,102 plugin skills.**
- Of those: **499 are a single `origin` provenance key** that the `ecc` bundler
  injects (values like `ECC`, `community`, `ECC direct-port adaptation`) — not
  user-actionable; exclusion leaves **45 actionable findings**.
- 11 `name-folder-mismatch` findings collapse to **6 distinct skill defects**
  (`ecc` ships each in two layouts: `skills/` and `docs/ja-JP/skills/`); one of
  the 6 also produces the single `name-invalid` finding.
- Field distribution for the 532 `unknown-field`: `origin` 499, `homepage` 27,
  `tools` 26, `author` 7, `repo` 3, `tags` 3, `category` 3, `icon` 1, `color` 1.

**Standing rule.** 544 must never appear without the 45-actionable figure in the
same paragraph. README, marketing, release notes, and commit messages must all
cite both numbers or neither.

**Drop simulation is a range, not a set, until the host is available for
calibration. Do not market a specific "you will lose these skills" claim.**

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

### Phase 1 acceptance (revised)

Parity is **Tier 1 parity**, not all-findings parity. Phase 1 is done when every
incumbent finding that maps to a Tier 1 check is reproduced — **1 of 1**
(`budget-exceeded`). The other nine findings on the 13 user skills are not a
Phase 1 obligation: `body-too-large` (×2) and `reference-chain` (×5) are Tier 2,
deferred to Phase 3, and `script-network-call` (×2) is security, out of scope by
§23. Criterion 1: **PASS**.

The remaining Phase 1 criteria, all met:

- **Coverage on the 1,102 plugin skills.** Every Tier 1 bucket-(a) check runs on
  plugin sources — 544 findings the incumbent cannot produce. Each shipped check
  has a passing and a failing golden fixture under `test/fixtures/tier1/`.
- **Extras on both sources.** `description-capped` and `context-pressure` are not
  filtered by source; `test/source-coverage.test.ts` proves each fires for a user
  skill and a plugin skill.
- **`--why <skill>`** resolves both user and plugin (namespaced `plugin:skill`)
  skills from spec §18.1, and states plainly which parts it cannot answer yet
  (drop-set membership, runtime activation).
- **Budget accounting** reports `rawChars` and `effectiveChars` separately, with
  `overhead.charsPerEntry = 0` marked `calibrated: false`.

### Deferred to Phase 2

**Warm runtime on 100-skill corpus: 718–749 ms, vs spec target <200 ms.**
Deferred to Phase 2 profiling. Likely YAML parse; profile before optimizing.
Not optimized in Phase 1.

### Phase 2 scope additions

Three Phase 1 deviations are real scope gaps, not style notes:

- **Command discovery** (deviation 7) — `summary.commands: 0`; the incumbent
  counts 905 commands contributing 75,073 chars to the same budget; our
  `effectiveChars` understates total listing cost by that amount. Phase 2 either
  implements command discovery or explicitly declares `effectiveChars` as
  "skills-only, commands excluded" in every output format. Silence is not
  acceptable.
- **`description-capped` severity inconsistency** (deviation 1) — spec §7.1 says
  error, §6.2 says warning. Zero occurrences on the corpus so no live impact, but
  pin the severity in contract data before it fires. Phase 2.
- **Upload-path escalation** (deviation 3) — currently driven by
  `rejectedOnUploadPath` field, not a `--upload` flag Phase 1 lacks. Phase 2
  either adds the flag or documents the field-driven behavior as the permanent
  design.

### Phase 2a — budget honesty (shipped)

**Runtime gate, revised to spec §24.1.** The Phase 1 gate measured 1,115 skills,
which conflates the corpus size with our own speed and hides startup cost. The
gate is now the 100-skill corpus:

| Measure | Gate | Median | Range (5 trials) | Result |
| --- | --- | --- | --- | --- |
| 100 skills, cold | < 1,000 ms hard | **544 ms** | 512–754 ms | pass |
| 1,115 skills, cold | reported, not gated | **3,572 ms** | 3,539–3,718 ms | — |

Warm concept removed, see §4.3.

The incumbent takes 18.3 s median on the same 1,115 corpus, so a full cold run
is ~5× faster.

**Per-file parse cache removed as a measured net loss (2a.1).** Spec §4.3
originally specified a per-skill JSON cache keyed by `(path, mtime, size)`. It
was built, measured, and withdrawn: cold 100-skill **755 ms** against warm
**805 ms**; cold 1,115 **4,545 ms** against warm **5,408 ms**. Reading one JSON
file per skill costs more than reading a ~500 B SKILL.md and parsing its
frontmatter, because filesystem round-trips dominate at that file size. Removing
the cache also removed the `stat()` that fed the lookup, so cold improved past
the old cold figure: **755 → 544 ms** at 100 skills, **4,545 → 3,572 ms** at
1,115.

Cold performance comes from bundling `yaml` and `picocolors`, previously external
so every run resolved them from `node_modules` — that change alone took cold
100-skill from 1,027 ms to 755 ms. `--version` still costs 382–541 ms on this
box, of which ~290 ms is Node startup. A single-file cache (one JSON blob, atomic
writes, ~50 KB for 1,000 skills) may revisit this if 1,115-skill cold runtime
becomes a bottleneck; it is not currently justified.

**Command discovery, verified against the real home.** `~/.claude/commands` does
not exist on this machine: all 905 commands live under
`~/.claude/plugins/**/commands/**`. Discovering only the two roots the brief
named would have reported zero commands and no error, so plugin command
discovery is part of the implementation.

- 905 commands found, exactly the incumbent's count.
- 75,055 chars by bare stem, against the incumbent's 75,073 — a difference of 18
  chars (0.02%), which is the parsing disagreement we set out to find: none.
- 83,768 chars by namespaced name (`plugin:command`), which is what the host
  actually lists. The incumbent's figure ignores the namespace and therefore
  understates real listing cost by 8,713 chars (11.6%).
- All 905 names are namespaced; `foo/bar.md` renders as `foo:bar`.

On the real home `effectiveChars` is 549,886 (466,118 skills + 83,768 commands).

**Overhead and limit stay uncalibrated.** Calibration is impossible on this host:
`claude -p` exits 1 with `[claude-code:unrecognized_model]`, reports
`duration_api_ms: 0` and 0 tokens, and the install (2.1.251) is signed out. The
constant stays `0` with `calibrated: false`, and the same reason string is
carried in JSON (`budget.overhead.reason`, `budget.limitNote`) and in human
output, so no reader can mistake a placeholder for a measurement.

### Phase 2b — routing survival model (shipped)

This is the differentiator: `claude-skills-doctor` has no routing model in any
form, and no incumbent reports what adding the 1,000th skill does to top-1.

**The model.** `P_top1(N) = r · exp(−p · (N−1))`, with `r = 0.867` and
`p = 2.83e-4`, source `curse-of-skills-2026`. The break point for a threshold θ is
the smallest integer N whose estimate is at or below θ, computed by checking the
boundary rather than trusting the continuous formula's rounding. Parameters,
source and citation are printed with every estimate, in both human and JSON
output; `.skill-diag.json` and `--routing-params r,p` override them, and an
override changes the provenance label so a hand-supplied number is never
reported as the published one.

**Calibration.** The published point is `P_top1(2029) = 0.488`. Measured on the
2,029-skill fixture with distinct descriptions: **0.488** — inside the ±0.05
tolerance, so nothing is retuned.

**Duplicate adjustment.** Descriptions are tokenised, shingled at width 3, and
compared by Jaccard at 0.72; connected components become clusters; every extra
member adds `w = 1.0` effective entries, so `N_eff = N + Σ(k_i − 1)·w`. Both
estimates are always printed, because the gap between them is the finding.
On the duplicate-heavy fixture (500 descriptions × 4 copies, N = 2,000) the naive
estimate is **0.493** and the adjusted one is **0.322** (`N_eff = 3,500`) — the
adjustment moves the answer by 0.17, well past the 0.10 bar that would have
forced `w = 2`.

**The live corpus.** N = 1,115, naive **0.633**; 77 clusters covering 177 skills
(cross-plugin duplicates and translated copies inside `ecc`), `N_eff = 1,215`,
density **1.09**, adjusted **0.615**. Status OK: neither warning fires.

**Headroom is reported twice, because the two numbers answer different
questions.** Naive headroom counts raw skills; adjusted headroom counts skills at
the corpus's current cluster density, so it is the figure to quote for "how many
more distinct skills can I add".

| Line | Naive headroom | Naive N | Adjusted headroom | Adjusted N |
| --- | --- | --- | --- | --- |
| warning 0.60 | 187 | 1,302 | **80** | 1,195 |
| critical 0.50 | 831 | 1,946 | **671** | 1,786 |

Naive crossings: P(1302) = 0.59996 and P(1946) = 0.499998 (the brief predicted
832 to critical by assuming 1,947; 1946 is already below 0.50). Adjusted figures
hold density constant: `N_eff = density · N_new`, so the line is reached at
`ceil(N* / density)` — `ceil(1302 / 1.0897) = 1,195` and `ceil(1946 / 1.0897) =
1,786`. Ceiling, not floor, so the tool never overstates headroom; the brief's
79 and 670 floor the same quotients (1194.84, 1785.82). The assumption is carried
in output as `adjustedHeadroomAssumption` and labelled an estimate. Where there
are no clusters, density is 1 and adjusted equals naive.

**Quote the adjusted number when talking to users.** 187 is the raw-skill figure
and overstates how much room the router has by roughly 2× on this corpus.

**Warnings.** `routing-health-at-risk` (warning, below 0.60) and
`routing-health-critical` (error, below 0.50) are Tier 2 checks in the registry,
mutually exclusive so one corpus cannot produce both. Golden fixtures live under
`test/fixtures/tier2/`; because a two-skill fixture cannot reach a 1,300-skill
threshold, those fixtures carry their own `.skill-diag.json` parameters, and the
scale cases (1,400 and 2,000 generated skills) are exercised in
`test/routing-warnings.test.ts`.

**Marginal cost and the ladder.** The naive per-skill cost is identical for every
skill — the model sees only N — and output says so rather than manufacturing a
ranking; the adjusted column separates clustered skills (which cost two effective
entries) from singletons. The ladder reports `namespace-gating` as an *estimated*
directional gain from cross-plugin pairs, `lexical-pre-filter` as a fraction-of-
top-10 estimate, `curated-negatives` as **not-simulated** (it needs activation
data, Phase 4), and `duplicate-pruning` as per-cluster gains with the top three
listed.

**Cost.** Lint now computes the routing analysis on every run: 1,115 skills went
from 3.57 s to ~4.7 s. Pair generation uses an inverted shingle index, so only
candidate pairs that share a shingle are scored. Not gated.

**Cluster display is capped** at 12 members plus a pointer to `--json`; a raw
corpus with hundreds of clusters otherwise buries the summary it is meant to
support.

### Phase 2c — drop-order calibration attempt (shipped: unknown)

**What was asked.** Discover the host's real drop order so `--why` could name
the exact skills an over-budget listing loses: 40 synthetic skills, a pinned
`SLASH_COMMAND_TOOL_CHAR_BUDGET=10000` that forces 20 drops, and 5 trials with
shuffled install order compared against four candidate rules.

**What happened.** The host is unusable, exactly as in 2a: `claude -p` exits 1
with `Not logged in · Please run /login`, and the configured model reports
`[claude-code:unrecognized_model]`. All 5 trials failed on exit code 1 with zero
observations, so no rule could be fitted. `calibration/drop-order-result.json`
records `hostAvailable: false`, `winner: null`, `confidence: "none"`, and the
verbatim failure in `observedFailure`. The contract says the same thing:
`dropOrder: "unknown"`, `calibrationMethod: "unverified"`, with a `reason`
pointing at `calibrationUnavailableReason`.

**Harness arithmetic.** 40 skills × (64-char name + 372-char description) =
17,440 chars against a 10,000-char budget: excess 7,440 = exactly 20 × 372, so
exactly 20 descriptions must drop. Names sit at the contract's 64-char maximum
and each folder equals its frontmatter name, because `nameMustMatchDirectory`
is true. The brief's 200-char descriptions were arithmetically impossible:
40 × 200 = 8,000 is *below* the 10,000 budget, so nothing would drop.

**Escape hatch.** `calibration/manual-drop-order.sh` performs the same
experiment from a working host and prints the result JSON; redirect it to
`calibration/drop-order-result.json`, then set the contract's `dropOrder` from
that evidence rather than guesswork.

**Simulation ships as a range.** `--why <skill>` cannot name a set without a
verified order, so it reports the honest bracket `[floor(excess / max
description), ceil(excess / min description)]`, clamped to the entries that can
free chars at all. When a rule *is* calibrated the output names the exact set
with the rule that produced it. Both shapes are schema-backed
(`schema/report-v1.json`; `dropSimulation` is `null`, `range`, or `set`), and
`--why <skill> --json` emits them for CI.

**v0.1 marketing constraint.** Drop simulation cannot be a headline. The v0.1
headline is the routing survival model, plugin-skill coverage, and honest budget
labels; a specific "you will lose these skills" claim needs a calibrated host
and stays "coming when you have a working host", not a promise.

### Phase 2c.3 — routing exit codes, dual-N reporting, dedupe mode (shipped)

**The user's machine has two valid N's.** Deduped to enabled plugins at latest
version: N=1,115, top-1=0.633 adjusted 0.615, status OK. Raw scan of all cached
plugin versions: N=2,290, top-1=0.454 adjusted 0.348, status CRITICAL. 676
duplicate clusters covering 1,612 skills, dominated by `nextjs-turbopack`
appearing as 10-skill clusters in both `cache/` and `marketplaces/`. The tool
reports both; users must know which corresponds to their host's load behavior.

**Measured on the user's home.** `enabled-latest` keeps 1,069 of 2,275 plugin
skills (817 from disabled plugins, 389 marketplace install copies, 0 old
versions, 0 duplicate content), giving N=1,084 with the 15 user and project
skills included. That is 31 short of the 1,115 corpus figure. The gap is
`mattpocock-skills`, whose skills sit at `skills/<category>/<name>/SKILL.md`
instead of `skills/<name>/SKILL.md`, so the host rule does not count them. The
number was not tuned to hit 1,115; a different host layout legitimately changes
N.

**Modes.** `--dedupe enabled-latest` (default) applies the rules above,
`--dedupe all` (alias `off`) keeps the raw scan, and `.skill-diag.json` accepts
the same value. When `settings.json` has no readable `enabledPlugins`,
discovery falls back to the heuristic and `dedupe.source` reports
`heuristic, settings unreadable` rather than silently pretending the filter ran.

**Exit codes.** `routing` exits 1 on `critical` regardless of `--strict`, 2 on
`at-risk` only under `--strict`, 0 on `ok`, and 3 when `--why` matches nothing.
The status used is the worse of the active mode and the raw scan, because the
raw scan is a real load scenario for hosts that mount every cached version.
Main-report warnings still follow the active mode only, so the default run on
this machine stays clean while `--dedupe all` fires
`routing-health-critical`.

## Bugs discovered during Phase 2

Three defects surfaced while building 2a–2b. They are recorded here because two
of them were live in earlier releases, not because they were 2b scope.

**1. Subcommands ignored their own flags — live since Phase 1.** `--home`,
`--project`, `--json`, `--quiet` and friends were declared on both the root
program and every subcommand. Commander assigns a duplicated flag to the
*parent*, so `subCommand.opts()` was empty: **`budget --json` has been silently
ignored since Phase 1**, printing human output, and `budget --home <corpus>`
scanned the real home instead. Fixed in `2b4f76a` by merging parent and
subcommand options (child last). No earlier test failed, because none drove the
subcommands through the CLI — `test/budget-json.test.ts` now does, against a
schema.

**2. "2,290 skills vs 1,115" was not a discovery duplication.** During 2b the
`routing` subcommand reported N = 2,290 for the 1,115-skill corpus. The root
cause was bug 1: `--home` was discarded, so the tool scanned the real
`~/.claude` (2,275 plugin + 15 user/project skills, all cached plugin versions).
There was no junction, symlink or double-walked layout — the corpus contains
exactly 1,115 `SKILL.md` files and discovery returns 1,115 unique paths; a probe
confirmed `N=1115 uniquePaths=1115`, and the discovery walk was not changed. The
fix is the same option merge. This matters because 1,115 is a load-bearing claim
in Phase 0.5 and the parity tests.

**3. `init -p` wrote to the repository root.** The `-p, --project` option on
`init` declared `process.cwd()` as its *default*, so the subcommand's option bag
always carried the default and — merged last — overrode the path the parent had
actually parsed. Fixed by removing the default and applying `process.cwd()` at
the use site.

### Phase 3 pre-requisites

**Cached plugin versions are counted for commands but deduplicated for skills.**
Command discovery matches the incumbent: every cached plugin version counts (905
on this machine, not one per enabled plugin). Skill discovery is deduplicated to
live/enabled installs (1,115). The inconsistency is deliberate for now — matching
the incumbent's command count is what makes those numbers comparable — and is a
Phase 3 pre-requisite. Routing health depends on `N` (the skill count), not on
the command count, so it does not block 2b.

## Non-goals

Per spec §23 — no description grading by default, no security scanning, no
auto-rewrite, no cloud dependency, no claim that routing health is a
measurement.
