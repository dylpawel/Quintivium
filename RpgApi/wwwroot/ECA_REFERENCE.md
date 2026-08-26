# ECA Script Reference

Scripts are defined in `scripts.json` as an array of script objects. Each script listens for an event, optionally checks a condition, and runs a list of actions.

```json
{
  "id": "my_script",
  "on": "<event>",
  "condition": "<optional condition expression>",
  "once": true,
  "actions": [ ... ]
}
```

| Field | Required | Description |
|---|---|---|
| `id` | ✓ | Unique identifier. Used for `once` tracking. |
| `on` | ✓ | Event name to listen for (built-in or custom). |
| `condition` | | Condition expression. Script is skipped if it evaluates to false. |
| `once` | | If `true`, the script fires at most once per session. |
| `map` | | Scope the script to a specific map id. Auto-applied when using per-map script files (see below). |
| `tile` | | Scope `tile_approach` / `tile_enter` to a specific tile. A plain string `"markName"` resolves to that named mark on the map; `{ "x": n, "y": n }` targets an explicit tile. |
| `npc` | | Scope `npc_interact` scripts to a specific NPC id. |
| `actions` | ✓ | Array of action objects to execute in order. |

---

## Multiple script files

Instead of a single `scripts.json`, a scenario can split scripts across multiple files. Declare them in `scenario.json`:

```json
"scriptFiles": [
  "scripts.json",
  { "file": "map_scripts.json", "map": "map" },
  { "file": "cave_scripts.json", "map": "cave" }
]
```

- A plain string entry (`"scripts.json"`) loads the file with no automatic map scope.
- An object entry with `"map"` automatically applies that map scope to every script in the file that doesn't already have one — so the `"map"` field can be omitted from individual scripts inside those files.

If `scriptFiles` is absent the engine falls back to loading `scripts.json` as before.

---

## Events

### Built-in events

| Event | When it fires | Context fields |
|---|---|---|
| `scenario_start` | Once when the scenario is first loaded. | — |
| `map_enter` | When the player enters a map. | `map_id` |
| `tile_approach` | When the player tries to step onto a tile (before moving). | `x`, `y` |
| `tile_enter` | After the player successfully moves onto a tile. | `x`, `y` |
| `npc_interact` | When the player interacts with (bumps into) an NPC. | `npc_id`, `x`, `y` |
| `monster_defeated` | When the player wins a battle against a monster (walk-in or `start_combat`). Auto-increments kill counters. | `monster_type`, `x`, `y`, `kills`, `total_kills` |

### Custom events

Any string not listed above is a custom event. Custom events only fire when a `fire_event` action explicitly triggers them.

```json
{ "type": "fire_event", "event": "my_custom_event" }
```

Scripts listen for them the same way:

```json
{ "id": "handler", "on": "my_custom_event", ... }
```

---

## Conditions

The `"condition"` field on a script (or on a choice — see below) is a boolean expression string.

### Logic operators

| Syntax | Meaning |
|---|---|
| `A && B` or `A AND B` | Both must be true |
| `A \|\| B` or `A OR B` | At least one must be true |
| `!A` or `NOT A` | Negation |
| `(A && B) \|\| C` | Grouping with parentheses |

### String literals

Type names and any future value with spaces are written as **quoted string literals** using
single or double quotes (with `\` escapes). They are used as arguments to condition functions
such as `monster_type('Skeleton Reaper')`. Unquoted identifiers still work when the value has
no spaces (`flag(my_flag)`, `has_item(bread)`, `map(cave)`).

```
monster_type('Skeleton Reaper')          // single quotes
monster_type("Skeleton Reaper")          // double quotes
```

> **Why:** monster names contain spaces (`"Skeleton Reaper"`); the bare-identifier form
> can't express that. Quotes keep the grammar consistent and let values include spaces.

### Condition functions

#### `flag(name)`
True if the named flag has been set.
```
flag(cooper_visited)
```

#### `flag(name, value)`
True if the flag equals the given string value.
```
flag(quest_stage, started)
```

#### `stat(name op value)`
Numeric variable comparison. Operators: `>=`, `<=`, `>`, `<`, `==`, `!=`.
```
stat(mage_skeletons >= 3)
stat(gold > 0)
```

#### `has_item(item_id)`
True if the player has at least 1 of the item.
```
has_item(bread)
```

#### `has_item(item_id, qty)`
True if the player has at least `qty` of the item.
```
has_item(potion, 2)
```

#### `has_tag(tag)`
True if the player has any item whose id contains the given tag string.
```
has_tag(key)
```

#### `chance(probability)`
True with the given probability (0.0–1.0) — evaluated fresh each time.
```
chance(0.3)
```

#### `map(map_id)`
True if the player is currently on the given map.
```
map(cave)
```

#### `near(x, y, radius)`
True if the player's current tile is within `radius` tiles (Euclidean) of `(x, y)`.
```
near(10, 10, 3)
```

### Kill counts & monster type

These three predicates are meaningful inside `monster_defeated` scripts; `kills('Type')`
and `stat(total_kills)` also work in any other event (they read persisted counters).

Diagnostics: defeating a monster of type **X**

- increments the persisted counter `state.variables.<x>_kills` (e.g. `Skeleton` → `skeleton_kills`,
  `Skeleton Reaper` → `skeleton_reaper_kills`) — readable everywhere via `stat(<x>_kills op value)`;
- increments a global `state.variables.total_kills`;
- fires `monster_defeated` with context fields `monster_type`, `x`, `y`, `kills` (this type's
  running tally, including the just-counted defeat), `total_kills`.

#### `monster_type('Type')`
Boolean: true if the slain monster's type matches **Type**. Comparison is case-insensitive and
ignores spaces vs underscores, so `monster_type('Skeleton_Reaper')` matches `"Skeleton Reaper"`.

#### `kills`  · `kills > 0`  · `kills >= N`
The **context variable** `kills` resolves to the current event's per-type tally (see above) when
available, else `0`. Used bare it's a truthiness check (`!= 0`); with `op value` it's a numeric
comparison. Equivalent idioms:

```
kills                       // any kill happened this event (kills != 0)
kills > 0                   // same thing, explicit
kills >= 2                  // this is the 2nd kill of the same type
```

#### `kills['Type']`  /  `kills('Type')`
Numeric: the running tally for **Type**. Both forms are identical. Inside a `monster_defeated`
event *of that type*, it reads the bound event value; otherwise (or from any other event) it
reads the persisted `<x>_kills` counter.

```
kills['Skeleton'] >= 3                   // 3+ Skeletons defeated (any event)
kills('Skeleton Reaper') == 1            // exactly one Reaper, so far
monster_type('Skeleton') AND kills['Skeleton'] == 3   // gated form — fires on the 3rd Skeleton
```

> **Tip — always gate per-type counts with `monster_type('...')`.** `kills['Type'] >= N` alone has no
> idea *which* monster the current event is about, so once the threshold is met it would match every
> subsequent kill of any type. Pair it with `monster_type('Type')` (or use the bound `kills >= N`) so
> the script only fires on kills of that type.

#### `stat(total_kills op value)`
The global cross-type kill tally via the existing `stat(...)`. No type gate applies — it's a total.

### Examples

```
flag(cooper_visited) && !stat(mage_skeletons >= 3)
near(10, 10, 3) && chance(0.3)
has_item(key) || flag(door_unlocked)
stat(hp <= 5) && map(dungeon)
monster_type('Skeleton Reaper') && kills >= 2
stat(total_kills >= 10)
```

---

## Actions

### Narrative

#### `show_dialog`
Shows a dialog box the player must dismiss (Space / Enter).

```json
{ "type": "show_dialog", "text": "Hello, adventurer." }
{ "type": "show_dialog", "speaker": "Hero-Mage", "text": "I guard these lands." }
```

| Field | Description |
|---|---|
| `text` | Message to display. |
| `speaker` | Optional speaker name shown above the text. |
| `give` | Optional object map `{ item_id: qty }` — items granted to the player *and* shown as icons with quantity badges. |
| `show` | Optional object map `{ item_id: qty }` — items shown as icons with quantity badges but **not** granted. Useful for "you need X to craft this" prompts. |
| `item` / `items` | Legacy icon-only display (no quantity badges). `show` / `give` take priority when present. |

**Display precedence** for which icons appear: `show` → `give` → `items`/`item`. So if both `give` and `show` are set, only the `show` items are displayed (the `give` items are still granted, just not shown — use this when granted items differ from what you want pictured).

**Shortcut — give-and-show rewards.** Combine `give` with `text` to hand out items and picture them in one action:

```json
{
  "type": "show_dialog",
  "speaker": "Carpenter",
  "text": "Here, take these materials.",
  "give": { "nail": 3, "plank": 2 }
}
```

This grants 3 nails and 2 planks to the inventory *and* displays their sprites with `×3` / `×2` badges in the dialog — no separate `give_item` actions needed.

**Show-only.** `show` displays items without granting them:

```json
{
  "type": "show_dialog",
  "speaker": "Blacksmith",
  "text": "Bring me these and I'll forge you a blade.",
  "show": { "iron_ore": 5, "coal": 2 }
}
```

---

#### `show_choice`
Shows a prompt with a list of buttons. Runs the chosen option's `actions`.

```json
{
  "type": "show_choice",
  "text": "What do you seek?",
  "choices": [
    { "label": "Nothing. Farewell." },
    {
      "label": "Show me your power!",
      "condition": "stat(mage_skeletons >= 1)",
      "actions": [
        { "type": "fire_event", "event": "mage_power_requested" }
      ]
    }
  ]
}
```

| Field | Description |
|---|---|
| `text` | Prompt displayed above the choices. |
| `choices` | Array of choice objects (see below). |

**Choice object fields:**

| Field | Description |
|---|---|
| `label` | Button text shown to the player. |
| `condition` | Optional condition. Choice is hidden if it evaluates to false. |
| `actions` | Optional array of actions to run when this choice is selected. |

Players can select choices with mouse click or by pressing the number key (1, 2, 3...).

---

#### `show_message`
Shows a brief timed overlay message (does not block movement).

```json
{ "type": "show_message", "text": "You gained 10 XP!", "duration": 3000 }
```

| Field | Description |
|---|---|
| `text` | Message to display. |
| `duration` | Display time in milliseconds. Default: `3000`. |
| `item` / `items` | One or more item/crafting IDs to show as sprites alongside the text. `item` accepts a single string, `items` an array. |

---

### Environment

#### `set_weather`
Sets the atmospheric weather for the current map. Weather is **per-map and persistent in-session** — it survives `change_map` transitions (stored in engine state, not re-asserted on entry). A `transition_secs` value tweens all numeric params smoothly; omit it (or set `0`) to snap instantly.

```json
{ "type": "set_weather", "weather": "rain", "intensity": 0.6, "wind": 80, "transition_secs": 2 }
{ "type": "set_weather", "weather": "none", "transition_secs": 2 }
```

| Field | Description |
|---|---|
| `weather` | `none` \| `rain` \| `snow`. (Atmospheric effects only. Overlays like **night** and **sunset** are controlled via `set_lighting`, below — they are not weather. Weather and lighting compose freely, e.g. night+rain or sunset+rain.) |
| `intensity` | Particle density, `0..1`. Default `0.6` (or `0` for `none`). |
| `wind` | Horizontal particle tilt in px/s. Positive = blowing right. Default `0`. Clamped to `±100` (`MAX_WIND`); values beyond saturate to the cap. **Also drives decorations:** wind-aware trees/bushes lean downwind and sway harder in proportion to `wind`, so a storm visibly bends the foliage in the same direction the rain/snow is drifting. The decoration bend is quantized into 5 buckets — `wind` in `(-25, 25]` leaves decorations swaying exactly as authored (flat base, no lean), `|wind| > 75` saturates to the full lean, and 25–75 is a half-lean between. It's pixel art, so 5 levels is enough for the eye to read the bend cleanly. The decoration bend follows weather transitions just like the particles, so `set_weather ... wind=80 transition_secs=2` ramps the foliage lean in over the same 2s. |
| `transition_secs` | Optional tween duration. Omit/`0` for an instant change. |

A map may also author a default in `scenario.json`:

```json
"weather": { "map": { "type": "rain", "intensity": 0.35, "wind": 25 } }
```

Unlisted maps default to clear.

---

#### `set_lighting`
Sets the **darkness / lighting overlay** for the current map — this is how night and sunset are created (they are overlays, deliberately separate from `set_weather`). Like weather, it is per-map and persists in-session. Lighting composes with weather, so night+rain and sunset+rain both work. Night transitions are automatically slowed (2×) so dusk/dawn read as a paced dimming rather than a cut.

```json
{ "type": "set_lighting", "lighting": "night", "transition_secs": 4 }
{ "type": "set_lighting", "lighting": "sunset", "transition_secs": 3 }
{ "type": "set_lighting", "lighting": "day", "transition_secs": 4 }
{ "type": "set_lighting", "lighting": { "col": [0, 1, 10], "a": 0.8 }, "transition_secs": 4 }
```

| Field | Description |
|---|---|
| `lighting` | A **named preset** (`"night"` deep-blue dark, `"sunset"` warm radial glow, `"day"` cleared) or an **object** `{ "mode": "flat"|"sunset", "col": [r,g,b], "a": alpha }`. `mode` defaults to `flat` — a solid rgba fill; `sunset` paints the cached screen-space radial glow. `a` is the overlay alpha (`0` = fully lit, `1` = pitch black; sunset reads as authored at `a≈0.18`). |
| `transition_secs` | Optional tween duration. Omit/`0` for an instant change. During a transition `col` and `a` both interpolate from the prior overlay toward the target, so day→night and night→sunset animate smoothly; across a flat↔sunset mode change the target mode fades its alpha in. Night uses a 2× slower tween automatically. |

A map may author a default in `scenario.json`:

```json
"lighting": { "map": { "col": [0, 1, 10], "a": 0.9 } }
"lighting": { "cave": { "col": [0, 0, 0], "a": 0.95 } }
```

**Light sources.** While a darkness overlay is active, light sources punch through it: fires placed as map effects (`fire`, `fire_2`, `fire_big`) and a player-held `torch` (granted via `give_item`) each add a soft, additive radial glow. Overlapping lights preserve their hue (red + yellow → orange), since the glow field is accumulated in an offscreen buffer with capped per-light intensity. No ECA wiring is needed for these — they are detected automatically by the renderer.

See `map_scripts.json` → `farmer_weather` for a working example that lets the player toggle night/sunset/day via `set_lighting`.

---

### Movement

#### `block_move`
Cancels the movement that triggered this script. Only meaningful in `tile_approach` scripts.

```json
{ "type": "block_move" }
```

---

### Flags & Variables

#### `set_flag`
Sets a boolean flag.

```json
{ "type": "set_flag", "name": "cooper_visited" }
{ "type": "set_flag", "name": "door_open", "value": false }
```

| Field | Description |
|---|---|
| `name` | Flag name. |
| `value` | Optional. Defaults to `true`. Set to `false` to clear. |

---

#### `clear_flag`
Removes a flag entirely (equivalent to it never being set).

```json
{ "type": "clear_flag", "name": "cooper_visited" }
```

---

#### `set_variable`
Sets a numeric (or string) variable to an exact value.

```json
{ "type": "set_variable", "name": "mage_skeletons", "value": 0 }
```

---

#### `add_variable`
Adds a delta to a numeric variable. Variable starts at 0 if not set.

```json
{ "type": "add_variable", "name": "mage_skeletons", "delta": 1 }
{ "type": "add_variable", "name": "score", "delta": -5 }
```

---

### Inventory

#### `give_item`
Adds items to the player's inventory.

```json
{ "type": "give_item", "item_id": "bread", "qty": 3 }
```

| Field | Description |
|---|---|
| `item_id` | Item identifier string. |
| `qty` | Amount to give. Default: `1`. |

---

#### `remove_item`
Removes items from the player's inventory (minimum 0).

```json
{ "type": "remove_item", "item_id": "bread", "qty": 1 }
```

---

### World

#### `fire_event`
Fires a custom event immediately, running all matching scripts.

```json
{ "type": "fire_event", "event": "mage_power_requested" }
{ "type": "fire_event", "event": "trap_triggered", "data": { "trap_id": "spike_pit" } }
```

| Field | Description |
|---|---|
| `event` | Event name to fire. |
| `data` | Optional extra fields merged into the event context. |

---

#### `change_map`
Moves the player to a different map.

```json
{ "type": "change_map", "map_id": "cave", "mark": "Start" }
{ "type": "change_map", "map_id": "map", "x": 23, "y": 4 }
```

| Field | Description |
|---|---|
| `map_id` | Target map identifier. |
| `mark` | Named tile on the target map to spawn at (from the map's `marks` array). Takes priority over `x`/`y`. |
| `x`, `y` | Optional explicit spawn coordinates. Used if `mark` is not set. |

Maps define named tiles in their JSON under `"marks": [{ "name": "Start", "x": 3, "y": 3 }, ...]`. These names can be used in `tile` scope filters in two ways (the string form is preferred shorthand):

```json
"tile": "Start"            // named mark
"tile": { "x": 3, "y": 3 } // explicit coords
```

---

#### `spawn_monster`
Spawns a monster on the current map.

```json
{ "type": "spawn_monster", "monster": "Skeleton" }
{ "type": "spawn_monster", "monster": "Orc", "x": 10, "y": 8 }
{ "type": "spawn_monster", "monster": "OrcWarrior", "x": 20, "y": 10, "radius": 3 }
{ "type": "spawn_monster", "monster": "Boss", "pool": 3 }
{ "type": "spawn_monster", "monster": "Orc", "pool": "1..3" }
{ "type": "spawn_monster", "monster": "Mixed", "pool": "2,3" }
```

| Field | Description |
|---|---|
| `monster` | Monster type name. |
| `x`, `y` | Optional exact spawn tile. Random walkable tile used if omitted. |
| `radius` | If set, spawns within this radius of `(x, y)`. |
| `pool` | Optional question pool spec for battles with this monster. Overrides global pool. Formats: `2` (single), `"1,3"` (list), `"1..3"` (range). |

---

#### `spawn_npc`
Spawns an NPC on the current map.

```json
{ "type": "spawn_npc", "npc": "Hero-Mage", "x": 4, "y": 18, "id": "mage" }
{ "type": "spawn_npc", "npc": "Merchant", "x": 10, "y": 5, "id": "merchant", "flip_x": true }
```

| Field | Description |
|---|---|
| `npc` | NPC type name — matches the entry in `NPC_DEFS` and the sprite filename (without `.png`) in `characters/`. |
| `x`, `y` | Spawn tile position. |
| `id` | Unique NPC identifier used for `npc_interact` scoping. |
| `flip_x` | Optional. Mirrors the sprite horizontally. Default: `false`. |

---

#### `pick_random`
Runs the actions of one randomly chosen entry from a pool.

```json
{
  "type": "pick_random",
  "choices": [
    { "actions": [ { "type": "show_dialog", "text": "The wind whispers secrets." } ] },
    { "actions": [ { "type": "show_dialog", "text": "A crow watches you silently." } ] },
    { "actions": [ { "type": "show_dialog", "text": "You hear distant thunder." } ] }
  ]
}
```

| Field | Description |
|---|---|
| `choices` | Array of objects, each with an `actions` list. One is picked at random with equal probability. |

---

#### `remove_decoration`
Removes the decoration at the given tile position from the current map. The change persists when the player returns to the map.

```json
{ "type": "remove_decoration", "x": 5, "y": 12 }
```

| Field | Description |
|---|---|
| `x`, `y` | Tile coordinates of the decoration to remove. |

---

#### `spawn_decoration`
Spawns an asset as a decoration on the current map at the given tile. Overwrites any
decoration already on that cell. The decoration persists for the session while you
remain on (and return to) the map, exactly like one placed in the editor.

```json
{ "type": "spawn_decoration", "asset_id": "chest", "x": 10, "y": 8 }
```

| Field | Description |
|---|---|
| `asset_id` | Asset identifier string (an entry in `assets/definitions.json`). |
| `x`, `y` | Tile coordinates to place the decoration at. |

The decoration is placed centered on the cell (no random jitter / flip), so it lands
exactly where you target it — e.g. dropping a rock `rocks_6` onto a water tile.

---

#### `spawn_item`
Spawns an item on the current map at the given tile. The item is visible on the map
and is automatically collected when the player enters the tile. The item is added to
the player's inventory (with auto-equip if applicable) and a toast message is shown.

```json
{ "type": "spawn_item", "item_id": "gold", "x": 10, "y": 8, "qty": 5 }
```

| Field | Description |
|---|---|
| `item_id` | Item identifier string (an entry in `assets/items.json`). |
| `x`, `y` | Tile coordinates to place the item at. |
| `qty` | Quantity to spawn (default: 1). |

The item renders centered on the tile like a decoration. When the player steps on
the tile, the item is collected, added to inventory, and removed from the map. The
collection shows a message using the same toast system as `show_message` (3000ms).
Items placed via `spawn_item` persist in save/load; collected items are absent after
save/load.

---

#### `change_tile`
Replaces a single tile's terrain on the current map — e.g. turning water to grass to
forge a land bridge, or sinking sand into water. The change persists in-session (it
mirrors painting the tile in the editor), so it survives leaving and returning to the
map. Terrain renders, the blocked grid, and water-edge masks are all rebuilt, so
traversability updates and any new water/non-water borders blend correctly.

```json
{ "type": "change_tile", "tile": "BridgeMark", "terrain": "grass" }
{ "type": "change_tile", "x": 12, "y": 8, "terrain": "water" }
{ "type": "change_tile", "tile": { "x": 5, "y": 3 }, "terrain": "sand" }
```

| Field | Description |
|---|---|
| `terrain` | Destination terrain. Either a numeric terrain id (e.g. `7`) or a terrain **name** string (`"grass"`, `"water"`, `"sand"` — case-insensitive, spaces vs underscores equivalent). |
| `tile` | Target tile — a `"MarkName"` string (named mark, same shorthand as the `tile` scope filter) or `{ "x": n, "y": m }`. Takes priority over `mark`/`x`/`y`. |
| `mark` | Named tile on the current map to target. Used only if `tile` is not set. |
| `x`, `y` | Explicit target tile coordinates. Used if neither `tile` nor `mark` is set. |

> **Edge case — the player's own tile.** Traversability is only checked on attempted
> *moves*, so changing the tile the player currently stands on never traps them; they
> simply can't step back onto it after leaving (e.g. turning your footing to water
> then walking off works, but re-entering that tile is blocked). This matches the
> editor's behaviour.

---

### Combat

#### `start_combat`
Starts a battle against a monster type.

```json
{ "type": "start_combat", "enemy_id": "OrcShaman" }
```

| Field | Description |
|---|---|
| `enemy_id` | Enemy type name. |

If the player wins, execution continues with the next action. The script stops (blocked) if the player loses or flees.

---

### Scenario flow

#### `end_scenario`
Ends the current scenario, optionally transitioning to another.

```json
{ "type": "end_scenario" }
{ "type": "end_scenario", "next": "scenario_2" }
```

| Field | Description |
|---|---|
| `next` | Optional id of the next scenario to load. |

---

#### `set_question_pool`
Sets the global question pool spec for battles. This overrides the default (pool 1) for all subsequent battles unless a monster specifies its own pool via `spawn_monster`.

```json
{ "type": "set_question_pool", "pool": 2 }
{ "type": "set_question_pool", "pool": "1..3" }
{ "type": "set_question_pool", "pool": "1,3" }
```

| Field | Description |
|---|---|
| `pool` | Question pool specification. Formats: `2` (single pool), `"1,3"` (discrete list), `"1..3"` (range). Can be a number or string. |

---

#### `clear_question_pool`
Clears the global question pool spec, reverting to the default (pool 1 only).

```json
{ "type": "clear_question_pool" }
```

| Field | Description |
|---|---|
| (none) | No fields required. |

---

## Full script example

```json
[
  {
    "id": "guard_talk",
    "on": "npc_interact",
    "npc": "guard",
    "actions": [
      { "type": "show_dialog", "speaker": "Guard", "text": "Halt! Who goes there?" },
      { "type": "show_choice", "text": "Choose your response:", "choices": [
        {
          "label": "I am a friend.",
          "actions": [
            { "type": "set_flag", "name": "guard_friendly" },
            { "type": "show_dialog", "speaker": "Guard", "text": "Pass, friend." }
          ]
        },
        {
          "label": "None of your business.",
          "actions": [
            { "type": "show_dialog", "speaker": "Guard", "text": "Then you shall not pass!" },
            { "type": "start_combat", "enemy_id": "Guard" }
          ]
        },
        {
          "label": "I bring a bribe.",
          "condition": "has_item(gold_coin, 5)",
          "actions": [
            { "type": "remove_item", "item_id": "gold_coin", "qty": 5 },
            { "type": "set_flag", "name": "guard_bribed" },
            { "type": "show_dialog", "speaker": "Guard", "text": "...Very well. Carry on." }
          ]
        }
      ]}
    ]
  },
  {
    "id": "gate_block",
    "on": "tile_approach",
    "map": "town",
    "tile": { "x": 12, "y": 8 },
    "condition": "!flag(guard_friendly) && !flag(guard_bribed)",
    "actions": [
      { "type": "show_dialog", "text": "The guard blocks your path." },
      { "type": "block_move" }
    ]
  }
]
```
