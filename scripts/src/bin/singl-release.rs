//! Builds the NSIS installer and publishes it to the update folder that
//! Settings → Updates points at (see src-tauri/src/commands/updater.rs).
//! Port of `scripts/release.mjs`.
//!
//!   pnpm release --bump bugfix --notes "What changed" [--debug] [--dir "<folder>"] [--skip-build]
//!
//! Versions are major.minor.bugfix. --bump major|minor|bugfix raises the version in
//! src-tauri/tauri.conf.json (and package.json) before building: major resets minor and
//! bugfix, minor resets bugfix. --version x.y.z sets it outright. With neither, the current
//! version is built as is. Installed apps only update to a higher version.
//! --dir falls back to SINGL_UPDATE_DIR, then releases/ in the project.
//! --debug: Smart App Control blocks the fresh build scripts a release build needs;
//! a debug build reuses the ones `tauri dev` already ran.

use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{Value, json};
use singl_scripts::{fail, iso_now, pnpm, project_root};

#[derive(Default)]
struct Opts {
  dir: Option<String>,
  bump: Option<String>,
  version: Option<String>,
  notes: String,
  skip_build: bool,
  debug: bool,
}

fn parse_opts() -> Opts {
  let mut o = Opts::default();
  let mut it = std::env::args().skip(1);
  while let Some(arg) = it.next() {
    let (key, inline) = match arg.split_once('=') {
      Some((k, v)) if k.starts_with("--") => (k.to_string(), Some(v.to_string())),
      _ => (arg.clone(), None),
    };
    let mut value = |name: &str| inline.clone().or_else(|| it.next()).unwrap_or_else(|| fail(1, format!("{name} needs a value.")));
    match key.as_str() {
      "--dir" => o.dir = Some(value("--dir")),
      "--bump" => o.bump = Some(value("--bump")),
      "--version" => o.version = Some(value("--version")),
      "--notes" => o.notes = value("--notes"),
      "--skip-build" => o.skip_build = true,
      "--debug" => o.debug = true,
      // pnpm forwards a literal `--` when called as `pnpm release -- ...`.
      "--" => {}
      _ => fail(1, format!("Unknown option \"{arg}\".")),
    }
  }
  o
}

type Semver = (u64, u64, u64);

fn parse_semver(v: &str) -> Option<Semver> {
  let mut parts = v.split('.');
  let mut num = || parts.next().filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).and_then(|p| p.parse().ok());
  let out = (num()?, num()?, num()?);
  parts.next().is_none().then_some(out)
}

/// The version to release, or `None` to build the current one as is.
fn next_version(current: &str, bump: Option<&str>, version: Option<&str>) -> Result<Option<String>, String> {
  if bump.is_none() && version.is_none() {
    return Ok(None);
  }
  if bump.is_some() && version.is_some() {
    return Err("Pass --bump or --version, not both.".into());
  }
  let (major, minor, bugfix) = parse_semver(current).ok_or_else(|| format!("Current version \"{current}\" is not major.minor.bugfix."))?;
  let next = match (version, bump) {
    (Some(v), _) => {
      parse_semver(v).ok_or_else(|| format!("--version must be major.minor.bugfix, got \"{v}\"."))?;
      v.to_string()
    }
    (None, Some("major")) => format!("{}.0.0", major + 1),
    (None, Some("minor")) => format!("{major}.{}.0", minor + 1),
    (None, Some("bugfix" | "patch")) => format!("{major}.{minor}.{}", bugfix + 1),
    (None, Some(other)) => return Err(format!("--bump must be major, minor or bugfix, got \"{other}\".")),
    (None, None) => unreachable!(),
  };
  if parse_semver(&next).expect("validated") <= (major, minor, bugfix) {
    return Err(format!("{next} is not higher than {current}; installed apps would not update."));
  }
  Ok(Some(next))
}

/// Swaps only the first `"version"` value (the top-level one in both files),
/// so the file keeps its formatting.
fn set_version_text(text: &str, to: &str) -> Option<String> {
  let re = Regex::new(r#"("version"\s*:\s*)"[^"]*""#).expect("valid regex");
  re.is_match(text).then(|| re.replacen(text, 1, format!("${{1}}\"{to}\"")).into_owned())
}

fn set_version(file: &Path, to: &str) {
  let text = std::fs::read_to_string(file).unwrap_or_else(|e| fail(1, format!("Cannot read {}: {e}", file.display())));
  let updated = set_version_text(&text, to).unwrap_or_else(|| fail(1, format!("No \"version\" field to update in {}.", file.display())));
  std::fs::write(file, updated).unwrap_or_else(|e| fail(1, format!("Cannot write {}: {e}", file.display())));
}

fn main() {
  let opts = parse_opts();
  let root = project_root().unwrap_or_else(|| fail(1, "Run from inside the singl checkout (no src-tauri/tauri.conf.json found)."));

  // Defaults to releases/ in the project; point Settings → Updates at the same folder.
  let dir = opts
    .dir
    .clone()
    .or_else(|| std::env::var("SINGL_UPDATE_DIR").ok().filter(|s| !s.trim().is_empty()))
    .map(PathBuf::from)
    .map(|d| if d.is_absolute() { d } else { std::env::current_dir().unwrap_or_default().join(d) })
    .unwrap_or_else(|| root.join("releases"));
  std::fs::create_dir_all(&dir).unwrap_or_else(|e| fail(1, format!("Cannot create {}: {e}", dir.display())));

  let conf_path = root.join("src-tauri").join("tauri.conf.json");
  let conf: Value = std::fs::read_to_string(&conf_path)
    .ok()
    .and_then(|t| serde_json::from_str(&t).ok())
    .unwrap_or_else(|| fail(1, format!("Cannot read {}.", conf_path.display())));
  let product_name = conf["productName"].as_str().unwrap_or_else(|| fail(1, "tauri.conf.json has no productName.")).to_string();
  let mut version = conf["version"].as_str().unwrap_or_else(|| fail(1, "tauri.conf.json has no version.")).to_string();

  match next_version(&version, opts.bump.as_deref(), opts.version.as_deref()) {
    Err(msg) => fail(1, msg),
    Ok(None) => {}
    Ok(Some(next)) => {
      set_version(&conf_path, &next);
      set_version(&root.join("package.json"), &next);
      println!("Version {version} -> {next}");
      version = next;
    }
  }

  if !opts.skip_build {
    let mut args = vec!["tauri", "build", "--bundles", "nsis"];
    if opts.debug {
      args.push("--debug");
    }
    let status = pnpm(&args).current_dir(&root).status().unwrap_or_else(|e| fail(1, format!("Cannot run pnpm: {e}")));
    if !status.success() {
      std::process::exit(status.code().unwrap_or(1));
    }
  }

  let installer = format!("{product_name}_{version}_x64-setup.exe");
  let profile = if opts.debug { "debug" } else { "release" };
  let built = root.join("src-tauri").join("target").join(profile).join("bundle").join("nsis").join(&installer);
  if !built.is_file() {
    fail(1, format!("Installer not found: {}", built.display()));
  }

  // Installer first, manifest last, so a client never sees a version whose file is missing.
  std::fs::copy(&built, dir.join(&installer)).unwrap_or_else(|e| fail(1, format!("Cannot copy the installer: {e}")));
  let manifest = json!({ "version": version, "installer": installer, "notes": opts.notes, "publishedAt": iso_now() });
  let text = serde_json::to_string_pretty(&manifest).expect("manifest serializes") + "\n";
  std::fs::write(dir.join("latest.json"), text).unwrap_or_else(|e| fail(1, format!("Cannot write latest.json: {e}")));

  println!("Published {product_name} {version} to {}", dir.display());
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bumps_versions() {
    assert_eq!(next_version("1.2.3", None, None), Ok(None));
    assert_eq!(next_version("1.2.3", Some("major"), None), Ok(Some("2.0.0".into())));
    assert_eq!(next_version("1.2.3", Some("minor"), None), Ok(Some("1.3.0".into())));
    assert_eq!(next_version("1.2.3", Some("bugfix"), None), Ok(Some("1.2.4".into())));
    assert_eq!(next_version("1.2.3", Some("patch"), None), Ok(Some("1.2.4".into())));
    assert_eq!(next_version("1.2.3", None, Some("1.10.0")), Ok(Some("1.10.0".into())));
  }

  #[test]
  fn rejects_bad_versions() {
    assert!(next_version("1.2.3", Some("minor"), Some("2.0.0")).is_err());
    assert!(next_version("1.2.3", Some("huge"), None).is_err());
    assert!(next_version("1.2.3", None, Some("1.2.3")).is_err());
    assert!(next_version("1.2.3", None, Some("1.1.9")).is_err());
    assert!(next_version("1.2.3", None, Some("1.2")).is_err());
    assert!(next_version("1.2", Some("bugfix"), None).is_err());
  }

  #[test]
  fn swaps_first_version_only() {
    let text = "{\n  \"name\": \"x\",\n  \"version\" : \"0.1.7\",\n  \"deps\": { \"version\": \"9.9.9\" }\n}\n";
    let out = set_version_text(text, "0.1.8").unwrap();
    assert_eq!(out, "{\n  \"name\": \"x\",\n  \"version\" : \"0.1.8\",\n  \"deps\": { \"version\": \"9.9.9\" }\n}\n");
    assert!(set_version_text("{}", "1.0.0").is_none());
  }
}
