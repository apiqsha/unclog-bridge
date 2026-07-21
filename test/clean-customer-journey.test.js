const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const { connectWithSetupIntent } = require("../src/index");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const BRIDGE_ENTRY = path.join(PACKAGE_ROOT, "src", "index.js");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function effect(operations) {
  return { schema: "unclog-local-artifact-effects/1", effect_id: hash(operations), operations };
}

function commandEnvelope(state, command, extra = {}) {
  return {
    allowed: true,
    blocked: false,
    status: "OK",
    command,
    command_status: { supported: true, classification: "hosted" },
    local_contract: { response_keys: ["status", "next_action", "commands_now"] },
    project: { id: "project-clean", name: "Clean hosted project", projectVersion: state.version },
    mission_id: state.missionId,
    next_action: { code: "HOSTED_STEP_READY", message: "Continue through the current MCP action." },
    commands_now: [],
    agent_instruction: {
      schema: "unclog-agent-instruction/2",
      instruction_id: `UGI_${state.phase}_${state.version}`,
      phase: state.phase,
      authority: "hosted_unclog_server",
      guidance_sha256: hash({ phase: state.phase }),
      guidance_markdown: "Use only the installed Unclog MCP tools and the current server-authorized action.",
      transport: {
        kind: "official_thin_mcp_bridge",
        private_local_cli_allowed: false,
        canonical_command_notation_only: true,
        executable_actions_field: "allowed_actions",
        local_editable_roots: [".unclog-drafts"]
      }
    },
    ...extra
  };
}

function currentEnvelope(state, command, actor = {}) {
  const mission = state.missionId || "M001";
  const draft = `.unclog-drafts/${state.draftId}/unclog_goals.json`;
  const plan = "unclog_actions_sub1.json";
  const proof = "unclog_proof_a001.json";
  const closeout = "unclog_checks_sub1.json";
  const managerCommands = {
    mission: ['unclog --json mission create --title "mission outcome"'],
    draft: [`unclog --mission ${mission} --json goals template --draft`],
    lock: [`unclog --mission ${mission} --json goals lock --file ${draft}`],
    spawn: [`unclog --mission ${mission} --json agents spawn --capacity 1`],
    wait_worker: [],
    validate: [`unclog --mission ${mission} --json mission validate`],
    done: []
  };
  if (!actor.agent_id) {
    const code = state.phase === "wait_worker" ? "WORKER_THREAD_HANDOFF_REQUIRED" : state.phase === "done" ? "MISSION_VALIDATED" : "MANAGER_ACTION_READY";
    return commandEnvelope(state, command, {
      next_action: { code, message: code === "WORKER_THREAD_HANDOFF_REQUIRED" ? "The separate worker owns implementation now." : "Continue the manager workflow." },
      required_fields: state.phase === "mission" ? ["title"] : [],
      commands_now: managerCommands[state.phase] || []
    });
  }
  const workerCommands = {
    worker_plan: [`unclog --mission ${mission} --json action-plan submit --agent-id sub-1 --file ${plan}`],
    worker_proof: [`unclog --mission ${mission} --json action check A001 --agent-id sub-1 --file ${proof}`],
    worker_review: [`unclog --mission ${mission} --json action revise A001 --agent-id sub-1 --decision accept_current --reasoning "compact proof audit"`],
    worker_closeout: [`unclog --mission ${mission} --json set submit --agent-id sub-1 --summary "done" --proof "hosted evidence" --closeout-sweep-file ${closeout} --review-lifecycle-file unclog_review_final_sub1.json`],
    validate: [],
    done: []
  };
  return commandEnvelope(state, command, {
    agent_id: "sub-1",
    packet_view: "focus",
    packet_status: "ready",
    current_assigned_scope: { id: "G001", lines: ["G001: Complete the customer outcome"] },
    agent_progress: { status: state.phase === "validate" || state.phase === "done" ? "done" : "active" },
    completion_contract: { done_condition: "agent_progress.status == done" },
    required_fields: state.phase === "worker_review" ? ["decision", "reasoning"] : state.phase === "worker_closeout" ? ["summary", "proof", "closeout_sweep_file"] : [],
    commands_now: workerCommands[state.phase] || []
  });
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startHostedFixture(state) {
  const server = http.createServer(async (request, response) => {
    const body = await readRequest(request);
    if (request.url === "/v1/bridge/device/authorize") {
      send(response, 200, {
        status: "authorization_pending",
        device_code: body.device_code,
        user_code: body.user_code,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        interval: 0,
        project_id: "project-clean"
      });
      return;
    }
    if (request.url === "/v1/bridge/device/token") {
      send(response, 200, {
        status: "approved",
        session_id: "00000000-0000-4000-8000-000000000101",
        project_id: "project-clean",
        expires_at: new Date(Date.now() + 60_000).toISOString()
      });
      return;
    }
    if (request.url === "/v1/bridge/project-link") {
      send(response, 200, {
        allowed: true,
        blocked: false,
        status: "OK",
        linked: true,
        command: "bridge.project-link",
        project: { id: "project-clean", name: "Clean hosted project", status: "active", projectVersion: state.version },
        device: { id: "00000000-0000-4000-8000-000000000101", label: "Generic MCP", state: "approved", projectId: "project-clean" },
        dashboard_probe: { dashboard_state: "ready", device_count: 1, monitor_unlocked: true },
        monitor_probe: { source_status: "ready", selectedProjectId: "project-clean", monitorStateKind: "active" },
        source: { serverOwnedLink: true, supabaseBacked: true },
        next_action: { code: "BRIDGE_PROJECT_LINKED" },
        commands_now: []
      });
      return;
    }
    if (request.url === "/v1/bridge/session/revoke") {
      state.revoked = true;
      send(response, 200, { allowed: true, revoked: true });
      return;
    }
    if (request.url !== "/v1/bridge/commands") {
      send(response, 404, { code: "not_found" });
      return;
    }

    const command = body.command;
    const payload = body.payload || {};
    state.calls.push({ command, payload });
    const actor = { agent_id: payload.agent_id };
    if (command === "next" || command === "agents.packet") {
      if (command === "agents.packet") {
        state.workerAcknowledged = true;
        if (state.phase === "wait_worker") state.phase = "worker_plan";
      }
      send(response, 200, currentEnvelope(state, command, actor));
      return;
    }
    if (payload.expected_project_version !== state.version) {
      send(response, 409, { allowed: false, blocked: true, code: "project_version_conflict", message: "Refresh current state." });
      return;
    }

    let local_artifact_effects;
    if (command === "mission.create") {
      state.missionId = "M001";
      state.phase = "draft";
    } else if (command === "goals.template") {
      const draftPath = `.unclog-drafts/${state.draftId}/unclog_goals.json`;
      const statusPath = `.unclog-drafts/${state.draftId}/status.json`;
      const draft = { goals: [], worker_lanes: { max_sub_agents: 1 } };
      const status = { draft_id: state.draftId, kind: "goals_intake", status: "intake", goals_file: "unclog_goals.json" };
      const operations = [
        { op: "write_json", path: draftPath, document: draft, sha256: hash(draft), before_sha256: null },
        { op: "write_json", path: statusPath, document: status, sha256: hash(status), before_sha256: null }
      ];
      local_artifact_effects = effect(operations);
      state.phase = "lock";
    } else if (command === "goals.lock") {
      assert.equal(payload.workflow_file_path, `.unclog-drafts/${state.draftId}/unclog_goals.json`);
      state.goalDocumentReceived = Boolean(payload.workflow_document);
      state.phase = "spawn";
    } else if (command === "agents.spawn") {
      state.phase = "wait_worker";
    } else if (command === "action-plan.submit") {
      state.planReceived = payload.workflow_document?.schema === "action-plan/2";
      state.phase = "worker_proof";
    } else if (command === "action.check") {
      state.proofReceived = payload.workflow_document?.schema === "small-action-proof/2";
      state.phase = "worker_review";
    } else if (command === "action.revise") {
      assert.equal(payload.decision, "accept_current");
      state.phase = "worker_closeout";
    } else if (command === "set.submit") {
      state.closeoutReceived = payload.closeout_sweep?.closeout_sweep?.schema === "small-goal-closeout/2";
      state.phase = "validate";
    } else if (command === "mission.validate") {
      state.phase = "done";
      state.validated = true;
    }
    state.version += 1;
    const responseBody = currentEnvelope(state, command, actor);
    if (command === "agents.spawn") {
      responseBody.worker_handoffs = [{
        mission_id: "M001",
        agent_id: "sub-1",
        role: "implementation",
        first_prompt: "Use the installed Unclog MCP. Call unclog_next with mission_id M001, agent_id sub-1, and focus true."
      }];
      responseBody.handoff_required = true;
    }
    if (local_artifact_effects) responseBody.local_artifact_effects = local_artifact_effects;
    send(response, 200, responseBody);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function toolValue(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}

test("fresh customer connects once then completes manager, cold-worker, proof, closeout, and final validation through MCP", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unclog-clean-mcp-"));
  const customerRepo = path.join(root, "customer-repo");
  const homeDir = path.join(root, "home");
  const bridgeHome = path.join(root, "bridge-home");
  fs.mkdirSync(path.join(customerRepo, ".git"), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const state = {
    phase: "mission",
    version: 1,
    missionId: null,
    draftId: "D20260717-120003-c0ffee",
    calls: [],
    workerAcknowledged: false,
    validated: false,
    revoked: false
  };
  const server = await startHostedFixture(state);
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const previous = {
    home: process.env.UNCLOG_BRIDGE_HOME,
    local: process.env.UNCLOG_BRIDGE_ALLOW_LOCAL_HTTP,
    secret: process.env.UNCLOG_BRIDGE_ALLOW_INSECURE_TEST_SECRET_STORE
  };
  process.env.UNCLOG_BRIDGE_HOME = bridgeHome;
  process.env.UNCLOG_BRIDGE_ALLOW_LOCAL_HTTP = "true";
  process.env.UNCLOG_BRIDGE_ALLOW_INSECURE_TEST_SECRET_STORE = "true";
  let sdkClient;
  try {
    const connected = await connectWithSetupIntent(
      ["--tool", "generic", "--setup-intent", `UC_${"C".repeat(32)}`, "--api-base-url", apiUrl],
      {
        cwd: customerRepo,
        homeDir,
        bridgeHome,
        runtimeEntry: BRIDGE_ENTRY,
        pollIntervalMs: 1,
        openBrowser: false,
        sessionOptions: { storageDir: bridgeHome, cwd: customerRepo, allowLocalHttp: true }
      }
    );
    assert.equal(connected.ok, true);
    assert.equal(connected.mcp.persistent, true);
    assert.equal(connected.shell_commands_required_after_setup, false);
    assert.equal(fs.existsSync(path.join(bridgeHome, "mcp.json")), true);
    assert.equal(fs.existsSync(path.join(customerRepo, ".unclog", "state.json")), false);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BRIDGE_ENTRY, "mcp", "--workspace", customerRepo],
      env: {
        ...process.env,
        UNCLOG_BRIDGE_HOME: bridgeHome,
        UNCLOG_BRIDGE_ALLOW_LOCAL_HTTP: "true",
        UNCLOG_BRIDGE_ALLOW_INSECURE_TEST_SECRET_STORE: "true"
      },
      stderr: "pipe"
    });
    sdkClient = new Client({ name: "clean-customer", version: "1.0.0" });
    await sdkClient.connect(transport);

    async function next(actor = {}) {
      return toolValue(await sdkClient.callTool({ name: "unclog_next", arguments: actor }));
    }
    async function act(view, actor = {}, input = {}) {
      assert.equal(view.allowed_actions.length, 1, JSON.stringify(view));
      return toolValue(await sdkClient.callTool({
        name: "unclog_act",
        arguments: { ...actor, action_id: view.allowed_actions[0].action_id, ...(Object.keys(input).length ? { input } : {}) }
      }));
    }

    let manager = await next();
    manager = await act(manager, {}, { title: "Prove hosted Unclog MCP end to end" });
    manager = await act(manager);
    const draftFile = path.join(customerRepo, `.unclog-drafts/${state.draftId}/unclog_goals.json`);
    assert.equal(fs.existsSync(draftFile), true);
    fs.writeFileSync(draftFile, JSON.stringify({ goals: [{ id: "G001", text: "Complete the outcome", children: [] }], worker_lanes: { max_sub_agents: 1 } }));
    manager = await act(manager);
    manager = await act(manager);
    assert.equal(manager.handoff_required, true);
    assert.match(manager.worker_handoffs[0].first_prompt, /Call unclog_next/);
    assert.equal(JSON.stringify(manager).includes("npx"), false);

    const workerActor = { mission_id: "M001", agent_id: "sub-1", focus: true };
    let worker = await next(workerActor);
    assert.equal(worker.packet_view, "focus");
    assert.equal(state.workerAcknowledged, true);
    const planFile = path.join(customerRepo, "unclog_actions_sub1.json");
    fs.writeFileSync(planFile, JSON.stringify({
      schema: "action-plan/2",
      selected_small_goal_ids: ["G001"],
      actions: [{ id: "A000", text: "Deliver outcome", children: [{ id: "A001", goal_id: "G001", text: "Implement", children: [{ id: "A002", text: "Make change" }] }] }]
    }));
    worker = await act(worker, workerActor);
    const proofFile = path.join(customerRepo, "unclog_proof_a001.json");
    fs.writeFileSync(proofFile, JSON.stringify({
      schema: "small-action-proof/2",
      action_id: "A001",
      completed_tiny_actions: [{ action_id: "A002", summary: "Change completed." }],
      validation_result: { schema: "small-action-validation-result/1", decision: "pass" }
    }));
    worker = await act(worker, workerActor);
    worker = await act(worker, workerActor, { decision: "accept_current", reasoning: "Proof directly satisfies the locked goal contract." });
    const closeoutFile = path.join(customerRepo, "unclog_checks_sub1.json");
    fs.writeFileSync(closeoutFile, JSON.stringify({
      closeout_sweep: {
        schema: "small-goal-closeout/2",
        integration_result: { interactions_checked: [], contradictions: [], unresolved_escalations: [], new_findings: [], none_required_reason: "Single isolated outcome.", decision: "pass" }
      }
    }));
    fs.writeFileSync(path.join(customerRepo, "unclog_review_final_sub1.json"), JSON.stringify({ stage: "final", goal_id: "G001" }));
    worker = await act(worker, workerActor, { summary: "Outcome complete", proof: "Focused proof passed" });
    assert.equal(worker.agent_progress.status, "done");

    manager = await next({ mission_id: "M001" });
    assert.equal(manager.allowed_actions[0].command, "mission.validate");
    manager = await act(manager, { mission_id: "M001" }, {
      summary: "The clean hosted customer lifecycle completed successfully.",
      proof: "Accepted action proof and closeout evidence passed."
    });
    assert.equal(state.validated, true);
    assert.equal(manager.next_action.code, "MISSION_VALIDATED");
    assert.equal(state.goalDocumentReceived, true);
    assert.equal(state.planReceived, true);
    assert.equal(state.proofReceived, true);
    assert.equal(state.closeoutReceived, true);
    assert.equal(state.calls.some((row) => row.command === "action.check" && row.payload.expected_project_version >= 1), true);
    assert.equal(state.calls.some((row) => JSON.stringify(row.payload).includes("session_token")), false);
    assert.equal(fs.existsSync(path.join(customerRepo, ".unclog", "state.json")), false);
  } finally {
    if (sdkClient) await sdkClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (previous.home === undefined) delete process.env.UNCLOG_BRIDGE_HOME; else process.env.UNCLOG_BRIDGE_HOME = previous.home;
    if (previous.local === undefined) delete process.env.UNCLOG_BRIDGE_ALLOW_LOCAL_HTTP; else process.env.UNCLOG_BRIDGE_ALLOW_LOCAL_HTTP = previous.local;
    if (previous.secret === undefined) delete process.env.UNCLOG_BRIDGE_ALLOW_INSECURE_TEST_SECRET_STORE; else process.env.UNCLOG_BRIDGE_ALLOW_INSECURE_TEST_SECRET_STORE = previous.secret;
  }
});
