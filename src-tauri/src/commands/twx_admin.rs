//! Server health, connectors, Stream and DataTable queries for the ThingWorx server page.
//! Read-only, except that `twx_connector_test` runs a connector's own ValidateConnection when asked.

use singl_core::twx::admin::{
  self, ConnectorInfo, ConnectorTest, DataTableInfo, DataTableQuery, LoggedProperty, Ping, QueryResult, ServerHealth, StreamInfo, StreamList,
  StreamQuery,
};
use singl_core::twx::projects;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

/// Whether the server answers, how fast, and its version and memory.
#[tauri::command]
pub async fn twx_server_ping(state: State<'_, AppState>, env: String) -> IpcResult<Ping> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::ping(&client).await)
}

#[tauri::command]
pub async fn twx_server_health(state: State<'_, AppState>, env: String) -> IpcResult<ServerHealth> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::health(&client).await)
}

#[tauri::command]
pub async fn twx_streams_list(state: State<'_, AppState>, env: String) -> IpcResult<StreamList> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::list_streams(&client).await?)
}

#[tauri::command]
pub async fn twx_logged_properties(state: State<'_, AppState>, env: String, thing: String) -> IpcResult<Vec<LoggedProperty>> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::logged_properties(&client, &thing).await?)
}

#[tauri::command]
pub async fn twx_stream_query(state: State<'_, AppState>, env: String, query: StreamQuery) -> IpcResult<QueryResult> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::query_stream(&client, &query).await?)
}

/// Integration connectors with their endpoints. Loaded apart from the health call.
#[tauri::command]
pub async fn twx_connectors_list(state: State<'_, AppState>, env: String) -> IpcResult<Vec<ConnectorInfo>> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::list_connectors(&client).await?)
}

/// Runs the connector's ValidateConnection. Only on a click: whether it is free of side effects is not documented.
#[tauri::command]
pub async fn twx_connector_test(state: State<'_, AppState>, env: String, thing: String) -> IpcResult<ConnectorTest> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::test_connector(&client, &thing).await)
}

#[tauri::command]
pub async fn twx_datatables_list(state: State<'_, AppState>, env: String) -> IpcResult<Vec<StreamInfo>> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::list_datatables(&client).await?)
}

#[tauri::command]
pub async fn twx_datatable_info(state: State<'_, AppState>, env: String, table: String) -> IpcResult<DataTableInfo> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::datatable_info(&client, &table).await?)
}

#[tauri::command]
pub async fn twx_datatable_query(state: State<'_, AppState>, env: String, query: DataTableQuery) -> IpcResult<QueryResult> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(admin::query_datatable(&client, &query).await?)
}
