# Contributions

A family contributions chart: giving from the heart.
Built on Nonviolent Communication and Alfie Kohn's work, so there are no
points, prizes, streaks, totals, or praise. Just the list, a why line, and a
specific thank-you.

- **Works on phone and computer**, installs with Add to Home Screen.
- **One family sign-in** (Mom makes it once). Each person taps their name.
- **Family names stay private:** Mom types the kids' names on first run. They are saved only in the family's database, never in this code.
- **Synced** through a Supabase database, live on every open device.
- **Offline:** check-offs wait on the device and sync when the internet is back.
- **Mom mode** behind a PIN: lists, ideas, requests, private "feels hard" notes, settings.

## Where things are

| Path | What it is |
| --- | --- |
| `web/` | The app itself (plain HTML, CSS, JS; no build step) |
| `web/seed/seed.json` | Starter contributions, idea list, and app words. Loaded **once**, on first run; edits in the app are never overwritten. |
| `web/config.js` | Which Supabase project to use (public key only) |
| `supabase/migrations/` | Database tables, privacy rules, and PIN-checked functions |
| `scripts/validate.py` | Quick checks CI runs on every pull request (content complete, no banned words, offline files present) |
| `tests/acceptance.mjs` | The nine acceptance checks from the builder prompt, plus an offline check |
| `.github/workflows/keep-awake.yml` | Daily ping so the free Supabase plan doesn't pause |

## Run the checks

Needs Docker and the Supabase CLI (`brew install supabase/tap/supabase`).

```sh
supabase start
cd tests && npm i && node acceptance.mjs
```

The checks wipe and rebuild the **local** test database only.

## Testing tools

Mom mode → Settings → Testing tools lets you pretend it's another day or time on
that one device, to check the morning and weekly clearing. The boys can't see it.
