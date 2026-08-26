// ─── Unit tests for the condition evaluator + monster_defeat counters ─────────
// Run:  node .\RpgApi\wwwroot\game\_killcount_test.mjs
//
// Verifies the new condition syntax (string literals, monster_type('X'),
// kills / kills > 0 / kills >= N / kills['X'] / kills('X') / stat(total_kills))
// and the auto kill-counter semantics in engine.recordMonsterDefeat.
//
// The test scenario lives at ../scenarios/_qtest/. It is not listed in
// scenarios.json (loadScenario doesn't need the index), but it must exist on disk
// so fetch() can reach scenario.json + scripts.json.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

// Polyfill fetch() for file:// URLs — Node's global fetch doesn't support them.
globalThis.fetch = async (url) => {
  const path = url.startsWith('file:') ? fileURLToPath(url) : url
  let body
  try { body = readFileSync(path, 'utf8') }
  catch (e) { console.error('[fetch 404]', path, '·', e.code || e.message); return { ok: false, status: 404, json: async () => null, text: async () => '' } }
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(body),
    text: async () => body,
  }
}

import { loadScenario, setHooks, recordMonsterDefeat, getState } from './engine.js'

let passing = 0, failing = 0
const failures = []
function check(name, cond, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passing++
  else { failing++; failures.push({ name, got, want, cond }) }
}
function checkTrue(name, cond, val) {
  if (val) passing++
  else { failing++; failures.push({ name, cond, got: val }) }
}

// Capture dialog texts so we can observe which scripts fire on each kill.
const dialogs = []
setHooks({
  showDialog: async (text /*, speaker, items*/) => { dialogs.push(text) },
  showChoice: async () => {},
  showMessage: async () => {},
})

// Load the scenario: scripts.json defines a set of monster_defeated handlers.
// Use a file:// base so our fetch() shim can reach the on-disk scenario files.
const here     = fileURLToPath(import.meta.url)
const lastSep  = here.search(/[\\/][^\\/]*$/)
const gameDir  = here.slice(0, lastSep)                              // .../game
const wwwRoot  = gameDir.slice(0, gameDir.search(/[\\/][^\\/]*$/))  // .../wwwroot
const scenarioBase = pathToFileURL(wwwRoot + '/scenarios').href
await loadScenario('_qtest', scenarioBase)

const inv = () => getState().inventory
const vars = () => getState().variables

// ── Script recap (from scripts.json) ──────────────────────────────────────────
// loot_reaper   : monster_type('Skeleton Reaper') AND kills >= 2   → torch
// loot_skeleton : kills['Skeleton'] >= 3                           → bone
// loot_veteran  : stat(total_kills) >= 5                          → medal
// any_kill_msg  : kills > 0                                        → dialog "a kill happened"
// reaper_on1    : monster_type('Skeleton Reaper') AND kills('Orc') >= 99  → NEVER
// reaper_third  : monster_type('Skeleton Reaper') AND kills == 3        → dialog "third reaper"
// double_quote  : monster_type("Skeleton") AND kills >= 1              → dquote (double-quoted literal form)
// underscore    : monster_type('Skeleton_Reaper') AND kills >= 1         → underscore (space/underscore normalisation)
// callform      : kills('Skeleton Reaper') == 1                         → callform (call-form == bracket-form)

// helper: kill one monster and record what dialogs fired this event
function dialogsFiredThisEvent() {
  const n = dialogs.length
  return () => dialogs.slice(n)
}
function gaveThisEvent(before) {
  return Object.fromEntries(Object.entries(inv()).filter(([k, v]) => (before[k] ?? 0) !== v))
}
// True if `item` was granted this event (qty increased since `before`).
function grantedThis(before, item) {
  return inv()[item] >= (before[item] ?? 0) + 1
}
// Subset check: every key/value in `subset` must equal what was granted this event.
function grantedSubset(before, subset) {
  const g = gaveThisEvent(before)
  return Object.entries(subset).every(([k, v]) => g[k] === v)
}
// No items granted this event at all.
function grantedNone(before) {
  return Object.keys(gaveThisEvent(before)).length === 0
}

// ── 1) Skeleton (kill #1): dialog + dquote (double-quoted literal & kills>=1).
{
  const beforeInv = { ...inv() }
  const df = dialogsFiredThisEvent()
  await recordMonsterDefeat('Skeleton', 1, 2)
  check('counters: skeleton_kills == 1', 'skeleton_kill_1', vars().skeleton_kills, 1)
  check('counters: total_kills == 1',   'total_kill_1',     vars().total_kills, 1)
  checkTrue('"kills > 0" dialog fires', 'kill1_dialog', df().includes('a kill happened'))
  checkTrue('double-quoted monster_type("Skeleton") & kills>=1 → dquote', 'dquote1', grantedThis(beforeInv, 'dquote'))
  checkTrue('no torch/bone/medal on 1st kill', '1st_kill_loot', !grantedThis(beforeInv, 'torch') && !grantedThis(beforeInv, 'bone'))
}

// ── 2) Skeleton (kill #2): dialog only.
{
  const beforeInv = { ...inv() }
  const df = dialogsFiredThisEvent()
  await recordMonsterDefeat('Skeleton', 2, 3)
  check('skeleton_kills == 2', 'skel2', vars().skeleton_kills, 2)
  check('total_kills == 2',   'tot2',  vars().total_kills, 2)
  checkTrue('dialog only on 2nd skel', 'skel2_dialog', df().includes('a kill happened'))
  checkTrue('no bone yet (need 3)',    'bone2', !grantedThis(beforeInv, 'bone'))
}

// ── 3) Skeleton (kill #3): dialog + bone (monster_type('Skeleton') AND kills['Skeleton']>=3).
{
  const beforeInv = { ...inv() }
  const df = dialogsFiredThisEvent()
  await recordMonsterDefeat('Skeleton', 3, 4)
  check('skeleton_kills == 3', 'skel3', vars().skeleton_kills, 3)
  checkTrue('bone granted on 3rd skeleton', 'bone3', grantedThis(beforeInv, 'bone'))
}

// ── 4) Reaper (kill #4, 1st reaper): dialog + underscore + callform (kills('Skeleton Reaper')==1).
//      AND verify the skeleton gate: bone(Skeleton>=3) does NOT fire — event isn't a Skeleton.
{
  const beforeInv = { ...inv() }
  const df = dialogsFiredThisEvent()
  await recordMonsterDefeat('Skeleton Reaper', 4, 5)
  check('reaper_kills == 1', 'reap1', vars().skeleton_reaper_kills, 1)
  check('total_kills == 4', 'tot4',  vars().total_kills, 4)
  checkTrue('underscore form of monster_type matches, kills>=1', 'underscore4', grantedThis(beforeInv, 'underscore'))
  checkTrue('call form kills("Skeleton Reaper") == 1 (1st reaper)', 'callform4', grantedThis(beforeInv, 'callform'))
  checkTrue('skeleton-type gate holds: no bone on a reaper kill', 'skel3_gate', !grantedThis(beforeInv, 'bone'))
  checkTrue('no torch on 1st reaper (kills=1)', 'torch4', !grantedThis(beforeInv, 'torch'))
}

// ── 5) Reaper (kill #5, 2nd): torch (kills>=2) + medal (total>=5).
{
  const beforeInv = { ...inv() }
  await recordMonsterDefeat('Skeleton Reaper', 5, 6)
  check('reaper_kills == 2', 'reap2', vars().skeleton_reaper_kills, 2)
  check('total_kills == 5', 'tot5',  vars().total_kills, 5)
  checkTrue('torch on 2nd reaper (kills>=2)', 'torch5', grantedThis(beforeInv, 'torch'))
  checkTrue('medal on 5th total kill',          'medal5', grantedThis(beforeInv, 'medal'))
}

// ── 6) Reaper (kill #6, 3rd): torch + medal + "third reaper" + kill msg.
{
  const beforeInv = { ...inv() }
  const df = dialogsFiredThisEvent()
  await recordMonsterDefeat('Skeleton Reaper', 6, 7)
  check('reaper_kills == 3', 'reap3', vars().skeleton_reaper_kills, 3)
  checkTrue('torch again on 3rd reaper', 'torch6', grantedThis(beforeInv, 'torch'))
  checkTrue('medal again on 6th kill',   'medal6', grantedThis(beforeInv, 'medal'))
  checkTrue('both "third reaper" & kill msg fire', 'both_dialogs6',
            df().includes('a kill happened') && df().includes('third reaper'))
}

// ── 7) Negatives
checkTrue('Orc>=99 listener never fired', 'orc_guard', !('should_never_fire' in inv()))

// ── 8) Victory message on every kill (6 kills)
check('a kill message logged on all 6 kills', 'kill_msgs', dialogs.filter(d => d === 'a kill happened').length, 6)

// ── 9) Final tally sanity
check('final skeleton_kills == 3', 'fin_skel',  vars().skeleton_kills, 3)
check('final reaper_kills == 3',   'fin_reap',  vars().skeleton_reaper_kills, 3)
check('final total_kills == 6',    'fin_total', vars().total_kills, 6)

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(70)}`)
console.log(`KILL-COUNTER TESTS: ${passing} passed, ${failing} failed`)
if (failing) {
  console.log('— FAILURES —')
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`)
    console.log(`      got : ${JSON.stringify(f.got)}`)
    if (f.want !== undefined) console.log(`      want: ${JSON.stringify(f.want)}`)
  }
  process.exit(1)
} else {
  console.log('All checks passed.')
  process.exit(0)
}
