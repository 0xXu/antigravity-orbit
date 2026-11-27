use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static REQ_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
struct SessionFile {
    endpoint: String,
    #[serde(rename = "authToken")]
    auth_token: String,
}

#[derive(Serialize)]
struct IpcRequest<'a> {
    id: String,
    #[serde(rename = "authToken")]
    auth_token: &'a str,
    method: &'a str,
    params: Value,
}

#[derive(Deserialize)]
struct IpcResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<IpcError>,
}

#[derive(Deserialize)]
struct IpcError {
    code: String,
    message: String,
}

fn resolve_session_path() -> Result<PathBuf, String> {
    if let Ok(override_dir) = std::env::var("ANTIGRAVITY_ORBIT_STATE_DIR") {
        return Ok(PathBuf::from(override_dir).join("ipc-session.json"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or("Cannot resolve home dir")?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("Antigravity Orbit")
            .join("ipc-session.json"));
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = dirs::config_dir().ok_or("Cannot resolve APPDATA")?;
        return Ok(appdata.join("Antigravity Orbit").join("ipc-session.json"));
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let cfg = dirs::config_dir().ok_or("Cannot resolve XDG config dir")?;
        Ok(cfg.join("antigravity-orbit").join("ipc-session.json"))
    }
}

fn read_ipc_response<R: BufRead>(reader: &mut R) -> Result<IpcResponse, String> {
    for _ in 0..16 {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("IPC read failed: {e}"))?;
        if bytes == 0 {
            return Err("IPC connection closed before response".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let raw_val: Value =
            serde_json::from_str(trimmed).map_err(|e| format!("Bad IPC JSON: {e}"))?;
        if raw_val.get("type").and_then(Value::as_str) == Some("event") {
            continue;
        }
        return serde_json::from_value(raw_val).map_err(|e| format!("Bad IPC reply: {e}"));
    }
    Err("Exceeded max skipped IPC event frames".to_string())
}

pub fn send_ipc_call(method: &str, params: Value) -> Result<Value, String> {
    let session_path = resolve_session_path()?;
    let raw = fs::read_to_string(&session_path)
        .map_err(|e| format!("Core daemon not running ({}): {e}", session_path.display()))?;
    let session: SessionFile =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid ipc-session.json: {e}"))?;

    let req = IpcRequest {
        id: format!("tauri-{}", REQ_COUNTER.fetch_add(1, Ordering::Relaxed)),
        auth_token: &session.auth_token,
        method,
        params,
    };
    let mut payload = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    payload.push('\n');

    #[cfg(unix)]
    let parsed = {
        use std::os::unix::net::UnixStream;
        let mut stream = UnixStream::connect(&session.endpoint)
            .map_err(|e| format!("UDS connect failed: {e}"))?;
        stream
            .write_all(payload.as_bytes())
            .map_err(|e| format!("UDS write failed: {e}"))?;
        let mut reader = BufReader::new(stream);
        read_ipc_response(&mut reader)?
    };

    #[cfg(windows)]
    let parsed = {
        use std::fs::OpenOptions;
        let mut pipe = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&session.endpoint)
            .map_err(|e| format!("Named Pipe connect failed: {e}"))?;
        pipe.write_all(payload.as_bytes())
            .map_err(|e| format!("Named Pipe write failed: {e}"))?;
        let mut reader = BufReader::new(pipe);
        read_ipc_response(&mut reader)?
    };

    if parsed.ok {
        Ok(parsed.result.unwrap_or(Value::Null))
    } else if let Some(err) = parsed.error {
        Err(format!("[{}] {}", err.code, err.message))
    } else {
        Err("Unknown IPC error".to_string())
    }
}
