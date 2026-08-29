# notify/ — the Core/Notify pure core, judged by one corpus on three runtimes

The law behind `ClosedSource/DSX/Modules/Core/Notify` (`parity/F02-notifications.md`).
Everything in this folder is a DECISION, never plumbing: `UNUserNotificationCenter`,
`NotificationManagerCompat` and the browser `Notification` API all ask the pure core what to
do and then do it.

| Fixture | Pins |
|---|---|
| `permission.json` | the ladder — undetermined → provisional → granted → denied, the iOS provisional escalation, the Android 13 split, the option set that survives a request, and that `status` never prompts |
| `schedule.json` | the TRIGGER RESOLVER: `at` · `in` · `cron` · `repeats`, resolved to the next N fire instants across two DST boundaries, a leap day, a month that has no 31st, and a cron whose match never comes |
| `channels.json` | the channel-importance fold: the six words, the Android constants, the iOS interruption-level twin, the app-may-only-lower rule, user blocking, and `channel_required` |
| `presentation.json` | what a notification does while the app is open, and that a claimed `notify.received` suppresses the system presentation |
| `routing.json` | the `notify.opened` payload for a tap, an action, and a text-input action; the cold-start open; the handoff to `Mandatory/PushRouting` |

Runners:

- **TS** — `OpenSource/Web/packages/kernel/test/notify-conformance.test.ts` over
  `packages/kernel/src/notify.ts` (`node --test`, and the `conformance` script).
- **Kotlin** — `:core NotifyConformanceTest` over
  `OpenSource/Engine/Android/core/src/main/kotlin/despia/engine/NotifyCore.kt` (`gradle test`).
- **Swift** — the reference, `OpenSource/Engine/iOS/NotifyCore.swift`, driven on the Codemagic
  record lane.

## Why the timezone table is in the fixture

A reminder that fires at the wrong hour on one platform is the defining notification bug, and it
is always the same bug: three runtimes each asking their own platform what "09:00 in New York"
means. So the corpus carries its own **zone rules** — a base offset plus the exact instants at
which the offset changes — and every runner resolves wall-clock time through that table rather
than through an IANA database it happens to link. The rules are then not a matter of what a
device knows; they are a matter of what this file says.

Two transitions are pinned by name because they are where date math dies:

- **a wall-clock time that does not exist** (spring forward, 02:30 on 2026-03-08 in New York):
  the fire moves to the first instant that does exist, 03:00 local. It is never dropped, because
  a daily reminder that silently skips a day once a year is worse than one that runs half an
  hour late once a year.
- **a wall-clock time that happens twice** (fall back, 01:30 on 2026-11-01 in New York): the
  FIRST occurrence fires, and only the first. Firing twice is a duplicate notification; firing on
  the second is an hour late.

## Wall clock versus interval

`repeats: "hourly"` is an INTERVAL — exactly 3600 seconds apart, straight through a DST
transition. Every other repeat unit is WALL CLOCK: a 09:00 daily reminder is still 09:00 the day
the clocks move, which means the interval between those two fires is 23 or 25 hours. Both
behaviours are correct and they are different; the corpus pins which is which so that no runtime
has to guess.
