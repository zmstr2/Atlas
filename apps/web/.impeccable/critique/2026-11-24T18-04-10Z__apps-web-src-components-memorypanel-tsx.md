---
target: "side panel: Next move card + hierarchy"
total_score: 24
p0_count: 2
p1_count: 2
timestamp: 2026-11-24T18-04-10Z
slug: apps-web-src-components-memorypanel-tsx
---
Method: dual-agent (A: design review · B: detector + type inventory)
Target: live call side panel, Next move card + panel hierarchy (third pass)
Score 24/40 (flat): honesty gains offset by added feature density. Aesthetic & minimalist = 1.
Detector 0 findings. Type inventory: 24 distinct text styles, 5 sizes, 4 weights, 9 colors across panel+sidebar; 12px vs 13px too close (1.08).
P0 Record shows everything always (4 lines per known axis, cross-axis duplicates) -> 2-line rows, detail+quote on expand, auto-expand during change flash.
P0 Suggestions too long (30-word compound questions) -> <=18 words, one question, no "and" compounds; why <=8 words; clamp 3 lines.
P1 Card does four jobs (now/why/tray/history) -> question only by default; why+actions on hover/focus (why visible 5s on arrival); tray = one "2 more open" footer line; history moves to record bottom.
P1 Chrome noise: "Live memory" bar duplicates persona header, ~7 hairlines, "Not raised yet", 600 weights -> delete; whitespace not dividers; 4 text styles.
P2 Color semantics: Unconfirmed + Pressed share amber; "Still open" vs "Open loops" name clash; prospect-owed loop labelled "You".
P3 No undo for Drop/Asked; shortcuts undiscoverable.
