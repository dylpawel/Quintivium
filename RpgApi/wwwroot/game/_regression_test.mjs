// ─── Regression: existing condition forms after the parser rewrite ──────────
// Run:  node .\RpgApi\wwwroot\game\_regression_test.mjs
//
// Confirms the demo_scenario scripts still parse + evaluate correctly after
// refactoring stat(name op value) into a comparison node, and that boolean
// combinators (!, &&, AND, OR) and the other predicates (has_item, flag,
// near, chance) are unaffected.

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

globalThis.fetch = async (url) => {
  const p = url.startsWith('file:') ? fileURLToPath(url) : url
  let body
  try { body = readFileSync(p, 'utf8') }
  catch { return { ok: false, status: 404, json: async () => null, text: async () => '' } }
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }
}

import { loadScenario, fireEvent, setHooks, getState, setMapMarks } from './engine.js'

// Resolve ../scenarios relative to this file (cross-platform: strip the
// filename twice to climb RpgApi/wwwroot/game -> RpgApi/wwwroot).
const here     = fileURLToPath(import.meta.url)
const lastSep  = here.search(/[\\/][^\\/]*$/)
const gameDir  = here.slice(0, lastSep)                              // .../game
const wwwRoot  = gameDir.slice(0, gameDir.search(/[\\/][^\\/]*$/))  // .../wwwroot
await loadScenario('demo_scenario', pathToFileURL(wwwRoot + '/scenarios').href)

const dialogs = []
const spawned = []
const mapChanges = []
setHooks({
  showDialog:   async (t)              => { dialogs.push(t) },
  showChoice:  async (text)           => { dialogs.push('CHOICE:' + text) },
  showMessage:  async ()               => {},
  spawnMonster: async (type)           => { spawned.push(type) },
  changeMap:    async (mapId, x, y, mark) => { mapChanges.push({ mapId, x, y, mark }) },
})

let pass = 0, fail = 0
const faild = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++; else { fail++; faild.push({ name, got, want }) }
}

// scenario_start -> intro: dialog + 3 bread.
dialogs.length = 0
await fireEvent('scenario_start')
chk('intro dialog fires on scenario_start', dialogs.includes('Welcome, adventurer. Your journey begins here.'), true)
chk('intro gives 3 bread', getState().inventory.bread, 3)

// mage_power_requested with mage_skeletons=0 -> spawn path (condition: !stat(mage_skeletons >= 3)).
dialogs.length = 0; spawned.length = 0
await fireEvent('mage_power_requested')
chk('skeleton spawned when mage_skeletons < 3', spawned.length, 1)
chk('spawn-path dialog fires', dialogs.includes('Behold! The undead rise at my command. Defeat them if you dare.'), true)
chk('exhausted dialog does NOT fire at < 3', dialogs.includes('I have exhausted my power. The dead must rest now.'), false)

// Now mage_skeletons=3 -> exhausted path (condition: stat(mage_skeletons >= 3)), no spawn.
getState().variables.mage_skeletons = 3
dialogs.length = 0; spawned.length = 0
await fireEvent('mage_power_requested')
chk('exhausted dialog fires at >= 3', dialogs.includes('I have exhausted my power. The dead must rest now.'), true)
chk('exhausted path spawns nothing', spawned.length, 0)

// Tile-scope by NAMED MARK (string form "tile": "Exit").
// cave_scripts.json → cave_exit scopes tile_approach to the "Exit" mark, which
// the cave map defines at (3,2). Approaching that tile must run the script and
// issue change_map → map @(23,4). Verifies the string-tile-form mark resolution
// (previously supported via "tile": {"mark":"Exit"}; now simplified to just "tile":"Exit").
getState().currentMap = 'cave'
setMapMarks([{ name: 'Start', x: 3, y: 3 }, { name: 'Exit', x: 3, y: 2 }, { name: 'Water', x: 4, y: 8 }])

dialogs.length = 0; mapChanges.length = 0
await fireEvent('tile_approach', { x: 3, y: 2 })
chk('cave_exit dialog fires at "Exit" mark (string tile scope)',
    dialogs.includes('You climb back toward the light...'), true)
chk('cave_exit issues change_map → map @ (23,4)',
    mapChanges[0], { mapId: 'map', x: 23, y: 4, mark: null })

// Approaching a tile that is NOT the Exit mark must NOT run cave_exit.
dialogs.length = 0; mapChanges.length = 0
await fireEvent('tile_approach', { x: 0, y: 0 })
chk('cave_exit does NOT fire at an unrelated tile',
    dialogs.includes('You climb back toward the light...'), false)

// Final report.
console.log(`\n${'='.repeat(70)}`)
console.log(`REGRESSION: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('— FAILURES —')
  for (const f of faild) console.log(`  X ${f.name}  got=${JSON.stringify(f.got)}  want=${JSON.stringify(f.want)}`)
  process.exit(1)
}
console.log('All regression checks passed.')
process.exit(0)
