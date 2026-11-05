//! A small XML tree for reading ThingWorx entity files, which are generated
//! and well-formed. Text follows xml2js's defaults, which singl-web's gulp
//! task read them with: an element's text is all its text and CDATA joined,
//! and dropped when it is only whitespace and held no CDATA.

use crate::{CoreError, Result};

#[derive(Debug, Default)]
pub struct Element {
  pub name: String,
  pub attrs: Vec<(String, String)>,
  pub children: Vec<Element>,
  pub text: String,
}

impl Element {
  pub fn attr(&self, name: &str) -> Option<&str> {
    self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
  }

  pub fn child(&self, name: &str) -> Option<&Element> {
    self.children.iter().find(|c| c.name == name)
  }

  pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
    self.children.iter().filter(move |c| c.name == name)
  }

  /// Follows the first child of each name in turn.
  pub fn path(&self, names: &[&str]) -> Option<&Element> {
    names.iter().try_fold(self, |el, name| el.child(name))
  }
}

fn invalid(what: &str) -> CoreError {
  CoreError::Invalid(format!("Malformed XML: {what}"))
}

fn decode_entities(s: &str) -> String {
  if !s.contains('&') {
    return s.to_string();
  }
  let mut out = String::with_capacity(s.len());
  let mut rest = s;
  while let Some(i) = rest.find('&') {
    out.push_str(&rest[..i]);
    rest = &rest[i..];
    let Some(end) = rest.find(';').filter(|&e| e <= 12) else {
      out.push('&');
      rest = &rest[1..];
      continue;
    };
    let entity = &rest[1..end];
    let decoded = match entity {
      "amp" => Some('&'),
      "lt" => Some('<'),
      "gt" => Some('>'),
      "quot" => Some('"'),
      "apos" => Some('\''),
      _ => entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"))
        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
        .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
        .and_then(char::from_u32),
    };
    match decoded {
      Some(c) => {
        out.push(c);
        rest = &rest[end + 1..];
      }
      None => {
        out.push('&');
        rest = &rest[1..];
      }
    }
  }
  out.push_str(rest);
  out
}

fn parse_attrs(mut s: &str) -> Result<Vec<(String, String)>> {
  let mut attrs = Vec::new();
  loop {
    s = s.trim_start();
    if s.is_empty() {
      return Ok(attrs);
    }
    let eq = s.find('=').ok_or_else(|| invalid("attribute without a value"))?;
    let name = s[..eq].trim().to_string();
    let after = s[eq + 1..].trim_start();
    let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'').ok_or_else(|| invalid("unquoted attribute"))?;
    let close = after[1..].find(quote).ok_or_else(|| invalid("unterminated attribute"))?;
    attrs.push((name, decode_entities(&after[1..1 + close])));
    s = &after[close + 2..];
  }
}

/// Parses a document and returns its root element.
pub fn parse(xml: &str) -> Result<Element> {
  // Each open element, with whether it held CDATA.
  let mut stack: Vec<(Element, bool)> = vec![(Element::default(), false)];
  let mut rest = xml.strip_prefix('\u{feff}').unwrap_or(xml);

  while !rest.is_empty() {
    let Some(lt) = rest.find('<') else {
      push_text(&mut stack, rest, false);
      break;
    };
    if lt > 0 {
      push_text(&mut stack, &rest[..lt], false);
      rest = &rest[lt..];
    }
    if let Some(body) = rest.strip_prefix("<![CDATA[") {
      let end = body.find("]]>").ok_or_else(|| invalid("unterminated CDATA"))?;
      push_text(&mut stack, &body[..end], true);
      rest = &body[end + 3..];
    } else if let Some(body) = rest.strip_prefix("<!--") {
      rest = &body[body.find("-->").ok_or_else(|| invalid("unterminated comment"))? + 3..];
    } else if rest.starts_with("<?") || rest.starts_with("<!") {
      rest = &rest[rest.find('>').ok_or_else(|| invalid("unterminated declaration"))? + 1..];
    } else if let Some(body) = rest.strip_prefix("</") {
      let end = body.find('>').ok_or_else(|| invalid("unterminated end tag"))?;
      let (mut el, had_cdata) = stack.pop().filter(|_| !stack.is_empty()).ok_or_else(|| invalid("unexpected end tag"))?;
      if el.name != body[..end].trim() {
        return Err(invalid(&format!("</{}> closes <{}>", body[..end].trim(), el.name)));
      }
      if !had_cdata && el.text.trim().is_empty() {
        el.text.clear();
      }
      stack.last_mut().expect("root holder").0.children.push(el);
      rest = &body[end + 1..];
    } else {
      let end = tag_end(rest).ok_or_else(|| invalid("unterminated tag"))?;
      let inner = &rest[1..end];
      let (inner, empty) = match inner.strip_suffix('/') {
        Some(i) => (i, true),
        None => (inner, false),
      };
      let split = inner.find(char::is_whitespace).unwrap_or(inner.len());
      let el = Element { name: inner[..split].to_string(), attrs: parse_attrs(&inner[split..])?, ..Default::default() };
      if empty {
        stack.last_mut().expect("root holder").0.children.push(el);
      } else {
        stack.push((el, false));
      }
      rest = &rest[end + 1..];
    }
  }
  if stack.len() != 1 {
    return Err(invalid("unclosed element"));
  }
  stack.pop().and_then(|(holder, _)| holder.children.into_iter().next()).ok_or_else(|| invalid("no root element"))
}

/// Index of the `>` closing the tag at the start of `s`, skipping quoted values.
fn tag_end(s: &str) -> Option<usize> {
  let mut quote = None;
  for (i, c) in s.char_indices() {
    match (quote, c) {
      (None, '"' | '\'') => quote = Some(c),
      (Some(q), c) if c == q => quote = None,
      (None, '>') => return Some(i),
      _ => {}
    }
  }
  None
}

fn push_text(stack: &mut [(Element, bool)], text: &str, cdata: bool) {
  let (el, had_cdata) = stack.last_mut().expect("root holder");
  if cdata {
    el.text.push_str(text);
    *had_cdata = true;
  } else {
    el.text.push_str(&decode_entities(text));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_entity_files() {
    let root = parse(
      "\u{feff}<?xml version=\"1.0\"?>\n<Entities a=\"x &amp; y\">\n  <!-- c -->\n  <Things>\n    <Thing name='T' d=\"a>b\">\n      <code>\n<![CDATA[\n  if (a < b) {}\n]]>\n      </code>\n      <empty/>\n      <t>a &lt; b&#65;</t>\n    </Thing>\n  </Things>\n</Entities>",
    )
    .unwrap();
    assert_eq!(root.attr("a"), Some("x & y"));
    let thing = root.path(&["Things", "Thing"]).unwrap();
    assert_eq!(thing.attr("d"), Some("a>b"));
    // Whitespace around the CDATA stays, as in xml2js.
    assert_eq!(thing.child("code").unwrap().text, "\n\n  if (a < b) {}\n\n      ");
    assert_eq!(thing.child("empty").unwrap().text, "");
    assert_eq!(thing.child("t").unwrap().text, "a < bA");
    assert!(parse("<a><b></a>").is_err());
  }
}
