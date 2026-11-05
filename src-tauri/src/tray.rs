//! System tray: "minimize to tray" for the main window and the clock widget.
//!
//! The switches live in the frontend's localStorage (Settings → App
//! Preferences); the main window pushes them here with `tray_prefs_set` on
//! start and on every change. The tray icon only shows while one is on.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, Window, WindowEvent};

const TRAY_ID: &str = "singl-tray";
pub const MAIN_LABEL: &str = "main";
pub const WIDGET_LABEL: &str = "clock-widget";
/// Asks the main window's JS to open the clock widget (it owns its creation).
const OPEN_WIDGET_EVENT: &str = "tray://open-clock-widget";

#[derive(Default)]
pub struct TrayPrefs {
  main: AtomicBool,
  widget: AtomicBool,
}

impl TrayPrefs {
  fn applies_to(&self, label: &str) -> bool {
    match label {
      MAIN_LABEL => self.main.load(Ordering::Relaxed),
      WIDGET_LABEL => self.widget.load(Ordering::Relaxed),
      _ => false,
    }
  }

  fn any(&self) -> bool {
    self.main.load(Ordering::Relaxed) || self.widget.load(Ordering::Relaxed)
  }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
  app.manage(TrayPrefs::default());

  let show_main = MenuItem::with_id(app, "show-main", "Show singl", true, None::<&str>)?;
  let show_widget = MenuItem::with_id(app, "show-widget", "Show Clock Widget", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Quit singl", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show_main, &show_widget, &PredefinedMenuItem::separator(app)?, &quit])?;

  let mut builder = TrayIconBuilder::with_id(TRAY_ID)
    .tooltip("singl")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show-main" => restore(app, MAIN_LABEL),
      "show-widget" => {
        if app.get_webview_window(WIDGET_LABEL).is_some() {
          restore(app, WIDGET_LABEL)
        } else {
          let _ = app.emit_to(MAIN_LABEL, OPEN_WIDGET_EVENT, ());
        }
      }
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        restore(tray.app_handle(), MAIN_LABEL);
      }
    });
  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }
  let tray: TrayIcon<R> = builder.build(app)?;
  tray.set_visible(false)?;
  Ok(())
}

/// Hides a window that was just minimized, when its switch is on, so it leaves
/// the taskbar and lives in the tray instead.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
  if !matches!(event, WindowEvent::Resized(_)) {
    return;
  }
  let prefs = window.state::<TrayPrefs>();
  if prefs.applies_to(window.label()) && window.is_minimized().unwrap_or(false) {
    let _ = window.hide();
  }
}

fn restore<R: Runtime>(app: &AppHandle<R>, label: &str) {
  if let Some(win) = app.get_webview_window(label) {
    show(&win);
  }
}

fn show<R: Runtime>(win: &WebviewWindow<R>) {
  let _ = win.show();
  let _ = win.unminimize();
  let _ = win.set_focus();
}

/// Saves the switches. A window already sitting minimized (e.g. singl was
/// launched at sign-in) goes to the tray straight away.
#[tauri::command]
pub fn tray_prefs_set<R: Runtime>(app: AppHandle<R>, main: bool, widget: bool) -> Result<(), String> {
  let prefs = app.state::<TrayPrefs>();
  prefs.main.store(main, Ordering::Relaxed);
  prefs.widget.store(widget, Ordering::Relaxed);

  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    tray.set_visible(prefs.any()).map_err(|e| e.to_string())?;
  }
  for label in [MAIN_LABEL, WIDGET_LABEL] {
    if let Some(win) = app.get_webview_window(label) {
      if prefs.applies_to(label) {
        if win.is_minimized().unwrap_or(false) {
          let _ = win.hide();
        }
      } else if !win.is_visible().unwrap_or(true) && win.is_minimized().unwrap_or(false) {
        // Switch turned off while the window was in the tray: bring it back
        // to the taskbar (still minimized) so it isn't stranded.
        let _ = win.show();
        let _ = win.minimize();
      }
    }
  }
  Ok(())
}
