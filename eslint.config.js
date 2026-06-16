// ESLint flat config for the whole monorepo.
//
// The most important part of this file is the `client/src/sim/**` override:
// the simulation must stay deterministic and renderer/network-free so it can
// be replayed headless (lockstep). Pixi, net code, wall-clock time and
// floating-point math intrinsics are all banned inside sim/.
import tseslint from 'typescript-eslint';

const SIM_ISOLATION_MSG =
  'client/src/sim/** is pure deterministic logic: no Pixi, no render/, no net/.';
const SIM_DETERMINISM_MSG =
  'Non-deterministic / floating-point intrinsic is banned in client/src/sim/** (use integer millitiles + the seeded PRNG).';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.venv/**'],
  },
  ...tseslint.configs.recommended,
  {
    // --- Sim isolation guardrail (deterministic lockstep core) ---
    files: ['client/src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pixi.js', 'pixi.js/*'],
              message: SIM_ISOLATION_MSG,
            },
            {
              group: ['**/render', '**/render/*', '**/render/**'],
              message: SIM_ISOLATION_MSG,
            },
            {
              group: ['**/net', '**/net/*', '**/net/**'],
              message: SIM_ISOLATION_MSG,
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: SIM_DETERMINISM_MSG },
        { object: 'Math', property: 'random', message: SIM_DETERMINISM_MSG },
        { object: 'Math', property: 'sin', message: SIM_DETERMINISM_MSG },
        { object: 'Math', property: 'cos', message: SIM_DETERMINISM_MSG },
        { object: 'Math', property: 'sqrt', message: SIM_DETERMINISM_MSG },
        { object: 'performance', property: 'now', message: SIM_DETERMINISM_MSG },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: SIM_DETERMINISM_MSG },
      ],
    },
  },
);
