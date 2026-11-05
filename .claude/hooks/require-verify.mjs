/**
 * Stop- och SubagentStop-hook (ADR-0012): en session som ändrat filer får inte avsluta utan en
 * verifieringspost för exakt det filträdet. Posten behöver inte vara grön, bara finnas: kravet är att
 * testerna körts och att resultatet rapporteras ärligt (rules.md §12), inte att allt är grönt. Är
 * resultatet inte `passed` visas det för användaren, oavsett vad Claude själv skriver.
 *
 * Fallgrop: "ändrat filer" avgörs av transkriptet (Edit, Write, NotebookEdit). En fil som bara ändrats
 * via Bash räknas inte. Ändringar som bara rör dokumentation kräver ingen verifiering.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readRecord,
  repoRoot,
  treeHash,
  verifierHash,
  workingChanges,
} from './verify-record.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DOCS_ONLY = /(^docs\/|\.md$)/;
const RUN_VERIFY = 'node .claude/hooks/verify.mjs';

/** Om transkriptet innehåller ett anrop till ett verktyg som ändrar filer. */
export function sessionEditedFiles(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  return readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .some((line) => {
      if (!line.includes('"tool_use"')) return false;
      try {
        const content = JSON.parse(line)?.message?.content;
        return (
          Array.isArray(content) &&
          content.some((c) => c?.type === 'tool_use' && EDIT_TOOLS.has(c.name))
        );
      } catch {
        return false;
      }
    });
}

/**
 * Beslutet, givet läget: `{ block, reason }` för att stoppa avslutet, `{ message }` för att bara visa
 * något för användaren, eller `{}`.
 */
export function stopDecision({
  edited,
  changes,
  record,
  currentTree,
  currentVerifier,
  isRetry,
}) {
  if (!edited) return {};
  const relevant = changes.filter((c) => !DOCS_ONLY.test(c.path));
  if (relevant.length === 0) return {};
  const isValid =
    record !== null &&
    record.treeHash === currentTree &&
    record.verifierHash === currentVerifier;
  if (!isValid) {
    if (isRetry) {
      return {
        message:
          'Avslutar utan giltig verifieringspost för de senaste ändringarna. Lokal verifiering: INTE KÖRD.',
      };
    }
    return {
      block: true,
      reason:
        `Filer har ändrats sedan senaste verifieringen (${relevant.length} st). Kör \`${RUN_VERIFY}\` ` +
        'och återge resultatet ordagrant. Fungerar inte miljön blir posten env_error, och då ska du stanna och fråga användaren.',
    };
  }
  if (record.result === 'passed') return {};
  const notPassed = record.steps
    .filter((s) => s.required && s.outcome !== 'passed')
    .map((s) => `${s.name}=${s.outcome}`);
  return {
    message: `Lokal verifiering: ${record.result.toUpperCase()} (${notPassed.join(', ')}). CI avgör.`,
  };
}

export function hookOutput(decision) {
  if (decision.block) return { decision: 'block', reason: decision.reason };
  if (decision.message) return { systemMessage: decision.message };
  return null;
}

function main() {
  let output;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const repo = repoRoot(input.cwd ?? process.cwd());
    const changes = workingChanges(repo);
    output = hookOutput(
      stopDecision({
        edited: sessionEditedFiles(input.agent_transcript_path ?? input.transcript_path),
        changes,
        record: readRecord(repo),
        currentTree: treeHash(repo, changes),
        currentVerifier: verifierHash(),
        isRetry: input.stop_hook_active === true,
      }),
    );
  } catch (error) {
    // Hooken får aldrig låsa fast användaren: vid fel avslutas sessionen, med en varning.
    output = {
      systemMessage: `require-verify.mjs kunde inte kontrollera verifieringen: ${error.message}`,
    };
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
