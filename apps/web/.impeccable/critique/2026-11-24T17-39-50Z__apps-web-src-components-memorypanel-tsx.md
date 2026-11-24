---
target: live call side panel (post-redesign)
total_score: 24
p0_count: 1
p1_count: 2
timestamp: 2026-11-24T17-39-50Z
slug: apps-web-src-components-memorypanel-tsx
---
Method: dual-agent (A: design review · B: detector + contrast)
Target: live call side panel (MemoryPanel, NextMoveCard) after the first redesign

Score 24/40 (was 18). Old problems gone: empty Confirmed cards, skeletons, side stripes, tiny uppercase labels, 2.5:1 contrast (now 4.8:1).
Detector: 0 findings. Contrast: all main pairs pass; fails: fg-muted on bg-subtle 4.04 (debug pre CallSidebar:186), 11px labels in chat/sidebar.

Priority issues
- [P0] Header "4/4 qualified" and labels contradict content: count includes Blocked/Partial axes; "Blocked" overclaims a payback condition; Timeline "not a priority this year" labelled Partial; raw-evidence fallback headline is lowercase fragment.
- [P1] Next move text is a meta-instruction ("Correct the budget and authority mismatch..."), not something to say. Constrain to a literal question + one-line why.
- [P1] Next move card scrolls away with the record; pin it above the scroll region.
- [P2] Duplication (Dana/$15K x4), stale open loop "Provide budget information", fact categories mislabelled ("Process").
- [P3] Nested live regions double-announce; Earlier toggle lacks aria-controls and 24px target.

Earlier suggestions: recommended pattern B (topic-tracked "Still open" tray resolved by the call itself, max 2 visible + "+n more", Covered fade-out, "Left unasked" recap at call end, manual Asked/Drop override), over A (pin/dismiss) and C (time decay).
