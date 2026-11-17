//! Skills: `SKILL.md` folders the user can pick for a turn. Their
//! instructions go into that turn's system prompt, so every provider gets
//! them, not only Claude Code.
//!
//! Looked up in `~/.claude/skills/<name>/SKILL.md` (user) and
//! `<workspace>/.claude/skills/<name>/SKILL.md` (project). A skill's id is the
//! path of its `SKILL.md`; only ids from [`list`] are ever read.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{CoreError, Result};

/// Instructions past this are cut.
const BODY_LIMIT: usize = 60_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
  pub id: String,
  pub name: String,
  pub description: String,
  /// `"user"` or `"project"`.
  pub source: String,
}

fn roots(workspace: Option<&Path>) -> Vec<(PathBuf, &'static str)> {
  let mut out = Vec::new();
  if let Some(root) = workspace {
    out.push((root.join(".claude").join("skills"), "project"));
  }
  if let Some(home) = crate::agents::home_dir() {
    out.push((home.join(".claude").join("skills"), "user"));
  }
  out
}

/// `(frontmatter fields, body)`; a file without frontmatter is all body.
fn split(text: &str) -> (Vec<(String, String)>, &str) {
  let text = text.trim_start_matches('\u{feff}');
  let Some(rest) = text.strip_prefix("---") else { return (Vec::new(), text) };
  let Some(end) = rest.find("\n---") else { return (Vec::new(), text) };
  let fields = rest[..end]
    .lines()
    .filter_map(|l| l.split_once(':'))
    .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches(['"', '\'']).to_string()))
    .collect();
  let body = rest[end + 4..].trim_start_matches(['-', '\r', '\n']);
  (fields, body)
}

/// Every skill found, project ones first; a project skill hides a user skill of the same name.
pub fn list(workspace: Option<&Path>) -> Vec<SkillInfo> {
  let mut out: Vec<SkillInfo> = Vec::new();
  for (dir, source) in roots(workspace) {
    let Ok(entries) = std::fs::read_dir(&dir) else { continue };
    let mut found: Vec<SkillInfo> = entries
      .flatten()
      .filter_map(|e| {
        let file = e.path().join("SKILL.md");
        let text = std::fs::read_to_string(&file).ok()?;
        let (fields, _) = split(&text);
        let get = |k: &str| fields.iter().find(|(f, _)| f == k).map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
        let folder = e.file_name().to_string_lossy().into_owned();
        Some(SkillInfo {
          id: file.to_string_lossy().into_owned(),
          name: get("name").unwrap_or(folder),
          description: get("description").unwrap_or_default(),
          source: source.into(),
        })
      })
      .collect();
    found.sort_by_key(|s| s.name.to_lowercase());
    for s in found {
      if !out.iter().any(|o| o.name == s.name) {
        out.push(s);
      }
    }
  }
  out
}

/// The named skills' instructions, as a system-prompt section. Unknown ids fail.
pub fn prompt_section(workspace: Option<&Path>, ids: &[String]) -> Result<String> {
  if ids.is_empty() {
    return Ok(String::new());
  }
  let known = list(workspace);
  let mut out = String::from("\n\n## Skills the user selected for this message\nFollow these instructions where they apply.");
  for id in ids {
    let skill = known
      .iter()
      .find(|s| &s.id == id)
      .ok_or_else(|| CoreError::NotFound(format!("Skill \"{id}\" is no longer available.")))?;
    let text = std::fs::read_to_string(&skill.id)?;
    let (_, body) = split(&text);
    let dir = Path::new(&skill.id).parent().map(|d| d.display().to_string()).unwrap_or_default();
    out.push_str(&format!(
      "\n\n### Skill: {}\n(Its files live in {dir}.)\n\n{}",
      skill.name,
      super::context::clip(body.trim(), BODY_LIMIT)
    ));
  }
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn frontmatter_and_body_split() {
    let (fields, body) = split("---\nname: deploy\ndescription: \"Ship it\"\n---\n\nDo the thing.\n");
    assert_eq!(fields, vec![("name".into(), "deploy".into()), ("description".into(), "Ship it".into())]);
    assert_eq!(body.trim(), "Do the thing.");
    assert_eq!(split("plain").1, "plain");
  }

  #[test]
  fn project_skills_list_and_load() {
    let dir = tempfile::tempdir().unwrap();
    let skill = dir.path().join(".claude/skills/review");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), "---\nname: review\ndescription: Review code\n---\nCheck tests.").unwrap();
    let found: Vec<SkillInfo> = list(Some(dir.path())).into_iter().filter(|s| s.source == "project").collect();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].description, "Review code");
    let section = prompt_section(Some(dir.path()), &[found[0].id.clone()]).unwrap();
    assert!(section.contains("### Skill: review") && section.contains("Check tests."));
    assert!(prompt_section(Some(dir.path()), &["C:/nope/SKILL.md".into()]).is_err());
  }
}
