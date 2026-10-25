#!/usr/bin/env node
/**
 * Secrets är namnrymdsscopade i Kubernetes — en secret skapad i "data" är
 * osynlig för en podd i "ticketing", även om namnet matchar exakt.
 * Varken `kubectl apply`/`kubectl kustomize` eller kubeletens egna
 * schema-validering fångar det: ingenting kontrollerar att en refererad
 * secret faktiskt EXISTERAR förrän kubelet försöker starta containern
 * (CreateContainerConfigError, bara synligt mot ett riktigt kluster).
 *
 * Det här scriptet simulerar .github/workflows/deploy.ymls bash (bara de
 * konstruktioner filen faktiskt använder: enkla variabler och
 * "for X in a b; do ... done"-loopar) för att räkna ut exakt vilka
 * (secret-namn, namnrymd)-par som verkligen skapas, och jämför det mot
 * varje secretKeyRef/envFrom.secretRef/imagePullSecrets som
 * infra/k8s/base/** faktiskt refererar. Se docs/phase-status.md för de
 * två incidenter (postgres-shard-*-credentials, rabbitmq-credentials)
 * som motiverade detta.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { parse, parseAllDocuments } from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy.yml');
const MANIFEST_GLOB = join(REPO_ROOT, 'infra/k8s/base/**/*.yaml');

/** Kör en deploy.yml-stegs `run:`-bash och returnerar varje
 * `kubectl create secret ... <namn> -n <namnrymd>` den producerar. */
function extractSecretCreations(script) {
  const created = [];
  const vars = {};
  const lines = script.split('\n');
  let loop = null; // { varName, values, bodyStart }

  const substitute = (token, loopVarName, loopValue) => {
    let out = token.replace(/^["']|["']$/g, '');
    if (loopVarName !== undefined) {
      out = out
        .replaceAll(`\${${loopVarName}}`, loopValue)
        .replaceAll(`$${loopVarName}`, loopValue);
    }
    for (const [name, value] of Object.entries(vars)) {
      out = out.replaceAll(`\${${name}}`, value).replaceAll(`$${name}`, value);
    }
    return out;
  };

  const runCreateMatch = (line, loopVarName, loopValue) => {
    const m = line.match(
      /kubectl create secret (?:generic|docker-registry) +(\S+) +-n +(\S+)/,
    );
    if (m) {
      created.push({
        name: substitute(m[1], loopVarName, loopValue),
        namespace: substitute(m[2], loopVarName, loopValue),
      });
    }
    const assign = line.match(/^\s*(\w+)=["']?([^"'\n]*)/);
    if (assign && !line.includes('kubectl')) {
      vars[assign[1]] = substitute(assign[2], loopVarName, loopValue);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const forMatch = line.match(/for\s+(\w+)\s+in\s+([^;]+);\s*do/);
    if (forMatch) {
      const varName = forMatch[1];
      const values = forMatch[2].trim().split(/\s+/);
      const bodyLines = [];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        if (/\bdo\b/.test(lines[i]) && /^\s*for\b/.test(lines[i])) depth++;
        if (/^\s*done\s*$/.test(lines[i])) {
          depth--;
          if (depth === 0) break;
        }
        bodyLines.push(lines[i]);
        i++;
      }
      for (const value of values) {
        for (const bodyLine of bodyLines) {
          runCreateMatch(bodyLine, varName, value);
        }
      }
      continue;
    }
    runCreateMatch(line, undefined, undefined);
  }
  return created;
}

function loadDeployYmlSecretMap() {
  const doc = parse(readFileSync(DEPLOY_WORKFLOW, 'utf8'));
  const steps = doc.jobs?.deploy?.steps ?? [];
  const map = new Map(); // secretName -> Set(namespace)
  for (const step of steps) {
    if (typeof step.run !== 'string') continue;
    for (const { name, namespace } of extractSecretCreations(step.run)) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(namespace);
    }
  }
  return map;
}

function* iterContainers(podSpec) {
  yield* podSpec.containers ?? [];
  yield* podSpec.initContainers ?? [];
}

function findSecretReferences(manifestPath) {
  const refs = []; // { secretName, kind: 'env'|'envFrom'|'imagePullSecret' }
  const text = readFileSync(manifestPath, 'utf8');
  for (const doc of parseAllDocuments(text, { merge: true })) {
    const resource = doc.toJS();
    if (!resource || !['Deployment', 'StatefulSet'].includes(resource.kind)) continue;
    const namespace = resource.metadata?.namespace;
    if (!namespace) continue; // ingen namnrymd satt — kan inte verifieras här
    const podSpec = resource.spec?.template?.spec;
    if (!podSpec) continue;

    for (const container of iterContainers(podSpec)) {
      for (const env of container.env ?? []) {
        const secretName = env.valueFrom?.secretKeyRef?.name;
        if (secretName)
          refs.push({ namespace, secretName, source: `${manifestPath}:env ${env.name}` });
      }
      for (const envFrom of container.envFrom ?? []) {
        const secretName = envFrom.secretRef?.name;
        if (secretName)
          refs.push({ namespace, secretName, source: `${manifestPath}:envFrom` });
      }
    }
    for (const pullSecret of podSpec.imagePullSecrets ?? []) {
      if (pullSecret.name) {
        refs.push({
          namespace,
          secretName: pullSecret.name,
          source: `${manifestPath}:imagePullSecrets`,
        });
      }
    }
  }
  return refs;
}

function main() {
  const secretMap = loadDeployYmlSecretMap();
  const manifestFiles = globSync(MANIFEST_GLOB);
  const problems = [];

  for (const file of manifestFiles) {
    for (const ref of findSecretReferences(file)) {
      const namespaces = secretMap.get(ref.secretName);
      if (!namespaces || !namespaces.has(ref.namespace)) {
        problems.push(
          `${ref.source}: secret "${ref.secretName}" refereras i namnrymden "${ref.namespace}", men deploy.yml skapar den bara i [${
            namespaces ? [...namespaces].join(', ') : '(aldrig)'
          }]`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error(
      'Secret-namnrymdsfel — en podd refererar en secret som inte skapas i dess egen namnrymd:\n',
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nDetta syns ALDRIG i "kubectl apply" (secretKeyRef valideras inte vid apply-tid) — bara som' +
        ' CreateContainerConfigError när kubelet faktiskt försöker starta containern. Fixa genom att' +
        ' antingen kopiera secreten till rätt namnrymd i deploy.yml (se "Ensure Postgres credentials' +
        ' exist" för mönstret), eller flytta podden.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: alla secret-referenser i ${manifestFiles.length} manifest matchar en namnrymd deploy.yml faktiskt skapar dem i.`,
  );
}

main();
