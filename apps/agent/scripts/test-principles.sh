#!/usr/bin/env bash
set -e

# Loads OPENROUTER_API_KEY from repo-root .env.local
set -a
source "$(dirname "$0")/../../../.env.local"
set +a

run_eval() {
  local label="$1"
  local augment="$2"
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "RUN: $label"
  echo "════════════════════════════════════════════════════════"
  SUGGESTER_AUGMENT="$augment" bun scripts/eval-conversation.ts 2>&1 | \
    awk '/^AGGREGATE SCORES/,/^CADENCE SUPPRESSION ANALYSIS/' | head -20
}

P1='# Pain completeness (applies to principles 1, 2, 4)
A pain signal remains active until three components exist in the conversation:
  (1) a number or quantification
  (2) a downstream consequence (cost, blocker, or business meaning)
  (3) a process or owner (who feels it, where in the workflow)
If any component is missing, drilling plays (drill_vague, quantify_pain) take precedence over advancing plays (push_next_axis, trial_close, multi_thread).'

P2='# Acknowledgment is not anchoring (applies to principle 1 and rep_skipped_drill)
Acknowledgment is a single beat: a verbal recognition ("yeah, that is a lot", "got it", "wow", "makes sense"). Anchoring is a follow-up move that builds on the acknowledged content (a question about it, a translation of it, a reframe of it). A rep who acknowledges a fresh pain signal and then changes subject HAS NOT anchored — that is a skipped drill.'

P3='# Commitment requires three components (applies to anchor_next_step, rep_no_next_step, trial_close)
A "next step" is a commitment only when it specifies all three:
  (1) when — a specific date, time, or scheduled meeting
  (2) who — the named participants
  (3) what — the agenda or deliverable
Missing any component = vague follow-up, not commitment. At call end (signaled by the prospect acknowledging the end), a vague follow-up is the architectural break — anchor_next_step fires regardless of whether any other technique error appears.'

P4='# Prospect agency outranks sticky context (applies to principles 3, 4)
Load-bearing concerns and unresolved objections are STATE — they describe what is true in the conversation. Prospect-offered paths are EVENTS — what just happened in the latest turn. Events take precedence over state. When the prospect latest utterance offers their own forward motion (proposing to involve a stakeholder, proposing a conditional path, asking for evidence they can use internally), pick the play that seizes that offered motion. Do not reframe an objection the prospect just offered to work around. Reframe is for stuck objections; a prospect proposing forward motion is not stuck.'

P5='# LAER governs objection-handling mistakes
When the rep is responding to an explicit objection, the LAER framework applies (Listen → Acknowledge → Explore → Respond/Confirm). Skipping ANY LAER step is rep_defended_objection. This takes precedence over rep_off_ladder; if the rep is responding to an objection at all (even badly, even drifting topics), the mistake is in how they are handling the objection, not that they changed subject. rep_off_ladder fires only when no objection is in play and the rep introduces an unrelated topic.'

run_eval "BASELINE (no augment)" ""
run_eval "P1: Signal completeness" "$P1"
run_eval "P2: Acknowledgment vs anchoring" "$P2"
run_eval "P3: Commitment components" "$P3"
run_eval "P4: Prospect agency vs state" "$P4"
run_eval "P5: LAER hierarchy" "$P5"
run_eval "ALL: P1+P2+P3+P4+P5" "$P1

$P2

$P3

$P4

$P5"
