# Unclog Bridge

The official persistent thin MCP bridge for hosted Unclog. It handles one-time connection, revocable authentication, client registration, safe local draft files, and HTTPS transport. The workflow brain, phase decisions, authorization, and canonical mission state remain on the hosted service.

## Customer setup

Copy the exact prompt from the signed-in Unclog dashboard and give it to your coding agent inside the target Git repository. Its one-time command has this shape:

```sh
npx --yes unclog-bridge@1.1.7 connect --tool codex --setup-intent <short-lived-intent>
```

`--tool` may be `codex`, `claude`, `cursor`, or `generic`. The bridge resolves the repository root, waits for approval in the already signed-in dashboard, links the repository, installs the exact public runtime under `~/.unclog/bridge/runtime/1.1.7`, and registers an `unclog` local stdio MCP server without replacing unrelated client settings. Customers do not need an npm account and do not copy or type a device code.

The already-open dashboard is the primary approval surface. The bridge gives the customer 30 seconds to review the automatically detected request before it opens the one-time approval URL as a recovery fallback; successful normal approval never opens the extra fallback tab.

After a normal Codex, Claude, or Cursor setup, the only continuation message is:

> Unclog connected. Start a new task and say: Use Unclog.

Generic clients also receive the generated MCP configuration path to import before that step. Setup is repository-bound. Run a fresh dashboard setup prompt when connecting another repository or client.

## Normal use

After setup, there are exactly three workflow tools:

- `unclog_next` gets the authoritative current phase, focused worker packet, and opaque allowed action IDs.
- `unclog_act` executes exactly one current server-authorized action ID. It refreshes authority first and rejects stale, wrong-mission, wrong-worker, arbitrary-input, and destructive actions.
- `unclog_wait` performs only a bounded wait for approval, handoff, or another external state change.

Routine work never uses `npx`, a shell command, a private Unclog CLI, or a locally installed full Unclog skill. Cold workers start by calling `unclog_next` with the mission and worker IDs supplied in their handoff prompt. Proof, closeout, and final mission validation remain mandatory hosted workflow gates.

Unconfirmed goal-intake content stays in explicit files under `.unclog-drafts` in the repository. The bridge uploads a draft only when the current hosted action explicitly authorizes submission. It rejects traversal, symlink escape, arbitrary source-file reads, repository payloads, patches, tokens, and controller internals.

## Credentials and recovery

The setup intent and approval URL are short-lived pairing material. The resulting device session is revocable and stored outside the repository in the operating-system credential store. On Unix-like systems only, an unavailable keyring may fall back to a verified `0700` directory and `0600` credential file. Windows requires Credential Manager. Never paste a session token into a prompt or config file.

CLI commands are reserved for setup and recovery:

- `doctor` validates the saved session, exact runtime identity, workspace binding, and owned client configuration.
- `reconnect` uses a fresh exact setup prompt from the dashboard.
- `update` atomically installs the invoked bridge release and updates only the bridge-owned MCP entry.
- `uninstall` removes only bridge-owned local configuration/runtime and attempts hosted device revocation.
- `logout` or `revoke` revokes the hosted device while leaving the installed MCP registration available for a later reconnect.

If recovery is needed, invoke the exact pinned release shown by the dashboard, for example `npx --yes unclog-bridge@1.1.7 doctor`. Unknown routine CLI commands fail closed and direct the agent back to `unclog_next`.

## Public-package boundary

The package contains only the thin bridge source, README, and customer license. Public source and release provenance live at [apiqsha/unclog-bridge](https://github.com/apiqsha/unclog-bridge). The private product repository, canonical hosted controller, optimized workflow guidance, database authority, and server secrets are never included.

Supported releases are produced only by the repository GitHub Actions release workflow using exact dependencies and npm provenance. Normal releases use npm trusted OIDC publishing; no long-lived customer or runtime npm credential is required.
