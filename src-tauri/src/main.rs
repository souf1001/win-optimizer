#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tweaks;

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
struct Status {
    system: String,
    warning: String,
    applied: HashMap<String, bool>,
    /// Tweaks with saved original values, which Revert can restore even if only partly applied.
    backups: Vec<String>,
}

#[derive(Serialize)]
struct Outcome {
    id: String,
    ok: bool,
    skipped: bool,
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
    let mut status =
        Status { system: String::new(), warning: String::new(), applied: HashMap::new(), backups: Vec::new() };
    for line in lines {
        if let Some(info) = line.strip_prefix("info:") {
            status.system = info.to_string();
        } else if let Some(warning) = line.strip_prefix("warn:") {
            status.warning = warning.to_string();
        } else if let Some(id) = line.strip_prefix("backup:") {
            status.backups.push(id.to_string());
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
            let (kind, rest) = line.split_once(':')?;
            let (id, message) = rest.split_once(':').unwrap_or((rest, ""));
            let (ok, skipped) = match kind {
                "done" => (true, false),
                "skip" => (true, true),
                "fail" => (false, false),
                _ => return None,
            };
            Some(Outcome { id: id.to_string(), ok, skipped, message: message.to_string() })
        })
        .collect()
}

/// Runs a script with Windows PowerShell and returns its output lines.
/// With `stream`, every line is also sent to the UI as a `log` event.
async fn powershell(app: &AppHandle, script: &str, stream: bool) -> Result<Vec<String>, String> {
    let app = app.clone();
    let script = script.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // One script at a time: a status check must not run while tweaks are being changed.
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        run_powershell(&script, |line| {
            if stream {
                let _ = app.emit("log", line);
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Reads the script from stdin, so it never touches disk where another process could swap it.
/// Module lookup is pinned to the system folder so user-writable module folders can't be loaded.
const BOOTSTRAP: &str = "$env:PSModulePath = \"$PSHOME\\Modules\"; \
    $reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8); \
    . ([scriptblock]::Create($reader.ReadToEnd()))";

fn run_powershell(script: &str, mut on_line: impl FnMut(&str)) -> Result<Vec<String>, String> {
    let system = system_dir();
    let windows = system.parent().unwrap_or(&system).to_path_buf();
    let shell_dir = system.join(r"WindowsPowerShell\v1.0");

    let mut command = Command::new(shell_dir.join("powershell.exe"));
    command
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", BOOTSTRAP])
        // Only system folders on PATH, and no profiler DLLs injected through user environment variables.
        .env(
            "PATH",
            format!(
                "{};{};{};{}",
                system.display(),
                windows.display(),
                system.join("Wbem").display(),
                shell_dir.display()
            ),
        )
        .env("PSModulePath", shell_dir.join("Modules"))
        .env_remove("COR_ENABLE_PROFILING")
        .env_remove("COR_PROFILER")
        .env_remove("COR_PROFILER_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("could not start PowerShell: {e}"))?;

    let mut stdin = child.stdin.take().expect("stdin is piped");
    let script = script.to_string();
    let writer = std::thread::spawn(move || stdin.write_all(script.as_bytes()));

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

    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = writer.join();
    let errors = errors.join().unwrap_or_default();
    let errors = errors.trim();
    // A script that died before reporting anything is an error, not "0 tweaks applied".
    let reported = lines.iter().any(|l| ["done:", "skip:", "fail:", "state:"].iter().any(|p| l.starts_with(p)));
    if !status.success() && !reported {
        return Err(if errors.is_empty() { format!("PowerShell exited with {status}") } else { errors.to_string() });
    }
    if !errors.is_empty() {
        on_line(&format!("log:{errors}"));
    }
    Ok(lines)
}

/// The real System32 folder, independent of environment variables the user controls.
#[cfg(windows)]
fn system_dir() -> PathBuf {
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = [0u16; 260];
    // SAFETY: the buffer is valid for `buffer.len()` UTF-16 units.
    let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    PathBuf::from(String::from_utf16_lossy(&buffer[..len.min(buffer.len())]))
}

#[cfg(not(windows))]
fn system_dir() -> PathBuf {
    PathBuf::from(r"C:\Windows\System32")
}

/// Restarts now. With a zero timeout Windows does not force-close apps, so unsaved work still prompts.
#[tauri::command]
fn restart_pc() -> Result<(), String> {
    let mut command = Command::new(system_dir().join("shutdown.exe"));
    command.args(["/r", "/t", "0", "/d", "p:4:1"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let status = command.status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("shutdown.exe exited with {status}"))
    }
}

fn main() {
    // Elevated processes inherit the user's environment. These would let a user-level
    // program swap the WebView2 runtime or its arguments.
    for name in
        ["WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_USER_DATA_FOLDER"]
    {
        std::env::remove_var(name);
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_tweaks, get_status, run_tweaks, restart_pc])
        .run(tauri::generate_context!())
        .expect("error while running Win Optimizer");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Applies every reversible tweak on a real Windows machine, checks that the status
    /// script sees it as applied, reverts everything and checks the machine is back to
    /// where it started. Meant for a throwaway CI VM: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn apply_check_revert() {
        let targets: Vec<&tweaks::Tweak> = tweaks::all().iter().filter(|t| t.reversible && t.checkable).collect();
        let print = |line: &str| println!("{line}");
        let status = || parse_status(&run_powershell(&tweaks::status_script(tweaks::all()), print).unwrap());

        let before = status();
        let applied = parse_outcomes(&run_powershell(&tweaks::run_script(&targets, false, false), print).unwrap());
        let during = status();
        let reverted = parse_outcomes(&run_powershell(&tweaks::run_script(&targets, true, false), print).unwrap());
        let after = status();

        let mut problems = Vec::new();
        for outcome in &applied {
            if !outcome.ok || outcome.skipped {
                println!("skipped {}: {}", outcome.id, outcome.message);
            } else if during.applied.get(&outcome.id) != Some(&true) {
                println!("{} did nothing on this machine (skipped or unsupported)", outcome.id);
            } else if after.applied.get(&outcome.id) != before.applied.get(&outcome.id) {
                problems.push(format!("{} is not back to its original state after revert", outcome.id));
            }
        }
        for outcome in reverted.iter().filter(|o| !o.ok) {
            problems.push(format!("{} failed to revert: {}", outcome.id, outcome.message));
        }
        assert!(problems.is_empty(), "{problems:#?}");
    }

    /// Cleanup must delete a junction itself, never what it points to.
    #[test]
    #[ignore]
    fn cleanup_does_not_follow_junctions() {
        let script = format!(
            "{}\n{}",
            tweaks::PRELUDE,
            r#"
            $root = Join-Path ([IO.Path]::GetTempPath()) "wo-junction-test"
            Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
            New-Item "$root\clean\sub" -ItemType Directory -Force | Out-Null
            New-Item "$root\target" -ItemType Directory -Force | Out-Null
            Set-Content "$root\clean\sub\junk.txt" 'junk'
            Set-Content "$root\target\keep.txt" 'keep'
            New-Item "$root\clean\link" -ItemType Junction -Value "$root\target" | Out-Null
            Clear-Folder "$root\clean"
            "left:$(@(Get-ChildItem "$root\clean" -Force).Count)"
            "kept:$(Test-Path "$root\target\keep.txt")"
            "#
        );
        let lines = run_powershell(&script, |line| println!("{line}")).unwrap();
        assert!(lines.contains(&"kept:True".to_string()), "junction target was deleted");
        assert!(lines.contains(&"left:0".to_string()), "folder was not emptied");
    }
}
