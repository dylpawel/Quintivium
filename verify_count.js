const fs = require('fs');
const map = JSON.parse(fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json'));
console.log('map.json scripts:', map.scripts.length);
map.scripts.forEach(s => console.log('  -', s.id));