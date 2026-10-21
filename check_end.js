const fs = require('fs');
const content = fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json', 'utf8');
console.log('File length:', content.length);
console.log('Content from 27580 to end:', JSON.stringify(content.slice(27580)));