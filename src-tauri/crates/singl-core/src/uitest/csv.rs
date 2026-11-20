//! Azure DevOps Test Plans CSV: reads test cases for import and writes them for export.
//! Pure functions with RFC 4180 quoting, hand written so no crate is needed.

/// One numbered step of a test case.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CsvStep {
  pub action: String,
  pub expected: String,
}

/// One test case and its steps, as Azure lays them out.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CsvCase {
  pub ado_id: Option<i64>,
  pub title: String,
  pub area_path: String,
  pub assigned_to: String,
  pub state: String,
  pub tags: String,
  pub steps: Vec<CsvStep>,
}

const HEADER: [&str; 10] = [
  "ID",
  "Work Item Type",
  "Title",
  "Test Step",
  "Step Action",
  "Step Expected",
  "Area Path",
  "Assigned To",
  "State",
  "Tags",
];

/// A parsed record: its 1-based starting line and its cells.
type Record = (usize, Vec<String>);

/// Column positions looked up by header name.
struct Columns {
  id: Option<usize>,
  work_item_type: Option<usize>,
  title: usize,
  test_step: Option<usize>,
  action: Option<usize>,
  expected: Option<usize>,
  area_path: Option<usize>,
  assigned_to: Option<usize>,
  state: Option<usize>,
  tags: Option<usize>,
}

/// Parses Azure Test Plans CSV text into test cases. Errors name the line.
pub fn parse_azure_csv(text: &str) -> Result<Vec<CsvCase>, String> {
  let text = text.strip_prefix('\u{feff}').unwrap_or(text);
  let mut records = read_records(text)?;
  records.retain(|(_, cells)| cells.iter().any(|c| !c.trim().is_empty()));
  if records.is_empty() {
    return Err("The CSV is empty.".to_string());
  }

  let (_, header) = records.remove(0);
  let names: Vec<String> = header.iter().map(|h| h.trim().to_ascii_lowercase()).collect();
  let find = |name: &str| names.iter().position(|h| h == name);
  let Some(title) = find("title") else {
    return Err("The header row has no Title column.".to_string());
  };
  let cols = Columns {
    id: find("id"),
    work_item_type: find("work item type"),
    title,
    test_step: find("test step"),
    action: find("step action"),
    expected: find("step expected"),
    area_path: find("area path"),
    assigned_to: find("assigned to"),
    state: find("state"),
    tags: find("tags"),
  };

  let mut cases: Vec<CsvCase> = Vec::new();
  for (line, row) in &records {
    let work_item_type = cell(row, cols.work_item_type).trim();
    let title = cell(row, Some(cols.title));
    let step_number = cell(row, cols.test_step).trim();
    let is_case = work_item_type.eq_ignore_ascii_case("Test Case")
      || (work_item_type.is_empty() && !title.trim().is_empty() && step_number.is_empty());
    if is_case {
      cases.push(CsvCase {
        ado_id: cell(row, cols.id).trim().parse::<i64>().ok(),
        title: title.to_string(),
        area_path: cell(row, cols.area_path).to_string(),
        assigned_to: cell(row, cols.assigned_to).to_string(),
        state: cell(row, cols.state).to_string(),
        tags: cell(row, cols.tags).to_string(),
        steps: Vec::new(),
      });
      continue;
    }
    let action = clean_html(cell(row, cols.action));
    let expected = clean_html(cell(row, cols.expected));
    if work_item_type.is_empty() && title.trim().is_empty() && (!action.is_empty() || !expected.is_empty()) {
      match cases.last_mut() {
        Some(case) => case.steps.push(CsvStep { action, expected }),
        None => return Err(format!("Line {line}: step row before any test case.")),
      }
    }
    // Any other row (a non-test-case work item, say) is ignored.
  }
  Ok(cases)
}

/// Writes test cases as Azure CSV: BOM, CRLF line ends, one step row per step.
pub fn export_azure_csv(cases: &[CsvCase]) -> String {
  let mut out = String::from("\u{feff}");
  push_row(&mut out, &HEADER);
  for case in cases {
    let id = case.ado_id.map(|id| id.to_string()).unwrap_or_default();
    push_row(
      &mut out,
      &[&id, "Test Case", &case.title, "", "", "", &case.area_path, &case.assigned_to, &case.state, &case.tags],
    );
    for (i, step) in case.steps.iter().enumerate() {
      let number = (i + 1).to_string();
      push_row(&mut out, &["", "", "", &number, &step.action, &step.expected, "", "", "", ""]);
    }
  }
  out
}

fn cell(row: &[String], index: Option<usize>) -> &str {
  index.and_then(|i| row.get(i)).map_or("", String::as_str)
}

fn push_row(out: &mut String, cells: &[&str]) {
  let quoted: Vec<String> = cells.iter().map(|c| quote(c)).collect();
  out.push_str(&quoted.join(","));
  out.push_str("\r\n");
}

/// Wraps a cell in quotes, doubling inner quotes, when it needs them.
fn quote(cell: &str) -> String {
  if cell.chars().any(|c| matches!(c, ',' | '"' | '\r' | '\n')) {
    format!("\"{}\"", cell.replace('"', "\"\""))
  } else {
    cell.to_string()
  }
}

/// Splits CSV text into records per RFC 4180. Quoted fields may hold commas and line breaks.
fn read_records(text: &str) -> Result<Vec<Record>, String> {
  let mut records: Vec<Record> = Vec::new();
  let mut row: Vec<String> = Vec::new();
  let mut field = String::new();
  let mut in_quotes = false;
  let mut line = 1;
  let mut start = 1;
  let mut chars = text.chars().peekable();
  while let Some(c) = chars.next() {
    if in_quotes {
      match c {
        '"' if chars.peek() == Some(&'"') => {
          chars.next();
          field.push('"');
        }
        '"' => in_quotes = false,
        '\n' => {
          line += 1;
          field.push(c);
        }
        _ => field.push(c),
      }
      continue;
    }
    match c {
      '"' if field.is_empty() => in_quotes = true,
      ',' => row.push(std::mem::take(&mut field)),
      '\r' | '\n' => {
        if c == '\r' && chars.peek() == Some(&'\n') {
          chars.next();
        }
        line += 1;
        row.push(std::mem::take(&mut field));
        records.push((start, std::mem::take(&mut row)));
        start = line;
      }
      _ => field.push(c),
    }
  }
  if in_quotes {
    return Err(format!("Line {start}: a quoted field is never closed."));
  }
  if !field.is_empty() || !row.is_empty() {
    row.push(field);
    records.push((start, row));
  }
  Ok(records)
}

/// Turns Azure's HTML step text into plain lines: breaks become newlines, other tags go,
/// entities decode, and blank lines are dropped.
fn clean_html(raw: &str) -> String {
  let mut text = String::with_capacity(raw.len());
  let mut rest = raw;
  while let Some(pos) = rest.find('<') {
    text.push_str(&rest[..pos]);
    let tail = &rest[pos..];
    let is_tag = tail[1..].starts_with(|c: char| c.is_ascii_alphabetic() || c == '/' || c == '!');
    match tail.find('>') {
      Some(end) if is_tag => {
        let name: String = tail[1..end]
          .trim_start_matches('/')
          .trim()
          .chars()
          .take_while(|c| c.is_ascii_alphanumeric())
          .collect::<String>()
          .to_ascii_lowercase();
        let closing_block = tail.starts_with("</") && (name == "p" || name == "div");
        if name == "br" || closing_block {
          text.push('\n');
        }
        rest = &tail[end + 1..];
      }
      _ => {
        text.push('<');
        rest = &tail[1..];
      }
    }
  }
  text.push_str(rest);
  decode_entities(&text).lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
}

/// Decodes the entities Azure writes into step text, in one pass so `&amp;lt;` stays `&lt;`.
fn decode_entities(s: &str) -> String {
  const ENTITIES: [(&str, &str); 6] =
    [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'")];
  let mut out = String::with_capacity(s.len());
  let mut rest = s;
  while let Some(pos) = rest.find('&') {
    out.push_str(&rest[..pos]);
    let tail = &rest[pos..];
    match ENTITIES.iter().find(|(entity, _)| tail.starts_with(entity)) {
      Some((entity, plain)) => {
        out.push_str(plain);
        rest = &tail[entity.len()..];
      }
      None => {
        out.push('&');
        rest = &tail[1..];
      }
    }
  }
  out.push_str(rest);
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn step(action: &str, expected: &str) -> CsvStep {
    CsvStep { action: action.into(), expected: expected.into() }
  }

  #[test]
  fn quoting_survives_commas_quotes_and_newlines() {
    let case = CsvCase {
      ado_id: Some(7),
      title: "Login, \"quick\" test".into(),
      steps: vec![step("Enter user\nthen password", "Shows \"OK\", fast")],
      ..Default::default()
    };
    let csv = export_azure_csv(std::slice::from_ref(&case));
    assert!(csv.contains("\"Login, \"\"quick\"\" test\""));
    assert!(csv.contains("\"Enter user\nthen password\""));
    assert_eq!(parse_azure_csv(&csv).unwrap(), vec![case]);
  }

  #[test]
  fn reordered_headers_unknown_columns_and_case() {
    let csv = "tags,Extra,TITLE , work item type,id,step expected,Test Step,step action\r\n\
               smoke,ignored,Open page,test case,12,,,\r\n\
               ,ignored,,,,Page shows,1,Click save\r\n";
    let cases = parse_azure_csv(csv).unwrap();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].ado_id, Some(12));
    assert_eq!(cases[0].title, "Open page");
    assert_eq!(cases[0].tags, "smoke");
    assert_eq!(cases[0].steps, vec![step("Click save", "Page shows")]);
  }

  #[test]
  fn strips_html_and_decodes_entities() {
    let csv = "Work Item Type,Title,Step Action,Step Expected\n\
               Test Case,Html,,\n\
               ,,\"<DIV><P>Open&nbsp;the&nbsp;page</P></DIV><DIV>Click &amp; wait</DIV>\",\"<P>Shows&nbsp;<B>OK</B></P><br>Done\"\n\
               ,,\"if a < b &amp;lt;\",\n";
    let cases = parse_azure_csv(csv).unwrap();
    assert_eq!(cases[0].steps[0], step("Open the page\nClick & wait", "Shows OK\nDone"));
    assert_eq!(cases[0].steps[1], step("if a < b &lt;", ""));
  }

  #[test]
  fn skips_bom_blank_rows_and_accepts_lf() {
    let csv = "\u{feff}ID,Work Item Type,Title,Test Step,Step Action\n\n,,,,\n,Test Case,Shown,,\n,,,1,Go\n";
    let cases = parse_azure_csv(csv).unwrap();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].title, "Shown");
    assert_eq!(cases[0].ado_id, None);
    assert_eq!(cases[0].steps, vec![step("Go", "")]);
  }

  #[test]
  fn export_writes_bom_crlf_and_header() {
    let csv = export_azure_csv(&[CsvCase { title: "T".into(), ..Default::default() }]);
    assert!(csv.starts_with('\u{feff}'));
    assert!(csv.starts_with("\u{feff}ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Area Path,Assigned To,State,Tags\r\n"));
    assert!(!csv.replace("\r\n", "").contains('\n'));
    assert!(csv.ends_with("\r\n"));
  }

  #[test]
  fn round_trip_is_lossless() {
    let cases = vec![
      CsvCase {
        ado_id: Some(42),
        title: "Ünïcödé ✓ — case".into(),
        area_path: "Proj\\Area".into(),
        assigned_to: "a@b.com".into(),
        state: "Design".into(),
        tags: "smoke; ui".into(),
        steps: vec![step("Open", "Opened"), step("Type \"x\", then y", "")],
      },
      CsvCase { title: "No steps, no id".into(), ..Default::default() },
      CsvCase { ado_id: None, title: "Quote at end\"".into(), steps: vec![step("a", "b")], ..Default::default() },
    ];
    assert_eq!(parse_azure_csv(&export_azure_csv(&cases)).unwrap(), cases);
  }

  #[test]
  fn missing_work_item_type_column_uses_title_and_blank_step() {
    let csv = "ID,Title,Test Step,Step Action,Step Expected\r\n\
               ,Login,,,\r\n\
               ,,1,Open,Shows\r\n";
    let cases = parse_azure_csv(csv).unwrap();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].title, "Login");
    assert_eq!(cases[0].steps, vec![step("Open", "Shows")]);
  }

  #[test]
  fn step_before_any_case_is_an_error() {
    let csv = "ID,Work Item Type,Title,Test Step,Step Action,Step Expected\r\n\
               ,,,1,Open,Shows\r\n";
    assert_eq!(parse_azure_csv(csv).unwrap_err(), "Line 2: step row before any test case.");
  }

  #[test]
  fn missing_title_header_is_an_error() {
    let err = parse_azure_csv("ID,Work Item Type,Step Action\n1,Test Case,x\n").unwrap_err();
    assert_eq!(err, "The header row has no Title column.");
  }

  #[test]
  fn unclosed_quote_is_an_error() {
    let err = parse_azure_csv("ID,Work Item Type,Title\n,Test Case,\"open\n").unwrap_err();
    assert_eq!(err, "Line 2: a quoted field is never closed.");
  }

  #[test]
  fn non_numeric_id_is_none() {
    let cases = parse_azure_csv("ID,Work Item Type,Title\nabc,Test Case,One\n 9 ,test case,Two\n").unwrap();
    assert_eq!(cases[0].ado_id, None);
    assert_eq!(cases[1].ado_id, Some(9));
  }
}
