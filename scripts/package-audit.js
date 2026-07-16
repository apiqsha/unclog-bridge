const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const publishWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
const allowedTopLevel = new Set(["LICENSE", "README.md", "package.json", "scripts", "src", "test", "package-lock.json"]);
const actual = fs.readdirSync(root).filter((name) => !name.startsWith(".") && name !== "node_modules");
const unexpected = actual.filter((name) => !allowedTopLevel.has(name));
if (unexpected.length) throw new Error(`Unexpected package content: ${unexpected.join(", ")}`);

const source = fs.readdirSync(path.join(root, "src"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => fs.readFileSync(path.join(root, "src", name), "utf8"))
  .join("\n");
for (const forbidden of ["SUPABASE_SERVICE_ROLE_KEY", "codex-tools/unclog", "unclog_lib", "hosted_workflow.py"]) {
  if (source.includes(forbidden)) throw new Error(`Forbidden server-only content: ${forbidden}`);
}
if (/\b(?:sk_live_|sb_secret_)[A-Za-z0-9_-]+\b/.test(source)) throw new Error("Credential-like material detected.");

if (manifest.name !== "unclog-bridge" || manifest.private !== false || manifest.version !== "1.0.0") {
  throw new Error("Public package identity must remain explicit and version pinned.");
}
if (manifest.license !== "SEE LICENSE IN LICENSE" || !fs.existsSync(path.join(root, "LICENSE"))) {
  throw new Error("Customer usage terms must be explicit in the packaged LICENSE file.");
}
if (manifest.repository?.url !== "https://github.com/apiqsha/unclog-bridge.git") {
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

process.stdout.write("package audit passed\n");
