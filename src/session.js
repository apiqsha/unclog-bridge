const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SESSION_FILE = "session.json";
const DEFAULT_STORAGE_DIR = path.join(os.homedir(), ".unclog", "bridge");
const KEYRING_SERVICE = "dev.unclog.bridge";
const TEST_SECRET_FILE = "test-session-secret";
const FALLBACK_SECRET_PREFIX = "credential-";
const FORBIDDEN_PERSISTED_KEYS = new Set([
  "accesstoken", "refreshtoken", "sessiontoken", "token", "secret", "password",
  "repository", "sourcecode", "filecontents", "patch", "diff"
]);

class SessionStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionStorageError";
    this.code = code;
  }
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function walkKeys(value, keys = []) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(normalizeKey(key));
      walkKeys(child, keys);
    }
  } else if (Array.isArray(value)) {
    value.forEach((child) => walkKeys(child, keys));
  }
  return keys;
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPrivateOrReservedHostname(hostname) {
  const clean = String(hostname || "").toLowerCase();
  if (
    isLoopbackHostname(clean) || clean === "::" || clean.endsWith(".local") ||
    clean.endsWith(".test") || clean.endsWith(".invalid") || clean.endsWith(".example") ||
    clean.split(".").includes("example")
  ) return true;
  const parts = clean.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first, second, third] = parts;
    return first === 0 || first === 10 || first === 127 ||
      (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) ||
      (first === 192 && second === 0 && [0, 2].includes(third)) ||
      (first === 198 && [18, 19].includes(second)) || (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) || first >= 224;
  }
  return /^(fc|fd)[0-9a-f]{2}:/i.test(clean) || /^fe80:/i.test(clean);
}

function hasPlaceholderUrlToken(parsed) {
  return `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase()
    .match(/example|test_unclog|pay_test|placeholder|dummy/) !== null;
}

function allowExplicitLocalHttp(options = {}) {
  return options.allowLocalHttp === true || process.env.UNCLOG_BRIDGE_ALLOW_LOCAL_HTTP === "true";
}

function normalizeApiBaseUrl(apiBaseUrl, options = {}) {
  let parsed;
  try { parsed = new URL(String(apiBaseUrl)); } catch {
    throw new SessionStorageError("session_api_base_url_invalid", "Session apiBaseUrl must be a valid hosted Unclog URL.");
  }
  const localHttp = allowExplicitLocalHttp(options) && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new SessionStorageError("session_api_base_url_insecure", "Session apiBaseUrl must use HTTPS except explicit loopback development.");
  }
  if (parsed.protocol === "https:" && (isPrivateOrReservedHostname(parsed.hostname) || hasPlaceholderUrlToken(parsed))) {
    throw new SessionStorageError("session_api_base_url_not_live", "Session apiBaseUrl must target a live hosted Unclog endpoint.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return pathname ? `${parsed.origin}${pathname}` : parsed.origin;
}

function normalizeHostedPublicUrl(rawUrl, options = {}) {
  let parsed;
  try { parsed = new URL(String(rawUrl)); } catch {
    throw new SessionStorageError("hosted_public_url_invalid", "Hosted public URL must be valid.");
  }
  const localHttp = allowExplicitLocalHttp(options) && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new SessionStorageError("hosted_public_url_insecure", "Hosted public URL must use HTTPS except explicit loopback development.");
  }
  if (parsed.protocol === "https:" && (isPrivateOrReservedHostname(parsed.hostname) || hasPlaceholderUrlToken(parsed))) {
    throw new SessionStorageError("hosted_public_url_not_live", "Hosted public URL must be live.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveSessionDir(options = {}) {
  const resolved = path.resolve(options.storageDir || process.env.UNCLOG_BRIDGE_HOME || DEFAULT_STORAGE_DIR);
  const cwd = path.resolve(options.cwd || process.cwd());
  if (resolved === cwd || isInside(resolved, cwd)) {
    throw new SessionStorageError("session_storage_in_repo", "Unclog bridge session references must be stored outside the current repository.");
  }
  return resolved;
}

function resolveSessionFile(options = {}) {
  return path.join(resolveSessionDir(options), SESSION_FILE);
}

function credentialAccount(apiBaseUrl, deviceSessionId) {
  return `session-${crypto.createHash("sha256").update(`${apiBaseUrl}:${deviceSessionId}`).digest("hex").slice(0, 32)}`;
}

function testSecretStoreAllowed(options = {}) {
  return process.env.UNCLOG_BRIDGE_ALLOW_INSECURE_TEST_SECRET_STORE === "true" &&
    allowExplicitLocalHttp(options);
}

function testSecretPath(options = {}) {
  return path.join(resolveSessionDir(options), TEST_SECRET_FILE);
}

function fallbackSecretPath(account, options = {}) {
  const suffix = crypto.createHash("sha256").update(String(account)).digest("hex").slice(0, 32);
  return path.join(resolveSessionDir(options), `${FALLBACK_SECRET_PREFIX}${suffix}.secret`);
}

function permissionFileFallbackAllowed(options = {}) {
  return String(options.platform || process.platform) !== "win32";
}

function assertPrivateUnixPermissions(target, expectedMode, code) {
  if (process.platform === "win32") return;
  const actualMode = fs.statSync(target).mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new SessionStorageError(code, "The fallback credential file could not be permission-protected.");
  }
}

function storeFallbackCredential(account, token, options = {}) {
  if (!permissionFileFallbackAllowed(options)) {
    throw new SessionStorageError(
      "session_keyring_unavailable",
      "The operating-system credential store is unavailable. Run `unclog-bridge doctor` and retry."
    );
  }
  const directory = resolveSessionDir(options);
  const file = fallbackSecretPath(account, options);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(file, String(token), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assertPrivateUnixPermissions(directory, 0o700, "session_fallback_directory_permissions_invalid");
  assertPrivateUnixPermissions(file, 0o600, "session_fallback_file_permissions_invalid");
  return "permission-protected file";
}

function loadFallbackCredential(account, options = {}) {
  const file = fallbackSecretPath(account, options);
  if (!fs.existsSync(file)) return null;
  if (!permissionFileFallbackAllowed(options)) {
    throw new SessionStorageError(
      "session_fallback_not_supported",
      "This platform requires the operating-system credential store."
    );
  }
  assertPrivateUnixPermissions(path.dirname(file), 0o700, "session_fallback_directory_permissions_invalid");
  assertPrivateUnixPermissions(file, 0o600, "session_fallback_file_permissions_invalid");
  return fs.readFileSync(file, "utf8").trim();
}

function keyringEntry(account, options = {}) {
  if (typeof options.keyringEntry === "function") return options.keyringEntry(account);
  try {
    const { Entry } = require("@napi-rs/keyring");
    return new Entry(KEYRING_SERVICE, account);
  } catch (error) {
    throw new SessionStorageError(
      "session_keyring_unavailable",
      "The operating-system credential store is unavailable. Run `unclog-bridge doctor` and retry."
    );
  }
}

function credentialStorageCapabilities(options = {}) {
  let keyringAvailable = typeof options.keyringEntry === "function" || Boolean(options.credentialStore);
  if (!keyringAvailable) {
    try {
      const { Entry } = require("@napi-rs/keyring");
      keyringAvailable = typeof Entry === "function";
    } catch {
      keyringAvailable = false;
    }
  }
  const permissionProtectedFileFallback = permissionFileFallbackAllowed(options);
  return {
    keyringAvailable,
    permissionProtectedFileFallback,
    usable: keyringAvailable || permissionProtectedFileFallback
  };
}

function storeCredential(account, token, options = {}) {
  if (!/^us_[A-Za-z0-9_-]{24,160}$/.test(String(token || ""))) {
    throw new SessionStorageError("session_token_invalid", "Hosted Unclog returned an invalid device session.");
  }
  if (options.credentialStore) {
    options.credentialStore.set(account, String(token));
    return "provided credential store";
  }
  if (testSecretStoreAllowed(options)) {
    const file = testSecretPath(options);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(token), { encoding: "utf8", mode: 0o600 });
    return "test-only credential file";
  }
  try {
    keyringEntry(account, options).setPassword(String(token));
    return "operating-system credential store";
  } catch (error) {
    if (!permissionFileFallbackAllowed(options)) {
      if (error instanceof SessionStorageError) throw error;
      throw new SessionStorageError(
        "session_keyring_unavailable",
        "The operating-system credential store is unavailable. Run `unclog-bridge doctor` and retry."
      );
    }
    return storeFallbackCredential(account, token, options);
  }
}

function loadCredential(account, options = {}) {
  if (options.credentialStore) return options.credentialStore.get(account);
  if (testSecretStoreAllowed(options)) {
    const file = testSecretPath(options);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
  }
  try {
    const token = keyringEntry(account, options).getPassword();
    if (token) return token;
  } catch (error) {
    if (!permissionFileFallbackAllowed(options)) {
      if (error instanceof SessionStorageError) throw error;
      throw new SessionStorageError(
        "session_keyring_unavailable",
        "The operating-system credential store is unavailable. Run `unclog-bridge doctor` and retry."
      );
    }
  }
  return loadFallbackCredential(account, options);
}

function deleteCredential(account, options = {}) {
  if (!account) return;
  if (options.credentialStore) return options.credentialStore.delete(account);
  if (testSecretStoreAllowed(options)) {
    const file = testSecretPath(options);
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  try { keyringEntry(account, options).deletePassword(); } catch {}
  const fallback = fallbackSecretPath(account, options);
  if (fs.existsSync(fallback)) fs.rmSync(fallback);
}

function assertSafeSessionReference(session, options = {}) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new SessionStorageError("session_reference_invalid", "Session reference must be an object.");
  }
  const forbidden = walkKeys(session).find((key) => FORBIDDEN_PERSISTED_KEYS.has(key));
  if (forbidden) {
    throw new SessionStorageError("session_secret_rejected", "Tokens, secrets, source, patches, and repository data may not be stored in session metadata.");
  }
  if (!session.apiBaseUrl || !session.deviceSessionId || !session.credentialAccount) {
    throw new SessionStorageError("session_reference_incomplete", "Session reference is incomplete.");
  }
  normalizeApiBaseUrl(session.apiBaseUrl, options);
}

function saveSession(session, sessionToken, options = {}) {
  const forbidden = walkKeys(session).find((key) => FORBIDDEN_PERSISTED_KEYS.has(key));
  if (forbidden) {
    throw new SessionStorageError("session_secret_rejected", "Session metadata contains forbidden secret or repository fields.");
  }
  const apiBaseUrl = normalizeApiBaseUrl(session.apiBaseUrl, options);
  const deviceSessionId = String(session.deviceSessionId || "");
  if (!deviceSessionId) throw new SessionStorageError("session_reference_incomplete", "Device session id is required.");
  const account = credentialAccount(apiBaseUrl, deviceSessionId);
  const record = {
    apiBaseUrl,
    deviceSessionId,
    credentialAccount: account,
    projectId: session.projectId ? String(session.projectId) : undefined,
    tool: session.tool ? String(session.tool) : undefined,
    expiresAt: session.expiresAt ? String(session.expiresAt) : undefined,
    savedAt: new Date().toISOString()
  };
  assertSafeSessionReference(record, options);
  const credentialStorage = storeCredential(account, sessionToken, options);
  const file = resolveSessionFile(options);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    deleteCredential(account, options);
    throw error;
  }
  return { path: file, record, credentialStorage };
}

function saveSessionReference(session, options = {}) {
  if (session && session.sessionToken) return saveSession(session, session.sessionToken, options);
  throw new SessionStorageError("session_token_required", "Use saveSession with an approved hosted session token.");
}

function loadSessionReference(options = {}) {
  const file = resolveSessionFile(options);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assertSafeSessionReference(record, options);
  return { ...record, apiBaseUrl: normalizeApiBaseUrl(record.apiBaseUrl, options) };
}

function loadSession(options = {}) {
  const record = loadSessionReference(options);
  if (!record) return null;
  const sessionToken = loadCredential(record.credentialAccount, options);
  if (!sessionToken) throw new SessionStorageError("session_credential_missing", "The saved Unclog session is missing from the operating-system credential store.");
  if (!/^us_[A-Za-z0-9_-]{24,160}$/.test(String(sessionToken))) {
    throw new SessionStorageError("session_credential_invalid", "The saved Unclog session credential is invalid. Connect again.");
  }
  return { ...record, sessionToken, allowLocalHttp: allowExplicitLocalHttp(options) };
}

function clearSession(options = {}) {
  const record = loadSessionReference(options);
  if (record) deleteCredential(record.credentialAccount, options);
  const file = resolveSessionFile(options);
  if (fs.existsSync(file)) fs.rmSync(file);
}

const clearSessionReference = clearSession;

function sessionStorageContract(options = {}) {
  return {
    storageDir: resolveSessionDir(options),
    storesInRepository: false,
    persistedSecretMaterial: false,
    sessionMetadataContainsSecret: false,
    persistedRepositoryData: false,
    secretStore: "operating-system credential store",
    permissionProtectedFileFallback: permissionFileFallbackAllowed(options),
    persistedFields: ["apiBaseUrl", "deviceSessionId", "credentialAccount", "projectId", "tool", "expiresAt", "savedAt"],
    revocableByServer: true
  };
}

module.exports = {
  DEFAULT_STORAGE_DIR,
  KEYRING_SERVICE,
  SESSION_FILE,
  SessionStorageError,
  clearSession,
  clearSessionReference,
  credentialStorageCapabilities,
  loadSession,
  loadSessionReference,
  normalizeApiBaseUrl,
  normalizeHostedPublicUrl,
  resolveSessionDir,
  resolveSessionFile,
  saveSession,
  saveSessionReference,
  sessionStorageContract
};
