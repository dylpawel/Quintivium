const fs = require('fs');
const content = fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json', 'utf8');

// The valid JSON ends at position 27585 (the last } before the comma at 27586)
// We need to keep 0 to 27585 inclusive, which is slice(0, 27586)
const fixed = content.slice(0, 27586);

try {
    JSON.parse(fixed);
    console.log('Fixed JSON is valid!');
    console.log('New length:', fixed.length);
    fs.writeFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json', fixed);
    console.log('File fixed!');
} catch (e) {
    console.error('Still invalid:', e.message);
}