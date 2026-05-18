# Changelog

## 0.2.1

### Fixed

- Reminders saved with the wrong wall-clock when the LLM emitted ISO
  timestamps in UTC (`...Z` or `+00:00`) for users not in UTC. The
  agent prompt told the model to mirror the user's offset, but the
  model still returned UTC about half the time, so a recurring
  reminder set for 20:00 local in `America/Santiago` ended up firing
  at 16:00 local. Equivalent off-by-N-hours bug for every IANA zone.
  The fix lives in `supabase/functions/_shared/tz.ts`:
  `reinterpretUtcAsLocal` rewrites any `Z`, `+00:00` or `-00:00`
  suffix to the owner's IANA offset (DST-aware via `formatInTimeZone`)
  before the row is inserted. Applied to both `create_reminder` and
  `create_event`.
- The bot used to respond to "what time is it on your internal clock"
  with a UTC time it invented. The `current_time` tool already returns
  local time, so the model was confabulating. Tool description and
  rules 12 and 14 in the system prompt now state explicitly that the
  tool already returns local time, the assistant has no separate
  internal clock, and UTC must never appear in user-facing replies.
- Appointments with a person or place (medical, dental, government,
  flights, interviews, school) now require both a `create_reminder`
  call (so it pings) and a `create_event` call (so it blocks the
  calendar slot). The old prompt left it ambiguous and the model often
  picked one.
- "Morning", "wake up", "noche", "before bed" and similar wording no
  longer default to 06:00 / 22:00. The agent must read `wake_time` and
  `bed_time` from `owner_context`, ask once if missing, and persist
  with `remember_about_user`.
- Confirmation is one-shot. After the user says yes / sí / dale / ok,
  the agent executes immediately instead of re-asking the same
  question.

### Added

- `supabase/functions/_shared/tz.ts` with `reinterpretUtcAsLocal`,
  isolated from runtime env so it can be unit-tested.
- `tests/reinterpret_utc_test.ts` covering UTC noop, Santiago,
  Madrid summer + winter (DST), Tokyo year-round, `+00:00` and
  `-00:00` suffixes, sub-second precision, malformed ISO. 8 tests,
  all green.

### Changed

- Removed unused imports and dead helpers in
  `supabase/functions/_shared/agent.ts`,
  `supabase/functions/_shared/commands.ts` and
  `supabase/functions/telegram-webhook/index.ts` flagged by the
  linter (CodeRabbit / Sonar).
- Replaced `String#replace(/x/g, …)` with `String#replaceAll` in
  `agent.ts` and `calendar/index.ts`. Replaced `parseInt` with
  `Number.parseInt` in `dispatch-reminder/index.ts`. Replaced
  `String#charCodeAt` with `String#codePointAt` in `telegram.ts`.
- `calendar/index.ts` `Array#sort()` on date keys now uses
  `localeCompare` so order is locale-stable.
- `calendar-cloud/index.html` settings modal: every `<label>` now
  has a `for=` attribute pointing at its control.

### Repository

- `sonar-project.properties` excludes `supabase/migrations/**` and
  `tests/**` from duplication scoring (forward-only migrations and
  shared test fixtures are not real duplication).

## 0.2.0

- Added daily proactive nudges via the `pulse` Edge Function and a
  pg_cron tick: collisions in the agenda, upcoming birthdays, dropped
  habits, idle stretches.
- Added second-brain features: journal entries with semantic search,
  habit tracking with streaks, agenda collision detection.
- Added weather (OpenWeather), good-news headlines (GNews/NewsAPI),
  live web search (Tavily/Brave/SerpAPI), location geocoding.
- Added the JSON RPC `calendar_feed` and `calendar_meta` to power a
  static HTML calendar UI shipped under `calendar-cloud/`. Month,
  week, day and list views, color picker, week start day, default
  view, language-aware.
- One-shot installer at `scripts/setup.sh` that links the project,
  applies migrations, pushes secrets, deploys every function, sets
  the cron URLs, and registers the Telegram webhook.
- Default language is now English. Switch with
  `UPDATE owner SET language = 'es' WHERE id = 1;`.
- No timezone fallback: the bot asks for it on first message and
  derives the IANA zone from your reported time.
- Mojibake repair pass on source strings.
- Atomic habit logging via `log_habit_atomic` (no race conditions on
  streak updates).
- Birthday view now safe across leap years and the owner timezone.

## 0.1.0

- Initial release.
