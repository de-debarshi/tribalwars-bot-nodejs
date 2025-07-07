import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

// Recruit troops in the barracks
async function recruitTroops({ villageId, troopType = 'spear', count = 1, units = null, BASE_URL, client, CSRF_TOKEN, html }) {
    // Use provided html (barracks page) and CSRF_TOKEN
    if (!html) {
        console.log('❌ Barracks HTML not provided for troop recruitment.');
        return;
    }
    if (!CSRF_TOKEN) {
        console.log('❌ CSRF token not provided for troop recruitment.');
        return;
    }
    const $ = cheerio.load(html);

    // If units object is provided, send all in one POST
    let postData;
    if (units && typeof units === 'object') {
        postData = { h: CSRF_TOKEN };
        for (const [type, cnt] of Object.entries(units)) {
            postData[`units[${type}]`] = cnt;
        }
    } else {
        // Single troop type fallback
        postData = {
            [`units[${troopType}]`]: count,
            h: CSRF_TOKEN
        };
    }
    const postUrl = `${BASE_URL}/game.php?village=${villageId}&screen=barracks&ajaxaction=train&mode=train&`;
    const qs = (await import('qs')).default;
    const postHeaders = {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Referer': `${BASE_URL}/game.php?village=${villageId}&screen=barracks`,
        'Origin': BASE_URL,
        'Tribalwars-Ajax': '1',
        'X-Requested-With': 'XMLHttpRequest',
    };
    try {
        const postRes = await client.post(postUrl, qs.stringify(postData), { headers: postHeaders });
        if (units && typeof units === 'object') {
            console.log(`✅ Recruited batch in village ${villageId}:`, units, 'Response:', postRes.status);
        } else {
            console.log(`✅ Recruited ${count} ${troopType}(s) in village ${villageId}. Response:`, postRes.status);
        }
    } catch (err) {
        if (units && typeof units === 'object') {
            console.error(`❌ Failed to recruit batch in village ${villageId}:`, units, err.message);
        } else {
            console.error(`❌ Failed to recruit ${troopType} in village ${villageId}:`, err.message);
        }
    }
}

// Load troop config template for a village using a mapping file
function getVillageTroopConfig(villageId, templatesDir = path.join(process.cwd(), 'templates')) {
    const mappingPath = path.join(process.cwd(), 'data/village_templates.json');
    if (!fs.existsSync(mappingPath)) {
        console.warn(`⚠️ Village-template mapping file not found: ${mappingPath}`);
        return null;
    }
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
    const templateFile = mapping[villageId];
    if (!templateFile) {
        console.warn(`⚠️ No template assigned for village ${villageId}`);
        return null;
    }
    const templatePath = path.join(templatesDir, templateFile);
    if (!fs.existsSync(templatePath)) {
        console.warn(`⚠️ Troop config template not found: ${templatePath}`);
        return null;
    }
    // Parse as JSON array
    try {
        const stages = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
        return stages;
    } catch (e) {
        console.warn(`⚠️ Failed to parse troop config template as JSON: ${templatePath}`);
        return null;
    }
}

// Given a villageId and its building levels, return the current troop stage config
function getCurrentTroopStage(villageId, buildingLevels, templatesDir = path.join(process.cwd(), 'templates')) {
    const stages = getVillageTroopConfig(villageId, templatesDir);
    if (!stages) return null;
    // Find all stages where the village's building level for stage.building >= stage.level
    const candidates = stages.filter(stage => {
        const bld = stage.building;
        const lvl = stage.level;
        return buildingLevels[bld] !== undefined && buildingLevels[bld] >= lvl;
    });
    if (candidates.length === 0) return null;
    // Pick the stage with the highest level for the relevant building
    const currentStage = candidates.reduce((max, stage) =>
        (!max || stage.level > max.level) ? stage : max, null);
    return {
        stage: currentStage,
        build: currentStage.build || {},
        upgrades: currentStage.upgrades || {},
        farm: currentStage.farm || []
    };
}

export { recruitTroops, getVillageTroopConfig, getCurrentTroopStage }; 