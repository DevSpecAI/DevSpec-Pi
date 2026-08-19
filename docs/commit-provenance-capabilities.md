# Pi commit-provenance capabilities

Authority: `devspec://product/implementation-contract` → `commit_provenance_contract`

Pi provenance support is cooperative assistance, not a filesystem, shell, or Git sandbox. Unsupported and ambiguous surfaces use instructions plus DevSpec's universal commit ingestion/analyzer.

| Surface | What Pi honestly receives | Safe transformation | Behavior |
|---|---|---:|---|
| First-class file edits (`write`, `edit`, `apply_patch`, `notebook`) | Tool name and structured arguments before execution | None needed | With an existing `.devspec/project.json` pin and no observed claim, inject at most one non-blocking nudge per Pi session/project. Always allow the edit. |
| Arbitrary Bash/shell | Command text before execution and result afterward | No general safe transform | Never classify for mutation authority, parse for commit policy, or block. Opaque commands fail open. |
| Git commit message | No first-class pre-commit message hook. For recognized Git output, Pi's existing ledger can read the resulting commit object's message and SHA, but arbitrary Bash cannot prove who authored a reference. | No safe pre-commit rewrite/stamp or certainty-grade source-attribution surface | Never deny, stamp, or report `agent_authored`/`plugin_stamped`. The ledger may attach the mechanical SHA/message to `record_implementation`; the server records conservative authoritative linkage and analyzer recovery remains available. |
| Git push/outgoing history | No first-class outgoing-commit set or push-policy hook | None | Never deny. Instructions plus server ingestion/analyzer provide recovery. Ambiguous history and service outages fail open. |
| Project association | Existing pin can be read; `/devspec.pin <full-project-uuid>` is an explicit local command | Explicit command may create/refresh the repository-root pin | Generic login, connection, bond, and remote delivery never write the current folder. Missing/malformed/unreadable pins are non-blocking. |
| DevSpec unavailable | Transport/auth/resource errors | None | Local edits, execution, tests, worktrees, cross-repository work, delegation, commits, and pushes continue. The v4 local fallback preserves coordination and linkage guidance without becoming a gate. |
| Post-implementation tools | Native DevSpec result and structured arguments | Host may mechanically attach a ledger SHA/message/source report | `record_implementation`, evidence, criterion verdicts, testing, release, and failure follow-through are never gated by claim state in Pi. |
| Subagents/unattended work | Ordinary Pi/provider behavior; no provenance-grade inherited authority signal | None | No trusted-child exception or lease. Parent and child work continue; commit linkage and server reconciliation remain authoritative. |

Independent DevSpec authentication/authorization, destructive database safeguards, cost confirmation, provider permissions, and Pi's own host controls are unchanged.
