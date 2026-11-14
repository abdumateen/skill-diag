# skill-diag

Local-first diagnostics for AI coding agent skills: one deterministic command
scans every skill your host can load (user, project, plugin, marketplace),
validates each `SKILL.md` against a versioned contract, estimates routing
health for crowded skill lists with a survival model and dual-N reporting
(deduped vs raw scan), and emits schema-validated JSON, human text, or SARIF
2.1.0 for CI — nothing leaves the machine, and routing-model estimates are
labeled `info` unless you ask to be held to them.

## Install

```bash
npx skill-diag
```

Or add it to a project:

```bash
npm install --save-dev skill-diag
```

## Usage

```bash
npx skill-diag                     # full scan: Tier 1 + Tier 2, exit-code gate
npx skill-diag --json              # schema-validated JSON (report-v1)
npx skill-diag --sarif             # SARIF 2.1.0 for GitHub Code Scanning
npx skill-diag routing             # routing health, dual-N (deduped + raw)
npx skill-diag routing --why <skill>   # one skill's routing cost, explained
npx skill-diag init                # write .skill-diag.json defaults
```

### `--why <skill>` example

```text
$ npx skill-diag routing --why nextjs-turbopack
nextjs-turbopack — routing survival model
  marginal top-1 contribution: 0.0011–0.0016
  duplicate cluster size: 10 (cache/ + marketplaces/ copies)
  routing health contribution: -0.012 (deduped)
```

The marginal cost is a range, not a point estimate — the cluster-level
counterfactual is not uniquely determined. See
[RELEASE_NOTES_v0.1.0.md](RELEASE_NOTES_v0.1.0.md) for the full feature list,
known limitations, and the honest-numbers policy.

## CI usage

GitHub Actions (Code Scanning upload):

```yaml
- run: npx skill-diag --sarif --quiet --home "$HOME" > skill-diag.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: skill-diag.sarif
```

Pre-commit / any gate:

```bash
npx skill-diag --quiet          # exit 1 on error findings
npx skill-diag --quiet --strict # exit 2 on warnings too
```

Exit codes: 0 clean, 1 error, 2 warnings under `--strict`, 3 usage error.
Routing-model estimates are `info` by default and never fail a run; pass
`--strict-raw` to promote them to their natural severity and gate on them.
