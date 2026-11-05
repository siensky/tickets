/**
 * Delar en skalkommandorad i enkla kommandon (ord, omdirigeringsmål, heredoc) åt guard.mjs.
 * Kommandon inuti `$( )`, `<( )` och backticks blir egna kommandon i listan.
 *
 * Fallgrop: det här är ingen fullständig skaltolk. Det som inte går att tolka säkert (oavslutade
 * citat eller parenteser) kastar ett fel, och guard.mjs nekar då hellre än gissar. Ett ord som
 * innehåller en expansion (`$X`, `${X}`, `$( )`) markeras `dynamic`: dess värde avgörs först när
 * kommandot körs.
 */

export class ShellParseError extends Error {}

const SEPARATORS = new Set([';', '&', '|', '(', ')', '\n']);

class Scanner {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.commands = [];
    this.nested = [];
    this.pendingHeredocs = [];
    this.startCommand();
  }

  startCommand() {
    this.command = { words: [], redirects: [], heredocs: [] };
    this.commands.push(this.command);
    this.word = null;
    this.redirectNext = false;
  }

  appendToWord(text, isDynamic = false) {
    this.word ??= { text: '', dynamic: false };
    this.word.text += text;
    this.word.dynamic ||= isDynamic;
  }

  endWord() {
    if (this.word === null) return;
    if (this.redirectNext) {
      this.command.redirects.push(this.word);
      this.redirectNext = false;
    } else {
      this.command.words.push(this.word);
    }
    this.word = null;
  }

  scan() {
    while (this.pos < this.src.length) {
      this.step(this.src[this.pos]);
    }
    this.endWord();
    if (this.pendingHeredocs.length > 0) throw new ShellParseError('heredoc utan slut');
    const commands = this.commands.filter((c) => c.words.length > 0 || c.redirects.length > 0);
    return [...commands, ...this.nested];
  }

  step(ch) {
    if (ch === ' ' || ch === '\t') return this.skip(() => this.endWord());
    if (ch === '\n') return this.newline();
    if (ch === '#' && this.word === null) return this.comment();
    if (ch === "'") return this.singleQuoted();
    if (ch === '"') return this.doubleQuoted();
    if (ch === '\\') return this.escaped();
    if (ch === '`') return this.appendToWord(this.backticks(), true);
    if (ch === '$') return this.dollar();
    if (ch === '<' || ch === '>' || (ch === '&' && this.src[this.pos + 1] === '>'))
      return this.redirect();
    if (SEPARATORS.has(ch)) return this.skip(() => this.separator());
    this.pos += 1;
    this.appendToWord(ch);
  }

  skip(action) {
    this.pos += 1;
    action();
  }

  separator() {
    this.endWord();
    this.startCommand();
  }

  newline() {
    this.pos += 1;
    this.endWord();
    const heredocCommands = this.pendingHeredocs;
    this.pendingHeredocs = [];
    for (const { command, delimiter, stripTabs } of heredocCommands) {
      command.heredocs.push(this.heredocBody(delimiter, stripTabs));
    }
    this.startCommand();
  }

  heredocBody(delimiter, stripTabs) {
    const lines = [];
    while (this.pos < this.src.length) {
      const end = this.src.indexOf('\n', this.pos);
      const line = this.src.slice(this.pos, end === -1 ? this.src.length : end);
      this.pos = end === -1 ? this.src.length : end + 1;
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) return lines.join('\n');
      lines.push(line);
    }
    throw new ShellParseError(`heredoc utan slutrad ${delimiter}`);
  }

  comment() {
    while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
  }

  singleQuoted() {
    const end = this.src.indexOf("'", this.pos + 1);
    if (end === -1) throw new ShellParseError('oavslutat enkelcitat');
    this.appendToWord(this.src.slice(this.pos + 1, end));
    this.pos = end + 1;
  }

  doubleQuoted() {
    this.pos += 1;
    this.appendToWord('');
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '"') {
        this.pos += 1;
        return;
      }
      if (ch === '\\' && this.pos + 1 < this.src.length) {
        this.appendToWord(this.src[this.pos + 1]);
        this.pos += 2;
      } else if (ch === '`') {
        this.appendToWord(this.backticks(), true);
      } else if (ch === '$') {
        this.dollar();
      } else {
        this.appendToWord(ch);
        this.pos += 1;
      }
    }
    throw new ShellParseError('oavslutat dubbelcitat');
  }

  escaped() {
    const next = this.src[this.pos + 1];
    this.pos += 2;
    if (next !== undefined && next !== '\n') this.appendToWord(next);
  }

  backticks() {
    const end = this.src.indexOf('`', this.pos + 1);
    if (end === -1) throw new ShellParseError('oavslutad backtick');
    const inner = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    this.nested.push(...splitCommands(inner));
    return '`…`';
  }

  dollar() {
    const next = this.src[this.pos + 1];
    if (next === '(') return this.appendToWord(this.substitution(this.pos + 1), true);
    if (next === '{') return this.appendToWord(this.braced(), true);
    const name = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(this.src.slice(this.pos));
    if (name === null) return this.skip(() => this.appendToWord('$'));
    this.pos += name[0].length;
    this.appendToWord(name[0], true);
  }

  braced() {
    const end = this.src.indexOf('}', this.pos);
    if (end === -1) throw new ShellParseError('oavslutad ${');
    const text = this.src.slice(this.pos, end + 1);
    this.pos = end + 1;
    return text;
  }

  /** `$( … )` eller `<( … )` med `open` på den inledande parentesen. Kommandona inuti blir egna kommandon. */
  substitution(open) {
    const close = matchingParen(this.src, open);
    this.nested.push(...splitCommands(this.src.slice(open + 1, close)));
    this.pos = close + 1;
    return '$(…)';
  }

  redirect() {
    const rest = this.src.slice(this.pos);
    if (rest.startsWith('<(') || rest.startsWith('>(')) {
      this.endWord();
      return this.appendToWord(this.substitution(this.pos + 1), true);
    }
    const heredoc = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(rest);
    if (heredoc !== null) {
      this.endWord();
      this.pendingHeredocs.push({
        command: this.command,
        delimiter: heredoc[3],
        stripTabs: heredoc[1] === '-',
      });
      this.pos += heredoc[0].length;
      return;
    }
    // Ett fd-nummer direkt före (`2>`) hör till omdirigeringen, inte till ett ord.
    if (this.word !== null && /^[0-9]+$/.test(this.word.text)) this.word = null;
    this.endWord();
    const op = /^(<<<|>>|>&|<&|>\||&>|<>|<|>)/.exec(rest)[0];
    this.pos += op.length;
    this.redirectNext = true;
  }
}

function matchingParen(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i += 1;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new ShellParseError('oavslutad parentes');
}

/** Alla enkla kommandon i `src`, inklusive de som ligger inuti kommandosubstitutioner. */
export function splitCommands(src) {
  return new Scanner(src).scan();
}
