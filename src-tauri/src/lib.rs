mod commands;
mod error;
mod state;
mod tray;

use tauri::Manager;

const AUTOSTART_ARG: &str = "--autostart";

fn launched_at_startup() -> bool {
  std::env::args().any(|a| a == AUTOSTART_ARG)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      // Launch at sign-in: the Run entry passes --autostart (see the plugin
      // args below), so start minimized to the taskbar instead of popping up.
      #[cfg(desktop)]
      {
        app.handle().plugin(tauri_plugin_autostart::init(
          tauri_plugin_autostart::MacosLauncher::LaunchAgent,
          Some(vec![AUTOSTART_ARG]),
        ))?;
        tray::setup(app.handle())?;
        if launched_at_startup() {
          if let Some(main) = app.get_webview_window("main") {
            let _ = main.minimize();
          }
        }
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // `tauri dev` keeps its database in the project's .data/, apart from the
      // installed app's. Installers built with `--debug` are not dev builds.
      let db_path = if tauri::is_dev() {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.data/singl.db")
      } else {
        app.path().app_data_dir()?.join("singl.db")
      };
      let state = tauri::async_runtime::block_on(state::AppState::load(db_path))?;
      app.manage(state);
      Ok(())
    })
    .on_window_event(tray::on_window_event)
    .invoke_handler(tauri::generate_handler![
      tray::tray_prefs_set,
      commands::db::db_info,
      commands::db::db_import,
      commands::jobs::job_cancel,
      commands::compare::compare_tree,
      commands::compare::compare_content,
      commands::compare::compare_search,
      commands::entities::entity_files,
      commands::entities::entity_read,
      commands::entities::entity_write,
      commands::entities::entity_create,
      commands::entities::entity_rename,
      commands::entities::entity_delete,
      commands::entities::entity_search,
      commands::entities::entity_find,
      commands::entities::entity_locate,
      commands::entities::entity_run_times,
      commands::entities::entity_export,
      commands::repo::repo_get,
      commands::repo::repo_branches,
      commands::repo::repo_clone,
      commands::repo::repo_checkout,
      commands::repo::repo_fetch,
      commands::repo::repo_pull,
      commands::repo::repo_status,
      commands::repo::repo_diff,
      commands::repo::repo_files,
      commands::repo::repo_file_content,
      commands::repo::repo_search,
      commands::repo::repo_clean,
      commands::twx::twx_export,
      commands::twx::twx_export_deployment_files,
      commands::twx::twx_extract_deployment_files,
      commands::twx::twx_backup_deployment_files,
      commands::twx::twx_upload_deployment_files,
      commands::twx::twx_repo_dirs,
      commands::twx::twx_connectors,
      commands::twx::twx_update_connectors,
      commands::twx::twx_cli_bundle,
      commands::twx::twx_cli_extract,
      commands::services::service_search,
      commands::services::service_definitions,
      commands::services::service_execute,
      commands::services::service_presets_list,
      commands::services::service_preset_save,
      commands::services::service_preset_delete,
      commands::flows::flow_list,
      commands::flows::flow_get,
      commands::flows::flow_create,
      commands::flows::flow_rename,
      commands::flows::flow_delete,
      commands::flows::flow_duplicate,
      commands::flows::flow_save,
      commands::flows::flow_move,
      commands::flows::flow_folders_list,
      commands::flows::flow_folder_create,
      commands::flows::flow_folder_rename,
      commands::flows::flow_folder_move,
      commands::flows::flow_folder_delete,
      commands::flows::flow_datashape_fields,
      commands::flows::flow_run,
      commands::settings::settings_get,
      commands::settings::settings_azure_pat_set,
      commands::settings::settings_compare_paths_set,
      commands::settings::settings_bundle_dirs_set,
      commands::settings::environments_list,
      commands::settings::environment_save,
      commands::settings::environment_set_enabled,
      commands::settings::environment_clone,
      commands::settings::environment_delete,
      commands::settings::project_save,
      commands::settings::project_delete,
      commands::workspace::workspace_root_get,
      commands::workspace::workspace_root_set,
      commands::updater::update_dir_set,
      commands::updater::update_check,
      commands::updater::update_install,
      commands::presence::presence_status,
      commands::presence::presence_start,
      commands::presence::presence_stop,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        app.state::<state::AppState>().jobs.cancel_all();
      }
    });
}
