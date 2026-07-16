const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const PACKAGE_ROOT = path.resolve(__dirname, "..");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npmSync(args, options) {
  return spawnSync(npmCommand(), args, {
    ...options,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
}

function runCli(script, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function hostedCommandEnvelope(command, extra = {}) {
  return {
    allowed: true,
    blocked: false,
    status: "OK",
    command,
    command_status: { supported: true, classification: "hosted" },
    local_contract: { responseKeys: ["status", "next_action", "commands_now"] },
    next_action: { code: "HOSTED_STEP_READY", message: "Continue the hosted mission." },
    commands_now: [],
    ...extra
  };
}

function recursiveFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? recursiveFiles(full) : [full];
  });
}

test("packed customer CLI completes and recovers a hosted-only mission, writes output, and revokes", { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unclog-clean-customer-"));
  const packDir = path.join(root, "pack");
  const installDir = path.join(root, "install");
  const homeDir = path.join(root, "home");
  const customerRepo = path.join(root, "customer-repo");
  const npmEnv = {
    ...process.env,
    NPM_CONFIG_CACHE: path.join(root, "npm-cache")
  };
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(customerRepo, { recursive: true });
  fs.mkdirSync(path.join(customerRepo, ".git"));

  const packed = npmSync(["pack", "--json", "--pack-destination", packDir], {
    cwd: PACKAGE_ROOT,
    env: npmEnv
  });
  assert.equal(packed.status, 0, packed.stderr);
  const packReport = JSON.parse(packed.stdout);
  const tarball = path.join(packDir, packReport[0].filename);
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  const extracted = spawnSync("tar", ["-xf", tarball, "-C", extractDir], { cwd: root, encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  const installedPackageDir = path.join(installDir, "node_modules", "unclog-bridge");
  fs.mkdirSync(path.dirname(installedPackageDir), { recursive: true });
  fs.renameSync(path.join(extractDir, "package"), installedPackageDir);
  const cli = path.join(installDir, "node_modules", "unclog-bridge", "src", "index.js");
  assert.equal(fs.existsSync(cli), true);

  const hosted = {
    approved: true,
    mission: null,
    goalsLocked: false,
    planSubmitted: false,
    actionAccepted: false,
    setSubmitted: false,
    commands: [],
    payloads: [],
    sessionToken: null
  };
  const server = http.createServer(async (request, response) => {
    try {
      const body = await readJsonRequest(request);
      if (request.url === "/v1/bridge/device/authorize") {
        sendJson(response, 200, {
          status: "authorization_pending",
          device_code: body.device_code,
          user_code: body.user_code,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          interval: 0,
          project_id: "proj_clean"
        });
        return;
      }
      if (request.url === "/v1/bridge/device/token") {
        hosted.sessionToken = body.session_token;
        sendJson(response, 200, {
          status: "approved",
          session_id: "00000000-0000-4000-8000-000000000001",
          project_id: "proj_clean",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          token_type: "Bearer"
        });
        return;
      }
      const authorization = request.headers.authorization;
      if (authorization !== `Bearer ${hosted.sessionToken}`) {
        sendJson(response, 401, { allowed: false, code: "unclog_auth_required", message: "Sign in." });
        return;
      }
      if (request.url === "/v1/bridge/session/revoke") {
        hosted.approved = false;
        sendJson(response, 200, {
          allowed: true,
          status: "OK",
          revoked: true,
          command: "bridge.session-revoke",
          device: { id: "00000000-0000-4000-8000-000000000001", state: "revoked", projectId: body.project_id }
        });
        return;
      }
      if (!hosted.approved) {
        sendJson(response, 403, { allowed: false, code: "bridge_device_not_approved", message: "Log in again." });
        return;
      }
      if (request.url === "/v1/bridge/project-link") {
        sendJson(response, 200, {
          allowed: true,
          blocked: false,
          status: "OK",
          linked: true,
          command: "bridge.project-link",
          project: { id: body.project_id, name: "Clean hosted project", status: "active", projectVersion: 1 },
          device: { id: "00000000-0000-4000-8000-000000000001", label: "Clean install", state: "approved", projectId: body.project_id },
          dashboard_probe: { dashboard_state: "ready", device_count: 1, monitor_unlocked: true },
          monitor_probe: { source_status: "ready", selectedProjectId: body.project_id, monitorStateKind: "active" },
          source: { kind: "hosted-api", serverOwnedLink: true, supabaseBacked: true },
          next_action: { code: "BRIDGE_PROJECT_LINKED", commands_now: [] },
          commands_now: []
        });
        return;
      }
      if (request.url !== "/v1/bridge/commands") {
        sendJson(response, 404, { allowed: false, code: "not_found" });
        return;
      }
      const command = body.command;
      hosted.commands.push(command);
      hosted.payloads.push({ command, payload: body.payload });
      if (command === "mission.create") hosted.mission = { id: "M001", status: "active" };
      if (command === "goals.lock") hosted.goalsLocked = true;
      if (command === "action-plan.submit") hosted.planSubmitted = true;
      if (command === "action.check") hosted.actionAccepted = true;
      if (command === "set.submit") hosted.setSubmitted = true;
      if (command === "mission.validate") hosted.mission.status = "validated_done";
      const generated = command === "goals.template"
        ? { generated_file: { name: "ignored-server-name.json", content: { mission_id: "M001", goals: [] } } }
        : {};
      sendJson(response, 200, hostedCommandEnvelope(command, {
        mission_id: hosted.mission && hosted.mission.id,
        mission: hosted.mission,
        ...generated
      }));
    } catch (error) {
      sendJson(response, 500, { allowed: false, code: "test_server_error", message: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    UNCLOG_BRIDGE_HOME: path.join(homeDir, "bridge"),
    UNCLOG_BRIDGE_ALLOW_LOCAL_HTTP: "true",
    UNCLOG_BRIDGE_ALLOW_INSECURE_TEST_SECRET_STORE: "true",
    UNCLOG_API_URL: apiBaseUrl
  };
  const run = async (...args) => {
    const result = await runCli(cli, args, { cwd: customerRepo, env });
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };

  try {
    const connected = await run(
      "connect", "--tool", "codex", "--setup-intent", `UC_${"C".repeat(32)}`,
      "--api-base-url", apiBaseUrl
    );
    assert.equal(connected.status, "connected");
    assert.equal(connected.project.id, "proj_clean");
    await run("mission", "create", "--title", "Hosted-only mission");
    await run("goals", "lock", "--mission", "M001");

    const planFile = path.join(customerRepo, "plan.json");
    const proofFile = path.join(customerRepo, "proof.json");
    const closeoutFile = path.join(customerRepo, "closeout.json");
    const finalReviewFile = path.join(customerRepo, "review-final.json");
    fs.writeFileSync(planFile, JSON.stringify({
      selected_small_goal_ids: ["G002"],
      actions: [{ id: "A000", text: "Hosted action set", children: [{
        id: "A001",
        goal_id: "G003",
        text: "Deliver exact hosted Tiny Goal",
        validation_plan: {
          schema: "small-action-validation-plan/1",
          policy_revision: "minimum-sufficient/1",
          goal_id: "G003",
          primary_check: { id: "V1", method: "direct_observation", target: "hosted outcome", procedure: "observe the exact hosted outcome directly", expected_signal: "hosted outcome is visible", covers: ["C1"] },
          why_sufficient: "A direct observation is sufficient for this isolated outcome.",
          stop_when: "Stop after the expected signal is directly observed.",
          scope_limit: "Do not broaden validation without an explicit trigger.",
          escalation_ladder: []
        },
        children: [{ id: "A002", text: "Execute hosted change" }]
      }] }]
    }));
    fs.writeFileSync(proofFile, JSON.stringify({
      schema: "small-action-proof/2",
      action_id: "A001",
      completed_tiny_actions: [{ action_id: "A002", summary: "Hosted change executed." }],
      validation_result: {
        schema: "small-action-validation-result/1",
        policy_revision: "minimum-sufficient/1",
        validation_plan_hash: "hosted-plan-hash",
        evidence: [{ id: "E1", check_id: "V1", origin: "primary", kind: "direct_observation", observed: "Hosted outcome was visible.", references: ["hosted:outcome"], covers: ["C1"] }],
        escalation: { triggered: false, trigger_observations: [] },
        decision: "pass",
        sufficiency_reason: "The direct signal covered the complete isolated claim."
      },
      proof: "hosted evidence"
    }));
    fs.writeFileSync(closeoutFile, JSON.stringify({
      closeout_sweep: {
        schema: "small-goal-closeout/2",
        integration_result: {
          interactions_checked: [], contradictions: [], unresolved_escalations: [], new_findings: [],
          none_required_reason: "Only one independent action exists in this hosted Small Goal.", decision: "pass"
        }
      },
      small_goal_summaries: [{ goal_id: "G002", human_summary: "Hosted Small Goal completed." }]
    }));
    fs.writeFileSync(finalReviewFile, JSON.stringify({ stage: "final", goal_id: "G002" }));
    await run("action_plan", "submit", "--file", planFile, "--mission", "M001");
    await run("action", "check", "A001", "--file", proofFile, "--mission", "M001");
    await run(
      "set", "submit", "--summary", "done", "--proof", "hosted evidence",
      "--closeout-sweep-file", closeoutFile, "--review-lifecycle-file", finalReviewFile, "--mission", "M001"
    );
    await run("recover", "--mission", "M001");
    await run("mission", "validate", "--mission", "M001");

    const outputFile = path.join(customerRepo, "generated", "goals.json");
    const outputResponse = await run("goals", "template", "--file", outputFile, "--mission", "M001");
    assert.equal(outputResponse.local_output.path, path.resolve(outputFile));
    assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, "utf8")), { mission_id: "M001", goals: [] });
    assert.equal(hosted.mission.status, "validated_done");
    assert.equal(hosted.goalsLocked && hosted.planSubmitted && hosted.actionAccepted && hosted.setSubmitted, true);
    const submittedSetPayload = hosted.payloads.find((item) => item.command === "set.submit").payload;
    assert.equal(submittedSetPayload.review_lifecycle.stage, "final");
    assert.equal(submittedSetPayload.review_lifecycle.goal_id, "G002");
    assert.equal(submittedSetPayload.cli_argv.includes("--review-lifecycle-file"), false);
    assert.equal(JSON.stringify(submittedSetPayload.cli_argv).includes(finalReviewFile), false);
    const submittedPlanPayload = hosted.payloads.find((item) => item.command === "action-plan.submit").payload;
    const submittedProofPayload = hosted.payloads.find((item) => item.command === "action.check").payload;
    assert.equal(submittedPlanPayload.workflow_document.actions[0].children[0].validation_plan.schema, "small-action-validation-plan/1");
    assert.equal(submittedProofPayload.workflow_document.schema, "small-action-proof/2");
    assert.equal(submittedSetPayload.closeout_sweep.closeout_sweep.schema, "small-goal-closeout/2");

    const sessionFile = path.join(homeDir, "bridge", "session.json");
    assert.equal(fs.existsSync(sessionFile), true);
    assert.equal(fs.existsSync(path.join(customerRepo, ".unclog", "state.json")), false);
    const installedPackage = path.dirname(path.dirname(cli));
    const installedSource = recursiveFiles(installedPackage)
      .filter((file) => /\.(js|json)$/i.test(file))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    for (const forbidden of ["SUPABASE_SERVICE_ROLE_KEY", "codex-tools/unclog", "unclog_lib", "hosted_workflow.py"]) {
      assert.equal(installedSource.includes(forbidden), false, forbidden);
    }
    assert.equal(installedSource.toLowerCase().includes("electron"), false);

    const loggedOut = await run("logout");
    assert.equal(loggedOut.serverRevoked, true);
    assert.equal(hosted.approved, false);
    assert.equal(fs.existsSync(sessionFile), false);
    const afterLogout = await runCli(cli, ["recover", "--mission", "M001"], { cwd: customerRepo, env });
    assert.equal(afterLogout.status, 1);
    assert.match(afterLogout.stderr, /auth|login/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
