# Fitness Tracker — Agent Instructions

## Project goals

Fitness Tracker is primarily a mobile web application. Treat the phone/mobile
experience as the primary interface when making UI decisions.

Keep the project simple and maintainable. Prefer straightforward solutions over
additional services, servers, authentication layers, or infrastructure unless
they are clearly necessary.

## Working practices

- Inspect the relevant existing code before making changes.
- Preserve existing working behavior unless the task explicitly changes it.
- Keep changes focused on the requested task.
- Remove obsolete code rather than retaining compatibility layers that are no
  longer needed.
- Do not add explanatory comments about old architectures or systems that the
  project no longer uses.
- Keep README documentation focused on how the current project works.
- Do not commit credentials, tokens, API keys, generated secrets, or private
  configuration.
- Run the project's relevant checks/tests after making changes.
- Report what was changed and any checks that could not be run.

## Data

The current data format is authoritative.

Do not preserve or introduce compatibility logic for old tracked-data layouts
unless explicitly requested.

Files under data/events/ may be regenerated from source documents. Do not assume
old generated data must be preserved.

## OCR

Google OCR is the primary OCR implementation.

There is also a local/fallback OCR implementation. It is deliberately
quarantined and should remain clearly separated from the primary Google OCR
path.

Rules:

- Normal operation should use Google OCR.
- The fallback OCR must not influence or complicate the Google OCR
  implementation.
- Use fallback OCR only when Google OCR is unavailable, fails, is not configured,
  or cannot be used.
- Failure of Google OCR should degrade gracefully.
- When fallback OCR is being used, notify the user discreetly and cleanly in
  the UI rather than presenting a disruptive error.
- Do not remove fallback OCR unless explicitly requested.

### Temporary GitHub Pages OCR diagnostic harness

Use this only when an agent needs a real browser-origin Google Vision run and the
API cannot be exercised directly from the agent environment. It is a temporary
diagnostic tool, not part of the normal application architecture. Do not invoke
it unless the current task actually needs a deployed OCR integration test.

The goal is to temporarily deploy a self-running diagnostic page on the public
GitHub Pages site, run the normal production OCR/parser path against a fixture
kept in the private data repository, write the result back to the private
repository for the agent to inspect, and then restore the normal site.

Procedure:

1. Record the current `main` commit SHA of the public `Fitness-Tracker` repo and
   treat it as the mandatory restore point.
2. Put the test fixture in the private `Fitness-Tracker-Data` repository or use
   an existing private fixture. Never add personal scans or private fitness data
   to the public app repository merely to run this test.
3. Create a clearly labelled sacrificial commit on the public repo that replaces
   the normal entry page with a minimal diagnostic harness. Reuse the production
   OCR/parser modules instead of copying parser logic into the harness.
4. The harness should auto-run on page load and:
   - use the tracker token already stored in the authorized browser session;
   - stop with a clear message if no stored token is available;
   - fetch the chosen fixture from the private data repo through the GitHub API;
   - run the same Google Vision and parser path used by the normal upload UI;
   - assign a unique run ID so reloads do not create duplicate diagnostic runs;
   - write a JSON diagnostic result back to the private repository through the
     normal authenticated GitHub write path;
   - include the public app commit SHA, fixture identifier, OCR/parser result,
     warnings, relevant diagnostic text, and pass/fail expectations;
   - never write the GitHub token, authorization headers, or other credentials
     into diagnostic output.
5. Prefer `data/diagnostics/runs/` for diagnostic output so normal fitness
   records are not polluted. If the task specifically tests the production
   record-save path, use an unmistakably test-only record ID and remove it after
   the result has been inspected.
6. Push the sacrificial commit and wait until GitHub Pages is serving that exact
   commit. Open it once in the already-authorized browser; the harness then runs
   automatically and saves its result to the private repo.
7. Read the saved diagnostic result from `Fitness-Tracker-Data` and use it to
   debug or validate the change.
8. Immediately restore the public application from the saved restore point,
   including any required cache-busting version changes, and verify that Pages
   is serving the restored application.
9. Remove test-only records/fixtures when they are no longer useful. Diagnostic
   result files may be retained only when they are useful as regression evidence.

Safety requirements:

- Never commit a GitHub access token to the public repository.
- Never commit private scans or personal fitness records to the public repository.
- Do not broaden the permissions of the normal tracker token just for this
  harness.
- Use the existing Google Vision configuration; do not introduce a second key or
  a second OCR implementation for the harness.
- Keep the sacrificial deployment as small as possible and always restore the
  original site in the same work session.

## UI

- Mobile is the primary target.
- Preserve responsive behavior.
- Avoid desktop-first layouts that merely shrink on phones.
- Keep operational/status/error messages unobtrusive unless user action is
  actually required.
- Match the existing visual language rather than introducing a new design
  system for isolated changes.

## Before finishing a task

1. Review the resulting diff for unrelated changes.
2. Run the applicable tests/checks.
3. Fix issues caused by the change.
4. Summarize the implementation and validation performed.
