//! Normalises entity XML exported from ThingWorx so it diffs cleanly: one
//! attribute per line, four-space indents, and the per-export noise
//! (`lastModifiedDate`, `Owner`, build stamps) stripped. Byte for byte the
//! output of singl-web's `xmlformat.ts`.

use std::sync::LazyLock;

use regex::Regex;

const ENTITIES_STRIP_ATTRS: &[&str] = &["build", "modelPersistenceProviderPackage", "revision", "schemaVersion"];

static XML_DECL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<\?xml[^?]*\?>\s*").unwrap());
static ENTITIES_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<Entities([^>]*)>").unwrap());
static LAST_MODIFIED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\s+lastModifiedDate="[^"]*""#).unwrap());
static OWNER_EMPTY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]*<Owner[^>]*/>\n?").unwrap());
static OWNER_FULL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]*<Owner[^>]*>.*?</Owner>\n?").unwrap());
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!\[CDATA\[.*?\]\]>|<[^>]+>").unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([A-Za-z0-9_:.-]+)="([^"]*)""#).unwrap());
static FILTER_ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([A-Za-z0-9_][A-Za-z0-9_.-]*)="([^"]*)""#).unwrap());

pub fn format_entity_xml(raw: &str) -> String {
  let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
  let xml = XML_DECL.replace(raw, "");
  let xml = pretty_print(&xml);

  let xml = ENTITIES_TAG.replace(&xml, |caps: &regex::Captures| format!("<Entities{}>", filter_entities_attrs(&caps[1])));
  let xml = LAST_MODIFIED.replace_all(&xml, "");
  let xml = OWNER_EMPTY.replace_all(&xml, "");
  let xml = OWNER_FULL.replace_all(&xml, "");
  let xml = BLANK_RUNS.replace_all(&xml, "\n");

  format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{}\n", xml.trim())
}

fn filter_entities_attrs(attrs: &str) -> String {
  let kept: Vec<String> = FILTER_ATTR
    .captures_iter(attrs)
    .filter(|c| !ENTITIES_STRIP_ATTRS.contains(&&c[1]))
    .map(|c| if &c[1] == "universal" { r#"universal="password""#.to_string() } else { format!("{}=\"{}\"", &c[1], &c[2]) })
    .collect();
  if kept.is_empty() { String::new() } else { format!("\n {}", kept.join("\n ")) }
}

enum Token<'a> {
  Cdata(&'a str),
  Tag(&'a str),
  Text(&'a str),
}

fn tokenize(xml: &str) -> Vec<Token<'_>> {
  let mut tokens = Vec::new();
  let mut last = 0;
  for m in TOKEN.find_iter(xml) {
    let text = xml[last..m.start()].trim();
    if !text.is_empty() {
      tokens.push(Token::Text(text));
    }
    let value = m.as_str();
    tokens.push(if value.starts_with("<![CDATA[") { Token::Cdata(value) } else { Token::Tag(value) });
    last = m.end();
  }
  let text = xml[last..].trim();
  if !text.is_empty() {
    tokens.push(Token::Text(text));
  }
  tokens
}

fn parse_tag(tag: &str) -> (&str, Vec<String>) {
  let inner = tag.strip_prefix("</").or_else(|| tag.strip_prefix('<')).unwrap_or(tag);
  let inner = inner.strip_suffix("/>").or_else(|| inner.strip_suffix('>')).unwrap_or(inner).trim();
  let (name, rest) = match inner.find(char::is_whitespace) {
    Some(i) => (&inner[..i], &inner[i..]),
    None => (inner, ""),
  };
  (name, ATTR.captures_iter(rest).map(|c| format!("{}=\"{}\"", &c[1], &c[2])).collect())
}

fn open_tag(name: &str, attrs: &[String], prefix: &str) -> String {
  if attrs.is_empty() {
    format!("<{name}>")
  } else {
    format!("<{name}\n{prefix} {}>", attrs.join(&format!("\n{prefix} ")))
  }
}

fn open_close(name: &str, attrs: &[String], prefix: &str) -> String {
  if attrs.is_empty() {
    format!("{prefix}<{name}></{name}>")
  } else {
    format!("{prefix}<{name}\n{prefix} {}></{name}>", attrs.join(&format!("\n{prefix} ")))
  }
}

fn is_self_closing(tag: &str) -> bool {
  let second = tag.as_bytes().get(1).copied();
  tag.len() > 3 && tag.ends_with("/>") && !matches!(second, Some(b'/' | b'!' | b'?'))
}

fn pretty_print(xml: &str) -> String {
  let tokens = tokenize(xml);
  let mut lines: Vec<String> = Vec::new();
  let mut depth = 0usize;
  let pad = |d: usize| "    ".repeat(d);

  let mut i = 0;
  while i < tokens.len() {
    match tokens[i] {
      Token::Cdata(value) => {
        let inner = &value[9..value.len() - 3];
        lines.push(format!("{}<![CDATA[", pad(depth)));
        lines.extend(inner.split('\n').map(String::from));
        lines.push(format!("{}]]>", pad(depth)));
      }
      Token::Text(value) => lines.push(format!("{}{value}", pad(depth))),
      Token::Tag(tag) if is_self_closing(tag) => {
        let (name, attrs) = parse_tag(tag);
        lines.push(open_close(name, &attrs, &pad(depth)));
      }
      Token::Tag(tag) if tag.starts_with("</") => {
        depth = depth.saturating_sub(1);
        lines.push(format!("{}{tag}", pad(depth)));
      }
      Token::Tag(tag) if tag.starts_with("<!") || tag.starts_with("<?") => lines.push(format!("{}{tag}", pad(depth))),
      Token::Tag(tag) => {
        let (name, attrs) = parse_tag(tag);
        let close = format!("</{name}>");
        let is_close = |t: Option<&Token>| matches!(t, Some(Token::Tag(v)) if *v == close);
        if let (Some(Token::Text(text)), true) = (tokens.get(i + 1), is_close(tokens.get(i + 2))) {
          lines.push(format!("{}{}{text}{close}", pad(depth), open_tag(name, &attrs, &pad(depth))));
          i += 3;
          continue;
        }
        if is_close(tokens.get(i + 1)) {
          lines.push(open_close(name, &attrs, &pad(depth)));
          i += 2;
          continue;
        }
        lines.push(format!("{}{}", pad(depth), open_tag(name, &attrs, &pad(depth))));
        depth += 1;
      }
    }
    i += 1;
  }
  lines.join("\n")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn formats_like_singl_web() {
    let raw = "\u{feff}<?xml version=\"1.0\"?><Entities build=\"b\" majorVersion=\"9\" universal=\"x\"><Things><Thing name=\"T\" lastModifiedDate=\"2020\"><Owner name=\"a\" type=\"User\"/><description>Hi</description><Empty a=\"1\"></Empty><Self/><code><![CDATA[\n  x();\n]]></code></Thing></Things></Entities>";
    let expected = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Entities\n majorVersion=\"9\"\n universal=\"password\">\n    <Things>\n        <Thing\n         name=\"T\">\n            <description>Hi</description>\n            <Empty\n             a=\"1\"></Empty>\n            <Self></Self>\n            <code>\n                <![CDATA[\n\n  x();\n\n                ]]>\n            </code>\n        </Thing>\n    </Things>\n</Entities>\n";
    assert_eq!(format_entity_xml(raw), expected);
  }
}
