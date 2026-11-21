# Interrupted workflow recovery tests (#353)

Test: `backend/tests/interrupted-workflow-recovery.test.ts`.
Mechanisms under test: [`recovery-flow.ts`](../backend/src/recovery/recovery-flow.ts)
(the step cursor), [`side-effect-checkpoint.ts`](../backend/src/recovery/side-effect-checkpoint.ts)
([RECOVERY_CHECKPOINTS.md](./RECOVERY_CHECKPOINTS.md)), the job worker's lease
([JOBS.md](./JOBS.md)) and the export service's cancellation ([EXPORTS.md](./EXPORTS.md)).

Existing tests prove each mechanism on its own. These prove they compose: that a
workflow killed at *any* point recovers safely.

## Approach

A four-step workflow (`validate`, `submit-proof`\*, `notify-seller`\*, `finalize`;
\* = external side effect) is run by a small driver that persists a cursor and
wraps each effect in `runWithCheckpoint`. The test then enumerates **every crash
point**, restarts against the same durable state, and checks two properties:

- **Safety:** each external effect is performed at most once (the ledger is the
  ground truth, not the checkpoint).
- **Liveness:** the run completes, or stops at a named state that needs a human
  (`IN_DOUBT`), or is refused as still live (`IN_PROGRESS`). It never loops,
  skips a step, or silently re-sends.

| Crash point | What survives | Recovery |
| --- | --- | --- |
| `before_step` | cursor at the step | re-runs it |
| `in_effect` (effect landed, outcome not written) | checkpoint `started`, ledger has the effect | without a provider lookup → `IN_DOUBT` after the stale window; with one → settled `succeeded`, continues |
| `after_effect_recorded` (checkpoint settled, cursor not advanced) | checkpoint `succeeded` | replays the stored result, no second send, advances |
| `after_cursor` | cursor advanced | continues with the next step |

Restarting before the stale window yields `IN_PROGRESS` (it may still be
running), and only afterwards `IN_DOUBT`.

## Why it is deterministic

No timers, sleeps or randomness. Time is an injected clock. "The process dies" is
a flag on the checkpoint store that makes its writes silently not land, which is
exactly what a real crash does. One test runs the whole matrix twice and asserts
byte-identical traces, ledgers and cursors.

## Also covered

- Repeated crashes on every restart still end with exactly-once effects.
- A recovered run cannot replay another operation's result; a key reused with a
  different payload is refused.
- Cursor edge cases: `FAILED`, completed/empty workflows, a rewound cursor
  (plain step may repeat; a recorded effect fails safe).
- A job worker that dies holding a lease: nobody takes the job before the lease
  expires; afterwards another worker reclaims it, reconciles, and the effect
  still happens once.
- An export aborted between pages stores no artifact, and a retry yields the same
  file as an uninterrupted export.

## Adding a workflow

Add its steps to `STEPS` (or write a sibling driver) and the matrix grows
automatically. The test `enumerates every crash point` pins the count so the
matrix cannot silently shrink.

## Known limits

`recovery-flow.ts` records an effect in the cursor only after the step finishes.
The cursor alone therefore cannot tell that an effect landed; a crash in that
window is made safe by the checkpoint store, which is why effects must go through
`runWithCheckpoint` (or `SideEffectDispatcher`). A workflow that performs an
external effect without a checkpoint is not protected by this design.
