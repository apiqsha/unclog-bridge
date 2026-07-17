const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const MCP_INSTRUCTIONS = [
  "Hosted Unclog is the workflow authority; this local MCP server is only a thin authenticated transport and controlled .unclog-drafts adapter.",
  "Always call unclog_next first. Execute only an action_id returned in allowed_actions through unclog_act.",
  "Never run npx, a bare unclog command, a private/local Unclog CLI, or edit .unclog.",
  "Use unclog_wait only for an approval, handoff, or external transition. Continue until the server reports the assigned outcome complete.",
  "Unconfirmed goal intake remains local under .unclog-drafts and is sent only by the explicit server-authorized submit action."
].join(" ");

const STRIPPED_COMMAND_KEYS = new Set([
  "after_handoff_command",
  "after_mission_create",
  "after_user_confirms_goals",
  "block_command",
  "blocked_command",
  "bridge_commands_now",
  "cli_argv",
  "closeout_lint_command",
  "closeout_template_command",
  "command",
  "commands_now",
  "focus_packet_command",
  "full_packet_command",
  "if_needed",
  "manager_status_command",
  "next_packet_command",
  "normal_unclog_flow",
  "packet_command",
  "proof_file_command",
  "proof_lint_command",
  "proof_submit_command",
  "proof_template_command",
  "revise_command",
  "safe_commands",
  "status_command",
  "submit_command"
]);

const RESERVED_INPUT_KEYS = new Set([
  "action_id", "actor_id", "agent_id", "cli_argv", "command", "device_id", "expected_project_version",
  "idempotency_key", "local_artifacts", "mission_id", "project_id", "project_version",
  "repository", "session_token", "source", "token", "workflow_document"
]);

const BLOCKED_MCP_COMMANDS = new Set(["mission.abandon", "goals.delete"]);
const COMMAND_BOUND_FILE_FIELDS = new Set(["closeout_sweep_file", "file", "goal_contract_file", "review_lifecycle_file"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function tokenizeCommand(text) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of String(text || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaped || quote) {
    const error = new Error("Hosted Unclog returned an invalid action command.");
    error.code = "mcp_action_command_invalid";
    throw error;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandTokens(raw) {
  const tokens = tokenizeCommand(raw);
  if (tokens[0] === "npx" || tokens[0] === "npm") {
    const error = new Error("Hosted Unclog MCP actions may not invoke npm or npx.");
    error.code = "mcp_shell_transport_forbidden";
    throw error;
  }
  if (tokens[0] === "unclog") tokens.shift();
  return tokens;
}

function commandName(raw, supportedCommands) {
  const tokens = commandTokens(raw).map((value) => String(value).toLowerCase());
  const matches = [];
  for (const command of supportedCommands) {
    const parts = String(command).split(".");
    for (let index = 0; index <= tokens.length - parts.length; index += 1) {
      if (parts.every((part, offset) => tokens[index + offset] === part)) {
        matches.push({ command, length: parts.length, index });
        break;
      }
    }
  }
  matches.sort((left, right) => right.length - left.length || left.index - right.index || left.command.localeCompare(right.command));
  if (!matches.length) {
    const error = new Error("Hosted Unclog returned an action outside the public bridge contract.");
    error.code = "mcp_action_unknown";
    throw error;
  }
  return matches[0].command;
}

function projectVersion(result) {
  for (const value of [
    result?.project?.projectVersion,
    result?.project?.project_version,
    result?.next_project_version,
    result?.expected_project_version,
    result?.refresh?.project_version
  ]) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function currentCommandEntries(result) {
  const top = Array.isArray(result?.commands_now) ? result.commands_now : [];
  const nested = Array.isArray(result?.next_action?.commands_now) ? result.next_action.commands_now : [];
  const blockerActions = [];
  const confirmationActions = result?.next_action?.code === "GOAL_INTAKE_CONFIRM_DRAFT"
    && Array.isArray(result?.next_action?.after_user_confirms_goals)
    ? result.next_action.after_user_confirms_goals
    : [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (["block_command", "blocked_command"].includes(key) && typeof child === "string" && child.trim()) {
        blockerActions.push(child);
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  };
  visit(result);
  const entries = [];
  const seen = new Set();
  for (const [values, auxiliary, condition] of [
    [[...top, ...nested], false, null],
    [blockerActions, true, null],
    [confirmationActions, true, "after_user_confirms_goals"]
  ]) {
    for (const raw of values) {
      if (typeof raw !== "string" || !raw.trim() || seen.has(raw)) continue;
      seen.add(raw);
      entries.push({ raw, auxiliary, condition });
    }
  }
  return entries;
}

function currentCommands(result) {
  return currentCommandEntries(result).map((entry) => entry.raw);
}

function actorIdentity(actor = {}) {
  return {
    mission_id: String(actor.mission_id || "").trim(),
    agent_id: String(actor.agent_id || "").trim(),
    focus: actor.focus !== false
  };
}

function actionId(rawCommand, result, actor) {
  const material = JSON.stringify({
    rawCommand: String(rawCommand),
    projectVersion: projectVersion(result),
    missionId: actor.mission_id,
    agentId: actor.agent_id,
    nextCode: result?.next_action?.code || ""
  });
  return `UA_${crypto.createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

function commandBindsField(raw, field) {
  const flag = `--${String(field).replaceAll("_", "-")}`;
  const tokens = commandTokens(raw);
  return tokens.includes(flag) || tokens.some((token) => token.startsWith(`${flag}=`));
}

function actionDescriptors(result, actor, deps) {
  const responseRequired = new Set([
    ...(Array.isArray(result?.required_fields) ? result.required_fields : []),
    ...(Array.isArray(result?.next_action?.required_fields) ? result.next_action.required_fields : [])
  ].map(String));
  const fieldGuide = {
    ...(result?.field_guide && typeof result.field_guide === "object" ? result.field_guide : {}),
    ...(result?.next_action?.field_guide && typeof result.next_action.field_guide === "object" ? result.next_action.field_guide : {})
  };
  const descriptors = [];
  for (const { raw, auxiliary, condition } of currentCommandEntries(result)) {
    const command = commandName(raw, deps.supportedCommands);
    if (BLOCKED_MCP_COMMANDS.has(command)) continue;
    const contract = deps.hostedResponseContract(command);
    const contractRequired = (contract.requiredFields || []).filter((field) => (
      auxiliary || !commandBindsField(raw, field)
    ));
    const inputFields = [...new Set([
      ...contractRequired,
      ...(auxiliary ? [] : responseRequired)
    ])]
      .filter((field) => !RESERVED_INPUT_KEYS.has(field) && !COMMAND_BOUND_FILE_FIELDS.has(field));
    descriptors.push({
      action_id: actionId(raw, result, actor),
      command,
      gate: contract.gate,
      required_input: inputFields,
      field_guide: Object.fromEntries(inputFields.map((field) => [field, fieldGuide[field] || contract.fieldGuide?.[field] || "Current workflow input."])),
      proof_required: contract.proofRequired === true,
      ...(condition ? { condition, requires_user_confirmation: true } : {})
    });
  }
  return descriptors;
}

function sanitizeForMcp(value, key = "") {
  if (STRIPPED_COMMAND_KEYS.has(key)) return undefined;
  if (key === "next" && typeof value === "string") return undefined;
  if (/_commands?$/.test(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeForMcp(child)).filter((child) => child !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (["billing", "command_status", "contract", "domain", "entitlement", "local_contract", "source"].includes(childKey)) continue;
    const sanitized = sanitizeForMcp(child, childKey);
    if (sanitized !== undefined) output[childKey] = sanitized;
  }
  return output;
}

function publicMcpResult(result, actor, deps, extra = {}) {
  const output = sanitizeForMcp(clone(result));
  output.allowed_actions = actionDescriptors(result, actor, deps);
  output.transport = {
    kind: "local_stdio_mcp",
    server_authority: "hosted_unclog",
    shell_commands_allowed: false,
    private_local_cli_allowed: false
  };
  return { ...output, ...extra };
}

function assertInput(input, allowedFields, requiredFields = []) {
  const value = input === undefined ? {} : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("unclog_act input must be a JSON object.");
    error.code = "mcp_action_input_invalid";
    throw error;
  }
  const rendered = JSON.stringify(value);
  if (Buffer.byteLength(rendered, "utf8") > 64 * 1024) {
    const error = new Error("unclog_act input is too large.");
    error.code = "mcp_action_input_too_large";
    throw error;
  }
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(value)) {
    if (RESERVED_INPUT_KEYS.has(key) || !allowed.has(key)) {
      const error = new Error(`Input field ${key} is not authorized for the current action.`);
      error.code = "mcp_action_input_not_allowed";
      throw error;
    }
  }
  const missing = requiredFields.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return true;
    const child = value[key];
    return child === undefined || child === null || (typeof child === "string" && !child.trim());
  });
  if (missing.length) {
    const error = new Error(`The current Unclog action requires input: ${missing.join(", ")}.`);
    error.code = "mcp_action_input_required";
    throw error;
  }
  return clone(value);
}

function mcpError(error) {
  const state = error?.publicState && typeof error.publicState === "object" ? error.publicState : {};
  return {
    ok: false,
    blocked: true,
    code: String(state.code || error?.code || "mcp_action_failed"),
    message: String(state.message || error?.message || "Unclog could not complete this action."),
    recovery: Array.isArray(state.actions) ? state.actions : (Array.isArray(state.recovery) ? state.recovery : ["Call unclog_next to refresh current hosted state."])
  };
}

function toolResponse(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

function createMcpRuntime(bridge, options = {}) {
  const workspaceRoot = fs.realpathSync(path.resolve(options.workspaceRoot || process.cwd()));
  const identity = bridge.repositoryIdentity(workspaceRoot);
  if (path.resolve(identity.root || workspaceRoot) !== path.resolve(workspaceRoot)) {
    const error = new Error("The configured Unclog workspace must be the Git repository root.");
    error.code = "mcp_workspace_root_required";
    throw error;
  }
  const deps = {
    supportedCommands: [...bridge.HOSTED_COMMAND_CONTRACTS],
    hostedResponseContract: bridge.hostedResponseContract
  };
  const client = options.client || bridge.createBridgeClient({ session: options.session, sessionOptions: options.sessionOptions, fetchImpl: options.fetchImpl });
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now || (() => Date.now());

  async function fetchCurrent(actorValue = {}) {
    const actor = actorIdentity(actorValue);
    bridge.reconcilePendingLocalArtifactEffects({ cwd: workspaceRoot });
    const argv = actor.agent_id
      ? ["agents", "packet", "--agent-id", actor.agent_id, ...(actor.focus ? ["--focus"] : [])]
      : ["next"];
    if (actor.mission_id) argv.push("--mission", actor.mission_id);
    const parsed = bridge.parseHostedCommandArgv(argv, { cwd: workspaceRoot });
    if (actor.agent_id && actor.focus) parsed.payload.focus = true;
    const result = await client.command(parsed.command, parsed.payload);
    const returnedMission = String(result?.mission_id || result?.mission?.id || "").trim();
    const returnedAgent = String(result?.agent_id || result?.agent?.id || "").trim();
    if (actor.mission_id && returnedMission && returnedMission !== actor.mission_id) {
      const error = new Error("The hosted response belongs to a different mission.");
      error.code = "mcp_wrong_mission";
      throw error;
    }
    if (actor.agent_id && returnedAgent && returnedAgent !== actor.agent_id) {
      const error = new Error("The hosted response belongs to a different worker lane.");
      error.code = "mcp_wrong_actor";
      throw error;
    }
    const localArtifacts = bridge.applyHostedLocalArtifactEffects(result, { cwd: workspaceRoot });
    return { actor, result, localArtifacts };
  }

  async function next(input = {}) {
    try {
      const current = await fetchCurrent(input);
      return publicMcpResult(current.result, current.actor, deps, current.localArtifacts ? { local_artifacts: current.localArtifacts } : {});
    } catch (error) {
      return mcpError(error);
    }
  }

  async function act(input = {}) {
    try {
      const requestedActionId = String(input.action_id || "").trim();
      if (!/^UA_[0-9a-f]{32}$/.test(requestedActionId)) {
        const error = new Error("Use an action_id returned by the latest unclog_next response.");
        error.code = "mcp_action_id_invalid";
        throw error;
      }
      const current = await fetchCurrent(input);
      const rawCommands = currentCommands(current.result);
      const descriptors = actionDescriptors(current.result, current.actor, deps);
      const index = descriptors.findIndex((descriptor) => descriptor.action_id === requestedActionId);
      if (index < 0) {
        const error = new Error("This Unclog action is stale or is not authorized for the current mission and actor.");
        error.code = "mcp_action_stale";
        throw error;
      }
      const descriptor = descriptors[index];
      const raw = rawCommands.find((candidate) => actionId(candidate, current.result, current.actor) === requestedActionId);
      if (!raw) {
        const error = new Error("The current hosted action could not be resolved.");
        error.code = "mcp_action_stale";
        throw error;
      }
      const parsed = bridge.parseHostedCommandArgv(commandTokens(raw), { cwd: workspaceRoot });
      if (parsed.command !== descriptor.command || BLOCKED_MCP_COMMANDS.has(parsed.command)) {
        const error = new Error("The current action is not available through the non-destructive MCP surface.");
        error.code = "mcp_action_not_available";
        throw error;
      }
      const allowedInput = [...new Set([...(descriptor.required_input || []), ...Object.keys(descriptor.field_guide || {})])];
      Object.assign(parsed.payload, assertInput(input.input, allowedInput, descriptor.required_input || []));
      const version = projectVersion(current.result);
      if (version !== null) parsed.payload.expected_project_version = version;
      const result = await client.command(parsed.command, parsed.payload);
      const localArtifacts = bridge.applyHostedLocalArtifactEffects(result, { cwd: workspaceRoot });
      const localOutput = parsed.localOutputPath ? bridge.writeHostedOutputFile(parsed.localOutputPath, result, { cwd: workspaceRoot }) : null;
      return publicMcpResult(result, current.actor, deps, {
        executed_action_id: requestedActionId,
        ...(localArtifacts ? { local_artifacts: localArtifacts } : {}),
        ...(localOutput ? { local_output: localOutput } : {})
      });
    } catch (error) {
      return mcpError(error);
    }
  }

  async function wait(input = {}) {
    try {
      const timeoutSeconds = Math.max(1, Math.min(30, Number(input.timeout_seconds || 20)));
      const pollMilliseconds = Math.max(500, Math.min(5000, Number(input.poll_interval_ms || 2000)));
      const deadline = now() + timeoutSeconds * 1000;
      const first = await fetchCurrent(input);
      const firstFingerprint = JSON.stringify({
        code: first.result?.next_action?.code,
        actions: actionDescriptors(first.result, first.actor, deps).map((row) => row.action_id),
        version: projectVersion(first.result)
      });
      if (actionDescriptors(first.result, first.actor, deps).length > 0 && input.wait_for_change !== true) {
        return publicMcpResult(first.result, first.actor, deps, { changed: false, timed_out: false });
      }
      let latest = first;
      while (now() < deadline) {
        await sleep(Math.min(pollMilliseconds, Math.max(1, deadline - now())));
        latest = await fetchCurrent(input);
        const fingerprint = JSON.stringify({
          code: latest.result?.next_action?.code,
          actions: actionDescriptors(latest.result, latest.actor, deps).map((row) => row.action_id),
          version: projectVersion(latest.result)
        });
        if (fingerprint !== firstFingerprint) {
          return publicMcpResult(latest.result, latest.actor, deps, { changed: true, timed_out: false });
        }
      }
      return publicMcpResult(latest.result, latest.actor, deps, { changed: false, timed_out: true });
    } catch (error) {
      return mcpError(error);
    }
  }

  return { act, next, wait, workspaceRoot, workspaceIdentity: identity };
}

function createMcpServer(bridge, options = {}) {
  const runtime = createMcpRuntime(bridge, options);
  const server = new McpServer({ name: "unclog", version: options.version || bridge.BRIDGE_VERSION }, { instructions: MCP_INSTRUCTIONS });
  const actorShape = {
    mission_id: z.string().max(80).optional().describe("Mission id when the server or handoff supplied one."),
    agent_id: z.string().max(80).optional().describe("Worker lane id only in that worker's separate task."),
    focus: z.boolean().optional().describe("Use the normal compact worker packet; defaults true.")
  };
  server.registerTool("unclog_next", {
    description: "Get the authoritative current hosted Unclog phase, instruction, and allowed actions. Call this first and after every action.",
    inputSchema: actorShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (input) => {
    const value = await runtime.next(input);
    return toolResponse(value, value.ok === false);
  });
  server.registerTool("unclog_act", {
    description: "Execute exactly one current server-authorized Unclog action_id. Stale, wrong-mission, wrong-actor, arbitrary, and destructive commands are rejected.",
    inputSchema: {
      ...actorShape,
      action_id: z.string().regex(/^UA_[0-9a-f]{32}$/),
      input: z.record(z.unknown()).optional().describe("Only fields listed by that action's required_input may be sent.")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async (input) => {
    const value = await runtime.act(input);
    return toolResponse(value, value.ok === false);
  });
  server.registerTool("unclog_wait", {
    description: "Wait for a hosted approval, worker handoff, or external transition with a bounded poll; it never runs an action.",
    inputSchema: {
      ...actorShape,
      timeout_seconds: z.number().int().min(1).max(30).optional(),
      poll_interval_ms: z.number().int().min(500).max(5000).optional(),
      wait_for_change: z.boolean().optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (input) => {
    const value = await runtime.wait(input);
    return toolResponse(value, value.ok === false);
  });
  return { runtime, server };
}

async function startMcpServer(bridge, options = {}) {
  const { server } = createMcpServer(bridge, options);
  const transport = options.transport || new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = {
  BLOCKED_MCP_COMMANDS,
  MCP_INSTRUCTIONS,
  actionDescriptors,
  commandName,
  createMcpRuntime,
  createMcpServer,
  publicMcpResult,
  startMcpServer,
  tokenizeCommand
};
