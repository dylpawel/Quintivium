/**
 * Migration Script: Merge separate script files into map JSON files
 *
 * Run with: node migrate_scripts_to_maps.js
 *
 * This script:
 * 1. Reads scenario.json to get scriptFiles mapping
 * 2. For each map with a script file, loads the script file
 * 3. Merges scripts into the map JSON under "scripts" field
 * 4. Updates scenario.json to remove per-map script file entries (keep global only)
 * 5. Optionally backs up original files
 */

const fs = require('fs');
const path = require('path');

const SCENARIO_DIR = 'RpgApi/wwwroot/scenarios/mystic_island_PL';
const BACKUP_DIR = 'RpgApi/wwwroot/scenarios/mystic_island_PL/.backup_' + Date.now();

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
}

function backupFile(filePath) {
    ensureBackupDir();
    const relPath = path.relative(SCENARIO_DIR, filePath);
    const backupPath = path.join(BACKUP_DIR, relPath);
    const backupDir = path.dirname(backupPath);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.copyFileSync(filePath, backupPath);
    console.log(`  Backed up: ${relPath}`);
}

async function migrate() {
    console.log('Starting migration: Embed scripts into map files...\n');

    // 1. Load scenario.json
    const scenarioPath = path.join(SCENARIO_DIR, 'scenario.json');
    const scenario = readJson(scenarioPath);
    console.log(`Loaded scenario: ${scenario.title}`);

    // 2. Get scriptFiles mapping
    const scriptFiles = scenario.scriptFiles || ['scripts.json'];
    console.log(`Found ${scriptFiles.length} script file entries`);

    // 3. Process each script file entry
    const globalScriptFiles = [];
    const mapScriptMigrations = [];

    for (const entry of scriptFiles) {
        if (typeof entry === 'string') {
            // Global script file (no map scope)
            globalScriptFiles.push(entry);
            console.log(`  Global script file: ${entry}`);
        } else if (entry?.file && entry?.map) {
            // Per-map script file
            mapScriptMigrations.push({
                mapId: entry.map,
                scriptFile: entry.file
            });
            console.log(`  Map "${entry.map}" -> script file: ${entry.file}`);
        }
    }

    // 4. For each map, merge scripts into map JSON
    for (const { mapId, scriptFile } of mapScriptMigrations) {
        const mapPath = path.join(SCENARIO_DIR, 'maps', `${mapId}.json`);
        const scriptPath = path.join(SCENARIO_DIR, scriptFile);

        if (!fs.existsSync(mapPath)) {
            console.warn(`  WARNING: Map file not found: ${mapPath}`);
            continue;
        }

        if (!fs.existsSync(scriptPath)) {
            console.warn(`  WARNING: Script file not found: ${scriptPath}`);
            continue;
        }

        // Backup both files
        backupFile(mapPath);
        backupFile(scriptPath);

        // Load map and scripts
        const mapData = readJson(mapPath);
        const scripts = readJson(scriptPath);

        console.log(`  Merging ${scripts.length} scripts into ${mapId}.json`);

        // Clean scripts for embedding (remove fields not needed in map file)
        const cleanedScripts = scripts.map(s => {
            const cleaned = { ...s };
            // Ensure 'on' field (migrate from 'event' if needed)
            if (cleaned.event && !cleaned.on) {
                cleaned.on = cleaned.event;
            }
            delete cleaned.event;
            // Remove map field (will be implicit from map file)
            delete cleaned.map;
            // Remove enabled (default true)
            if (cleaned.enabled === true) delete cleaned.enabled;
            // Remove name (not used by engine)
            delete cleaned.name;
            // Remove empty condition
            if (!cleaned.condition || cleaned.condition.trim() === '') {
                delete cleaned.condition;
            }
            // Ensure id
            if (!cleaned.id) {
                cleaned.id = require('crypto').randomUUID();
            }
            return cleaned;
        });

        // Add scripts to map data
        mapData.scripts = cleanedScripts;

        // Write updated map
        writeJson(mapPath, mapData);
        console.log(`  ✓ Updated ${mapId}.json with ${cleanedScripts.length} scripts`);
    }

    // 5. Update scenario.json to only keep global script files
    scenario.scriptFiles = globalScriptFiles;
    backupFile(scenarioPath);
    writeJson(scenarioPath, scenario);
    console.log(`\n✓ Updated scenario.json - kept ${globalScriptFiles.length} global script file(s)`);

    console.log(`\nMigration complete!`);
    console.log(`Backups stored in: ${BACKUP_DIR}`);
    console.log(`\nNext steps:`);
    console.log(`1. Test the game to verify map_enter scripts work`);
    console.log(`2. Update editor to work with embedded scripts (remove scriptStorage.js usage)`);
    console.log(`3. Delete old *_script.json files after verification`);
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});