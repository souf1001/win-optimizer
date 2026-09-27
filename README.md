# Win Optimizer

A small desktop app that debloats and tunes Windows 10 and 11 for gaming and everyday use.
It removes preinstalled apps, turns off telemetry and ads, lowers idle CPU and RAM use,
and applies the gaming tweaks that actually make a difference.

- **131 tweaks** in 8 categories: Bloatware, Privacy, Performance, Gaming, Services, Updates, Interface, Cleanup
- **Three presets**: Light, Medium and Aggressive. Pick one, then add or remove single tweaks
- **Live status**: the app checks which tweaks are already applied on your PC
- **Undo**: the app saves your original values before changing anything, and Revert puts exactly those back. App removal and cleanup can't be undone
- **Transparent**: expand any tweak to see the exact registry values, services, tasks or script it touches
- **Restore point** before every run (optional, on by default)
- Small (a few MB), no background process, no telemetry of its own

## Presets

| Preset | What it includes | What you notice |
| --- | --- | --- |
| Light | Junk apps, telemetry, ads and tips, web results in Start, Edge background mode, windowed game optimizations | Far fewer ads and popups, about 100-250 MB less RAM at idle, startup apps appear sooner |
| Medium | Light, plus features some people use: Copilot, Recall, Widgets, Phone Link, background Store apps, Game Bar, mouse acceleration | Another 100-300 MB at idle (matters on 8 GB PCs), consistent mouse aim |
| Aggressive | Everything, including trade-offs: Memory Integrity/VBS off, Ultimate Performance plan, SysMain and Search indexing off, Windows.old removal | VBS off is the one measurable FPS gain: 0-5% on most CPUs, 10-15% in some CPU-bound games |

Honest expectations: no registry tweak doubles your FPS. The real wins are a quieter, lighter
Windows, fewer background spikes while you play, and the few gaming settings that actually matter.

Tweaks marked *Optional* are personal taste (dark mode, classic context menu, taskbar on the left)
and are never selected by a preset.

## Install

1. Download `Win Optimizer_x.y.z_x64-setup.exe` from the [Releases](../../releases) page,
   or from the latest successful run under **Actions → Build → Artifacts**.
2. Run it. The installer and the app ask for administrator rights, because most tweaks
   change machine-wide settings.
3. Open **Win Optimizer** from the Start menu.

Requires Windows 10 or 11 (x64). WebView2 is built into both.

## Using it

1. Wait a few seconds while the app checks what is already applied.
2. Choose **Light**, **Medium** or **Aggressive** at the top right.
3. Browse the categories on the left. Click a row to select or deselect it; click the arrow to see what it changes.
4. Press **Apply**, check the summary, and confirm. Keep "Create a restore point" on.
5. Restart when the summary says so.

To undo, select the tweaks and press **Revert**. You can also roll back everything with
the restore point: Start → "Create a restore point" → System Restore.

Shortcuts: `/` or `Ctrl+K` to search, `Esc` to clear.

## Build from source

Requirements: [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 20+, and on Windows
the "Desktop development with C++" workload from the Visual Studio Build Tools.

```powershell
git clone https://github.com/souf1001/win-optimizer
cd win-optimizer
npm install
npm run dev      # run the app in development mode
npm run build    # build the installer into src-tauri/target/release/bundle/nsis/
```

Tests:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml                         # definitions and PowerShell syntax
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture # applies and reverts everything: VM only!
```

CI runs both on a fresh Windows VM and builds the installer on every push. Pushing a tag like
`v0.1.0` publishes a GitHub release.

## How it works

```
tweaks/*.toml          Tweak definitions (data, one file per category)
src-tauri/src/
  tweaks.rs            Loads the TOML and turns it into PowerShell
  prelude.ps1          PowerShell helpers every script starts with
  main.rs              Tauri commands: list_tweaks, get_status, run_tweaks
ui/                    Plain HTML, CSS and JavaScript. No framework, no build step
```

The app is built with [Tauri 2](https://tauri.app): a Rust backend and a web UI rendered by the
WebView2 runtime that ships with Windows. The backend generates one PowerShell script per action and
runs it with the built-in Windows PowerShell 5.1. Each tweak runs in its own `try/catch`, so one
failure never stops the rest.

## Adding a tweak

Most tweaks are pure data. Add a block to the matching file in `tweaks/`:

```toml
[[tweak]]
id = "game-dvr"                       # unique, kebab-case
name = "Disable background recording"
description = "What it does and what you lose, in one or two sentences."
level = "light"                       # light | medium | aggressive | optional
restart = false                       # true if it needs a restart or sign-out
registry = [
  # type defaults to DWord. Without `default`, revert deletes the value.
  { path = 'HKCU:\System\GameConfigStore', name = 'GameDVR_Enabled', value = 0, default = 1 },
]
services = [{ name = "DiagTrack", startup = "Disabled", default = "Automatic" }]
tasks = ['\Microsoft\Windows\Autochk\Proxy']
apps = ["Microsoft.BingNews"]          # appx names, wildcards allowed
```

Apply, revert and the status check are generated from these fields. For anything else, write PowerShell:

```toml
apply = '''...'''    # runs on Apply
revert = '''...'''   # runs on Revert (leave out if it can't be undone)
check = '''...'''    # returns $true when the tweak is applied
```

Run `cargo test` afterwards. It validates every definition and parses the generated scripts.

## Security

The app runs as administrator, so it is built to not become a way in:

- Scripts go to PowerShell through a pipe (stdin), never through a file another program could swap.
- PowerShell is started by its full System32 path with a clean `PATH`, a pinned module path and
  no profiler variables, so user-writable folders can't inject code into the elevated session.
- Cleanup never follows junctions or symlinks, so a planted link can't redirect deletes to system folders.
- The OneDrive uninstaller only runs if it is signed by Microsoft.
- Only one script runs at a time. If the restore point fails, nothing is changed.
- The web view only loads the bundled UI (strict CSP, no remote content) and all text is escaped.
- CI actions are pinned to commit SHAs and the build job has read-only access.

## What this app deliberately does not do

These show up in many "optimizer" lists but are placebo, outdated or harmful:

- **Disable Windows Defender or Windows Update.** Tamper Protection reverts it, and the security cost is real.
- **Disable the page file or memory compression.** Increases crashes and RAM pressure, and doesn't make games faster.
- **Nagle's algorithm, NetworkThrottlingIndex, MMCSS priorities, SystemResponsiveness.** Most games use UDP or don't register with MMCSS.
- **Win32PrioritySeparation and global timer resolution.** The first is the same as the client default, the second doesn't affect the game in focus.
- **SvcHostSplitThresholdInKB.** Only lowers the number of svchost processes shown in Task Manager.
- **Spectre/Meltdown mitigations off.** A security hole for almost no gain on current CPUs.
- **Disable fullscreen optimizations, HPET, dynamic tick.** Windows 11 handles these better than the old tweaks.
- **Clear Prefetch.** Windows rebuilds it and apps start slower until it does.
- **Remove Edge, the Store, Xbox sign-in or Get Help.** Breaks WebView2 apps, app updates, game sign-in and troubleshooters.

## Credits

Tweak research is based on the current state of
[Win11Debloat](https://github.com/Raphire/Win11Debloat),
[WinUtil](https://github.com/ChrisTitusTech/winutil),
[Sophia Script](https://github.com/farag2/Sophia-Script-for-Windows) and
[Atlas OS](https://github.com/Atlas-OS/Atlas), checked against Microsoft's policy documentation.
