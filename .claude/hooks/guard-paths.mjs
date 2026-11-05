/**
 * Sökvägar och miljövariabler som spärren (guard.mjs) bedömer: hemliga filer, verifieringsposten i
 * .claude/state/ och variabler som får git, en pager eller en tolk att köra ett annat program.
 *
 * Fallgrop: en sökväg kan skrivas på många sätt (`.claude//state`, `.claude/./state`, `--output=…`,
 * `.claude/stat?`, versaler på ett filsystem som inte skiljer på dem). Allt normaliseras först, varje
 * del efter ett `=` bedöms för sig, och ett ociterat globmönster bedöms efter vad det kan matcha.
 * Rekursiv läsning (`grep -r … infra`) nämner ingen hemlig fil och fångas inte; se ADR-0012.
 */
import { posix } from 'node:path';

export const SECRET_PATH =
  /(^|[^\w.-])\.env(\.local|\.[\w-]+\.local)?(?![\w.-])|\.tfstate|\.kube(\/|-config-raw)|\.tikknet-tf\.env/i;
const SECRET_DIR = /(^|\/)infra\/terraform(\/|$)/i;
// Namn som ett globmönster inte får kunna matcha (punktfiler matchas bara av mönster som börjar med punkt).
const SECRET_NAMES = [
  '.env',
  '.env.local',
  '.env.production.local',
  '.kube',
  '.kube-config-raw',
  '.tikknet-tf.env',
  'terraform.tfstate',
  'terraform.tfstate.backup',
];

const normalizePath = (text) => (text.includes('/') ? posix.normalize(text) : text);

/** Texten och varje del efter ett `=` (`--output=x`, `of=x`, `NAMN=x`), normaliserade. */
const pathCandidates = (text) => [text, ...text.split('=').slice(1)].map(normalizePath);

/** Ett globmönster för ett sökvägsled som reguljärt uttryck. Ett ogiltigt mönster blir bokstavlig text. */
export function globRegex(segment) {
  // `{a..z}` (en serie) kan bli vad som helst: den räknas som `*`.
  const chars = [...segment.replace(/\{[^{}]*\.\.[^{}]*\}/g, '\u0000')];
  let source = '';
  let braceDepth = 0;
  let inBracket = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (inBracket) {
      inBracket = ch !== ']';
      source += ch === '\\' ? '\\\\' : ch;
    } else if (ch === '[') {
      inBracket = true;
      source += chars[i + 1] === '!' ? '[^' : '[';
      if (chars[i + 1] === '!') i += 1;
    } else if (
      ch === '{' ||
      (ch === '}' && braceDepth > 0) ||
      (ch === ',' && braceDepth > 0)
    ) {
      braceDepth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      source += ch === '{' ? '(' : ch === '}' ? ')' : '|';
    } else {
      const map = { '\u0000': '.*', '*': '[^/]*', '?': '[^/]' };
      source += map[ch] ?? ch.replace(/[.+^$()|\\{}]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${source}$`, 'i');
  } catch {
    return new RegExp(`^${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  }
}

const segmentMatches = (segment, name, isGlob) =>
  segment.toLowerCase() === name ||
  (isGlob && /[*?[{]/.test(segment) && globRegex(segment).test(name));

function globMatchesSecret(path) {
  if (SECRET_DIR.test(path)) return true;
  return path.split('/').some((segment) => {
    if (!/[*?[{]/.test(segment)) return false;
    const literals = segment.split(/[*?[\]{},!]/).filter((part) => part.length >= 2);
    return SECRET_NAMES.some(
      (name) =>
        (segment.startsWith('.') || !name.startsWith('.')) &&
        (segment.startsWith('.') ||
          literals.some((part) => name.includes(part.toLowerCase()))) &&
        globRegex(segment).test(name),
    );
  });
}

/** Om ordet (`{ text, glob }`) kan peka på en fil med hemligheter. */
export function mentionsSecret(word) {
  return pathCandidates(word.text).some(
    (path) => SECRET_PATH.test(path) || (word.glob && globMatchesSecret(path)),
  );
}

function claudeSegments(word, check) {
  return pathCandidates(word.text).some((path) => {
    const segments = path.split('/');
    return segments.some(
      (segment, i) => segmentMatches(segment, '.claude', word.glob) && check(segments[i + 1]),
    );
  });
}

/** Om ordet pekar på .claude/state/, även med glob, `..`, `=` eller versaler. */
export function touchesClaudeState(word) {
  return claudeSegments(
    word,
    (next) => next !== undefined && segmentMatches(next, 'state', word.glob),
  );
}

/** Om ordet är mappen .claude själv (för `rm -r .claude`, `mv .claude …`). */
export function isClaudeDir(word) {
  return claudeSegments(word, (next) => next === undefined || next === '');
}

/** Om ordet pekar in i .claude/ (för `cd`: ett relativt `state/…` efteråt går inte att bedöma). */
export function entersClaudeDir(word) {
  return claudeSegments(word, () => true);
}

// Variabler som får git, en pager, ett skal eller en tolk att köra ett annat program.
const RISKY_ENV =
  /^(GIT_[A-Z0-9_]+|PATH|PAGER|MANPAGER|LESSOPEN|LESSCLOSE|EDITOR|VISUAL|SSH_ASKPASS|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|NODE_OPTIONS|PYTHONSTARTUP|PERL5OPT|RUBYOPT)$/;
const HARMLESS_ENV = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$|^GIT_TERMINAL_PROMPT$/;

/** Om en tilldelning `NAMN=värde` kan få ett annat program att köras. */
export function isRiskyAssignment(text) {
  const [name, ...rest] = text.split('=');
  const value = rest.join('=');
  if (!RISKY_ENV.test(name) || HARMLESS_ENV.test(name)) return false;
  if (/PAGER$/.test(name) && ['', 'cat', 'less'].includes(value)) return false;
  return !(name === 'NODE_OPTIONS' && /^(--max-old-space-size=\d+\s*)+$/.test(value));
}
