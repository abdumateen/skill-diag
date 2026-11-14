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

## GitHub Actions

The repo ships a composite action (`action.yml`) that runs the scan and
uploads the SARIF report to GitHub Code Scanning. The upload runs even when
the scan fails, so a red build still shows its findings:

```yaml
name: skill-diag
on:
  push:
    branches: [main]
  pull_request:

permissions:
  security-events: write   # required for the SARIF upload

jobs:
  skills:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: OWNER/skill-diag@v0.2.0
        with:
          version: 0.2.0
          args: --strict --sarif skill-diag.sarif
```

Replace `OWNER` with the repository owner once the action is published.
Inputs: `args` (default `--strict --sarif skill-diag.sarif`) and `version`
(default `latest`). If you change the SARIF path in `args`, change the
`sarif_file` the action uploads accordingly — pin `version` to the release
you reviewed for reproducible CI.

## Pre-commit Hook

The repo ships a pre-commit hook definition (`.pre-commit-hooks.yaml`) that
runs the full scan before every commit:

```yaml
repos:
  - repo: OWNER/skill-diag
    rev: v0.2.0
    hooks:
      - id: skill-diag
```

The hook runs `skill-diag --strict` against the whole skill directory — not
just changed files — because a skill's listing cost and routing health depend
on the corpus, not on the diff.

## GitLab CI

Jenkins, Bitbucket Pipelines, and GitLab CI all drive the tool through its
Docker image. Build the image from this repository's `Dockerfile`, push it to
your registry, then use it as the job image:

```yaml
# .gitlab-ci.yml
skill-diag:
  stage: test
  image:
    name: registry.gitlab.com/OWNER/skill-diag:v0.2.0
    entrypoint: [""]
  script:
    - node /app/dist/cli.js --strict --sarif skill-diag.sarif
  artifacts:
    when: always
    paths:
      - skill-diag.sarif
```

`entrypoint: [""]` hands the job a plain shell; the tool lives at
`/app/dist/cli.js` inside the image. GitLab has no Code Scanning equivalent,
so the SARIF file is kept as a job artifact — with `when: always`, a failing
gate still uploads its report.

Any CI that can run Docker gets the same result without a registry:

```bash
docker run --rm -v "$PWD:/project" -w /project skill-diag --strict
```

## CI usage

Prefer the action and hook above. For a bare gate on any CI:

```bash
npx skill-diag --quiet          # exit 1 on error findings
npx skill-diag --quiet --strict # exit 2 on warnings too
```

Exit codes: 0 clean, 1 error, 2 warnings under `--strict`, 3 usage error.
Routing-model estimates are `info` by default and never fail a run; pass
`--strict-raw` to promote them to their natural severity and gate on them.
