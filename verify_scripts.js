const fs = require('fs');
const map = JSON.parse(fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json'));
const cave = JSON.parse(fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/cave.json'));
const scenario = JSON.parse(fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/scenario.json'));

const output = [];
output.push('=== MAP.JSON ===');
output.push('Scripts count: ' + map.scripts.length);
map.scripts.forEach(s => output.push('  - ' + s.id));

output.push('\n=== CAVE.JSON ===');
output.push('Scripts count: ' + cave.scripts.length);
cave.scripts.forEach(s => output.push('  - ' + s.id));

output.push('\n=== SCENARIO.JSON ===');
output.push('Has scriptFiles: ' + ('scriptFiles' in scenario));

fs.writeFileSync('verify_output.txt', output.join('\n'));
console.log('Done - output written to verify_output.txt');