import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubBundle, HubBundleError } from "./bundle.js";
import { compiledConfigurationHash } from "./compiler.js";

const hub = `
environments:
  zentic:
    kind: daemon
    daemon: local
    cwd: /workspace/zentic
  hub:
    kind: daemon
    daemon: local
    cwd: /workspace/hub
agents:
  codex-safe:
    provider: codex
    model: gpt-5.5
    options:
      sandbox_workspace_write:
        writable_roots: [/var/cache/npm]
        network_access: false
  claude:
    provider: claude
    mode: ultracode
`;

const workflow = `
name: route-request
on: manual.run
max_runtime: 1h
inputs:
  repo:
    type: string
    required: true
    choices: [zentic, hub]
  agent:
    type: string
    required: true
    choices: [codex-safe, claude]
steps:
  - id: work
    environment: \${{ zentic.inputs.repo }}
    max_runtime: 30m
    idle_timeout: 5m
    agent: \${{ zentic.inputs.agent }}
    prompt:
      - include: partials/shared.md
      - text: "Request: \${{ zentic.prompt }}"
`;

function canonicalFiles() {
  return [
    { path: ".zentic/workflows/route.yml", content: workflow },
    { path: ".zentic/workflows/partials/shared.md", content: "Keep context exact." },
    { path: ".zentic/hub.yml", content: hub },
  ];
}

function filesWithWorkflow(content: string) {
  const files = canonicalFiles();
  const index = files.findIndex(({ path }) => path.endsWith("route.yml"));
  const current = files[index];
  if (current === undefined) throw new Error("canonical workflow fixture is missing");
  files[index] = { path: current.path, content };
  return files;
}

function filesWithHub(content: string) {
  const files = canonicalFiles();
  const index = files.findIndex(({ path }) => path === ".zentic/hub.yml");
  const current = files[index];
  if (current === undefined) throw new Error("canonical Hub fixture is missing");
  files[index] = { path: current.path, content };
  return files;
}

function hasBundleIssue(error: unknown, path: string, message: RegExp): boolean {
  if (!(error instanceof HubBundleError)) return false;
  const found = error.issues.find((entry) => entry.path.join(".") === path);
  return found !== undefined && message.test(found.message);
}

describe("Hub configuration bundle", () => {
  it("accepts an optional project name as slug-validated deployment metadata", () => {
    const bundle = compileHubBundle(filesWithHub(`name: agent-tools\n${hub}`));

    assert.equal(bundle.name, "agent-tools");
    assert.equal(Object.hasOwn(bundle.configuration, "name"), false);
  });

  it.each(["Agent Tools", "agent_tools", "-agent-tools", "agent--tools", "a".repeat(101)])(
    "rejects invalid project name %s with a structured field issue",
    (name) => {
      assert.throws(
        () => compileHubBundle(filesWithHub(`name: ${name}\n${hub}`)),
        (error) =>
          hasBundleIssue(
            error,
            ".zentic/hub.yml.name",
            /lowercase letters, numbers, and single hyphens|too big/iu,
          ),
      );
    },
  );

  it("compiles canonical files with provenance and complete finite named resources", () => {
    const bundle = compileHubBundle(canonicalFiles());
    const trigger = bundle.configuration.triggers[0]!;
    const step = trigger.steps[0]!;

    assert.deepEqual(
      bundle.configuration.environments.map(({ name }) => name),
      ["hub", "zentic"],
    );
    assert.equal(trigger.sourceFile, ".zentic/workflows/route.yml");
    assert.equal(step.environment, "${{ zentic.inputs.repo }}");
    assert.ok("selector" in step.agent);
    if (!("selector" in step.agent)) return;
    assert.equal(step.agent.selector, "${{ zentic.inputs.agent }}");
    assert.deepEqual(Object.keys(step.agent.choices), ["claude", "codex-safe"]);
    assert.deepEqual(step.agent.choices["codex-safe"]?.options, {
      sandbox_workspace_write: {
        writable_roots: ["/var/cache/npm"],
        network_access: false,
      },
    });
    assert.deepEqual(step.prompt[0], {
      kind: "partial",
      path: ".zentic/workflows/partials/shared.md",
      content: "Keep context exact.",
      contentHash: "4d64ca5298d18aaf016856e6579d80ec097e276c0acf1fa061689b0643844b8d",
    });
  });

  it("rejects monolithic triggers with a direct migration error", () => {
    assert.throws(
      () => compileHubBundle([{ path: ".zentic/hub.yml", content: `${hub}\ntriggers: []\n` }]),
      (error) =>
        hasBundleIssue(
          error,
          ".zentic/hub.yml.triggers",
          /move each trigger to \.zentic\/workflows\/<workflow>\.yml/iu,
        ),
    );
  });

  it("rejects a resource document without a direct workflow document", () => {
    assert.throws(
      () => compileHubBundle([{ path: ".zentic/hub.yml", content: hub }]),
      (error) =>
        hasBundleIssue(
          error,
          ".zentic/workflows",
          /at least one direct \.zentic\/workflows\/<workflow>\.yml/iu,
        ),
    );
  });

  it("rejects unknown, non-finite, and object-valued dynamic authority", () => {
    const cases = [
      {
        source: workflow.replace("choices: [zentic, hub]", "choices: [zentic, missing]"),
        expected: /environment choice missing is not a configured environment/iu,
      },
      {
        source: workflow.replace("    choices: [codex-safe, claude]", ""),
        expected: /agent.*finite choices/iu,
      },
      {
        source: workflow.replace(
          "agent: ${{ zentic.inputs.agent }}",
          "agent:\n      provider: ${{ zentic.inputs.agent }}",
        ),
        expected: /dynamic inline agent configurations are not allowed/iu,
      },
    ];

    for (const { source, expected } of cases) {
      assert.throws(() => compileHubBundle(filesWithWorkflow(source)), expected);
    }
  });

  it("orders discovered workflows and hashes authored bundles deterministically", () => {
    const second = workflow.replace("route-request", "another-request");
    const left = compileHubBundle([
      ...canonicalFiles(),
      { path: ".zentic/workflows/a.yml", content: second },
    ]);
    const right = compileHubBundle([
      { path: ".zentic/workflows/a.yml", content: second },
      ...canonicalFiles().toReversed(),
    ]);

    assert.deepEqual(
      left.configuration.triggers.map(({ name }) => name),
      ["another-request", "route-request"],
    );
    assert.equal(left.authoredHash, right.authoredHash);
    assert.equal(
      compiledConfigurationHash(left.configuration),
      compiledConfigurationHash(right.configuration),
    );
  });

  it("rejects duplicate workflow names with both source files in the diagnostic", () => {
    assert.throws(
      () =>
        compileHubBundle([
          ...canonicalFiles(),
          { path: ".zentic/workflows/duplicate.yml", content: workflow },
        ]),
      (error) =>
        hasBundleIssue(
          error,
          ".zentic/workflows/route.yml.name",
          /\.zentic\/workflows\/duplicate\.yml/u,
        ),
    );
  });

  it("locates malformed workflow and named environment fields in their authored files", () => {
    const malformedWorkflow = workflow.replace("name: route-request\n", "");
    assert.throws(
      () => compileHubBundle(filesWithWorkflow(malformedWorkflow)),
      (error) =>
        hasBundleIssue(error, ".zentic/workflows/route.yml.name", /expected.*string|required/iu),
    );

    const malformedEnvironment = hub.replace("    cwd: /workspace/zentic\n", "");
    assert.throws(
      () => compileHubBundle(filesWithHub(malformedEnvironment)),
      (error) =>
        hasBundleIssue(
          error,
          ".zentic/hub.yml.environments.zentic.cwd",
          /expected.*string|required/iu,
        ),
    );
  });

  it("attributes malformed expressions to their conceptual authored workflow field", () => {
    const malformedExpression = workflow.replace(
      "    agent: ${{ zentic.inputs.agent }}",
      "    agent: ${{ zentic.inputs.agent + }}",
    );
    assert.throws(
      () => compileHubBundle(filesWithWorkflow(malformedExpression)),
      (error) =>
        hasBundleIssue(
          error,
          ".zentic/workflows/route.yml.steps.work.agent",
          /expression|unexpected|expected/iu,
        ),
    );
  });

  it("attributes unsupported worktree expressions to the exact Hub source field", () => {
    const unsupported = hub.replace(
      "    cwd: /workspace/zentic",
      '    cwd: /workspace/zentic\n    worktree:\n      mode: branch-off\n      newBranch: "trigger-${{ zentic.event.github.delivery_id }}"',
    );
    assert.throws(
      () => compileHubBundle(filesWithHub(unsupported)),
      (error) =>
        hasBundleIssue(
          error,
          ".zentic/hub.yml.environments.zentic.worktree.newBranch",
          /unsupported path zentic\.event\.github\.delivery_id/iu,
        ),
    );
  });

  it("rejects unreferenced partial files by their authored path", () => {
    assert.throws(
      () =>
        compileHubBundle([
          ...canonicalFiles(),
          {
            path: ".zentic/workflows/partials/orphan.md",
            content: "Never silently injected.",
          },
        ]),
      (error) => hasBundleIssue(error, ".zentic/workflows/partials/orphan.md", /not referenced/iu),
    );
  });

  it.each([
    [".zentic/hub.toml", "TOML is not accepted"],
    [".zentic/workflows/nested/run.yml", "direct child"],
    [".zentic/workflows/run.yaml", "must use the .yml extension"],
    [".zentic/workflows/partials/safety.txt", "must use the .md extension"],
    ["../hub.yml", "unsafe bundle path"],
  ])("rejects non-canonical bundle path %s", (path, message) => {
    assert.throws(
      () => compileHubBundle([...canonicalFiles(), { path, content: "name: ignored" }]),
      new RegExp(message, "iu"),
    );
  });
});
