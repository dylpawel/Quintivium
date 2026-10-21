const fs = require('fs');
const content = fs.readFileSync('RpgApi/wwwroot/scenarios/demo_scenario/maps/map.json', 'utf8');

// Search for various ending patterns
console.log('Searching for ]}]:', content.indexOf(']}'));
console.log('Searching for ]}]}:', content.indexOf(']}]}'));
console.log('Searching for ]}}]:', content.indexOf(']}}]'));

// Look at the area around 27580
console.log('\nAround 27580:', JSON.stringify(content.slice(27570, 27600)));

// Search from the end
for (let i = content.length - 1; i >= content.length - 100; i--) {
    if (content[i] === '}' && content[i-1] === ']') {
        console.log('Found ]} at:', i-1, 'context:', JSON.stringify(content.slice(i-5, i+5)));
    }
}