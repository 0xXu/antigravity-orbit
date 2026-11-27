# Architecture & Security Boundaries

## System Overview

```text
+-----------------------------------+        Local IPC (Unix socket / Named Pipe)
|  @antigravity-orbit/desktop       | <==========================================>
|  (React 19 + Vite + Tauri 2)      |        Token-authenticated JSON-lines
+-----------------------------------+
                                                    |
                                                    v
                                      +-----------------------------------+
                                      |  @antigravity-orbit/core          |
                                      |  - ConfigStore (atomic 0600)      |
                                      |  - CdpOrchestrator (11 channels)  |
                                      |  - UsageLedger (node:sqlite WAL)  |
                                      |  - QuotaFusion & AccountManager   |
                                      |  - Loopback Media Gateways        |
                                      |  - ThoughtTranslator & InlineDiff |
                                      |  - ReversibleMaintenanceService   |
                                      +-----------------------------------+
                                                    |
                                       Loopback CDP (ws://127.0.0.1:*)
                                       Isolated World (ANTIGRAVITY_ORBIT_ISOLATED_V1)
                                                    v
                                      +-----------------------------------+
                                      |  @antigravity-orbit/runtime       |
                                      |  11 on-demand IIFE channels       |
                                      +-----------------------------------+
```

## Runtime Channel Budgets

Disabled or unrequested channels remain strictly **0-byte unloaded** in the IDE.

| Channel ID | Purpose | Always On | Max Budget |
| --- | --- | --- | --- |
| `ch01-core` | Microkernel bootstrap, themes, ink stream | Yes | 150 KB |
| `ch02-hud` | Hybrid metrics HUD & vial canvas | Config | 80 KB |
| `ch03-i18n` | Interface localization | Config (`language !== 'en'`) | 80 KB |
| `ch04-workbench` | Code folding, outline rail, BTW menu, effort slider | Config | 80 KB |
| `ch05-translator` | Thought translation overlay | Config (`mode !== 'off'`) | 60 KB |
| `ch06-omni` | Rich media / document viewer | Config | 60 KB |
| `ch07-inline-diff` | Inline git diff viewer | Config (`omni && inlineDiff`) | 60 KB |
| `ch08-chat-mode` | Focused chat layout | Config | 60 KB |
| `ch09-optics-picker` | 3D model picker | Demand (`modelMenuOpen`, non-eco) | 60 KB |
| `ch11-optics-wallpaper` | Ambient static/video wallpaper | Config + path (non-eco) | 60 KB |
| `ch12-settings` | In-IDE quick settings drawer | Demand (`settingsOpen`) | 80 KB |

## Core Security Invariants

1. **Isolated World & Top-Level Frame Guard**: All runtime channels execute inside `ANTIGRAVITY_ORBIT_ISOLATED_V1` with `grantUniveralAccess: false`. `Runtime.bindingCalled` events whose `executionContextId` does not match the top-level isolated world are dropped.
2. **Loopback-Only Transport**:
   - CDP discovery rejects non-`ws:`, credentialed, and non-loopback endpoints.
   - `LocalIpcServer` binds a `0600` Unix domain socket (or random named pipe on Windows) and verifies a 256-bit random session token using `crypto.timingSafeEqual`.
   - `WallpaperGateway` and `OmniStreamingGateway` bind exclusively to `127.0.0.1`, validate the `Host` header, enforce path/extension allowlists, and serve `OmniStreamingGateway` responses with per-directory HMAC-SHA256 TTL tokens and `connect-src 'none'` sandbox CSP.
3. **SSRF & Git Hook Fail-Closed Guards**:
   - `ThoughtTranslatorService` blocks cloud metadata IPs/hosts, high-risk internal ports, non-HTTP(S) protocols, and redirects, and caps concurrency at 3.
   - `getSafeInlineDiff` rejects path traversal, `.env*`, symlinks escaping the repository root, non-directory `.git` entries, and `.git/config` containing `[filter ...]` or `fsmonitor =`.
4. **Atomic Account Switching & Reversible Maintenance**:
   - `AccountManager` enforces host-stopped checks, records a WAL journal before mutating `state.vscdb` inside `BEGIN IMMEDIATE`, rolls back on failure, and scrubs credentials from completed journals on commit and account deletion.
   - `ReversibleMaintenanceService` blocks protected user-data segments and symlinks, tracks `(dev, ino)` in manifests, and never overwrites regenerated files on restore.
