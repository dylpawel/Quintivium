const fs = require('fs');
const content = fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json', 'utf8');
console.log('File length:', content.length);
console.log('Position 27580-27600:', JSON.stringify(content.slice(27580, 27600)));
console.log('Position 27586:', content[27586]);
console.log('Char code at 27586:', content.charCodeAt(27586));