const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const bridge = require("../src/index");
const {
  MCP_INSTRUCTIONS,
  createMcpRuntime,
  createMcpServer
} = require("../src/mcp");

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unclog-mcp-"));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

function envelope(command, extra = {}) {
  return {
    allowed: true,
    blocked: false,
    status: "OK",
    command,
    project: { id: "project-1", projectVersion: 1 },
    mission_id: "M001",
    next_action: { code: "HOSTED_STEP_READY", message: "Use the current hosted action." },
    commands_now: [],
    ...extra
  };
}

function artifactHash(document) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable(document))).digest("hex");
}

test("unclog_next exposes structured current actions without npx or shell commands", async () => {
  const root = repository();
  const calls = [];
  const runtime = createMcpRuntime(bridge, {
    workspaceRoot: root,
    client: {
      async command(command, payload) {
        calls.push({ command, payload });
        return envelope(command, {
          required_fields: ["title"],
          field_guide: { title: "One compact mission outcome." },
          completion_contract: {
            blocked_command: 'unclog --mission M001 --json agents block --agent-id sub-1 --reason "compact reason"',
            next_packet_command: "unclog --mission M001 --json agents packet --agent-id sub-1 --focus"
          },
          commands_now: ['unclog --mission M001 --json mission create --title "mission outcome"']
        });
      }
    }
  });

  const result = await runtime.next({ mission_id: "M001" });
  assert.equal(calls[0].command, "next");
  assert.equal(result.allowed_actions.length, 2);
  assert.equal(result.allowed_actions[0].command, "mission.create");
  assert.equal(result.allowed_actions[1].command, "agents.block");
  assert.deepEqual(result.allowed_actions[0].required_input, ["title"]);
  assert.deepEqual(result.allowed_actions[1].required_input, ["reason"]);
  assert.match(result.allowed_actions[0].action_id, /^UA_[0-9a-f]{32}$/);
  assert.equal(result.commands_now, undefined);
  assert.equal(result.next_action.commands_now, undefined);
  assert.equal(result.completion_contract.blocked_command, undefined);
  assert.equal(result.completion_contract.next_packet_command, undefined);
  assert.equal(JSON.stringify(result).includes("npx"), false);
  assert.equal(result.transport.shell_commands_allowed, false);
});

test("confirmed local intake exposes a typed mission-create action without leaking commands", async () => {
  const root = repository();
  const calls = [];
  const confirmEnvelope = () => envelope("next", {
    next_action: {
      code: "GOAL_INTAKE_CONFIRM_DRAFT",
      message: "Ask the user to confirm the captured outcomes before creating the mission.",
      commands_now: [],
      after_user_confirms_goals: ['unclog --json mission create --title "Compact mission title"'],
      after_mission_create: "Continue with the hosted Inbox gate."
    },
    commands_now: []
  });
  const runtime = createMcpRuntime(bridge, {
    workspaceRoot: root,
    client: {
      async command(command, payload) {
        calls.push({ command, payload });
        if (command === "next") return confirmEnvelope();
        return envelope(command, { project: { id: "project-1", projectVersion: 2 }, commands_now: [] });
      }
    }
  });

  const view = await runtime.next();
  assert.equal(view.allowed_actions.length, 1);
  assert.equal(view.allowed_actions[0].command, "mission.create");
  assert.equal(view.allowed_actions[0].condition, "after_user_confirms_goals");
  assert.equal(view.allowed_actions[0].requires_user_confirmation, true);
  assert.deepEqual(view.allowed_actions[0].required_input, ["title"]);
  assert.equal(view.next_action.after_user_confirms_goals, undefined);
  assert.equal(view.next_action.after_mission_create, undefined);
  assert.equal(JSON.stringify(view).includes("unclog --json"), false);

  const acted = await runtime.act({
    action_id: view.allowed_actions[0].action_id,
    input: { title: "Disposable capacity planner" }
  });
  assert.equal(acted.code, undefined, JSON.stringify(acted));
  const mutation = calls.find((row) => row.command === "mission.create");
  assert.equal(mutation.payload.title, "Disposable capacity planner");
});

test("confirmed mission-create authority survives a stateless next refresh at the same project version", async () => {
  const root = repository();
  const draftId = "D20260718-035800-c0ffee";
  const file = `.unclog-drafts/${draftId}/unclog_goals.json`;
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify({ goals: [] }));
  let version = 0;
  const mutations = [];
  const intakeEnvelope = () => envelope("next", {
    mission_id: "",
    project: { id: "project-1", projectVersion: version },
    next_action: { code: "GOAL_INTAKE_CONTINUE_LOCAL_DRAFT", message: "Lint the confirmed local draft." },
    commands_now: [`unclog --json goals lint --file "${file}"`]
  });
  const confirmationEnvelope = () => envelope("goals.lint", {
    mission_id: "",
    project: { id: "project-1", projectVersion: version },
    valid: true,
    next_action: {
      code: "GOAL_INTAKE_CONFIRM_DRAFT",
      message: "Create the mission only after user confirmation.",
      commands_now: [],
      after_user_confirms_goals: ['unclog --json mission create --title "Compact mission title"']
    },
    commands_now: []
  });
  const client = {
    async command(command, payload) {
      if (command === "next") return intakeEnvelope();
      if (command === "goals.lint") return confirmationEnvelope();
      if (command === "mission.create") {
        mutations.push({ command, payload });
        version += 1;
        return envelope(command, {
          mission_id: "M001",
          project: { id: "project-1", projectVersion: version },
          commands_now: []
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  };
  const runtime = createMcpRuntime(bridge, { workspaceRoot: root, client });

  const intake = await runtime.next();
  const linted = await runtime.act({ action_id: intake.allowed_actions[0].action_id });
  assert.equal(linted.allowed_actions[0].command, "mission.create");
  assert.equal(linted.allowed_actions[0].requires_user_confirmation, true);

  const created = await runtime.act({
    action_id: linted.allowed_actions[0].action_id,
    input: { title: "Disposable queue lab" }
  });
  assert.equal(created.code, undefined, JSON.stringify(created));
  assert.equal(created.mission_id, "M001");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].payload.expected_project_version, 0);
  assert.equal(mutations[0].payload.title, "Disposable queue lab");
});

test("unclog_act re-fetches authority, binds mission/action/version, and rejects stale or arbitrary input", async () => {
  const root = repository();
  const mutations = [];
  let version = 4;
  let currentCommand = 'unclog --mission M001 --json mission create --title "mission outcome"';
  const client = {
    async command(command, payload) {
      if (command === "next") {
        return envelope(command, {
          project: { id: "project-1", projectVersion: version },
          required_fields: ["title"],
          field_guide: { title: "One compact mission outcome." },
          commands_now: [currentCommand]
        });
      }
      mutations.push({ command, payload });
      version += 1;
      currentCommand = "unclog --mission M001 --json goals template --draft";
      return envelope(command, {
        project: { id: "project-1", projectVersion: version },
        next_action: { code: "DRAFT_GOALS", message: "Create the local intake draft." },
        commands_now: [currentCommand]
      });
    }
  };
  const runtime = createMcpRuntime(bridge, { workspaceRoot: root, client });
  const next = await runtime.next({ mission_id: "M001" });
  const actionId = next.allowed_actions[0].action_id;
  const missing = await runtime.act({ mission_id: "M001", action_id: actionId });
  assert.equal(missing.code, "mcp_action_input_required");
  assert.match(missing.message, /title/);
  assert.equal(mutations.length, 0);
  const acted = await runtime.act({ mission_id: "M001", action_id: actionId, input: { title: "Ship hosted MCP" } });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].command, "mission.create");
  assert.equal(mutations[0].payload.title, "Ship hosted MCP");
  assert.equal(mutations[0].payload.mission_id, "M001");
  assert.equal(mutations[0].payload.expected_project_version, 4);
  assert.equal(acted.executed_action_id, actionId);
  assert.equal(acted.allowed_actions[0].command, "goals.template");

  const stale = await runtime.act({ mission_id: "M001", action_id: actionId, input: { title: "Repeat" } });
  assert.equal(stale.code, "mcp_action_stale");
  assert.equal(mutations.length, 1);

  const current = await runtime.next({ mission_id: "M001" });
  const arbitrary = await runtime.act({ mission_id: "M001", action_id: current.allowed_actions[0].action_id, input: { token: "forbidden" } });
  assert.equal(arbitrary.code, "mcp_action_input_not_allowed");
  assert.equal(mutations.length, 1);
});

test("worker unclog_next retrieves only the focused packet for the bound lane", async () => {
  const root = repository();
  let observed = null;
  const runtime = createMcpRuntime(bridge, {
    workspaceRoot: root,
    client: {
      async command(command, payload) {
        observed = { command, payload };
        return envelope(command, {
          agent_id: "sub-1",
          packet_view: "focus",
          commands_now: ["unclog --mission M001 --json action-plan export --agent-id sub-1 --file unclog_actions_sub1.json"]
        });
      }
    }
  });
  const result = await runtime.next({ mission_id: "M001", agent_id: "sub-1" });
  assert.equal(observed.command, "agents.packet");
  assert.equal(observed.payload.agent_id, "sub-1");
  assert.equal(observed.payload.focus, true);
  assert.equal(result.packet_view, "focus");
  assert.equal(result.allowed_actions[0].command, "action-plan.export");
  assert.equal(JSON.stringify(result).includes("packet_command"), false);
});

test("MCP action applies only controlled draft effects inside the repository", async () => {
  const root = repository();
  const draftId = "D20260717-120003-c0ffee";
  const relative = `.unclog-drafts/${draftId}/unclog_goals.json`;
  const statusRelative = `.unclog-drafts/${draftId}/status.json`;
  const document = { goals: [], worker_lanes: { max_sub_agents: 6 } };
  const status = { draft_id: draftId, kind: "goals_intake", status: "intake", goals_file: "unclog_goals.json" };
  let created = false;
  const runtime = createMcpRuntime(bridge, {
    workspaceRoot: root,
    client: {
      async command(command) {
        if (command === "next") {
          return envelope(command, { commands_now: ["unclog --mission M001 --json goals template --draft"] });
        }
        created = true;
        const operations = [
          { op: "write_json", path: relative, document, sha256: artifactHash(document), before_sha256: null },
          { op: "write_json", path: statusRelative, document: status, sha256: artifactHash(status), before_sha256: null }
        ];
        return envelope(command, {
          commands_now: [],
          local_artifact_effects: {
            schema: "unclog-local-artifact-effects/1",
            effect_id: artifactHash(operations),
            operations
          }
        });
      }
    }
  });
  const next = await runtime.next({ mission_id: "M001" });
  const result = await runtime.act({ mission_id: "M001", action_id: next.allowed_actions[0].action_id });
  assert.equal(created, true);
  assert.equal(result.code, undefined, JSON.stringify(result));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")), document);
  assert.equal(result.local_artifacts.applied, 2);
  assert.equal(fs.existsSync(path.join(root, ".unclog", "state.json")), false);
});

test("fresh intake transitions from create to exact local draft actions without a list loop", async () => {
  const root = repository();
  const draftId = "D20260718-031500-a11ce0";
  const file = `.unclog-drafts/${draftId}/unclog_goals.json`;
  const statusFile = `.unclog-drafts/${draftId}/status.json`;
  const document = { goals: [], ui_ux_parity_gate: { required: false, reasoning: "Non-visual regression." } };
  const status = {
    draft_id: draftId,
    kind: "goals_intake",
    status: "intake",
    mission_id: null,
    goals_file: "unclog_goals.json",
    created_at: "2026-07-17T19:15:00Z",
    updated_at: "2026-07-17T19:15:00Z"
  };
  const client = {
    async command(command, payload) {
      if (command === "next") {
        const entries = payload?.local_artifacts?.entries || [];
        if (!entries.some((entry) => entry.path === statusFile)) {
          return envelope(command, {
            mission_id: "",
            next_action: { code: "GOAL_INTAKE_OR_CREATE_MISSION", message: "Create a local draft." },
            commands_now: ["unclog --json goals template --draft"]
          });
        }
        return envelope(command, {
          mission_id: "",
          next_action: {
            code: "GOAL_INTAKE_CONTINUE_LOCAL_DRAFT",
            message: "Edit the exact matching local draft, call unclog_next again, then lint it.",
            commands_now: [],
            local_drafts: [{ draft_id: draftId, file, status_file: statusFile, editable: true }],
            local_draft_actions: [{
              command: `unclog --json goals lint --file "${file}"`,
              condition: "after_editing_this_matching_draft",
              draft_id: draftId,
              file
            }],
            create_new_action: {
              command: "unclog --json goals template --draft",
              condition: "only_if_no_local_draft_matches_current_request"
            }
          },
          commands_now: []
        });
      }
      if (command === "goals.template") {
        const operations = [
          { op: "write_json", path: statusFile, document: status, sha256: artifactHash(status), before_sha256: null },
          { op: "write_json", path: file, document, sha256: artifactHash(document), before_sha256: null }
        ];
        return envelope(command, {
          mission_id: "",
          draft_id: draftId,
          file,
          status_file: statusFile,
          commands_now: [],
          local_artifact_effects: {
            schema: "unclog-local-artifact-effects/1",
            effect_id: artifactHash(operations),
            operations
          }
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  };
  const runtime = createMcpRuntime(bridge, { workspaceRoot: root, client });

  const first = await runtime.next();
  assert.deepEqual(first.allowed_actions.map((row) => row.command), ["goals.template"]);
  const createActionId = first.allowed_actions[0].action_id;
  const created = await runtime.act({ action_id: createActionId });
  assert.equal(created.local_artifacts.applied, 2);
  assert.equal(created.file, file);

  const resumed = await runtime.next();
  assert.equal(resumed.next_action.code, "GOAL_INTAKE_CONTINUE_LOCAL_DRAFT");
  assert.equal(resumed.next_action.local_drafts[0].file, file);
  assert.deepEqual(resumed.allowed_actions.map((row) => row.command), ["goals.lint", "goals.template"]);
  assert.deepEqual(resumed.allowed_actions[0], {
    action_id: resumed.allowed_actions[0].action_id,
    command: "goals.lint",
    gate: resumed.allowed_actions[0].gate,
    required_input: [],
    field_guide: {},
    proof_required: resumed.allowed_actions[0].proof_required,
    condition: "after_editing_this_matching_draft",
    draft_id: draftId,
    file
  });
  assert.equal(resumed.allowed_actions[1].condition, "only_if_no_local_draft_matches_current_request");
  assert.equal(JSON.stringify(resumed).includes("unclog --json"), false);
  assert.equal(JSON.stringify(resumed).includes("drafts.list"), false);

  const stale = await runtime.act({ action_id: createActionId });
  assert.equal(stale.code, "mcp_action_stale");
});

test("unclog_wait is bounded and returns only after hosted state changes", async () => {
  const root = repository();
  let clock = 0;
  let reads = 0;
  const runtime = createMcpRuntime(bridge, {
    workspaceRoot: root,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    client: {
      async command(command) {
        reads += 1;
        const changed = reads >= 2;
        return envelope(command, {
          project: { id: "project-1", projectVersion: changed ? 2 : 1 },
          next_action: { code: changed ? "WORKER_READY" : "WORKER_THREAD_HANDOFF_REQUIRED", message: "Hosted transition." },
          commands_now: changed ? ["unclog --mission M001 --json agents status"] : []
        });
      }
    }
  });
  const result = await runtime.wait({ mission_id: "M001", wait_for_change: true, timeout_seconds: 10, poll_interval_ms: 500 });
  assert.equal(result.changed, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.allowed_actions[0].command, "agents.status");
  assert.ok(clock <= 10_000);
});

test("official MCP SDK client sees exactly three tools and server instructions", async () => {
  const root = repository();
  const fakeClient = {
    async command(command) {
      return envelope(command, { commands_now: [] });
    }
  };
  const { server } = createMcpServer(bridge, { workspaceRoot: root, client: fakeClient, version: "1.1.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sdkClient = new Client({ name: "unclog-contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), sdkClient.connect(clientTransport)]);
  const tools = await sdkClient.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["unclog_act", "unclog_next", "unclog_wait"]);
  assert.equal(sdkClient.getInstructions(), MCP_INSTRUCTIONS);
  const next = await sdkClient.callTool({ name: "unclog_next", arguments: { mission_id: "M001" } });
  assert.equal(next.isError, undefined);
  assert.equal(next.structuredContent.transport.kind, "local_stdio_mcp");
  await sdkClient.close();
  await server.close();
});
