# FSRS + weighted evidence, Daily without skill tasks, form-only skills

## Context

Session `01a1dcc8-…b0b8`: the learner answered all 5 due words correctly, yet the result showed 3/5 remembered. Two words got only `cloze_select` (recognition). Recognition success never counts as solid and only grants a one-off 24 h grace. "bargain" had already used its grace, so its schedule did not move and it stays due forever.

Root causes:
- The scheduler (`src/modules/memory-srs/srs.ts`) splits answers into recall vs recognition. Most templates in this Duolingo-style app are not typing.
- The planner picks templates at random, with no regard for what moves memory.
- The skill system runs a second memory model in parallel: reading/writing duplicate meaning memory, and the "2 sessions, 24 h" rule duplicates spacing. Daily review also gets bonus skill tasks.

Target design (agreed in chat):
1. **FSRS-6 is the only memory model** (meaning). It decides *when* and *which word*.
2. **Every task carries an evidence weight by evidence class.** Templates of the same nature share a class: `match` is the same class as `select`.
3. **Daily review = exactly one meaning task per due word**, with no skill bonus tasks.
4. **Skills are form-only** (listening, speaking, spelling). They decide *which template*, not when.
5. **Result screen groups by correctness, not by weight.** Clean answers are remembered (solid); helped/retried/primed answers are shaky; wrong answers are relearn.
6. **Existing progress is converted directly** from `interval_hours` / `lapse_count`.

## 1. Evidence classes and weights (pure)

- `src/common/constants/domain.ts`
  - Add `EVIDENCE_CLASS`:

    | Class | Value | Variants |
    |---|---|---|
    | `RECALL_PRODUCE` | `recall_produce` | `typing` meaning_recall |
    | `RECALL_ASSEMBLED` | `recall_assembled` | `fly_reorder` spelling_recall |
    | `RECOGNIZE_CONTEXT` | `recognize_context` | `cloze_select` single_blank, context_meaning |
    | `RECOGNIZE` | `recognize` | `select` gloss, reverse_gloss, meaning_clash · `match` meaning_pairs, word_pairs |

  - Add `CLASS_BY_VARIANT`, next to `INTENT_BY_VARIANT` in `src/modules/practice-resolver/curated.ts:38`. Variants with no class carry no meaning evidence: phonetic/stress choice, transcription, fix_spelling, recording.
  - Add `FSRS_GRADE = { AGAIN: 'again', HARD: 'hard', GOOD: 'good', EASY: 'easy' }`.
- `src/config/policy.ts`: add `memoryEvidence`.
  - `weights`: { recall_produce: 1.0, recall_assembled: 0.7, recognize_context: 0.4, recognize: 0.3 }
  - `audioFactor`: 1.2 (capped at the next class up)
  - `baseOptionCount`: 4
- New `src/modules/memory-srs/evidence-weight.ts`:
  - `answerWeight({ variant, optionCount, promptIsTargetAudio })` = w × (1 − 1/n) / (1 − 1/4) × audio factor.
  - `combineWeights(ws)` = 1 − Π(1 − wᵢ), capped at 1.
- `optionCount` source at commit: `clientPayload.options.length` for select/cloze, `pairs.left.length` for match. `TaskRow` already holds `clientPayload`, read by `commit-evaluator.ts:66`.
  - Match approximation: every pair uses the full pair count, because the solve order is not stored.

## 2. FSRS core (pure, no Nest/Drizzle)

- New `src/modules/memory-srs/fsrs.ts`. Own FSRS-6 formulas, so the weighted update is possible:
  - `retrievability(elapsedDays, S)`, `intervalDays(S, desiredRetention)`
  - `initialState(outcome, at)`: S0 by grade. A clean success interpolates S0(Hard)→S0(Good) by W.
  - `knownState(at)`: S = `knownInitialDays`, D = D0(Easy).
  - `applyReview(state, outcome, at)`:
    - same-day reviews use the short-term formula
    - success: S' = S·(1 + W·(SInc_good − 1)), with the D update scaled by W
    - Hard: hard-penalty recall formula
    - Again: post-lapse stability, lapse + 1
  - `next_review_at` = at + clamp(interval, `minIntervalHours`, `maxIntervalDays`).
- `src/config/policy.ts`: replace `POLICY.srs` with `POLICY.fsrs`.
  - `w`: the 21 FSRS-6 defaults, copied from `ts-fsrs` at implementation time
  - `desiredRetention`: 0.9
  - `maxIntervalDays`: 90
  - `minIntervalHours`: 12
  - `knownInitialDays`: 7, replacing `newLearning.knownInitialHours`
- Add `ts-fsrs` as a **devDependency only**. The parity spec checks that `applyReview` with W = 1 / Hard / Again matches `ts-fsrs` for the same params.
- Delete `srs.ts` (`applyDailyDue`, `applyNonDaily`, grace logic). One `applyReview` serves every mode, since FSRS handles early reviews itself.
- `SrsState` becomes { learnedAt, lastReviewedAt, nextReviewAt, stability, difficulty, lapseCount }.
- `SCHEDULER_VERSION` = `'fsrs6-weighted-v1'` (`domain.ts:301`).

## 3. Reducer → outcome

- `src/modules/memory-srs/memory-reducer.ts`
  - Keep `signalOf` / `reduceMemory` and the `signal` column. Journey `reviewCounts` and weak ranking (`planner.repository.ts:218`) still read it.
  - Add to `MemoryDraft`: `grade` and `weight`.
    - `FAILED_*` → AGAIN
    - `ASSISTED_RECALL` or primed → HARD
    - `UNAIDED_RECALL` / `RECOGNITION_SUCCESS` → GOOD with W = `combineWeights` of the clean answers
    - W = 0 (only classless tasks) → no review
  - `MemoryFact` gains `variant`, `optionCount` and `promptIsTargetAudio`, filled in `commit-evaluator.ts:151-166`.
- `src/modules/session-commit/services/commit.service.ts:177-195` `applySrs`:
  - New words → `initialState` / `knownState`. Keep the known/declaredKnown/slip rules exactly.
  - Existing words → `applyReview` in every mode.
  - A null grade leaves the state untouched, including `last_reviewed_at`.

## 3b. Easy grade from response time

Session commit records no timing today. `eventSchema` in `src/modules/practice-evaluator/events.ts:8` has only `seq`.

- **Client (API change):** each event gets an optional `elapsedMs`, the ms since the task was shown. This follows the `elapsedMs` already used by the Challenge Map (`src/modules/challenge/domain/match-madness.ts:40`).
- **Validation:** non-decreasing across a task's events, capped at a policy max.
- **Recording:** the evaluator (`src/modules/practice-evaluator/evaluate.ts` `tallyAttempts`) records `firstSubmitMs` for each target. It is kept in `result.tasks` for calibration.
- **Easy rule:** all of:
  - a clean first try
  - class `recall_produce` or `recall_assembled` (recognition is never Easy)
  - `firstSubmitMs` ≤ threshold
  - unprimed
- **Thresholds** in `POLICY.memoryEvidence.easy` (TRIAL):
  - typing: `baseMs + perCharMs × answer length`
  - fly_reorder: `baseMs + perTileMs × tiles`
- **Effect:** grade EASY, applied with FSRS's easy bonus. If `elapsedMs` is missing, Easy is never given, so older clients keep working.
- `memory_observations.grade` can be `'easy'`.
- **Risk:** the time is client-reported. Easy only lengthens the learner's own intervals, and LP does not read it, so gaming it gains nothing.
- **Later:** switch to speed relative to the learner's own median, once enough timing data exists.

## 4. Result summary, LP

- `src/modules/session-commit/domain/result-summary.ts`
  - `reviewGroupOf`: correctness-based.
    - solid: unaided-unprimed recall **or** recognition success
    - shaky: assisted or primed
    - relearn: failed
    - Drop the `RECOGNIZED_ONLY` cause from review. Keep the constant only if still used elsewhere.
  - `countedAsReview`: pre-commit due + grade GOOD + unprimed.
  - Remove the comment that ties groups to the SRS branch.
- LP (`src/modules/learning-points/domain/lp-awards.ts`): unchanged. It reads only the pre-commit `nextReviewAt`.

## 5. DB migration `drizzle/0019_fsrs_form_skills.sql`

Add it to `_journal.json` and mirror it in `spec/001_initial_schema_v0.4_FULL_SPEC_PROPOSED.sql` and `src/db/schema.ts`.

**`user_meaning_progress`**
- Add `stability numeric(12,4) NOT NULL CHECK (> 0)` and `difficulty numeric(6,4) NOT NULL CHECK (BETWEEN 1 AND 10)`.
- Backfill in one UPDATE:
  - S = greatest(interval_hours/24, 0.1)
  - D = least(10, D0(Good) + lapse_count)
  - scheduler_version = new
- Drop `interval_hours`, `unaided_streak` and `recognition_grace_used`.

**`memory_observations`**
- Add `grade varchar(8) NULL CHECK (grade IN ('again','hard','good','easy'))` and `evidence_weight numeric(4,3) NULL`.

**`skill_evidence`**
- `DELETE WHERE skill = 'reading'`.
- `UPDATE skill = 'spelling' WHERE skill = 'writing'`.
- Replace `skill_evidence_skill_check` and the scope check: spelling → meaning_id; listening/speaking → pronunciation_id.

**Commit write**
- `commit.repository.ts:127-134` (read JSON) and `:200-243` (`jsonb_to_recordset` upsert / observation insert): swap the columns.
- Update `src/seed/seed-polysemy.ts:110-119`.

## 6. Planner

- `src/modules/session-planner/domain/plan-builder.ts:183-202` `reviewTasks`, Daily:
  - exactly one primary per target
  - no `skillBonusChance` bonus
  - `pickWeighted` by `POLICY.review.classPickWeight[class]`, which replaces the flat `semanticWeight` (e.g. recognize 2, recognize_context 2, recall_assembled 1.5, recall_produce 1)
- Bias by form skills: a target with an open listening issue doubles its audio-prompt candidates; an open spelling issue doubles its recall candidates.
- Checkpoint keeps `recallOnly`; Random/Weak keep their skill paths.
- `src/modules/session-planner/repositories/planner.repository.ts:117-145` `dueTargets`: one query, no extra round trip.
  - Select `stability` and `last_reviewed_at`.
  - `ORDER BY` retrievability ascending, computed in SQL from the FSRS decay/factor constants passed as `::float8`, then `meaning_id`.
  - Aggregate open form-skill issues per target in the same statement, reusing `openSkillIssuesSql` (`skill-issue.sql.ts:11`).

## 7. Form-only skills

- `domain.ts:96-117`
  - `SKILL` = { LISTENING, SPEAKING, SPELLING: 'spelling' }
  - `SKILL_STATUS` drops `VERIFIED`, keeping not_verified / demonstrated
  - `SKILL_CHANGE` keeps leveledUp / cleared / pendingConfirm / regressed
- `src/modules/skill-verification/skill-evidence.ts`
  - `skillOf` / `evidenceFor`:
    - recognition with audio → listening
    - recognition with text → null
    - pairing → null
    - meaning_recall → spelling
    - spelling_repair → spelling (keep weak)
    - transcription with audio → listening
    - sound_discrimination → listening (weak)
    - pronunciation → speaking
  - `deriveSkillStatus`: drop the verified rule. Delete `POLICY.skill`.
  - `WordScopes` / `isWordFullyVerified`: remove.
- `skill-issue.sql.ts`, `progress.service.ts:55-85`, `progress.repository.ts`:
  - The word detail returns `skills: { spelling, listening?, speaking? }`.
  - `fullyVerified` is removed.
  - Each meaning gets `memory: { stabilityDays, retrievability, nextReviewAt }`.
- `planner.service.ts:25-26`: `skills` enum loses `reading`. `taskForSkill` (`plan-builder.ts:128`): spelling → fly/typing.
- `result-summary.ts`: `struggledAt` is set only when the task's skill is a form skill. `practiceSummary` / `skillChanges` work unchanged on the new skill set.

## 8. Docs

- `docs/DECISIONS.md`: new section covering:
  - FSRS + evidence classes and weights
  - Daily with one meaning task per word
  - form-only skills
  - correctness-based groups
  - conversion formula
  - It supersedes rows :13–:27 and :106–:119 where they conflict.
- `docs/FRONTEND_FLOW.md`, at the skill table :197-206, word detail :166-172, results :1069-1129 and Random skills :183:
  - new skill keys
  - no `verified` / `fullyVerified`
  - new `memory` block
  - `reading` rejected
  - optional `elapsedMs` on task events
  - **The frontend must ship with this.**
- `spec/Vocab_Flow_Backend_FULL_SPEC_v0.4_2026-10-30.md:736-742,1009-1036,1045`: mark the SRS formulas and the four-skill verification as superseded by DECISIONS.

## Verification

- **Unit:**
  - `fsrs.spec.ts`: parity with `ts-fsrs`, weighted S monotonic in W, same-day path, clamps.
  - `evidence-weight.spec.ts`: classes, option count (n = 2 → lower, n = 1 → 0), audio cap, combine.
  - Easy rule:
    - fast clean typing → EASY
    - slow typing → GOOD
    - fast select → GOOD
    - missing `elapsedMs` → GOOD
    - non-monotonic `elapsedMs` → `INVALID_SUBMISSION`
  - Update `memory-srs.spec.ts`, `result-summary.spec.ts` (all-correct recognition → solid), `skill-evidence.spec.ts`, `resolver.spec.ts:131`.
  - New Daily `reviewTasks` tests in `plan-builder.spec.ts`: one task per target, no recording/transcription, class weights respected.
- **Integration:**
  - Update clock advances that assume 12/24/48/168 h intervals: `api.test.ts:393,421,640-692`, `scope-review.test.ts:306,338` and the rest from the explore map. Assert via `nextReviewAt > now` and stability instead of exact hours where possible.
  - Update `skill-practice.test.ts`: `reading` → 400; spelling path.
  - Update `session-summary.test.ts` (C65, C69–C72).
  - `test/schema.test.ts` must pass against the updated spec SQL.
  - `test/api.test.ts:1062-1101` query counts must stay equal at 1 vs 20 Meanings, with `commit < 8`.
- **Regression for the reported bug:** a new integration test.
  - Daily with 5 due words, every task a correct `cloze_select`.
  - Expect 5 solid.
  - Expect every `nextReviewAt` > now and stability increased.
- **Run:** `pnpm lint && pnpm test && pnpm build`, then `pnpm db:migrate` on a copy of prod data. Check that the backfill gives no NULL or out-of-range S/D.
