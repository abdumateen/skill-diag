#!/usr/bin/env bash
#
# manual-drop-order.sh — drop-order calibration you can run on a working host.
#
# Why this exists: calibration/drop-order.mjs needs `claude -p` to answer, and on
# this machine it cannot (exit 1, [claude-code:unrecognized_model], signed out).
# Run this on a machine where `claude -p "hi"` returns a reply.
#
# What it does:
#   1. Builds 40 synthetic skills in a throwaway temp home (never ~/.claude/skills).
#      Each entry is name 64 chars + description 372 chars = 436; 40 entries =
#      17,440 chars. SLASH_COMMAND_TOOL_CHAR_BUDGET=10000, so exactly 20 entries
#      must lose their descriptions.
#   2. Runs `claude -p` five times, each with a different install order and mtime
#      spread, against the same isolated home layout.
#   3. Greps the captured output (and any session transcript under the isolated
#      CLAUDE_CONFIG_DIR) for each description's unique `probe-NN ::` marker.
#   4. Prints a JSON object on stdout. Save it over the shipped result:
#
#        ./calibration/manual-drop-order.sh > calibration/drop-order-result.json
#
#   Then rebuild: npx tsup && npx vitest run
#
# Requirements: bash, coreutils, node (for the JSON assembly step), and a host
# where `claude -p "test"` succeeds. Set CLAUDE_BIN to override the binary.
#
# Exit codes: 0 = result written; 3 = host unusable (nothing dropped, JSON still
# written with hostAvailable:false so the failure is recorded, not silent).

set -uo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
N=40
TRIALS=5
DESC_LEN=372
NAME_LEN=64
BUDGET=10000
PAD='—'
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/skill-diag-do-manual-XXXXXX")"
KEEP="${KEEP:-0}"

cleanup() { [ "$KEEP" = "1" ] || rm -rf "$ROOT"; }
trap cleanup EXIT

skill_name() {
  local i="$1" stem="do-probe-$(printf '%02d' "$i")-"
  local padlen=$((NAME_LEN - ${#stem}))
  printf '%s' "$stem"; printf 'x%.0s' $(seq 1 "$padlen")
}

description() {
  local i="$1" marker="probe-$(printf '%02d' "$i") :: "
  local padlen=$((DESC_LEN - ${#marker}))
  printf '%s' "$marker"; printf "$PAD%.0s" $(seq 1 "$padlen")
}

TRIAL_JSON="["
FAILED=0

for t in $(seq 0 $((TRIALS - 1))); do
  HOME_DIR="$ROOT/home-$t"
  SKILLS="$HOME_DIR/.claude/skills"
  mkdir -p "$SKILLS"

  ORDER="$(seq 0 $((N - 1)) | sort -R)"
  created=0
  for i in $ORDER; do
    dir="$SKILLS/$(skill_name "$i")"
    mkdir -p "$dir"
    printf -- '---\nname: %s\ndescription: %s\n---\n\nSynthetic probe skill %s.\n' \
      "$(skill_name "$i")" "$(description "$i")" "$i" > "$dir/SKILL.md"
    touch -t "$(date -d "-$((N - created)) minutes" '+%Y%m%d%H%M')" "$dir" 2>/dev/null || true
    created=$((created + 1))
  done

  OUT="$ROOT/trial-$t.out"
  ERR="$ROOT/trial-$t.err"
  HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" \
    CLAUDE_CONFIG_DIR="$HOME_DIR/.claude" \
    SLASH_COMMAND_TOOL_CHAR_BUDGET="$BUDGET" \
    "$CLAUDE_BIN" -p "reply with the single word ok" >"$OUT" 2>"$ERR"
  EXIT=$?

  # Transcript, if the host wrote one under the isolated config.
  TRANSCRIPT=""
  if [ -d "$HOME_DIR/.claude/projects" ]; then
    TRANSCRIPT="$(find "$HOME_DIR/.claude/projects" -name '*.jsonl' -exec cat {} + 2>/dev/null || true)"
  fi
  TEXT="$TRANSCRIPT$(cat "$OUT" 2>/dev/null)$(cat "$ERR" 2>/dev/null)"

  LISTED="[]"
  if [ "$EXIT" -eq 0 ]; then
    ids=""
    for i in $(seq 0 $((N - 1))); do
      if printf '%s' "$TEXT" | grep -qF "$(description "$i")"; then ids="$ids${ids:+,}$i"; fi
    done
    LISTED="[${ids}]"
  else
    FAILED=$((FAILED + 1))
  fi

  [ "$t" -gt 0 ] && TRIAL_JSON="$TRIAL_JSON,"
  TRIAL_JSON="$TRIAL_JSON{\"trial\":$t,\"hostExitCode\":$EXIT,\"listed\":$LISTED}"

  echo "[trial $t] exit=$EXIT listed=$(printf '%s' "$LISTED" | tr -cd ',' | wc -c | tr -d ' ') marker-failures=$FAILED" >&2
done

TRIAL_JSON="$TRIAL_JSON]"

TRIAL_JSON_ENV="$TRIAL_JSON" FAILED="$FAILED" TRIALS="$TRIALS" N="$N" DESC_LEN="$DESC_LEN" \
  NAME_LEN="$NAME_LEN" BUDGET="$BUDGET" \
node -e '
const trials = JSON.parse(process.env.TRIAL_JSON_ENV);
const anyHost = trials.some((t) => t.hostExitCode === 0 && t.listed.length > 0);
const rules = {
  a: { rule: "reverse-alphabetical" },
  b: { rule: "least-recently-invoked" },
  c: { rule: "reverse-registration" },
  d: { rule: "never-invoked-first" },
};
// Manual mode records observations only; rule fitting is done by the maintainer
// from the listed sets, because install order is not reconstructed here.
const n = Number(process.env.N);
const nameLen = Number(process.env.NAME_LEN);
const descLen = Number(process.env.DESC_LEN);
const budget = Number(process.env.BUDGET);
const out = {
  experiment: "drop-order",
  specSection: "11.1",
  generatedAt: new Date().toISOString(),
  harness: "calibration/manual-drop-order.sh",
  hostAvailable: anyHost,
  hostVersion: process.env.HOST_VERSION || null,
  configuration: {
    skills: n,
    trials: Number(process.env.TRIALS),
    descriptionChars: descLen,
    nameChars: nameLen,
    budgetChars: budget,
    totalRawChars: n * (nameLen + descLen),
    forcedDropCount: Math.round((n * (nameLen + descLen) - budget) / descLen),
    budgetEnv: "SLASH_COMMAND_TOOL_CHAR_BUDGET",
  },
  trials,
  rules,
  winner: null,
  confidence: anyHost ? "pending-fit" : "none",
  evidence: anyHost
    ? "calibration/manual-drop-order.sh — listed sets per trial; fit against the four rules"
    : "calibration/manual-drop-order.sh — every trial failed before a listing was produced",
  ...(anyHost ? {} : { reason: "host unusable: claude -p did not return a listing (see trials[].hostExitCode)" }),
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
'

[ "$FAILED" -eq "$TRIALS" ] && exit 3
exit 0