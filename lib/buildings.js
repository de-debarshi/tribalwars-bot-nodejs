import * as cheerio from 'cheerio';

// Upgrade a building in a village, with resource check
async function upgradeBuilding({ buildingId, villageId, BASE_URL, CSRF_TOKEN, client, html, skipIfInsufficientResources }) {
    if (skipIfInsufficientResources && html) {
        const current = extractCurrentResources(html);
        const required = extractRequiredResources(html, buildingId);
        if (!required) {
            console.log(`❌ Could not find required resources for building ${buildingId}`);
            return;
        }
        if (current.wood < required.wood || current.stone < required.stone || current.iron < required.iron) {
            console.log(`⛔ Not enough resources to upgrade ${buildingId} in village ${villageId}. Needed:`, required, 'Available:', current);
            return;
        }
    }
    const postUrl = `${BASE_URL}/game.php?village=${villageId}&screen=main&ajaxaction=upgrade_building&type=main`;
    const qs = (await import('qs')).default;
    const postData = qs.stringify({
        id: buildingId,
        force: 1,
        destroy: 0,
        source: villageId,
        h: CSRF_TOKEN,
    });
    const postHeaders = {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Referer': `${BASE_URL}/game.php?village=${villageId}&screen=main`,
        'Origin': BASE_URL,
        'Tribalwars-Ajax': '1',
        'X-Requested-With': 'XMLHttpRequest',
    };
    const postRes = await client.post(postUrl, postData, { headers: postHeaders });
    console.log('Build upgrade response:', postRes.status);
}

// Extract building levels from HTML
function extractBuildingLevels(html) {
    const $ = cheerio.load(html);
    const buildingLevels = {};
    $('#buildings tr[id^="main_buildrow_"]').each((_, row) => {
        const $row = $(row);
        const id = $row.attr('id');
        const buildingId = id?.replace('main_buildrow_', '');
        if (buildingId) {
            const levelText = $row.find('span').first().text();
            const match = levelText.match(/Level (\d+)/);
            if (match) {
                buildingLevels[buildingId] = parseInt(match[1], 10);
            }
        }
    });
    return buildingLevels;
}

// Update village JSON with new building levels
function updateVillageJson(villageData, villageId, buildingLevels) {
    const village = villageData.villages.find(v => v.id === villageId);
    if (village) {
        village.buildingLevels = buildingLevels;
    }
    return villageData;
}

// Count the construction queue from HTML
function countConstructionQueue(html) {
    const $ = cheerio.load(html);
    const buildRows = $('#buildqueue tr').filter((_, el) => {
        const className = $(el).attr('class') || '';
        return className.includes('buildorder_');
    });
    return buildRows.length;
}

// Extract current resources from the header
function extractCurrentResources(html) {
    const $ = cheerio.load(html);
    return {
        wood: parseInt($('#wood').text().replace(/\D/g, ''), 10),
        stone: parseInt($('#stone').text().replace(/\D/g, ''), 10),
        iron: parseInt($('#iron').text().replace(/\D/g, ''), 10)
    };
}

// Extract required resources for a building from the buildings table
function extractRequiredResources(html, buildingId) {
    const $ = cheerio.load(html);
    const row = $(`#main_buildrow_${buildingId}`);
    if (!row.length) return null;
    return {
        wood: parseInt(row.find('.cost_wood').attr('data-cost') || '0', 10),
        stone: parseInt(row.find('.cost_stone').attr('data-cost') || '0', 10),
        iron: parseInt(row.find('.cost_iron').attr('data-cost') || '0', 10)
    };
}

// Get the time (in seconds) until the next building finishes from the build queue
function getNextBuildFinishTime(html) {
    const $ = cheerio.load(html);
    // Find the first build row with a data-endtime attribute
    const firstBuild = $('#buildqueue tr').find('span[data-endtime]').first();
    if (!firstBuild.length) return null;
    const endTime = parseInt(firstBuild.attr('data-endtime'), 10);
    if (!endTime) return null;
    const now = Math.floor(Date.now() / 1000);
    const secondsLeft = endTime - now;
    return secondsLeft > 0 ? secondsLeft : 0;
}

// Dummy: Get the time (in seconds) until the next research finishes
function getNextResearchFinishTime(html) {
    // TODO: Implement real parsing for research queue
    return 120; // 2 minutes
}

// Dummy: Get the time (in seconds) until the next troop training finishes
function getNextTroopFinishTime(html) {
    // TODO: Implement real parsing for troop training queue
    return 180; // 3 minutes
}

export {
    upgradeBuilding,
    extractBuildingLevels,
    updateVillageJson,
    countConstructionQueue,
    extractCurrentResources,
    extractRequiredResources,
    getNextBuildFinishTime,
    getNextResearchFinishTime,
    getNextTroopFinishTime
}; 