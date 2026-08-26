// ─── Runs both engine test suites and reports a single pass/fail ────────────
// Run from this directory:
//     node .\RpgApi\wwwroot\game\_run_tests.mjs
//
// Exits non-zero if any suite fails. Both child scripts set their own exit code;
// we surface a combined status so a CI check or `&&` build chain can gate on it.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here   = fileURLToPath(import.meta.url)
const dir    = here.slice(0, here.search(/[\\/][^\\/]*$/))

const suites = ['_killcount_test.mjs', '_regression_test.mjs']
let failed = 0

for (const s of suites) {
  console.log(`\n### ${'='.repeat(68)}\n### ${s}\n### ${'='.repeat(68)}`)
  const r = spawnSync('node', [dir + '/' + s], { stdio: 'inherit' })
  if (r.status !== 0) { failed++ }
}

console.log(`\n${'='.repeat(70)}`)
console.log(failed ? `OVERALL: ${failed} suite(s) FAILED` : 'OVERALL: all suites passed')
process.exit(failed ? 1 : 0)
