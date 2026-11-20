//! Unit test document for a UI test run: Word, PDF or Markdown, with the screenshots.
//!
//! Laid out like the team's hand-written unit test documents: an info table, what was expected, a
//! short summary, ONE table with a row per test case, the screenshots with captions, and open
//! issues only when something did not pass. The wording comes from one model call and is scrubbed so
//! it reads as if a person ran the tests; if that call fails, plain text built from the run data is
//! used instead, so a document is always produced.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use zip::write::SimpleFileOptions;

use super::runner::Emit;
use super::{UiStepResult, UiTestCase, UiTestSuite};
use crate::assistant::runner::SendRequest;
use crate::assistant::{ApprovalMode, Assistant, store};
use crate::{CoreError, Result};

const TEXT_TIMEOUT: Duration = Duration::from_secs(180);
const PDF_TIMEOUT: Duration = Duration::from_secs(60);

fn invalid(msg: impl Into<String>) -> CoreError {
  CoreError::Invalid(msg.into())
}

// ---- request / output -----------------------------------------------------------

pub struct ReportRequest {
  pub suite_id: String,
  /// A run id from the history (its row id or the run's own id); `None` = the latest run.
  pub run_id: Option<String>,
  /// Case ids to include; `None` = every case in the run.
  pub case_ids: Option<Vec<String>>,
  /// `docx`, `pdf` or `md`.
  pub format: String,
  pub path: String,
  pub title: String,
  pub prepared_by: String,
  /// Optional user story line, e.g. `27432 - Feature Group Column`.
  pub user_story: String,
  /// Optional iteration, e.g. `1.18`.
  pub iteration: String,
  /// Optional `.docx` whose styles, fonts and theme the Word document reuses.
  pub template_path: String,
  /// `all`, `failed` or `none`.
  pub screenshots: String,
}

#[derive(Debug, Serialize)]
pub struct ReportOutput {
  pub path: String,
  pub files: Vec<String>,
}


// ---- scrub ------------------------------------------------------------------------

struct Rule {
  re: regex::Regex,
  /// Replacement for a singular match; plural matches (ending in `s`) use `plural` when set.
  singular: &'static str,
  plural: Option<&'static str>,
}

fn rules() -> &'static Vec<Rule> {
  static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
  RULES.get_or_init(|| {
    let r = |p: &str, singular: &'static str, plural: Option<&'static str>| Rule { re: regex::Regex::new(p).expect("static regex"), singular, plural };
    vec![
      r(r"(?i)\bbrowser_[a-z_]+\b", "", None),
      r(r"(?i)\bmcp\w*", "", None),
      r(r"(?i)\bautomation tools?\b", "", None),
      r(r"(?i)\bneeds (?:to be )?review(?:ed)?\b", "needs a further check", None),
      r(r"(?i)\bneed (?:to be )?review(?:ed)?\b", "need a further check", None),
      r(r"(?i)\b(?:the|an?)\s+(?:ai|llm|artificial intelligence|language model|model|assistant|agent)\b", "the tester", None),
      r(r"(?i)\b(?:assistant|agent)s?\b", "tester", Some("testers")),
      r(r"(?i)\b(?:artificial intelligence|language models?|llms?|ai|playwright|claude)\b(?:-\w+)?", "", None),
      r(r"(?i)\bgpt(?:-[\w.]+)?", "", None),
      r(r"(?i)\btranscripts?\b", "record", Some("records")),
      r(r"(?i)\bprompts?\b", "instruction", Some("instructions")),
      r(r"(?i)\bsnapshots?\b", "page check", Some("page checks")),
    ]
  })
}

fn capitalize(s: &str) -> String {
  let mut c = s.chars();
  match c.next() {
    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    None => String::new(),
  }
}

/// Removes or rewrites wording that would reveal how the test was run.
pub fn scrub(text: &str) -> String {
  let mut s = text.to_string();
  for rule in rules() {
    s = rule
      .re
      .replace_all(&s, |c: &regex::Captures| {
        let m = &c[0];
        let plural = m.to_ascii_lowercase().ends_with('s');
        let rep = match (plural, rule.plural) {
          (true, Some(p)) => p,
          _ => rule.singular,
        };
        if m.chars().next().is_some_and(char::is_uppercase) { capitalize(rep) } else { rep.to_string() }
      })
      .into_owned();
  }
  let s = regex::Regex::new(r"\(\s*\)").expect("static regex").replace_all(&s, "").into_owned();
  let s = regex::Regex::new(r"[ \t]{2,}").expect("static regex").replace_all(&s, " ").into_owned();
  let s = regex::Regex::new(r"\s+([,.;:!?])").expect("static regex").replace_all(&s, "$1").into_owned();
  s.trim().to_string()
}

// ---- generated text --------------------------------------------------------------

#[derive(Default, Debug)]
struct CaseText {
  scenario: Option<String>,
  expected: Option<String>,
  actual: Option<String>,
}

#[derive(Default, Debug)]
struct Texts {
  application: Option<String>,
  expected: Option<String>,
  summary: Option<String>,
  cases: HashMap<String, CaseText>,
  /// (case id, step number) -> caption.
  captions: HashMap<(String, i64), String>,
  issues: HashMap<String, String>,
}

fn text_of(v: &Value, key: &str) -> Option<String> {
  v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn step_no(v: &Value) -> Option<i64> {
  v.get("step").or_else(|| v.get("n")).and_then(|n| n.as_i64().or_else(|| n.as_str().and_then(|x| x.trim().parse().ok())))
}

/// The JSON object the model answered with (fenced or bare); anything else yields empty texts.
fn parse_texts(answer: &str) -> Texts {
  let known = |v: &Value| v.is_object() && ["application", "expected", "summary", "cases", "captions", "issues"].iter().any(|k| v.get(*k).is_some());
  let mut found: Option<Value> = None;
  for part in answer.split("```").skip(1).step_by(2) {
    let body = part.strip_prefix("json").or_else(|| part.strip_prefix("JSON")).unwrap_or(part);
    if let Ok(v) = serde_json::from_str::<Value>(body.trim()) {
      if known(&v) {
        found = Some(v);
        break;
      }
    }
  }
  if found.is_none() {
    for (i, c) in answer.char_indices() {
      if c != '{' {
        continue;
      }
      if let Some(Ok(v)) = serde_json::Deserializer::from_str(&answer[i..]).into_iter::<Value>().next() {
        if known(&v) {
          found = Some(v);
          break;
        }
      }
    }
  }
  let Some(v) = found else { return Texts::default() };
  let mut t = Texts { application: text_of(&v, "application"), expected: text_of(&v, "expected"), summary: text_of(&v, "summary"), ..Default::default() };
  for c in v.get("cases").and_then(Value::as_array).into_iter().flatten() {
    let Some(id) = text_of(c, "caseId") else { continue };
    t.cases.insert(id, CaseText { scenario: text_of(c, "scenario"), expected: text_of(c, "expected"), actual: text_of(c, "actual") });
  }
  for c in v.get("captions").and_then(Value::as_array).into_iter().flatten() {
    if let (Some(id), Some(n), Some(cap)) = (text_of(c, "caseId"), step_no(c), text_of(c, "caption")) {
      t.captions.insert((id, n), cap);
    }
  }
  for i in v.get("issues").and_then(Value::as_array).into_iter().flatten() {
    if let (Some(id), Some(d)) = (text_of(i, "caseId"), text_of(i, "text").or_else(|| text_of(i, "description"))) {
      t.issues.insert(id, d);
    }
  }
  t
}

fn build_text_prompt(input: &Value) -> String {
  format!(
    "You are a QA engineer writing the wording of a short unit test document for a completed test run. Write like a person \
     who ran the tests by hand: short, factual, past tense, plain business English, no filler, no first person (no \"I\" or \
     \"we\"). Describe only what the data shows. Never speculate and never invent results. Example scenario: \"Open Option \
     Choice Combination Report, select Dresden, search, scroll right.\" Example caption: \"Option Choice Combination Report, \
     PLM View, Dresden. The FeatureGroup column shows Plumbing.\"\n\n\
     HARD RULE: never mention AI, artificial intelligence, models, LLMs, assistants, agents, automation tools, Playwright, \
     MCP, Claude, prompts, transcripts, snapshots or \"tool\". The document must read as if a person ran every test by hand \
     in the browser. Do not write \"needs review\"; write \"needs a further check\" instead.\n\n\
     Return ONLY one JSON object (no markdown fences, no commentary) in exactly this shape:\n\
     {{\"application\":\"\",\"expected\":\"\",\"summary\":\"\",\"overall\":\"PASS\",\"cases\":[{{\"caseId\":\"\",\"scenario\":\"\",\"expected\":\"\",\"actual\":\"\"}}],\"captions\":[{{\"caseId\":\"\",\"step\":1,\"caption\":\"\"}}],\"issues\":[{{\"caseId\":\"\",\"text\":\"\"}}]}}\n\n\
     Field rules:\n\
     - application: the screens or mashups that were exercised, short, e.g. \"CHBU Landing Page - Option Choice Combination Report\".\n\
     - expected: one short paragraph on what the test cases set out to show (use the user story if given).\n\
     - summary: one to three sentences on the outcome, consistent with the counts. The document adds the \"Overall result\" label itself.\n\
     - overall: PASS only if every case passed, else FAIL.\n\
     - cases: one entry for EVERY case, using its caseId. scenario: one concise line describing what was done, written from the steps. \
       expected: the expected results merged into one concise sentence. actual: what was observed, from the step observations; \
       for a passed case start with \"As expected.\" then the key facts; for others say what differed.\n\
     - captions: one entry for EVERY screenshot listed (caseId and step as given): a descriptive caption of what the screenshot \
       shows, from the step action and observation. Do not start with \"Figure\".\n\
     - issues: one entry for every case that did not pass: what was observed, one or two sentences. Empty list if all passed.\n\n\
     DATA:\n{}",
    input
  )
}

/// One model call (tools off) in a throwaway chat, which is deleted afterwards.
async fn ask_texts(a: &Arc<Assistant>, suite: &UiTestSuite, prompt: String) -> Result<String> {
  let (provider, model) = super::runner::models(a, suite).await?;
  let pool = a.pool().await;
  let chat = store::create(&pool).await?;
  let req = SendRequest {
    chat_id: Some(chat.id.clone()),
    provider,
    model,
    effort: String::new(),
    text: prompt,
    attachments: Vec::new(),
    tools: Some(vec![]),
    skills: Vec::new(),
    approval: ApprovalMode::Auto,
    server_approval: Some(ApprovalMode::Auto),
    inline_attachments: Vec::new(),
    references: Vec::new(),
    images: Vec::new(),
    sub_agents: None,
  };
  let fut = a.ask(req);
  tokio::pin!(fut);
  let out = tokio::select! {
    r = &mut fut => r.map(|(_, answer)| answer),
    _ = tokio::time::sleep(TEXT_TIMEOUT) => {
      a.cancel(&chat.id);
      let _ = fut.await;
      Err(invalid("Writing the document text took too long."))
    }
  };
  let _ = store::delete(&pool, &chat.id).await;
  out
}

// ---- document model --------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tone {
  None,
  Pass,
  Fail,
  Review,
}

#[derive(Clone, Debug)]
struct Cell {
  text: String,
  tone: Tone,
}

fn cell(t: impl Into<String>) -> Cell {
  Cell { text: t.into(), tone: Tone::None }
}

fn toned(t: impl Into<String>, tone: Tone) -> Cell {
  Cell { text: t.into(), tone }
}

fn tone_of(label: &str) -> Tone {
  match label {
    "Pass" => Tone::Pass,
    "Fail" => Tone::Fail,
    "Review" => Tone::Review,
    _ => Tone::None,
  }
}

#[derive(Clone)]
struct Image {
  bytes: Vec<u8>,
  ext: &'static str,
  w: u32,
  h: u32,
  /// File name in the Markdown image folder.
  name: String,
}

enum Block {
  Title(String),
  Subtitle(String),
  H1(String),
  Para(String),
  Bullets(Vec<String>),
  Table { head: Vec<String>, widths: Vec<u32>, rows: Vec<Vec<Cell>> },
  Figure { caption: String, img: Image },
}

/// Reads an image's pixel size from its header: PNG IHDR, or a JPEG start-of-frame marker.
pub fn image_size(b: &[u8]) -> Option<(u32, u32)> {
  if b.len() >= 24 && b[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
    let w = u32::from_be_bytes(b[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(b[20..24].try_into().ok()?);
    return (w > 0 && h > 0).then_some((w, h));
  }
  if b.len() > 4 && b[0] == 0xFF && b[1] == 0xD8 {
    let mut i = 2;
    while i + 9 < b.len() {
      if b[i] != 0xFF {
        i += 1;
        continue;
      }
      let m = b[i + 1];
      if m == 0xFF {
        i += 1;
        continue;
      }
      if (0xD0..=0xD9).contains(&m) || m == 0x01 {
        i += 2;
        continue;
      }
      let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
      if matches!(m, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
        let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
        let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
        return (w > 0 && h > 0).then_some((w, h));
      }
      i += 2 + len.max(2);
    }
  }
  None
}

fn load_image(path: &str, name_stem: &str) -> Option<Image> {
  if path.is_empty() {
    return None;
  }
  let bytes = std::fs::read(path).ok()?;
  let (w, h) = image_size(&bytes)?;
  let ext = if bytes.starts_with(&[0x89, b'P']) { "png" } else { "jpg" };
  Some(Image { bytes, ext, w, h, name: format!("{name_stem}.{ext}") })
}

struct CaseRow {
  id: String,
  scenario: String,
  expected: String,
  actual: String,
  /// `Pass`, `Fail` or `Review`.
  status: &'static str,
}

struct Fig {
  /// Case label, added to the caption when the document has several cases.
  case: String,
  caption: String,
  img: Image,
}

struct Issue {
  case: String,
  text: String,
}

#[derive(Default)]
struct Counts {
  total: usize,
  passed: usize,
  failed: usize,
  review: usize,
}

struct Meta {
  title: String,
  suite: String,
  user_story: String,
  iteration: String,
  /// `ThingWorx test server (host)`.
  environment: String,
  prepared_by: String,
  /// Run date, `16-Nov-2026`.
  date: String,
}

struct Doc {
  meta: Meta,
  application: String,
  expected: String,
  summary: String,
  pass: bool,
  counts: Counts,
  cases: Vec<CaseRow>,
  figs: Vec<Fig>,
  issues: Vec<Issue>,
}

/// One case of the run, as stored in the run history.
#[derive(Debug, Clone)]
struct RunCase {
  case_id: String,
  title: String,
  status: String,
  reason: String,
  steps: Vec<UiStepResult>,
}

fn status_label(s: &str) -> &'static str {
  match s {
    "passed" => "Pass",
    "failed" => "Fail",
    _ => "Review",
  }
}

fn id_label(c: &UiTestCase, no: usize) -> String {
  match c.ado_id {
    Some(id) => id.to_string(),
    None => format!("TC-{no:02}"),
  }
}

fn plain(s: &str) -> String {
  s.trim().trim_end_matches('.').trim().to_string()
}

/// Non-empty parts joined with `sep`, ending in a full stop.
fn sentence(parts: impl IntoIterator<Item = String>, sep: &str) -> String {
  let v: Vec<String> = parts.into_iter().map(|p| plain(&p)).filter(|p| !p.is_empty()).collect();
  if v.is_empty() { String::new() } else { format!("{}.", v.join(sep)) }
}

fn assemble(meta: Meta, run: &[(RunCase, UiTestCase)], texts: &Texts, shots: &str) -> Doc {
  let mut counts = Counts { total: run.len(), ..Default::default() };
  let mut cases = Vec::new();
  let mut figs = Vec::new();
  let mut issues = Vec::new();
  for (i, (rc, def)) in run.iter().enumerate() {
    let no = i + 1;
    let status = status_label(&rc.status);
    match status {
      "Pass" => counts.passed += 1,
      "Fail" => counts.failed += 1,
      _ => counts.review += 1,
    }
    let id = id_label(def, no);
    let ct = texts.cases.get(&rc.case_id);
    let title = if def.title.is_empty() { rc.title.clone() } else { def.title.clone() };
    let reason = scrub(&rc.reason);
    let ai = |o: Option<&String>| o.map(|s| scrub(s)).filter(|s| !s.is_empty());

    let scenario = ai(ct.and_then(|c| c.scenario.as_ref())).unwrap_or_else(|| {
      let s = sentence(def.steps.iter().map(|s| s.action.clone()), ", ");
      if s.is_empty() { title.clone() } else { s.trim_end_matches('.').to_string() }
    });
    let expected = ai(ct.and_then(|c| c.expected.as_ref())).unwrap_or_else(|| {
      let s = sentence(def.steps.iter().map(|s| s.expected.clone()), "; ");
      if s.is_empty() { "The steps complete without errors.".into() } else { s }
    });
    let notes: Vec<String> = (1..=def.steps.len() as i64).filter_map(|n| rc.steps.iter().find(|r| r.step == n)).map(|r| scrub(&r.note)).filter(|n| !n.is_empty()).collect();
    let actual = ai(ct.and_then(|c| c.actual.as_ref())).unwrap_or_else(|| {
      let n = sentence(notes.clone(), "; ");
      match status {
        "Pass" if n.is_empty() => "As expected.".into(),
        "Pass" => format!("As expected. {n}"),
        _ if !n.is_empty() => n,
        _ if !reason.is_empty() => reason.clone(),
        "Fail" => "The expected result was not seen.".into(),
        _ => "The outcome could not be confirmed and needs a further check.".into(),
      }
    });

    // Screenshots chosen by the requested mode, in step order.
    let with_shot: Vec<usize> = (0..def.steps.len()).filter(|&k| rc.steps.iter().any(|r| r.step == k as i64 + 1 && !r.screenshot.is_empty())).collect();
    let any_failed = rc.steps.iter().any(|r| r.status == "failed");
    let last_shot = with_shot.last().copied();
    for k in with_shot {
      let r = rc.steps.iter().find(|r| r.step == k as i64 + 1).expect("step with screenshot");
      let keep = match shots {
        "all" => true,
        "failed" => r.status == "failed" || (!any_failed && status != "Pass" && Some(k) == last_shot),
        _ => false,
      };
      if !keep {
        continue;
      }
      if let Some(img) = load_image(&r.screenshot, &format!("case-{no}-step-{}", k + 1)) {
        let caption = texts
          .captions
          .get(&(rc.case_id.clone(), k as i64 + 1))
          .map(|c| scrub(c))
          .filter(|c| !c.is_empty())
          .unwrap_or_else(|| format!("{title}, step {}", k + 1));
        figs.push(Fig { case: id.clone(), caption, img });
      }
    }
    if status != "Pass" {
      let text = ai(texts.issues.get(&rc.case_id)).unwrap_or_else(|| if reason.is_empty() { actual.clone() } else { reason.clone() });
      issues.push(Issue { case: id.clone(), text });
    }
    cases.push(CaseRow { id, scenario, expected, actual, status });
  }

  let pass = counts.total > 0 && counts.passed == counts.total;
  let application = texts.application.as_deref().map(scrub).filter(|s| !s.is_empty()).unwrap_or_else(|| meta.suite.clone());
  let expected = texts.expected.as_deref().map(scrub).filter(|e| !e.is_empty()).unwrap_or_else(|| {
    let titles: Vec<String> = run.iter().map(|(rc, d)| plain(if d.title.is_empty() { &rc.title } else { &d.title })).collect();
    format!("The following were checked: {}.", titles.join("; "))
  });
  let body = texts.summary.as_deref().map(scrub).map(|s| lead_re().replace(&s, "").trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| {
    if pass {
      if counts.total == 1 { "The test case passed.".into() } else { format!("All {} test cases passed.", counts.total) }
    } else {
      let mut s = format!("{} of {} test cases passed", counts.passed, counts.total);
      if counts.failed > 0 {
        s.push_str(&format!(", {} failed", counts.failed));
      }
      if counts.review > 0 {
        s.push_str(&format!(", {} need a further check", counts.review));
      }
      s.push('.');
      s
    }
  });
  let summary = format!("Overall result: {}. {body}", if pass { "PASS" } else { "FAIL" });
  Doc { meta, application, expected, summary, pass, counts, cases, figs, issues }
}

/// A leading "Overall result: PASS." the model wrote itself; the document adds its own.
fn lead_re() -> &'static regex::Regex {
  static RE: OnceLock<regex::Regex> = OnceLock::new();
  RE.get_or_init(|| regex::Regex::new(r"(?i)^\s*overall\s+(?:result|verdict)\s*[:\-]?\s*(?:pass|fail|passed|failed)?\s*[.:]?\s*").expect("static regex"))
}

fn blocks(d: &Doc) -> Vec<Block> {
  let m = &d.meta;
  let mut b = vec![Block::Title(m.title.clone()), Block::Subtitle("Unit Test Results".into())];
  let info: Vec<(&str, &str)> = vec![
    ("User story", &m.user_story),
    ("Iteration", &m.iteration),
    ("Environment", &m.environment),
    ("Application", &d.application),
    ("Tested by", &m.prepared_by),
    ("Date", &m.date),
  ];
  b.push(Block::Table {
    head: vec!["Item".into(), "Detail".into()],
    widths: vec![2400, 6960],
    rows: info.into_iter().filter(|(_, v)| !v.trim().is_empty()).map(|(k, v)| vec![cell(k), cell(v)]).collect(),
  });
  b.push(Block::H1("1. What was expected".into()));
  b.push(Block::Para(d.expected.clone()));
  b.push(Block::H1("2. Summary".into()));
  b.push(Block::Para(d.summary.clone()));
  let c = &d.counts;
  let mut rows = vec![
    vec![cell("Total test cases"), cell(c.total.to_string())],
    vec![cell("Passed"), cell(c.passed.to_string())],
    vec![cell("Failed"), cell(c.failed.to_string())],
  ];
  if c.review > 0 {
    rows.push(vec![cell("Needs review"), cell(c.review.to_string())]);
  }
  rows.push(vec![cell("Overall result"), toned(if d.pass { "Pass" } else { "Fail" }, if d.pass { Tone::Pass } else { Tone::Fail })]);
  b.push(Block::Table { head: vec!["Item".into(), "Value".into()], widths: vec![2400, 6960], rows });
  b.push(Block::H1("3. Test cases".into()));
  b.push(Block::Table {
    head: ["ID", "Test case", "Expected", "Actual", "Status"].map(String::from).to_vec(),
    widths: vec![900, 2300, 2300, 2900, 960],
    rows: d.cases.iter().map(|c| vec![cell(&c.id), cell(&c.scenario), cell(&c.expected), cell(&c.actual), toned(c.status, tone_of(c.status))]).collect(),
  });
  let mut section = 4;
  if !d.figs.is_empty() {
    b.push(Block::H1(format!("{section}. Screenshots")));
    section += 1;
    let many = d.cases.len() > 1;
    for (i, f) in d.figs.iter().enumerate() {
      let tag = if many { format!(" ({})", f.case) } else { String::new() };
      b.push(Block::Figure { caption: format!("Figure {} - {}{tag}", i + 1, f.caption.trim()), img: f.img.clone() });
    }
  }
  if !d.issues.is_empty() {
    b.push(Block::H1(format!("{section}. Open issues")));
    b.push(Block::Bullets(d.issues.iter().map(|i| format!("{}: {}", i.case, i.text)).collect()));
  }
  b
}

// ---- dates ----------------------------------------------------------------------

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn civil(days: i64) -> (i64, u32, u32) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
  let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
  (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `16-Nov-2026` at `offset_min` from UTC.
fn format_date(secs: i64, offset_min: i64) -> String {
  let (y, m, d) = civil((secs + offset_min * 60).div_euclid(86_400));
  format!("{d:02}-{}-{y}", MONTHS[(m - 1) as usize])
}

#[cfg(windows)]
fn local_offset_min() -> i64 {
  #[repr(C)]
  struct Tzi {
    bias: i32,
    std_name: [u16; 32],
    std_date: [u16; 8],
    std_bias: i32,
    dst_name: [u16; 32],
    dst_date: [u16; 8],
    dst_bias: i32,
  }
  unsafe extern "system" {
    fn GetTimeZoneInformation(info: *mut Tzi) -> u32;
  }
  // SAFETY: plain C struct filled in by the OS; all-zero is a valid initial value.
  let mut t: Tzi = unsafe { std::mem::zeroed() };
  let r = unsafe { GetTimeZoneInformation(&mut t) };
  let extra = if r == 2 { t.dst_bias } else { t.std_bias };
  -i64::from(t.bias + extra)
}

#[cfg(not(windows))]
fn local_offset_min() -> i64 {
  0
}

// ---- XML / HTML helpers ----------------------------------------------------------

fn esc(s: &str) -> String {
  let mut o = String::with_capacity(s.len() + 8);
  for c in s.chars() {
    match c {
      '&' => o.push_str("&amp;"),
      '<' => o.push_str("&lt;"),
      '>' => o.push_str("&gt;"),
      '"' => o.push_str("&quot;"),
      '\'' => o.push_str("&apos;"),
      c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
      c => o.push(c),
    }
  }
  o
}

// ---- DOCX -----------------------------------------------------------------------

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture""#;

/// Text width of the page (Letter, 1in side margins), in twentieths of a point.
const TEXT_W: u32 = 9360;

fn fill(t: Tone) -> Option<&'static str> {
  match t {
    Tone::Pass => Some("C6EFCE"),
    Tone::Fail => Some("FFC7CE"),
    Tone::Review => Some("FFEB9C"),
    Tone::None => None,
  }
}

fn w_runs(text: &str, bold: bool) -> String {
  let mut o = String::new();
  for (i, line) in text.split('\n').enumerate() {
    o.push_str("<w:r>");
    if bold {
      o.push_str("<w:rPr><w:b/></w:rPr>");
    }
    if i > 0 {
      o.push_str("<w:br/>");
    }
    o.push_str(&format!("<w:t xml:space=\"preserve\">{}</w:t></w:r>", esc(line)));
  }
  if o.is_empty() {
    o.push_str("<w:r><w:t></w:t></w:r>");
  }
  o
}

fn w_para(style: Option<&str>, extra: &str, runs: &str) -> String {
  let ppr = match (style, extra.is_empty()) {
    (None, true) => String::new(),
    (s, _) => format!("<w:pPr>{}{extra}</w:pPr>", s.map(|s| format!("<w:pStyle w:val=\"{s}\"/>")).unwrap_or_default()),
  };
  format!("<w:p>{ppr}{runs}</w:p>")
}

fn w_cell(width: u32, c: &Cell, header: bool) -> String {
  let shade = if header { Some("D9E2F3") } else { fill(c.tone) };
  let shd = shade.map(|f| format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{f}\"/>")).unwrap_or_default();
  let bold = header || c.tone != Tone::None;
  format!("<w:tc><w:tcPr><w:tcW w:w=\"{width}\" w:type=\"dxa\"/>{shd}</w:tcPr>{}</w:tc>", w_para(Some("TableText"), "", &w_runs(&c.text, bold)))
}

fn w_table(head: &[String], widths: &[u32], rows: &[Vec<Cell>]) -> String {
  let total: u32 = widths.iter().sum::<u32>().max(1);
  let w: Vec<u32> = widths.iter().map(|x| x * TEXT_W / total).collect();
  let mut o = format!("<w:tbl><w:tblPr><w:tblStyle w:val=\"ReportTable\"/><w:tblW w:w=\"{TEXT_W}\" w:type=\"dxa\"/><w:tblLayout w:type=\"fixed\"/><w:tblLook w:val=\"0000\" w:firstRow=\"0\" w:lastRow=\"0\" w:firstColumn=\"0\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"0\"/></w:tblPr><w:tblGrid>");
  for x in &w {
    o.push_str(&format!("<w:gridCol w:w=\"{x}\"/>"));
  }
  o.push_str("</w:tblGrid>");
  o.push_str("<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>");
  for (i, t) in head.iter().enumerate() {
    o.push_str(&w_cell(w[i], &cell(t), true));
  }
  o.push_str("</w:tr>");
  for r in rows {
    o.push_str("<w:tr><w:trPr><w:cantSplit/></w:trPr>");
    for (i, c) in r.iter().enumerate() {
      o.push_str(&w_cell(w[i], c, false));
    }
    o.push_str("</w:tr>");
  }
  o.push_str("</w:tbl>");
  o.push_str(&w_para(None, "<w:spacing w:after=\"60\"/>", ""));
  o
}

const MAX_W_EMU: u64 = 6 * 914_400;
const MAX_H_EMU: u64 = 8 * 914_400;

/// Picture size in EMU: pixels at 96 dpi, scaled down to fit 6.0in wide (and 8in tall).
fn fit_emu(w: u32, h: u32) -> (u64, u64) {
  let (mut cx, mut cy) = (u64::from(w) * 9525, u64::from(h) * 9525);
  if cx > MAX_W_EMU {
    cy = cy * MAX_W_EMU / cx;
    cx = MAX_W_EMU;
  }
  if cy > MAX_H_EMU {
    cx = cx * MAX_H_EMU / cy;
    cy = MAX_H_EMU;
  }
  (cx.max(1), cy.max(1))
}

fn w_drawing(rid: &str, id: usize, img: &Image, descr: &str) -> String {
  let (cx, cy) = fit_emu(img.w, img.h);
  format!(
    "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/>\
     <wp:docPr id=\"{id}\" name=\"Picture {id}\" descr=\"{}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
     <a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic>\
     <pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{}\"/><pic:cNvPicPr/></pic:nvPicPr>\
     <pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
     <pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>\
     </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>",
    esc(descr),
    esc(&img.name)
  )
}

/// The styles the document uses (the look of the team's existing unit test documents: Calibri,
/// dark blue headings, grey table borders). A template that lacks one of them gets it appended.
const STYLE_DEFS: [(&str, &str); 9] = [
  ("Normal", r#"<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>"#),
  ("Title", r#"<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>"#),
  ("Subtitle", r#"<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>"#),
  ("Heading1", r#"<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>"#),
  ("Caption", r#"<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:qFormat/><w:pPr><w:spacing w:before="40" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>"#),
  ("ListBullet", r#"<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>"#),
  ("TableText", r#"<w:style w:type="paragraph" w:customStyle="1" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>"#),
  ("TableNormal", r#"<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>"#),
  ("ReportTable", r#"<w:style w:type="table" w:customStyle="1" w:styleId="ReportTable"><w:name w:val="Report Table"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/></w:tblBorders><w:tblCellMar><w:top w:w="30" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="30" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>"#),
];

const STYLES_HEAD: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Times New Roman" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="278" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>"#;

/// The built-in styles part, or a template's styles part with any of our style ids it lacks appended.
fn styles_xml(template: Option<&str>) -> String {
  match template {
    None => {
      let mut s = String::from(STYLES_HEAD);
      for (_, def) in STYLE_DEFS {
        s.push_str(def);
      }
      s.push_str("</w:styles>");
      s
    }
    Some(t) => {
      let missing: String = STYLE_DEFS.iter().filter(|(id, _)| !t.contains(&format!("w:styleId=\"{id}\""))).map(|(_, d)| *d).collect();
      match t.rfind("</w:styles>") {
        Some(i) => format!("{}{missing}{}", &t[..i], &t[i..]),
        None => t.to_string(),
      }
    }
  }
}

/// Bullet list definition used by the ListBullet paragraphs.
const NUMBERING: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:hint="default"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#;

/// Parts taken from a `.docx` whose look the document should reuse.
pub struct Template {
  styles: String,
  theme: Option<Vec<u8>>,
  fonts: Option<Vec<u8>>,
}

fn read_part(z: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, name: &str) -> Option<Vec<u8>> {
  use std::io::Read as _;
  let mut f = z.by_name(name).ok()?;
  let mut v = Vec::new();
  f.read_to_end(&mut v).ok()?;
  Some(v)
}

fn load_template(path: &str) -> Result<Template> {
  let bytes = std::fs::read(path).map_err(|e| invalid(format!("The template could not be read: {e}")))?;
  let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| invalid("The template is not a Word (.docx) file."))?;
  let styles = read_part(&mut z, "word/styles.xml").and_then(|b| String::from_utf8(b).ok()).filter(|s| s.contains("</w:styles>")).ok_or_else(|| invalid("The template has no styles to reuse."))?;
  Ok(Template { styles, theme: read_part(&mut z, "word/theme/theme1.xml"), fonts: read_part(&mut z, "word/fontTable.xml") })
}

fn render_docx(blocks: &[Block], template: Option<&Template>) -> Result<Vec<u8>> {
  let mut body = String::new();
  let mut media: Vec<(String, Vec<u8>)> = Vec::new();
  let mut rels = String::new();
  let mut exts: Vec<&'static str> = Vec::new();
  let mut drawing_id = 0usize;
  for b in blocks {
    match b {
      Block::Title(t) => body.push_str(&w_para(Some("Title"), "", &w_runs(t, false))),
      Block::Subtitle(t) => body.push_str(&w_para(Some("Subtitle"), "", &w_runs(t, false))),
      Block::H1(t) => body.push_str(&w_para(Some("Heading1"), "", &w_runs(t, false))),
      Block::Para(t) => body.push_str(&w_para(None, "", &w_runs(t, false))),
      Block::Bullets(items) => {
        for i in items {
          body.push_str(&w_para(Some("ListBullet"), "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>", &w_runs(i, false)));
        }
      }
      Block::Table { head, widths, rows } => body.push_str(&w_table(head, widths, rows)),
      Block::Figure { caption, img } => {
        drawing_id += 1;
        let file = format!("image{drawing_id}.{}", img.ext);
        let rid = format!("rIdImg{drawing_id}");
        rels.push_str(&format!("<Relationship Id=\"{rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/{file}\"/>"));
        media.push((file, img.bytes.clone()));
        if !exts.contains(&img.ext) {
          exts.push(img.ext);
        }
        body.push_str(&w_para(None, "<w:keepNext/><w:spacing w:after=\"60\"/><w:jc w:val=\"center\"/>", &w_drawing(&rid, drawing_id, img, caption)));
        body.push_str(&w_para(Some("Caption"), "", &w_runs(caption, false)));
      }
    }
  }
  let document = format!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document {NS}><w:body>{body}\
     <w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/>\
     <w:pgMar w:top=\"1080\" w:right=\"1440\" w:bottom=\"1080\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>"
  );
  let theme = template.and_then(|t| t.theme.as_deref());
  let fonts = template.and_then(|t| t.fonts.as_deref());
  let styles = styles_xml(template.map(|t| t.styles.as_str()));

  let mut content_types = String::from(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
     <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>",
  );
  for e in &exts {
    let mime = if *e == "png" { "image/png" } else { "image/jpeg" };
    content_types.push_str(&format!("<Default Extension=\"{e}\" ContentType=\"{mime}\"/>"));
  }
  content_types.push_str(
    "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
     <Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
     <Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>",
  );
  if theme.is_some() {
    content_types.push_str("<Override PartName=\"/word/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>");
  }
  if fonts.is_some() {
    content_types.push_str("<Override PartName=\"/word/fontTable.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml\"/>");
  }
  content_types.push_str("</Types>");
  let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
     <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
  let mut doc_rels = String::from(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
     <Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
     <Relationship Id=\"rIdNumbering\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>",
  );
  if theme.is_some() {
    doc_rels.push_str("<Relationship Id=\"rIdTheme\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/>");
  }
  if fonts.is_some() {
    doc_rels.push_str("<Relationship Id=\"rIdFonts\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable\" Target=\"fontTable.xml\"/>");
  }
  doc_rels.push_str(&rels);
  doc_rels.push_str("</Relationships>");

  let zerr = |e: zip::result::ZipError| invalid(e.to_string());
  let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
  let deflate = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
  let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
  let mut parts: Vec<(&str, &[u8])> = vec![
    ("[Content_Types].xml", content_types.as_bytes()),
    ("_rels/.rels", root_rels.as_bytes()),
    ("word/document.xml", document.as_bytes()),
    ("word/styles.xml", styles.as_bytes()),
    ("word/numbering.xml", NUMBERING.as_bytes()),
    ("word/_rels/document.xml.rels", doc_rels.as_bytes()),
  ];
  if let Some(t) = theme {
    parts.push(("word/theme/theme1.xml", t));
  }
  if let Some(f) = fonts {
    parts.push(("word/fontTable.xml", f));
  }
  for (name, data) in parts {
    zw.start_file(name, deflate).map_err(zerr)?;
    zw.write_all(data)?;
  }
  for (name, data) in &media {
    zw.start_file(format!("word/media/{name}"), stored).map_err(zerr)?;
    zw.write_all(data)?;
  }
  Ok(zw.finish().map_err(zerr)?.into_inner())
}

// ---- HTML (for PDF) --------------------------------------------------------------

fn data_uri(img: &Image) -> String {
  use base64::Engine as _;
  let mime = if img.ext == "png" { "image/png" } else { "image/jpeg" };
  format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&img.bytes))
}

fn h_text(s: &str) -> String {
  esc(s).replace('\n', "<br>")
}

fn tone_class(t: Tone) -> &'static str {
  match t {
    Tone::Pass => " class=\"pass\"",
    Tone::Fail => " class=\"fail\"",
    Tone::Review => " class=\"review\"",
    Tone::None => "",
  }
}

fn render_html(blocks: &[Block], title: &str) -> String {
  let mut o = format!(
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{}</title><style>\
     @page {{ size: Letter; margin: 15mm 25mm; }}\
     body {{ font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: #111; line-height: 1.3; }}\
     h1.title {{ font-size: 20pt; color: #1F3864; margin: 0 0 3pt; }}\
     p.subtitle {{ font-size: 14pt; color: #595959; margin: 0 0 12pt; }}\
     h1 {{ font-size: 14pt; color: #1F3864; margin: 14pt 0 6pt; break-after: avoid; }}\
     table {{ border-collapse: collapse; width: 100%; margin: 4pt 0 10pt; }}\
     th, td {{ border: 1px solid #999; padding: 2pt 4.5pt; vertical-align: top; text-align: left; font-size: 10pt; }}\
     th {{ background: #D9E2F3; }} tr {{ break-inside: avoid; }}\
     td.pass {{ background: #C6EFCE; font-weight: bold; }} td.fail {{ background: #FFC7CE; font-weight: bold; }} td.review {{ background: #FFEB9C; font-weight: bold; }}\
     figure {{ margin: 8pt 0 12pt; text-align: center; break-inside: avoid; page-break-inside: avoid; }}\
     figure img {{ width: 6in; max-width: 100%; max-height: 200mm; object-fit: contain; }}\
     figcaption {{ font-size: 9pt; color: #595959; margin-top: 3pt; }}\
     </style></head><body>",
    esc(title)
  );
  for b in blocks {
    match b {
      Block::Title(t) => o.push_str(&format!("<h1 class=\"title\">{}</h1>", esc(t))),
      Block::Subtitle(t) => o.push_str(&format!("<p class=\"subtitle\">{}</p>", esc(t))),
      Block::H1(t) => o.push_str(&format!("<h1>{}</h1>", esc(t))),
      Block::Para(t) => o.push_str(&format!("<p>{}</p>", h_text(t))),
      Block::Bullets(items) => {
        o.push_str("<ul>");
        for i in items {
          o.push_str(&format!("<li>{}</li>", esc(i)));
        }
        o.push_str("</ul>");
      }
      Block::Table { head, widths, rows } => {
        let total: u32 = widths.iter().sum::<u32>().max(1);
        o.push_str("<table><colgroup>");
        for w in widths {
          o.push_str(&format!("<col style=\"width:{}%\">", w * 100 / total));
        }
        o.push_str("</colgroup><thead><tr>");
        for h in head {
          o.push_str(&format!("<th>{}</th>", esc(h)));
        }
        o.push_str("</tr></thead><tbody>");
        for r in rows {
          o.push_str("<tr>");
          for c in r {
            o.push_str(&format!("<td{}>{}</td>", tone_class(c.tone), h_text(&c.text)));
          }
          o.push_str("</tr>");
        }
        o.push_str("</tbody></table>");
      }
      Block::Figure { caption, img } => {
        o.push_str(&format!("<figure><img src=\"{}\" alt=\"{}\"><figcaption>{}</figcaption></figure>", data_uri(img), esc(caption), esc(caption)));
      }
    }
  }
  o.push_str("</body></html>");
  o
}

// ---- Markdown ---------------------------------------------------------------------

/// Keeps `<tag>`-like text literal in Markdown.
fn md_esc(s: &str) -> String {
  s.replace('<', "&lt;").replace('>', "&gt;")
}

fn md_cell(s: &str) -> String {
  md_esc(s).replace('|', "\\|").replace("\r\n", "\n").replace('\n', "<br>")
}

fn url_path(s: &str) -> String {
  s.chars()
    .map(|c| match c {
      ' ' => "%20".to_string(),
      '#' => "%23".into(),
      '%' => "%25".into(),
      '(' => "%28".into(),
      ')' => "%29".into(),
      c => c.to_string(),
    })
    .collect()
}

fn render_md(blocks: &[Block], files_dir: &str) -> String {
  let mut o = String::new();
  for b in blocks {
    match b {
      Block::Title(t) => o.push_str(&format!("# {}\n\n", md_esc(t))),
      Block::Subtitle(t) => o.push_str(&format!("{}\n\n", md_esc(t))),
      Block::H1(t) => o.push_str(&format!("## {}\n\n", md_esc(t))),
      Block::Para(t) => o.push_str(&format!("{}\n\n", md_esc(t).replace('\n', "  \n"))),
      Block::Bullets(items) => {
        for i in items {
          o.push_str(&format!("- {}\n", md_esc(i)));
        }
        o.push('\n');
      }
      Block::Table { head, rows, .. } => {
        o.push_str(&format!("| {} |\n| {} |\n", head.iter().map(|h| md_cell(h)).collect::<Vec<_>>().join(" | "), head.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")));
        for r in rows {
          o.push_str(&format!("| {} |\n", r.iter().map(|c| md_cell(&c.text)).collect::<Vec<_>>().join(" | ")));
        }
        o.push('\n');
      }
      Block::Figure { caption, img } => {
        let caption = md_esc(caption);
        let alt = caption.replace('[', "(").replace(']', ")");
        o.push_str(&format!("![{alt}]({}/{})\n\n*{caption}*\n\n", url_path(files_dir), url_path(&img.name)));
      }
    }
  }
  o
}

// ---- PDF via Microsoft Edge --------------------------------------------------------

fn find_edge() -> Option<PathBuf> {
  let mut c: Vec<PathBuf> = vec![
    PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
  ];
  for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
    if let Some(base) = std::env::var_os(var) {
      c.push(PathBuf::from(base).join(r"Microsoft\Edge\Application\msedge.exe"));
    }
  }
  if let Some(p) = c.into_iter().find(|p| p.is_file()) {
    return Some(p);
  }
  let mut cmd = std::process::Command::new(if cfg!(windows) { "where" } else { "which" });
  cmd.arg("msedge");
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt as _;
    cmd.creation_flags(0x0800_0000);
  }
  let out = cmd.output().ok()?;
  String::from_utf8_lossy(&out.stdout).lines().map(|l| PathBuf::from(l.trim())).find(|p| p.is_file())
}

fn file_url(p: &Path) -> String {
  let s = p.to_string_lossy().replace('\\', "/");
  let s = s.strip_prefix("//?/").unwrap_or(&s);
  let enc: String = s.chars().map(|c| match c { ' ' => "%20".to_string(), '#' => "%23".into(), '%' => "%25".into(), c => c.to_string() }).collect();
  if enc.starts_with('/') { format!("file://{enc}") } else { format!("file:///{enc}") }
}

async fn html_to_pdf(data_dir: &Path, html: &str, out: &Path) -> Result<()> {
  let edge = find_edge().ok_or_else(|| invalid("Microsoft Edge was not found, so the PDF could not be made. Install Edge or choose Word or Markdown."))?;
  let tmp = data_dir.join("uitest").join("tmp").join(uuid::Uuid::new_v4().to_string());
  std::fs::create_dir_all(&tmp)?;
  let result = async {
    let page = tmp.join("report.html");
    let pdf = tmp.join("report.pdf");
    std::fs::write(&page, html)?;
    let mut cmd = tokio::process::Command::new(&edge);
    cmd
      .args(["--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--no-first-run", "--disable-extensions", "--disable-sync"])
      .arg(format!("--user-data-dir={}", tmp.join("profile").display()))
      .arg(format!("--print-to-pdf={}", pdf.display()))
      .arg(file_url(&page))
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn()?;
    match tokio::time::timeout(PDF_TIMEOUT, child.wait()).await {
      Ok(r) => {
        r?;
      }
      Err(_) => {
        let _ = child.kill().await;
        return Err(invalid("Making the PDF took too long."));
      }
    }
    let bytes = std::fs::read(&pdf).map_err(|_| invalid("Microsoft Edge did not produce a PDF."))?;
    if !bytes.starts_with(b"%PDF") {
      return Err(invalid("Microsoft Edge produced an invalid PDF."));
    }
    std::fs::write(out, bytes)?;
    Ok(())
  }
  .await;
  let _ = std::fs::remove_dir_all(&tmp);
  result
}

// ---- loading and generating --------------------------------------------------------

struct Loaded {
  suite: UiTestSuite,
  env: String,
  base_url: String,
  started_at: i64,
  cases: Vec<(RunCase, UiTestCase)>,
}

fn parse_run_cases(result: &Value) -> Vec<RunCase> {
  result
    .get("cases")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .map(|c| RunCase {
      case_id: c.get("caseId").and_then(Value::as_str).unwrap_or_default().into(),
      title: c.get("title").and_then(Value::as_str).unwrap_or_default().into(),
      status: c.get("status").and_then(Value::as_str).unwrap_or_default().into(),
      reason: c.get("reason").and_then(Value::as_str).unwrap_or_default().into(),
      steps: serde_json::from_value(c.get("stepResults").cloned().unwrap_or(Value::Null)).unwrap_or_default(),
    })
    .collect()
}

async fn load(a: &Arc<Assistant>, req: &ReportRequest) -> Result<Loaded> {
  let pool = a.pool().await;
  let suite = super::get_suite(&pool, &req.suite_id).await?;
  let rows = crate::automation::list_runs(&pool, "uitest", Some(&suite.id), crate::automation::KEEP_RUNS).await?;
  let run_id = req.run_id.as_deref().map(str::trim).filter(|r| !r.is_empty());
  let detail = match run_id {
    None => match rows.first() {
      Some(r) => crate::automation::get_run(&pool, &r.id).await?,
      None => return Err(invalid("This suite has no finished run yet. Run its test cases first.")),
    },
    Some(rid) => {
      let mut found = None;
      for r in &rows {
        if r.id == rid {
          found = Some(crate::automation::get_run(&pool, &r.id).await?);
          break;
        }
      }
      if found.is_none() {
        for r in &rows {
          let d = crate::automation::get_run(&pool, &r.id).await?;
          if d.result.get("runId").and_then(Value::as_str) == Some(rid) {
            found = Some(d);
            break;
          }
        }
      }
      found.ok_or_else(|| CoreError::NotFound("That run is no longer in the history.".into()))?
    }
  };
  let defs = super::list_cases(&pool, &suite.id).await?;
  let mut cases = Vec::new();
  for rc in parse_run_cases(&detail.result) {
    if req.case_ids.as_ref().is_some_and(|ids| !ids.contains(&rc.case_id)) {
      continue;
    }
    let def = defs.iter().find(|d| d.id == rc.case_id).cloned().unwrap_or_else(|| UiTestCase { id: rc.case_id.clone(), title: rc.title.clone(), ..Default::default() });
    cases.push((rc, def));
  }
  if cases.is_empty() {
    return Err(invalid("None of the chosen test cases are part of that run."));
  }
  let env_id = detail.result.get("envId").and_then(Value::as_str).filter(|e| !e.is_empty()).unwrap_or(&suite.env_id).to_string();
  let base_url = crate::db::environments::list(&pool).await?.into_iter().find(|e| e.environment == env_id).map(|e| e.twx_base_url).unwrap_or_default();
  Ok(Loaded { suite, env: env_id, base_url, started_at: detail.run.started_at, cases })
}

/// `ThingWorx test server (host)`.
fn env_label(env: &str, base_url: &str) -> String {
  let host = base_url.trim().split("://").last().unwrap_or_default().split('/').next().unwrap_or_default();
  let env = env.trim().to_lowercase();
  let name = if env.is_empty() { "ThingWorx server".to_string() } else { format!("ThingWorx {env} server") };
  if host.is_empty() { name } else { format!("{name} ({host})") }
}

fn text_input(l: &Loaded, req: &ReportRequest, shots: &str) -> Value {
  let status_of = |r: &RunCase| status_label(&r.status);
  let mut screenshots = Vec::new();
  if shots != "none" {
    for (r, d) in &l.cases {
      for (i, s) in d.steps.iter().enumerate() {
        if let Some(x) = r.steps.iter().find(|x| x.step == i as i64 + 1 && !x.screenshot.is_empty()) {
          screenshots.push(json!({ "caseId": r.case_id, "step": i + 1, "action": s.action, "observation": x.note }));
        }
      }
    }
  }
  json!({
    "userStory": req.user_story.trim(),
    "iteration": req.iteration.trim(),
    "suite": l.suite.name,
    "environment": env_label(&l.env, &l.base_url),
    "counts": {
      "total": l.cases.len(),
      "passed": l.cases.iter().filter(|(r, _)| r.status == "passed").count(),
      "failed": l.cases.iter().filter(|(r, _)| r.status == "failed").count(),
      "needsFurtherCheck": l.cases.iter().filter(|(r, _)| !matches!(r.status.as_str(), "passed" | "failed")).count(),
    },
    "cases": l.cases.iter().enumerate().map(|(i, (r, d))| json!({
      "caseId": r.case_id,
      "label": id_label(d, i + 1),
      "title": d.title,
      "result": status_of(r),
      "reason": r.reason,
      "steps": d.steps.iter().enumerate().map(|(i, s)| {
        let res = r.steps.iter().find(|x| x.step == i as i64 + 1);
        json!({ "n": i + 1, "action": s.action, "expected": s.expected,
                "result": res.map(|x| x.status.as_str()).unwrap_or("not recorded"), "observation": res.map(|x| x.note.as_str()).unwrap_or("") })
      }).collect::<Vec<_>>(),
    })).collect::<Vec<_>>(),
    "screenshots": screenshots,
  })
}

pub async fn generate(a: &Arc<Assistant>, data_dir: &Path, req: ReportRequest, emit: &Emit) -> Result<ReportOutput> {
  let say = |stage: &str, message: &str| emit("uitest://report", json!({ "stage": stage, "message": message }));
  let format = req.format.trim().to_ascii_lowercase();
  if !matches!(format.as_str(), "docx" | "pdf" | "md") {
    return Err(invalid("format must be \"docx\", \"pdf\" or \"md\"."));
  }
  let shots = match req.screenshots.trim() {
    "" | "all" => "all",
    "failed" => "failed",
    "none" => "none",
    _ => return Err(invalid("screenshots must be \"all\", \"failed\" or \"none\".")),
  };
  let target = PathBuf::from(req.path.trim());
  if req.path.trim().is_empty() || !target.is_absolute() {
    return Err(invalid("Choose where to save the document (an absolute path)."));
  }
  let template = match req.template_path.trim() {
    "" => None,
    p if format == "docx" => Some(load_template(p)?),
    _ => None,
  };

  say("writing", "Reading the run results");
  let l = load(a, &req).await?;
  say("writing", "Writing the document text");
  let texts = match ask_texts(a, &l.suite, build_text_prompt(&text_input(&l, &req, shots))).await {
    Ok(answer) => parse_texts(&answer),
    Err(e) => {
      crate::assistant::log_warn(&format!("uitest report: using plain text, the text call failed: {e}"));
      Texts::default()
    }
  };
  let off = local_offset_min();
  let run_at = if l.started_at > 0 { l.started_at } else { crate::db::now() };
  let title = [req.title.trim(), req.user_story.trim(), l.suite.name.trim()].into_iter().find(|t| !t.is_empty()).unwrap_or("Unit Test").to_string();
  let meta = Meta {
    title: title.clone(),
    suite: l.suite.name.clone(),
    user_story: req.user_story.trim().to_string(),
    iteration: req.iteration.trim().to_string(),
    environment: env_label(&l.env, &l.base_url),
    prepared_by: req.prepared_by.trim().to_string(),
    date: format_date(run_at, off),
  };
  let doc = assemble(meta, &l.cases, &texts, shots);
  let bl = blocks(&doc);

  say("rendering", "Building the document");
  if let Some(parent) = target.parent() {
    std::fs::create_dir_all(parent)?;
  }
  let mut files = Vec::new();
  match format.as_str() {
    "docx" => {
      let bytes = render_docx(&bl, template.as_ref())?;
      say("saving", "Saving the Word document");
      std::fs::write(&target, bytes)?;
      files.push(target.to_string_lossy().into_owned());
    }
    "pdf" => {
      say("rendering", "Converting to PDF");
      html_to_pdf(data_dir, &render_html(&bl, &title), &target).await?;
      files.push(target.to_string_lossy().into_owned());
    }
    _ => {
      let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "report".into());
      let dir_name = format!("{stem}_files");
      let imgs: Vec<&Image> = bl.iter().filter_map(|b| if let Block::Figure { img, .. } = b { Some(img) } else { None }).collect();
      say("saving", "Saving the Markdown document");
      let dir = target.parent().unwrap_or(Path::new("")).join(&dir_name);
      if !imgs.is_empty() {
        std::fs::create_dir_all(&dir)?;
      }
      std::fs::write(&target, render_md(&bl, &dir_name))?;
      files.push(target.to_string_lossy().into_owned());
      for img in imgs {
        let p = dir.join(&img.name);
        std::fs::write(&p, &img.bytes)?;
        files.push(p.to_string_lossy().into_owned());
      }
    }
  }
  say("done", "The document is ready");
  Ok(ReportOutput { path: target.to_string_lossy().into_owned(), files })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::uitest::UiTestStep;

  fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
      c ^= u32::from(b);
      for _ in 0..8 {
        c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
      }
    }
    !c
  }

  fn adler(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
      a = (a + u32::from(x)) % 65_521;
      b = (b + a) % 65_521;
    }
    (b << 16) | a
  }

  /// A valid RGB PNG (stored deflate blocks), a gradient so it is not blank.
  pub(super) fn test_png(w: u32, h: u32, seed: u8) -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..h {
      raw.push(0);
      for x in 0..w {
        raw.extend([(x * 255 / w.max(1)) as u8, (y * 255 / h.max(1)) as u8, seed]);
      }
    }
    let mut z = vec![0x78, 0x01];
    let mut chunks = raw.chunks(65_535).peekable();
    while let Some(c) = chunks.next() {
      z.push(u8::from(chunks.peek().is_none()));
      z.extend((c.len() as u16).to_le_bytes());
      z.extend((!(c.len() as u16)).to_le_bytes());
      z.extend(c);
    }
    z.extend(adler(&raw).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
      out.extend((data.len() as u32).to_be_bytes());
      let mut body = kind.to_vec();
      body.extend(data);
      out.extend(&body);
      out.extend(crc32(&body).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend(w.to_be_bytes());
    ihdr.extend(h.to_be_bytes());
    ihdr.extend([8, 2, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
  }

  /// Checks tags nest and close and `&` only starts an entity.
  fn assert_well_formed(xml: &str) {
    let mut stack: Vec<String> = Vec::new();
    let mut rest = xml;
    let mut roots = 0;
    while let Some(i) = rest.find('<') {
      let text = &rest[..i];
      assert!(!text.contains('>'), "stray > in text: {text}");
      let mut t = text;
      while let Some(p) = t.find('&') {
        let tail = &t[p..];
        let semi = tail.find(';').expect("unterminated entity");
        let ent = &tail[1..semi];
        assert!(matches!(ent, "amp" | "lt" | "gt" | "quot" | "apos") || ent.starts_with('#'), "bad entity &{ent};");
        t = &tail[semi..];
      }
      let end = rest[i..].find('>').expect("unterminated tag") + i;
      let tag = &rest[i + 1..end];
      if tag.starts_with('?') || tag.starts_with('!') {
      } else if let Some(name) = tag.strip_prefix('/') {
        assert_eq!(stack.pop().as_deref(), Some(name.trim()), "mismatched close {name}");
      } else {
        let selfclose = tag.ends_with('/');
        let name = tag.trim_end_matches('/').split_whitespace().next().unwrap().to_string();
        assert!(tag.matches('"').count() % 2 == 0, "odd quotes in <{tag}>");
        if stack.is_empty() {
          roots += 1;
        }
        if !selfclose {
          stack.push(name);
        }
      }
      rest = &rest[end + 1..];
    }
    assert!(stack.is_empty(), "unclosed: {stack:?}");
    assert_eq!(roots, 1);
  }

  fn sample_with(dir: &Path, shots: &str, texts: &Texts, cases: usize, real: &[Vec<u8>]) -> Doc {
    let counter = std::cell::Cell::new(0usize);
    let write = |name: &str, w, h, seed| {
      let p = dir.join(name);
      let i = counter.get();
      counter.set(i + 1);
      let bytes = if real.is_empty() { test_png(w, h, seed) } else { real[i % real.len()].clone() };
      std::fs::write(&p, bytes).unwrap();
      p.to_string_lossy().into_owned()
    };
    let s = |step, st: &str, note: &str, shot: String| UiStepResult { step, status: st.into(), note: note.into(), screenshot: shot };
    let mut run = vec![
      (
        RunCase {
          case_id: "c1".into(),
          title: "Asset filter narrows the grid".into(),
          status: "passed".into(),
          reason: "ok".into(),
          steps: vec![s(1, "passed", "The mashup loaded with a snapshot of 12 rows", write("a1.png", 640, 360, 40)), s(2, "passed", "Grid showed 1 row", write("a2.png", 640, 360, 120))],
        },
        UiTestCase {
          id: "c1".into(),
          ado_id: Some(12345),
          title: "Asset filter narrows the grid".into(),
          steps: vec![
            UiTestStep { action: "Open the Asset mashup".into(), expected: "The grid lists all assets".into() },
            UiTestStep { action: "Type 'PUMP-01' in the Asset filter".into(), expected: "Only PUMP-01 is listed".into() },
          ],
          ..Default::default()
        },
      ),
      (
        RunCase {
          case_id: "c2".into(),
          title: "Save & close <dialog>".into(),
          status: "failed".into(),
          reason: "The AI saw an error toast after Save".into(),
          steps: vec![s(1, "passed", "", write("b1.png", 1600, 900, 200)), s(2, "failed", "Error toast 'Save failed' was shown", write("b2.png", 1600, 900, 220))],
        },
        UiTestCase {
          id: "c2".into(),
          title: "Save & close <dialog>".into(),
          steps: vec![
            UiTestStep { action: "Click Edit".into(), expected: "Dialog opens".into() },
            UiTestStep { action: "Click Save".into(), expected: "Dialog closes with no error".into() },
          ],
          ..Default::default()
        },
      ),
    ];
    run.truncate(cases);
    let meta = Meta {
      title: "US 12345 - Asset filter".into(),
      suite: "Asset Manager".into(),
      user_story: "12345 - Asset filter".into(),
      iteration: "1.18".into(),
      environment: "ThingWorx test server (twx.example.com)".into(),
      prepared_by: "Jane Tester".into(),
      date: "20-Nov-2026".into(),
    };
    assemble(meta, &run, texts, shots)
  }

  fn sample(dir: &Path, shots: &str, texts: &Texts) -> Doc {
    sample_with(dir, shots, texts, 2, &[])
  }

  const MODEL_JSON: &str = r#"```json
{"application":"Asset Manager - Asset grid, Edit dialog","expected":"The Asset filter narrows the grid and Save closes the dialog.","summary":"Overall result: FAIL. One of two cases passed.","overall":"FAIL",
 "cases":[{"caseId":"c1","scenario":"Open Asset mashup, filter on PUMP-01","expected":"Only PUMP-01 is listed.","actual":"As expected. One row shown."},
          {"caseId":"c2","scenario":"Edit an asset and click Save","expected":"Dialog closes with no error.","actual":"An error toast Save failed was shown."}],
 "captions":[{"caseId":"c1","step":1,"caption":"Asset mashup before filtering. The grid lists 12 assets."},{"caseId":"c2","step":"2","caption":"Edit dialog after Save. An error toast is shown."}],
 "issues":[{"caseId":"c2","text":"Save showed an error toast and the dialog stayed open."}]}
```"#;

  fn docx_part(bytes: &[u8], name: &str) -> String {
    use std::io::Read as _;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
  }

  #[test]
  fn scrub_removes_tooling_words() {
    assert_eq!(scrub("The AI clicked Save using Playwright snapshot."), "The tester clicked Save using page check.");
    assert_eq!(scrub("The model used MCP browser_click on the Claude page"), "The tester used on the page");
    assert_eq!(scrub("Assistant opened the page; see the transcript and prompts"), "Tester opened the page; see the record and instructions");
    assert_eq!(scrub("An LLM (GPT-4) read it"), "The tester read it");
    assert_eq!(scrub("Used the language model and artificial intelligence"), "Used the tester and");
    assert_eq!(scrub("One case needs review; two need review"), "One case needs a further check; two need a further check");
    // Ordinary words stay.
    assert_eq!(scrub("Said maintain; the Tools menu and Assistants grid"), "Said maintain; the Tools menu and Testers grid");
    assert_eq!(scrub("Clicked the Details tab"), "Clicked the Details tab");
  }

  #[test]
  fn png_and_jpeg_sizes() {
    assert_eq!(image_size(&test_png(640, 360, 1)), Some((640, 360)));
    assert_eq!(image_size(b"not an image at all, really"), None);
    let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x01, 0x2C, 0x02, 0x58, 0x03, 0x01, 0x11, 0x00];
    assert_eq!(image_size(&jpeg), Some((600, 300)));
    assert_eq!(fit_emu(400, 300), (400 * 9525, 300 * 9525));
    let (cx, cy) = fit_emu(1600, 900);
    assert_eq!(cx, MAX_W_EMU);
    assert!(cy < 900 * 9525);
  }

  #[test]
  fn dates() {
    assert_eq!(format_date(0, 0), "01-Jan-1970");
    assert_eq!(format_date(1_795_183_500, 330), "20-Nov-2026");
    assert_eq!(env_label("TEST", "https://twx.example.com/Thingworx"), "ThingWorx test server (twx.example.com)");
    assert_eq!(env_label("test", ""), "ThingWorx test server");
  }

  #[test]
  fn parses_model_json_and_survives_garbage() {
    let t = parse_texts(MODEL_JSON);
    assert_eq!((t.application.as_deref(), t.expected.as_deref()), (Some("Asset Manager - Asset grid, Edit dialog"), Some("The Asset filter narrows the grid and Save closes the dialog.")));
    assert_eq!(t.cases["c1"].scenario.as_deref(), Some("Open Asset mashup, filter on PUMP-01"));
    assert_eq!(t.cases["c2"].actual.as_deref(), Some("An error toast Save failed was shown."));
    assert_eq!(t.captions[&("c2".to_string(), 2)], "Edit dialog after Save. An error toast is shown.");
    assert_eq!(t.issues["c2"], "Save showed an error toast and the dialog stayed open.");
    for bad in ["", "no json here", "{not json", "```json\n{\"foo\":1}\n```", "[1,2]"] {
      let t = parse_texts(bad);
      assert!(t.application.is_none() && t.cases.is_empty(), "{bad}");
    }
  }

  #[test]
  fn fallback_text_when_model_fails() {
    let dir = tempfile::tempdir().unwrap();
    let d = sample(dir.path(), "all", &parse_texts("total garbage"));
    assert_eq!(d.application, "Asset Manager");
    assert_eq!(d.summary, "Overall result: FAIL. 1 of 2 test cases passed, 1 failed.");
    assert_eq!(d.cases[0].id, "12345");
    assert_eq!(d.cases[1].id, "TC-02");
    assert_eq!(d.cases[0].scenario, "Open the Asset mashup, Type 'PUMP-01' in the Asset filter");
    assert_eq!(d.cases[0].expected, "The grid lists all assets; Only PUMP-01 is listed.");
    // Notes are used, scrubbed.
    assert_eq!(d.cases[0].actual, "As expected. The mashup loaded with a page check of 12 rows; Grid showed 1 row.");
    assert_eq!(d.cases[1].actual, "Error toast 'Save failed' was shown.");
    assert_eq!((d.cases[0].status, d.cases[1].status), ("Pass", "Fail"));
    assert_eq!(d.issues.len(), 1);
    assert_eq!(d.issues[0].text, "The tester saw an error toast after Save");
    assert_eq!(d.figs[0].caption, "Asset filter narrows the grid, step 1");
    let all = format!("{}{}{}", d.application, d.expected, d.summary);
    assert!(!all.to_lowercase().contains("playwright"));
  }

  #[test]
  fn model_text_is_used_and_scrubbed() {
    let dir = tempfile::tempdir().unwrap();
    let d = sample(dir.path(), "all", &parse_texts(MODEL_JSON));
    // The document puts its own result first; the model's lead is not repeated.
    assert_eq!(d.summary, "Overall result: FAIL. One of two cases passed.");
    assert_eq!(d.cases[1].scenario, "Edit an asset and click Save");
    assert_eq!(d.cases[0].actual, "As expected. One row shown.");
    assert_eq!(d.figs[0].caption, "Asset mashup before filtering. The grid lists 12 assets.");
    assert_eq!(d.figs[3].caption, "Edit dialog after Save. An error toast is shown.");
    assert_eq!(d.issues[0].text, "Save showed an error toast and the dialog stayed open.");
  }

  #[test]
  fn screenshot_modes() {
    let dir = tempfile::tempdir().unwrap();
    let count = |m: &str| sample(dir.path(), m, &Texts::default()).figs.len();
    assert_eq!((count("all"), count("failed"), count("none")), (4, 1, 0));
  }

  #[test]
  fn docx_has_one_case_table_and_figures_at_the_end() {
    let dir = tempfile::tempdir().unwrap();
    let d = sample(dir.path(), "all", &parse_texts(MODEL_JSON));
    let bytes = render_docx(&blocks(&d), None).unwrap();
    let names: Vec<String> = zip::ZipArchive::new(std::io::Cursor::new(bytes.clone())).unwrap().file_names().filter_map(|n| n.ok().map(|c| c.into_owned())).collect();
    for part in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels", "word/media/image1.png", "word/media/image4.png"] {
      assert!(names.iter().any(|n| n == part), "missing {part}: {names:?}");
    }
    for part in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels"] {
      assert_well_formed(&docx_part(&bytes, part));
    }
    let s = docx_part(&bytes, "word/document.xml");
    // Info, summary and one table for every case: three tables in all, not one per case.
    assert_eq!(s.matches("<w:tbl>").count(), 3);
    assert_eq!(s.matches("<w:drawing>").count(), 4);
    for h in ["1. What was expected", "2. Summary", "3. Test cases", "4. Screenshots", "5. Open issues"] {
      assert!(s.contains(h), "{h}");
    }
    // Order: case table, then screenshots, then issues.
    let (t, sh, oi) = (s.find("3. Test cases").unwrap(), s.find("4. Screenshots").unwrap(), s.find("5. Open issues").unwrap());
    assert!(t < sh && sh < oi);
    assert!(s.find("Figure 1 - ").unwrap() > sh && s.rfind("Figure 4 - ").unwrap() < oi);
    assert!(s.contains("Figure 1 - Asset mashup before filtering. The grid lists 12 assets. (12345)"));
    assert!(s.contains("Unit Test Results") && s.contains("<w:t xml:space=\"preserve\">Item</w:t>") && s.contains("Tested by"));
    assert!(s.contains("C6EFCE") && s.contains("FFC7CE"));
    assert!(s.contains("<w:numId w:val=\"1\"/>") && s.contains("w:val=\"ListBullet\""));
    assert!(!s.contains("•"));
    for gone in ["Purpose", "Scope", "Sign-off", "Preconditions", "Needs review"] {
      assert!(!s.contains(gone), "{gone}");
    }
    assert!(docx_part(&bytes, "word/numbering.xml").contains("w:numFmt w:val=\"bullet\""));
    let styles = docx_part(&bytes, "word/styles.xml");
    for id in ["Title", "Subtitle", "Heading1", "Caption", "ListBullet", "ReportTable"] {
      assert!(styles.contains(&format!("w:styleId=\"{id}\"")), "{id}");
    }
  }

  #[test]
  fn all_passed_has_no_issues_section_or_review_row() {
    let dir = tempfile::tempdir().unwrap();
    let d = sample_with(dir.path(), "all", &Texts::default(), 1, &[]);
    assert!(d.pass && d.issues.is_empty());
    let b = blocks(&d);
    assert!(!b.iter().any(|x| matches!(x, Block::H1(t) if t.contains("Open issues"))));
    assert!(!b.iter().any(|x| matches!(x, Block::Bullets(_))));
    // One case: no case tag on the captions.
    let cap = b.iter().find_map(|x| if let Block::Figure { caption, .. } = x { Some(caption.clone()) } else { None }).unwrap();
    assert_eq!(cap, "Figure 1 - Asset filter narrows the grid, step 1");
    let md = render_md(&b, "f");
    assert!(md.contains("Overall result: PASS."));
    assert!(!md.contains("Needs review"));
    // Without screenshots the issues would be section 4.
    let d = sample_with(dir.path(), "none", &Texts::default(), 2, &[]);
    assert!(blocks(&d).iter().any(|x| matches!(x, Block::H1(t) if t == "4. Open issues")));
  }

  #[test]
  fn template_styles_are_copied_and_gaps_filled() {
    let dir = tempfile::tempdir().unwrap();
    let styles = r#"<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Garamond"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:color w:val="123456"/></w:rPr></w:style></w:styles>"#;
    let tpl_path = dir.path().join("tpl.docx");
    {
      let mut zw = zip::ZipWriter::new(std::fs::File::create(&tpl_path).unwrap());
      let o = SimpleFileOptions::default();
      for (n, d) in [("word/styles.xml", styles), ("word/theme/theme1.xml", "<a:theme xmlns:a=\"x\"/>"), ("word/fontTable.xml", "<w:fonts xmlns:w=\"x\"/>")] {
        zw.start_file(n, o).unwrap();
        zw.write_all(d.as_bytes()).unwrap();
      }
      zw.finish().unwrap();
    }
    assert!(load_template(&dir.path().join("missing.docx").to_string_lossy()).is_err());
    let tpl = load_template(&tpl_path.to_string_lossy()).unwrap();
    let d = sample(dir.path(), "all", &Texts::default());
    let bytes = render_docx(&blocks(&d), Some(&tpl)).unwrap();
    for part in ["word/styles.xml", "[Content_Types].xml", "word/_rels/document.xml.rels", "word/theme/theme1.xml", "word/fontTable.xml"] {
      assert_well_formed(&docx_part(&bytes, part));
    }
    let s = docx_part(&bytes, "word/styles.xml");
    assert!(s.contains("Garamond") && s.contains("123456"));
    // The template's own Title stays as it was; the styles it lacks are appended once.
    assert_eq!(s.matches("w:styleId=\"Title\"").count(), 1);
    for id in ["Subtitle", "Heading1", "Caption", "ListBullet", "TableText", "TableNormal", "ReportTable"] {
      assert_eq!(s.matches(&format!("w:styleId=\"{id}\"")).count(), 1, "{id}");
    }
    assert!(!s.contains("w:color w:val=\"1F3864\"/><w:sz w:val=\"40\""));
    assert!(docx_part(&bytes, "[Content_Types].xml").contains("/word/theme/theme1.xml"));
    assert!(docx_part(&bytes, "word/_rels/document.xml.rels").contains("fontTable.xml"));
    // A file that is not a Word document is refused.
    let bad = dir.path().join("bad.docx");
    std::fs::write(&bad, b"nope").unwrap();
    assert!(load_template(&bad.to_string_lossy()).is_err());
  }

  #[test]
  fn markdown_links_images_relatively() {
    let dir = tempfile::tempdir().unwrap();
    let d = sample(dir.path(), "all", &Texts::default());
    let md = render_md(&blocks(&d), "my report_files");
    assert!(md.contains("![Figure 3 - Save & close &lt;dialog&gt;, step 1 (TC-02)](my%20report_files/case-2-step-1.png)"), "{md}");
    assert!(md.contains("| ID | Test case | Expected | Actual | Status |"));
    assert!(md.contains("## 4. Screenshots") && md.contains("## 5. Open issues"));
    assert!(md.contains("- TC-02: The tester saw an error toast after Save"));
    assert!(md.contains("| Item | Detail |") && md.contains("| Item | Value |"));
  }

  #[test]
  fn html_embeds_images() {
    let dir = tempfile::tempdir().unwrap();
    let d = sample(dir.path(), "failed", &Texts::default());
    let h = render_html(&blocks(&d), "T");
    assert_eq!(h.matches("data:image/png;base64,").count(), 1);
    assert!(h.contains("page-break-inside: avoid"));
    assert!(h.contains("Unit Test Results"));
  }

  /// Writes sample files to `$REPORT_SAMPLE_DIR` for a look; `docx` and `md` always, `pdf` needs Edge.
  /// `$REPORT_SAMPLE_PNGS` (a folder of PNGs) supplies realistic screenshots, `$REPORT_TEMPLATE` a style template.
  fn write_samples(pdf: bool) {
    let Some(out) = std::env::var_os("REPORT_SAMPLE_DIR").map(PathBuf::from) else { return };
    let shots = out.join("shots");
    std::fs::create_dir_all(&shots).unwrap();
    let mut real: Vec<Vec<u8>> = Vec::new();
    if let Some(d) = std::env::var_os("REPORT_SAMPLE_PNGS") {
      let mut files: Vec<PathBuf> = std::fs::read_dir(d).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "png")).collect();
      files.sort();
      real = files.iter().map(|p| std::fs::read(p).unwrap()).collect();
    }
    let d = sample_with(&shots, "all", &parse_texts(MODEL_JSON), 2, &real);
    let bl = blocks(&d);
    std::fs::write(out.join("sample.docx"), render_docx(&bl, None).unwrap()).unwrap();
    if let Some(t) = std::env::var_os("REPORT_TEMPLATE") {
      let tpl = load_template(&t.to_string_lossy()).unwrap();
      std::fs::write(out.join("sample-templated.docx"), render_docx(&bl, Some(&tpl)).unwrap()).unwrap();
    }
    std::fs::write(out.join("sample.md"), render_md(&bl, "sample_files")).unwrap();
    std::fs::create_dir_all(out.join("sample_files")).unwrap();
    for b in &bl {
      if let Block::Figure { img, .. } = b {
        std::fs::write(out.join("sample_files").join(&img.name), &img.bytes).unwrap();
      }
    }
    if pdf {
      let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
      rt.block_on(html_to_pdf(&out, &render_html(&bl, &d.meta.title), &out.join("sample.pdf"))).unwrap();
    }
  }

  #[test]
  fn samples_docx_md() {
    write_samples(false);
  }

  #[test]
  #[ignore = "needs Microsoft Edge"]
  fn samples_pdf() {
    write_samples(true);
  }
}
