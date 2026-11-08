Below is the complete, implementation-ready specification for the project. It is written to be handed directly to a coding agent. Every architectural decision, CLI surface, data model, check definition, output format, and integration contract is specified. Where a behavior must be verified experimentally against a live host, that verification is specified as a build-time task rather than assumed as fact.

\---

\# PROJECT SPECIFICATION: \`skill-diag\` — Capability Surface Observability for Agent Skills

\## 1. What this is

\`skill-diag\` is a \*\*local-first, deterministic CLI and CI-native observability platform\*\* that audits every \`SKILL.md\` an AI coding agent can see and answers three questions no existing tool answers together:

1\. \*\*Will this skill load at all?\*\* (static contract validity against the host’s loader)

2\. \*\*Will this skill actually fire when it should?\*\* (runtime activation evidence joined to static findings)

3\. \*\*At current library size, can the router still find the right skill at all?\*\* (scale-aware routing health)

The positioning sentence:

\> \*\*“Your skill exists. That doesn’t mean the agent can see it, route to it, or still find it once your library scales.”\*\*

It is \*\*not\*\* a description grader (that is skill-issue’s job, and skill-issue does it well). It is \*\*not\*\* a security scanner (that is Snyk/Socket/skill-scanner’s job). It is the \*\*mechanical activation and routing layer\*\* that sits beneath the semantic layer and makes it actionable.

\---

\## 2. What it solves (the failure modes, precisely)

\### 2.1 Static silent exclusion

Claude Code injects a listing of skill names and descriptions into the system prompt under a shared character budget. As of Claude Code 2.0.70+, the default is \*\*15,000 characters (~4,000 tokens)\*\*, controlled by \`SLASH\_COMMAND\_TOOL\_CHAR\_BUDGET\`. When the listing overflows, \*\*names still list, but descriptions are dropped—starting with the skills you invoke least\*\*—and Claude is told not to use skills it was not told about. The failure produces no error and no warning.

A second, independent limit compounds this: each individual entry’s \`description + when\_to\_use\` is \*\*truncated at 1,536 characters\*\*, regardless of the total budget. And because the listing budget is also expressed as \*\*1% of the model’s context window\*\*, the same skill set can be comfortable on a 1M-token model and 37% over budget on a 200K-token model.

Other static failure modes: invalid YAML frontmatter (prevents loading entirely, silently), \`name\` not matching the folder name (the loader rejects it; Anthropic’s own validator misses this), missing \`name\` or \`description\`, exact name collisions, and unknown frontmatter fields that the host silently ignores.

\*\*Confirmed evidence of scale:\*\* one analysis found that at the 15,000-character limit, approximately \*\*26% of skills are excluded from Claude’s context\*\*.

\### 2.2 Runtime activation failure (the gap static linters cannot see)

A skill can pass every static check and still never fire. Claude Code now emits \*\*OpenTelemetry \`claude\_code.skill\_activated\` events\*\* carrying \`skill.name\`, \`skill.source\`, and—since v2.1.126—an \*\*\`invocation\_trigger\` attribute\*\* with values \`"user-slash"\`, \`"claude-proactive"\`, and \`"nested-skill"\`. Transcripts also carry \`attributionSkill\` metadata on assistant turns.

This means it is now possible to answer: \*\*“This skill passed every static check but has fired zero times in 200 sessions. Its closest neighbor fired 47 times on prompts that match this skill’s description.”\*\* No existing tool joins the static and runtime evidence streams to produce that sentence.

\### 2.3 Scale-induced routing failure (the largest unsolved problem)

The \*\*Curse of Skills\*\* paper measured a production harness that grew from ~1,600 to 2,029 skills in three weeks. \*\*Top-1 routing accuracy fell to 48.9%\*\*—it crossed the 50% break point at approximately \*\*1,950 skills\*\*—while \*\*Recall@5 stayed at 86.7%\*\*, making recall-centric monitoring structurally blind to the top-1 collapse. The two-parameter survival model is:

\\\[

P\_{\\text{top-1}}(N) = r \\cdot e^{-p(N-1)}

\\\]

with calibrated values \\(r = 0.867\\) and \\(p = 2.83 \\times 10^{-4}\\) per skill at N = 2,029. The model decomposes the top-1 deficit into \*\*ranking collision (~38 points)\*\* versus \*\*retrieval failure (~13 points)\*\*—a 2.9-to-1 ratio—meaning near-duplicate skills dominate the problem, and an affordable mitigation ladder (namespace gating → lexical pre-filter → curated negatives) holds quality.

No CLI linter models this. \`skill-diag\` should.

\---

\## 3. Architecture (pipeline, not daemon)

\`\`\`

┌──────────────────────────────────────────────────────────────────┐

│ Layer 0 · DISCOVERY │

│ Walk skill dirs per host · slash-command defs · context files │

│ Cache by file mtime · no network calls │

└──────────────────────────────┬───────────────────────────────────┘

▼

┌──────────────────────────────────────────────────────────────────┐

│ Layer 1 · STRICT PARSER │

│ YAML frontmatter with host-accurate strictness · line-level errors│

│ Flag unknown fields · flag host-invalid-but-YAML-valid constructs│

└──────────────────────────────┬───────────────────────────────────┘

▼

┌──────────────────────────────────────────────────────────────────┐

│ Layer 2 · CONTRACT ENGINE (contracts as data, one per host) │

│ Budget formula · overhead · per-entry cap · name rules · drop │

│ ordering · required/forbidden fields │

└──────────────────────────────┬───────────────────────────────────┘

▼

┌──────────────────────────────────────────────────────────────────┐

│ Layer 3 · CHECK ENGINE │

│ Tier 1 deterministic errors · Tier 2 heuristic warnings │

│ Tier 3 optional semantic (--llm) │

└──────────────────────────────┬───────────────────────────────────┘

▼

┌──────────────────────────────────────────────────────────────────┐

│ Layer 4 · CAPABILITY SURFACE MODEL (shared data model · core IP)│

│ static health ⊕ runtime health ⊕ routing health │

└──────────────────────────────┬───────────────────────────────────┘

▼

┌──────────────────────────────────────────────────────────────────┐

│ Layer 5 · OUTPUT & INTEGRATION │

│ human · JSON · SARIF · GitHub Action · GitLab CI · MCP · graph │

└──────────────────────────────────────────────────────────────────┘

\`\`\`

The \*\*Capability Surface Model\*\* is the shared data structure every output reads from. It is what makes this a platform rather than a bundle of commands.

\---

\## 4. Discovery layer (Layer 0) — exact specification

\### 4.1 Paths to walk

| Host | Skill paths | Command paths | Context files |

|---|---|---|---|

| \*\*Claude Code\*\* | \`~/.claude/skills//SKILL.md\`, \`.claude/skills//SKILL.md\`, plugin skill dirs | \`.claude/commands/\*\*/\*.md\`, \`~/.claude/commands/\*\*/\*.md\` | \`CLAUDE.md\`, \`.claude/CLAUDE.md\` |

| \*\*Codex\*\* | \`~/.codex/skills//SKILL.md\`, \`.codex/skills/\` (if present) | — | \`AGENTS.md\` |

| \*\*Cursor\*\* | \`.cursor/skills/\` (if present) | \`.cursor/commands/\` | \`.cursor/rules/\*\*/\*.mdc\` |

| \*\*Gemini CLI\*\* | \`.gemini/skills/\` (if present) | — | \`GEMINI.md\` |

| \*\*OpenClaw\*\* | \`~/.openclaw/skills/\`, \`.openclaw/skills/\` (Claude-compatible layout) | same as commands | \`OPENCLAW.md\` |

Discovery is \*\*purely filesystem-based\*\*. No host API calls, no network. Walk each root recursively, collecting \`SKILL.md\` files and command \`.md\` files.

\### 4.2 Priority and shadowing

Claude Code resolves skills in priority order: \*\*Enterprise → Personal → Project → Plugin\*\*. Plugin skills use a \`plugin-name:skill-name\` namespace. When two skills resolve to the same command name, the higher-priority one wins and the lower one is \*\*shadowed\*\*. Discovery must record the priority tier and the resolved command name for every skill, and the check engine must flag shadowing.

\### 4.3 Caching

Cache parsed ASTs keyed by \`(absolute\_path, mtime, size)\`. A repeated run in watch mode or pre-commit should skip re-parsing unchanged files. Cache location: \`~/.cache/skill-diag/\` (respect \`XDG\_CACHE\_HOME\`). Cache is invalidated automatically on mtime change; a \`--no-cache\` flag forces a cold run.

\---

\## 5. Parser layer (Layer 1) — exact specification

\### 5.1 Frontmatter fields (Claude Code, complete)

| Field | Type | Constraints | Notes |

|---|---|---|---|

| \`name\` | string | lowercase alphanumeric + hyphens, max \*\*64\*\* chars, no leading/trailing/doubled hyphens, \*\*must match directory name\*\* | Defaults to directory name if omitted |

| \`description\` | string | max \*\*1024\*\* chars | Recommended, not strictly required by spec—but omitting it makes the skill unroutable |

| \`argument-hint\` | string | — | Autocomplete hint; \*\*Claude Code-only\*\*, rejected by claude.ai uploads |

| \`disable-model-invocation\` | boolean | default \`false\` | If \`true\`, description is \*\*not\*\* in context; skill only loads on explicit invocation |

| \`user-invocable\` | boolean | default \`true\` | If \`false\`, hidden from \`/\` menu but description stays in context |

| \`allowed-tools\` | string | space/comma-separated tool names, e.g. \`Read, Bash(git \*)\` | Pre-approves tools without permission prompts |

| \`model\` | enum | \`haiku\` \\| \`sonnet\` \\| \`opus\` | — |

| \`context\` | enum | \`fork\` | Runs in isolated subagent context |

| \`agent\` | string | \`Explore\` \\| \`Plan\` \\| \`general-purpose\` \\| custom | Used when \`context: fork\` |

| \`hooks\` | object | — | Lifecycle hooks scoped to the skill |

| \`license\` | string | — | Open-standard field |

| \`compatibility\` | string | max \*\*500\*\* chars | Open-standard field |

| \`metadata\` | object | string keys and values | Open-standard field |

\*\*The six open-standard fields\*\* (portable across 70+ platforms via the Agent Skills standard, now donated to the Linux Foundation’s Agentic AI Foundation): \`name\`, \`description\`, \`license\`, \`compatibility\`, \`metadata\`, \`allowed-tools\`. Any field outside this set is \*\*Claude Code-only\*\* and must be flagged when the target is a portable upload path.

\### 5.2 Parser strictness requirements

The parser must \*\*mimic the host loader, not merely validate YAML\*\*. Concretely:

1\. Use the \`yaml\` package (eemeli/yaml) in strict mode. Report the \*\*exact line and column\*\* of every parse error.

2\. \*\*Reject or flag constructs the host rejects even when valid YAML\*\*: tabs in indentation, duplicate keys, anchors/aliases in frontmatter (the host loader does not resolve them), and unquoted colons in description values (a common silent breaker).

3\. \*\*Flag unknown fields as warnings\*\*, not silent passes. Claude Code ignores unknown fields, which hides typos (e.g., \`argument-hint\` on a claude.ai upload path is a hard error, not an ignore).

4\. \*\*Do not auto-fix YAML.\*\* Report the error and the line number. Silent fixes hide the same class of failure the tool exists to expose.

\### 5.3 Body parsing

After the closing \`---\` of frontmatter, parse the markdown body to support three downstream checks:

\- \*\*Declared tool usage\*\*: scan for tool-name references (e.g., \`Bash(\`, \`Read\`, \`Write\`, \`Edit\`, \`Grep\`, \`Glob\`) to compare against \`allowed-tools\`.

\- \*\*Reference file presence\*\*: resolve relative paths mentioned in the body (e.g., \`references/foo.md\`, \`scripts/bar.sh\`) and verify they exist inside the skill folder.

\- \*\*Body size\*\*: measure character count for the oversized-body warning.

\---

\## 6. Contract engine (Layer 2) — contracts as data

Each host is defined by a \*\*JSON contract file\*\* in \`contracts/\`. The core engine never contains host-specific conditionals. Adding a host means adding a contract file, not rewriting code.

\### 6.1 Contract schema

\`\`\`jsonc

{

"$schema": "https://skill-diag.dev/schemas/contract-v1.json",

"host": "claude-code",

"versionRange": ">=2.0.70",

"skillRoots": \["~/.claude/skills", ".claude/skills"\],

"commandRoots": \[".claude/commands", "~/.claude/commands"\],

"frontmatter": {

"required": \[\],

"recommended": \["description"\],

"namePattern": "^\[a-z0-9\]+(-\[a-z0-9\]+)\*$",

"nameMaxLength": 64,

"nameMustMatchDirectory": true,

"descriptionMaxLength": 1024,

"allowedFields": \["name","description","argument-hint","disable-model-invocation",

"user-invocable","allowed-tools","model","context","agent",

"hooks","license","compatibility","metadata"\],

"openStandardFields": \["name","description","license","compatibility","metadata","allowed-tools"\],

"rejectedOnUploadPath": \["argument-hint"\]

},

"listingBudget": {

"mode": "percentage\_of\_context",

"fraction": 0.01,

"absoluteDefaultChars": 15000,

"envOverride": "SLASH\_COMMAND\_TOOL\_CHAR\_BUDGET",

"perEntryCapChars": 1536,

"defaultContextWindow": 200000,

"charsPerToken": 4

},

"dropBehavior": {

"namesAlwaysListed": true,

"dropTarget": "descriptions",

"dropOrder": "least\_recently\_invoked\_first",

"dropOrderConfidence": "experimental"

},

"priorityOrder": \["enterprise","personal","project","plugin"\],

"telemetry": {

"otelEvent": "claude\_code.skill\_activated",

"triggerAttribute": "invocation\_trigger",

"triggerValues": \["user-slash","claude-proactive","nested-skill"\],

"attributionField": "attributionSkill"

}

}

\`\`\`

\*\*Build-time requirement:\*\* The \`dropOrder\` field is marked \`"experimental"\` because the exact ordering is undocumented. The coding agent must build a \*\*calibration harness\*\* (see §11) that creates a controlled skill set exceeding the budget and observes which descriptions are dropped. The calibrated ordering is then encoded in the contract with a \`confidence\` flag. If the ordering cannot be reproduced reliably, \`dropOrder\` falls back to \`"unknown"\` and the drop simulation reports a \*\*range\*\* rather than a single prediction.

\### 6.2 Budget calculation (including overhead)

The budget is \*\*not\*\* a raw sum of \`name + description\` lengths. Each entry carries formatting overhead (separators, labels, whitespace). The formula is:

\\\[

\\text{effective\\\_chars} = \\sum\_{i \\in \\text{skills}} \\left( |name\_i| + |description\_i| + |when\\\_to\\\_use\_i| + \\text{overhead} \\right) + \\sum\_{j \\in \\text{commands}} \\left( |name\_j| + |description\_j| + \\text{overhead} \\right)

\\\]

The \`overhead\` constant must be \*\*measured experimentally\*\* by the calibration harness and recorded in the contract as \`overheadCharsPerEntry\`. The CLI must report \*\*both\*\* \`rawChars\` and \`effectiveChars\`, and must state which value the verdict is based on.

Per-entry truncation is checked separately: if \`description + when\_to\_use\` exceeds \`perEntryCapChars\` (1,536), report a \`description-capped\` warning with the number of characters that will never reach the model.

\---

\## 7. Check engine (Layer 3) — complete check catalogue

Checks are partitioned into three tiers. Tier 1 checks are \*\*errors\*\* (non-zero exit by default). Tier 2 checks are \*\*warnings\*\* (non-zero exit only with \`--strict\`). Tier 3 is \*\*opt-in\*\*.

\### 7.1 Tier 1 — deterministic errors (hard failures)

| Check ID | Severity | What it verifies | Message shape |

|---|---|---|---|

| \`yaml-invalid\` | error | Frontmatter parses under host-strict rules | \`line {L}: {parser error}\` |

| \`missing-name\` | error | \`name\` is present or derivable from directory | \`SKILL.md has no name and directory name is not a valid identifier\` |

| \`missing-description\` | error | \`description\` is present and non-empty | \`description is empty — skill will be unrouteable\` |

| \`name-folder-mismatch\` | error | \`name\` equals directory basename | \`name: {name} must match folder name {folder}\` |

| \`name-invalid\` | error | \`name\` matches \`^\[a-z0-9\]+(-\[a-z0-9\]+)\*$\`, ≤64 chars | \`name {name} violates pattern / length\` |

| \`description-too-long\` | error | \`description\` ≤ 1024 chars | \`description is {n} chars; max is 1024\` |

| \`description-capped\` | error | \`description + when\_to\_use\` ≤ 1,536 chars | \`{n} chars will never reach the model (cap 1,536)\` |

| \`budget-exceeded\` | error | Effective chars ≤ budget limit | \`{used}/{limit} effective chars ({pct}%) — {dropCount} skill description(s) will be silently dropped\` |

| \`exact-name-collision\` | error | No two skills resolve to the same command name across priority tiers | \`{name} is shadowed: {pathA} (tier X) overrides {pathB} (tier Y)\` |

| \`unknown-field\` | error on upload path | No fields outside \`openStandardFields\` when target is portable upload | \`argument-hint is rejected on claude.ai upload paths\` |

| \`required-field-missing\` | error | All contract-required fields present | \`{field} is required by {host} {version}\` |

\### 7.2 Tier 2 — heuristic warnings (soft failures)

| Check ID | Severity | What it verifies | Message shape |

|---|---|---|---|

| \`description-collision\` | warning | No pair of descriptions exceeds similarity threshold (default 0.72 Jaccard on token shingles) | \`description ~{pct}% overlaps {other} — they may compete to trigger\` |

| \`trigger-overlap\` | warning | Extracted trigger clauses (from \`Use when…\`, \`Trigger when…\`, or first sentence) do not overlap across skills | \`trigger sets for {a} and {b} overlap on: {terms}\` |

| \`allowed-tools-mismatch\` | warning | Declared \`allowed-tools\` covers tools referenced in the body | \`body references {tool} but allowed-tools does not include it\` |

| \`body-oversized\` | warning | Body ≤ threshold (default 5,000 chars) | \`body is {n} chars — move examples to references/\` |

| \`reference-missing\` | warning | Relative paths in the body resolve to existing files | \`references {path} but file does not exist\` |

| \`reference-chain-too-deep\` | warning | Reference chains are ≤1 level deep | \`{path} → {path2} → {path3} exceeds depth 1\` |

| \`absolute-path\` | warning | No absolute filesystem paths in the body | \`absolute path {path} reduces portability\` |

| \`docs-in-skill-folder\` | warning | No \`README.md\`/\`CHANGELOG.md\` inside skill folder | \`{file} is human-facing documentation and does not belong in a skill folder\` |

| \`context-pressure\` | warning / error at >95% | Estimated system-prompt size ≤ 80% of context window | \`system prompt estimated at {n}/{window} tokens ({pct}%)\` |

| \`routing-health-at-risk\` | warning | Estimated top-1 survival probability < 0.60 | \`estimated top-1 at N={n} is {p} — below 0.60\` |

| \`routing-health-critical\` | error | Estimated top-1 survival probability < 0.50 | \`estimated top-1 at N={n} is {p} — below the 0.50 break point\` |

\### 7.3 Tier 3 — optional semantic (\`--llm\`)

When \`--llm\` is passed, the tool spawns a local \`claude\` or \`codex\` CLI with a structured prompt and parses the response. Checks:

| Check ID | What it assesses |

|---|---|

| \`description-too-vague\` | Description does not contain a trigger clause the router can match |

| \`description-is-howto\` | Description is a step-by-step summary rather than a trigger (“Use when…”), which causes the agent to follow the summary and skip loading the body |

| \`description-scope-too-broad\` | Description would match almost any prompt and therefore competes with everything |

The \`--llm\` path is \*\*opt-in and offline by default\*\*. It must be labeled as a \*\*triage signal\*\*, never as a verdict. The default run makes zero network calls and zero model calls.

\### 7.4 Check result schema

Every check emits a result object:

\`\`\`jsonc

{

"checkId": "name-folder-mismatch",

"tier": 1,

"severity": "error",

"skillPath": "/abs/path/.claude/skills/pdf-tools/SKILL.md",

"skillName": "pdf-tools",

"line": 2,

"column": 7,

"message": "name: pdf must match folder name pdf-tools",

"fix": {

"kind": "rename-frontmatter-field",

"field": "name",

"from": "pdf",

"to": "pdf-tools",

"confidence": "certain"

}

}

\`\`\`

The \`fix\` object is \*\*advisory\*\*. It is consumed by \`--fix\` and by the human output’s “suggested fix” line. It is never applied automatically without explicit confirmation.

\---

\## 8. Capability Surface Model (Layer 4) — the core data model

Every skill in the discovery set is represented as a single object that joins static, runtime, and routing health:

\`\`\`jsonc

{

"identity": {

"name": "pdf-tools",

"commandName": "pdf-tools",

"path": "/abs/path/.claude/skills/pdf-tools/SKILL.md",

"host": "claude-code",

"tier": "project",

"contentHash": "sha256:…"

},

"declaredContract": {

"description": "Extract text and tables from PDFs. Use when…",

"allowedTools": \["Read", "Bash(pdftotext \*)"\],

"model": null,

"disableModelInvocation": false,

"userInvocable": true,

"unknownFields": \[\]

},

"staticHealth": {

"tier1Errors": \[\],

"tier2Warnings": \["description-collision"\],

"rawChars": 412,

"effectiveChars": 448,

"perEntryTruncatedBy": 0

},

"runtimeHealth": {

"activationCount": 0,

"activationByTrigger": {"user-slash": 0, "claude-proactive": 0, "nested-skill": 0},

"lastActivatedAt": null,

"sessionsObserved": 200,

"closestNeighbor": {"name": "doc-extract", "activationCount": 47, "descriptionSimilarity": 0.78}

},

"routingHealth": {

"duplicateClusterId": "pdf-extraction",

"clusterSize": 3,

"estimatedTop1Contribution": -0.021,

"marginalTop1IfRemoved": 0.514,

"inDropSet": false

}

}

\`\`\`

This model is written to \`.skill-diag/capability-surface.json\` on every run (unless \`--no-state\`), enabling trend analysis and dashboard ingestion. It is the single source of truth for all output formats.

\---

\## 9. Routing health engine — the scale model

\### 9.1 The survival model

Given a library of \\(N\\) skills, estimate top-1 routing accuracy as:

\\\[

\\hat{P}\_{\\text{top-1}}(N) = r \\cdot e^{-p(N-1)}

\\\]

Default calibrated parameters (from the Curse of Skills production measurement): \\(r = 0.867\\), \\(p = 2.83 \\times 10^{-4}\\). These defaults are \*\*overridable\*\* via config, because a different harness may have different collision hazards.

The break point where top-1 crosses a threshold \\(\\theta\\) is:

\\\[

N^\*(\\theta) = 1 + \\frac{\\ln(r/\\theta)}{p}

\\\]

At \\(\\theta = 0.50\\), \\(N^\* \\approx 1{,}950\\).

\### 9.2 Duplicate-mass adjustment

The base model treats every skill as an independent collision hazard. The engine refines it using \*\*duplicate clusters\*\*:

1\. Build a graph of skills whose pairwise description similarity exceeds a threshold (default 0.72) or whose trigger sets overlap.

2\. Each connected component is a \*\*duplicate cluster\*\* of size \\(k\\). The effective collision hazard contributed by the cluster is scaled by a factor derived from \\(k\\) (a cluster of \\(k\\) near-identical skills contributes more collision mass than \\(k\\) independent skills because they compete on the same prompts).

3\. Recompute \\(\\hat{P}\_{\\text{top-1}}\\) with the adjusted \\(N\_{\\text{eff}}\\) and report the \*\*delta\*\* from the base model.

This is why the tool can say: “You have 240 skills, but 61 of them form 14 duplicate clusters. Your effective collision mass is 279. Removing the 3 largest clusters would move estimated top-1 from 0.47 to 0.55.”

\### 9.3 Marginal-cost simulation

For each skill \\(i\\), compute the change in \\(\\hat{P}\_{\\text{top-1}}\\) if that skill were removed:

\\\[

\\Delta\_i = \\hat{P}\_{\\text{top-1}}(N-1) - \\hat{P}\_{\\text{top-1}}(N)

\\\]

Report the top contributors to routing loss. This answers: \*\*“Which skill, if pruned, would most improve the router’s ability to find everything else?”\*\*

\### 9.4 Mitigation ladder

Recommend mitigations in order of effort-to-impact, following the Curse of Skills mitigation ranking:

1\. \*\*Namespace gating\*\* — prefix skill command names by domain (e.g., \`pdf:extract\`, \`pdf:fill\`) to reduce cross-domain collisions.

2\. \*\*Lexical pre-filter\*\* — add distinguishing trigger vocabulary to descriptions.

3\. \*\*Curated negatives\*\* — add explicit “Do not use when…” clauses to the highest-collision skills.

4\. \*\*Duplicate pruning\*\* — merge or remove near-identical skills.

The output must state the \*\*estimated top-1 gain\*\* of each mitigation, using the model.

\### 9.5 Important honesty constraint

The routing health model is a \*\*calibrated estimate\*\*, not a measurement of the user’s specific harness. The CLI must always label it as \`estimated\`, must state the parameters and their source, and must offer \`--calibrate\` mode (see §11) to fit \\(r\\) and \\(p\\) from the user’s own activation logs. If the user has no runtime data, the model uses published defaults and says so.

\---

\## 10. Runtime activation observatory

\### 10.1 Data sources

Claude Code emits \`claude\_code.skill\_activated\` OTEL log events with:

\- \`event.name\`: \`"skill\_activated"\`

\- \`skill.name\`: the skill name (may be \`"custom\_skill"\` unless \`OTEL\_LOG\_TOOL\_DETAILS=1\` for third-party plugins)

\- \`skill.source\`: \`"bundled"\`, \`"userSettings"\`, \`"projectSettings"\`, \`"plugin"\`

\- \`invocation\_trigger\`: \`"user-slash"\`, \`"claude-proactive"\`, \`"nested-skill"\`

Transcripts carry \`attributionSkill\` on assistant messages, stamped onto turn-end events.

\### 10.2 Ingestion

\`skill-diag runtime ingest --otel \` accepts either:

\- A directory of \`.jsonl\` OTEL log files.

\- An OTLP HTTP endpoint URL (optional \`--otlp\` flag; this is the only network call the tool makes, and only when explicitly requested).

It parses events into a time-indexed activation store: \`~/.cache/skill-diag/runtime.sqlite\` (or a JSONL fallback if SQLite is unavailable). Schema:

\`\`\`sql

CREATE TABLE activations (

ts TEXT NOT NULL,

skill\_name TEXT NOT NULL,

skill\_source TEXT,

trigger TEXT, -- user-slash | claude-proactive | nested-skill

session\_id TEXT,

prompt\_id TEXT

);

CREATE INDEX idx\_skill\_ts ON activations(skill\_name, ts);

\`\`\`

\### 10.3 The static–runtime join

For every skill in the discovery set, the join produces:

\- \*\*Activation count\*\* (total and by trigger).

\- \*\*Last activated\*\* timestamp.

\- \*\*Zero-activation flag\*\* if \`activationCount == 0\` and \`sessionsObserved >= threshold\` (default 20).

\- \*\*Trigger theft\*\*: if skill A has zero activations and its closest neighbor B has a high activation count, and the two descriptions are similar above threshold, flag \`trigger-theft-suspect\` with B as the suspected thief.

\- \*\*Slash-only drift\*\*: if a skill fires only via \`user-slash\` and never via \`claude-proactive\`, its description is not winning autonomous routing—flag \`proactive-routing-failure\`.

\### 10.4 Privacy

Runtime data is \*\*local only\*\*. No telemetry is sent anywhere. The OTEL endpoint flag is opt-in and documented as a network call. The SQLite store can be deleted with \`skill-diag runtime purge\`.

\---

\## 11. Calibration harness (build-time requirement)

Before shipping drop simulation and routing health, the coding agent must build and run three calibration experiments. Each experiment is a script under \`calibration/\` that produces a JSON fixture consumed by the contract and the model.

\### 11.1 Drop-order calibration

Create a controlled \`.claude/skills/\` directory with \\(K\\) synthetic skills whose descriptions are padded to known lengths. Set \`SLASH\_COMMAND\_TOOL\_CHAR\_BUDGET\` to a value that forces exclusion of exactly \\(M\\) skills. Observe which descriptions are dropped (via transcript inspection or a minimal host probe). Repeat with shuffled install order. Fit the observed ordering to a rule (\`least-recently-invoked\`, reverse-alphabetical, reverse-registration). Record the winning rule and a confidence score in \`contracts/claude-code.json → dropBehavior.dropOrder\`.

\### 11.2 Overhead calibration

Using the same harness, measure the difference between \`rawChars\` (sum of name + description) and \`effectiveChars\` (the value at which the host actually drops). The delta divided by the number of entries is \`overheadCharsPerEntry\`. Record it in the contract.

\### 11.3 Routing-parameter calibration (optional, user-facing)

\`skill-diag calibrate --activations \` fits \\(r\\) and \\(p\\) to the user’s own data by regressing top-1 accuracy against registry size over time (if the user has historical size and activation data). If insufficient data exists, it falls back to published defaults and says so. This is the mechanism by which the model becomes \*\*specific to the user’s harness\*\* rather than a generic estimate.

\---

\## 12. CLI interface — complete specification

Binary name: \`skill-diag\`. Package name: \`skill-diag\`. \`npx skill-diag\` runs without install.

\### 12.1 Commands

| Command | Purpose |

|---|---|

| \`skill-diag\` (default) | Run all Tier 1 + Tier 2 checks on all discovered skills; human output |

| \`skill-diag lint \[paths…\]\` | Lint specific skill directories or files |

| \`skill-diag budget\` | Show the budget bar, per-skill contribution, and drop simulation |

| \`skill-diag collisions\` | Show duplicate clusters, trigger overlap, and shadowing |

| \`skill-diag routing\` | Show routing health: estimated top-1, break point, marginal costs, mitigation ladder |

| \`skill-diag runtime ingest --otel \` | Ingest OTEL activation logs |

| \`skill-diag runtime report\` | Show static–runtime join: zero-activation skills, trigger theft, slash-only drift |

| \`skill-diag calibrate --activations \` | Fit routing parameters to local data |

| \`skill-diag fix\` | Show proposed patches (never auto-commits) |

| \`skill-diag init\` | Write a \`.skill-diag.json\` with defaults |

| \`skill-diag mcp\` | Start the MCP server (stdio) |

| \`skill-diag graph\` | Emit a JSON graph of skills, clusters, and edges |

\### 12.2 Flags (global)

| Flag | Default | Behavior |

|---|---|---|

| \`--json\` | off | Machine-readable output (schema below) |

| \`--sarif \` | off | Write SARIF v2.1.0 for GitHub Code Scanning |

| \`--strict\` | off | Tier 2 warnings also produce non-zero exit |

| \`--fix\` | off | Show proposed patches as a unified diff; never apply |

| \`--yes\` | off | With \`--fix\`, apply only \`confidence: certain\` fixes; still never commit |

| \`--llm\` | off | Enable Tier 3 semantic checks via local \`claude\`/\`codex\` CLI |

| \`--why \` | off | Explain every finding for one skill in detail |

| \`--host \` | auto-detect | Restrict to one host contract |

| \`--context-window \` | contract default (200000) | Override context window for budget derivation |

| \`--budget \` | env/contract | Pin the listing budget in characters |

| \`--no-cache\` | off | Bypass parse cache |

| \`--no-state\` | off | Do not write \`capability-surface.json\` |

| \`--quiet\` | off | Suppress human output; exit code only |

| \`--color\` / \`--no-color\` | auto | Force color on/off |

\### 12.3 Exit codes

| Code | Meaning |

|---|---|

| \`0\` | No Tier 1 errors; no Tier 2 warnings (or no \`--strict\`) |

| \`1\` | Tier 1 error(s) present |

| \`2\` | \`--strict\` and Tier 2 warning(s) present |

| \`3\` | Invalid CLI usage / bad flag |

| \`4\` | Internal error (parse crash, IO failure) |

\### 12.4 Human output — exact layout

\`\`\`

skill-diag v0.1.0 · host: claude-code 2.1.x · context: 200,000 tokens

Discovery budget ████████████████████████████░░░░ 13,120 / 15,000 chars (87%)

effective chars (incl. overhead) 13,448 / 15,000 (89.7%)

per-entry cap 1,536 chars (1 skill truncated)

drop simulation if budget exceeded, 2 skills drop descriptions:

· pdf-fill (last activated: never)

· doc-merge (last activated: 41 days ago)

Routing health estimated top-1 0.62 (N=186, duplicate mass=214)

break point (0.50) at N≈1,950 headroom: 1,764 skills

largest routing cost pdf-extraction cluster (3 skills, −0.021)

FINDINGS (severity-ordered)

ERROR name-folder-mismatch pdf-tools/SKILL.md:2

\`name: pdf\` must match folder name \`pdf-tools\`

fix: change name to \`pdf-tools\` \[certain\]

ERROR budget-exceeded (listing)

13,448 / 15,000 effective chars — 2 skill descriptions will be dropped

fix: trim \`pdf-fill\` (−412 chars) and \`doc-merge\` (−388 chars) \[likely\]

WARN description-collision review-code/SKILL.md:3

description ~72% overlaps \`code-review\` — may compete to trigger

fix: add a distinguishing trigger clause \[heuristic\]

WARN zero-activation pdf-tools

0 activations in 200 sessions; closest neighbor \`doc-extract\` fired 47×

fix: run \`skill-diag runtime report --why pdf-tools\` \[diagnostic\]

28 skills · 6 commands · 2 errors · 2 warnings · 1 runtime finding

exit 1

\`\`\`

The budget bar uses \`█\` for used and \`░\` for remaining. Severity ordering is error → warning → runtime finding. Every finding includes a \*\*fix line\*\* and a \*\*confidence tag\*\* (\`certain\`, \`likely\`, \`heuristic\`, \`diagnostic\`).

\---

\## 13. JSON output schema (for CI)

\`\`\`jsonc

{

"version": "1",

"tool": {"name": "skill-diag", "version": "0.1.0"},

"host": "claude-code",

"contextWindow": 200000,

"generatedAt": "2026-11-08T12:00:00Z",

"summary": {

"skills": 28,

"commands": 6,

"errors": 2,

"warnings": 2,

"runtimeFindings": 1,

"exitCode": 1

},

"budget": {

"limitChars": 15000,

"rawChars": 13120,

"effectiveChars": 13448,

"percentUsed": 89.7,

"perEntryCapChars": 1536,

"dropSimulation": {

"willDrop": true,

"droppedSkills": \["pdf-fill", "doc-merge"\],

"confidence": "experimental"

}

},

"routingHealth": {

"estimatedTop1": 0.62,

"model": {"r": 0.867, "p": 0.000283, "source": "curse-of-skills-default"},

"breakPointN": 1950,

"duplicateMass": 214,

"clusters": \[

{"id": "pdf-extraction", "members": \["pdf-tools","pdf-fill","doc-merge"\], "top1Cost": -0.021}

\]

},

"findings": \[

{

"checkId": "name-folder-mismatch",

"tier": 1,

"severity": "error",

"skill": "pdf-tools",

"path": "/abs/.../pdf-tools/SKILL.md",

"line": 2,

"column": 7,

"message": "name: pdf must match folder name pdf-tools",

"fix": {"kind":"rename-frontmatter-field","field":"name","to":"pdf-tools","confidence":"certain"}

}

\],

"runtime": {

"sessionsObserved": 200,

"zeroActivationSkills": \["pdf-tools"\],

"triggerTheftSuspects": \[{"victim":"pdf-tools","thief":"doc-extract","similarity":0.78}\],

"slashOnlySkills": \[\]

}

}

\`\`\`

The JSON schema ships in \`schema/report-v1.json\`. The CLI validates its own output against the schema before printing (a \`--self-check\` flag runs this explicitly).

\---

\## 14. SARIF output (GitHub Code Scanning)

\`--sarif \` writes SARIF v2.1.0 with:

\- \`tool.driver.name\`: \`"skill-diag"\`.

\- \`tool.driver.rules\`: one rule per \`checkId\`, with \`shortDescription\`, \`fullDescription\`, \`helpUri\`, and \`defaultConfiguration.level\` (\`error\` or \`warning\`).

\- \`results\`: one result per finding, with \`ruleId\`, \`level\`, \`message.text\`, and \`locations\[0\].physicalLocation.artifactLocation.uri\` + \`region.startLine\` / \`startColumn\`.

\- \`partialFingerprints\`: a stable hash of \`(checkId, path, line)\` so GitHub can track findings across commits.

This is the format that produces \*\*inline PR annotations\*\* via \`github/codeql-action/upload-sarif\`.

\---

\## 15. GitHub Action

Repository root contains \`action.yml\`:

\`\`\`yaml

name: skill-diag

description: Audit agent skills for silent activation and routing failures

inputs:

args:

description: Arguments passed to skill-diag

default: "--strict --sarif skill-diag.sarif"

context-window:

description: Model context window in tokens

default: "200000"

runs:

using: composite

steps:

\- shell: bash

run: npx --yes skill-diag ${{ inputs.args }} --context-window ${{ inputs.context-window }}

\- if: always()

uses: github/codeql-action/upload-sarif@v3

with:

sarif\_file: skill-diag.sarif

\`\`\`

The action runs \`npx skill-diag\` (no separate install), writes SARIF, and uploads it. Findings appear as PR annotations. The action fails the check on exit code 1 (or 2 with \`--strict\`). A \`--fix\` workflow is \*\*not\*\* included in the action; fixes are reviewed locally.

\---

\## 16. MCP server

\`skill-diag mcp\` starts a stdio MCP server exposing one tool:

\`\`\`jsonc

{

"name": "diagnose\_skills",

"description": "Diagnose why an agent skill is not loading, routing, or scaling. Returns structured findings for a named skill or the whole library.",

"inputSchema": {

"type": "object",

"properties": {

"skill": {"type": "string", "description": "Optional skill name; omit to diagnose the whole library"},

"includeRuntime": {"type": "boolean", "default": true},

"includeRouting": {"type": "boolean", "default": true}

}

}

}

\`\`\`

The tool returns the \*\*same JSON report\*\* as \`--json\`, filtered to the requested skill if \`skill\` is provided. The agent can call it mid-run when a user says “why isn’t my skill firing?” and explain the fix in natural language. This is the \*\*feedback loop inside the agent\*\*—the agent diagnoses its own blindness.

\---

\## 17. Configuration file (\`.skill-diag.json\`)

Optional. Zero-config is the default; the file exists for teams that need to pin behavior.

\`\`\`jsonc

{

"$schema": "https://skill-diag.dev/schemas/config-v1.json",

"hosts": \["claude-code"\],

"budget": {

"limitChars": null,

"contextWindow": 200000,

"perEntryCapChars": 1536

},

"thresholds": {

"descriptionSimilarity": 0.72,

"triggerOverlap": 0.50,

"bodyMaxChars": 5000,

"routingWarnTop1": 0.60,

"routingErrorTop1": 0.50,

"zeroActivationMinSessions": 20

},

"routing": {

"r": 0.867,

"p": 0.000283,

"source": "curse-of-skills-default"

},

"ignore": \[

{"checkId": "docs-in-skill-folder", "path": ".claude/skills/legacy-\*"}

\],

"severityOverrides": {

"trigger-overlap": "error"

}

}

\`\`\`

\`skill-diag init\` writes this with defaults and comments. The CLI \*\*never requires\*\* the file to run.

\---

\## 18. How people use it (end-to-end workflows)

\### 18.1 Individual developer — “my skill never fires”

\`\`\`bash

npx skill-diag --why my-skill

\`\`\`

The tool reports: static findings, budget status, whether \`my-skill\` is in the drop set, whether it has ever activated, and whether a neighbor is stealing its triggers. The fix line points to the smallest change.

If the developer has OTEL logs:

\`\`\`bash

npx skill-diag runtime ingest --otel ~/.claude/logs/otel.jsonl

npx skill-diag runtime report --why my-skill

\`\`\`

The report shows: “0 activations in 200 sessions; \`doc-extract\` fired 47 times on prompts matching your description; similarity 0.78. Fix: add a distinguishing trigger clause, or prune \`doc-extract\`.”

\### 18.2 Team — CI gate on every PR

Add the GitHub Action. Every PR that adds a skill which the host will silently drop, or which pushes the library past a routing-health threshold, \*\*fails the check\*\* with an inline annotation. The developer fixes it before merge. No skill is ever merged invisible.

\### 18.3 Platform team — capacity planning

\`\`\`bash

npx skill-diag routing --json

\`\`\`

The report shows estimated top-1, the break point, duplicate clusters, and the marginal cost of each skill. The platform team uses it to decide when to namespace-gate, when to prune, and when to stop adding skills. It is \*\*budget planning for the capability surface\*\*, not just linting.

\### 18.4 Agent self-diagnosis — MCP

The user asks the coding agent: “why isn’t my pdf skill firing?” The agent calls \`diagnose\_skills\` via MCP and answers: “Your \`pdf-tools\` skill passed static checks but is being shadowed on the budget by two larger descriptions, and its trigger overlaps with \`doc-extract\` which fired 47 times. Trim \`pdf-fill\` by 412 chars and add ‘Use when the user mentions PDF forms’ to \`pdf-tools\`.”

\### 18.5 Pre-commit hook

\`\`\`yaml

\# .pre-commit-config.yaml

\- repo: local

hooks:

\- id: skill-diag

name: skill-diag

entry: npx skill-diag --strict

language: system

files: 'SKILL\\.md$'

\`\`\`

\### 18.6 GitLab CI

\`\`\`yaml

skill-diag:

image: node:22

script:

\- npx skill-diag --json --strict > skill-diag.json

artifacts:

paths: \[skill-diag.json\]

rules:

\- changes: \['\*\*/SKILL.md'\]

\`\`\`

\---

\## 19. Distribution

| Channel | Command | Purpose |

|---|---|---|

| \*\*npm\*\* | \`npx skill-diag\` / \`npm i -g skill-diag\` | Primary channel; zero-friction |

| \*\*Standalone binary\*\* | \`skill-diag\` (via \`bun build --compile\`) | Pre-commit, CI images without Node |

| \*\*Homebrew\*\* | \`brew install skill-diag\` | Secondary macOS channel |

| \*\*GitHub Action\*\* | \`uses: /skill-diag-action@v1\` | CI distribution multiplier |

| \*\*MCP\*\* | \`npx skill-diag mcp\` | Agent self-diagnosis |

\`package.json\` includes a \`bin\` entry mapping \`skill-diag\` to \`dist/cli.js\`. The binary is built from the same TypeScript source via Bun’s compile target.

\---

\## 20. Tech stack (exact)

| Concern | Choice | Rationale |

|---|---|---|

| Language | \*\*TypeScript\*\* (strict mode) | Type safety for contract schemas and JSON output; npm-native |

| Runtime | \*\*Node ≥20\*\* for npx; \*\*Bun\*\* for single-file binary | Broadest reach; binary fallback |

| YAML | \*\*\`yaml\` (eemeli/yaml)\*\* strict mode | Line-level errors; the de facto standard【—】 |

| CLI parser | \*\*\`commander\`\*\* (or hand-rolled if binary size matters) | Five subcommands and ~15 flags; commander is stable |

| HTTP (optional OTLP) | \*\*\`undici\`\*\* (built into Node 20+) | No extra dependency |

| SQLite (runtime store) | \*\*\`better-sqlite3\`\*\* or JSONL fallback | Synchronous, fast, local |

| Testing | \*\*\`vitest\`\*\* + fixture corpus of real \`SKILL.md\` files | Fast; snapshot tests for output formats |

| Build | \*\*\`tsup\`\*\* (bundle) + \*\*\`bun build --compile\`\*\* (binary) | Minimal config |

| Schema validation | \*\*\`ajv\`\*\* against JSON Schema | Validate own output; validate config |

Dependency budget: \*\*≤6 runtime dependencies\*\* (\`yaml\`, \`commander\`, \`better-sqlite3\` optional, \`ajv\`, \`picocolors\`, \`undici\` optional). No framework, no database server, no vector store, no mandatory network call.

\---

\## 21. Repository layout

\`\`\`

skill-diag/

├── package.json

├── tsconfig.json

├── action.yml

├── README.md

├── contracts/

│ ├── claude-code.json

│ ├── codex.json

│ ├── cursor.json

│ ├── gemini-cli.json

│ └── openclaw.json

├── schema/

│ ├── report-v1.json

│ ├── config-v1.json

│ └── contract-v1.json

├── src/

│ ├── cli.ts

│ ├── discovery/

│ │ ├── walk.ts

│ │ ├── priority.ts

│ │ └── cache.ts

│ ├── parser/

│ │ ├── frontmatter.ts

│ │ ├── body.ts

│ │ └── strict-yaml.ts

│ ├── contracts/

│ │ ├── loader.ts

│ │ └── budget.ts

│ ├── checks/

│ │ ├── tier1/

│ │ ├── tier2/

│ │ ├── tier3/

│ │ └── registry.ts

│ ├── model/

│ │ ├── capability-surface.ts

│ │ ├── routing-health.ts

│ │ └── duplicate-clusters.ts

│ ├── runtime/

│ │ ├── otel.ts

│ │ ├── store.ts

│ │ └── join.ts

│ ├── output/

│ │ ├── human.ts

│ │ ├── json.ts

│ │ ├── sarif.ts

│ │ └── graph.ts

│ ├── mcp/

│ │ └── server.ts

│ └── calibration/

│ ├── drop-order.ts

│ ├── overhead.ts

│ └── routing-params.ts

├── calibration/

│ ├── fixtures/

│ └── run.ts

├── test/

│ ├── fixtures/skills/

│ └── \*.test.ts

└── .github/workflows/

├── ci.yml

└── release.yml

\`\`\`

\---

\## 22. Implementation order (strict)

The coding agent must follow this order. Do not build later stages before earlier stages pass their acceptance tests.

1\. \*\*Discovery + parser + Claude Code contract + Tier 1 checks + human/JSON output.\*\* Acceptance: on a fixture corpus of 30 real \`SKILL.md\` files, the tool reproduces every finding that claude-skills-doctor reproduces, plus \`description-capped\` and \`context-pressure\`.

2\. \*\*Budget with overhead + drop simulation.\*\* Acceptance: the calibration harness reproduces the host’s drop set on a controlled fixture with ≥90% accuracy. If accuracy is below 90%, \`dropOrder\` falls back to \`"unknown"\` and the simulation reports a range.

3\. \*\*SARIF + GitHub Action.\*\* Acceptance: a PR that adds a skill with \`name-folder-mismatch\` produces an inline annotation and a failing check.

4\. \*\*Routing health engine.\*\* Acceptance: on a synthetic library of N = 2,029 skills with known duplicate clusters, the estimated top-1 is within ±0.05 of the published calibration point (0.489) when using default parameters.

5\. \*\*Runtime ingest + static–runtime join.\*\* Acceptance: with a fixture OTEL log containing 200 sessions and one zero-activation skill whose neighbor fired 47 times, the join emits a \`trigger-theft-suspect\` finding.

6\. \*\*MCP server.\*\* Acceptance: an MCP client can call \`diagnose\_skills\` and receive a schema-valid report filtered to one skill.

7\. \*\*Cross-host contracts (Codex, Cursor).\*\* Acceptance: adding a contract file is sufficient to lint that host’s skills; no core code changes.

8\. \*\*\`--fix\`, \`--llm\`, graph output.\*\* Last. These are enhancements, not the wedge.

\---

\## 23. What this project explicitly does not do

\- It does \*\*not\*\* grade description quality by default. That is \`skill-issue\`’s job; the \`--llm\` flag is a triage signal, not a competitor.

\- It does \*\*not\*\* scan for security vulnerabilities. That is \`skill-audit\`, Snyk, Socket, and \`skill-scanner\`’s job. It may surface \`\` in descriptions as a prompt-injection hygiene warning, but it does not attempt a security audit.

\- It does \*\*not\*\* auto-rewrite descriptions. \`selftune\` does that; this tool \*\*diagnoses\*\* and proposes reviewable fixes.

\- It does \*\*not\*\* require a cloud account, a server, a vector store, or a mandatory LLM call.

\- It does \*\*not\*\* claim the routing health estimate is a measurement. It is a calibrated estimate, labeled as such, with an opt-in calibration path.

\---

\## 24. Acceptance criteria for the whole project

The project is ready for a v1.0 release when \*\*all\*\* of the following are true:

1\. \`npx skill-diag\` runs on a clean machine with Node 20+ in \*\*under one second\*\* on a 100-skill directory (cold cache) and under 200 ms warm.

2\. On the fixture corpus, it finds \*\*every\*\* Tier 1 error that claude-skills-doctor finds, plus \`description-capped\`, \`context-pressure\`, and \`budget-exceeded\` with drop simulation.

3\. The GitHub Action produces SARIF that GitHub Code Scanning accepts without schema errors.

4\. The routing health model reproduces the published top-1 calibration point within ±0.05 on the synthetic 2,029-skill fixture.

5\. The MCP server passes the MCP conformance test suite and returns schema-valid JSON for \`diagnose\_skills\`.

6\. A user with OTEL logs can run \`runtime ingest\` and \`runtime report\` and receive a \`trigger-theft-suspect\` finding on the fixture data.

7\. The tool makes \*\*zero network calls\*\* in the default path, verified by a network-isolated test.

8\. Every output format (human, JSON, SARIF) is validated against its schema in CI.

9\. Adding a new host contract requires \*\*only\*\* adding a JSON file and fixtures—no changes to \`src/checks/\` or \`src/model/\`.

10\. The README contains a working quickstart for \*\*all six\*\* usage workflows in §18.

\---

This specification is complete. A coding agent can build from it without further product decisions. The two items that require empirical work rather than pure implementation are the \*\*drop-order calibration\*\* and the \*\*overhead calibration\*\*; both are specified as build-time harnesses with fallback behavior, so the product ships correctly even if the host’s behavior cannot be modeled with full confidence.