/**
 * Sökverktygen (grep, rg, git grep) och hemliga filer. Rekursiv sökning nämner ingen hemlig fil i
 * kommandot, så sökvägskontrollen i guard-paths.mjs ser den inte. `rg` hoppar över det som .gitignore
 * pekar ut (tfstate, kubeconfig, .env.local) och är därför det tillåtna sättet att söka i många filer.
 *
 * Fallgrop: verifierat med rg 14: ett positivt `-g '<glob>'` och `-u`/`--no-ignore*` läser även
 * gitignorerade filer, och .gitignore gäller inte utanför repot (`rg --hidden x ~`). Därför är ett positivt
 * glob bara tillåtet som `*.<vanlig filändelse>`, och sökvägar som `~`, `/` och `..` nekas. Korta flaggor
 * tolkas tecken för tecken (`-rC2`, `-uA2`) och långa flaggor får vara förkortade (`--rec`).
 * Kontrollerna returnerar `{ rule, reason }` eller `null`; guard-rules.mjs gör beslutet av dem.
 */

const USE_RG = 'Använd rg: det hoppar över filer som .gitignore pekar ut (hemligheter).';
// Ett positivt glob är tillåtet bara som `*.ts`, `**/*.mjs`, `src/**/*.json` och liknande: ändelsen kan
// inte matcha en hemlig fil (terraform.tfstate, .kube/config, .env).
const SAFE_GLOB =
  /^(?:[\w.@-]+\/|\*\*\/)*\*+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|css|scss|html|sql|sh|tf|txt|toml)$/;
// Sökvägar som når långt utanför projektet: hemkatalogen, roten, överordnade kataloger.
const OUTSIDE_PROJECT =
  /^(?:~|\$HOME|\$\{HOME\}|\/(?:Users|home)?(?:\/[^/]+)?)\/?$|^(?:~|\$HOME|\$\{HOME\})\/|(?:^|\/)\.\.(?:\/|$)/;
const GREP_VALUE_FLAGS = 'ABCDdefm';
const RG_VALUE_FLAGS = 'ABCEefgjMmrTtd';

const finding = (rule, reason) => ({ rule, reason });
const texts = (args) => args.map((a) => a.text);
const isShort = (text) => /^-[^-]/.test(text);

/** Tecknen i ett kort flaggkluster fram till första flagga som tar ett värde, och vad värdet börjar med. */
function clusterFlags(text, valueFlags) {
  const flags = [];
  for (let i = 1; i < text.length; i += 1) {
    if (valueFlags.includes(text[i]))
      return { flags, valueFlag: text[i], rest: text.slice(i + 1) };
    flags.push(text[i]);
  }
  return { flags, valueFlag: null, rest: '' };
}

function isRecursiveGrep(all) {
  return all.some((text, i) => {
    const next = all[i + 1];
    if (text.startsWith('--')) {
      return (
        text.startsWith('--rec') ||
        text.startsWith('--dereference-rec') ||
        (text.startsWith('--dir') && (text.endsWith('=recurse') || next === 'recurse'))
      );
    }
    if (!isShort(text)) return false;
    const { flags, valueFlag, rest } = clusterFlags(text, GREP_VALUE_FLAGS);
    return (
      flags.some((f) => f === 'r' || f === 'R') ||
      (valueFlag === 'd' && (rest || next) === 'recurse')
    );
  });
}

export function checkRecursiveGrep(args) {
  const all = texts(args);
  const end = all.indexOf('--');
  return isRecursiveGrep(end === -1 ? all : all.slice(0, end))
    ? finding(
        'grep-recursive',
        `Rekursiv grep läser även hemliga filer (tfstate, kubeconfig). ${USE_RG}`,
      )
    : null;
}

/** De glob-mönster (som ord) som ett rg-kommando ger via -g, --glob och --iglob. */
function rgGlobs(args) {
  const globs = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = args[i].text;
    const inline = /^--i?glob=([\s\S]*)$/.exec(text) ?? /^-g([\s\S]+)$/.exec(text);
    if (inline !== null) globs.push({ text: inline[1], dynamic: args[i].dynamic });
    else if (/^--i?glob$/.test(text) || /^-[^-]*g$/.test(text)) globs.push(args[i + 1]);
  }
  return globs;
}

const isGlobSafe = (word) =>
  word !== undefined &&
  !word.dynamic &&
  (word.text.startsWith('!') || SAFE_GLOB.test(word.text));

export function checkRgIgnore(args) {
  const bypassesIgnore = texts(args).some(
    (text) =>
      /^--(unrestricted|no-ignore.*)$/.test(text) ||
      (isShort(text) && clusterFlags(text, RG_VALUE_FLAGS).flags.includes('u')),
  );
  if (bypassesIgnore) {
    return finding(
      'rg-no-ignore',
      'rg -u och --no-ignore* läser även gitignorerade filer (hemligheter).',
    );
  }
  return rgGlobs(args).every(isGlobSafe)
    ? null
    : finding(
        'rg-glob',
        'Ett positivt rg -g/--glob läser även gitignorerade filer. Ange sökvägen som argument, eller ett glob som `*.ts`.',
      );
}

/** Sökningar i hemkatalogen, roten eller en överordnad katalog når filer som .gitignore inte skyddar. */
export function checkSearchPaths(args) {
  return args.some((a) => !a.text.startsWith('-') && OUTSIDE_PROJECT.test(a.text))
    ? finding(
        'search-outside-project',
        'Sök inom projektet: `~`, `/` och `..` når hemliga filer utanför repot (~/.ssh, ~/.kube).',
      )
    : null;
}

// git godtar förkortade långa flaggor, så `--no-ind` och `--no-exclude` räknas också.
export function checkGitGrepIgnore(rest) {
  return rest.some((a) => /^--no-(i|ex)/.test(a))
    ? finding(
        'git-grep-ignored',
        'git grep --no-index och --no-exclude-standard läser även gitignorerade filer.',
      )
    : null;
}
