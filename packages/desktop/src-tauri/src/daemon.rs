use crate::ipc;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct DaemonManager {
    child: Mutex<Option<Child>>,
}

impl DaemonManager {
    pub fn ensure_started(&self, app: &AppHandle) -> Result<String, String> {
        if ipc::send_ipc_call("daemon.status", json!({})).is_ok() {
            return Ok("already-running".to_string());
        }

        let mut guard = self
            .child
            .lock()
            .map_err(|_| "Daemon lock poisoned".to_string())?;

        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Ok("starting".to_string());
            }
            *guard = None;
        }

        let node_bin = resolve_node_binary().ok_or_else(|| {
            "未找到 Node.js 运行时（需 Node >= 26）。请安装 Node.js 或设置 ANTIGRAVITY_ORBIT_NODE_BIN。"
                .to_string()
        })?;
        let (script_path, channels_dir) = resolve_daemon_paths(app).ok_or_else(|| {
            "未找到内置 Core 守护进程脚本（daemon.mjs）。".to_string()
        })?;

        let mut cmd = Command::new(&node_bin);
        cmd.arg(&script_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if let Some(ch_dir) = channels_dir {
            cmd.env("ANTIGRAVITY_ORBIT_CHANNELS_DIR", ch_dir);
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("启动 Core 守护进程失败 ({}): {e}", node_bin.display()))?;
        *guard = Some(child);
        Ok("spawned".to_string())
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

pub fn resolve_node_binary() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("ANTIGRAVITY_ORBIT_NODE_BIN") {
        let p = PathBuf::from(custom);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        let bin_name = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(bin_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut candidates = Vec::new();
        if let Some(home) = dirs::home_dir() {
            // Prioritize user-installed ~/.local/share/node-vX.Y.Z (highest semver first)
            collect_semver_node_bins(&home.join(".local/share"), Some("node-"), &mut candidates);
            candidates.push(home.join(".volta/bin/node"));
            candidates.push(home.join(".fnm/current/bin/node"));
            candidates.push(home.join(".asdf/shims/node"));
            collect_semver_node_bins(&home.join(".nvm/versions/node"), None, &mut candidates);
        }
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        candidates.push(PathBuf::from("/usr/local/bin/node"));
        candidates.push(PathBuf::from("/usr/bin/node"));
        for c in candidates {
            if c.is_file() {
                return Some(c);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        for c in [
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
        ] {
            if c.is_file() {
                return Some(c);
            }
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn parse_node_semver_key(name: &str) -> Option<(u32, u32, u32)> {
    let trimmed = name
        .strip_prefix("node-")
        .unwrap_or(name)
        .strip_prefix('v')
        .unwrap_or(name);
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let patch = parts
        .next()
        .and_then(|s| s.split('-').next())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    Some((major, minor, patch))
}

#[cfg(target_os = "macos")]
fn collect_semver_node_bins(dir: &Path, prefix: Option<&str>, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut matched: Vec<((u32, u32, u32), PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(pfx) = prefix {
                if !name.starts_with(pfx) {
                    return None;
                }
            }
            let ver = parse_node_semver_key(&name)?;
            Some((ver, entry.path().join("bin/node")))
        })
        .collect();
    matched.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in matched {
        out.push(path);
    }
}

fn resolve_daemon_paths(app: &AppHandle) -> Option<(PathBuf, Option<PathBuf>)> {
    if let Ok(res_dir) = app.path().resource_dir() {
        let candidates = [
            (
                res_dir.join("resources/core/daemon.mjs"),
                res_dir.join("resources/channels"),
            ),
            (res_dir.join("core/daemon.mjs"), res_dir.join("channels")),
        ];
        for (script, channels) in candidates {
            if script.is_file() {
                let ch = channels.is_dir().then_some(channels);
                return Some((script, ch));
            }
        }
    }

    // Development fallback relative to current working directory
    if let Ok(cwd) = std::env::current_dir() {
        for base in [cwd.as_path(), cwd.parent().unwrap_or(cwd.as_path())] {
            if let Some(found) = check_workspace_paths(base) {
                return Some(found);
            }
        }
    }

    None
}

fn check_workspace_paths(root: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    let bundled = root.join("packages/desktop/src-tauri/resources/core/daemon.mjs");
    if bundled.is_file() {
        let ch = root.join("packages/desktop/src-tauri/resources/channels");
        return Some((bundled, ch.is_dir().then_some(ch)));
    }
    let dev_main = root.join("packages/core/dist/main.js");
    if dev_main.is_file() {
        let ch = root.join("packages/runtime/dist/channels");
        return Some((dev_main, ch.is_dir().then_some(ch)));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_node_binary_on_host() {
        assert!(
            resolve_node_binary().is_some(),
            "Expected node binary to be discoverable on PATH or standard install locations"
        );
    }
}
