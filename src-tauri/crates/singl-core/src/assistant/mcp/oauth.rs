//! OAuth sign-in for HTTP MCP servers (MCP authorization spec): discovery from
//! the server's 401, a client id (given, remembered, or dynamically
//! registered), the browser login with PKCE, a loopback redirect, and refresh.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::now;
use crate::{CoreError, Result};

/// Fixed so a client can be registered in advance with this redirect URL.
pub const REDIRECT_PORT: u16 = 47822;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// Prefix of the error the Settings page answers by asking for a client id.
pub const NEEDS_CLIENT_ID: &str = "NEEDS_CLIENT_ID";

pub fn redirect_uri() -> String {
  format!("http://127.0.0.1:{REDIRECT_PORT}/callback")
}

/// One server's sign-in, keyed by its URL in the settings. Never sent to the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OAuthToken {
  pub access_token: String,
  pub refresh_token: String,
  /// Unix seconds; 0 when the server did not say.
  pub expires_at: i64,
  pub token_endpoint: String,
  pub client_id: String,
  pub client_secret: String,
}

impl OAuthToken {
  pub fn signed_in(&self) -> bool {
    !self.access_token.is_empty()
  }

  pub fn expiring(&self) -> bool {
    self.expires_at > 0 && now() >= self.expires_at - 60
  }
}

fn invalid(msg: impl Into<String>) -> CoreError {
  CoreError::Invalid(msg.into())
}

fn http() -> Result<reqwest::Client> {
  reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|e| invalid(e.to_string()))
}

/// `a=1&b=2`, form-urlencoded.
fn form(pairs: &[(&str, &str)]) -> String {
  let mut u = Url::parse("http://x/").expect("static url");
  u.query_pairs_mut().extend_pairs(pairs.iter().filter(|(_, v)| !v.is_empty()));
  u.query().unwrap_or_default().to_string()
}

async fn get_json(client: &reqwest::Client, url: &str) -> Option<Value> {
  let resp = client.get(url).header("Accept", "application/json").send().await.ok()?;
  if !resp.status().is_success() {
    return None;
  }
  resp.json::<Value>().await.ok()
}

/// `https://h/a/b` + `.well-known/x` → `https://h/.well-known/x/a/b` and `https://h/.well-known/x`.
fn well_known(base: &Url, name: &str, path_after: bool) -> Vec<String> {
  let origin = base.origin().ascii_serialization();
  let path = base.path().trim_end_matches('/');
  let mut out = Vec::new();
  if !path.is_empty() {
    out.push(format!("{origin}/.well-known/{name}{path}"));
    if path_after {
      out.push(format!("{origin}{path}/.well-known/{name}"));
    }
  }
  out.push(format!("{origin}/.well-known/{name}"));
  out
}

/// `key="value"` out of a `WWW-Authenticate` header.
fn auth_param(header: &str, key: &str) -> Option<String> {
  let at = header.find(&format!("{key}="))? + key.len() + 1;
  let rest = &header[at..];
  Some(match rest.strip_prefix('"') {
    Some(q) => q.split('"').next()?.to_string(),
    None => rest.split([',', ' ']).next()?.to_string(),
  })
}

struct Discovered {
  authorization_endpoint: String,
  token_endpoint: String,
  registration_endpoint: Option<String>,
  scope: String,
}

async fn discover(client: &reqwest::Client, server_url: &str) -> Result<Discovered> {
  let server = Url::parse(server_url).map_err(|e| invalid(format!("Bad server URL: {e}")))?;
  // The 401 names the resource metadata and, often, the scope.
  let probe = client
    .post(server_url)
    .header("Accept", "application/json, text/event-stream")
    .header("Content-Type", "application/json")
    .body(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "singl", "version": "1"}}}).to_string())
    .send()
    .await
    .ok();
  let challenge =
    probe.as_ref().and_then(|r| r.headers().get("www-authenticate")).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
  let mut resource_urls: Vec<String> = auth_param(&challenge, "resource_metadata").into_iter().collect();
  resource_urls.extend(well_known(&server, "oauth-protected-resource", false));

  let mut resource = None;
  for u in resource_urls {
    if let Some(v) = get_json(client, &u).await {
      resource = Some(v);
      break;
    }
  }
  let issuer = resource
    .as_ref()
    .and_then(|r| r["authorization_servers"].get(0))
    .and_then(Value::as_str)
    .map(String::from)
    .unwrap_or_else(|| server.origin().ascii_serialization());
  let issuer_url = Url::parse(&issuer).map_err(|e| invalid(format!("Bad authorization server: {e}")))?;
  let mut meta = None;
  for name in ["oauth-authorization-server", "openid-configuration"] {
    for u in well_known(&issuer_url, name, true) {
      if let Some(v) = get_json(client, &u).await.filter(|v| v["authorization_endpoint"].is_string()) {
        meta = Some(v);
        break;
      }
    }
    if meta.is_some() {
      break;
    }
  }
  let meta = meta.ok_or_else(|| invalid(format!("{server_url} does not publish OAuth sign-in details.")))?;
  let text = |k: &str| meta[k].as_str().map(String::from);
  let supported = |k: &str| -> Vec<String> {
    meta[k].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
  };

  // The challenge's scope may be the minimum (read); ask for every scope the resource offers.
  let mut scopes: Vec<String> = auth_param(&challenge, "scope").map(|s| s.split_whitespace().map(String::from).collect()).unwrap_or_default();
  let offered = resource.as_ref().and_then(|r| r["scopes_supported"].as_array()).cloned().unwrap_or_default();
  for s in offered.iter().filter_map(Value::as_str) {
    if !scopes.iter().any(|x| x == s) {
      scopes.push(s.to_string());
    }
  }
  // Ask for a refresh token where the server offers one.
  if supported("scopes_supported").iter().any(|s| s == "offline_access") && !scopes.iter().any(|s| s == "offline_access") {
    scopes.push("offline_access".into());
  }
  Ok(Discovered {
    authorization_endpoint: text("authorization_endpoint").unwrap_or_default(),
    token_endpoint: text("token_endpoint").ok_or_else(|| invalid("The authorization server has no token endpoint."))?,
    registration_endpoint: text("registration_endpoint"),
    scope: scopes.join(" "),
  })
}

async fn register(client: &reqwest::Client, endpoint: &str) -> Result<(String, String)> {
  let body = json!({
    "client_name": "singl",
    "redirect_uris": [redirect_uri()],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none",
  });
  let resp = client.post(endpoint).json(&body).send().await.map_err(|e| invalid(format!("Client registration failed: {e}")))?;
  if !resp.status().is_success() {
    let status = resp.status();
    return Err(invalid(format!("Client registration failed: HTTP {status}: {}", resp.text().await.unwrap_or_default())));
  }
  let v: Value = resp.json().await.map_err(|e| invalid(e.to_string()))?;
  let id = v["client_id"].as_str().ok_or_else(|| invalid("Client registration returned no client_id."))?;
  Ok((id.to_string(), v["client_secret"].as_str().unwrap_or_default().to_string()))
}

fn random() -> String {
  format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn open_browser(url: &str) -> Result<()> {
  #[cfg(windows)]
  let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
  #[cfg(target_os = "macos")]
  let r = std::process::Command::new("open").arg(url).spawn();
  #[cfg(all(unix, not(target_os = "macos")))]
  let r = std::process::Command::new("xdg-open").arg(url).spawn();
  r.map(|_| ()).map_err(|e| invalid(format!("Could not open the browser: {e}")))
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>singl</title><body style=\"font-family:system-ui;padding:3rem\">";

/// Waits for the browser to come back to the loopback redirect; returns the code.
async fn wait_for_code(listener: tokio::net::TcpListener, state: &str) -> Result<String> {
  loop {
    let (mut sock, _) = listener.accept().await.map_err(|e| invalid(e.to_string()))?;
    let mut buf = vec![0u8; 8192];
    let n = sock.read(&mut buf).await.unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or_default().to_string();
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else { continue };
    if url.path() != "/callback" {
      let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
      continue;
    }
    let q = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    let (result, message) = match (q("code"), q("error")) {
      _ if q("state").as_deref() != Some(state) => (Err(invalid("Sign-in answer did not match the request.")), "Sign-in failed: state mismatch."),
      (Some(code), _) => (Ok(code), "Signed in. You can close this tab and return to singl."),
      (None, err) => {
        let detail = q("error_description").or(err).unwrap_or_else(|| "no code returned".into());
        (Err(invalid(format!("Sign-in was refused: {detail}"))), "Sign-in failed. Return to singl for details.")
      }
    };
    let body = format!("{PAGE}<p>{message}</p>");
    let _ = sock
      .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
      .await;
    return result;
  }
}

async fn token_request(client: &reqwest::Client, endpoint: &str, pairs: &[(&str, &str)]) -> Result<Value> {
  let resp = client
    .post(endpoint)
    .header("Content-Type", "application/x-www-form-urlencoded")
    .header("Accept", "application/json")
    .body(form(pairs))
    .send()
    .await
    .map_err(|e| invalid(format!("Token request failed: {e}")))?;
  let status = resp.status();
  let text = resp.text().await.unwrap_or_default();
  if !status.is_success() {
    return Err(invalid(format!("Token request failed: HTTP {status}: {}", text.trim())));
  }
  serde_json::from_str(&text).map_err(|e| invalid(format!("Bad token reply: {e}")))
}

fn token_from(v: &Value, base: &OAuthToken) -> Result<OAuthToken> {
  let access = v["access_token"].as_str().ok_or_else(|| invalid("The token reply had no access_token."))?;
  Ok(OAuthToken {
    access_token: access.to_string(),
    // A refresh reply may leave the old refresh token in force.
    refresh_token: v["refresh_token"].as_str().map(String::from).unwrap_or_else(|| base.refresh_token.clone()),
    expires_at: v["expires_in"].as_i64().map(|s| now() + s).unwrap_or(0),
    ..base.clone()
  })
}

/// The whole browser sign-in. `known` keeps a client id from an earlier sign-in.
pub async fn sign_in(
  server_url: &str,
  client_id: Option<String>,
  client_secret: Option<String>,
  known: Option<&OAuthToken>,
) -> Result<OAuthToken> {
  let client = http()?;
  let d = discover(&client, server_url).await?;
  let given = client_id.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
  let (client_id, client_secret) = match (given, known.filter(|k| !k.client_id.is_empty())) {
    (Some(id), _) => (id, client_secret.map(|s| s.trim().to_string()).unwrap_or_default()),
    (None, Some(k)) => (k.client_id.clone(), k.client_secret.clone()),
    (None, None) => match &d.registration_endpoint {
      Some(ep) => register(&client, ep).await?,
      None => {
        return Err(invalid(format!(
          "{NEEDS_CLIENT_ID}: This server does not let apps register themselves. Register a client for singl with redirect URL {} and enter its client ID.",
          redirect_uri()
        )));
      }
    },
  };

  let listener = tokio::net::TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
    .await
    .map_err(|e| invalid(format!("Could not listen on port {REDIRECT_PORT} for the sign-in (another sign-in running?): {e}")))?;
  let verifier = random();
  let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
  let state = random();
  let redirect = redirect_uri();
  let mut auth = Url::parse(&d.authorization_endpoint).map_err(|e| invalid(format!("Bad authorization endpoint: {e}")))?;
  auth.query_pairs_mut().extend_pairs(
    [
      ("response_type", "code"),
      ("client_id", client_id.as_str()),
      ("redirect_uri", redirect.as_str()),
      ("code_challenge", challenge.as_str()),
      ("code_challenge_method", "S256"),
      ("state", state.as_str()),
      ("scope", d.scope.as_str()),
      ("resource", server_url),
    ]
    .into_iter()
    .filter(|(_, v)| !v.is_empty()),
  );
  open_browser(auth.as_str())?;
  let code = tokio::time::timeout(LOGIN_TIMEOUT, wait_for_code(listener, &state))
    .await
    .map_err(|_| invalid("Sign-in timed out after 5 minutes."))??;

  let v = token_request(
    &client,
    &d.token_endpoint,
    &[
      ("grant_type", "authorization_code"),
      ("code", &code),
      ("redirect_uri", &redirect),
      ("client_id", &client_id),
      ("client_secret", &client_secret),
      ("code_verifier", &verifier),
      ("resource", server_url),
    ],
  )
  .await?;
  token_from(&v, &OAuthToken { token_endpoint: d.token_endpoint, client_id, client_secret, ..Default::default() })
}

/// A fresh access token from the refresh token.
pub async fn refresh(server_url: &str, t: &OAuthToken) -> Result<OAuthToken> {
  if t.refresh_token.is_empty() || t.token_endpoint.is_empty() {
    return Err(invalid("No refresh token; sign in again."));
  }
  let v = token_request(
    &http()?,
    &t.token_endpoint,
    &[
      ("grant_type", "refresh_token"),
      ("refresh_token", &t.refresh_token),
      ("client_id", &t.client_id),
      ("client_secret", &t.client_secret),
      ("resource", server_url),
    ],
  )
  .await?;
  token_from(&v, t)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_www_authenticate_params() {
    let h = r#"Bearer resource_metadata="https://h/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read""#;
    assert_eq!(auth_param(h, "resource_metadata").unwrap(), "https://h/.well-known/oauth-protected-resource/api/mcp");
    assert_eq!(auth_param(h, "scope").unwrap(), "mcp:read");
    assert!(auth_param("Bearer", "scope").is_none());
  }

  #[test]
  fn well_known_urls() {
    let u = Url::parse("https://h/api/auth").unwrap();
    assert_eq!(
      well_known(&u, "oauth-authorization-server", true),
      vec![
        "https://h/.well-known/oauth-authorization-server/api/auth",
        "https://h/api/auth/.well-known/oauth-authorization-server",
        "https://h/.well-known/oauth-authorization-server",
      ]
    );
  }

  #[test]
  fn form_encodes_and_skips_empty() {
    assert_eq!(form(&[("a", "x y&z"), ("b", "")]), "a=x+y%26z");
  }
}
