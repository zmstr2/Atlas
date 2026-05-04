# Atlas Project

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
- `/office-hours` — Office hours facilitation
- `/plan-ceo-review` — CEO-level product thinking and expansion proposals
- `/plan-eng-review` — Architecture diagrams, test matrices, failure mode mapping
- `/plan-design-review` — Design audit, AI slop detection, design system inference
- `/design-consultation` — Interactive design consultation
- `/design-shotgun` — Rapid multi-concept design generation
- `/design-html` — HTML/CSS design prototyping
- `/review` — Paranoid code review with auto-fixes
- `/ship` — Release engineer: PR creation and shipping
- `/land-and-deploy` — Land PR and trigger deployment
- `/canary` — Canary deploy monitoring
- `/benchmark` — Performance benchmarking
- `/browse` — Fast headless browser for web browsing and QA
- `/connect-chrome` — Connect to an existing Chrome session
- `/qa` — Full QA with browser automation
- `/qa-only` — QA without design review
- `/design-review` — Design review on current branch
- `/setup-browser-cookies` — Configure browser cookies for QA sessions
- `/setup-deploy` — Configure deployment settings
- `/setup-gbrain` — Set up GBrain integration
- `/retro` — Developer stats and retrospective
- `/investigate` — Deep investigation of issues or codebases
- `/document-release` — Release documentation
- `/codex` — AI-powered code generation
- `/cso` — Chief Security Officer security review
- `/autoplan` — Automatic planning and task breakdown
- `/plan-devex-review` — Developer experience review planning
- `/devex-review` — Developer experience review
- `/careful` — Extra-careful mode for risky operations
- `/freeze` — Freeze dependencies or configuration
- `/guard` — Guard against regressions
- `/unfreeze` — Unfreeze dependencies or configuration
- `/gstack-upgrade` — Upgrade gstack to latest version
- `/learn` — Interactive learning mode

If gstack skills aren't working, run `cd ~/.claude/skills/gstack && ./setup` to rebuild the binary and re-register skills.
