const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const publishWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
const allowedTopLevel = new Set(["LICENSE", "README.md", "package.json", "scripts", "src", "test", "package-lock.json"]);
const actual = fs.readdirSync(root).filter((name) => !name.startsWith(".") && name !== "node_modules");
const unexpected = actual.filter((name) => !allowedTopLevel.has(name));
if (unexpected.length) throw new Error(`Unexpected package content: ${unexpected.join(", ")}`);

const source = fs.readdirSync(path.join(root, "src"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => fs.readFileSync(path.join(root, "src", name), "utf8"))
  .join("\n");
for (const forbidden of ["SUPABASE_SERVICE_ROLE_KEY", "codex-tools/unclog", "references/legacy", "unclog_lib", "hosted_workflow.py"]) {
  if (source.includes(forbidden)) throw new Error(`Forbidden server-only content: ${forbidden}`);
}
if (/\b(?:sk_live_|sb_secret_)[A-Za-z0-9_-]+\b/.test(source)) throw new Error("Credential-like material detected.");

if (manifest.name !== "unclog-bridge" || manifest.private !== false || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Public package identity must remain explicit and use a valid release version.");
}
if (packageLock.name !== manifest.name || packageLock.version !== manifest.version || packageLock.packages?.[""]?.version !== manifest.version) {
  throw new Error("Package manifest and lockfile release versions must match exactly.");
}
if (manifest.dependencies?.["@modelcontextprotocol/sdk"] !== "1.29.0" || manifest.dependencies?.zod !== "3.25.76") {
  throw new Error("Persistent MCP runtime dependencies must remain exact and production pinned.");
}
if (JSON.stringify(manifest.files) !== JSON.stringify(["src", "README.md", "LICENSE"])) {
  throw new Error("The published package file boundary changed.");
}
if (manifest.license !== "SEE LICENSE IN LICENSE" || !fs.existsSync(path.join(root, "LICENSE"))) {
  throw new Error("Customer usage terms must be explicit in the packaged LICENSE file.");
}
if (manifest.repository?.url !== "git+https://github.com/apiqsha/unclog-bridge.git") {
  throw new Error("Package provenance repository must be the public thin-bridge repository.");
}
if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
  throw new Error("Public provenance publishing is required.");
}
for (const contract of [
  "id-token: write",
  "runs-on: ubuntu-latest",
  "npm@11.17.0",
  "npm publish --access public --provenance",
  "npm publish --access public",
]) {
  if (!publishWorkflow.includes(contract)) throw new Error(`Missing release workflow contract: ${contract}`);
}
if (!publishWorkflow.includes("secrets.NPM_TOKEN") || !publishWorkflow.includes("github.event_name == 'release'")) {
  throw new Error("Release workflow must separate first-publish token bootstrap from trusted publishing.");
}

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
for (const required of [
  `unclog-bridge@${manifest.version} connect`,
  "Unclog connected. Start a new task and say: Use Unclog.",
  "unclog_next",
  "unclog_act",
  "unclog_wait",
  ".unclog-drafts",
  "Customers do not need an npm account",
  "30 seconds"
]) {
  if (!readme.includes(required)) throw new Error(`README is missing current customer contract: ${required}`);
}
const documentedVersions = [...readme.matchAll(/unclog-bridge@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
if (!documentedVersions.length || documentedVersions.some((version) => version !== manifest.version)) {
  throw new Error("Every README bridge command must use the package manifest version.");
}
if (/unclog-bridge@1\.0\.|\bfollow\b/.test(readme)) throw new Error("README contains retired routine CLI guidance.");

const mcpSource = fs.readFileSync(path.join(root, "src", "mcp.js"), "utf8");
const registeredTools = [...mcpSource.matchAll(/registerTool\("([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(registeredTools) !== JSON.stringify(["unclog_next", "unclog_act", "unclog_wait"])) {
  throw new Error(`Public MCP surface must contain exactly three tools: ${registeredTools.join(", ")}`);
}
for (const required of ["mcp_action_stale", "mcp_wrong_mission", "mcp_wrong_actor", "mcp_action_input_required", "shell_commands_allowed: false"]) {
  if (!mcpSource.includes(required)) throw new Error(`Missing MCP fail-closed contract: ${required}`);
}
const installerSource = fs.readFileSync(path.join(root, "src", "install.js"), "utf8");
for (const required of ["client_config_conflict", "installation.json", "runtime_identity_mismatch", "Unclog connected. Start a new task and say: Use Unclog."]) {
  if (!installerSource.includes(required)) throw new Error(`Missing persistent installer contract: ${required}`);
}
for (const retired of ["presentHostedResult", "renderCanonicalHostedCommand", "composeHostedCliOutput", 'command === "follow"']) {
  if (source.includes(retired)) throw new Error(`Retired repeated-command surface remains public: ${retired}`);
}
if (!source.includes("DEFAULT_APPROVAL_FALLBACK_DELAY_MS = 30_000")) {
  throw new Error("Normal dashboard approval must receive a 30-second review window before fallback opens.");
}

process.stdout.write("package audit passed\n");
