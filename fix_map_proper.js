const fs = require('fs');
const content = fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json', 'utf8');
const map = JSON.parse(content);

// The 6 missing scripts from map_4_pieces.json
const missingScripts = [
    {
        "id": "spawn_map_boy",
        "on": "map_enter",
        "once": true,
        "actions": [
            {
                "type": "spawn_npc",
                "npc": "Hero-Boy",
                "x": 17,
                "y": 4,
                "id": "lost_boy"
            }
        ]
    },
    {
        "id": "found_4_map_pieces",
        "on": "tile_enter",
        "tile": { "x": 24, "y": 1 },
        "once": true,
        "actions": [
            {
                "type": "show_dialog",
                "text": "You discover a hidden cache tucked beneath a gnarled tree root. Inside, you find 4 tattered pieces of an old map, their edges singed and worn by time.",
                "item": "map_fragment"
            },
            {
                "type": "give_item",
                "item_id": "map_piece",
                "qty": 4
            }
        ]
    },
    {
        "id": "boy_interaction_success",
        "on": "npc_interact",
        "npc": "lost_boy",
        "condition": "has_item(map_piece, 4)",
        "actions": [
            {
                "type": "show_dialog",
                "speaker": "Young Pip",
                "text": "By the heavens! You found them! Look how the parchment fragments align—the ancient script is whole once more!",
                "item": "map_fragment"
            },
            {
                "type": "show_dialog",
                "speaker": "Young Pip",
                "text": "My father would have flayed me alive had I truly lost the charts to the King's highway. Bless you, noble traveler!"
            },
            {
                "type": "remove_item",
                "item_id": "map_piece",
                "qty": 4
            },
            {
                "type": "set_flag",
                "name": "boy_quest_complete"
            },
            {
                "type": "give_item",
                "item_id": "Gold",
                "qty": 20
            },
            {
                "type": "show_message",
                "text": "Quest Complete: Earned 20 Gold!",
                "duration": 4000
            }
        ]
    },
    {
        "id": "boy_interaction_remind",
        "on": "npc_interact",
        "npc": "lost_boy",
        "condition": "flag(lost_boy_met) && !has_item(map_piece, 4) && !flag(boy_quest_complete)",
        "actions": [
            {
                "type": "show_dialog",
                "speaker": "Young Pip",
                "text": "Alas, the winds still howl through the valleys, and my map remains shattered. Prithee, kind traveler, have you found the 4 missing pieces yet?",
                "item": "map_fragment"
            }
        ]
    },
    {
        "id": "boy_interaction_first_time",
        "on": "npc_interact",
        "npc": "lost_boy",
        "condition": "!flag(lost_boy_met) && !has_item(map_piece, 4) && !flag(boy_quest_complete)",
        "actions": [
            {
                "type": "show_dialog",
                "speaker": "Young Pip",
                "text": "... Oh, gentle traveler, pray lend your ear to a foolish boy's plight!"
            },
            {
                "type": "show_dialog",
                "speaker": "Young Pip",
                "text": "A sudden, foul squall swept through the square and tore my grandfather's old charting map right from my grasp! It ripped into four scattered pieces, carried off into the wild lands."
            },
            {
                "type": "show_dialog",
                "speaker": "Young Pip",
                "text": "Without it, the merchants cannot pass the misty vale. Should you find all 4 pieces of the map on your journey, I beg of you to return them to me!",
                "item": "map_fragment"
            },
            {
                "type": "set_flag",
                "name": "lost_boy_met"
            }
        ]
    },
    {
        "id": "boy_interaction_post_quest",
        "on": "npc_interact",
        "npc": "lost_boy",
        "condition": "flag(boy_quest_complete)",
        "actions": [
            {
                "type": "show_dialog",
                "speaker": "Young Pip",
                "text": "May the stars guide your path, brave hero! I shall never forget your kindness."
            }
        ]
    }
];

// Add the missing scripts to the map
map.scripts.push(...missingScripts);

// Write back the fixed file
fs.writeFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json', JSON.stringify(map));
console.log('Fixed! Total scripts:', map.scripts.length);
map.scripts.forEach(s => console.log('  -', s.id));