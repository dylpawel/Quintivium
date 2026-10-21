const fs = require('fs');
try {
    const content = fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json', 'utf8');
    JSON.parse(content);
    console.log('Valid JSON');
    console.log('Length:', content.length);
    console.log('Last 20 chars:', JSON.stringify(content.slice(-20)));
} catch (e) {
    console.error('Invalid JSON:', e.message);
    console.error('Position:', e.message.match(/position (\d+)/)?.[1] || 'unknown');
}