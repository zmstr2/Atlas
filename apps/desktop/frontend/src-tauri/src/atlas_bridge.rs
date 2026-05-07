// atlas_bridge — forwards Meetily's transcript pipeline to the remote Atlas
// agent (deployed on Railway). Previously this also spawned a bundled Bun
// sidecar; that has been removed in favor of a remote HTTPS service.
//
// Responsibilities:
//   1. install_event_forwarder: subscribes to Meetily's "transcript-update"
//      Tauri event, drops partials, and POSTs final utterances to
//      `${ATLAS_AGENT_URL}/calls/{callId}/utterance` with the user's JWT in
//      the Authorization header.
//   2. Tauri commands for the frontend to set/clear the active call and the
//      auth token, and to read the agent base URL.
//
// The active Atlas call id and auth token live in mutexes shared with the
// Tauri commands. While there's no active call OR no auth token, transcript
// events are dropped silently (with a warning log on missing auth).

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Listener, Manager};

const DEFAULT_AGENT_URL: &str = "https://atlas-agent.up.railway.app";

/// Resolve the Atlas agent base URL. Reads `ATLAS_AGENT_URL` from the
/// environment at runtime (set at compile time by the build / Tauri config,
/// or at dev runtime). Falls back to the production Railway URL.
fn agent_base_url() -> String {
    std::env::var("ATLAS_AGENT_URL").unwrap_or_else(|_| DEFAULT_AGENT_URL.to_string())
}

#[derive(Debug, Clone, Default)]
pub struct AtlasState {
    pub active_call_id: Arc<Mutex<Option<String>>>,
    pub auth_token: Arc<Mutex<Option<String>>>,
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
/// initial founder/customer hint. The Atlas agent's SpeakerMap will
/// override these labels if the user relabels mid-call.
fn participant_for_source(source: &str) -> (&'static str, &'static str) {
    let s = source.to_ascii_lowercase();
    if s.contains("mic") {
        ("microphone", "founder")
    } else {
        ("system_audio", "customer")
    }
}

/// Subscribe to Meetily's "transcript-update" events and forward finalized
/// utterances to the remote Atlas agent.
pub fn install_event_forwarder(app: &AppHandle) {
    let state = app.state::<AtlasState>();
    let active_call = state.active_call_id.clone();
    let auth_token = state.auth_token.clone();
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

        let token = match auth_token.lock().ok().and_then(|g| g.clone()) {
            Some(t) => t,
            None => {
                log::warn!(
                    "[atlas_bridge] no auth token set; skipping utterance POST (user not logged in?)"
                );
                return;
            }
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

        let url = format!("{}/calls/{call_id}/utterance", agent_base_url());
        let app_for_emit = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    log::error!("[atlas_bridge] reqwest build failed: {e}");
                    return;
                }
            };

            match client
                .post(&url)
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    // Success — nothing to do. Pipeline broadcasts SSE
                    // back to the frontend independently.
                }
                Ok(res) => {
                    let status = res.status();
                    let body_text = res.text().await.unwrap_or_default();
                    log::warn!(
                        "[atlas_bridge] agent rejected utterance: {status} {body_text}"
                    );
                    let _ = app_for_emit.emit(
                        "atlas-bridge-error",
                        format!("agent {status}: {body_text}"),
                    );
                }
                Err(e) => {
                    log::warn!("[atlas_bridge] agent POST failed: {e}");
                    let _ = app_for_emit.emit("atlas-bridge-error", e.to_string());
                }
            }
        });
    });

    log::info!(
        "[atlas_bridge] event forwarder installed (agent={})",
        agent_base_url()
    );
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
pub fn atlas_agent_base_url() -> String {
    agent_base_url()
}

#[tauri::command]
pub fn set_atlas_auth_token(state: tauri::State<'_, AtlasState>, token: String) {
    log::info!("[atlas_bridge] auth token set ({} chars)", token.len());
    if let Ok(mut guard) = state.auth_token.lock() {
        *guard = Some(token);
    }
}

#[tauri::command]
pub fn clear_atlas_auth_token(state: tauri::State<'_, AtlasState>) {
    log::info!("[atlas_bridge] auth token cleared");
    if let Ok(mut guard) = state.auth_token.lock() {
        *guard = None;
    }
}
