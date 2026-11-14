# skill-diag v0.1.0

Local-first, deterministic diagnostics for AI coding agent skills. One command
scans every skill your host can load — user, project, plugin, and marketplace
installs — checks them against a versioned contract, estimates what a crowded
skill list does to routing, and emits schema-validated JSON, human text, and
SARIF. Nothing leaves the machine.

## What it does

- **28 checks in two tiers.** Tier 1 validates each `SKILL.md` against the
  host's own contract (frontmatter shape, description length and truncation,
  name rules, body limits). Tier 2 checks corpus-level health: context-window
  pressure from the full skill listing, and a routing survival model that
  estimates whether a skill is still picked when the host must choose from N
  loaded descriptions.
- **A routing survival model, not a vibe.** `P_top1(N) = r·exp(−p·(N−1))`
  with parameters fit from the 2026 "curse of skills" measurements
  (r = 0.867, p = 2.83e-4). It reports naive P_top1(N) and an adjusted
  P_top1(N_eff) after duplicate clustering, with a break point (0.50) and a
  warning threshold (0.60). It is an estimate with labeled provenance —
  `not-simulated` until calibration lands — not a measurement.
- **Dual-N reporting.** Hosts do not load every cached copy of a plugin.
  skill-diag reports the deduped, enabled-latest count (what the host actually
  mounts) and the raw scan of every cached version side by side, because the
  two N's can differ by 2× on a real machine and the honest number is both.
- **SARIF 2.1.0 output.** `--sarif` emits a schema-validated SARIF log with
  stable `partialFingerprints`, ready for GitHub Code Scanning upload.
- **Honest labels.** Findings are `error`, `warning`, or `info`. Routing-model
  estimates are `info` by default — they are estimates, not facts about a file
  — and only gate the exit code when `--strict-raw` asks to be held to them.

## What's new in v0.1.0

First public release. Ships Tier 1 + Tier 2 checks (28 total), the routing
survival model with dual-N reporting, `--why <skill>` per-skill routing
explanations, SARIF 2.1.0 output for CI, and exit-code semantics designed for
gates: `routing` exits 0 ok / 2 at-risk under `--strict` / 1 critical, and raw
scan estimates never fail a run unless promoted with `--strict-raw`.

On a 1,115-skill corpus where the incumbent (claude-skills-doctor v0.7.0)
withholds 22 of its 28 checks from plugin skills, skill-diag reports
**544 findings the incumbent never surfaces, of which 45 are actionable** —
the other 499 are one repeated artifact of how the incumbent's own bundler
stamps an `origin` key into each skill. Both numbers are stated together on
purpose: the coverage claim is the 45, not the 544.

## What's not in v0.1.0

- No OTEL telemetry, no MCP server, no multi-host discovery (Phase 4).
- No `--fix`, no LLM-assisted grading, no dependency graph.
- No calibrated drop simulation: the drop-order model reports a range, not a
  point estimate, until calibration data exists.
- No auto-rewriting of skill files. The tool reads; it never writes skills.

## Install

```bash
npx skill-diag            # scan the current project + your home
npx skill-diag routing    # routing health, dual-N report, exit-code gate
npx skill-diag init       # write .skill-diag.json defaults
```

Or pin it in a project: `npm install --save-dev skill-diag`.

## CI usage

```yaml
# GitHub Actions: upload findings to Code Scanning
- run: npx skill-diag --sarif --quiet --home "$HOME" > skill-diag.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: skill-diag.sarif
```

Pre-commit: `npx skill-diag --quiet` exits 1 on error findings, 2 on warnings
under `--strict`, and never on `info` estimates.

## Known limitations

- **Uncalibrated overhead.** The routing model's parameters come from
  published measurements, not from this tool's own calibration runs; treat the
  absolute P_top1 values as estimates with labeled provenance.
- **Drop simulation is a range.** `--why` reports the marginal cost of a skill
  as a range because the cluster-level counterfactual is not uniquely
  determined.
- **Cold runtime.** A cold full scan of the real home (~1,084 deduped skills,
  2,290 raw) takes ~10 s on the reference machine; the 1,115-skill corpus
  takes ~5.2 s. The 100-skill gate is < 1,000 ms median, but with thin margin
  on a loaded desktop.
- **Windows-first.** Developed and tested on Windows 11; POSIX hosts are
  expected to work but are not yet exercised in CI.
