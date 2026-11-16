import {
  prebuildZenticArtifacts,
  resolveZenticWorktree,
} from "../src/e2e/harness/source-zentic.js";

/**
 * Packs and installs the Zentic source once, before any worker starts.
 *
 * Tests that enroll a daemon call `SourceZentic.start()`, which packs six workspaces and installs
 * the tarballs. Done from inside a test, that work spends the test's own 120s budget, and on a
 * loaded runner it was enough to exhaust it — one arbitrary daemon test timing out per run. Built
 * here it costs nothing that a test is timed against, and every worker inherits the result.
 *
 * Suites that never reach for the source checkout leave `ZENTIC_E2E_WORKTREE` unset; there is
 * nothing to build for them and nothing to fail.
 */
export default async function globalSetup(): Promise<void> {
  if (!process.env["ZENTIC_E2E_WORKTREE"]) return;
  await prebuildZenticArtifacts(resolveZenticWorktree());
}
