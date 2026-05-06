// atlas_bridge — wires Meetily's transcript pipeline into the Atlas Bun sidecar.
//
// Two pieces:
//   1. spawn_sidecar: launches the bundled atlas-agent binary on app startup
//      with ATLAS_DATA_DIR set to Tauri's app_data_dir so SQLite lands in the
//      OS-standard per-user dir.
//   2. install_event_forwarder: subscribes to Meetily's "transcript-update"
//      Tauri event, drops partials, and POSTs final utterances to
//      http://127.0.0.1:3001/calls/{callId}/utterance.
//
// The active Atlas call id lives in a parking_lot mutex shared with the
// `set_active_atlas_call` and `clear_active_atlas_call` Tauri commands, which
// the frontend invokes around the call lifecycle. While there's no active
// call, transcript events are dropped silently.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_NAME: &str = "atlas-agent";
const SIDECAR_PORT: u16 = 3001;
const SIDECAR_BASE: &str = "http://127.0.0.1:3001";

#[derive(Debug, Clone, Default)]
pub struct AtlasState {
    pub active_call_id: Arc<Mutex<Option<String>>>,
    pub sidecar_handle: Arc<Mutex<Option<CommandChild>>>,
}

impl AtlasState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Deserialize)]
struct TranscriptUpdate {
    text: String,
    #[serde(default)]
    source: String, // "Microphone" | "Audio" | "System Audio"
    #[serde(default)]
    is_partial: bool,
    #[serde(default)]
    confidence: f32,
    #[serde(default)]
    audio_start_time: f64, // seconds since recording start
    #[serde(default)]
    audio_end_time: f64, // seconds since recording start
}

#[derive(Debug, Serialize)]
struct UtteranceBody {
    #[serde(rename = "participantId")]
    participant_id: String,
    text: String,
    #[serde(rename = "startMs")]
    start_ms: u64,
    #[serde(rename = "endMs")]
    end_ms: u64,
    confidence: f32,
    speaker: String,
}

/// Map Meetily's audio source label to a stable participant id and an
/// initial founder/customer hint. The Atlas sidecar's SpeakerMap will
/// override these labels if the user relabels mid-call.
fn participant_for_source(source: &str) -> (&'static str, &'static str) {
    let s = source.to_ascii_lowercase();
    if s.contains("mic") {
        ("microphone", "founder")
    } else {
        ("system_audio", "customer")
    }
}

/// Spawn the bundled atlas-agent sidecar. Returns the child handle so we
/// can kill it on app shutdown.
pub fn spawn_sidecar(app: &AppHandle) -> Result<CommandChild, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?
        .join("atlas-agent");
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("create atlas-agent data dir: {e}"))?;

    log::info!(
        "[atlas_bridge] spawning {SIDECAR_NAME} sidecar (data_dir={:?})",
        data_dir
    );

    let (mut rx, child) = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("locate sidecar binary: {e}"))?
        .env("ATLAS_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("PORT", SIDECAR_PORT.to_string())
        .spawn()
        .map_err(|e| format!("spawn sidecar: {e}"))?;

    // Forward sidecar stdout/stderr into Tauri's logs for diagnosability.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!(
                        "[atlas-agent stdout] {}",
                        String::from_utf8_lossy(&line).trim_end()
                    );
                }
                CommandEvent::Stderr(line) => {
                    log::warn!(
                        "[atlas-agent stderr] {}",
                        String::from_utf8_lossy(&line).trim_end()
                    );
                }
                CommandEvent::Terminated(status) => {
                    log::error!("[atlas-agent] terminated: {:?}", status);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// Subscribe to Meetily's "transcript-update" events and forward finalized
/// utterances to the Atlas sidecar.
pub fn install_event_forwarder(app: &AppHandle) {
    let active_call = app.state::<AtlasState>().active_call_id.clone();
    let app_handle = app.clone();

    app.listen("transcript-update", move |event| {
        let payload = event.payload();
        let update: TranscriptUpdate = match serde_json::from_str(payload) {
            Ok(u) => u,
            Err(e) => {
                log::warn!("[atlas_bridge] bad transcript-update payload: {e}");
                return;
            }
        };

        if update.is_partial {
            return; // skip interim chunks
        }
        if update.text.trim().is_empty() {
            return;
        }

        let call_id = match active_call.lock().ok().and_then(|g| g.clone()) {
            Some(id) => id,
            None => return, // no active Atlas call — ignore
        };

        let (participant_id, speaker) = participant_for_source(&update.source);
        let body = UtteranceBody {
            participant_id: participant_id.to_string(),
            text: update.text.clone(),
            start_ms: (update.audio_start_time * 1000.0) as u64,
            end_ms: (update.audio_end_time * 1000.0) as u64,
            confidence: if update.confidence > 0.0 {
                update.confidence
            } else {
                1.0
            },
            speaker: speaker.to_string(),
        };

        let url = format!("{SIDECAR_BASE}/calls/{call_id}/utterance");
        let app_for_emit = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    log::error!("[atlas_bridge] reqwest build failed: {e}");
                    return;
                }
            };

            match client.post(&url).json(&body).send().await {
                Ok(res) if res.status().is_success() => {
                    // Success — nothing to do. Pipeline broadcasts SSE
                    // back to the frontend independently.
                }
                Ok(res) => {
                    let status = res.status();
                    let body_text = res.text().await.unwrap_or_default();
                    log::warn!(
                        "[atlas_bridge] sidecar rejected utterance: {status} {body_text}"
                    );
                    let _ = app_for_emit.emit(
                        "atlas-bridge-error",
                        format!("sidecar {status}: {body_text}"),
                    );
                }
                Err(e) => {
                    log::warn!("[atlas_bridge] sidecar POST failed: {e}");
                    let _ = app_for_emit.emit("atlas-bridge-error", e.to_string());
                }
            }
        });
    });

    log::info!("[atlas_bridge] event forwarder installed");
}

// ── Tauri commands invoked from the Atlas frontend ─────────────────────────

#[tauri::command]
pub fn set_active_atlas_call(state: tauri::State<'_, AtlasState>, call_id: String) {
    log::info!("[atlas_bridge] active call set: {call_id}");
    if let Ok(mut guard) = state.active_call_id.lock() {
        *guard = Some(call_id);
    }
}

#[tauri::command]
pub fn clear_active_atlas_call(state: tauri::State<'_, AtlasState>) {
    log::info!("[atlas_bridge] active call cleared");
    if let Ok(mut guard) = state.active_call_id.lock() {
        *guard = None;
    }
}

#[tauri::command]
pub fn atlas_sidecar_base_url() -> String {
    SIDECAR_BASE.to_string()
}
