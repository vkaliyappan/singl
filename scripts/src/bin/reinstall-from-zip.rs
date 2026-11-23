//! With no arguments, runs the Windows FSCapture112 reinstall from
//! singl-web's `reinstall-fscapture.bat`, including the registry cleanup.
//! Pass paths to reinstall a different portable app from its zip.
//!
//!   reinstall-from-zip --target <folder> --zip <file.zip> [--dest <folder>]
//!
//! --dest is where the zip is extracted (default: the target's parent folder,
//! for zips whose top-level folder is the target, as `Expand-Archive` did).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use singl_scripts::fail;

const USAGE: &str = "Usage: reinstall-from-zip [--target <folder> --zip <file.zip> [--dest <folder>]]";

fn main() {
  let mut target = None;
  let mut zip = None;
  let mut dest = None;
  let mut it = std::env::args().skip(1).peekable();
  if it.peek().is_none() {
    if !cfg!(windows) {
      fail(1, "ERROR: the FSCapture112 reinstall requires Windows.");
    }
    println!("=== Reinstall FSCapture112 ===");
    if let Err(e) = reinstall_fscapture(
      Path::new(r"C:\MyFiles\Soft\FSCapture112"),
      Path::new(r"C:\MyFiles\Soft\FSCapture112.zip"),
      Path::new(r"C:\MyFiles\Soft"),
      r"HKCU\Software\8322898",
    ) {
      fail(1, format!("ERROR: {e}"));
    }
    println!("=== Done ===");
    return;
  }
  while let Some(arg) = it.next() {
    let value = it.next().map(PathBuf::from).unwrap_or_else(|| fail(64, USAGE));
    match arg.as_str() {
      "--target" => target = Some(value),
      "--zip" => zip = Some(value),
      "--dest" => dest = Some(value),
      _ => fail(64, USAGE),
    }
  }
  let (Some(target), Some(zip)) = (target, zip) else { fail(64, USAGE) };
  let dest = dest.or_else(|| target.parent().map(Path::to_path_buf)).unwrap_or_else(|| fail(64, "--target has no parent folder; pass --dest."));

  println!("=== Reinstall {} ===", target.display());
  if let Err(e) = reinstall(&target, &zip, &dest) {
    fail(1, format!("ERROR: {e}"));
  }
  println!("=== Done ===");
}

fn reinstall(target: &Path, zip: &Path, dest: &Path) -> Result<(), String> {
  // Check the zip before deleting anything, so a typo can't leave nothing installed.
  if !zip.is_file() {
    return Err(format!("zip not found \"{}\"", zip.display()));
  }

  println!("[1/2] Deleting folder: {}", target.display());
  delete_target(target)?;

  println!("[2/2] Extracting: {} -> {}", zip.display(), dest.display());
  extract(zip, dest)
}

fn reinstall_fscapture(target: &Path, zip: &Path, dest: &Path, reg_key: &str) -> Result<(), String> {
  println!("[1/3] Deleting folder: {}", target.display());
  delete_target(target)?;

  println!("[2/3] Extracting: {}", zip.display());
  if !zip.is_file() {
    return Err(format!("zip not found \"{}\"", zip.display()));
  }
  let status = Command::new("powershell.exe")
    .args([
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $env:SINGL_REINSTALL_ZIP -DestinationPath $env:SINGL_REINSTALL_DEST -Force -ErrorAction Stop",
    ])
    .env("SINGL_REINSTALL_ZIP", zip)
    .env("SINGL_REINSTALL_DEST", dest)
    .status()
    .map_err(|e| format!("extraction failed: {e}"))?;
  if !status.success() {
    return Err("extraction failed".into());
  }

  println!("[3/3] Removing registry key: {reg_key}");
  let status = Command::new("reg.exe")
    .args(["query", reg_key])
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map_err(|e| format!("failed to query registry key: {e}"))?;
  if status.success() {
    let status = Command::new("reg.exe")
      .args(["delete", reg_key, "/f"])
      .status()
      .map_err(|e| format!("failed to delete registry key: {e}"))?;
    if !status.success() {
      return Err("failed to delete registry key".into());
    }
  } else {
    println!("  key not present, skipping");
  }
  Ok(())
}

fn delete_target(target: &Path) -> Result<(), String> {
  if target.exists() {
    std::fs::remove_dir_all(target).map_err(|e| format!("failed to delete \"{}\": {e}", target.display()))?;
  } else {
    println!("  folder not present, skipping");
  }
  Ok(())
}

fn extract(zip: &Path, dest: &Path) -> Result<(), String> {
  std::fs::create_dir_all(dest).map_err(|e| format!("cannot create \"{}\": {e}", dest.display()))?;
  let file = std::fs::File::open(zip).map_err(|e| format!("cannot open zip: {e}"))?;
  let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a valid zip: {e}"))?;
  // `extract` rejects entries that would escape `dest` (zip-slip) and overwrites files.
  archive.extract(dest).map_err(|e| format!("extraction failed: {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  #[test]
  fn replaces_folder_with_zip_contents() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("App");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("stale.txt"), "old").unwrap();

    let zip_path = tmp.path().join("App.zip");
    let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
    w.start_file("App/app.exe", zip::write::SimpleFileOptions::default()).unwrap();
    w.write_all(b"binary").unwrap();
    w.finish().unwrap();

    reinstall(&target, &zip_path, tmp.path()).unwrap();
    assert!(!target.join("stale.txt").exists());
    assert_eq!(std::fs::read(target.join("app.exe")).unwrap(), b"binary");
  }

  #[test]
  fn keeps_folder_when_zip_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("App");
    std::fs::create_dir_all(&target).unwrap();
    assert!(reinstall(&target, &tmp.path().join("missing.zip"), tmp.path()).is_err());
    assert!(target.exists());
  }

  #[cfg(windows)]
  #[test]
  fn fscapture_deletes_before_checking_zip_and_cleans_registry_after_extraction() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("App");
    let zip_path = tmp.path().join("App.zip");
    let reg_key = format!(
      r"HKCU\Software\singl-scripts-reinstall-test-{}",
      tmp.path().file_name().unwrap().to_string_lossy()
    );
    std::fs::create_dir(&target).unwrap();

    let missing_zip = reinstall_fscapture(&target, &zip_path, tmp.path(), &reg_key);
    assert!(missing_zip.unwrap_err().starts_with("zip not found"));
    assert!(!target.exists());

    let mut writer = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
    writer.start_file("App/app.exe", zip::write::SimpleFileOptions::default()).unwrap();
    writer.write_all(b"binary").unwrap();
    writer.finish().unwrap();
    let added = Command::new("reg.exe").args(["add", &reg_key, "/f"]).output().unwrap();
    assert!(added.status.success(), "{added:?}");

    let result = reinstall_fscapture(&target, &zip_path, tmp.path(), &reg_key);
    let key_still_exists = Command::new("reg.exe").args(["query", &reg_key]).output().unwrap().status.success();
    if key_still_exists {
      let _ = Command::new("reg.exe").args(["delete", &reg_key, "/f"]).output();
    }

    result.unwrap();
    assert!(!key_still_exists);
    assert_eq!(std::fs::read(target.join("app.exe")).unwrap(), b"binary");
  }
}
