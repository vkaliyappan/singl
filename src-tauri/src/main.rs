// Prevents additional console window on Windows, DO NOT REMOVE!! Applied in
// debug too: installers are built with `tauri build --debug` while Smart App
// Control blocks release builds. `tauri dev` still shows logs, since the CLI
// pipes the app's output.
#![windows_subsystem = "windows"]

fn main() {
  app_lib::run();
}
