const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const CURRENT_VERSION = require("../package.json").version;

const {
  CODEX_BEGIN,
  CODEX_END,
  installHostedMcp,
  installPersistentRuntime,
  installationDoctor,
  loadInstallation,
  uninstallHostedMcp
} = require("../src/install");

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "unclog-install-"));
}

function makeRepository(root) {
  const repository = path.join(root, "customer-repository");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  return repository;
}

test("persistent runtime installs an exact public package into an owned atomic directory", () => {
  const root = temporaryRoot();
  const bridgeHome = path.join(root, "bridge-home");
  let observed = null;
  const runtime = installPersistentRuntime({
    version: CURRENT_VERSION,
    bridgeHome,
    nodePath: process.execPath,
    npmExecPath: path.join(root, "npm-cli.js"),
    runProcess(command, args) {
      observed = { command, args };
      const prefixIndex = args.indexOf("--prefix");
      const target = args[prefixIndex + 1];
      const packageRoot = path.join(target, "node_modules", "unclog-bridge");
      fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "unclog-bridge", version: CURRENT_VERSION }));
      fs.writeFileSync(path.join(packageRoot, "src", "index.js"), "// verified runtime\n");
      return { status: 0, stdout: "installed" };
    }
  });

  assert.equal(runtime.reused, false);
  assert.equal(fs.existsSync(runtime.entry), true);
  assert.equal(observed.command, process.execPath);
  assert.ok(observed.args.includes(`unclog-bridge@${CURRENT_VERSION}`));
  assert.ok(observed.args.includes("--ignore-scripts"));
  assert.ok(observed.args.includes("--omit=dev"));
  const reused = installPersistentRuntime({ version: CURRENT_VERSION, bridgeHome });
  assert.equal(reused.reused, true);
});

test("Codex MCP registration is owned, deduplicated, restart-aware, and safely uninstallable", () => {
  const root = temporaryRoot();
  const homeDir = path.join(root, "home");
  const bridgeHome = path.join(root, "bridge");
  const repository = makeRepository(root);
  const codexHome = path.join(homeDir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"gpt-5\"\n");
  const runtimeEntry = path.resolve(__dirname, "../src/index.js");

  const first = installHostedMcp({
    version: CURRENT_VERSION,
    client: "codex",
    workspaceRoot: repository,
    homeDir,
    bridgeHome,
    codexHome,
    nodePath: process.execPath,
    runtimeEntry,
    allowExternalRuntime: true
  });
  const second = installHostedMcp({
    version: CURRENT_VERSION,
    client: "codex",
    workspaceRoot: repository,
    homeDir,
    bridgeHome,
    codexHome,
    nodePath: process.execPath,
    runtimeEntry,
    allowExternalRuntime: true
  });
  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.equal(config.split(CODEX_BEGIN).length - 1, 1);
  assert.equal(config.split(CODEX_END).length - 1, 1);
  assert.match(config, /\[mcp_servers\.unclog\]/);
  assert.match(config, /"mcp"/);
  assert.ok(config.includes(repository.replaceAll("\\", "\\\\")));
  assert.equal(first.restartRequired, true);
  assert.equal(first.nextStep, "Unclog connected. Start a new task and say: Use Unclog.");
  assert.equal(second.serverName, "unclog");
  assert.equal(loadInstallation({ bridgeHome }).workspaceRoot, fs.realpathSync(repository));
  assert.equal(installationDoctor({ bridgeHome }).healthy, true);

  const removed = uninstallHostedMcp({ bridgeHome });
  const remaining = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.equal(removed.configRemoved, true);
  assert.match(remaining, /model = "gpt-5"/);
  assert.doesNotMatch(remaining, /mcp_servers\.unclog/);
  assert.equal(fs.existsSync(path.join(bridgeHome, "installation.json")), false);
});

test("Claude, Cursor, and generic adapters preserve unrelated MCP servers", () => {
  for (const client of ["claude", "cursor", "generic"]) {
    const root = temporaryRoot();
    const homeDir = path.join(root, "home");
    const bridgeHome = path.join(root, "bridge");
    const repository = makeRepository(root);
    const configPath = client === "claude"
      ? path.join(homeDir, ".claude.json")
      : client === "cursor"
        ? path.join(homeDir, ".cursor", "mcp.json")
        : path.join(bridgeHome, "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { existing: { command: "existing-tool" } }, preference: true }));
    const result = installHostedMcp({
      version: CURRENT_VERSION,
      client,
      workspaceRoot: repository,
      homeDir,
      bridgeHome,
      nodePath: process.execPath,
      runtimeEntry: path.resolve(__dirname, "../src/index.js"),
      allowExternalRuntime: true
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.preference, true);
    assert.equal(config.mcpServers.existing.command, "existing-tool");
    assert.equal(config.mcpServers.unclog.command, process.execPath);
    assert.ok(config.mcpServers.unclog.args.includes("--workspace"));
    assert.equal(result.restartRequired, client !== "generic");
    uninstallHostedMcp({ bridgeHome });
    const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(after.mcpServers.existing.command, "existing-tool");
    assert.equal(after.mcpServers.unclog, undefined);
  }
});

test("client config conflicts fail closed without overwriting user-owned entries", () => {
  const root = temporaryRoot();
  const homeDir = path.join(root, "home");
  const bridgeHome = path.join(root, "bridge");
  const repository = makeRepository(root);
  const file = path.join(homeDir, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { unclog: { command: "customer-owned" } } }));
  assert.throws(
    () => installHostedMcp({
      version: CURRENT_VERSION,
      client: "cursor",
      workspaceRoot: repository,
      homeDir,
      bridgeHome,
      nodePath: process.execPath,
      runtimeEntry: path.resolve(__dirname, "../src/index.js"),
      allowExternalRuntime: true
    }),
    (error) => error.code === "client_config_conflict"
  );
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.unclog.command, "customer-owned");
  assert.equal(fs.existsSync(path.join(bridgeHome, "installation.json")), false);
});

test("failed client registration rolls back a newly installed runtime and preserves customer config", () => {
  const root = temporaryRoot();
  const homeDir = path.join(root, "home");
  const bridgeHome = path.join(root, "bridge");
  const repository = makeRepository(root);
  const file = path.join(homeDir, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const customerConfig = { preference: "keep", mcpServers: { unclog: { command: "customer-owned" } } };
  fs.writeFileSync(file, JSON.stringify(customerConfig));

  assert.throws(() => installHostedMcp({
    version: CURRENT_VERSION,
    client: "cursor",
    workspaceRoot: repository,
    homeDir,
    bridgeHome,
    nodePath: process.execPath,
    npmExecPath: path.join(root, "npm-cli.js"),
    runProcess(_command, args) {
      const target = args[args.indexOf("--prefix") + 1];
      const packageRoot = path.join(target, "node_modules", "unclog-bridge");
      fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "unclog-bridge", version: CURRENT_VERSION }));
      fs.writeFileSync(path.join(packageRoot, "src", "index.js"), "// candidate runtime\n");
      return { status: 0 };
    }
  }), (error) => error.code === "client_config_conflict");

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), customerConfig);
  assert.equal(fs.existsSync(path.join(bridgeHome, "runtime", CURRENT_VERSION)), false);
  assert.equal(fs.existsSync(path.join(bridgeHome, "installation.json")), false);
});

test("switching clients removes only the previous managed entry and keeps unrelated settings", () => {
  const root = temporaryRoot();
  const homeDir = path.join(root, "home");
  const bridgeHome = path.join(root, "bridge");
  const repository = makeRepository(root);
  const codexHome = path.join(homeDir, ".codex");
  const cursorFile = path.join(homeDir, ".cursor", "mcp.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"customer-model\"\n");
  fs.writeFileSync(cursorFile, JSON.stringify({ mcpServers: { other: { command: "other" } }, theme: "dark" }));
  const common = {
    version: CURRENT_VERSION,
    workspaceRoot: repository,
    homeDir,
    bridgeHome,
    codexHome,
    nodePath: process.execPath,
    runtimeEntry: path.resolve(__dirname, "../src/index.js"),
    allowExternalRuntime: true
  };

  installHostedMcp({ ...common, client: "codex" });
  installHostedMcp({ ...common, client: "cursor" });

  const codex = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  const cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.match(codex, /customer-model/);
  assert.doesNotMatch(codex, /mcp_servers\.unclog/);
  assert.equal(cursor.theme, "dark");
  assert.equal(cursor.mcpServers.other.command, "other");
  assert.equal(cursor.mcpServers.unclog.command, process.execPath);
  assert.equal(loadInstallation({ bridgeHome }).client, "cursor");
});

test("doctor rejects duplicated or tampered managed configuration", () => {
  const root = temporaryRoot();
  const homeDir = path.join(root, "home");
  const bridgeHome = path.join(root, "bridge");
  const repository = makeRepository(root);
  const codexHome = path.join(homeDir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const file = path.join(codexHome, "config.toml");
  fs.writeFileSync(file, "model = \"gpt-5\"\n");
  installHostedMcp({
    version: CURRENT_VERSION,
    client: "codex",
    workspaceRoot: repository,
    homeDir,
    bridgeHome,
    codexHome,
    nodePath: process.execPath,
    runtimeEntry: path.resolve(__dirname, "../src/index.js"),
    allowExternalRuntime: true
  });

  fs.appendFileSync(file, "\n[mcp_servers.unclog]\ncommand = \"tampered\"\n");
  const diagnosis = installationDoctor({ bridgeHome });
  assert.equal(diagnosis.healthy, false);
  assert.equal(diagnosis.configHealthy, false);
  assert.equal(diagnosis.duplicateEntries, true);
  assert.match(diagnosis.recovery, /fresh setup prompt/);
});
