export interface Change {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export interface Replacement {
  start: number;
  end: number;
  text: string;
  cursor: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

// Comments and literals are indivisible: their punctuation is never syntax.
function tokenize(source: string): Token[] {
  const pattern = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|`[^`]*(?:`|$)|[\p{L}_][\p{L}\p{N}_]*|\d+|<-|\.\.\.|[^\s]/gu;

  return Array.from(source.matchAll(pattern))
    .filter(m => !m[0].startsWith('//') && !m[0].startsWith('/*'))
    .map(m => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
}

const keywords = new Set('break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var'.split(' '));
const identifier = (s: string | undefined): boolean => !!s && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(s) && !keywords.has(s);

class Parser {
  constructor(readonly tokens: Token[]) {}

  at(i: number): string | undefined {
    return this.tokens[i]?.text;
  }

  // Return the token immediately following a balanced group.
  group(i: number): number | undefined {
    const closing: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const stack: string[] = [];

    if (!closing[this.at(i) ?? '']) {
      return undefined;
    }

    for (; i < this.tokens.length; i++) {
      const t = this.at(i)!;

      if (closing[t]) {
        stack.push(closing[t]);
      } else if (t === ')' || t === ']' || t === '}') {
        if (stack.pop() !== t) {
          return undefined;
        }

        if (!stack.length) {
          return i + 1;
        }
      }
    }

    return undefined;
  }

  type(i: number, depth = 0): number | undefined {
    if (depth > 100) {
      return undefined;
    }

    const nextType = (n: number) => this.type(n, depth + 1);
    const t = this.at(i);

    if (t === '*') {
      return nextType(i + 1);
    }

    if (t === '<-') {
      return this.at(i + 1) === 'chan' ? nextType(i + 2) : undefined;
    }

    if (t === 'chan') {
      return nextType(i + (this.at(i + 1) === '<-' ? 2 : 1));
    }

    if (t === '[') {
      const end = this.group(i);

      return end === undefined ? undefined : nextType(end);
    }

    if (t === 'map') {
      if (this.at(i + 1) !== '[') {
        return undefined;
      }

      const end = this.group(i + 1);

      return end === undefined ? undefined : nextType(end);
    }

    if (t === 'struct' || t === 'interface') {
      return this.at(i + 1) === '{' ? this.group(i + 1) : undefined;
    }

    if (t === '(') {
      const end = nextType(i + 1);

      return end !== undefined && this.at(end) === ')' ? end + 1 : undefined;
    }

    if (t === 'func') {
      if (this.at(i + 1) !== '(') {
        return undefined;
      }

      const end = this.group(i + 1);

      if (end === undefined) {
        return undefined;
      }

      if (this.at(end) === '(') {
        return this.group(end);
      }

      return nextType(end) ?? end;
    }

    if (!identifier(t)) {
      return undefined;
    }

    let end = i + 1;

    if (this.at(end) === '.') {
      if (!identifier(this.at(end + 1))) {
        return undefined;
      }

      end += 2;
    }

    return this.at(end) === '[' ? this.group(end) : end;
  }

  resultStart(func: number): number | undefined {
    let i = func + 1;

    if (identifier(this.at(i))) {
      i++;

      if (this.at(i) === '[') {
        const end = this.group(i);

        if (end === undefined) {
          return undefined;
        }

        i = end;
      }
    }

    if (this.at(i) !== '(') {
      return undefined;
    }

    let end = this.group(i);

    if (end === undefined) {
      return undefined;
    }

    // A receiver is followed by a method name and its parameter list.
    if (identifier(this.at(end)) && this.at(end + 1) === '(') {
      end = this.group(end + 1);
    }

    return end;
  }

  topLevelCommas(start: number, end: number): Token[] {
    const result: Token[] = [];

    for (let i = start; i < end; i++) {
      if (this.at(i) === ',') {
        result.push(this.tokens[i]);
      }

      if (['(', '[', '{'].includes(this.at(i)!)) {
        const next = this.group(i);

        if (next === undefined) {
          break;
        }

        i = next - 1;
      }
    }

    return result;
  }
}

/** Compute an edit in the document AFTER the user's change. No VS Code dependency. */
export function transform(before: string, change: Change): Replacement | undefined {
  const { rangeOffset: offset, rangeLength: length, text } = change;
  const after = before.slice(0, offset) + text + before.slice(offset + length);

  if (text === ',' && length === 0) {
    const p = new Parser(tokenize(after));

    for (let i = 0; i < p.tokens.length; i++) {
      if (p.at(i) !== 'func') {
        continue;
      }

      const start = p.resultStart(i);

      if (start === undefined) {
        continue;
      }

      // Callback types belong to the enclosing parameter list. Its commas
      // must not be interpreted as edits to a callback's result list.
      i = start - 1;

      if (p.at(start) === '(') {
        continue;
      }

      const end = p.type(start);

      if (end === undefined || p.at(end) !== ',' || p.tokens[end].start !== offset) {
        continue;
      }

      const from = p.tokens[start].start;
      const result = `(${after.slice(from, offset).trimEnd()}, )`;

      return { start: from, end: offset + 1, text: result, cursor: from + result.length - 1 };
    }
  }

  // Only removal of a real result separator can unwrap a result list.
  if (text !== '' || !before.slice(offset, offset + length).includes(',')) {
    return undefined;
  }

  const p = new Parser(tokenize(before));

  for (let i = 0; i < p.tokens.length; i++) {
    if (p.at(i) !== 'func') {
      continue;
    }

    const start = p.resultStart(i);

    if (start === undefined) {
      continue;
    }

    // Apply the same parameter-list exclusion when removing commas.
    i = start - 1;

    if (p.at(start) !== '(') {
      continue;
    }

    const end = p.group(start);

    if (end === undefined) {
      continue;
    }

    const open = p.tokens[start], close = p.tokens[end - 1];

    if (offset < open.end || offset + length > close.start) {
      continue;
    }

    if (!p.topLevelCommas(start + 1, end - 1).some(t => t.start >= offset && t.end <= offset + length)) {
      continue;
    }

    const inside = after.slice(open.end, close.start - length);
    const remaining = new Parser(tokenize(inside));

    // Named results, multiple results and incomplete types must retain parentheses.
    if (!remaining.tokens.length || remaining.type(0) !== remaining.tokens.length) {
      continue;
    }

    const value = inside.trim();

    // A trailing line comment would swallow the function body after unwrapping.
    if (inside.includes('//')) {
      continue;
    }

    const trimStart = inside.length - inside.trimStart().length;
    const cursor = open.start + Math.max(0, Math.min(value.length, offset - open.end - trimStart));

    return { start: open.start, end: close.end - length, text: value, cursor };
  }

  return undefined;
}
