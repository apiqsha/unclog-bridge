const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BridgeServerError,
  HOSTED_COMMAND_CONTRACTS,
  HOSTED_LOCAL_ONLY_COMMAND_CONTRACTS,
  HOSTED_REMOVED_COMMAND_CONTRACTS,
  HOSTED_UNSUPPORTED_COMMAND_CONTRACTS,
  MissingAuthError,
  applyHostedLocalArtifactEffects,
  assertHostedProjectLinkEnvelope,
  assertHostedResponseEnvelope,
  assertHostedCommandContract,
  blockedState,
  buildAdapterPrompt,
  callHostedCommand,
  callHostedProjectLink,
  callHostedSessionRevoke,
  connectWithSetupIntent,
  createBridgeClient,
  hostedCommandStatus,
  hostedResponseContract,
  installHostedAdapter,
  logout,
  openHostedApprovalUrl,
  parseHostedCommandArgv,
  reconcilePendingLocalArtifactEffects,
  repositoryIdentity,
  writeHostedOutputFile
} = require("../src/index");
const {
  SessionStorageError,
  clearSession,
  credentialStorageCapabilities,
  loadSession,
  loadSessionReference,
  resolveSessionDir,
  saveSession,
  sessionStorageContract
} = require("../src/session");

const TEST_SESSION_TOKEN = `us_${"A".repeat(43)}`;

function memoryCredentialStore() {
  const records = new Map();
  return {
    set: (key, value) => records.set(key, value),
    get: (key) => records.get(key),
    delete: (key) => records.delete(key)
  };
}

function tempStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "unclog-bridge-"));
}

function artifactHash(document) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
  };
  return require("node:crypto").createHash("sha256").update(JSON.stringify(stable(document))).digest("hex");
}

function localParserCommands() {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const privateParser = path.join(repositoryRoot, "codex-tools", "unclog", "unclog_lib", "cli.py");
  if (!fs.existsSync(privateParser)) return null;
  const script = [
    "import argparse, json, sys",
    "sys.path.insert(0, 'codex-tools/unclog')",
    "from unclog_lib.cli import build_parser",
    "def walk(parser, prefix=()):",
    "    actions=[a for a in parser._actions if isinstance(a, argparse._SubParsersAction)]",
    "    if not actions: return ['.'.join(prefix)] if prefix else []",
    "    return [item for action in actions for name, child in action.choices.items() for item in walk(child, prefix+(name,))]",
    "print(json.dumps(sorted(set(walk(build_parser())))))"
  ].join("\n");
  const candidates = [
    process.env.PYTHON,
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe"),
    "python"
  ].filter(Boolean);
  let result;
  for (const candidate of candidates) {
    result = spawnSync(candidate, ["-c", script], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    if (result.status === 0) break;
  }
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function hostedOk(command, overrides = {}) {
  const localContract = hostedResponseContract(command);
  return {
    allowed: true,
    status: "OK",
    command: localContract.command,
    command_status: hostedCommandStatus(command),
    next_action: {
      code: "HOSTED_COMMAND_AUTHORIZED",
      command: localContract.localCommand,
      gate: localContract.gate,
      required_fields: localContract.requiredFields,
      workflow_gates: localContract.workflowGates
    },
    next: localContract.localCommand,
    commands_now: [localContract.localCommand],
    local_contract: localContract,
    ...overrides
  };
}

test("missing auth blocks bridge commands with a public state", async () => {
  const client = createBridgeClient({
    fetchImpl: async () => {
      throw new Error("fetch should not run without auth");
    },
    sessionOptions: { storageDir: tempStorage() }
  });

  await assert.rejects(
    () => client.command("action.check", { action_id: "A1079" }),
    (error) => {
      assert.equal(error instanceof MissingAuthError, true);
      assert.equal(error.code, "unclog_auth_required");
      assert.equal(error.publicState.blocked, true);
      assert.equal(error.publicState.mobile.primaryAction, "Login");
      return true;
    }
  );
});

test("blocked state copy is compact and mobile safe", () => {
  const state = blockedState("subscription_required");
  const rendered = JSON.stringify(state).toLowerCase();
  assert.equal(state.blocked, true);
  assert.ok(state.title.length <= 24);
  assert.ok(state.message.length <= 96);
  assert.ok(state.mobile.message.length <= 48);
  assert.match(state.primaryAction, /login/i);
  assert.equal(state.billing.provider, "merchant_of_record");
  assert.equal(state.billing.portal_route, "/account/billing");
  assert.equal(state.billing.checkout_route, "/account/billing/checkout");
  assert.doesNotMatch(rendered, /controller|policy_prompt|core_rulebook|full_brain/);
  assert.doesNotMatch(rendered, /lemon|stripe|paddle|trial/);
});

test("session references are outside repos and never persist tokens", () => {
  const storageDir = tempStorage();
  const cwd = path.join(storageDir, "repo");
  const credentialStore = memoryCredentialStore();
  fs.mkdirSync(cwd);

  assert.throws(
    () => resolveSessionDir({ storageDir: path.join(cwd, ".unclog"), cwd }),
    (error) => error instanceof SessionStorageError && error.code === "session_storage_in_repo"
  );

  assert.throws(
    () =>
      saveSession(
        {
          apiBaseUrl: "https://api.unclog.dev",
          deviceSessionId: "device-session-1",
          accessToken: "secret-value"
        },
        TEST_SESSION_TOKEN,
        { storageDir, cwd, credentialStore }
      ),
    (error) => error instanceof SessionStorageError && error.code === "session_secret_rejected"
  );

  saveSession(
    {
      apiBaseUrl: "https://api.unclog.dev/",
      deviceSessionId: "device-session-1",
      projectId: "proj_solo_primary"
    },
    TEST_SESSION_TOKEN,
    { storageDir, cwd, credentialStore }
  );
  const loaded = loadSessionReference({ storageDir, cwd });
  assert.equal(loaded.apiBaseUrl, "https://api.unclog.dev");
  assert.equal(loaded.deviceSessionId, "device-session-1");
  assert.equal(loadSession({ storageDir, cwd, credentialStore }).sessionToken, TEST_SESSION_TOKEN);
  assert.equal(Object.prototype.hasOwnProperty.call(loaded, "accessToken"), false);
  assert.equal(fs.readFileSync(path.join(storageDir, "session.json"), "utf8").includes(TEST_SESSION_TOKEN), false);

  const contract = sessionStorageContract({ storageDir, cwd });
  assert.equal(contract.storesInRepository, false);
  assert.equal(contract.persistedSecretMaterial, false);
  assert.equal(contract.revocableByServer, true);
});

test("session credentials fall back only to a permission-protected file on supported platforms", () => {
  const storageDir = tempStorage();
  const unavailableKeyring = () => { throw new Error("keyring unavailable"); };
  const session = {
    apiBaseUrl: "https://api.unclog.dev",
    deviceSessionId: "device-fallback",
    projectId: "proj_solo_primary"
  };
  const unixOptions = { storageDir, platform: "linux", keyringEntry: unavailableKeyring };
  const saved = saveSession(session, TEST_SESSION_TOKEN, unixOptions);
  assert.equal(saved.credentialStorage, "permission-protected file");
  assert.equal(loadSession(unixOptions).sessionToken, TEST_SESSION_TOKEN);
  assert.equal(fs.readFileSync(saved.path, "utf8").includes(TEST_SESSION_TOKEN), false);
  clearSession(unixOptions);
  assert.equal(loadSessionReference(unixOptions), null);

  assert.throws(
    () => saveSession(
      { ...session, deviceSessionId: "device-no-windows-fallback" },
      TEST_SESSION_TOKEN,
      { storageDir: tempStorage(), platform: "win32", keyringEntry: unavailableKeyring }
    ),
    (error) => error instanceof SessionStorageError && error.code === "session_keyring_unavailable"
  );
});

test("session api endpoints must be HTTPS except explicit loopback dev", async () => {
  const storageDir = tempStorage();
  const credentialStore = memoryCredentialStore();

  assert.throws(
    () =>
      saveSession(
        { apiBaseUrl: "http://api.unclog.dev", deviceSessionId: "device-session-1" },
        TEST_SESSION_TOKEN,
        { storageDir, credentialStore }
      ),
    (error) => error instanceof SessionStorageError && error.code === "session_api_base_url_insecure"
  );

  saveSession(
    { apiBaseUrl: "http://127.0.0.1:8000/", deviceSessionId: "device-session-1" },
    TEST_SESSION_TOKEN,
    { storageDir, allowLocalHttp: true, credentialStore }
  );
  assert.equal(loadSessionReference({ storageDir, allowLocalHttp: true }).apiBaseUrl, "http://127.0.0.1:8000");

  for (const apiBaseUrl of [
    "https://10.0.0.5",
    "https://preview.local",
    "https://example.com",
    "https://api.unclog.dev/test_unclog"
  ]) {
    assert.throws(
      () => saveSession({ apiBaseUrl, deviceSessionId: "device-session-1" }, TEST_SESSION_TOKEN, { storageDir, credentialStore }),
      (error) => error instanceof SessionStorageError && error.code === "session_api_base_url_not_live"
    );
  }

  let fetchCalled = false;
  await assert.rejects(
    () =>
      callHostedCommand({
        command: "action.check",
        payload: {},
        session: { apiBaseUrl: "http://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => {
          fetchCalled = true;
          return { ok: true, json: async () => ({ allowed: true }) };
        }
      }),
    (error) => error instanceof BridgeServerError && error.code === "session_api_base_url_invalid"
  );
  assert.equal(fetchCalled, false);
});

test("authenticated command calls hosted server without local authority", async () => {
  const calls = [];
  const result = await callHostedCommand({
    command: "action.check",
    payload: { action_id: "A1075", proof: "server call only" },
    session: {
      apiBaseUrl: "https://api.unclog.dev",
      sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1",
      projectId: "proj_solo_primary"
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return hostedOk("action.check", { next_project_version: 3 });
        }
      };
    }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.status, "OK");
  assert.equal(result.command, "action.check");
  assert.equal(result.local_contract.gate, "current_action_set");
  assert.ok(result.local_contract.workflowGates.includes("proof_required"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.unclog.dev/v1/bridge/commands");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TEST_SESSION_TOKEN}`);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].init.headers, "x-unclog-device-session"), false);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    command: "action.check",
    payload: { action_id: "A1075", proof: "server call only" },
    project_id: "proj_solo_primary"
  });
});

test("hosted response contracts expose local CLI response gates", () => {
  const actionCheck = hostedResponseContract("action check");
  assert.equal(actionCheck.version, "hosted_local_cli_parity_v1");
  assert.equal(actionCheck.localCommand, "unclog --json action check");
  assert.deepEqual(actionCheck.requiredFields, ["action_id", "file"]);
  assert.ok(actionCheck.responseKeys.includes("next_action"));
  assert.ok(actionCheck.responseKeys.includes("commands_now"));
  assert.ok(actionCheck.responseKeys.includes("recovery"));
  assert.ok(actionCheck.workflowGates.includes("current_action_set"));
  assert.equal(actionCheck.proofRequired, true);

  const actionPlan = createBridgeClient({
    session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-1" }
  }).responseContract("action_plan submit");
  assert.equal(actionPlan.command, "action-plan.submit");
  assert.ok(actionPlan.responseKeys.includes("challenge_prompt"));
  assert.ok(actionPlan.workflowGates.includes("action_plan_audit"));

  assert.deepEqual(hostedResponseContract("action proof-lint").requiredFields, ["action_id", "file"]);
  assert.ok(hostedResponseContract("action revise").workflowGates.includes("proof_audit"));
  assert.deepEqual(hostedResponseContract("set submit").requiredFields, ["summary", "proof", "closeout_sweep_file"]);
  assert.ok(hostedResponseContract("set closeout-lint").responseKeys.includes("submit_command"));
  assert.ok(hostedResponseContract("version").responseKeys.includes("schema_contract_version"));

  const agentPacket = hostedResponseContract("agents packet");
  for (const key of [
    "agent_progress",
    "completion_contract",
    "assigned_goal_lines",
    "assigned_scope",
    "selected_scope_tiny_goal_ids",
    "current_action_set",
    "proof_commands",
    "blockers",
    "worker_files"
  ]) {
    assert.ok(agentPacket.responseKeys.includes(key), key);
  }
  assert.ok(agentPacket.workflowGates.includes("worker_next_action"));
  assert.equal(agentPacket.localExecution, false);

  const managerPacket = hostedResponseContract("packet");
  for (const key of ["goal_progress", "current_scope", "inbox_review", "lane_status", "validation_status", "repair_routes", "next_action"]) {
    assert.ok(managerPacket.responseKeys.includes(key), key);
  }
  assert.ok(managerPacket.workflowGates.includes("manager_phase_context"));
  assert.equal(managerPacket.localExecution, false);

  for (const contract of [agentPacket, managerPacket]) {
    const rendered = JSON.stringify(contract).toLowerCase();
    assert.ok(rendered.length < 1800, contract.command);
    assert.doesNotMatch(rendered, /full_ledger|full-ledger|raw_database|raw-database|repository_archive|source_code|raw_patch/);
  }
});

test("bridge only forwards hosted command contract names", async () => {
  const client = createBridgeClient({
    session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-1" }
  });
  assert.deepEqual(client.supportedCommands(), [...HOSTED_COMMAND_CONTRACTS].sort());
  for (const command of client.supportedCommands()) {
    const contract = hostedResponseContract(command);
    assert.equal(assertHostedCommandContract(command), command);
    assert.equal(contract.command, command);
    assert.ok(contract.responseKeys.includes("next_action"), command);
    assert.ok(contract.responseKeys.includes("recovery"), command);
  }

  for (const command of [
    "mission.create",
    "mission.status",
    "goals.lock",
    "goals.patch-template",
    "agents.packet",
    "agents.note",
    "agents.unblock",
    "agents.runtime.schedule",
    "agents.runtime.interrupt",
    "agents.runtime.stop",
    "agents.runtime.resume",
    "agents.runtime.replace",
    "action-plan.review-template",
    "action-plan.add-tiny",
    "action.proof-template",
    "action.proof-lint",
    "action.proof-repair-json",
    "action.revise",
    "set.closeout-template",
    "set.closeout-lint",
    "set.summary-context",
    "set.revise-template",
    "inbox.capture",
    "inbox.link",
    "drafts.list",
    "packet",
    "brief",
    "why",
    "recover",
    "version"
  ]) {
    assert.equal(HOSTED_COMMAND_CONTRACTS.has(command), true, command);
  }
  assert.equal(HOSTED_UNSUPPORTED_COMMAND_CONTRACTS.has("mission.delete"), true);
  assert.equal(HOSTED_UNSUPPORTED_COMMAND_CONTRACTS.has("agents.runtime.set"), true);
  assert.equal(HOSTED_UNSUPPORTED_COMMAND_CONTRACTS.has("social.post"), true);
  assert.equal(assertHostedCommandContract("action check"), "action.check");
  assert.equal(assertHostedCommandContract("action-plan export"), "action-plan.export");
  assert.equal(assertHostedCommandContract("action_plan submit"), "action-plan.submit");
  assert.equal(assertHostedCommandContract("ACTION proof_lint"), "action.proof-lint");
  assert.equal(assertHostedCommandContract("ACTION-PLAN submit"), "action-plan.submit");

  let fetchCalled = false;
  await assert.rejects(
    () =>
      callHostedCommand({
        command: "mission.delete",
        payload: {},
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => {
          fetchCalled = true;
          return { ok: true, json: async () => ({ allowed: true }) };
        }
      }),
    (error) => {
      assert.equal(error instanceof BridgeServerError, true);
      assert.equal(error.code, "bridge_command_rejected");
      assert.equal(error.publicState.reason, "unsupported_command");
      assert.equal(error.publicState.title, "Unsupported command");
      assert.ok(Array.isArray(error.publicState.actions));
      return true;
    }
  );
  assert.equal(fetchCalled, false);
  await assert.rejects(
    () =>
      callHostedCommand({
        command: "social.post",
        payload: { mode: "tiny_win", tone: "positive_neutral", text: "Legacy request" },
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => {
          fetchCalled = true;
          return { ok: true, json: async () => ({ allowed: true }) };
        }
      }),
    (error) => error instanceof BridgeServerError && error.publicState.reason === "unsupported_command"
  );
  assert.equal(fetchCalled, false);
});

test("bridge executable inventory covers the local parser and rejects removed Social commands", () => {
  const localCommands = localParserCommands();
  const removedSocialCommands = [...HOSTED_REMOVED_COMMAND_CONTRACTS];
  const classified = new Set([
    ...HOSTED_COMMAND_CONTRACTS,
    ...HOSTED_LOCAL_ONLY_COMMAND_CONTRACTS
  ]);
  assert.equal(HOSTED_COMMAND_CONTRACTS.size, 91);
  assert.equal(HOSTED_LOCAL_ONLY_COMMAND_CONTRACTS.size, 7);
  assert.equal(classified.size, 98);
  assert.equal(HOSTED_REMOVED_COMMAND_CONTRACTS.size, 11);
  for (const command of HOSTED_LOCAL_ONLY_COMMAND_CONTRACTS) {
    assert.equal(HOSTED_UNSUPPORTED_COMMAND_CONTRACTS.has(command), true, command);
  }
  for (const command of HOSTED_REMOVED_COMMAND_CONTRACTS) {
    assert.equal(HOSTED_UNSUPPORTED_COMMAND_CONTRACTS.has(command), true, command);
  }
  if (localCommands) assert.deepEqual([...classified].sort(), localCommands);

  for (const command of localCommands || classified) {
    const status = hostedCommandStatus(command);
    assert.equal(
      status.supported || status.reason === "unsupported_command",
      true,
      command
    );
    if (status.supported) {
      const contract = hostedResponseContract(command);
      assert.equal(contract.command, command);
      assert.ok(contract.responseKeys.includes("status"), command);
      assert.ok(contract.responseKeys.includes("next_action"), command);
      assert.ok(contract.responseKeys.includes("recovery"), command);
    }
  }
  for (const command of removedSocialCommands) {
    assert.equal(localCommands ? localCommands.includes(command) : classified.has(command), false, command);
    assert.equal(hostedCommandStatus(command).reason, "unsupported_command", command);
    assert.throws(() => assertHostedCommandContract(command), BridgeServerError);
  }
});

test("bridge command status is explicit for supported, unsupported, and unknown commands", () => {
  const client = createBridgeClient({ session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-1" } });
  const supported = hostedCommandStatus("goals lock");
  assert.equal(supported.supported, true);
  assert.equal(supported.command, "goals.lock");
  assert.ok(client.supportedCommands().includes("inbox.capture"));
  assert.equal(client.supportedCommands().some((command) => command.startsWith("social.")), false);

  const unsupported = client.commandStatus("social post");
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.reason, "unsupported_command");

  const unknown = hostedCommandStatus("repo upload");
  assert.equal(unknown.supported, false);
  assert.equal(unknown.reason, "unknown_command");
});

test("bridge preserves canonical hosted runtime lifecycle commands and fields", () => {
  const cases = [
    {
      argv: ["agents", "runtime", "schedule", "--capacity", "3"],
      command: "agents.runtime.schedule",
      requiredFields: ["capacity"],
      fields: { capacity: "3" }
    },
    {
      argv: [
        "agents", "runtime", "interrupt", "--agent-id", "sub-2", "--kind", "offline",
        "--requires-coordination", "--reason", "Runtime disconnected"
      ],
      command: "agents.runtime.interrupt",
      requiredFields: ["agent_id", "kind"],
      fields: {
        agent_id: "sub-2",
        kind: "offline",
        requires_coordination: "true",
        reason: "Runtime disconnected"
      }
    },
    {
      argv: ["agents", "runtime", "stop", "--agent-id", "sub-3", "--reason", "Operator stopped the run"],
      command: "agents.runtime.stop",
      requiredFields: ["agent_id"],
      fields: { agent_id: "sub-3", reason: "Operator stopped the run" }
    },
    {
      argv: ["agents", "runtime", "resume", "--agent-id", "sub-4", "--runtime-identity", "runtime-resumed-4"],
      command: "agents.runtime.resume",
      requiredFields: ["agent_id", "runtime_identity"],
      fields: { agent_id: "sub-4", runtime_identity: "runtime-resumed-4" }
    },
    {
      argv: [
        "agents", "runtime", "replace", "--agent-id", "sub-5",
        "--runtime-identity", "runtime-replacement-5", "--verified"
      ],
      command: "agents.runtime.replace",
      requiredFields: ["agent_id", "runtime_identity", "verified"],
      fields: { agent_id: "sub-5", runtime_identity: "runtime-replacement-5", verified: "true" }
    }
  ];

  for (const item of cases) {
    const parsed = parseHostedCommandArgv(item.argv);
    assert.equal(parsed.command, item.command);
    assert.deepEqual(parsed.payload.cli_argv, item.argv);
    for (const [key, value] of Object.entries(item.fields)) {
      assert.equal(parsed.payload[key], value, `${item.command}:${key}`);
    }
    assert.deepEqual(hostedResponseContract(item.command).requiredFields, item.requiredFields);
  }
});

test("bridge parses local-style command argv into hosted workflow payloads", () => {
  assert.deepEqual(parseHostedCommandArgv(["action", "check", "A109", "--proof", "tests passed"]), {
    command: "action.check",
    payload: {
      proof: "tests passed",
      action_id: "A109",
      cli_argv: ["action", "check", "A109", "--proof", "tests passed"]
    }
  });

  assert.deepEqual(parseHostedCommandArgv(["action", "revise", "A109", "--decision", "certain_flawless_optimized", "--reasoning", "Direct proof passed."]), {
    command: "action.revise",
    payload: {
      decision: "certain_flawless_optimized",
      reasoning: "Direct proof passed.",
      action_id: "A109",
      cli_argv: ["action", "revise", "A109", "--decision", "certain_flawless_optimized", "--reasoning", "Direct proof passed."]
    }
  });

  assert.deepEqual(
    parseHostedCommandArgv([
      "action",
      "check",
      "A109",
      "--proof",
      "tests passed",
      "--project",
      "proj_solo_primary",
      "--expected-project-version",
      "7",
      "--idempotency-key",
      "idem-123456"
    ]),
    {
      command: "action.check",
      payload: {
        proof: "tests passed",
        project_id: "proj_solo_primary",
        expected_project_version: "7",
        idempotency_key: "idem-123456",
        action_id: "A109",
        cli_argv: ["action", "check", "A109", "--proof", "tests passed"]
      }
    }
  );

  const workflowPath = require("node:path").join(require("node:os").tmpdir(), `unclog-actions-${process.pid}.json`);
  const adaptivePlan = {
    selected_small_goal_ids: ["G002"],
    actions: [{
      id: "A100",
      text: "Deliver the selected Small Goal",
      children: [{
        id: "A101",
        goal_id: "G003",
        text: "Make the Tiny Goal outcome observable",
        validation_plan: {
          schema: "small-action-validation-plan/1",
          policy_revision: "minimum-sufficient/1",
          goal_id: "G003",
          primary_check: {
            id: "V1",
            method: "direct_observation",
            target: "the exact changed behavior",
            procedure: "observe the smallest signal that distinguishes working from broken",
            expected_signal: "the Tiny Goal outcome is directly visible",
            covers: ["C1"]
          },
          why_sufficient: "The direct observation discriminates the scoped working outcome.",
          stop_when: "Stop after the expected signal covers the scoped claim.",
          scope_limit: "Do not run broader checks without an observed escalation trigger.",
          escalation_ladder: []
        },
        children: [{ id: "A102", text: "Perform the implementation step" }]
      }]
    }]
  };
  require("node:fs").writeFileSync(workflowPath, JSON.stringify(adaptivePlan), "utf8");
  try {
    const actionPlan = parseHostedCommandArgv(["--mission", "M023", "--json", "action_plan", "submit", "--file", workflowPath]);
    assert.equal(actionPlan.command, "action-plan.submit");
    assert.equal(actionPlan.payload.mission_id, "M023");
    assert.equal(actionPlan.payload.file, "workflow.json");
    assert.deepEqual(actionPlan.payload.workflow_document.selected_small_goal_ids, ["G002"]);
    assert.equal(actionPlan.payload.workflow_document.actions[0].children[0].validation_plan.schema, "small-action-validation-plan/1");
    assert.equal(actionPlan.payload.workflow_document.actions[0].children[0].validation_plan.policy_revision, "minimum-sufficient/1");
    assert.deepEqual(actionPlan.payload.cli_argv, ["action-plan", "submit", "--file", "workflow.json"]);
    assert.equal(actionPlan.payload.metadata, undefined);
  } finally {
    require("node:fs").unlinkSync(workflowPath);
  }

  const goalContractPath = require("node:path").join(require("node:os").tmpdir(), `unclog-goal-contract-${process.pid}.json`);
  const goalContract = {
    schema: "tiny-goal-contract/2",
    requirement_origin: "user_requested",
    applies_to: "the exact hosted outcome",
    user_intent: "Keep the requested behavior directly verifiable."
  };
  require("node:fs").writeFileSync(goalContractPath, JSON.stringify(goalContract), "utf8");
  try {
    const goalAdd = parseHostedCommandArgv([
      "goals", "add-tiny", "--parent", "G002", "--text", "Verify hosted setup",
      "--goal-contract-file", goalContractPath
    ]);
    assert.equal(goalAdd.command, "goals.add-tiny");
    assert.deepEqual(goalAdd.payload.goal_contract_document, goalContract);
    assert.equal(goalAdd.payload.goal_contract_file, "goal-contract.json");
    assert.deepEqual(goalAdd.payload.cli_argv, [
      "goals", "add-tiny", "--parent", "G002", "--text", "Verify hosted setup",
      "--goal-contract-file", "goal-contract.json"
    ]);
    assert.equal(JSON.stringify(goalAdd).includes(goalContractPath), false);
  } finally {
    require("node:fs").unlinkSync(goalContractPath);
  }

  assert.deepEqual(parseHostedCommandArgv(["inbox", "archive", "I003", "--reason", "done"]), {
    command: "inbox.archive",
    payload: {
      reason: "done",
      item_id: "I003",
      cli_argv: ["inbox", "archive", "I003", "--reason", "done"]
    }
  });

});

test("bridge transports adaptive proof and integration-closeout documents without becoming a semantic validator", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "unclog-adaptive-docs-"));
  const proofFile = path.join(root, "proof.json");
  const closeoutFile = path.join(root, "closeout.json");
  const proof = {
    schema: "small-action-proof/2",
    action_id: "A101",
    human_summary: "The scoped outcome now works.",
    inspection_note: "I checked the exact changed behavior.",
    verification_note: "I verified the direct expected signal.",
    proof: "One direct observation discriminated working from broken.",
    changed_files: ["app/example.js"],
    analyzed_files: ["app/example.js"],
    completed_tiny_actions: [{ action_id: "A102", summary: "Implementation step completed." }],
    validation_plan_hash: "server-checks-this-hash",
    validation_result: {
      schema: "small-action-validation-result/1",
      policy_revision: "minimum-sufficient/1",
      validation_plan_hash: "server-checks-this-hash",
      evidence: [{
        id: "E1",
        check_id: "V1",
        origin: "primary",
        kind: "direct_observation",
        observed: "The expected signal was directly visible.",
        references: ["runtime:exact-signal"],
        covers: ["C1"]
      }],
      escalation: { triggered: false, trigger_observations: [] },
      decision: "pass",
      sufficiency_reason: "The cheapest direct check covered the complete scoped claim."
    }
  };
  const closeout = {
    closeout_sweep: {
      schema: "small-goal-closeout/2",
      integration_result: {
        interactions_checked: [],
        contradictions: [],
        unresolved_escalations: [],
        new_findings: [],
        none_required_reason: "Only one independent Small Action exists in this Small Goal.",
        decision: "pass"
      }
    },
    small_goal_summaries: [{ goal_id: "G002", human_summary: "The Small Goal is complete." }]
  };
  fs.writeFileSync(proofFile, JSON.stringify(proof), "utf8");
  fs.writeFileSync(closeoutFile, JSON.stringify(closeout), "utf8");
  try {
    const proofCommand = parseHostedCommandArgv(["action", "check", "A101", "--file", proofFile, "--mission", "M001"]);
    const closeoutCommand = parseHostedCommandArgv(["set", "closeout-lint", "--file", closeoutFile, "--mission", "M001"]);
    assert.deepEqual(proofCommand.payload.workflow_document, proof);
    assert.deepEqual(closeoutCommand.payload.workflow_document, closeout);
    assert.equal(proofCommand.payload.cli_argv.includes(proofFile), false);
    assert.equal(closeoutCommand.payload.cli_argv.includes(closeoutFile), false);
    assert.equal(proofCommand.payload.metadata, undefined);
    assert.equal(closeoutCommand.payload.metadata, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bridge rejects missing or malformed workflow JSON before transport", () => {
  assert.throws(
    () => parseHostedCommandArgv(["goals", "update", "--file", "definitely-missing.json"]),
    (error) => error instanceof BridgeServerError && error.code === "FILE_NOT_FOUND"
  );
  const malformed = require("node:path").join(require("node:os").tmpdir(), `unclog-malformed-${process.pid}.json`);
  require("node:fs").writeFileSync(malformed, "{broken", "utf8");
  try {
    assert.throws(
      () => parseHostedCommandArgv(["goals", "update", "--file", malformed]),
      (error) => error instanceof BridgeServerError && error.code === "FILE_JSON_INVALID"
    );
  } finally {
    require("node:fs").unlinkSync(malformed);
  }
});

test("bridge privately transports canonical review lifecycle stages without leaking local argv", () => {
  const root = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "unclog-review-lifecycle-"));
  const writeStage = (stage) => {
    const file = require("node:path").join(root, `${stage}.json`);
    require("node:fs").writeFileSync(file, JSON.stringify({ stage, goal_id: "G002", evidence: [`${stage} evidence`] }), "utf8");
    return file;
  };
  const baselineFile = writeStage("baseline");
  const finalFile = writeStage("final");
  const activateFile = writeStage("activate");
  try {
    const baseline = parseHostedCommandArgv(["action_plan", "revise", "--decision", "certain_10_10", "--reasoning", "accepted", "--review-lifecycle-file", baselineFile, "--mission", "M001"]);
    const final = parseHostedCommandArgv(["set", "submit", "--summary", "done", "--proof", "verified", "--review-lifecycle-file", finalFile, "--mission", "M001"]);
    const activate = parseHostedCommandArgv(["set", "revise", "--decision", "certain_flawless_optimized", "--reasoning", "accepted", "--review-lifecycle-file", activateFile, "--mission", "M001"]);
    assert.equal(baseline.payload.review_lifecycle.stage, "baseline");
    assert.equal(baseline.payload.decision, "certain_flawless_optimized");
    assert.equal(baseline.payload.cli_argv.includes("certain_10_10"), true);
    assert.equal(baseline.payload.cli_argv.includes("certain_flawless_optimized"), false);
    assert.equal(final.payload.review_lifecycle.stage, "final");
    assert.equal(activate.payload.review_lifecycle.stage, "activate");
    for (const parsed of [baseline, final, activate]) {
      assert.equal(parsed.payload.metadata, undefined);
      assert.equal(parsed.payload.cli_argv.includes("--review-lifecycle-file"), false);
      assert.equal(parsed.payload.cli_argv.some((value) => [baselineFile, finalFile, activateFile].includes(value)), false);
      assert.equal(JSON.stringify(parsed.payload.cli_argv).includes("evidence"), false);
    }
  } finally {
    require("node:fs").rmSync(root, { recursive: true, force: true });
  }
});

test("bridge rejects missing, malformed, mismatched, and misplaced review lifecycle files before transport", () => {
  assert.throws(
    () => parseHostedCommandArgv(["set", "submit", "--summary", "done", "--proof", "verified", "--mission", "M001"]),
    (error) => error instanceof BridgeServerError && error.code === "REVIEW_LIFECYCLE_FILE_REQUIRED"
  );
  assert.throws(
    () => parseHostedCommandArgv(["set", "submit", "--summary", "done", "--proof", "verified", "--review-lifecycle-file", "missing-review.json", "--mission", "M001"]),
    (error) => error instanceof BridgeServerError && error.code === "FILE_NOT_FOUND"
  );
  const root = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "unclog-review-invalid-"));
  const malformed = require("node:path").join(root, "malformed.json");
  const wrongStage = require("node:path").join(root, "wrong-stage.json");
  const missingGoalId = require("node:path").join(root, "missing-goal-id.json");
  require("node:fs").writeFileSync(malformed, "{broken", "utf8");
  require("node:fs").writeFileSync(wrongStage, JSON.stringify({ stage: "activate", goal_id: "G002" }), "utf8");
  require("node:fs").writeFileSync(missingGoalId, JSON.stringify({ stage: "final" }), "utf8");
  try {
    assert.throws(
      () => parseHostedCommandArgv(["set", "submit", "--summary", "done", "--proof", "verified", "--review-lifecycle-file", malformed, "--mission", "M001"]),
      (error) => error instanceof BridgeServerError && error.code === "FILE_JSON_INVALID"
    );
    assert.throws(
      () => parseHostedCommandArgv(["set", "submit", "--summary", "done", "--proof", "verified", "--review-lifecycle-file", wrongStage, "--mission", "M001"]),
      (error) => error instanceof BridgeServerError && error.code === "REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH"
    );
    assert.throws(
      () => parseHostedCommandArgv(["set", "submit", "--summary", "done", "--proof", "verified", "--review-lifecycle-file", missingGoalId, "--mission", "M001"]),
      (error) => error instanceof BridgeServerError && error.code === "REVIEW_LIFECYCLE_IDENTITY_REQUIRED"
    );
    assert.throws(
      () => parseHostedCommandArgv(["recover", "--review-lifecycle-file", wrongStage, "--mission", "M001"]),
      (error) => error instanceof BridgeServerError && error.code === "REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH"
    );
    assert.throws(
      () => parseHostedCommandArgv(["recover", "--review-lifecycle-file", "--mission", "M001"]),
      (error) => error instanceof BridgeServerError && error.code === "REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH"
    );
  } finally {
    require("node:fs").rmSync(root, { recursive: true, force: true });
  }
});

test("hosted output documents are written only to the requested local file", () => {
  const root = tempStorage();
  const storageDir = path.join(root, "session");
  const outputPath = path.join(root, "exports", "goals.json");
  const written = writeHostedOutputFile(
    outputPath,
    { domain: { generated_file: { name: "server-choice.json", content: { goals: [{ id: "G001" }] } } } },
    { sessionOptions: { storageDir, cwd: process.cwd() } }
  );
  assert.equal(written.path, path.resolve(outputPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), { goals: [{ id: "G001" }] });
  assert.equal(fs.existsSync(path.join(root, "server-choice.json")), false);
  assert.throws(
    () => writeHostedOutputFile(path.join(storageDir, "session.json"), { generated_file: { content: {} } }, {
      sessionOptions: { storageDir, cwd: process.cwd() }
    }),
    (error) => error instanceof BridgeServerError && error.code === "local_output_session_path_rejected"
  );
});

test("thin bridge materializes hosted goal drafts and carries local draft context back to canonical commands", () => {
  const root = tempStorage();
  fs.mkdirSync(path.join(root, ".git"));
  const draftId = "D20260717-120000-abcdef";
  const draftRelative = `.unclog-drafts/${draftId}/unclog_goals.json`;
  const statusRelative = `.unclog-drafts/${draftId}/status.json`;
  const draft = { goals: [], worker_lanes: { max_sub_agents: 6 } };
  const status = {
    draft_id: draftId,
    kind: "goals_intake",
    status: "intake",
    mission_id: null,
    goals_file: "unclog_goals.json",
    submitted_file: null,
    created_at: "2026-07-17T04:00:00Z",
    updated_at: "2026-07-17T04:00:00Z"
  };
  const createOperations = [
    { op: "write_json", path: statusRelative, before_sha256: null, sha256: artifactHash(status), document: status },
    { op: "write_json", path: draftRelative, before_sha256: null, sha256: artifactHash(draft), document: draft }
  ];
  const createEffects = {
    schema: "unclog-local-artifact-effects/1",
    effect_id: artifactHash(createOperations),
    operations: createOperations
  };
  try {
    const applied = applyHostedLocalArtifactEffects({ domain: { local_artifact_effects: createEffects } }, { cwd: root });
    assert.equal(applied.applied, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, draftRelative), "utf8")), draft);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, statusRelative), "utf8")), status);

    const listed = parseHostedCommandArgv(["drafts", "list"], { cwd: root });
    assert.equal(listed.command, "drafts.list");
    assert.equal(listed.payload.local_artifacts.schema, "unclog-local-artifacts/1");
    assert.deepEqual(listed.payload.local_artifacts.entries, [{ path: statusRelative, document: status }]);

    const lock = parseHostedCommandArgv(["goals", "lock", "--file", draftRelative], { cwd: root });
    assert.equal(lock.command, "goals.lock");
    assert.equal(lock.payload.workflow_file_path, draftRelative);
    assert.deepEqual(lock.payload.workflow_document, draft);
    assert.deepEqual(lock.payload.local_artifacts.entries.map((entry) => entry.path), [draftRelative, statusRelative]);
    assert.deepEqual(lock.payload.cli_argv, ["goals", "lock", "--file", "workflow.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("thin bridge archives an accepted local draft idempotently and keeps recovery journals clean", () => {
  const root = tempStorage();
  fs.mkdirSync(path.join(root, ".git"));
  const draftId = "D20260717-120001-fedcba";
  const draftRelative = `.unclog-drafts/${draftId}/unclog_goals.json`;
  const submittedRelative = `.unclog-drafts/${draftId}/submitted_goals.json`;
  const statusRelative = `.unclog-drafts/${draftId}/status.json`;
  const draft = { goals: [{ text: "Use hosted Unclog with local workflow artifacts" }] };
  const intakeStatus = {
    draft_id: draftId, kind: "goals_intake", status: "intake", mission_id: null,
    goals_file: "unclog_goals.json", submitted_file: null,
    created_at: "2026-07-17T04:00:00Z", updated_at: "2026-07-17T04:00:00Z"
  };
  const submittedStatus = {
    ...intakeStatus,
    status: "submitted",
    mission_id: "M001",
    goals_file: null,
    submitted_file: "submitted_goals.json",
    submitted_at: "2026-07-17T04:01:00Z",
    updated_at: "2026-07-17T04:01:00Z"
  };
  const operations = [
    { op: "rename", from: draftRelative, path: submittedRelative, sha256: artifactHash(draft) },
    {
      op: "write_json", path: statusRelative, before_sha256: artifactHash(intakeStatus),
      sha256: artifactHash(submittedStatus), document: submittedStatus
    }
  ];
  const effect = {
    schema: "unclog-local-artifact-effects/1",
    effect_id: artifactHash(operations),
    operations
  };
  try {
    fs.mkdirSync(path.join(root, `.unclog-drafts/${draftId}`), { recursive: true });
    fs.writeFileSync(path.join(root, draftRelative), `${JSON.stringify(draft, null, 2)}\n`);
    fs.writeFileSync(path.join(root, statusRelative), `${JSON.stringify(intakeStatus, null, 2)}\n`);
    const first = applyHostedLocalArtifactEffects({ local_artifact_effects: effect }, { cwd: root });
    assert.equal(first.applied, 2);
    assert.equal(fs.existsSync(path.join(root, draftRelative)), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, submittedRelative), "utf8")), draft);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, statusRelative), "utf8")), submittedStatus);
    assert.equal(applyHostedLocalArtifactEffects({ local_artifact_effects: effect }, { cwd: root }).applied, 0);
    assert.deepEqual(reconcilePendingLocalArtifactEffects({ cwd: root }), { reconciled: 0 });
    const journalDirectory = path.join(root, ".unclog-drafts", ".bridge-effects");
    assert.deepEqual(fs.readdirSync(journalDirectory), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("adapter prompt is minimal and useless without server auth", async () => {
  const prompt = buildAdapterPrompt("Codex");
  const rendered = prompt.toLowerCase();
  assert.match(rendered, /server authorization/);
  assert.match(rendered, /thin/);
  assert.doesNotMatch(rendered, /controller_internals|policy_prompt|core_rulebook|full_brain/);

  await assert.rejects(
    () =>
      callHostedCommand({
        command: "action.check",
        payload: { controller_internals: true },
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => ({ ok: true, json: async () => ({ allowed: true }) })
      }),
    (error) => error instanceof BridgeServerError && error.code === "bridge_payload_rejected"
  );
});

test("customer adapters use discoverable Agent Skills paths and safely retire only owned Claude legacy files", () => {
  const homeDir = tempStorage();
  const legacyPath = path.join(homeDir, ".claude", "commands", "unclog-hosted.md");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, "<!-- unclog-hosted-adapter-v1 -->\nlegacy hosted adapter\n");

  const claude = installHostedAdapter("claude", homeDir);
  const claudePath = path.join(homeDir, ".claude", "skills", "unclog-hosted", "SKILL.md");
  assert.equal(claude.path, "~/.claude/skills/unclog-hosted/SKILL.md");
  assert.equal(claude.removedLegacyAdapter, true);
  assert.equal(fs.existsSync(legacyPath), false);
  assert.match(fs.readFileSync(claudePath, "utf8"), /^---\nname: unclog-hosted\ndescription: /);

  const userOwnedLegacy = path.join(homeDir, ".claude", "commands", "unclog-hosted.md");
  fs.writeFileSync(userOwnedLegacy, "user-owned command\n");
  const claudeRefresh = installHostedAdapter("claude", homeDir);
  assert.equal(claudeRefresh.removedLegacyAdapter, false);
  assert.equal(fs.readFileSync(userOwnedLegacy, "utf8"), "user-owned command\n");

  const codex = installHostedAdapter("codex", homeDir);
  assert.equal(codex.path, "~/.agents/skills/unclog-hosted/SKILL.md");
  assert.match(
    fs.readFileSync(path.join(homeDir, ".agents", "skills", "unclog-hosted", "SKILL.md"), "utf8"),
    /follow the server-provided next action/
  );
});

test("repository identity resolves the Git root and rejects setup outside a repository", () => {
  const root = tempStorage();
  const repo = path.join(root, "customer-repo");
  const nested = path.join(repo, "packages", "app");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const fromRoot = repositoryIdentity(repo);
  const fromNested = repositoryIdentity(nested);
  assert.equal(fromNested.label, "customer-repo");
  assert.equal(fromNested.fingerprint, fromRoot.fingerprint);
  assert.match(fromNested.fingerprint, /^[0-9a-f]{64}$/);
  assert.throws(
    () => repositoryIdentity(outside),
    (error) => error instanceof BridgeServerError && error.code === "git_repository_required"
  );
});

test("approval fallback validates the hosted URL and remains usable when browser opening fails", async () => {
  let opened = "";
  assert.equal(await openHostedApprovalUrl("https://app.unclog.dev/connect?code=ABCD-EFGH", {
    openBrowser: async (url) => { opened = url; return false; }
  }), false);
  assert.equal(opened, "https://app.unclog.dev/connect?code=ABCD-EFGH");
  assert.equal(await openHostedApprovalUrl("https://example.com/connect?code=ABCD-EFGH", {
    openBrowser: async () => true
  }), false);
});

test("credential storage capability treats the Unix permission-protected fallback as usable", () => {
  const linux = credentialStorageCapabilities({ platform: "linux" });
  assert.equal(linux.permissionProtectedFileFallback, true);
  assert.equal(linux.usable, true);

  const windows = credentialStorageCapabilities({ platform: "win32" });
  assert.equal(windows.permissionProtectedFileFallback, false);
  assert.equal(windows.usable, windows.keyringAvailable);
});

test("setup connect clears a stale session reference whose credential is missing", async () => {
  const storageDir = tempStorage();
  const cwd = path.join(storageDir, "repo");
  const homeDir = path.join(storageDir, "customer-profile");
  const credentialStore = memoryCredentialStore();
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.mkdirSync(homeDir);
  saveSession({
    apiBaseUrl: "http://127.0.0.1:8080",
    deviceSessionId: "00000000-0000-4000-8000-000000000090",
    projectId: "proj_stale",
    tool: "codex"
  }, TEST_SESSION_TOKEN, { storageDir, cwd, allowLocalHttp: true, credentialStore });
  const staleReference = loadSessionReference({ storageDir, cwd, allowLocalHttp: true });
  credentialStore.delete(staleReference.credentialAccount);
  let fetchCalled = false;

  await assert.rejects(
    () => connectWithSetupIntent(
      ["--tool", "codex", "--setup-intent", `UC_${"S".repeat(32)}`, "--api-base-url", "http://127.0.0.1:8080"],
      {
        cwd,
        homeDir,
        sessionOptions: { storageDir, cwd, allowLocalHttp: true, credentialStore },
        fetchImpl: async () => {
          fetchCalled = true;
          return { ok: false, json: async () => ({ status: "error", code: "expected_test_stop", message: "Stop after stale recovery." }) };
        }
      }
    ),
    (error) => error instanceof BridgeServerError && error.code === "expected_test_stop"
  );
  assert.equal(fetchCalled, true);
  assert.equal(loadSessionReference({ storageDir, cwd, allowLocalHttp: true }), null);
});

test("adapter conflict preserves an existing working session", async () => {
  const storageDir = tempStorage();
  const cwd = path.join(storageDir, "repo");
  const homeDir = path.join(storageDir, "customer-profile");
  const credentialStore = memoryCredentialStore();
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  const conflictPath = path.join(homeDir, ".agents", "skills", "unclog-hosted", "SKILL.md");
  fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
  fs.writeFileSync(conflictPath, "customer-owned adapter\n");
  const oldToken = `us_${"P".repeat(43)}`;
  saveSession({
    apiBaseUrl: "http://127.0.0.1:8080",
    deviceSessionId: "00000000-0000-4000-8000-000000000091",
    projectId: "proj_preserved",
    tool: "codex"
  }, oldToken, { storageDir, cwd, allowLocalHttp: true, credentialStore });
  const calls = [];

  await assert.rejects(
    () => connectWithSetupIntent(
      ["--tool", "codex", "--setup-intent", `UC_${"T".repeat(32)}`, "--api-base-url", "http://127.0.0.1:8080"],
      {
        cwd,
        homeDir,
        pollIntervalMs: 1,
        sessionOptions: { storageDir, cwd, allowLocalHttp: true, credentialStore },
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          if (url.endsWith("/v1/bridge/device/authorize")) {
            const request = JSON.parse(init.body);
            return { ok: true, json: async () => ({
              status: "authorization_pending",
              device_code: request.device_code,
              user_code: request.user_code,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              interval: 0,
              project_id: "proj_preserved"
            }) };
          }
          if (url.endsWith("/v1/bridge/device/token")) {
            return { ok: true, json: async () => ({
              status: "approved",
              session_id: "00000000-0000-4000-8000-000000000092",
              project_id: "proj_preserved",
              expires_at: new Date(Date.now() + 60_000).toISOString()
            }) };
          }
          if (url.endsWith("/v1/bridge/session/revoke")) {
            return { ok: true, json: async () => ({ allowed: true, revoked: true }) };
          }
          throw new Error(`Unexpected URL ${url}`);
        }
      }
    ),
    (error) => error instanceof BridgeServerError && error.code === "adapter_path_conflict"
  );
  const loaded = loadSession({ storageDir, cwd, allowLocalHttp: true, credentialStore });
  assert.equal(loaded.deviceSessionId, "00000000-0000-4000-8000-000000000091");
  assert.equal(loaded.sessionToken, oldToken);
  const revokeCalls = calls.filter((call) => call.url.endsWith("/v1/bridge/session/revoke"));
  assert.equal(revokeCalls.length, 1);
  assert.notEqual(revokeCalls[0].init.headers.authorization, `Bearer ${oldToken}`);
});

test("setup intent connect waits for approval, stores a protected credential, installs adapter, and returns hosted next", async () => {
  const storageDir = tempStorage();
  const cwd = path.join(storageDir, "repo");
  const homeDir = path.join(storageDir, "customer-profile");
  const credentialStore = memoryCredentialStore();
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(homeDir);
  const calls = [];
  const statuses = [];
  let tokenPolls = 0;
  const result = await connectWithSetupIntent(
    ["--tool", "codex", "--setup-intent", `UC_${"C".repeat(32)}`, "--api-base-url", "http://127.0.0.1:8080"],
    {
      cwd,
      homeDir,
      pollIntervalMs: 1,
      pollRetryBaseMs: 1,
      fallbackDelayMs: 0,
      openBrowser: async () => false,
      onStatus: (status) => statuses.push(status),
      sessionOptions: { storageDir, cwd, allowLocalHttp: true, credentialStore },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/v1/bridge/device/authorize")) {
          const request = JSON.parse(init.body);
          return { ok: true, json: async () => ({
            status: "authorization_pending",
            device_code: request.device_code,
            user_code: request.user_code,
            verification_uri_complete: `https://app.unclog.dev/connect?code=${request.user_code}`,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            interval: 0,
            project_id: "proj_solo_primary"
          }) };
        }
        if (url.endsWith("/v1/bridge/device/token")) {
          tokenPolls += 1;
          if (tokenPolls === 1) throw new Error("temporary network interruption");
          return { ok: true, json: async () => tokenPolls === 2
            ? { status: "authorization_pending", retry_after_seconds: 0 }
            : { status: "approved", session_id: "00000000-0000-4000-8000-000000000001", project_id: "proj_solo_primary", expires_at: new Date(Date.now() + 60_000).toISOString() }
          };
        }
        if (url.endsWith("/v1/bridge/project-link")) {
          return { ok: true, json: async () => ({
            allowed: true, blocked: false, status: "OK", linked: true,
            project: { id: "proj_solo_primary", name: "Hosted project", status: "active", projectVersion: 1 },
            device: { id: "00000000-0000-4000-8000-000000000001", label: "Codex", state: "approved", projectId: "proj_solo_primary" },
            dashboard_probe: { dashboard_state: "ready", device_count: 1, monitor_unlocked: true },
            monitor_probe: { source_status: "ready", selectedProjectId: "proj_solo_primary", monitorStateKind: "active" },
            source: { serverOwnedLink: true, supabaseBacked: true }, next_action: {}, commands_now: []
          }) };
        }
        return { ok: true, json: async () => hostedOk("next", {
          next_action: { code: "CREATE_MISSION", message: "Capture the customer outcome." },
          commands_now: ["unclog-bridge mission create --title <outcome>"]
        }) };
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.linked, true);
  assert.equal(result.status, "connected");
  assert.equal(result.next_action.code, "CREATE_MISSION");
  assert.equal(result.storage.persistedSecretMaterial, false);
  const loaded = loadSessionReference({ storageDir, cwd, allowLocalHttp: true });
  assert.equal(loaded.apiBaseUrl, "http://127.0.0.1:8080");
  assert.equal(loaded.deviceSessionId, "00000000-0000-4000-8000-000000000001");
  assert.equal(loaded.projectId, "proj_solo_primary");
  assert.equal(loadSession({ storageDir, cwd, allowLocalHttp: true, credentialStore }).sessionToken.startsWith("us_"), true);
  const adapterPath = path.join(homeDir, ".agents", "skills", "unclog-hosted", "SKILL.md");
  assert.equal(fs.existsSync(adapterPath), true);
  const adapterText = fs.readFileSync(adapterPath, "utf8");
  assert.match(adapterText, /^---\nname: unclog-hosted\ndescription: /);
  assert.match(adapterText, /start, continue, resume, or check Unclog work/);
  assert.match(adapterText, /Do not guess the next workflow command/);
  assert.match(adapterText, /<!-- unclog-hosted-adapter-v1 -->/);
  assert.equal(fs.existsSync(path.join(cwd, ".agents", "skills", "unclog-hosted", "SKILL.md")), false);
  assert.equal(statuses[0].stage, "waiting_for_dashboard_approval");
  assert.equal(statuses.some((status) => status.stage === "approval_poll_retry"), true);
  assert.equal(JSON.stringify(statuses[0]).includes("approval_url"), false);
  assert.equal(statuses.some((status) => status.approval_url?.startsWith("https://app.unclog.dev/connect?code=")), true);
  assert.equal(statuses.find((status) => status.stage === "approval_fallback").browser_opened, false);
  const authorizePayload = JSON.parse(calls.find((call) => call.url.endsWith("/v1/bridge/device/authorize")).init.body);
  const firstCommandPayload = JSON.parse(calls.find((call) => call.url.endsWith("/v1/bridge/commands")).init.body);
  assert.match(authorizePayload.device_code, /^dc_[A-Za-z0-9_-]{43}$/);
  assert.match(authorizePayload.user_code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.equal(firstCommandPayload.project_id, "proj_solo_primary");
  assert.deepEqual(firstCommandPayload.payload, {});
  assert.equal(calls.some((call) => call.init.headers.authorization?.startsWith("Bearer us_")), true);
  assert.equal(calls.some((call) => "x-unclog-device-session" in call.init.headers), false);
});

test("setup intent connect detects and revokes an existing bridge session before replacing it", async () => {
  const storageDir = tempStorage();
  const cwd = path.join(storageDir, "repo");
  const homeDir = path.join(storageDir, "customer-profile");
  const credentialStore = memoryCredentialStore();
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(homeDir);
  const oldToken = `us_${"B".repeat(43)}`;
  saveSession({
    apiBaseUrl: "http://127.0.0.1:8080",
    deviceSessionId: "00000000-0000-4000-8000-000000000010",
    projectId: "proj_solo_primary",
    tool: "codex"
  }, oldToken, { storageDir, cwd, allowLocalHttp: true, credentialStore });
  const calls = [];
  const result = await connectWithSetupIntent(
    ["--tool", "codex", "--setup-intent", `UC_${"D".repeat(32)}`, "--api-base-url", "http://127.0.0.1:8080"],
    {
      cwd,
      homeDir,
      pollIntervalMs: 1,
      sessionOptions: { storageDir, cwd, allowLocalHttp: true, credentialStore },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/v1/bridge/device/authorize")) {
          const request = JSON.parse(init.body);
          return { ok: true, json: async () => ({
            status: "authorization_pending",
            device_code: request.device_code,
            user_code: request.user_code,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            interval: 0,
            project_id: "proj_solo_primary"
          }) };
        }
        if (url.endsWith("/v1/bridge/device/token")) {
          return { ok: true, json: async () => ({
            status: "approved",
            session_id: "00000000-0000-4000-8000-000000000011",
            project_id: "proj_solo_primary",
            expires_at: new Date(Date.now() + 60_000).toISOString()
          }) };
        }
        if (url.endsWith("/v1/bridge/session/revoke")) {
          return { ok: true, json: async () => ({ allowed: true, revoked: true }) };
        }
        if (url.endsWith("/v1/bridge/project-link")) {
          return { ok: true, json: async () => ({
            allowed: true, blocked: false, status: "OK", linked: true,
            project: { id: "proj_solo_primary", name: "Hosted project", status: "active", projectVersion: 1 },
            device: { id: "00000000-0000-4000-8000-000000000011", label: "Codex", state: "approved", projectId: "proj_solo_primary" },
            dashboard_probe: { dashboard_state: "ready", device_count: 1, monitor_unlocked: true },
            monitor_probe: { source_status: "ready", selectedProjectId: "proj_solo_primary", monitorStateKind: "active" },
            source: { serverOwnedLink: true, supabaseBacked: true }, next_action: {}, commands_now: []
          }) };
        }
        return { ok: true, json: async () => hostedOk("next", {
          next_action: { code: "CREATE_MISSION", message: "Capture the customer outcome." },
          commands_now: []
        }) };
      }
    }
  );

  assert.equal(result.existing_session_detected, true);
  assert.equal(result.replaced_existing_session, true);
  const revokeCall = calls.find((call) => call.url.endsWith("/v1/bridge/session/revoke"));
  assert.equal(revokeCall.init.headers.authorization, `Bearer ${oldToken}`);
  const loaded = loadSession({ storageDir, cwd, allowLocalHttp: true, credentialStore });
  assert.equal(loaded.deviceSessionId, "00000000-0000-4000-8000-000000000011");
  assert.notEqual(loaded.sessionToken, oldToken);
});

test("project link command proves server-backed project and device records", async () => {
  const calls = [];
  const result = await callHostedProjectLink({
    projectId: "proj_solo_primary",
    session: {
      apiBaseUrl: "https://api.unclog.dev",
      sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-primary",
      projectId: "proj_solo_primary"
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          allowed: true,
          blocked: false,
          status: "OK",
          linked: true,
          command: "bridge.project-link",
          project: {
            id: "proj_solo_primary",
            name: "Solo launch project",
            status: "active",
            projectVersion: 1
          },
          device: {
            id: "device-primary",
            label: "Launch workstation",
            state: "approved",
            projectId: "proj_solo_primary"
          },
          dashboard_probe: {
            dashboard_state: "ready",
            device_count: 1,
            monitor_unlocked: true
          },
          monitor_probe: {
            source_status: "ready",
            selectedProjectId: "proj_solo_primary",
            monitorStateKind: "active"
          },
          source: {
            kind: "hosted-api",
            serverOwnedLink: true,
            supabaseBacked: true
          },
          next_action: {
            code: "BRIDGE_PROJECT_LINKED",
            commands_now: ["unclog-bridge packet --project proj_solo_primary"]
          },
          commands_now: ["unclog-bridge packet --project proj_solo_primary"]
        })
      };
    }
  });

  assertHostedProjectLinkEnvelope(result);
  assert.equal(result.linked, true);
  assert.equal(result.project.id, "proj_solo_primary");
  assert.equal(result.device.state, "approved");
  assert.equal(result.dashboard_probe.dashboard_state, "ready");
  assert.equal(result.monitor_probe.selectedProjectId, "proj_solo_primary");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.unclog.dev/v1/bridge/project-link");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TEST_SESSION_TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { project_id: "proj_solo_primary" });
});

test("logout revokes the hosted device before clearing its local reference", async () => {
  const storageDir = tempStorage();
  const credentialStore = memoryCredentialStore();
  saveSession({
    apiBaseUrl: "https://api.unclog.dev",
    deviceSessionId: "device-primary",
    projectId: "proj_solo_primary"
  }, TEST_SESSION_TOKEN, { storageDir, credentialStore });
  const calls = [];
  const result = await logout({
    sessionOptions: { storageDir, credentialStore },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          allowed: true,
          status: "OK",
          revoked: true,
          command: "bridge.session-revoke",
          device: { id: "device-primary", state: "revoked", projectId: "proj_solo_primary" }
        })
      };
    }
  });
  assert.equal(result.serverRevoked, true);
  assert.equal(loadSessionReference({ storageDir }), null);
  assert.equal(calls[0].url, "https://api.unclog.dev/v1/bridge/session/revoke");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TEST_SESSION_TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { project_id: "proj_solo_primary" });
});

test("failed hosted revocation keeps the local reference for retry", async () => {
  const storageDir = tempStorage();
  const credentialStore = memoryCredentialStore();
  saveSession({
    apiBaseUrl: "https://api.unclog.dev",
    deviceSessionId: "device-primary",
    projectId: "proj_solo_primary"
  }, TEST_SESSION_TOKEN, { storageDir, credentialStore });
  await assert.rejects(
    () => logout({
      sessionOptions: { storageDir, credentialStore },
      fetchImpl: async () => ({
        ok: false,
        json: async () => ({ allowed: false, code: "session_revoke_denied", message: "Retry logout." })
      })
    }),
    (error) => error instanceof BridgeServerError && error.code === "session_revoke_denied"
  );
  assert.equal(loadSessionReference({ storageDir }).deviceSessionId, "device-primary");
});

test("setup connect rejects non-live API endpoints before sending pairing material", async () => {
  const storageDir = tempStorage();

  for (const apiBaseUrl of [
    "http://api.unclog.dev",
    "https://10.0.0.5",
    "https://example.com",
    "https://api.unclog.dev/test_unclog"
  ]) {
    await assert.rejects(
      () =>
        connectWithSetupIntent(
          ["--tool", "codex", "--setup-intent", `UC_${"C".repeat(32)}`, "--api-base-url", apiBaseUrl],
          { sessionOptions: { storageDir, credentialStore: memoryCredentialStore() }, fetchImpl: async () => { throw new Error("must not fetch"); } }
        ),
      (error) => error instanceof SessionStorageError
    );
  }
});

test("bridge rejects normalized local repository and token payload keys", async () => {
  let fetchCalled = false;
  await assert.rejects(
    () =>
      callHostedCommand({
        command: "action.check",
        payload: {
          repo: { contents: "secret-value" },
          sourceCode: "print('repo file')",
          nested: { accessToken: "secret-value", apiKey: "secret-value" }
        },
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => {
          fetchCalled = true;
          return { ok: true, json: async () => ({ allowed: true }) };
        }
      }),
    (error) => {
      assert.equal(error instanceof BridgeServerError, true);
      assert.equal(error.code, "bridge_payload_rejected");
      assert.doesNotMatch(error.message, /secret-value|apiKey|contents/);
      return true;
    }
  );
  assert.equal(fetchCalled, false);
});

test("server denied responses remain production ready", async () => {
  await assert.rejects(
    () =>
      callHostedCommand({
        command: "action.check",
        payload: { action_id: "A1081" },
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => ({
          ok: false,
          async json() {
            return {
              allowed: false,
              blocked: true,
              code: "subscription_required",
              message: "Open billing.",
              billing: {
                provider: "merchant_of_record",
                portal_route: "/account/billing",
                checkout_route: "/account/billing/checkout"
              },
              mobile: { title: "Pay", message: "Open billing.", primaryAction: "Billing" }
            };
          }
        })
      }),
    (error) => {
      assert.equal(error instanceof BridgeServerError, true);
      assert.equal(error.code, "subscription_required");
      assert.equal(error.publicState.status, "ERROR");
      assert.equal(error.publicState.blocked, true);
      assert.ok(Array.isArray(error.publicState.recovery));
      assert.equal(error.publicState.billing.provider, "merchant_of_record");
      assert.equal(error.publicState.billing.portal_route, "/account/billing");
      assert.doesNotMatch(JSON.stringify(error.publicState).toLowerCase(), /lemon|stripe|paddle|trial/);
      assert.equal(error.publicState.mobile.primaryAction, "Billing");
      return true;
    }
  );

  await assert.rejects(
    () =>
      callHostedCommand({
        command: "action.check",
        payload: { action_id: "A1081" },
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => ({
          ok: false,
          async json() {
            return {
              detail: {
                allowed: false,
                blocked: true,
                status: "ERROR",
                code: "version_lock_required",
                message: "Refresh project state and retry.",
                actions: ["Refresh project state and retry."]
              }
            };
          }
        })
      }),
    (error) => {
      assert.equal(error instanceof BridgeServerError, true);
      assert.equal(error.code, "version_lock_required");
      assert.equal(error.publicState.status, "ERROR");
      assert.equal(error.publicState.blocked, true);
      assert.deepEqual(error.publicState.recovery, ["Refresh project state and retry."]);
      return true;
    }
  );
});

test("generic allowed server responses are rejected as invalid contract envelopes", async () => {
  assert.doesNotThrow(() => assertHostedResponseEnvelope(hostedOk("progress"), "progress"));

  await assert.rejects(
    () =>
      callHostedCommand({
        command: "progress",
        payload: { mission_id: "M008" },
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return { allowed: true, status: "OK" };
          }
        })
      }),
    (error) => {
      assert.equal(error instanceof BridgeServerError, true);
      assert.equal(error.code, "server_response_invalid");
      assert.equal(error.publicState.reason, "server_response_invalid");
      return true;
    }
  );
});

test("server transport failures become public bridge states", async () => {
  await assert.rejects(
    () =>
      callHostedCommand({
        command: "action.check",
        payload: { action_id: "A1081" },
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => {
          throw new Error("ECONNRESET with transport details");
        }
      }),
    (error) => {
      assert.equal(error instanceof BridgeServerError, true);
      assert.equal(error.code, "server_unreachable");
      assert.equal(error.publicState.reason, "server_unreachable");
      assert.doesNotMatch(error.message, /ECONNRESET/);
      return true;
    }
  );

  await assert.rejects(
    () =>
      callHostedCommand({
        command: "action.check",
        payload: { action_id: "A1081" },
        session: { apiBaseUrl: "https://api.unclog.dev", sessionToken: TEST_SESSION_TOKEN, deviceSessionId: "device-session-1" },
        fetchImpl: async () => ({
          ok: false,
          async json() {
            throw new Error("html error page");
          }
        })
      }),
    (error) => {
      assert.equal(error instanceof BridgeServerError, true);
      assert.equal(error.code, "server_response_invalid");
      assert.equal(error.publicState.reason, "server_response_invalid");
      assert.doesNotMatch(error.message, /html error page/);
      return true;
    }
  );
});
