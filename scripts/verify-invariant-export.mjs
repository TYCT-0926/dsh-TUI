/**
 * `./invariant` export-contract regression.
 *
 * `lib/invariant.js` is the one checked-in artifact `pnpm build` does not
 * produce (see docs/contributing.md): the `./invariant` entry is a separately
 * bundled runtime export, kept aligned with `src/dsh-adapter/invariant.ts` by hand. The
 * split is the DSH ecosystem's shape, not this repo's improvisation — every
 * sibling package (dsh-agent, dsh-commands, dsh-skill, dsh-session, dsh-llm,
 * dsh-terminal) declares the identical `{types: ./lib/types/dsh-adapter/invariant.d.ts,
 * default: ./lib/invariant.js}` pair — so the exception is one to hold to,
 * and to hold in place, rather than one to remove.
 *
 * The hand step was missed once: the 20260811 cordis rescope swept the
 * package name in `src/dsh-adapter/invariant.ts` to `@deepseek-ai/dsh-cc-tui`, the bundle
 * was corrected for rc.6, and the two disagreed for weeks with nothing able
 * to notice. A convention documented in prose but not enforced by code is not
 * an invariant; this script is the enforcement:
 *
 * - the file `package.json` exports as `./invariant` exists and imports
 * - the bundle and the `tsc` output expose the same export surface
 * - both register the SAME package name with `ctx.invariants.register`
 *   (asserted behaviorally, by running `apply` against a recording stub —
 *   not by grepping source text)
 * - that name is `package.json` `name`, the key invariant ownership is
 *   reserved by; a name no published package answers to would reserve
 *   ownership nobody can select
 *
 * Run: node scripts/verify-invariant-export.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const packageName = manifest.name

// ---- the export map points at a file that exists
const exported = manifest.exports?.['./invariant']
const bundlePath = resolve(repoRoot, exported?.default ?? '')
const typesPath = resolve(repoRoot, exported?.types ?? '')
check(
  'package.json exports ./invariant with a runtime entry',
  typeof exported?.default === 'string',
  `got ${JSON.stringify(exported?.default)}`,
)
check('the bundled ./invariant runtime entry exists', existsSync(bundlePath), bundlePath)
check('the ./invariant declaration entry exists', existsSync(typesPath), typesPath)
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}

// ---- both modules: the shipped bundle and the tsc output it mirrors
const bundle = await import(pathToFileURL(bundlePath).href)
// Derive the compiled module from the manifest's own `types` entry rather
// than hardcoding a path: `src/invariant.ts` moved under `src/dsh-adapter/`
// once already, and a gate that has to be edited whenever the tree moves is
// the kind of hand-maintained coupling this script exists to remove.
const compiled = await import(pathToFileURL(typesPath.replace(/\.d\.ts$/, '.js')).href)

const surfaceOf = mod => Object.keys(mod).filter(key => key !== 'default').sort().join(',')
check(
  'bundle and tsc output expose the same export surface',
  surfaceOf(bundle) === surfaceOf(compiled),
  `bundle=${surfaceOf(bundle)} tsc=${surfaceOf(compiled)}`,
)
check('cordis plugin name matches', bundle.name === compiled.name, `${bundle.name} vs ${compiled.name}`)
check(
  'injected services match',
  JSON.stringify(bundle.inject) === JSON.stringify(compiled.inject),
  `${JSON.stringify(bundle.inject)} vs ${JSON.stringify(compiled.inject)}`,
)

/**
 * Run a module's `apply` against a recording stub and return every package
 * name it reserved. Behavioral, so a refactor that moves the constant still
 * gets checked.
 * @param mod - the imported invariant companion module.
 * @returns the package names passed to `invariants.register`.
 */
async function registeredNames(mod) {
  const seen = []
  await mod.apply({
    invariants: {
      register(name) {
        seen.push(name)
        return () => {}
      },
    },
  })
  return seen
}

const bundleNames = await registeredNames(bundle)
const compiledNames = await registeredNames(compiled)
check(
  'bundle and tsc output reserve the same package name',
  JSON.stringify(bundleNames) === JSON.stringify(compiledNames),
  `bundle=${JSON.stringify(bundleNames)} tsc=${JSON.stringify(compiledNames)}`,
)
// Asserted against BOTH sides, not just the bundle: checking one side alone
// prints a reassuring PASS while the other half is broken — exactly the
// reading that let the drift sit unnoticed.
check(
  'the reserved package name is this package',
  bundleNames.length === 1
    && bundleNames[0] === packageName
    && compiledNames.length === 1
    && compiledNames[0] === packageName,
  `bundle=${JSON.stringify(bundleNames)} tsc=${JSON.stringify(compiledNames)}, package.json name is ${packageName}`,
)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
