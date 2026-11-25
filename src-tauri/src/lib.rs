mod commands;
mod error;
mod state;
mod tray;

use tauri::{Emitter, Manager};

const AUTOSTART_ARG: &str = "--autostart";

fn launched_at_startup() -> bool {
  std::env::args().any(|a| a == AUTOSTART_ARG)
}

/// Turns this process into the Teams Presence Keeper when started as one
/// (never returns then); otherwise does nothing. Call before [`run`].
pub fn run_keeper_if_requested() {
  commands::presence::run_keeper_if_requested();
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
      // The assistant reports to the window; its MCP server starts in the background.
      let handle = app.handle().clone();
      state.assistant.set_sink(std::sync::Arc::new(move |event| {
        let _ = handle.emit("assistant://event", event);
      }));
      // App Tests: lets assistant tools start runs and tell the page what they changed.
      let handle = app.handle().clone();
      singl_core::uitest::runner::set_host(
        state.db_path.parent().map(std::path::PathBuf::from).unwrap_or_default(),
        std::sync::Arc::new(move |event: &str, payload| {
          let _ = handle.emit(event, payload);
        }),
      );
      let (assistant, discovery) =
        (state.assistant.clone(), singl_core::assistant::mcp::discovery_path(&state.db_path));
      tauri::async_runtime::spawn(async move {
        if let Err(e) = assistant.start_mcp(&discovery).await {
          log::warn!("assistant MCP server did not start: {e}");
        }
      });
      // Scheduled automation tasks, checked every 30 seconds while the app runs.
      let (scheduler, handle) = (state.assistant.clone(), app.handle().clone());
      tauri::async_runtime::spawn(singl_core::automation::schedule::run_loop(
        scheduler,
        std::sync::Arc::new(move |title: &str, body: &str| {
          use tauri_plugin_notification::NotificationExt;
          let _ = handle.notification().builder().title(title).body(body).show();
        }),
      ));
      app.manage(state);
      Ok(())
    })
    .on_window_event(tray::on_window_event)
    .invoke_handler(tauri::generate_handler![
      tray::tray_prefs_set,
      commands::db::db_info,
      commands::db::db_import,
      commands::jobs::job_cancel,
      commands::twx_import::twx_import_preview,
      commands::twx_import::twx_import_run,
      commands::twx_import::twx_import_backups,
      commands::twx_import::twx_import_restore,
      commands::twx_import::twx_import_open_backup,
      commands::twx_logs::twx_logs_query,
      commands::compare::compare_tree,
      commands::compare::compare_content,
      commands::compare::compare_search,
      commands::entities::entity_files,
      commands::entities::entity_read,
      commands::entities::entity_write,
      commands::entities::entity_save_as,
      commands::entities::entity_create,
      commands::entities::entity_rename,
      commands::entities::entity_delete,
      commands::entities::entity_search,
      commands::entities::entity_find,
      commands::entities::entity_locate,
      commands::entities::entity_run_times,
      commands::entities::entity_export,
      commands::entities::entity_list_remote,
      commands::entities::entity_reexport,
      commands::deps::deps_summary,
      commands::deps::deps_search,
      commands::deps::deps_graph,
      commands::deps::deps_callers,
      commands::deps::deps_unused,
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
      commands::twx_events::twx_thing_subscriptions,
      commands::twx_events::twx_set_subscription_enabled,
      commands::twx_events::twx_fire_event,
      commands::twx_events::twx_scheduled_things,
      commands::twx_events::twx_set_thing_enabled,
      commands::twx_access::twx_entity_permissions,
      commands::twx_access::twx_check_permission,
      commands::twx_access::twx_list_mashups,
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
      commands::agents::agents_status,
      commands::agents::agents_disabled_set,
      commands::agents::agent_list_models_run,
      commands::agents::agent_model_cache,
      commands::agents::agent_anthropic_models,
      commands::assistant::assistant_send,
      commands::assistant::assistant_cancel,
      commands::assistant::assistant_stop_sub_agent,
      commands::assistant::assistant_steer,
      commands::assistant::assistant_entity_undo,
      commands::assistant::assistant_chat_running,
      commands::assistant::assistant_chats,
      commands::assistant::assistant_chats_search,
      commands::assistant::assistant_chat_get,
      commands::assistant::assistant_chat_rename,
      commands::assistant::assistant_chat_delete,
      commands::assistant::assistant_context_set,
      commands::assistant::assistant_context_get,
      commands::assistant::assistant_suggestions,
      commands::assistant::assistant_ui_reply,
      commands::assistant::assistant_approve,
      commands::assistant::assistant_turn_mode,
      commands::assistant::assistant_running_chats,
      commands::assistant::assistant_settings_get,
      commands::assistant::assistant_settings_set,
      commands::assistant::assistant_providers,
      commands::assistant::assistant_models,
      commands::assistant::assistant_tools,
      commands::assistant::assistant_skills,
      commands::assistant::assistant_files_search,
      commands::assistant::assistant_mcp_info,
      commands::assistant::assistant_mcp_profiles_get,
      commands::assistant::assistant_mcp_profiles_set,
      commands::assistant::assistant_mcp_servers,
      commands::assistant::assistant_mcp_restart,
      commands::assistant::assistant_mcp_sign_in,
      commands::assistant::assistant_mcp_sign_out,
      commands::assistant::assistant_mcp_tools,
      commands::assistant::assistant_mcp_set_disabled_tools,
      commands::assistant::assistant_mcp_resources,
      commands::assistant::assistant_mcp_resource_read,
      commands::assistant::assistant_mcp_prompts,
      commands::assistant::assistant_mcp_prompt_get,
      commands::assistant::assistant_mcp_elicit_reply,
      commands::assistant::assistant_mcp_call_log,
      commands::assistant::assistant_mcp_call_log_clear,
      commands::assistant::assistant_usage_chat,
      commands::assistant::assistant_usage_summary,
      commands::assistant::assistant_memories,
      commands::assistant::assistant_memory_update,
      commands::assistant::assistant_memory_delete,
      commands::assistant::assistant_usage_calls,
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
      commands::twx_admin::twx_server_ping,
      commands::twx_admin::twx_server_health,
      commands::twx_admin::twx_streams_list,
      commands::twx_admin::twx_logged_properties,
      commands::twx_admin::twx_stream_query,
      commands::twx_admin::twx_connectors_list,
      commands::twx_admin::twx_connector_test,
      commands::twx_admin::twx_datatables_list,
      commands::twx_admin::twx_datatable_info,
      commands::twx_admin::twx_datatable_query,
      commands::automation::automation_suites_list,
      commands::automation::automation_suite_save,
      commands::automation::automation_suite_delete,
      commands::automation::automation_suite_run,
      commands::automation::automation_runs_list,
      commands::automation::automation_run_get,
      commands::automation::automation_run_delete,
      commands::automation::automation_drift_run,
      commands::automation::automation_drift_entity_xml,
      commands::automation::automation_schedules_list,
      commands::automation::automation_schedule_save,
      commands::automation::automation_schedule_enable,
      commands::automation::automation_schedule_delete,
      commands::automation::automation_schedule_run,
      commands::uitest::uitest_suites_list,
      commands::uitest::uitest_suite_get,
      commands::uitest::uitest_suite_save,
      commands::uitest::uitest_suite_delete,
      commands::uitest::uitest_cases_save,
      commands::uitest::uitest_import_csv,
      commands::uitest::uitest_export_csv,
      commands::uitest::uitest_chats,
      commands::uitest::uitest_chats_delete,
      commands::uitest::uitest_session_status,
      commands::uitest::uitest_session_login_start,
      commands::uitest::uitest_session_login_finish,
      commands::uitest::uitest_session_login_cancel,
      commands::uitest::uitest_session_check,
      commands::uitest::uitest_session_clear,
      commands::uitest::uitest_run,
      commands::uitest::uitest_run_cancel,
      commands::uitest::uitest_run_active,
      commands::uitest::uitest_report_generate,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        app.state::<state::AppState>().jobs.cancel_all();
        let state = app.state::<state::AppState>();
        state.agents.kill_all();
        state.assistant.stop_mcp(&singl_core::assistant::mcp::discovery_path(&state.db_path));
        tauri::async_runtime::block_on(state.assistant.shutdown());
      }
    });
}
