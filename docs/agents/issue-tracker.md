# Issue tracker: GitHub

Issues and specs live at https://github.com/ruimiguelcq/Inventory.
Use the gh CLI. Pass --repo ruimiguelcq/Inventory explicitly for
issue and PR commands so they also work outside a Git clone.

## Conventions

- Create: gh issue create --repo ruimiguelcq/Inventory --title "..." --body "..."
- Read: gh issue view <number> --repo ruimiguelcq/Inventory --comments
- List: gh issue list --repo ruimiguelcq/Inventory --state open --json number,title,body,labels,comments
- Comment: gh issue comment <number> --repo ruimiguelcq/Inventory --body "..."
- Label: gh issue edit <number> --repo ruimiguelcq/Inventory --add-label "..." or --remove-label "..."
- Close: gh issue close <number> --repo ruimiguelcq/Inventory --comment "..."

For multi-line bodies, use --body-file with a UTF-8 Markdown file.
Apply --label and --state filters as needed when listing issues.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If enabled later, use gh pr view/list/comment/edit/close and gh pr diff,
with the explicit repository flag. External requests come from authors
with CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, or NONE association.

GitHub shares issue and PR numbers. When the type is unknown, try
gh pr view and fall back to gh issue view.

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.
When a skill says "fetch the relevant ticket", read the issue and comments.

## Wayfinding operations

- Map: one issue labelled wayfinder:map, containing Notes,
  Decisions-so-far, and Fog.
- Child: link a ticket as a GitHub sub-issue using gh api. If unavailable,
  add it to the map's task list and start its body with Part of #<map>.
  Use wayfinder:<type> labels: research, prototype, grilling, or task.
- Blocking: use native GitHub issue dependencies. Add an edge with
  gh api --method POST repos/ruimiguelcq/Inventory/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>.
  Obtain the database ID with
  gh api repos/ruimiguelcq/Inventory/issues/<blocker> --jq .id.
  If dependencies are unavailable, use Blocked by: #<n> in the child body.
- Frontier: inspect the map's open children in map order. Choose the first
  without an assignee or open blockers. Native open blockers are counted
  by issue_dependencies_summary.blocked_by; for fallback links, check
  whether each referenced blocker is closed.
- Claim: assign the selected ticket to @me as the session's first write.
- Resolve: comment with the answer, close the ticket, and append a summary
  and link to the map's Decisions-so-far.

Use repos/ruimiguelcq/Inventory/... paths for repository gh api calls.
