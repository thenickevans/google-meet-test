# google-meet-test — project instructions

## FLOWS.md is the source of truth for CLI behavior

`FLOWS.md` enumerates every startup branch, flag combo, and hotkey transition
for `join.js`. It's the map of this project's surface area.

**When editing `join.js`, keep FLOWS.md in sync:**

- If the change touches argv parsing, `--help`, the main IIFE, `setupSession`,
  `runIdleLoop`, `runHotkeyLoop`, flag/mode/source validation, or auto-detect →
  **read FLOWS.md first**, then update it in the same commit as the code change.
- If the change is local (a single function body, a selector tweak, a log line),
  don't bother loading FLOWS.md — it's not relevant.
- Grep the matrix for specific rows rather than re-reading top-to-bottom.

**When adding a flag, hotkey, or startup branch:**
1. Add a matrix row in the relevant FLOWS.md section.
2. Add a Mermaid node if it's a new decision point.
3. Add or update the test-plan entry in FLOWS.md §3 with the expected observable
   (e.g., "prints `Config: mode=X ...`" or "exits 1 with usage").
4. Run the affected §3 rows manually before marking the task done.

## Testing ritual

FLOWS.md §3 is the manual smoke-test list — every row has a command and an
expected observable. Before declaring a startup/CLI change done, walk the rows
your change could have affected. 5-10 min total if run end-to-end; usually 1-2
min for a targeted change.

Don't automate this yet. When the list becomes painful, the right next step is
extracting a pure `resolveStartupConfig({argv, env})` and unit-testing it —
not bolting on a shell-script harness.

## Other conventions

- Nick's global preferences live in `~/.claude/CLAUDE.md`; this file is
  project-specific only. Don't duplicate global rules here.
- Project memory (backlog, validated approaches, gotchas) lives in
  `~/.claude/projects/-Users-nickevans-google-meet-test/memory/`. Check there
  before asking Nick a question he may have already answered.
