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
