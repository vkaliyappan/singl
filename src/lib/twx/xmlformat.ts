import type { XmlToken, ParsedTag, FilterAttrCallback } from './types';

const ENTITIES_STRIP_ATTRS = new Set([
  'build', 'modelPersistenceProviderPackage', 'revision', 'schemaVersion',
]);

export function formatEntityXml(rawXml: string): string {
  let xml = rawXml.replace(/<\?xml[^?]*\?>\s*/, '');
  xml = prettyPrint(xml);

  xml = xml.replace(/<Entities([^>]*)>/, (_match, attrs: string) => {
    const cleaned = filterAttributes(attrs, (name) => {
      if (ENTITIES_STRIP_ATTRS.has(name)) return false;
      if (name === 'universal') return { name, value: 'password' };
      return true;
    });
    return `<Entities${cleaned}>`;
  });

  xml = xml.replace(/\s+lastModifiedDate="[^"]*"/g, '');
  xml = xml.replace(/[ \t]*<Owner[^>]*\/>\n?/g, '');
  xml = xml.replace(/[ \t]*<Owner[^>]*>.*?<\/Owner>\n?/g, '');
  xml = xml.replace(/\n{3,}/g, '\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml.trim() + '\n';
}

function filterAttributes(attrString: string, callback: FilterAttrCallback): string {
  const result: string[] = [];
  const re = /([\w][\w.-]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) {
    const res = callback(m[1], m[2]);
    if (res === false) continue;
    if (res !== true && typeof res === 'object') {
      result.push(`${res.name}="${res.value}"`);
    } else {
      result.push(`${m[1]}="${m[2]}"`);
    }
  }
  if (result.length === 0) return '';
  return '\n ' + result.join('\n ');
}

function prettyPrint(xml: string): string {
  const tokens = tokenize(xml);
  const lines: string[] = [];
  let depth = 0;
  const pad = (d: number) => '    '.repeat(d);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type === 'cdata') {
      const inner = tok.value.slice(9, -3);
      const prefix = pad(depth);
      lines.push(prefix + '<![CDATA[');
      for (const line of inner.split('\n')) {
        lines.push(line);
      }
      lines.push(prefix + ']]>');
      continue;
    }

    if (tok.type === 'text') {
      lines.push(pad(depth) + tok.value);
      continue;
    }

    const tag = tok.value;

    if (/^<[^/!?][^>]*\/>$/.test(tag)) {
      const { name, attrs } = parseTag(tag);
      lines.push(openClose(name, attrs, pad(depth)));
      continue;
    }

    if (tag.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      lines.push(pad(depth) + tag);
      continue;
    }

    if (tag.startsWith('<!') || tag.startsWith('<?')) {
      lines.push(pad(depth) + tag);
      continue;
    }

    const { name, attrs } = parseTag(tag);

    if (
      i + 2 < tokens.length &&
      tokens[i + 1].type === 'text' &&
      tokens[i + 2].type === 'tag' &&
      tokens[i + 2].value === `</${name}>`
    ) {
      lines.push(
        pad(depth) + openTag(name, attrs, pad(depth)) + tokens[i + 1].value + `</${name}>`
      );
      i += 2;
      continue;
    }

    if (
      i + 1 < tokens.length &&
      tokens[i + 1].type === 'tag' &&
      tokens[i + 1].value === `</${name}>`
    ) {
      lines.push(openClose(name, attrs, pad(depth)));
      i += 1;
      continue;
    }

    lines.push(pad(depth) + openTag(name, attrs, pad(depth)));
    depth++;
  }

  return lines.join('\n');
}

function openTag(name: string, attrs: string[], prefix: string): string {
  if (attrs.length === 0) return `<${name}>`;
  return `<${name}\n${prefix} ${attrs.join(`\n${prefix} `)}>`;
}

function openClose(name: string, attrs: string[], prefix: string): string {
  if (attrs.length === 0) return `${prefix}<${name}></${name}>`;
  return `${prefix}<${name}\n${prefix} ${attrs.join(`\n${prefix} `)}></${name}>`;
}

function tokenize(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const re = /<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m.index > last) {
      const text = xml.slice(last, m.index).trim();
      if (text) tokens.push({ type: 'text', value: text });
    }
    if (m[0].startsWith('<![CDATA[')) {
      tokens.push({ type: 'cdata', value: m[0] });
    } else {
      tokens.push({ type: 'tag', value: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < xml.length) {
    const text = xml.slice(last).trim();
    if (text) tokens.push({ type: 'text', value: text });
  }
  return tokens;
}

function parseTag(tag: string): ParsedTag {
  const inner = tag.replace(/^<\/?/, '').replace(/\/?>$/, '').trim();
  const sp = inner.search(/\s/);
  const name = sp === -1 ? inner : inner.slice(0, sp);
  const attrStr = sp === -1 ? '' : inner.slice(sp);
  const attrs: string[] = [];
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    attrs.push(`${m[1]}="${m[2]}"`);
  }
  return { name, attrs };
}
