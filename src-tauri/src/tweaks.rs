//! Tweak definitions and the PowerShell generated from them.
//!
//! Tweaks live in `tweaks/*.toml` (one file per category). A tweak is mostly data:
//! registry values, services, scheduled tasks and apps. Anything else goes into the
//! free-form `apply` / `revert` / `check` PowerShell snippets.

use serde::{Deserialize, Serialize};
use std::fmt::Write;
use std::sync::OnceLock;

/// Helper functions every generated script starts with.
pub const PRELUDE: &str = include_str!("prelude.ps1");

/// Category files, in sidebar order.
const FILES: &[(&str, &str)] = &[
    ("bloatware", include_str!("../../tweaks/bloatware.toml")),
    ("privacy", include_str!("../../tweaks/privacy.toml")),
    ("performance", include_str!("../../tweaks/performance.toml")),
    ("gaming", include_str!("../../tweaks/gaming.toml")),
    ("services", include_str!("../../tweaks/services.toml")),
    ("updates", include_str!("../../tweaks/updates.toml")),
    ("interface", include_str!("../../tweaks/interface.toml")),
    ("cleanup", include_str!("../../tweaks/cleanup.toml")),
];

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Light,
    Medium,
    Aggressive,
    /// Personal preference: never picked by a preset.
    Optional,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum Value {
    Number(i64),
    Text(String),
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub path: String,
    pub name: String,
    #[serde(rename = "type", default = "dword")]
    pub kind: String,
    pub value: Value,
    /// Value to restore on revert. Without it, revert deletes the value.
    pub default: Option<Value>,
}

fn dword() -> String {
    "DWord".into()
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Service {
    pub name: String,
    /// Disabled, Manual, Automatic or AutomaticDelayed.
    pub startup: String,
    pub default: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Tweak {
    pub id: String,
    pub name: String,
    pub description: String,
    pub level: Level,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub restart: bool,
    #[serde(default)]
    pub registry: Vec<Registry>,
    #[serde(default)]
    pub services: Vec<Service>,
    /// Scheduled task paths to disable, e.g. '\Microsoft\Windows\Autochk\Proxy'.
    #[serde(default)]
    pub tasks: Vec<String>,
    /// Appx package names to remove (wildcards allowed).
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub apply: String,
    #[serde(default)]
    pub revert: String,
    /// PowerShell that returns $true when the tweak is already applied.
    #[serde(default)]
    pub check: String,
    /// Filled in on load so the UI does not need to know the rules.
    #[serde(default)]
    pub reversible: bool,
    #[serde(default)]
    pub checkable: bool,
}

#[derive(Deserialize)]
struct File {
    tweak: Vec<Tweak>,
}

pub fn all() -> &'static [Tweak] {
    static TWEAKS: OnceLock<Vec<Tweak>> = OnceLock::new();
    TWEAKS.get_or_init(|| load().expect("invalid tweak definitions"))
}

pub fn load() -> Result<Vec<Tweak>, String> {
    let mut tweaks: Vec<Tweak> = Vec::new();
    for (category, source) in FILES {
        let file: File = toml::from_str(source).map_err(|e| format!("{category}.toml: {e}"))?;
        for mut t in file.tweak {
            validate(&t).map_err(|e| format!("{category}.toml, {}: {e}", t.id))?;
            if tweaks.iter().any(|other| other.id == t.id) {
                return Err(format!("duplicate id {}", t.id));
            }
            t.category = category.to_string();
            t.reversible = t.apps.is_empty() && (t.apply.is_empty() || !t.revert.is_empty());
            t.checkable = check_expr(&t).is_some();
            tweaks.push(t);
        }
    }
    Ok(tweaks)
}

/// Rejects values that would end up unquoted in PowerShell or can't be reverted.
fn validate(t: &Tweak) -> Result<(), String> {
    let id_ok = !t.id.is_empty() && t.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !id_ok {
        return Err("id must be lowercase kebab-case".into());
    }
    if t.name.is_empty() || t.description.is_empty() {
        return Err("needs a name and a description".into());
    }
    for r in &t.registry {
        if !(r.path.starts_with("HKLM:\\") || r.path.starts_with("HKCU:\\")) {
            return Err(format!("registry path must start with HKLM:\\ or HKCU:\\: {}", r.path));
        }
        if !["DWord", "QWord", "String", "ExpandString"].contains(&r.kind.as_str()) {
            return Err(format!("unsupported registry type {}", r.kind));
        }
        let numeric = r.kind == "DWord" || r.kind == "QWord";
        if numeric != matches!(r.value, Value::Number(_)) {
            return Err(format!("{} has the wrong value type for {}", r.name, r.kind));
        }
    }
    let startups = ["Disabled", "Manual", "Automatic", "AutomaticDelayed"];
    for v in &t.services {
        if !startups.contains(&v.startup.as_str()) || !startups.contains(&v.default.as_str()) {
            return Err(format!("unknown startup type for {}", v.name));
        }
    }
    Ok(())
}

/// Quote a string for PowerShell (single quotes, no interpolation).
/// PowerShell also treats the typographic quotes ‘ ’ ‚ ‛ as single quotes.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace(['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'], "''"))
}

fn value(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        Value::Text(s) => quote(s),
    }
}

fn apply_body(t: &Tweak) -> String {
    let mut s = String::new();
    for r in &t.registry {
        let _ = writeln!(s, "Set-TweakReg {} {} {} {}", quote(&r.path), quote(&r.name), r.kind, value(&r.value));
    }
    for v in &t.services {
        let _ = writeln!(s, "Set-TweakSvc {} {}", quote(&v.name), v.startup);
    }
    for task in &t.tasks {
        let _ = writeln!(s, "Set-TweakTask {}", quote(task));
    }
    for app in &t.apps {
        let _ = writeln!(s, "Remove-App {}", quote(app));
    }
    s + &t.apply
}

fn revert_body(t: &Tweak) -> String {
    let mut s = String::new();
    for r in &t.registry {
        let default = r.default.as_ref().map_or("$null".to_string(), value);
        let _ = writeln!(s, "Undo-TweakReg {} {} {} {}", quote(&r.path), quote(&r.name), r.kind, default);
    }
    for v in &t.services {
        let _ = writeln!(s, "Undo-TweakSvc {} {}", quote(&v.name), v.default);
    }
    for task in &t.tasks {
        let _ = writeln!(s, "Undo-TweakTask {}", quote(task));
    }
    s + &t.revert
}

/// A PowerShell expression that is $true when the tweak is applied, if it can be checked.
fn check_expr(t: &Tweak) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for r in &t.registry {
        parts.push(format!("(Test-Reg {} {} {})", quote(&r.path), quote(&r.name), value(&r.value)));
    }
    for v in &t.services {
        parts.push(format!("(Test-Svc {} {})", quote(&v.name), v.startup));
    }
    for task in &t.tasks {
        parts.push(format!("(Test-Task {})", quote(task)));
    }
    for app in &t.apps {
        parts.push(format!("(Test-App {})", quote(app)));
    }
    if !t.check.is_empty() {
        parts.push(format!("(& {{\n{}\n}})", t.check));
    }
    (!parts.is_empty()).then(|| parts.join(" -and "))
}

/// Script that prints `state:<id>:1|0` for every checkable tweak.
pub fn status_script(tweaks: &[Tweak]) -> String {
    let mut s = String::from(PRELUDE);
    s.push_str("try { Write-SystemInfo } catch { Write-Output \"info:$($_.Exception.Message)\" }\n");
    for t in tweaks {
        if let Some(expr) = check_expr(t) {
            let _ = writeln!(s, "Test-Tweak {} {{ {} }}", quote(&t.id), expr);
        }
    }
    s
}

/// Script that applies (or reverts) the given tweaks one by one.
pub fn run_script(tweaks: &[&Tweak], revert: bool, restore_point: bool) -> String {
    let mut s = String::from(PRELUDE);
    if restore_point {
        // Without a restore point there is no safety net, so change nothing.
        s.push_str("Invoke-Tweak 'restore-point' { New-RestorePoint }\nif ($script:Failed) { exit 1 }\n");
    }
    for t in tweaks {
        let body = if revert { revert_body(t) } else { apply_body(t) };
        let flag = if revert { " -Revert" } else { "" };
        let _ = writeln!(s, "Invoke-Tweak {} {{\n{}\n}}{flag}", quote(&t.id), body.trim_end());
    }
    s.push_str("Restart-Explorer\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_are_valid() {
        for t in load().unwrap() {
            assert!(!apply_body(&t).trim().is_empty(), "{} does nothing", t.id);
        }
    }

    /// Checks the generated scripts with the real PowerShell parser (pwsh or powershell.exe).
    #[test]
    fn generated_scripts_parse() {
        let shell = if cfg!(windows) { "powershell.exe" } else { "pwsh" };
        let tweaks: Vec<&Tweak> = all().iter().collect();
        let scripts = [status_script(all()), run_script(&tweaks, false, true), run_script(&tweaks, true, false)];
        for (i, script) in scripts.iter().enumerate() {
            let path = std::env::temp_dir().join(format!("win-optimizer-parse-{i}.ps1"));
            std::fs::write(&path, script).unwrap();
            let command = format!(
                "$e = $null; [void][Management.Automation.Language.Parser]::ParseFile('{}', [ref]$null, [ref]$e); $e | ForEach-Object {{ \"line $($_.Extent.StartLineNumber): $($_.Message)\" }}",
                path.display()
            );
            let Ok(out) = std::process::Command::new(shell).args(["-NoProfile", "-Command", &command]).output() else {
                eprintln!("{shell} not found, skipping");
                return;
            };
            let errors = String::from_utf8_lossy(&out.stdout);
            assert!(errors.trim().is_empty(), "script {i}:\n{errors}");
        }
    }

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(quote("it's"), "'it''s'");
    }
}
