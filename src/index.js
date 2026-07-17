#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const {
  clearSession,
  credentialStorageCapabilities,
  loadSession,
  normalizeApiBaseUrl,
  normalizeHostedPublicUrl,
  resolveSessionDir,
  saveSession,
  SessionStorageError,
  sessionStorageContract
} = require("./session");

const COMMAND_ENDPOINT = "/v1/bridge/commands";
const PROJECT_LINK_ENDPOINT = "/v1/bridge/project-link";
const SESSION_REVOKE_ENDPOINT = "/v1/bridge/session/revoke";
const DEVICE_AUTHORIZE_ENDPOINT = "/v1/bridge/device/authorize";
const DEVICE_TOKEN_ENDPOINT = "/v1/bridge/device/token";
const BRIDGE_VERSION = require("../package.json").version;
const MAX_LOCAL_OUTPUT_BYTES = 1024 * 1024;
const LOCAL_ARTIFACT_SCHEMA = "unclog-local-artifacts/1";
const LOCAL_ARTIFACT_EFFECTS_SCHEMA = "unclog-local-artifact-effects/1";
const MAX_LOCAL_ARTIFACT_COUNT = 256;
const DRAFT_ARTIFACT_PATH = /^\.unclog-drafts\/(D\d{8}-\d{6}-[0-9a-f]{6})\/(unclog_goals|submitted_goals|status)\.json$/;

const NORMAL_HOSTED_COMMAND_CONTRACTS = [
  "mission.list",
  "mission.create",
  "mission.select",
  "mission.rename",
  "mission.status",
  "mission.validate",
  "mission.reject",
  "mission.repair",
  "mission.repair-template",
  "mission.abandon",
  "drafts.list",
  "goals.template",
  "goals.export",
  "goals.update",
  "goals.extend",
  "goals.lint",
  "goals.patch-template",
  "goals.patch",
  "goals.rename",
  "goals.move",
  "goals.add-big",
  "goals.add-smaller",
  "goals.add-small",
  "goals.add-granular",
  "goals.add-tiny",
  "goals.delete",
  "goals.split",
  "goals.merge",
  "goals.lock",
  "goals.status",
  "scope.status",
  "agents.plan",
  "agents.packet",
  "agents.status",
  "agents.spawn",
  "agents.handoff",
  "agents.note",
  "agents.repair-template",
  "agents.repair",
  "agents.block",
  "agents.unblock",
  "agents.runtime.schedule",
  "agents.runtime.interrupt",
  "agents.runtime.stop",
  "agents.runtime.resume",
  "agents.runtime.replace",
  "agents.watch",
  "next",
  "packet",
  "brief",
  "progress",
  "doctor",
  "why",
  "recover",
  "version",
  "action-plan.lint",
  "action-plan.export",
  "action-plan.coverage",
  "action-plan.submit",
  "action-plan.revise",
  "action-plan.review-template",
  "action-plan.rename",
  "action-plan.move",
  "action-plan.add-granular",
  "action-plan.add-tiny",
  "action-plan.status",
  "action.check",
  "action.proof-template",
  "action.proof-lint",
  "action.proof-repair-json",
  "action.revise",
  "set.closeout-template",
  "set.closeout-lint",
  "set.status",
  "set.submit",
  "set.revise",
  "set.revise-template",
  "set.summary-context",
  "inbox.packet",
  "inbox.list",
  "inbox.capture",
  "inbox.split",
  "inbox.merge",
  "inbox.triage",
  "inbox.label",
  "inbox.clarify",
  "inbox.edit",
  "inbox.archive",
  "inbox.unarchive",
  "inbox.move",
  "inbox.link"
];

const LOCAL_ONLY_COMMAND_CONTRACTS = [
  "init",
  "selftest",
  "mission.delete",
  "agents.runtime.set",
  "action-plan.add-big",
  "action-plan.add-smaller",
  "action-plan.add-small"
];

const REMOVED_SOCIAL_COMMAND_CONTRACTS = [
  "social.modes",
  "social.status",
  "social.candidates",
  "social.settings",
  "social.profile",
  "social.completion-hook",
  "social.feed",
  "social.follow",
  "social.skip",
  "social.post",
  "social.interact"
];

const HOSTED_COMMAND_CONTRACTS = new Set(NORMAL_HOSTED_COMMAND_CONTRACTS);
const HOSTED_LOCAL_ONLY_COMMAND_CONTRACTS = new Set(LOCAL_ONLY_COMMAND_CONTRACTS);
const HOSTED_REMOVED_COMMAND_CONTRACTS = new Set(REMOVED_SOCIAL_COMMAND_CONTRACTS);
const HOSTED_UNSUPPORTED_COMMAND_CONTRACTS = new Set([
  ...HOSTED_LOCAL_ONLY_COMMAND_CONTRACTS,
  ...HOSTED_REMOVED_COMMAND_CONTRACTS
]);
const HOSTED_LOCAL_CONTRACT_VERSION = "hosted_local_cli_parity_v1";
const LOCAL_RESPONSE_BASE_KEYS = ["status", "next_action", "next", "commands_now", "recovery"];
const LOCAL_STATUS_VALUES = ["OK", "REJECTED", "ERROR"];

const LOCAL_FIELD_GUIDE = {
  action_id: "Current action id from the active action set.",
  agent_id: "Logical worker lane id whose hosted runtime state is changing.",
  capacity: "Maximum number of already-assigned worker lanes that may run at once.",
  decision: "Audit decision accepted by the current workflow gate.",
  closeout_sweep_file: "Local closeout JSON path; the thin bridge checks JSON transport safety and sends the structured object for server-side workflow validation.",
  file: "Local workflow JSON path; the thin bridge checks JSON transport safety and sends the structured object for server-side workflow validation, never repository source.",
  proof: "Compact completed-evidence summary; the canonical validation result belongs in the structured proof document.",
  reason: "Compact blocker or state-change reason.",
  reasoning: "Compact audit reasoning for the selected gate.",
  review_lifecycle_file: "Private local review-evidence JSON path; the thin CLI validates and sends only its structured object.",
  runtime_identity: "Stable identity of the runtime resuming or replacing the logical worker lane.",
  summary: "Compact completion summary for the current action set.",
  text: "Workflow text, not repository contents.",
  verified: "Explicit confirmation that a replacement runtime was verified by the authoritative controller."
};

const COMMAND_GATE_CONTRACTS = {
  "goals.lock": {
    gate: "goal_lock",
    requiredFields: ["file"],
    responseKeys: ["challenge_prompt", "required_fields", "field_guide"],
    workflowGates: ["goal_lock_audit"]
  },
  "action-plan.submit": {
    gate: "action_plan_audit",
    requiredFields: ["file"],
    responseKeys: [
      "action_plan",
      "selected_scope",
      "selected_scope_tiny_goal_ids",
      "challenge_prompt",
      "required_fields",
      "field_guide",
      "allowed_fields",
      "forbidden_fields"
    ],
    workflowGates: ["action_plan_audit"]
  },
  "action-plan.revise": {
    gate: "action_plan_audit",
    requiredFields: ["decision", "reasoning"],
    responseKeys: [
      "action_plan",
      "selected_scope",
      "challenge_prompt",
      "required_fields",
      "field_guide",
      "allowed_fields",
      "forbidden_fields"
    ],
    workflowGates: ["action_plan_audit"]
  },
  "action.check": {
    gate: "current_action_set",
    requiredFields: ["action_id", "file"],
    responseKeys: [
      "checked_action",
      "current_action_set_id",
      "remaining_unchecked_count",
      "unchecked_count",
      "first_unchecked_action",
      "proof_file_command",
      "bulk_proof_hint",
      "submit_ready",
      "required_fields",
      "field_guide"
    ],
    workflowGates: ["current_action_set", "proof_required"]
  },
  "action.proof-template": {
    gate: "current_action_set",
    requiredFields: ["file"],
    responseKeys: ["action_proof_template", "proof_lint_command", "proof_submit_command", "instructions"],
    workflowGates: ["current_action_set", "action_proof_template"]
  },
  "action.proof-lint": {
    gate: "current_action_set",
    requiredFields: ["action_id", "file"],
    responseKeys: ["valid", "checked_fields", "first_issue", "issues_preview"],
    workflowGates: ["current_action_set", "proof_lint"]
  },
  "action.proof-repair-json": {
    gate: "current_action_set",
    requiredFields: ["action_id", "file"],
    responseKeys: ["repaired", "backup_file", "proof_lint_command"],
    workflowGates: ["current_action_set", "proof_json_repair"]
  },
  "action.revise": {
    gate: "current_action_set",
    requiredFields: ["action_id", "decision", "reasoning"],
    responseKeys: ["accepted_action", "unchecked_count", "next_action", "commands_now"],
    workflowGates: ["current_action_set", "proof_audit"]
  },
  "set.status": {
    gate: "current_action_set",
    responseKeys: ["selected_scope", "current_action_set", "unchecked_actions", "closeout_sweep", "completion_summary_prompt"],
    workflowGates: ["current_action_set"]
  },
  "set.submit": {
    gate: "set_audit",
    requiredFields: ["summary", "proof", "closeout_sweep_file"],
    responseKeys: [
      "current_action_set",
      "challenge_prompt",
      "required_fields",
      "field_guide",
      "completion_summary_prompt",
      "completion_summary_constraints"
    ],
    workflowGates: ["set_audit", "proof_required"]
  },
  "set.revise": {
    gate: "set_audit",
    requiredFields: ["decision", "reasoning"],
    responseKeys: [
      "current_action_set",
      "challenge_prompt",
      "required_fields",
      "field_guide",
      "completion_summary_prompt",
      "completion_summary_constraints"
    ],
    workflowGates: ["set_audit"]
  },
  "set.revise-template": {
    gate: "set_audit",
    responseKeys: ["template", "required_fields", "field_guide", "revise_command"],
    workflowGates: ["set_audit"]
  },
  "set.closeout-template": {
    gate: "current_action_set",
    requiredFields: ["file"],
    responseKeys: ["closeout_template", "closeout_lint_command", "submit_command", "instructions"],
    workflowGates: ["current_action_set", "closeout_template"]
  },
  "set.closeout-lint": {
    gate: "current_action_set",
    requiredFields: ["file"],
    responseKeys: ["valid", "first_issue", "issues_preview", "submit_command"],
    workflowGates: ["current_action_set", "closeout_lint"]
  },
  "agents.packet": {
    gate: "worker_next_action",
    responseKeys: [
      "agent_progress",
      "completion_contract",
      "assigned_goal_lines",
      "assigned_scope",
      "selected_scope_tiny_goal_ids",
      "current_action_set",
      "proof_commands",
      "blockers",
      "recovery",
      "worker_files"
    ],
    workflowGates: ["worker_next_action", "worker_blocker_state"]
  },
  "agents.block": {
    gate: "worker_blocker",
    requiredFields: ["reason"],
    responseKeys: ["agent_progress", "blocker", "completion_contract"],
    workflowGates: ["worker_blocker_state"]
  },
  "agents.runtime.schedule": {
    gate: "worker_runtime",
    requiredFields: ["capacity"],
    responseKeys: ["active_agent_ids", "queued_agent_ids", "transitions", "started_agent_ids", "worker_handoffs"],
    workflowGates: ["multi_agent_state", "runtime_capacity"]
  },
  "agents.runtime.interrupt": {
    gate: "worker_runtime",
    requiredFields: ["agent_id", "kind"],
    responseKeys: ["runtime_transition", "changed", "transition", "current_runtime", "runtime_runs"],
    workflowGates: ["multi_agent_state", "runtime_lifecycle"]
  },
  "agents.runtime.stop": {
    gate: "worker_runtime",
    requiredFields: ["agent_id"],
    responseKeys: ["runtime_transition", "changed", "transition", "current_runtime", "runtime_runs"],
    workflowGates: ["multi_agent_state", "runtime_lifecycle"]
  },
  "agents.runtime.resume": {
    gate: "worker_runtime",
    requiredFields: ["agent_id", "runtime_identity"],
    responseKeys: ["runtime_transition", "changed", "transition", "current_runtime", "runtime_runs"],
    workflowGates: ["multi_agent_state", "runtime_lifecycle"]
  },
  "agents.runtime.replace": {
    gate: "worker_runtime",
    requiredFields: ["agent_id", "runtime_identity", "verified"],
    responseKeys: ["runtime_transition", "changed", "transition", "current_runtime", "runtime_runs"],
    workflowGates: ["multi_agent_state", "runtime_lifecycle", "verified_replacement"]
  },
  packet: {
    gate: "resume",
    responseKeys: [
      "goal_progress",
      "current_scope",
      "inbox_review",
      "lane_status",
      "validation_status",
      "repair_routes",
      "next_action"
    ],
    workflowGates: ["resume_guidance", "manager_phase_context"]
  },
  brief: {
    gate: "resume",
    responseKeys: ["goal_progress", "current_scope", "next_action"],
    workflowGates: ["resume_guidance"]
  },
  progress: {
    gate: "progress",
    responseKeys: ["goal_progress", "agent_progress", "current_scope"],
    workflowGates: ["progress_refresh"]
  },
  next: {
    gate: "next_action",
    responseKeys: ["goal_progress", "current_scope", "next_action"],
    workflowGates: ["resume_guidance"]
  },
  recover: {
    gate: "recovery",
    responseKeys: ["phase", "safe_commands", "recovery"],
    workflowGates: ["recovery_guidance"]
  },
  doctor: {
    gate: "health",
    responseKeys: ["checks", "recovery"],
    workflowGates: ["health_check"]
  },
  why: {
    gate: "explain",
    responseKeys: ["phase", "safe_commands", "coverage", "current_action_set"],
    workflowGates: ["explain_current_gate"]
  },
  version: {
    gate: "version",
    responseKeys: ["cli_version", "contract_version", "schema_contract_version"],
    workflowGates: ["version_read"]
  },
  "inbox.capture": {
    gate: "inbox",
    requiredFields: ["text"],
    responseKeys: ["item", "counts", "changed_items"],
    workflowGates: ["inbox_state_update"]
  }
};

const PREFIX_GATE_CONTRACTS = [
  {
    prefix: "inbox.",
    gate: "inbox",
    responseKeys: ["items", "counts", "changed_items"],
    workflowGates: ["inbox_state_update"]
  },
  {
    prefix: "goals.",
    gate: "goals",
    responseKeys: ["goals", "lines", "selected_scope", "field_guide"],
    workflowGates: ["goal_tree_guardrails"]
  },
  {
    prefix: "mission.",
    gate: "mission",
    responseKeys: ["mission", "mission_id", "goal_progress", "validation_status"],
    workflowGates: ["mission_state_update"]
  },
  {
    prefix: "agents.",
    gate: "agents",
    responseKeys: ["agent_progress", "agents", "completion_contract"],
    workflowGates: ["multi_agent_state"]
  },
  {
    prefix: "action-plan.",
    gate: "action_plan",
    responseKeys: ["action_plan", "coverage", "selected_scope", "field_guide"],
    workflowGates: ["action_plan_shape"]
  },
  {
    prefix: "set.",
    gate: "current_action_set",
    responseKeys: ["current_action_set", "unchecked_actions", "field_guide"],
    workflowGates: ["current_action_set"]
  }
];

const BILLING_ROUTE_CONTRACT = Object.freeze({
  provider: "merchant_of_record",
  portal_route: "/account/billing",
  checkout_route: "/account/billing/checkout"
});

const BLOCKED_STATE_COPY = {
  auth_required: {
    title: "Sign in required",
    message: "Unclog commands require an active hosted session and paid solo subscription.",
    primaryAction: "Run unclog-bridge login",
    secondaryAction: "Open billing or device settings",
    billing: BILLING_ROUTE_CONTRACT,
    mobile: {
      title: "Sign in",
      message: "Connect this device to continue.",
      primaryAction: "Login"
    }
  },
  subscription_required: {
    title: "Sign in required",
    message: "Unclog commands require an active hosted session and paid solo subscription.",
    primaryAction: "Run unclog-bridge login",
    secondaryAction: "Open billing or device settings",
    billing: BILLING_ROUTE_CONTRACT,
    mobile: {
      title: "Sign in",
      message: "Connect this device to continue.",
      primaryAction: "Login"
    }
  },
  unsupported_command: {
    title: "Unsupported command",
    message: "Use a supported hosted workflow command.",
    primaryAction: "Show supported commands",
    secondaryAction: "Open hosted workflow help",
    mobile: {
      title: "Unsupported",
      message: "Choose a hosted workflow command.",
      primaryAction: "Commands"
    }
  },
  unknown_command: {
    title: "Unknown command",
    message: "This command is not in the hosted workflow contract.",
    primaryAction: "Check command spelling",
    secondaryAction: "Show supported commands",
    mobile: {
      title: "Unknown",
      message: "Check the command name.",
      primaryAction: "Check"
    }
  },
  payload_rejected: {
    title: "Payload blocked",
    message: "Send workflow data only; never send repositories, source, diffs, or secrets.",
    primaryAction: "Remove private data",
    secondaryAction: "Send proof summary",
    mobile: {
      title: "Payload blocked",
      message: "Remove private data.",
      primaryAction: "Review"
    }
  },
  server_required: {
    title: "Server required",
    message: "Hosted Unclog commands need a server connection.",
    primaryAction: "Retry",
    secondaryAction: "Check network",
    mobile: {
      title: "Server required",
      message: "Check connection.",
      primaryAction: "Retry"
    }
  },
  server_unreachable: {
    title: "Server unreachable",
    message: "Hosted Unclog could not be reached; retry after checking network access.",
    primaryAction: "Retry",
    secondaryAction: "Check network",
    mobile: {
      title: "Offline",
      message: "Check connection.",
      primaryAction: "Retry"
    }
  },
  server_response_invalid: {
    title: "Server response error",
    message: "Hosted Unclog returned an invalid response.",
    primaryAction: "Retry",
    secondaryAction: "Open status",
    mobile: {
      title: "Retry",
      message: "Server response failed.",
      primaryAction: "Retry"
    }
  }
};

class MissingAuthError extends Error {
  constructor(message = "Sign in to hosted Unclog before running bridge commands.") {
    super(message);
    this.name = "MissingAuthError";
    this.code = "unclog_auth_required";
    this.publicState = blockedState("auth_required");
  }
}

class BridgeServerError extends Error {
  constructor(code, message, publicState = null) {
    super(message);
    this.name = "BridgeServerError";
    this.code = code;
    this.publicState = publicState;
  }
}

function blockedState(reason = "auth_required") {
  const copy = BLOCKED_STATE_COPY[reason] || {
    title: "Request blocked",
    message: "Hosted Unclog blocked this command.",
    primaryAction: "Retry",
    secondaryAction: "Open hosted workflow help",
    mobile: {
      title: "Blocked",
      message: "Review the command.",
      primaryAction: "Review"
    }
  };
  const state = {
    allowed: false,
    blocked: true,
    status: "ERROR",
    code: reason,
    reason,
    title: copy.title,
    message: copy.message,
    primaryAction: copy.primaryAction,
    secondaryAction: copy.secondaryAction,
    actions: [copy.primaryAction, copy.secondaryAction].filter(Boolean),
    recovery: [copy.primaryAction, copy.secondaryAction].filter(Boolean),
    mobile: copy.mobile
  };
  if (copy.billing) {
    state.billing = { ...copy.billing };
  }
  return state;
}

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "controllerinternals",
  "policyprompt",
  "corerulebook",
  "fullbrain",
  "sourcecode",
  "source",
  "filecontents",
  "contents",
  "files",
  "repository",
  "repo",
  "workspacearchive",
  "patch",
  "diff",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "apitoken",
  "privatekey",
  "credential",
  "credentials",
  "secretkey",
  "authtoken",
  "bearertoken",
  "devicetoken",
  "sessiontoken",
  "token",
  "secret",
  "password"
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeHostedCommand(command) {
  return String(command || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function localCliCommand(command) {
  return `unclog --json ${String(command || "").replace(/\./g, " ")}`.trim();
}

function commandGateConfig(command) {
  if (Object.prototype.hasOwnProperty.call(COMMAND_GATE_CONTRACTS, command)) {
    return COMMAND_GATE_CONTRACTS[command];
  }
  return (
    PREFIX_GATE_CONTRACTS.find((item) => command.startsWith(item.prefix)) || {
      gate: "workflow",
      responseKeys: ["goal_progress"],
      workflowGates: ["workflow_state"]
    }
  );
}

function hostedResponseContract(command) {
  const normalizedCommand = normalizeHostedCommand(command);
  const config = commandGateConfig(normalizedCommand);
  const requiredFields = unique(config.requiredFields || []);
  const workflowGates = unique([
    "server_authorization",
    "workflow_payload_only",
    "local_cli_guardrails",
    ...(config.workflowGates || [])
  ]);
  const fieldGuide = {};
  for (const field of requiredFields) {
    fieldGuide[field] = LOCAL_FIELD_GUIDE[field] || "Workflow field required by the matching local CLI gate.";
  }
  return {
    version: HOSTED_LOCAL_CONTRACT_VERSION,
    command: normalizedCommand,
    localCommand: localCliCommand(normalizedCommand),
    gate: config.gate,
    statusValues: LOCAL_STATUS_VALUES,
    responseKeys: unique([...LOCAL_RESPONSE_BASE_KEYS, ...(config.responseKeys || [])]),
    requiredFields,
    fieldGuide,
    workflowGates,
    proofRequired: workflowGates.includes("proof_required"),
    localExecution: false
  };
}

function hostedCommandStatus(command) {
  const normalizedCommand = normalizeHostedCommand(command);
  if (HOSTED_COMMAND_CONTRACTS.has(normalizedCommand)) {
    return {
      supported: true,
      blocked: false,
      command: normalizedCommand,
      reason: "supported",
      title: "Supported command",
      message: "Hosted Unclog can forward this workflow command."
    };
  }
  if (HOSTED_UNSUPPORTED_COMMAND_CONTRACTS.has(normalizedCommand)) {
    return {
      supported: false,
      blocked: true,
      command: normalizedCommand,
      reason: "unsupported_command",
      title: "Unsupported command",
      message: "This local CLI command is intentionally blocked on hosted Unclog."
    };
  }
  return {
    supported: false,
    blocked: true,
    command: normalizedCommand,
    reason: "unknown_command",
    title: "Unknown command",
    message: "This command is not in the hosted Unclog workflow contract."
  };
}

function assertHostedCommandContract(command) {
  const commandStatus = hostedCommandStatus(command);
  if (!commandStatus.supported) {
    throw new BridgeServerError(
      "bridge_command_rejected",
      commandStatus.message,
      blockedState(commandStatus.reason)
    );
  }
  return commandStatus.command;
}

function findForbiddenPayloadKey(value) {
  if (Array.isArray(value)) {
    for (const child of value) {
      const forbidden = findForbiddenPayloadKey(child);
      if (forbidden) {
        return forbidden;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (FORBIDDEN_PAYLOAD_KEYS.has(normalized)) {
      return normalized;
    }
    const forbidden = findForbiddenPayloadKey(child);
    if (forbidden) {
      return forbidden;
    }
  }
  return null;
}

function assertNoLocalBrain(value) {
  if (findForbiddenPayloadKey(value)) {
    throw new BridgeServerError(
      "bridge_payload_rejected",
      "Bridge payloads must not contain controller internals, core rules, repository data, source, patches, or secrets.",
      blockedState("payload_rejected")
    );
  }
}

function buildAdapterPrompt(toolName = "AI coding tool") {
  return [
    `${toolName} should call the local Unclog bridge for workflow actions.`,
    "The bridge is intentionally thin and has no protected Unclog brain.",
    "Every useful command requires hosted server authorization before mutation.",
    "Do not paste repositories, source files, patches, diffs, tokens, or secrets into bridge payloads."
  ].join(" ");
}

function parseFlagArgs(argv) {
  const flags = {};
  const assignFlag = (key, value) => {
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
      return;
    }
    flags[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) {
      continue;
    }
    const key = raw.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      assignFlag(key, "true");
      continue;
    }
    assignFlag(key, next);
    index += 1;
  }
  return flags;
}

function normalizePayloadFlagKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const TOP_LEVEL_PAYLOAD_FLAGS = new Set([
  "action_id",
  "agent_id",
  "after",
  "after_summary",
  "answer",
  "before",
  "before_summary",
  "capacity",
  "closeout_sweep_file",
  "decision",
  "enabled",
  "expected_project_version",
  "fresh",
  "goal",
  "goal_id",
  "include_archived",
  "idempotency_key",
  "kind",
  "limit",
  "mark_reviewed",
  "mission_id",
  "name",
  "project_id",
  "proof",
  "raw",
  "reason",
  "reasoning",
  "request_id",
  "requires_coordination",
  "runtime_identity",
  "seed",
  "status",
  "summary",
  "text",
  "title",
  "timezone",
  "verified",
  "verbose",
  "worker"
]);

const PAYLOAD_FLAG_ALIASES = {
  mission: "mission_id",
  agent: "agent_id",
  goal: "goal_id",
  project: "project_id",
  expected_version: "expected_project_version",
  project_version: "expected_project_version",
  idem: "idempotency_key"
};

const BOOLEAN_CLI_FLAGS = new Set([
  "debug",
  "draft",
  "fresh",
  "include_archived",
  "json",
  "mark_reviewed",
  "raw",
  "requires_coordination",
  "verified",
  "verbose"
]);

const INPUT_WORKFLOW_FILE_COMMANDS = new Set([
  "mission.repair",
  "goals.update",
  "goals.extend",
  "goals.lint",
  "goals.patch",
  "goals.lock",
  "agents.repair",
  "action-plan.lint",
  "action-plan.submit",
  "action.check",
  "action.proof-lint",
  "action.proof-repair-json",
  "set.closeout-lint"
]);

const OUTPUT_WORKFLOW_FILE_COMMANDS = new Set([
  "goals.template",
  "goals.export",
  "goals.patch-template",
  "mission.repair-template",
  "agents.repair-template",
  "action-plan.export",
  "action-plan.review-template",
  "action.proof-template",
  "set.closeout-template",
  "set.revise-template"
]);

const TRANSPORT_ONLY_FLAGS = new Set([
  "debug",
  "json",
  "project",
  "project_id",
  "expected_project_version",
  "expected_version",
  "project_version",
  "idempotency_key",
  "idem",
  "mission",
  "raw",
  "review_lifecycle_file"
]);

function readWorkflowJson(filePath, label) {
  let raw;
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > 1024 * 1024) {
      throw new Error("workflow_file_size_invalid");
    }
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new BridgeServerError(
      "FILE_NOT_FOUND",
      `${label} was not found or exceeds the 1 MB workflow-data limit.`,
      { ...blockedState("FILE_NOT_FOUND"), status: "ERROR", code: "FILE_NOT_FOUND" }
    );
  }
  let value;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new BridgeServerError(
      "FILE_JSON_INVALID",
      `${label} must contain valid JSON.`,
      { ...blockedState("FILE_JSON_INVALID"), status: "ERROR", code: "FILE_JSON_INVALID" }
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeServerError(
      "FILE_JSON_OBJECT_REQUIRED",
      `${label} must contain one JSON object.`,
      { ...blockedState("FILE_JSON_OBJECT_REQUIRED"), status: "ERROR", code: "FILE_JSON_OBJECT_REQUIRED" }
    );
  }
  return value;
}

function resolveGitRoot(cwd = process.cwd()) {
  let resolved;
  try {
    resolved = fs.realpathSync(cwd);
  } catch {
    throw new BridgeServerError(
      "repository_not_found",
      "Run the Unclog setup prompt from an existing Git repository.",
      blockedState("repository_not_found")
    );
  }
  let gitRoot = resolved;
  while (!fs.existsSync(path.join(gitRoot, ".git"))) {
    const parent = path.dirname(gitRoot);
    if (parent === gitRoot) {
      throw new BridgeServerError(
        "git_repository_required",
        "Run the Unclog setup prompt from inside the Git repository you want to connect.",
        blockedState("git_repository_required")
      );
    }
    gitRoot = parent;
  }
  return gitRoot;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
  }
  return value;
}

function localArtifactDocumentHash(document) {
  return crypto.createHash("sha256").update(JSON.stringify(stableJsonValue(document))).digest("hex");
}

function assertNoSymlinkComponents(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BridgeServerError(
      "local_artifact_path_rejected",
      "Hosted Unclog local artifacts must stay inside this repository.",
      blockedState("local_artifact_path_rejected")
    );
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new BridgeServerError(
        "local_artifact_symlink_rejected",
        "Hosted Unclog local artifacts cannot pass through symbolic links.",
        blockedState("local_artifact_symlink_rejected")
      );
    }
  }
}

function resolveDraftArtifactPath(rawPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const root = options.root || resolveGitRoot(cwd);
  const target = path.resolve(cwd, String(rawPath || ""));
  const relative = path.relative(root, target).split(path.sep).join("/");
  const match = DRAFT_ARTIFACT_PATH.exec(relative);
  if (!match) {
    throw new BridgeServerError(
      "local_artifact_path_rejected",
      "Draft artifacts must use .unclog-drafts/<draft-id>/<known-file>.json inside this repository.",
      blockedState("local_artifact_path_rejected")
    );
  }
  assertNoSymlinkComponents(root, target);
  return { root, target, relative, draftId: match[1], name: `${match[2]}.json` };
}

function maybeResolveDraftArtifactPath(rawPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const root = options.root || resolveGitRoot(cwd);
  const target = path.resolve(cwd, String(rawPath || ""));
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative.startsWith(".unclog-drafts/")) return null;
  return resolveDraftArtifactPath(rawPath, { ...options, root });
}

function localArtifactEntry(relativePath, document) {
  const serialized = JSON.stringify(document);
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCAL_OUTPUT_BYTES) {
    throw new BridgeServerError(
      "local_artifact_too_large",
      "An Unclog workflow artifact exceeds the 1 MB transport limit.",
      blockedState("local_artifact_too_large")
    );
  }
  return { path: relativePath, document };
}

function localArtifactBundle(entries) {
  if (entries.length > MAX_LOCAL_ARTIFACT_COUNT) {
    throw new BridgeServerError(
      "local_artifact_count_invalid",
      "This repository contains too many active Unclog draft artifacts.",
      blockedState("local_artifact_count_invalid")
    );
  }
  const totalBytes = entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.document), "utf8"), 0);
  if (totalBytes > MAX_LOCAL_OUTPUT_BYTES) {
    throw new BridgeServerError(
      "local_artifacts_too_large",
      "Active Unclog draft metadata exceeds the 1 MB transport limit.",
      blockedState("local_artifacts_too_large")
    );
  }
  return { schema: LOCAL_ARTIFACT_SCHEMA, entries };
}

function collectDraftStatusArtifacts(options = {}) {
  const root = options.root || resolveGitRoot(options.cwd || process.cwd());
  const base = path.join(root, ".unclog-drafts");
  if (!fs.existsSync(base)) return localArtifactBundle([]);
  assertNoSymlinkComponents(root, base);
  const entries = [];
  for (const item of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!item.isDirectory() || !/^D\d{8}-\d{6}-[0-9a-f]{6}$/.test(item.name)) continue;
    const draftDir = path.join(base, item.name);
    assertNoSymlinkComponents(root, draftDir);
    const statusPath = path.join(draftDir, "status.json");
    if (!fs.existsSync(statusPath)) continue;
    const resolved = resolveDraftArtifactPath(statusPath, { root, cwd: root });
    entries.push(localArtifactEntry(resolved.relative, readWorkflowJson(resolved.target, "draft status")));
  }
  return localArtifactBundle(entries);
}

function attachDraftWorkflowContext(payload, filePath, workflowDocument, options = {}) {
  const root = resolveGitRoot(options.cwd || process.cwd());
  const draft = maybeResolveDraftArtifactPath(filePath, { ...options, root });
  if (!draft) return;
  if (draft.name !== "unclog_goals.json") {
    throw new BridgeServerError(
      "local_artifact_path_rejected",
      "Only an editable unclog_goals.json draft may be submitted as active goal intake.",
      blockedState("local_artifact_path_rejected")
    );
  }
  const entries = [localArtifactEntry(draft.relative, workflowDocument)];
  const statusPath = path.join(path.dirname(draft.target), "status.json");
  if (fs.existsSync(statusPath)) {
    const status = resolveDraftArtifactPath(statusPath, { root, cwd: root });
    entries.push(localArtifactEntry(status.relative, readWorkflowJson(status.target, "draft status")));
  }
  payload.local_artifacts = localArtifactBundle(entries);
  payload.workflow_file_path = draft.relative;
}

function canonicalCliArgv(command, positionals, flagTokens) {
  const argv = [...command.split("."), ...positionals.map(String)];
  for (let index = 0; index < flagTokens.length; index += 1) {
    const raw = String(flagTokens[index]);
    const key = normalizePayloadFlagKey(raw.slice(2));
    const next = flagTokens[index + 1];
    const hasValue = next && !String(next).startsWith("--") && !BOOLEAN_CLI_FLAGS.has(key);
    if (TRANSPORT_ONLY_FLAGS.has(key)) {
      if (hasValue) index += 1;
      continue;
    }
    argv.push(raw);
    if (hasValue) {
      let value = String(next);
      if (key === "file" && (INPUT_WORKFLOW_FILE_COMMANDS.has(command) || OUTPUT_WORKFLOW_FILE_COMMANDS.has(command))) {
        value = INPUT_WORKFLOW_FILE_COMMANDS.has(command) ? "workflow.json" : "output.json";
      } else if (key === "goal_contract_file") {
        value = "goal-contract.json";
      } else if (key === "closeout_sweep_file") {
        value = "closeout.json";
      }
      argv.push(value);
      index += 1;
    }
  }
  return argv;
}

function attachWorkflowDocuments(command, payload, flagTokens, options = {}) {
  const flags = parseFlagArgs(flagTokens);
  const filePath = flags.file;
  let localOutputPath;
  if (filePath && INPUT_WORKFLOW_FILE_COMMANDS.has(command)) {
    const localInputPath = path.resolve(options.cwd || process.cwd(), String(filePath));
    payload.workflow_document = readWorkflowJson(localInputPath, "--file");
    payload.file = "workflow.json";
    attachDraftWorkflowContext(payload, localInputPath, payload.workflow_document, options);
  } else if (filePath && OUTPUT_WORKFLOW_FILE_COMMANDS.has(command)) {
    payload.output_file_name = path.basename(String(filePath));
    localOutputPath = String(filePath);
  }
  const closeoutPath = flags["closeout-sweep-file"];
  if (closeoutPath) {
    payload.closeout_sweep = readWorkflowJson(closeoutPath, "--closeout-sweep-file");
    payload.closeout_sweep_file = "closeout.json";
  }
  const goalContractPath = flags["goal-contract-file"];
  if (goalContractPath) {
    payload.goal_contract_document = readWorkflowJson(goalContractPath, "--goal-contract-file");
    payload.goal_contract_file = "goal-contract.json";
  }
  if (payload.metadata && payload.metadata.flags) {
    delete payload.metadata.flags.file;
    delete payload.metadata.flags.closeout_sweep_file;
    delete payload.metadata.flags.goal_contract_file;
    delete payload.metadata.flags.json;
    if (Object.keys(payload.metadata.flags).length === 0) delete payload.metadata.flags;
    if (Object.keys(payload.metadata).length === 0) delete payload.metadata;
  }
  return localOutputPath;
}

function requiredReviewLifecycleStage(command, payload) {
  const decision = String(payload.decision || "").trim();
  if (command === "action-plan.revise" && decision === "certain_10_10") return "baseline";
  if (command === "set.submit") return "final";
  if (command === "set.revise" && decision === "certain_flawless_optimized") return "activate";
  return null;
}

function attachReviewLifecycle(command, payload, flagTokens) {
  const flags = parseFlagArgs(flagTokens);
  const filePath = flags["review-lifecycle-file"];
  const hasFileFlag = Object.prototype.hasOwnProperty.call(flags, "review-lifecycle-file");
  const expectedStage = requiredReviewLifecycleStage(command, payload);
  if (!expectedStage) {
    if (hasFileFlag) {
      throw new BridgeServerError(
        "REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH",
        "--review-lifecycle-file is accepted only for canonical baseline, final, and activate review milestones.",
        { ...blockedState("REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH"), status: "ERROR", code: "REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH" }
      );
    }
    return;
  }
  if (!filePath || filePath === "true") {
    throw new BridgeServerError(
      "REVIEW_LIFECYCLE_FILE_REQUIRED",
      `The ${expectedStage} review milestone requires --review-lifecycle-file.`,
      { ...blockedState("REVIEW_LIFECYCLE_FILE_REQUIRED"), status: "ERROR", code: "REVIEW_LIFECYCLE_FILE_REQUIRED" }
    );
  }
  const lifecycle = readWorkflowJson(filePath, "--review-lifecycle-file");
  if (String(lifecycle.stage || "").trim() !== expectedStage) {
    throw new BridgeServerError(
      "REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH",
      `Review lifecycle stage must be ${expectedStage} for this command.`,
      { ...blockedState("REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH"), status: "ERROR", code: "REVIEW_LIFECYCLE_STAGE_COMMAND_MISMATCH" }
    );
  }
  if (!String(lifecycle.goal_id || "").trim()) {
    throw new BridgeServerError(
      "REVIEW_LIFECYCLE_IDENTITY_REQUIRED",
      "Review lifecycle JSON must contain goal_id.",
      { ...blockedState("REVIEW_LIFECYCLE_IDENTITY_REQUIRED"), status: "ERROR", code: "REVIEW_LIFECYCLE_IDENTITY_REQUIRED" }
    );
  }
  payload.review_lifecycle = lifecycle;
  // The canonical action-plan CLI calls its acceptance decision certain_10_10,
  // while the hosted atomic review milestone uses the shared audit token.
  // Keep cli_argv canonical and translate only the server transport field.
  if (command === "action-plan.revise" && payload.decision === "certain_10_10") {
    payload.decision = "certain_flawless_optimized";
  }
  if (payload.metadata && payload.metadata.flags) {
    delete payload.metadata.flags.review_lifecycle_file;
    if (Object.keys(payload.metadata.flags).length === 0) delete payload.metadata.flags;
    if (Object.keys(payload.metadata).length === 0) delete payload.metadata;
  }
}

function writeHostedOutputFile(localOutputPath, result, options = {}) {
  const target = path.resolve(String(localOutputPath || ""));
  const generated = result && typeof result === "object"
    ? (result.generated_file || (result.domain && result.domain.generated_file))
    : null;
  if (!generated || typeof generated !== "object" || Array.isArray(generated) || !("content" in generated)) {
    throw new BridgeServerError(
      "server_output_missing",
      "Hosted Unclog did not return the requested output document.",
      blockedState("server_output_missing")
    );
  }
  const sessionDir = path.resolve(resolveSessionDir(options.sessionOptions || {}));
  const relativeToSession = path.relative(sessionDir, target);
  if (relativeToSession === "" || (!relativeToSession.startsWith("..") && !path.isAbsolute(relativeToSession))) {
    throw new BridgeServerError(
      "local_output_session_path_rejected",
      "Workflow output cannot overwrite the bridge session directory.",
      blockedState("local_output_session_path_rejected")
    );
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new BridgeServerError(
      "local_output_symlink_rejected",
      "Workflow output cannot be written through a symbolic link.",
      blockedState("local_output_symlink_rejected")
    );
  }
  const serialized = `${JSON.stringify(generated.content, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCAL_OUTPUT_BYTES) {
    throw new BridgeServerError(
      "local_output_too_large",
      "Hosted workflow output exceeds the 1 MB local output limit.",
      blockedState("local_output_too_large")
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serialized, { encoding: "utf8", mode: 0o600 });
  return {
    path: target,
    bytes: Buffer.byteLength(serialized, "utf8"),
    source: "hosted-generated-file"
  };
}

function extractLocalArtifactEffects(result) {
  if (!result || typeof result !== "object") return null;
  return result.local_artifact_effects || (result.domain && result.domain.local_artifact_effects) || null;
}

function readLocalArtifactDocument(target, label = "local artifact") {
  if (!fs.existsSync(target)) return null;
  if (fs.lstatSync(target).isSymbolicLink()) {
    throw new BridgeServerError(
      "local_artifact_symlink_rejected",
      `${label} cannot be read through a symbolic link.`,
      blockedState("local_artifact_symlink_rejected")
    );
  }
  return readWorkflowJson(target, label);
}

function validateLocalArtifactEffects(effects, options = {}) {
  if (!effects || typeof effects !== "object" || Array.isArray(effects)) {
    throw new BridgeServerError(
      "local_artifact_effects_invalid",
      "Hosted Unclog returned an invalid local artifact effect envelope.",
      blockedState("local_artifact_effects_invalid")
    );
  }
  if (effects.schema !== LOCAL_ARTIFACT_EFFECTS_SCHEMA || !/^[0-9a-f]{64}$/.test(String(effects.effect_id || ""))) {
    throw new BridgeServerError(
      "local_artifact_effects_invalid",
      "Hosted Unclog returned an unsupported local artifact effect contract.",
      blockedState("local_artifact_effects_invalid")
    );
  }
  if (!Array.isArray(effects.operations) || effects.operations.length > MAX_LOCAL_ARTIFACT_COUNT) {
    throw new BridgeServerError(
      "local_artifact_effects_invalid",
      "Hosted Unclog returned too many local artifact operations.",
      blockedState("local_artifact_effects_invalid")
    );
  }
  if (localArtifactDocumentHash(effects.operations) !== effects.effect_id) {
    throw new BridgeServerError(
      "local_artifact_effects_checksum_mismatch",
      "Hosted Unclog local artifact operations did not match their signed effect identity.",
      blockedState("local_artifact_effects_checksum_mismatch")
    );
  }
  const root = options.root || resolveGitRoot(options.cwd || process.cwd());
  const operations = effects.operations.map((raw) => {
    if (!raw || typeof raw !== "object" || !["write_json", "rename", "delete"].includes(raw.op)) {
      throw new BridgeServerError(
        "local_artifact_effects_invalid",
        "Hosted Unclog returned an unknown local artifact operation.",
        blockedState("local_artifact_effects_invalid")
      );
    }
    const destination = resolveDraftArtifactPath(raw.path, { root, cwd: root });
    if (!/^[0-9a-f]{64}$/.test(String(raw.sha256 || ""))) {
      throw new BridgeServerError(
        "local_artifact_effects_invalid",
        "Hosted Unclog returned an invalid local artifact checksum.",
        blockedState("local_artifact_effects_invalid")
      );
    }
    if (raw.op === "write_json") {
      if (!raw.document || typeof raw.document !== "object" || Array.isArray(raw.document)) {
        throw new BridgeServerError(
          "local_artifact_effects_invalid",
          "Hosted Unclog returned an invalid local JSON document.",
          blockedState("local_artifact_effects_invalid")
        );
      }
      if (localArtifactDocumentHash(raw.document) !== raw.sha256) {
        throw new BridgeServerError(
          "local_artifact_checksum_mismatch",
          "Hosted Unclog local artifact content did not match its checksum.",
          blockedState("local_artifact_checksum_mismatch")
        );
      }
      if (raw.before_sha256 !== null && raw.before_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(raw.before_sha256))) {
        throw new BridgeServerError(
          "local_artifact_effects_invalid",
          "Hosted Unclog returned an invalid local artifact precondition.",
          blockedState("local_artifact_effects_invalid")
        );
      }
      return { ...raw, destination };
    }
    if (raw.op === "rename") {
      const source = resolveDraftArtifactPath(raw.from, { root, cwd: root });
      if (path.dirname(source.target) !== path.dirname(destination.target)) {
        throw new BridgeServerError(
          "local_artifact_path_rejected",
          "A draft artifact rename cannot cross draft directories.",
          blockedState("local_artifact_path_rejected")
        );
      }
      return { ...raw, source, destination };
    }
    return { ...raw, destination };
  });
  return { root, effectId: effects.effect_id, operations, envelope: effects };
}

function atomicWriteLocalJson(target, document) {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCAL_OUTPUT_BYTES) {
    throw new BridgeServerError(
      "local_artifact_too_large",
      "Hosted Unclog local artifact exceeds the 1 MB limit.",
      blockedState("local_artifact_too_large")
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (fs.existsSync(target)) fs.rmSync(target);
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 0o600); } catch { /* Windows ACLs remain authoritative. */ }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

function applyValidatedLocalArtifactEffects(validated) {
  let applied = 0;
  for (const operation of validated.operations) {
    if (operation.op === "write_json") {
      const current = readLocalArtifactDocument(operation.destination.target);
      const currentHash = current ? localArtifactDocumentHash(current) : null;
      if (currentHash === operation.sha256) continue;
      const expectedBefore = operation.before_sha256 === undefined ? null : operation.before_sha256;
      if (currentHash !== null && (expectedBefore === null || currentHash !== expectedBefore)) {
        throw new BridgeServerError(
          "local_artifact_conflict",
          `Unclog did not overwrite a locally changed draft artifact: ${operation.destination.relative}`,
          blockedState("local_artifact_conflict")
        );
      }
      atomicWriteLocalJson(operation.destination.target, operation.document);
      applied += 1;
      continue;
    }
    if (operation.op === "rename") {
      const sourceDocument = readLocalArtifactDocument(operation.source.target);
      const destinationDocument = readLocalArtifactDocument(operation.destination.target);
      const sourceHash = sourceDocument ? localArtifactDocumentHash(sourceDocument) : null;
      const destinationHash = destinationDocument ? localArtifactDocumentHash(destinationDocument) : null;
      if (destinationHash === operation.sha256) {
        if (sourceHash !== null && sourceHash !== operation.sha256) {
          throw new BridgeServerError(
            "local_artifact_conflict",
            `Unclog did not remove a locally changed draft artifact: ${operation.source.relative}`,
            blockedState("local_artifact_conflict")
          );
        }
        if (sourceHash === operation.sha256) fs.rmSync(operation.source.target);
        continue;
      }
      if (destinationHash !== null || sourceHash !== operation.sha256) {
        throw new BridgeServerError(
          "local_artifact_conflict",
          `Unclog could not safely archive draft artifact: ${operation.source.relative}`,
          blockedState("local_artifact_conflict")
        );
      }
      fs.mkdirSync(path.dirname(operation.destination.target), { recursive: true });
      fs.renameSync(operation.source.target, operation.destination.target);
      applied += 1;
      continue;
    }
    const current = readLocalArtifactDocument(operation.destination.target);
    if (!current) continue;
    if (localArtifactDocumentHash(current) !== operation.sha256) {
      throw new BridgeServerError(
        "local_artifact_conflict",
        `Unclog did not delete a locally changed draft artifact: ${operation.destination.relative}`,
        blockedState("local_artifact_conflict")
      );
    }
    fs.rmSync(operation.destination.target);
    applied += 1;
  }
  return applied;
}

function localArtifactJournalDirectory(root) {
  return path.join(root, ".unclog-drafts", ".bridge-effects");
}

function persistLocalArtifactEffect(validated) {
  const journalDirectory = localArtifactJournalDirectory(validated.root);
  assertNoSymlinkComponents(validated.root, journalDirectory);
  fs.mkdirSync(journalDirectory, { recursive: true });
  const journalPath = path.join(journalDirectory, `${validated.effectId}.json`);
  if (fs.existsSync(journalPath)) {
    const existing = readWorkflowJson(journalPath, "local artifact recovery journal");
    if (JSON.stringify(stableJsonValue(existing)) !== JSON.stringify(stableJsonValue(validated.envelope))) {
      throw new BridgeServerError(
        "local_artifact_journal_conflict",
        "A local Unclog artifact recovery record has conflicting content.",
        blockedState("local_artifact_journal_conflict")
      );
    }
  } else {
    atomicWriteLocalJson(journalPath, validated.envelope);
  }
  return journalPath;
}

function applyHostedLocalArtifactEffects(result, options = {}) {
  const effects = extractLocalArtifactEffects(result);
  if (!effects) return null;
  const validated = validateLocalArtifactEffects(effects, options);
  if (validated.operations.length === 0) {
    return { effect_id: validated.effectId, applied: 0, reconciled: true };
  }
  const journalPath = persistLocalArtifactEffect(validated);
  const applied = applyValidatedLocalArtifactEffects(validated);
  if (fs.existsSync(journalPath)) fs.rmSync(journalPath);
  return { effect_id: validated.effectId, applied, reconciled: true };
}

function reconcilePendingLocalArtifactEffects(options = {}) {
  const root = options.root || resolveGitRoot(options.cwd || process.cwd());
  const journalDirectory = localArtifactJournalDirectory(root);
  if (!fs.existsSync(journalDirectory)) return { reconciled: 0 };
  assertNoSymlinkComponents(root, journalDirectory);
  let reconciled = 0;
  for (const item of fs.readdirSync(journalDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!item.isFile() || !/^[0-9a-f]{64}\.json$/.test(item.name)) continue;
    const journalPath = path.join(journalDirectory, item.name);
    if (fs.lstatSync(journalPath).isSymbolicLink()) {
      throw new BridgeServerError(
        "local_artifact_symlink_rejected",
        "A local Unclog artifact recovery record cannot be a symbolic link.",
        blockedState("local_artifact_symlink_rejected")
      );
    }
    const effects = readWorkflowJson(journalPath, "local artifact recovery journal");
    const validated = validateLocalArtifactEffects(effects, { ...options, root });
    applyValidatedLocalArtifactEffects(validated);
    fs.rmSync(journalPath);
    reconciled += 1;
  }
  return { reconciled };
}

function flagsToWorkflowPayload(argv = []) {
  const rawFlags = parseFlagArgs(argv);
  const payload = {};
  const metadataFlags = {};
  for (const [rawKey, value] of Object.entries(rawFlags)) {
    const normalizedKey = normalizePayloadFlagKey(rawKey);
    if (normalizedKey === "raw" || normalizedKey === "debug") continue;
    const key = PAYLOAD_FLAG_ALIASES[normalizedKey] || normalizedKey;
    if (!key) {
      continue;
    }
    if (TOP_LEVEL_PAYLOAD_FLAGS.has(key)) {
      payload[key] = value;
    } else {
      metadataFlags[key] = value;
    }
  }
  if (Object.keys(metadataFlags).length > 0) {
    payload.metadata = { flags: metadataFlags };
  }
  return payload;
}

function assignFirstMissing(payload, key, value) {
  if (value !== undefined && value !== "" && !Object.prototype.hasOwnProperty.call(payload, key)) {
    payload[key] = value;
  }
}

function attachPositionals(command, payload, positionals) {
  if (!positionals.length) {
    return payload;
  }
  const first = String(positionals[0]);
  if (command === "action.check" || command === "action.revise" || command === "action.proof-lint" || command === "action.proof-repair-json") {
    assignFirstMissing(payload, "action_id", first);
    return payload;
  }
  if (command === "mission.select" || command === "mission.rename") {
    assignFirstMissing(payload, "mission_id", first);
    return payload;
  }
  if (command.startsWith("inbox.") && command !== "inbox.capture" && command !== "inbox.packet" && command !== "inbox.list") {
    if (command === "inbox.merge") {
      payload.item_ids = payload.item_ids || positionals.map(String);
    } else {
      assignFirstMissing(payload, "item_id", first);
    }
    return payload;
  }
  if (command.startsWith("goals.") && !["goals.template", "goals.export", "goals.update", "goals.extend", "goals.lint", "goals.patch-template", "goals.patch", "goals.lock", "goals.status"].includes(command)) {
    if (command === "goals.merge") {
      payload.goal_ids = payload.goal_ids || positionals.map(String);
    } else {
      assignFirstMissing(payload, "goal_id", first);
    }
    return payload;
  }
  if (command === "action-plan.rename" || command === "action-plan.move") {
    assignFirstMissing(payload, "action_id", first);
    return payload;
  }
  payload.metadata = {
    ...(payload.metadata || {}),
    args: positionals.map(String)
  };
  return payload;
}

function splitCommandAndFlagTokens(argv = []) {
  const commandTokens = [];
  const flagTokens = [];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index]);
    if (raw.startsWith("--")) {
      flagTokens.push(raw);
      const next = argv[index + 1];
      if (next && !String(next).startsWith("--") && !BOOLEAN_CLI_FLAGS.has(normalizePayloadFlagKey(raw.slice(2)))) {
        flagTokens.push(String(next));
        index += 1;
      }
    } else {
      commandTokens.push(raw);
    }
  }
  return { commandTokens, flagTokens };
}

function parseHostedCommandArgv(argv = [], options = {}) {
  const { commandTokens, flagTokens } = splitCommandAndFlagTokens(argv);

  for (let length = commandTokens.length; length >= 1; length -= 1) {
    const candidate = normalizeHostedCommand(commandTokens.slice(0, length).join(" "));
    const status = hostedCommandStatus(candidate);
    if (status.supported || status.reason === "unsupported_command") {
      const positionals = commandTokens.slice(length);
      const payload = attachPositionals(status.command, flagsToWorkflowPayload(flagTokens), positionals);
      const localOutputPath = attachWorkflowDocuments(status.command, payload, flagTokens, options);
      if (status.command === "drafts.list" || status.command === "next") {
        payload.local_artifacts = collectDraftStatusArtifacts(options);
      }
      attachReviewLifecycle(status.command, payload, flagTokens);
      payload.cli_argv = canonicalCliArgv(status.command, positionals, flagTokens);
      return {
        command: status.command,
        payload,
        ...(localOutputPath ? { localOutputPath } : {})
      };
    }
  }

  return {
    command: normalizeHostedCommand(commandTokens.join(" ")),
    payload: attachPositionals("", flagsToWorkflowPayload(flagTokens), []),
  };
}

function sessionOptionsFor(apiBaseUrl, options = {}) {
  return {
    ...(options.sessionOptions || {}),
    allowLocalHttp:
      options.allowLocalHttp === true ||
      /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(apiBaseUrl)) ||
      (options.sessionOptions || {}).allowLocalHttp === true
  };
}

function repositoryIdentity(cwd = process.cwd()) {
  const gitRoot = resolveGitRoot(cwd);
  return {
    label: path.basename(gitRoot) || "Repository",
    fingerprint: crypto.createHash("sha256").update(gitRoot).digest("hex")
  };
}

async function openHostedApprovalUrl(rawUrl, options = {}) {
  let approvalUrl;
  try {
    approvalUrl = normalizeHostedPublicUrl(rawUrl, {
      allowLocalHttp: options.allowLocalHttp === true
    });
  } catch {
    return false;
  }
  if (options.openBrowser === false) return false;
  if (typeof options.openBrowser === "function") {
    try { return await options.openBrowser(approvalUrl) !== false; } catch { return false; }
  }
  const platform = options.platform || process.platform;
  const launcher = platform === "win32"
    ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", approvalUrl] }
    : platform === "darwin"
      ? { command: "open", args: [approvalUrl] }
      : { command: "xdg-open", args: [approvalUrl] };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = childProcess.spawn(launcher.command, launcher.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.once("error", () => finish(false));
      child.once("spawn", () => {
        child.unref();
        finish(true);
      });
    } catch {
      finish(false);
    }
  });
}

function newSessionToken() {
  return `us_${crypto.randomBytes(32).toString("base64url")}`;
}

function newDeviceAuthorizationMaterial() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let compact = "";
  const random = crypto.randomBytes(8);
  for (let index = 0; index < random.length; index += 1) {
    compact += alphabet[random[index] % alphabet.length];
  }
  return {
    deviceCode: `dc_${crypto.randomBytes(32).toString("base64url")}`,
    userCode: `${compact.slice(0, 4)}-${compact.slice(4)}`
  };
}

async function postDeviceJson(activeFetch, apiBaseUrl, endpoint, body) {
  let response;
  try {
    response = await activeFetch(`${apiBaseUrl}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-unclog-bridge-version": BRIDGE_VERSION },
      body: JSON.stringify(body)
    });
  } catch {
    throw new BridgeServerError("server_unreachable", "Hosted Unclog could not be reached.", blockedState("server_unreachable"));
  }
  const data = await readHostedJson(response);
  if (!response.ok || data.status === "error") {
    const publicState = normalizeHostedDenial(data);
    throw new BridgeServerError(data.code || "connection_rejected", data.message || "Hosted Unclog rejected this connection.", publicState);
  }
  return data;
}

function renderCanonicalHostedCommand(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^unclog(?:\.exe)?\s+--[a-z0-9-]+(?:\s|$)/i.test(trimmed)) return value;
  const args = trimmed
    .replace(/^unclog(?:\.exe)?\s*/i, "")
    .replace(/(^|\s)--json(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return `npx --yes unclog-bridge@${BRIDGE_VERSION}${args ? ` ${args}` : ""}`;
}

function renderHostedGuidance(markdown) {
  if (typeof markdown !== "string") return markdown;
  return markdown
    .replace(/`unclog(?:\.exe)?\s+(--[a-z0-9-]+[^`\r\n]*)`/gi, (_match, args) => `\`${renderCanonicalHostedCommand(`unclog ${args}`)}\``)
    .replace(/(^|\n)([ \t]*)unclog(?:\.exe)?\s+(--[a-z0-9-]+[^\r\n]*)/gi, (_match, lead, indent, args) => (
      `${lead}${indent}${renderCanonicalHostedCommand(`unclog ${args}`)}`
    ));
}

function renderHostedTransport(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => renderHostedTransport(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, renderHostedTransport(child, childKey)])
    );
  }
  if (typeof value !== "string") return value;
  if (key === "guidance_markdown") return renderHostedGuidance(value);
  return renderCanonicalHostedCommand(value);
}

function boundedDraftPreviewText(value, maxChars = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function readLocalDraftPreview(draft, options = {}) {
  try {
    const root = options.root || resolveGitRoot(options.cwd || process.cwd());
    const goalsPath = resolveDraftArtifactPath(draft.file, { ...options, root });
    const statusPath = resolveDraftArtifactPath(draft.status_file, { ...options, root });
    if (goalsPath.name !== "unclog_goals.json" || statusPath.name !== "status.json" || goalsPath.draftId !== statusPath.draftId) {
      throw new Error("local_draft_preview_path_mismatch");
    }
    const goalsDocument = readWorkflowJson(goalsPath.target, "local goals draft");
    const statusDocument = readWorkflowJson(statusPath.target, "local draft status");
    const goals = Array.isArray(goalsDocument.goals) ? goalsDocument.goals : [];
    const firstGoal = goals.find((goal) => goal && typeof goal === "object");
    return {
      available: true,
      state: goals.length === 0 ? "empty" : "has_goals",
      top_level_goal_count: goals.length,
      first_big_goal: boundedDraftPreviewText(firstGoal && firstGoal.text),
      last_edited_at: String(statusDocument.updated_at || statusDocument.created_at || draft.updated_at || "") || null,
      source: "bounded_local_draft_preview"
    };
  } catch {
    return {
      available: false,
      state: "unavailable",
      top_level_goal_count: null,
      first_big_goal: null,
      last_edited_at: String(draft.updated_at || "") || null,
      source: "bounded_local_draft_preview"
    };
  }
}

function compactDraftListing(result, options = {}) {
  if (result.command !== "drafts.list" || !Array.isArray(result.drafts)) return result;
  const allDrafts = result.drafts;
  const activeDrafts = allDrafts.filter((draft) => (
    draft && draft.status === "intake" && draft.editable === true
  )).map((draft) => ({
    ...draft,
    local_preview: readLocalDraftPreview(draft, options)
  }));
  const availablePreviews = activeDrafts.map((draft) => draft.local_preview).filter((preview) => preview.available);
  return {
    ...result,
    drafts: activeDrafts,
    draft_summary: {
      active_editable_count: activeDrafts.length,
      empty_count: availablePreviews.filter((preview) => preview.state === "empty").length,
      with_goals_count: availablePreviews.filter((preview) => preview.state === "has_goals").length,
      preview_unavailable_count: activeDrafts.length - availablePreviews.length,
      submitted_history_count: allDrafts.filter((draft) => draft && draft.status === "submitted").length,
      total_count: allDrafts.length,
      default_view: "active_editable_only",
      selection_rule: "Match the draft to the user's current request; recency alone is not a semantic match.",
      create_new_when: "The request is clearly independent and no active draft matches.",
      history_command: `npx --yes unclog-bridge@${BRIDGE_VERSION} drafts list --raw`
    }
  };
}

const MANAGER_MONITOR_REDUNDANT_KEYS = [
  "billing",
  "contract",
  "device",
  "command_state",
  "capsule",
  "active_worker_count",
  "pending_worker_count",
  "blocked_worker_count",
  "stale_worker_count",
  "needs_attention_worker_count",
  "done_worker_count",
  "agent_assignment",
  "assignment_ready",
  "assignment_needs_replan",
  "mode",
  "agent_count",
  "agent_status_counts",
  "active_agent_count",
  "completed_agent_count",
  "blocked_agent_count",
  "stale_agent_count",
  "needs_attention_agent_count",
  "pending_agent_count",
  "agents",
  "agent_progress",
  "constraints",
  "watchdog_mode",
  "official_health_checker",
  "routine_check",
  "ai_invocations",
  "device_pings",
  "now",
  "interval_minutes",
  "stale_after_minutes",
  "state_store",
  "next_watch_at",
  "main_validation_required",
  "nudge_stale",
  "cooldown_minutes",
  "max_nudges",
  "local_artifacts",
  "adapter_refresh"
];

function compactManagerMonitoring(result) {
  if (!result || !["agents.status", "agents.watch"].includes(result.command)) return result;
  const statusShape = Boolean(result.manager_monitoring_guidance && result.worker_status_counts);
  const watchShape = result.command === "agents.watch" && Array.isArray(result.rows) && result.counts && typeof result.counts === "object";
  if (!statusShape && !watchShape) return result;
  const compact = { ...result };
  for (const key of MANAGER_MONITOR_REDUNDANT_KEYS) delete compact[key];
  if (Array.isArray(compact.required_fields) && compact.required_fields.length === 0) delete compact.required_fields;
  if (compact.field_guide && typeof compact.field_guide === "object" && Object.keys(compact.field_guide).length === 0) {
    delete compact.field_guide;
  }
  if (compact.agent_instruction && typeof compact.agent_instruction === "object") {
    const instruction = compact.agent_instruction;
    compact.agent_instruction = {
      schema: instruction.schema,
      instruction_id: instruction.instruction_id,
      phase: instruction.phase,
      next_action_code: instruction.next_action_code,
      authority: instruction.authority,
      guidance_sha256: instruction.guidance_sha256,
      canonical_guidance_sha256: instruction.canonical_guidance_sha256,
      transport: instruction.transport,
      guidance_delivery: "Routine manager monitoring omits repeated full phase guidance. Follow next_action and commands_now; the next non-monitor response carries the complete live guidance."
    };
    compact.agent_instruction = Object.fromEntries(
      Object.entries(compact.agent_instruction).filter(([, value]) => value !== undefined)
    );
  }
  compact.output_view = {
    mode: watchShape ? "compact_manager_watch" : "compact_manager_monitor",
    preserved: [
      "next_action",
      "commands_now",
      "manager_monitoring_guidance",
      "worker_monitor_signals",
      "worker_status_counts",
      "counts",
      "rows",
      "events",
      "manager_live_notes",
      "do_not",
      "agent_instruction"
    ].filter((key) => Object.hasOwn(compact, key)),
    full_diagnostics: "Use --raw only for human diagnostics when this view lacks required context; never execute canonical bare unclog commands from raw output."
  };
  return compact;
}

function presentHostedResult(result, options = {}) {
  const raw = options.raw === true;
  const canonical = JSON.parse(JSON.stringify(result || {}));
  const bridgeCommands = Array.isArray(canonical.commands_now)
    ? canonical.commands_now.map(renderCanonicalHostedCommand)
    : [];
  if (raw) {
    return { ...canonical, bridge_commands_now: bridgeCommands };
  }
  let rendered = renderHostedTransport(canonical);
  rendered.bridge_commands_now = bridgeCommands;
  if (rendered.agent_instruction && typeof rendered.agent_instruction === "object") {
    const canonicalHash = String(canonical.agent_instruction?.guidance_sha256 || "");
    const renderedGuidance = String(rendered.agent_instruction.guidance_markdown || "");
    rendered.agent_instruction = {
      ...rendered.agent_instruction,
      canonical_guidance_sha256: canonicalHash,
      guidance_sha256: crypto.createHash("sha256").update(renderedGuidance).digest("hex"),
      transport: {
        ...(rendered.agent_instruction.transport || {}),
        canonical_command_notation_only: false,
        executable_commands_field: "commands_now",
        rendered_by_bridge_version: BRIDGE_VERSION
      }
    };
  }
  for (const key of ["command_status", "domain", "entitlement", "local_contract", "refresh", "source"]) {
    delete rendered[key];
  }
  rendered = compactDraftListing(rendered, options);
  rendered = compactManagerMonitoring(rendered);
  return rendered;
}

function installHostedAdapter(tool, homeDir = os.homedir()) {
  const marker = "<!-- unclog-hosted-adapter-v2 -->";
  const ownedMarkers = [marker, "<!-- unclog-hosted-adapter-v1 -->"];
  const content = `---\nname: unclog-hosted\ndescription: Use when a repository is connected to hosted Unclog, when the user asks to start, continue, resume, or check Unclog work, or immediately after hosted setup completes. Use only the official thin bridge and follow the server-provided next action.\n---\n\n${marker}\n# Hosted Unclog\n\nThis is a bootstrap only. Use the published \`unclog-bridge\` thin CLI; never use or install a private/local Unclog CLI and never edit \`.unclog\`. Only the active intake file under \`.unclog-drafts\` may be edited locally.\n\nRun \`npx --yes unclog-bridge@${BRIDGE_VERSION} follow\`. When present, treat \`agent_instruction.guidance_markdown\` as the live phase skill selected by hosted Unclog. Routine manager status/watch may instead return a compact \`guidance_delivery\` identity; in that case \`next_action\`, \`commands_now\`, and \`do_not\` are sufficient. Execute only the bridge-rendered \`commands_now\`. Continue an existing \`local_draft.file\` instead of creating a duplicate. The server owns workflow state and the bridge owns transport. Do not guess the next workflow command or reconstruct the workflow locally. If authentication is missing, ask the user to copy a fresh setup prompt from the hosted dashboard.\n`;
  const relative = tool === "claude"
    ? path.join(".claude", "skills", "unclog-hosted", "SKILL.md")
    : path.join(".agents", "skills", "unclog-hosted", "SKILL.md");
  const legacyRelative = tool === "claude"
    ? path.join(".claude", "commands", "unclog-hosted.md")
    : null;
  const target = path.join(homeDir, relative);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8");
    if (!ownedMarkers.some((ownedMarker) => existing.includes(ownedMarker))) {
      throw new BridgeServerError("adapter_path_conflict", `Unclog did not overwrite existing file ${relative}.`, blockedState("adapter_path_conflict"));
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
  let removedLegacyAdapter = false;
  if (legacyRelative) {
    const legacyTarget = path.join(homeDir, legacyRelative);
    if (fs.existsSync(legacyTarget) && ownedMarkers.some((ownedMarker) => fs.readFileSync(legacyTarget, "utf8").includes(ownedMarker))) {
      fs.rmSync(legacyTarget);
      removedLegacyAdapter = true;
    }
  }
  return {
    tool,
    path: path.join("~", relative).replaceAll("\\", "/"),
    customerSafe: true,
    localWorkflowFallback: false,
    removedLegacyAdapter
  };
}

async function connectWithSetupIntent(argv = [], options = {}) {
  const flags = parseFlagArgs(argv);
  const setupIntent = flags["setup-intent"];
  const tool = String(flags.tool || "").trim().toLowerCase();
  const apiBaseUrl = flags["api-base-url"] || process.env.UNCLOG_API_URL || "https://api.unclog.dev";
  if (!setupIntent || !["codex", "claude"].includes(tool)) {
    throw new BridgeServerError(
      "connect_args_required",
      "Connect requires --setup-intent and --tool codex|claude.",
      {
        blocked: true,
        reason: "connect_args_required",
        title: "Setup prompt incomplete",
        message: "Run the setup prompt exactly from your hosted Unclog dashboard.",
        primaryAction: "Copy setup prompt again",
        secondaryAction: "Open hosted setup"
      }
    );
  }
  const sessionOptions = sessionOptionsFor(apiBaseUrl, options);
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl, sessionOptions);
  let existingSession = null;
  try {
    existingSession = loadSession(sessionOptions);
  } catch (error) {
    if (!(error instanceof SessionStorageError) || ![
      "session_credential_missing",
      "session_credential_invalid"
    ].includes(error.code)) {
      throw error;
    }
    clearSession(sessionOptions);
  }
  const activeFetch = resolveFetch(options.fetchImpl);
  const repository = repositoryIdentity(options.cwd || process.cwd());
  const retryMaterial = newDeviceAuthorizationMaterial();
  const authorizationBody = {
    setup_intent: String(setupIntent),
    device_code: retryMaterial.deviceCode,
    user_code: retryMaterial.userCode,
    tool,
    client_version: BRIDGE_VERSION,
    device_label: `${os.hostname()} (${tool})`,
    repository_label: repository.label,
    repository_fingerprint: repository.fingerprint
  };
  let authorization;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      authorization = await postDeviceJson(
        activeFetch,
        normalizedApiBaseUrl,
        DEVICE_AUTHORIZE_ENDPOINT,
        authorizationBody
      );
      break;
    } catch (error) {
      if (!(error instanceof BridgeServerError) || error.code !== "server_unreachable" || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }
  const notifyStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  try {
    notifyStatus({
      stage: "waiting_for_dashboard_approval",
      message: "Connection request sent. Approve it in the Unclog dashboard that is already open."
    });
  } catch {}
  const sessionToken = newSessionToken();
  const deadline = Date.parse(authorization.expires_at || "") || Date.now() + 10 * 60 * 1000;
  let intervalMs = Math.max(250, Number(options.pollIntervalMs || authorization.interval * 1000 || 2000));
  const fallbackDelayMs = Math.max(0, Number(options.fallbackDelayMs ?? 8000));
  const pollRetryBaseMs = Math.max(1, Number(options.pollRetryBaseMs ?? 1000));
  const fallbackAt = Date.now() + fallbackDelayMs;
  let fallbackShown = false;
  let exchange;
  let consecutivePollFailures = 0;
  let lastPollError = null;

  async function showApprovalFallbackIfNeeded() {
    if (fallbackShown || Date.now() < fallbackAt || !authorization.verification_uri_complete) return;
    fallbackShown = true;
    const browserOpened = await openHostedApprovalUrl(authorization.verification_uri_complete, {
      openBrowser: options.openBrowser,
      platform: options.platform,
      allowLocalHttp: sessionOptions.allowLocalHttp === true
    });
    try {
      notifyStatus({
        stage: "approval_fallback",
        message: browserOpened
          ? "A one-time approval page was opened. Approve there if the dashboard did not detect this request."
          : "The browser could not be opened automatically. Open this one-time approval link.",
        browser_opened: browserOpened,
        approval_url: authorization.verification_uri_complete
      });
    } catch {}
  }

  while (Date.now() < deadline) {
    try {
      exchange = await postDeviceJson(activeFetch, normalizedApiBaseUrl, DEVICE_TOKEN_ENDPOINT, {
        device_code: authorization.device_code,
        session_token: sessionToken,
        client_version: BRIDGE_VERSION
      });
      consecutivePollFailures = 0;
      lastPollError = null;
    } catch (error) {
      const retryable = error instanceof BridgeServerError && [
        "server_unreachable",
        "request_burst_limited",
        "device_token_exchange_rate_limited"
      ].includes(error.code);
      if (!retryable) throw error;
      consecutivePollFailures += 1;
      lastPollError = error;
      const retryAfterSeconds = Number(error.publicState?.retry_after_seconds || 0);
      intervalMs = Math.min(
        10_000,
        Math.max(intervalMs, retryAfterSeconds * 1000, consecutivePollFailures * pollRetryBaseMs)
      );
      try {
        notifyStatus({
          stage: "approval_poll_retry",
          message: "The hosted connection check was interrupted. Retrying automatically.",
          retry_after_seconds: Math.max(1, Math.ceil(intervalMs / 1000))
        });
      } catch {}
      await showApprovalFallbackIfNeeded();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (exchange.status === "approved") break;
    if (exchange.status === "access_denied") {
      throw new BridgeServerError("access_denied", "The Unclog dashboard denied this connection.", blockedState("access_denied"));
    }
    if (exchange.status === "expired_token") {
      throw new BridgeServerError("setup_intent_expired", "This setup prompt expired. Copy a new prompt.", blockedState("setup_intent_expired"));
    }
    if (exchange.status === "slow_down") {
      intervalMs = Math.max(intervalMs, Number(exchange.retry_after_seconds || 3) * 1000);
    }
    await showApprovalFallbackIfNeeded();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!exchange || exchange.status !== "approved" || !exchange.session_id || !exchange.project_id) {
    if (lastPollError) {
      throw new BridgeServerError(
        "approval_poll_timeout",
        "Network interruptions prevented this connection from completing before it expired. Copy a new setup prompt.",
        blockedState("server_unreachable")
      );
    }
    throw new BridgeServerError("setup_intent_expired", "This setup prompt expired before approval. Copy a new prompt.", blockedState("setup_intent_expired"));
  }
  const sessionRecord = {
    apiBaseUrl: normalizedApiBaseUrl,
    deviceSessionId: exchange.session_id,
    projectId: exchange.project_id,
    tool,
    expiresAt: exchange.expires_at
  };
  const session = { ...sessionRecord, sessionToken, allowLocalHttp: sessionOptions.allowLocalHttp === true };
  let saved = null;
  let replacedExistingSession = false;
  try {
    const adapter = installHostedAdapter(tool, options.homeDir || os.homedir());
    if (existingSession) {
      try {
        await callHostedSessionRevoke({
          projectId: existingSession.projectId,
          session: existingSession,
          fetchImpl: activeFetch
        });
      } catch (error) {
        if (!(error instanceof BridgeServerError) || error.code !== "bridge_session_revoke_failed") {
          throw error;
        }
      }
      clearSession(sessionOptions);
      replacedExistingSession = true;
    }
    saved = saveSession(sessionRecord, sessionToken, sessionOptions);
    const link = await callHostedProjectLink({ projectId: exchange.project_id, session, fetchImpl: activeFetch });
    const firstInstructionRaw = await callHostedCommand({ command: "next", payload: { project_id: exchange.project_id }, session, fetchImpl: activeFetch });
    const firstInstruction = presentHostedResult(firstInstructionRaw);
    return {
      ok: true,
      linked: true,
      status: "connected",
      existing_session_detected: Boolean(existingSession),
      replaced_existing_session: replacedExistingSession,
      message: "Hosted Unclog is connected. Continue with the hosted instruction below.",
      project: link.project,
      device: link.device,
      adapter,
      storage: {
        path: saved.path,
        secretStore: saved.credentialStorage,
        sessionMetadataContainsSecret: false,
        persistedSecretMaterial: saved.credentialStorage === "permission-protected file"
      },
      next_action: firstInstruction.next_action,
      commands_now: firstInstruction.commands_now || [],
      agent_instruction: firstInstruction.agent_instruction,
      hosted_instruction: firstInstruction
    };
  } catch (error) {
    try { await callHostedSessionRevoke({ projectId: exchange.project_id, session, fetchImpl: activeFetch }); } catch {}
    if (saved) clearSession(sessionOptions);
    throw error;
  }
}

async function logout(options = {}) {
  const sessionOptions = options.sessionOptions || {};
  const session = options.session || loadSession(sessionOptions);
  let revocation = { revoked: false, alreadySignedOut: true };
  if (session) {
    revocation = await callHostedSessionRevoke({
      session,
      fetchImpl: options.fetchImpl,
      projectId: session.projectId
    });
  }
  clearSession(sessionOptions);
  return {
    ok: true,
    serverRevoked: revocation.revoked === true,
    title: "Unclog bridge session cleared",
    message: session
      ? "This device was revoked by hosted Unclog and must log in again."
      : "No active bridge session remained on this device."
  };
}

function requireSession(session) {
  if (!session || !session.apiBaseUrl || !session.deviceSessionId || !session.sessionToken) {
    throw new MissingAuthError();
  }
  try {
    return {
      ...session,
      apiBaseUrl: normalizeApiBaseUrl(session.apiBaseUrl, { allowLocalHttp: session.allowLocalHttp === true })
    };
  } catch {
    throw new BridgeServerError(
      "session_api_base_url_invalid",
      "Bridge session must target a valid HTTPS hosted Unclog endpoint.",
      blockedState("auth_required")
    );
  }
}

function resolveFetch(fetchImpl) {
  const activeFetch = fetchImpl || globalThis.fetch;
  if (typeof activeFetch !== "function") {
    throw new BridgeServerError(
      "server_transport_missing",
      "No fetch implementation is available; the bridge cannot run commands without the hosted server.",
      blockedState("server_required")
    );
  }
  return activeFetch;
}

async function fetchHostedCommand(activeFetch, activeSession, command, payload) {
  const { project_id: payloadProjectId, ...workflowPayload } = payload;
  const projectId = payloadProjectId || activeSession.projectId;
  const requestBody = { command, payload: workflowPayload };
  if (projectId) {
    requestBody.project_id = String(projectId);
  }
  try {
    return await activeFetch(`${activeSession.apiBaseUrl}${COMMAND_ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${activeSession.sessionToken}`,
        "x-unclog-bridge-version": BRIDGE_VERSION
      },
      body: JSON.stringify(requestBody)
    });
  } catch {
    throw new BridgeServerError(
      "server_unreachable",
      "Hosted Unclog could not be reached; retry after checking network access.",
      blockedState("server_unreachable")
    );
  }
}

async function fetchHostedProjectLink(activeFetch, activeSession, projectId) {
  try {
    return await activeFetch(`${activeSession.apiBaseUrl}${PROJECT_LINK_ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${activeSession.sessionToken}`,
        "x-unclog-bridge-version": BRIDGE_VERSION
      },
      body: JSON.stringify({ project_id: projectId })
    });
  } catch {
    throw new BridgeServerError(
      "server_unreachable",
      "Hosted Unclog could not be reached; retry after checking network access.",
      blockedState("server_unreachable")
    );
  }
}

async function fetchHostedSessionRevoke(activeFetch, activeSession, projectId) {
  try {
    return await activeFetch(`${activeSession.apiBaseUrl}${SESSION_REVOKE_ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${activeSession.sessionToken}`,
        "x-unclog-bridge-version": BRIDGE_VERSION
      },
      body: JSON.stringify({ project_id: projectId })
    });
  } catch {
    throw new BridgeServerError(
      "server_unreachable",
      "Hosted Unclog could not revoke this device; the local reference was kept for retry.",
      blockedState("server_unreachable")
    );
  }
}

async function readHostedJson(response) {
  if (!response || typeof response.json !== "function") {
    throw new BridgeServerError(
      "server_response_invalid",
      "Hosted Unclog returned an invalid response.",
      blockedState("server_response_invalid")
    );
  }
  try {
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("invalid response shape");
    }
    return data;
  } catch {
    throw new BridgeServerError(
      "server_response_invalid",
      "Hosted Unclog returned an invalid response.",
      blockedState("server_response_invalid")
    );
  }
}

function normalizeHostedDenial(data = {}) {
  const publicData = data.detail && typeof data.detail === "object" && !Array.isArray(data.detail) ? data.detail : data;
  const reason = publicData.code || publicData.reason || "server_denied";
  const fallback = blockedState(reason);
  return {
    ...fallback,
    ...publicData,
    allowed: false,
    blocked: true,
    status: publicData.status || "ERROR",
    code: reason,
    reason: publicData.reason || reason,
    recovery: publicData.recovery || publicData.actions || fallback.recovery
  };
}

function assertHostedResponseEnvelope(data, command) {
  if (data.allowed === false || data.blocked === true) {
    return;
  }
  const requiredKeys = ["allowed", "status", "command", "command_status", "local_contract", "next_action", "commands_now"];
  const missing = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(data, key));
  if (
    data.allowed !== true ||
    missing.length > 0 ||
    data.command !== command ||
    !Array.isArray(data.commands_now) ||
    !data.next_action ||
    typeof data.next_action !== "object" ||
    !data.local_contract ||
    typeof data.local_contract !== "object" ||
    (!Array.isArray(data.local_contract.responseKeys) && !Array.isArray(data.local_contract.response_keys))
  ) {
    throw new BridgeServerError(
      "server_response_invalid",
      "Hosted Unclog returned an invalid response.",
      blockedState("server_response_invalid")
    );
  }
}

function projectRequiredState() {
  return {
    ...blockedState("auth_required"),
    code: "project_required",
    reason: "project_required",
    title: "Project required",
    message: "Run: unclog-bridge link --project <project id>.",
    primaryAction: "Copy setup prompt",
    secondaryAction: "Open setup",
    actions: ["Copy setup prompt", "Open setup"],
    recovery: ["Copy setup prompt", "Open setup"],
    mobile: {
      title: "Project",
      message: "Add --project <id>.",
      primaryAction: "Copy"
    }
  };
}

function assertHostedProjectLinkEnvelope(data) {
  if (data.allowed === false || data.blocked === true) {
    return;
  }
  const requiredKeys = [
    "allowed",
    "status",
    "linked",
    "project",
    "device",
    "dashboard_probe",
    "monitor_probe",
    "source",
    "next_action",
    "commands_now"
  ];
  const missing = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(data, key));
  const project = data.project || {};
  const device = data.device || {};
  const source = data.source || {};
  if (
    data.allowed !== true ||
    data.status !== "OK" ||
    data.linked !== true ||
    missing.length > 0 ||
    !project ||
    typeof project !== "object" ||
    !project.id ||
    !device ||
    typeof device !== "object" ||
    !device.id ||
    device.state !== "approved" ||
    !source ||
    typeof source !== "object" ||
    source.serverOwnedLink !== true ||
    source.supabaseBacked !== true ||
    !Array.isArray(data.commands_now) ||
    !data.next_action ||
    typeof data.next_action !== "object"
  ) {
    throw new BridgeServerError(
      "server_response_invalid",
      "Hosted Unclog returned an invalid response.",
      blockedState("server_response_invalid")
    );
  }
}

async function callHostedCommand({ command, payload = {}, session, fetchImpl }) {
  const activeSession = requireSession(session);
  const hostedCommand = assertHostedCommandContract(command);
  assertNoLocalBrain({ command, payload });
  const activeFetch = resolveFetch(fetchImpl);
  const response = await fetchHostedCommand(activeFetch, activeSession, hostedCommand, payload);
  const data = await readHostedJson(response);
  if (!response.ok || data.allowed === false || data.blocked === true) {
    const publicState = normalizeHostedDenial(data);
    throw new BridgeServerError(
      publicState.code || "server_denied",
      publicState.message || "Hosted Unclog rejected the command.",
      publicState
    );
  }
  assertHostedResponseEnvelope(data, hostedCommand);
  return data;
}

async function callHostedProjectLink({ projectId, session, fetchImpl }) {
  const activeSession = requireSession(session);
  const activeProjectId = String(projectId || activeSession.projectId || "").trim();
  if (!activeProjectId) {
    const publicState = projectRequiredState();
    throw new BridgeServerError(publicState.code, publicState.message, publicState);
  }
  assertNoLocalBrain({ project_id: activeProjectId });
  const activeFetch = resolveFetch(fetchImpl);
  const response = await fetchHostedProjectLink(activeFetch, activeSession, activeProjectId);
  const data = await readHostedJson(response);
  if (!response.ok || data.allowed === false || data.blocked === true) {
    const publicState = normalizeHostedDenial(data);
    throw new BridgeServerError(
      publicState.code || "server_denied",
      publicState.message || "Hosted Unclog rejected the project link.",
      publicState
    );
  }
  assertHostedProjectLinkEnvelope(data);
  return data;
}

async function callHostedSessionRevoke({ projectId, session, fetchImpl }) {
  const activeSession = requireSession(session);
  const activeProjectId = String(projectId || activeSession.projectId || "").trim();
  if (!activeProjectId) {
    const publicState = projectRequiredState();
    throw new BridgeServerError(publicState.code, publicState.message, publicState);
  }
  const activeFetch = resolveFetch(fetchImpl);
  const response = await fetchHostedSessionRevoke(activeFetch, activeSession, activeProjectId);
  const data = await readHostedJson(response);
  if (!response.ok || data.allowed === false || data.revoked !== true) {
    const publicState = normalizeHostedDenial(data);
    throw new BridgeServerError(
      publicState.code || "session_revoke_denied",
      publicState.message || "Hosted Unclog did not revoke this device.",
      publicState
    );
  }
  return data;
}

function createBridgeClient(options = {}) {
  const sessionOptions = options.sessionOptions || {};
  const fetchImpl = options.fetchImpl;
  return {
    blockedState,
    adapterPrompt: buildAdapterPrompt,
    commandStatus: hostedCommandStatus,
    responseContract: hostedResponseContract,
    supportedCommands: () => [...HOSTED_COMMAND_CONTRACTS].sort(),
    unsupportedCommands: () => [...HOSTED_UNSUPPORTED_COMMAND_CONTRACTS].sort(),
    sessionStorageContract: () => sessionStorageContract(sessionOptions),
    saveSession: (session, token) => saveSession(session, token, sessionOptions),
    async command(command, payload = {}) {
      const session = options.session || loadSession(sessionOptions);
      return callHostedCommand({ command, payload, session, fetchImpl });
    },
    async linkProject(projectId) {
      const session = options.session || loadSession(sessionOptions);
      return callHostedProjectLink({ projectId, session, fetchImpl });
    },
    async revokeSession() {
      return logout({ session: options.session, sessionOptions, fetchImpl });
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === "help" || command === "--help") {
    console.log(JSON.stringify({
      usage: "unclog-bridge connect|follow|status|doctor|logout|revoke|<hosted-command>",
      connect: `npx --yes unclog-bridge@${BRIDGE_VERSION} connect --tool codex|claude --setup-intent <intent>`,
      resume: `npx --yes unclog-bridge@${BRIDGE_VERSION} follow`,
      examples: [
        `npx --yes unclog-bridge@${BRIDGE_VERSION} drafts list`,
        `npx --yes unclog-bridge@${BRIDGE_VERSION} goals template --draft`,
        `npx --yes unclog-bridge@${BRIDGE_VERSION} <hosted command> --raw`
      ],
      output: "Default output is a compact cold-agent view with server guidance and executable thin-bridge commands. Add --raw only for complete diagnostics."
    }, null, 2));
    return 0;
  }
  if (command === "connect") {
    try {
      console.log(JSON.stringify(await connectWithSetupIntent(argv.slice(1), {
        onStatus(status) {
          console.error(JSON.stringify(status));
        }
      }), null, 2));
      return 0;
    } catch (error) {
      const publicState = error.publicState || { ...blockedState("connect_failed"), message: error.message, code: error.code };
      console.error(JSON.stringify(publicState, null, 2));
      return 1;
    }
  }
  if (command === "logout" || command === "revoke") {
    try {
      console.log(JSON.stringify(await logout(), null, 2));
      return 0;
    } catch (error) {
      const publicState = error.publicState || blockedState("logout_failed");
      console.error(JSON.stringify(publicState, null, 2));
      return 1;
    }
  }
  if (command === "link" || command === "status") {
    try {
      const flags = parseFlagArgs(argv.slice(1));
      const positionalProject = argv.slice(1).find((arg) => !String(arg).startsWith("--"));
      const result = await createBridgeClient().linkProject(flags.project || positionalProject);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    } catch (error) {
      const publicState = error.publicState || blockedState("error");
      console.error(JSON.stringify(publicState, null, 2));
      return 1;
    }
  }
  if (command === "doctor") {
    try {
      const storageCapabilities = credentialStorageCapabilities();
      const session = loadSession();
      console.log(JSON.stringify({
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        nodeVersion: process.version,
        keyringAvailable: storageCapabilities.keyringAvailable,
        permissionProtectedFileFallback: storageCapabilities.permissionProtectedFileFallback,
        credentialStorageUsable: storageCapabilities.usable,
        connected: Boolean(session),
        projectId: session ? session.projectId : null,
        storage: sessionStorageContract()
      }, null, 2));
      return 0;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, code: error.code || "doctor_failed", message: error.message }, null, 2));
      return 1;
    }
  }
  try {
    reconcilePendingLocalArtifactEffects();
    const rawOutput = argv.includes("--raw") || argv.includes("--debug");
    const parsed = command === "follow"
      ? parseHostedCommandArgv(argv.length > 1 ? argv.slice(1) : ["next"])
      : parseHostedCommandArgv(argv);
    const activeSession = loadSession();
    const adapterRefresh = activeSession?.tool
      ? installHostedAdapter(activeSession.tool)
      : null;
    const result = await createBridgeClient({ session: activeSession }).command(parsed.command, parsed.payload);
    const localArtifacts = applyHostedLocalArtifactEffects(result);
    const localOutput = parsed.localOutputPath
      ? writeHostedOutputFile(parsed.localOutputPath, result)
      : null;
    const presented = presentHostedResult(result, { raw: rawOutput, cwd: process.cwd() });
    console.log(JSON.stringify({
      ...presented,
      ...(localOutput ? { local_output: localOutput } : {}),
      ...(localArtifacts ? { local_artifacts: localArtifacts } : {}),
      ...(adapterRefresh ? { adapter_refresh: adapterRefresh } : {})
    }, null, 2));
    return 0;
  } catch (error) {
    const publicState = error.publicState || blockedState("error");
    console.error(JSON.stringify(publicState, null, 2));
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = {
  BridgeServerError,
  HOSTED_COMMAND_CONTRACTS,
  HOSTED_LOCAL_ONLY_COMMAND_CONTRACTS,
  HOSTED_REMOVED_COMMAND_CONTRACTS,
  HOSTED_UNSUPPORTED_COMMAND_CONTRACTS,
  MissingAuthError,
  applyHostedLocalArtifactEffects,
  assertHostedCommandContract,
  assertHostedProjectLinkEnvelope,
  assertHostedResponseEnvelope,
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
  main,
  normalizeHostedCommand,
  openHostedApprovalUrl,
  parseHostedCommandArgv,
  presentHostedResult,
  reconcilePendingLocalArtifactEffects,
  renderCanonicalHostedCommand,
  renderHostedGuidance,
  repositoryIdentity,
  writeHostedOutputFile
};
