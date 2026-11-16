import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { packageZenticArtifacts } from "./source-zentic.js";

/**
 * Packing the source workspaces is the most expensive thing the hub e2e harness does, and it
 * runs from `beforeEach`. These assertions are about the sharing, not the packing: a missing
 * checkout fails fast, which is all the identity checks need.
 */
describe("packaged source artifacts", () => {
  it("builds one tree per source checkout, however many daemons ask for it", () => {
    const first = packageZenticArtifacts("/nonexistent/zentic-checkout");
    const second = packageZenticArtifacts("/nonexistent/zentic-checkout");

    assert.equal(first, second, "a second start must wait on the first build, not begin another");
    return Promise.allSettled([first, second]);
  });

  it("keeps separate checkouts apart", () => {
    const one = packageZenticArtifacts("/nonexistent/zentic-one");
    const other = packageZenticArtifacts("/nonexistent/zentic-other");

    assert.notEqual(one, other);
    return Promise.allSettled([one, other]);
  });

  it("reports the same failure to every caller rather than retrying a checkout that cannot pack", async () => {
    const failures = await Promise.allSettled([
      packageZenticArtifacts("/nonexistent/zentic-unpackable"),
      packageZenticArtifacts("/nonexistent/zentic-unpackable"),
    ]);

    assert.deepEqual(
      failures.map((result) => result.status),
      ["rejected", "rejected"],
    );
  });
});
