/**
 * How many migrations this build expects to find applied.
 *
 * ── Why this is a file of its own ──
 *
 * It lived in the health route, said 9 while twelve existed, and had
 * therefore quietly stopped checking anything: a deployment still
 * running Phase 4's schema would have reported healthy. It was
 * forgotten twice, which is twice more than a number somebody has to
 * remember deserves.
 *
 * It is here rather than in the route so a test can import it without
 * dragging `next/server` into the test runner, and
 * `tests/phase7.test.mjs` counts the files in db/migrations and fails
 * when the two disagree. Bumping it is still manual; forgetting to is
 * no longer silent.
 */
export const EXPECTED_MIGRATIONS = 12;
