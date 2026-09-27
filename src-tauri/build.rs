fn main() {
    // Embed a manifest that asks for admin rights: most tweaks write to HKLM or change services.
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri build script");
}
