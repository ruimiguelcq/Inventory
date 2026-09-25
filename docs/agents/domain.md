# Domain docs

## Layout and reading rules

This project uses a single-context layout:
- CONTEXT.md at the repository root: domain vocabulary.
- docs/adr/: architectural decision records.

Before exploring the codebase, read CONTEXT.md and ADRs relevant to
the area being changed. If CONTEXT-MAP.md exists in the future, follow
its pointers to relevant context files and context-scoped ADRs.

If these files are absent, proceed silently. The domain-modeling skill,
also used by grill-with-docs and improve-codebase-architecture, creates
them lazily as terms and decisions are resolved.

## Vocabulary

Use the terms defined in CONTEXT.md in issue titles, proposals,
hypotheses, and tests. If a concept is missing, reconsider the term
or note the gap for domain-modeling.

## ADR conflicts

Explicitly surface proposals that contradict an existing ADR,
identifying the ADR and why the decision is worth reopening.
