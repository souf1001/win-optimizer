#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tweaks;

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
struct Status {
    system: String,
    applied: HashMap<String, bool>,
}

#[derive(Serialize)]
struct Outcome {
    id: String,
    ok: bool,
    message: String,
}

#[tauri::command]
fn list_tweaks() -> &'static [tweaks::Tweak] {
    tweaks::all()
}

#[tauri::command]
async fn get_status(app: AppHandle) -> Result<Status, String> {
    let lines = powershell(&app, &tweaks::status_script(tweaks::all()), false).await?;
    Ok(parse_status(&lines))
}

#[tauri::command]
async fn run_tweaks(
    app: AppHandle,
    ids: Vec<String>,
    revert: bool,
    restore_point: bool,
) -> Result<Vec<Outcome>, String> {
    let selected: Vec<&tweaks::Tweak> = tweaks::all().iter().filter(|t| ids.contains(&t.id)).collect();
    let lines = powershell(&app, &tweaks::run_script(&selected, revert, restore_point), true).await?;
    Ok(parse_outcomes(&lines))
}

fn parse_status(lines: &[String]) -> Status {
    let mut status = Status { system: String::new(), applied: HashMap::new() };
    for line in lines {
        if let Some(info) = line.strip_prefix("info:") {
            status.system = info.to_string();
        } else if let Some((id, state)) = line.strip_prefix("state:").and_then(|s| s.rsplit_once(':')) {
            status.applied.insert(id.to_string(), state == "1");
        }
    }
    status
}

fn parse_outcomes(lines: &[String]) -> Vec<Outcome> {
    lines
        .iter()
        .filter_map(|line| {
            if let Some(id) = line.strip_prefix("done:") {
                Some(Outcome { id: id.to_string(), ok: true, message: String::new() })
            } else {
                let (id, message) = line.strip_prefix("fail:")?.split_once(':')?;
                Some(Outcome { id: id.to_string(), ok: false, message: message.to_string() })
            }
        })
        .collect()
}

/// Runs a script with Windows PowerShell and returns its output lines.
/// With `stream`, every line is also sent to the UI as a `log` event.
async fn powershell(app: &AppHandle, script: &str, stream: bool) -> Result<Vec<String>, String> {
    let app = app.clone();
    let script = script.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        run_powershell(&script, |line| {
            if stream {
                let _ = app.emit("log", line);
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_powershell(script: &str, mut on_line: impl FnMut(&str)) -> Result<Vec<String>, String> {
    // A temp file avoids command line length limits. The BOM makes PowerShell 5.1 read it as UTF-8.
    let path = std::env::temp_dir().join(format!("win-optimizer-{}.ps1", std::process::id()));
    std::fs::write(&path, format!("\u{feff}{script}")).map_err(|e| e.to_string())?;

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("could not start PowerShell: {e}"))?;

    let mut stderr = child.stderr.take().expect("stderr is piped");
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });

    let mut lines = Vec::new();
    let mut reader = BufReader::new(child.stdout.take().expect("stdout is piped"));
    let mut buf = Vec::new();
    while reader.read_until(b'\n', &mut buf).map_err(|e| e.to_string())? > 0 {
        let line = String::from_utf8_lossy(&buf).trim_end().to_string();
        buf.clear();
        on_line(&line);
        lines.push(line);
    }

    let _ = child.wait();
    let _ = std::fs::remove_file(&path);
    let errors = errors.join().unwrap_or_default();
    if !errors.trim().is_empty() {
        on_line(&format!("log:{}", errors.trim()));
    }
    Ok(lines)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_tweaks, get_status, run_tweaks])
        .run(tauri::generate_context!())
        .expect("error while running Win Optimizer");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Applies every reversible tweak on a real Windows machine, checks that the status
    /// script sees it as applied, then reverts everything. Meant for a throwaway CI VM:
    /// `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn apply_check_revert() {
        let targets: Vec<&tweaks::Tweak> = tweaks::all().iter().filter(|t| t.reversible && t.checkable).collect();
        let print = |line: &str| println!("{line}");

        let applied = parse_outcomes(&run_powershell(&tweaks::run_script(&targets, false, false), print).unwrap());
        let status = parse_status(&run_powershell(&tweaks::status_script(tweaks::all()), print).unwrap());
        let reverted = parse_outcomes(&run_powershell(&tweaks::run_script(&targets, true, false), print).unwrap());

        let mut problems = Vec::new();
        for outcome in &applied {
            if !outcome.ok {
                println!("skipped {}: {}", outcome.id, outcome.message);
            } else if status.applied.get(&outcome.id) != Some(&true) {
                problems.push(format!("{} applied without errors but its check says it is not", outcome.id));
            }
        }
        for outcome in reverted.iter().filter(|o| !o.ok) {
            problems.push(format!("{} failed to revert: {}", outcome.id, outcome.message));
        }
        assert!(problems.is_empty(), "{problems:#?}");
    }
}
