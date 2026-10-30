// Root ESLint config for the whole monorepo.
//
// Enforces docs/rules.md: layer boundaries (controllers -> services ->
// repositories), no default exports, no `any`, no console.log, and file/
// function length limits. Everything here is `error`, not `warn` — a rule
// that only warns gets ignored once enough code is generated (rules.md §0).
import eslintJs from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/*.config.js',
      '**/*.config.cjs',
      '**/*.config.mjs',
      '**/*.config.ts',
      // Delad tsup-bas i repo-roten (tsup.base.ts) — matchar inte
      // "*.config.ts", och ingen tsconfig.json täcker filer i repo-
      // roten, så typescript-eslints projectService kan inte
      // typkontrollera den ("was not found by the project service").
      // Samma kategori fil som *.config.ts: byggverktygskonfiguration,
      // inte applikationskod som lagergränserna gäller.
      'tsup.base.ts',
      'infra/**',
    ],
  },
  eslintJs.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { boundaries },
    settings: {
      // eslint-plugin-boundaries resolver (via eslint-module-utils) kan
      // bara se lokala imports det kan slå upp på disk. Hela kodbasen
      // skriver ".js" på TypeScript-källfiler (Node-ESM-konventionen,
      // se index.ts: "from './routes/health.js'") — utan den här
      // resolvern tolkas VARJE sådan import som "okänd" (filen
      // "dummy.repository.js" finns inte, bara "dummy.repository.ts"),
      // och en okänd target hoppas tyst över som standard
      // (checkUnknownLocals: false). Det var INTE primärt service-roots
      // mode-inställning som gjorde regeln verkningslös — det var detta.
      // Verifierat med 'boundaries/debug' och ett avsiktligt brott, se
      // eslint.config.test.ts.
      'import/resolver': {
        typescript: true,
      },
      // Utan detta defaultar root-path till `process.cwd()` VID LINT-
      // TILLFÄLLET, inte till repo-roten — och eftersom varje paket kör
      // sitt eget "eslint ." (package.json:s "lint"-skript, det CI
      // faktiskt anropar via `turbo run lint`), blir cwd t.ex.
      // "services/booking-api" i stället för repo-roten. Mönstren nedan
      // ("services/*/src/controllers/**") matchar då aldrig något alls
      // — "pnpm lint" passerar grönt oavsett om ett lagerbrott finns,
      // obemärkt eftersom noll fel ser likadant ut som "inga brott" och
      // "ingenting bevakas" (samma klass bugg som importresolvern ovan,
      // hittat under Fas 5-reviewn). En absolut sökväg görs aldrig om
      // mot cwd (node:path.resolve returnerar en redan absolut sökväg
      // oförändrad), så detta gäller oavsett varifrån eslint körs.
      'boundaries/root-path': import.meta.dirname,
      'boundaries/elements': [
        { type: 'routes', pattern: 'services/*/src/routes/**' },
        { type: 'controllers', pattern: 'services/*/src/controllers/**' },
        { type: 'services-layer', pattern: 'services/*/src/services/**' },
        { type: 'repositories', pattern: 'services/*/src/repositories/**' },
        { type: 'mappers', pattern: 'services/*/src/mappers/**' },
        { type: 'schemas-layer', pattern: 'services/*/src/schemas/**' },
        // mode: 'file' krävs — default är 'folder', som tolkar mönstret
        // som en MAPP och lägger till "/**/*" på det internt. Ett
        // filmönster (index.ts) kan då aldrig matcha något, så
        // service-root klassificerades aldrig: en controllers-fil som
        // importerar från repositories/ (förbjudet nedan) flaggades
        // korrekt, men index.ts fick ALDRIG en type alls — "from" eller
        // "to" mot service-root slog därför aldrig in, obemärkt.
        //
        // `*.ts` (en ENDA `*`, spänner inte över `/`), inte bara
        // `index.ts` — Fas 6 la till `dependencies.ts` som en till lös
        // fil direkt i `src/` (samma skäl som index.ts: ren
        // konstruktion, ingen Fastify-routing), och den hade annars
        // blivit obevakad av exakt samma anledning som ovan.
        // `instrumentation.ts` (fanns redan i alla fem tjänster) fångas
        // nu också, verifierat ofarligt — den importerar bara `shared`.
        { type: 'service-root', pattern: 'services/*/src/*.ts', mode: 'file' },
        // Fas 6: engångsskript (reset-sale.ts m.fl.) — upptäckt i
        // Fas 6-reviewn att boundaries-listan saknade denna mapp helt,
        // vilket tyst satte lagerregeln ur spel här (samma riskklass
        // som den tidigare `boundaries/root-path`-regressionen,
        // eslint.config.test.ts). Egen typ, inte `service-root`: ett
        // skript ska bara få prata med repositories/shared, aldrig
        // registrera routes.
        { type: 'scripts', pattern: 'services/*/src/scripts/**' },
        { type: 'shared', pattern: 'shared/*/src/**' },
      ],
    },
    rules: {
      // --- rules.md §2: TypeScript ---
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Named exports only (rules.md §2) — no default exports.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Default exports are not allowed — use named exports (docs/rules.md §2).',
        },
      ],

      // rules.md §7: no console.log in production code.
      'no-console': 'error',

      // rules.md §1: max 300 lines/file, 50 lines/function.
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],

      // rules.md §1: layer boundaries. "boundaries/dependencies" +
      // "policies", INTE "boundaries/element-types" + "rules" — den
      // gamla formen är deprecated i v7 och varnar om det (icke-blockerande),
      // men det riktigt farliga är att v7 fortfarande PARSAR den utan fel
      // och sedan inte tillämpar den — noll lint-fel såg ut som "inga
      // brott" när det egentligen var "ingenting bevakas". Verifierat med
      // ett avsiktligt regressionstest, se eslint.config.test.ts.
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            {
              from: { element: { type: 'routes' } },
              allow: {
                to: {
                  element: { types: { anyOf: ['controllers', 'schemas-layer', 'shared'] } },
                },
              },
            },
            {
              from: { element: { type: 'controllers' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['services-layer', 'schemas-layer', 'mappers', 'shared'] },
                  },
                },
              },
            },
            {
              from: { element: { type: 'services-layer' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['repositories', 'mappers', 'schemas-layer', 'shared'] },
                  },
                },
              },
            },
            {
              from: { element: { type: 'repositories' } },
              allow: { to: { element: { types: { anyOf: ['mappers', 'shared'] } } } },
            },
            {
              from: { element: { type: 'mappers' } },
              allow: { to: { element: { type: 'shared' } } },
            },
            {
              from: { element: { type: 'schemas-layer' } },
              allow: { to: { element: { type: 'shared' } } },
            },
            {
              from: { element: { type: 'service-root' } },
              allow: {
                to: {
                  element: {
                    types: {
                      // 'service-root' med sig själv: `*.ts` matchar NU
                      // flera lösa filer per tjänst (index.ts,
                      // dependencies.ts, instrumentation.ts) — de
                      // importerar redan av varandra (index.ts →
                      // instrumentation.ts sedan tidigare, index.ts →
                      // dependencies.ts sedan Fas 6).
                      anyOf: [
                        'routes',
                        'controllers',
                        'services-layer',
                        'repositories',
                        'mappers',
                        'schemas-layer',
                        'shared',
                        'service-root',
                      ],
                    },
                  },
                },
              },
            },
            {
              from: { element: { type: 'scripts' } },
              allow: {
                to: { element: { types: { anyOf: ['repositories', 'mappers', 'shared'] } } },
              },
            },
          ],
        },
      ],
    },
  },
  {
    // rules.md §1: services/ and repositories/ stay framework-agnostic.
    files: ['services/*/src/services/**', 'services/*/src/repositories/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fastify',
              message:
                'services/ and repositories/ must stay framework-agnostic — no Fastify here (docs/rules.md §1).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // docs/plan.md 7.14: systemtesterna är black-box. Bara publikt HTTP-API och
    // läsande SQL, aldrig import av implementationen.
    files: ['tests/system/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tickets/*', '**/services/**', '**/shared/**'],
              message:
                'System tests are black-box: no imports from services/ or shared/ (docs/plan.md 7.14).',
            },
          ],
        },
      ],
    },
  },
  {
    // Frontend apps don't follow the service layer structure.
    files: ['apps/**/*.{ts,tsx}'],
    rules: {
      'boundaries/dependencies': 'off',
    },
  },
);
