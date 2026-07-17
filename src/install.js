const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const INSTALL_SCHEMA = "unclog-mcp-install/1";
const SERVER_NAME = "unclog";
const CODEX_BEGIN = "# unclog-bridge-managed-begin";
const CODEX_END = "# unclog-bridge-managed-end";

function bridgeHome(options = {}) {
  return path.resolve(options.bridgeHome || process.env.UNCLOG_BRIDGE_HOME || path.join(options.homeDir || os.homedir(), ".unclog", "bridge"));
}

function installationFile(options = {}) {
  return path.join(bridgeHome(options), "installation.json");
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function writePrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function readJsonFile(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
    return value;
  } catch {
    const error = new Error(`Unclog could not safely read ${file}.`);
    error.code = "client_config_invalid";
    throw error;
  }
}

function snapshotFile(file) {
  return fs.existsSync(file) ? { file, existed: true, content: fs.readFileSync(file) } : { file, existed: false, content: null };
}

function restoreFile(snapshot) {
  if (snapshot.existed) {
    fs.mkdirSync(path.dirname(snapshot.file), { recursive: true, mode: 0o700 });
    const temporary = `${snapshot.file}.rollback-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, snapshot.content, { mode: 0o600 });
    fs.renameSync(temporary, snapshot.file);
  } else if (fs.existsSync(snapshot.file)) {
    fs.rmSync(snapshot.file, { force: true });
  }
}

function loadInstallation(options = {}) {
  const value = readJsonFile(installationFile(options));
  if (!value) return null;
  if (value.schema !== INSTALL_SCHEMA || value.serverName !== SERVER_NAME) {
    const error = new Error("The saved Unclog MCP installation record is invalid.");
    error.code = "installation_record_invalid";
    throw error;
  }
  return value;
}

function runtimeEntryFor(root) {
  return path.join(root, "node_modules", "unclog-bridge", "src", "index.js");
}

function assertRuntime(entry, version, options = {}) {
  const resolved = path.resolve(entry);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const error = new Error("The persistent Unclog runtime entry is missing.");
    error.code = "runtime_entry_missing";
    throw error;
  }
  if (options.allowExternalRuntime === true) return resolved;
  const packageRoot = path.dirname(path.dirname(resolved));
  const manifest = readJsonFile(path.join(packageRoot, "package.json"));
  if (manifest?.name !== "unclog-bridge" || manifest?.version !== version) {
    const error = new Error("The persistent Unclog runtime identity does not match the requested release.");
    error.code = "runtime_identity_mismatch";
    throw error;
  }
  return resolved;
}

function defaultRunner(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: options.shell === true,
    env: options.env || process.env
  });
}

function installPersistentRuntime(options = {}) {
  const version = String(options.version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    const error = new Error("A valid exact Unclog bridge version is required.");
    error.code = "runtime_version_invalid";
    throw error;
  }
  if (options.runtimeEntry) {
    return {
      version,
      root: path.dirname(path.dirname(path.dirname(path.resolve(options.runtimeEntry)))),
      entry: assertRuntime(options.runtimeEntry, version, { allowExternalRuntime: options.allowExternalRuntime === true }),
      reused: true,
      source: "provided"
    };
  }

  const base = path.join(bridgeHome(options), "runtime");
  const target = path.join(base, version);
  const entry = runtimeEntryFor(target);
  if (fs.existsSync(entry)) {
    return { version, root: target, entry: assertRuntime(entry, version), reused: true, source: "npm" };
  }

  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const temporary = path.join(base, `.install-${version}-${process.pid}-${Date.now()}`);
  const npmExecPath = options.npmExecPath || process.env.npm_execpath;
  const nodePath = options.nodePath || process.execPath;
  const packageSpec = options.packageSpec || `unclog-bridge@${version}`;
  const npmArgs = [
    "install",
    "--prefix", temporary,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--save=false",
    "--package-lock=false",
    "--ignore-scripts",
    packageSpec
  ];
  const command = npmExecPath ? nodePath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = npmExecPath ? [npmExecPath, ...npmArgs] : npmArgs;
  const run = options.runProcess || defaultRunner;
  let result;
  try {
    result = run(command, args, { cwd: base, shell: !npmExecPath && process.platform === "win32" });
    if (!result || result.status !== 0) {
      const detail = String(result?.stderr || result?.stdout || "npm install failed").trim().slice(0, 600);
      const error = new Error(`Unclog could not install its persistent thin runtime. ${detail}`);
      error.code = "runtime_install_failed";
      throw error;
    }
    const installedEntry = assertRuntime(runtimeEntryFor(temporary), version);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temporary, target);
    return { version, root: target, entry: runtimeEntryFor(target), reused: false, source: "npm", verifiedEntry: installedEntry };
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexManagedBlock(command, args) {
  return [
    CODEX_BEGIN,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 30",
    CODEX_END
  ].join("\n");
}

function inspectCodexConfig(file) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const begin = existing.indexOf(CODEX_BEGIN);
  const end = existing.indexOf(CODEX_END);
  if ((begin >= 0) !== (end >= 0) || (begin >= 0 && end < begin)) {
    const error = new Error("The existing Codex Unclog MCP block is incomplete; Unclog did not edit it.");
    error.code = "client_config_conflict";
    throw error;
  }
  const withoutManaged = begin >= 0
    ? `${existing.slice(0, begin)}${existing.slice(end + CODEX_END.length)}`
    : existing;
  if (/^\s*\[mcp_servers(?:\.unclog|\."unclog")\]\s*$/m.test(withoutManaged)) {
    const error = new Error("A non-Unclog-managed Codex MCP server named unclog already exists; it was preserved.");
    error.code = "client_config_conflict";
    throw error;
  }
  return { existing, begin, end, withoutManaged };
}

function configureCodex(command, args, options = {}) {
  const configDir = options.codexHome || process.env.CODEX_HOME || path.join(options.homeDir || os.homedir(), ".codex");
  const file = path.join(configDir, "config.toml");
  const block = codexManagedBlock(command, args);
  const { withoutManaged } = inspectCodexConfig(file);
  const normalized = withoutManaged.trimEnd();
  writePrivateFile(file, `${normalized}${normalized ? "\n\n" : ""}${block}\n`);
  return { client: "codex", configPath: file, managed: { kind: "toml_block", begin: CODEX_BEGIN, end: CODEX_END } };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function configureJsonClient(client, file, command, args, options = {}) {
  const config = readJsonFile(file, {});
  const servers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? { ...config.mcpServers }
    : {};
  const entry = client === "claude"
    ? { type: "stdio", command, args, env: {} }
    : { command, args };
  const previous = options.previousInstallation;
  if (servers[SERVER_NAME] && !sameJson(servers[SERVER_NAME], entry)) {
    const wasManaged = previous?.client === client && previous?.configPath === file && sameJson(servers[SERVER_NAME], previous?.managed?.entry);
    if (!wasManaged) {
      const error = new Error(`A non-Unclog-managed ${client} MCP server named unclog already exists; it was preserved.`);
      error.code = "client_config_conflict";
      throw error;
    }
  }
  servers[SERVER_NAME] = entry;
  writePrivateFile(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`);
  return { client, configPath: file, managed: { kind: "json_entry", entry } };
}

function configureClient(client, command, args, options = {}) {
  const normalized = String(client || "").trim().toLowerCase();
  if (normalized === "codex") return configureCodex(command, args, options);
  if (normalized === "claude") {
    return configureJsonClient("claude", path.join(options.homeDir || os.homedir(), ".claude.json"), command, args, options);
  }
  if (normalized === "cursor") {
    return configureJsonClient("cursor", path.join(options.homeDir || os.homedir(), ".cursor", "mcp.json"), command, args, options);
  }
  if (normalized === "generic") {
    return configureJsonClient("generic", path.join(bridgeHome(options), "mcp.json"), command, args, options);
  }
  const error = new Error("Supported MCP clients are codex, claude, cursor, and generic.");
  error.code = "client_not_supported";
  throw error;
}

function clientConfigPath(client, options = {}) {
  const normalized = String(client || "").trim().toLowerCase();
  if (normalized === "codex") {
    const configDir = options.codexHome || process.env.CODEX_HOME || path.join(options.homeDir || os.homedir(), ".codex");
    return path.join(configDir, "config.toml");
  }
  if (normalized === "claude") return path.join(options.homeDir || os.homedir(), ".claude.json");
  if (normalized === "cursor") return path.join(options.homeDir || os.homedir(), ".cursor", "mcp.json");
  if (normalized === "generic") return path.join(bridgeHome(options), "mcp.json");
  const error = new Error("Supported MCP clients are codex, claude, cursor, and generic.");
  error.code = "client_not_supported";
  throw error;
}

function preflightHostedMcp(options = {}) {
  const client = String(options.client || "").trim().toLowerCase();
  const configPath = clientConfigPath(client, options);
  const previousInstallation = loadInstallation(options);
  if (client === "codex") {
    inspectCodexConfig(configPath);
  } else {
    const config = readJsonFile(configPath, {});
    const servers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
    if (servers[SERVER_NAME]) {
      const wasManaged = previousInstallation?.client === client
        && previousInstallation?.configPath === configPath
        && sameJson(servers[SERVER_NAME], previousInstallation?.managed?.entry);
      if (!wasManaged) {
        const error = new Error(`A non-Unclog-managed ${client} MCP server named unclog already exists; it was preserved.`);
        error.code = "client_config_conflict";
        throw error;
      }
    }
  }
  return { ready: true, client, configPath, previousInstallation };
}

function removeManagedConfig(record) {
  if (!record?.configPath || !record?.managed) return false;
  if (record.managed.kind === "toml_block") return removeCodexManagedBlock(record.configPath);
  if (record.managed.kind !== "json_entry" || !fs.existsSync(record.configPath)) return false;
  const config = readJsonFile(record.configPath, {});
  const servers = config.mcpServers && typeof config.mcpServers === "object" ? { ...config.mcpServers } : {};
  if (!sameJson(servers[SERVER_NAME], record.managed.entry)) return false;
  delete servers[SERVER_NAME];
  writePrivateFile(record.configPath, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`);
  return true;
}

function installHostedMcp(options = {}) {
  const version = String(options.version || "").trim();
  const workspaceRoot = fs.realpathSync(path.resolve(options.workspaceRoot || process.cwd()));
  const previousInstallation = loadInstallation(options);
  const targetConfigPath = clientConfigPath(options.client, options);
  const snapshots = new Map();
  for (const file of [installationFile(options), targetConfigPath, previousInstallation?.configPath].filter(Boolean)) {
    if (!snapshots.has(file)) snapshots.set(file, snapshotFile(file));
  }
  let runtime = null;
  try {
    runtime = installPersistentRuntime({ ...options, version });
    const nodePath = path.resolve(options.nodePath || process.execPath);
    const args = [runtime.entry, "mcp", "--workspace", workspaceRoot];
    const configured = configureClient(options.client, nodePath, args, { ...options, previousInstallation });
    if (previousInstallation && previousInstallation.configPath !== configured.configPath) {
      removeManagedConfig(previousInstallation);
    }
    const record = {
      schema: INSTALL_SCHEMA,
      serverName: SERVER_NAME,
      packageVersion: version,
      nodePath,
      runtimeRoot: runtime.root,
      runtimeEntry: runtime.entry,
      client: configured.client,
      configPath: configured.configPath,
      managed: configured.managed,
      workspaceRoot,
      installedAt: new Date().toISOString()
    };
    writePrivateFile(installationFile(options), `${JSON.stringify(record, null, 2)}\n`);
    if (previousInstallation?.runtimeRoot
        && previousInstallation.runtimeRoot !== runtime.root
        && isInsideOrEqual(previousInstallation.runtimeRoot, path.join(bridgeHome(options), "runtime"))
        && fs.existsSync(previousInstallation.runtimeRoot)) {
      try { fs.rmSync(previousInstallation.runtimeRoot, { recursive: true, force: true }); } catch {}
    }
    return {
      installed: true,
      persistent: true,
      serverName: SERVER_NAME,
      client: configured.client,
      packageVersion: version,
      runtimeReused: runtime.reused,
      configPath: configured.configPath,
      workspaceRoot,
      restartRequired: configured.client !== "generic",
      nextStep: configured.client === "generic"
        ? "Import the generated MCP configuration into your client. Then: Unclog connected. Start a new task and say: Use Unclog."
        : "Unclog connected. Start a new task and say: Use Unclog."
    };
  } catch (error) {
    for (const snapshot of [...snapshots.values()].reverse()) {
      try { restoreFile(snapshot); } catch {}
    }
    if (runtime && runtime.reused === false && fs.existsSync(runtime.root)) {
      try { fs.rmSync(runtime.root, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}

function removeCodexManagedBlock(file) {
  if (!fs.existsSync(file)) return false;
  const existing = fs.readFileSync(file, "utf8");
  const begin = existing.indexOf(CODEX_BEGIN);
  const end = existing.indexOf(CODEX_END);
  if (begin < 0 || end < begin) return false;
  const updated = `${existing.slice(0, begin)}${existing.slice(end + CODEX_END.length)}`.replace(/^\s+|\s+$/g, "");
  writePrivateFile(file, updated ? `${updated}\n` : "");
  return true;
}

function uninstallHostedMcp(options = {}) {
  const record = loadInstallation(options);
  if (!record) return { uninstalled: false, reason: "not_installed" };
  const configRemoved = removeManagedConfig(record);
  const home = bridgeHome(options);
  if (record.runtimeRoot && isInsideOrEqual(record.runtimeRoot, path.join(home, "runtime")) && fs.existsSync(record.runtimeRoot)) {
    fs.rmSync(record.runtimeRoot, { recursive: true, force: true });
  }
  const file = installationFile(options);
  if (fs.existsSync(file)) fs.rmSync(file);
  return { uninstalled: true, configRemoved, client: record.client, restartRequired: record.client !== "generic" };
}

function installationDoctor(options = {}) {
  const record = loadInstallation(options);
  if (!record) return { installed: false, healthy: false, recovery: "Run a fresh setup prompt from the hosted dashboard." };
  let runtimeHealthy = false;
  try {
    runtimeHealthy = fs.existsSync(record.nodePath) && assertRuntime(record.runtimeEntry, record.packageVersion) === path.resolve(record.runtimeEntry);
  } catch {}
  let configHealthy = false;
  let duplicateEntries = false;
  try {
    if (record.managed?.kind === "toml_block" && fs.existsSync(record.configPath)) {
      const config = fs.readFileSync(record.configPath, "utf8");
      const managedCount = config.split(CODEX_BEGIN).length - 1;
      const serverCount = (config.match(/^\s*\[mcp_servers(?:\.unclog|\."unclog")\]\s*$/gm) || []).length;
      duplicateEntries = managedCount !== 1 || serverCount !== 1;
      configHealthy = !duplicateEntries && config.includes(CODEX_END)
        && config.includes(JSON.stringify(record.nodePath))
        && config.includes(JSON.stringify(record.runtimeEntry))
        && config.includes(JSON.stringify(record.workspaceRoot));
    } else if (record.managed?.kind === "json_entry" && fs.existsSync(record.configPath)) {
      const config = readJsonFile(record.configPath, {});
      configHealthy = sameJson(config?.mcpServers?.[SERVER_NAME], record.managed.entry);
    }
  } catch {}
  return {
    installed: true,
    healthy: runtimeHealthy && configHealthy,
    client: record.client,
    packageVersion: record.packageVersion,
    runtimeHealthy,
    configHealthy,
    duplicateEntries,
    workspaceRoot: record.workspaceRoot,
    recovery: runtimeHealthy && configHealthy ? null : "Copy a fresh setup prompt from the hosted dashboard and run its exact one-time connect command."
  };
}

module.exports = {
  CODEX_BEGIN,
  CODEX_END,
  INSTALL_SCHEMA,
  SERVER_NAME,
  bridgeHome,
  clientConfigPath,
  configureClient,
  installHostedMcp,
  installPersistentRuntime,
  installationDoctor,
  installationFile,
  loadInstallation,
  preflightHostedMcp,
  uninstallHostedMcp
};
