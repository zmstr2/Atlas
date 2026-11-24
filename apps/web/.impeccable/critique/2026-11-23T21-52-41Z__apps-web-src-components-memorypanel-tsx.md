---
target: live call side panel
total_score: 18
p0_count: 2
p1_count: 2
timestamp: 2026-11-23T21-52-41Z
slug: apps-web-src-components-memorypanel-tsx
---
Method: dual-agent (A: design review · B: detector + browser)
Target: live call side panel (MemoryPanel.tsx, CallSidebar.tsx, CallStage.tsx)

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Skeletons stay mid-call; "no concerns yet" looks like "loading"; updates are silent |
| 2 | Match system / real world | 2 | BANT framing misfits a founder persona; "Authority: Soft signal" for the CTO; Mia labeled "CUSTOMER" |
| 3 | User control and freedom | 2 | Hang-up has no confirm and sits 4px from mute; resize handle not keyboard-usable |
| 4 | Consistency and standards | 2 | 10/11/12/14px sizes mixed; amber means 3 things; off-token hex in CallStage and card fills |
| 5 | Error prevention | 1 | Card can read "Confirmed" with no content |
| 6 | Recognition over recall | 2 | Fact-dot colors unexplained; hover-only verbatim |
| 7 | Flexibility and efficiency | 1 | No shortcuts; panel width not persisted; false click affordances |
| 8 | Aesthetic and minimalist | 2 | Calm palette undercut by card grid, strips, double pulse, uppercase labels |
| 9 | Error recovery | 3 | humanizeError with details is good |
| 10 | Help and documentation | 1 | Certainty scale unexplained; evidence (anchorTurnId) never shown |
| Total | | 18/40 | Poor |

## Priority issues
- [P0] "Confirmed" card with empty content (isPopulated checks state only; MemoryPanel.tsx:39-42). Fix: require a headline, else list under Awaiting; fix firm/confirmed/vague mapping.
- [P0] Skeletons used as permanent empty states (MemoryPanel.tsx:301-378). Fix: skeleton only before first data; then one teaching line or a collapsed "Not yet heard" line.
- [P1] Contrast: fg-muted #A8A29E = 2.52:1 on white, 2.04 at /80, ~2.35 on card tints; 9px chips 3.05-4.08. Fix: fg-muted -> ~#78716C, drop text opacity, min 11-12px.
- [P1] Banned/noisy accents: border-l-2 rows (detector side-tab at :135, also :153 :323 :350), bottom strips on cards, rainbow fact dots, uppercase eyebrows on every section. Fix: certainty ladder (shape not fill), sentence-case section titles, color for confirmed/blocked only.
- [P2] Principles not implemented: pushNext and anchorTurnId computed but never rendered; updates silent. Fix: "Ask next" line at top, click-to-source, 1.5s change highlight (reduced-motion safe), aria-live.

## Detector
CLI: 1 finding (side-tab, MemoryPanel.tsx:135); voice/ dir clean. Browser (pre-join page only, panel needs live mic call): cream-palette (bg.base #F7F4ED), clipped-overflow on pre-join camera tile (intentional; false positive).

## Persona red flags
Alex: no shortcuts, width resets, cursor-pointer rows that do nothing. Sam: hover-only concern divs, no aria-live, non-focusable separator, no focus-visible on icon buttons, 9-10px text. Hiring manager: confirmed-but-empty Timeline and skeletons read as bugs; the best moment (open loops) has the least weight; hang-up ends demo instantly.
