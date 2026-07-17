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
