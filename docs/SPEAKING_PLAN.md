# Remove the skill system; speaking progress and a speaking mode

## Context

After FSRS (`docs/FSRS_PLAN.md`) and optional Daily speaking (4e3b984), the skill system (`src/modules/skill-verification/`) no longer earns its cost:

- **Spelling** evidence comes only from `meaning_recall` / `spelling_repair`. FSRS grades these same answers (miss → Again, help → Hard). An open spelling issue is a recent lapse under another name.
- **Listening** evidence comes mostly from audio-prompt `select gloss`. A miss there cannot tell "did not hear it" from "forgot the meaning". This is the same ambiguity that kept speaking out of FSRS (DECISIONS "Daily speaking"), yet listening feeds both FSRS and a skill issue. Audio prompts stay as a way to ask about memory (×1.2 in FSRS), as Memrise does.
- **Speaking** is the only thing FSRS does not measure. It keeps its own state, but as a small per-pronunciation table, not an evidence log with issues, a 12 h recovery and `pendingConfirm`.

Target design (agreed in chat):
1. Drop the skill system (`skill_evidence`, statuses, issues, skill changes, `skillGapBoost`).
2. Weak and `needPracticeWords` are memory-only and share one SQL definition.
3. Add `user_speaking_progress`: one row per (user, pronunciation), updated at commit. It has two grading tracks: on-device (pass/fail) and Azure (score).
4. Add a `speaking_practice` mode built on that table. Daily speaking (4e3b984) stays as it is and also updates the table.

## 1. Speaking progress (pure)

New `src/modules/speaking/speaking-progress.ts`, with no Nest or Drizzle imports.

- **One result per pronunciation per session.** Take the first recording task of that pronunciation, by task ordinal. Skip a task when:
  - its phase is `new_practice` (the word was just modelled on the Learn card), or
  - its outcome is `invalid` or `unavailable`.
- **On-device** (`transcribed` events): it passes only if the **first** take passed. The evaluator keeps the last take, so this needs `attemptCount === 1 && outcome === assessed_passed`. A pass after retries counts as a miss, so retrying until a pass cannot build a streak.
  - `device_streak` = consecutive passing sessions; any miss resets it to 0.
  - Fluent when `device_streak >= POLICY.speaking.deviceFluentStreak` (2). Because each session contributes one result, a streak of 2 always spans 2 different sessions.
  - A miss while fluent → practicing.
- **Azure** (`assessed` events): the score is that of the task's **first valid receipt** (earliest `assessed_at`), not the receipt the learner accepted. Learners may assess many times and keep the best. `loadSession` already reads every unconsumed receipt of the session, so this needs no extra query.
  - `score_avg = scored_sessions === 0 ? score : score_avg + α × (score − score_avg)`, with α = `POLICY.speaking.scoreAlpha` (0.4).
  - Fluent when `score_avg >= fluentScore` (85) and `scored_sessions >= minScoredSessions` (2).
  - Back to practicing when `score_avg < slipScore` (75). Between the two thresholds the status stays as it was (hysteresis), so a word does not flip on every 79/81.
- **Both tracks:** a row keeps both tracks. The method of the current session's result decides the new status.
- The function signature is `applySpeaking(prev: SpeakingState | null, result: SpeakingResult): { next: SpeakingState; change: 'became_fluent' | 'slipped' | null }`.
- Unit tests:
  - streak across sessions
  - pass after retry
  - EWMA and hysteresis
  - first receipt used, not the accepted one
  - new-word, invalid and unavailable results skipped
  - switching method between sessions

`POLICY.speaking` [TRIAL]: `{ deviceFluentStreak: 2, scoreAlpha: 0.4, fluentScore: 85, slipScore: 75, minScoredSessions: 2 }`.
`SPEAKING_STATUS` in `domain.ts`: `{ NOT_TRIED: 'not_tried', PRACTICING: 'practicing', FLUENT: 'fluent' }`. `not_tried` means there is no row; it is never stored.

## 2. Schema: migration `0024_speaking_progress.sql`

```sql
CREATE TABLE user_speaking_progress (
  user_id uuid NOT NULL REFERENCES app_user(id),
  pronunciation_id uuid NOT NULL REFERENCES pronunciations(id),
  status varchar(12) NOT NULL CHECK (status IN ('practicing','fluent')),
  device_sessions int NOT NULL DEFAULT 0, device_streak smallint NOT NULL DEFAULT 0,
  scored_sessions int NOT NULL DEFAULT 0, score_avg numeric(5,2), last_score numeric(5,2), best_score numeric(5,2),
  last_passed boolean NOT NULL, last_assessed_at timestamptz NOT NULL, fluent_at timestamptz,
  PRIMARY KEY (user_id, pronunciation_id),
  CHECK ((scored_sessions = 0) = (score_avg IS NULL)),
  CHECK ((status = 'fluent') = (fluent_at IS NOT NULL))
);
-- Speaking mode order: weakest first.
CREATE INDEX idx_speaking_user_due ON user_speaking_progress (user_id, status, last_passed, last_assessed_at);
DROP TABLE skill_evidence;
```

- Mirror the table in `src/db/schema.ts` and `spec/001_initial_schema_v0.4_FULL_SPEC_PROPOSED.sql`. Remove `skill_evidence` from both. `test/schema.test.ts` must pass.
- Add the migration to `drizzle/meta/_journal.json` (idx 24).
- **No backfill.** Old speaking evidence has no first-take or first-receipt information, and there is little data (as with 0019). If needed, export `skill_evidence` before deploying.
- `maintenance.repository.ts:22`: consumed receipts no longer have a referencing table, so they can be purged with expired ones. Update the comment at `:28`.
- `account-deletion.repository.ts`: delete `userSpeakingProgress` instead of `skillEvidence`.

## 3. Commit

- `commit.repository.ts` `loadSession`:
  - Drop the `evidence` column and `SKILL_SUMMARY_MODES`.
  - Add `speaking`: the `user_speaking_progress` rows for `planPronunciations`, read `FOR UPDATE`, in the same statement.
  - Receipts are already loaded.
- `writeCommit`:
  - Replace the `evidence` CTE with an upsert `speaking` CTE: `INSERT ... SELECT FROM jsonb_to_recordset(p.d->'speaking') ON CONFLICT (user_id, pronunciation_id) DO UPDATE SET` every column from `EXCLUDED`.
  - Still one statement.
  - Guard: when there is no row, the CTE inserts nothing (no `values([])`).
- `commit.service.ts`:
  - Drop `evidenceDrafts`, `drafts`, `skillChanges` and the `before` map.
  - Build speaking results from `counted` + receipts.
  - Apply `applySpeaking` per pronunciation, pass the rows into `write`, and collect changes for the summary.
- `commit-evaluator.ts`:
  - Delete `EvidenceRowDraft` and `evidenceDrafts`.
  - Add `speakingResults(counted, targets, receipts)`. It is pure and lives next to `memoryDrafts`.
- `needPractice` before/after (Random, Weak) stays, using the new SQL from §5. `settleNeedPractice` is unchanged apart from the import.

## 4. Result summary (`result-summary.ts`)

- **Delete** `skillChanges`, `ChangeItem`, `statefulRows`, `RANK`, and the `openIssue` / `isCleanPass` / `deriveSkillStatus` imports.
- **`practiceSummary`** groups per counted task target instead of per evidence row:
  - `clean` = correct on the first try, no hint, not primed.
  - `helped` = correct with a hint, retry or priming.
  - `missed` = wrong or revealed.
  - A recording uses `assessed_passed` / `assessed_failed`.
  - `excluded` keeps only `invalid_recording` and `unavailable`.
  - `PItem` keeps `skill` (from `skillOf`, a task-type label, may be null) and drops `hadIssue`.
- **New block `speaking`** in every mode that had a scored recording, otherwise `null`:
  - `{ total, passed, becameFluent: [SItem], slipped: [SItem] }`
  - `SItem` = Item + `status` + `score` (null on-device).
  - In Daily it sits next to `review` and `newWords`.
- `struggledAt` and `skillOf` stay. Move `skillOf` to `src/modules/practice-resolver/task-skill.ts`. Random `skills` and `struggledAt` still use it as a task-type label.
- `result.summary` stats:
  - Random/Weak: `{practiceTotal, practiceClean, needPracticeAfter}`, without `leveledUp`.
  - Add `{speakingTotal, speakingPassed}` where the `speaking` block is present.

## 5. Weak and `needPracticeWords`: one definition

New `src/modules/review-load/repositories/weak-scope.sql.ts` with `weakMeaningsSql(userId, since)`. It returns learned, reviewable Meanings where, within the window:
- there are at least `POLICY.weak.minAttempts` observations,
- at least one observation is weak (`signal NOT IN (unaided_recall, recognition_success)`),
- **the latest observation is weak**, so a clean answer afterwards clears the word.

Observations from the session that learned the word are excluded, as today.

- Without the last condition, "11 → 11" would show after every Weak session until the 30-day window rolls over.
- There is no 12 h wait: FSRS already spaces the reviews. This is what lets `pendingConfirm` go.

Users:
- `planner.repository.ts` `weakTargets`:
  - Drop `open_issue`, the `skills` column and the `skill_evidence` subquery in `ORDER BY`.
  - Select from `weakMeaningsSql`, ordered by weak ratio, then `last_reviewed_at NULLS FIRST`.
- `needPracticeWordsSql` (move it here) = `count(DISTINCT word_id)` over `weakMeaningsSql`. It is still a scalar subquery, so `writeCommit` sees the pre-write rows.
- Word detail `needsPractice` per Meaning = `EXISTS` in `weakMeaningsSql`, computed inside `wordMeanings`'s statement.
- `since` = `now − POLICY.weak.lookbackDays`. Every caller passes `now` from `Clock`.

## 6. Planner

- `plan-builder.ts`:
  - Delete `taskForSkill`, `focusedTasks` and `skillGaps` / `focusSkills` in `PlanInput`.
  - `dailyCandidates` weights only by `classPickWeight`.
  - Remove `skillGapBoost` from `POLICY.review` and `recoveryHours` from `POLICY.memory`.
- `planner.repository.ts` `dueTargets`: drop the `open_issue` CTE and `skillGaps`.
- `planner.service.ts`: drop `skillGaps` and `focusSkills`. Random `skills` stays as a task filter (`skillFilter`, `skillTasks`).
- **New mode `SESSION_MODE.SPEAKING_PRACTICE: 'speaking_practice'`** (+ `TASK_PHASE.SPEAKING_PRACTICE`):
  - `capabilities.microphone=false` gives an empty plan, like a Random skill the device cannot train.
  - `speakingTargets(userId, locale, limit)`, one query:
    - learned, reviewable Meanings whose default-accent pronunciation can build a recording, left-joined to `user_speaking_progress`;
    - order: practicing with `last_passed = false` → not tried (no row) → practicing → fluent; then `last_assessed_at NULLS FIRST`, then `meaning_id`;
    - `LIMIT POLICY.practice.speakingTaskCap` (10).
  - One `buildRecording(target, ctx, { meaningCue: true })` per target. No FSRS change (recordings carry no memory evidence) and no `needPractice`.
  - Add the mode to the plan request enum. Like `weak_words_practice`, it takes no `skills` and no `filter`.

## 7. Progress API

- `progress.service.ts` / `progress.repository.ts`:
  - Drop `evidence()`, `EvidenceQueryRow`, `stateOf` and `indexEvidence`.
  - `wordMeanings` left-joins `user_speaking_progress` on the default-accent pronunciation (same statement).
  - Each Meaning:
    - `memory` unchanged;
    - **`speaking: { status, lastScore, bestScore, lastAssessedAt } | null`**, null when there is no pronunciation;
    - `needsPractice` per §5.
  - **`skills` is removed.**
- `wordStats` → `{ learnedWords, needPracticeWords, fluentWords }`. `fluentWords` comes from the same statement.

## 8. Delete

- `src/modules/skill-verification/` (all three files).
- In `domain.ts`:
  - delete `SKILL_STATUS`, `SKILL_ISSUE`, `SKILL_CHANGE(S)`;
  - delete the `EVIDENCE_REASON` values that are no longer used. Keep only those `practiceSummary.excluded` reports, renamed if needed.
  - `SKILL` / `SKILLS` stay, for Random filters and `struggledAt`.

## 9. Tests

- Delete `skill-evidence.spec.ts`.
- Rewrite:
  - the skill-change and practice cases in `result-summary.spec.ts`;
  - `test/skill-practice.test.ts`: Random skills only, no issue/clear flow.
- Update:
  - `test/session-summary.test.ts`;
  - `test/api.test.ts` (28 references);
  - `test/challenge.test.ts`, `test/placement.test.ts`: "writes no skill evidence" becomes "writes no speaking progress";
  - `test/account-deletion.test.ts`.
- New integration tests:
  - Speaking mode, one plan → commit:
    - the row is created;
    - fluent is reached after 2 passing sessions;
    - an Azure first receipt is used rather than the accepted one;
    - a miss slips the word back.
  - Daily with speaking on updates the table; new-word recordings do not.
  - `needPracticeWords` falls after a clean Weak answer and matches the Weak target count.
  - Query count at 1 vs 20 Meanings for the speaking plan, its commit and the word detail.

## 10. Docs

- `docs/DECISIONS.md`: new section "Skill system removed". It supersedes the skill rows of "FSRS and weighted evidence" and the "Speaking skill" row of "Daily speaking". It records:
  - why spelling and listening were dropped;
  - the two fluent tracks and their thresholds;
  - Weak/needPractice clearing on the latest observation;
  - no backfill.
- `docs/FRONTEND_FLOW.md`: word detail (§ around :168), `words/stats`, the mode table (:196), §15.3 results, the new `speaking` block, the speaking mode, and the Weak description (no "kỹ năng có issue").
- Spec md: mark the four-skill verification as superseded.

## iOS changes (breaking)

| Removed / changed | Replacement |
| --- | --- |
| `GET /words/{id}` → `meanings[].skills` | `meanings[].speaking` |
| `needsPractice` meaning | Memory-weak (§5), not a skill issue |
| `summary.skillChanges` | `summary.speaking.becameFluent / slipped` |
| `PItem.hadIssue`; practice counted per evidence row | Counted per task target |
| — | `mode: "speaking_practice"`, `words/stats.fluentWords` |

Transition: for one release, send `skills: null` and `skillChanges: null` instead of dropping the keys, as was done for the old summary numbers.

## Open questions

1. Does `speaking_practice` earn `extra_practice_completed` LP like Random/Weak?
2. Are the defaults right: on-device pass = first take only; Azure score = first valid receipt?
3. Is it OK that Weak and `needPractice` clear on the latest clean observation, with no 12 h wait?
