import axios from 'axios';
import * as cheerio from 'cheerio';
import qs from 'qs';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { sleep } from './lib/utils.js';
import {
  upgradeBuilding,
  extractBuildingLevels,
  updateVillageJson,
  countConstructionQueue,
  extractCurrentResources,
  extractRequiredResources,
  getNextBuildFinishTime,
  getNextResearchFinishTime,
  getNextTroopFinishTime
} from './lib/buildings.js';
import { recruitTroops, getCurrentTroopStage } from './lib/troops.js';
import { fetchAndSaveVillageMap, findNearestFarms, sendFarmAttack, parseVillageMapFull, getVillageCoords } from './lib/farming.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_CONFIG_PATH = path.join(__dirname, 'data/bot_config.json');
const botConfig = JSON.parse(fs.readFileSync(BOT_CONFIG_PATH, 'utf-8'));
const BASE_URL = botConfig.BASE_URL;
const BATCH_SIZE = botConfig.BATCH_SIZE || 5;

const COOKIE_STRING = botConfig.COOKIE_STRING;
const BASE_VILLAGE_ID = '3095';

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

const villageId = BASE_VILLAGE_ID;
const CONTINUE_TO_RUN = true;

let $ = null;
let CSRF_TOKEN = null;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'villages.json');
const CONFIG_PATH = path.join(__dirname, 'data/config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

 function loadVillageData() {
  if (fs.existsSync(DATA_PATH)) {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  }
  return { lastUpdated: null, villages: [] };
}

 function saveVillageData(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

const buildPlanPath = path.join(__dirname, 'templates/purple_predator.txt');
const buildPlanRaw = fs.readFileSync(buildPlanPath, 'utf-8');

const buildQueue = buildPlanRaw
  .split('\n')
  .map(line => {
    const [building, level] = line.trim().split(':');
    return { building, level: Number(level) };
  });
async function loadCookiesToJar(cookieStr, url) {
  const cookies = cookieStr.split(';');
  for (const cookie of cookies) {
    // Trim and add cookie with domain and path info
    const c = cookie.trim();
    await jar.setCookie(`${c}; Domain=us80.tribalwars.us; Path=/`, url);
  }
}

async function main() {
    while (CONTINUE_TO_RUN) {
        try {
            await initializeBot();
            /* Captcha detection */
            if ($('[data-bot-protect="forced"]').length > 0) {
                console.warn('⚠️ Bot protection hit! Cannot continue.');
                console.log('🔐 Stopping bot.');
                process.exit(0);
            }
            await startVillageCycle();
        } catch (err) {
            console.error('Error:', err.message);
        }
        const delay = 60 + Math.floor(Math.random() * 10);
        console.log('Will continue after: ' + delay + ' seconds');
        await sleep(delay * 1000);
    }
}

// Helper to get current troop counts from barracks page
async function getCurrentTroopCounts(villageId, BASE_URL, client) {
  // Fetch barracks page and parse troop counts from the table
  const barracksUrl = `${BASE_URL}/game.php?village=${villageId}&screen=barracks`;
  const getRes = await client.get(barracksUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Referer': barracksUrl,
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'DNT': '1',
    },
  });
  const html = getRes.data;
  const cheerio = (await import('cheerio')).default || (await import('cheerio'));
  const $ = cheerio.load(html);
  const troopCounts = {};
  // Parse the "In the village/total" column for each unit
  $('input.recruit_unit').each((_, el) => {
    const name = $(el).attr('name');
    // Find the parent row and the "In the village/total" cell
    const row = $(el).closest('tr');
    const countCell = row.find('td').eq(2); // 3rd column
    if (countCell.length) {
      const text = countCell.text().trim();
      // Format: "10/10" or "0/0"
      const [inVillage] = text.split('/').map(x => parseInt(x.trim(), 10));
      troopCounts[name] = isNaN(inVillage) ? 0 : inVillage;
    }
  });
  return troopCounts;
}

async function troopRecruitmentCycle(village, BASE_URL, client, buildingLevels, CSRF_TOKEN) {
  const troopStage = getCurrentTroopStage(village.id, buildingLevels);
  if (!troopStage || !troopStage.build) return;
  const barracksUrl = `${BASE_URL}/game.php?village=${village.id}&screen=barracks`;
  const getRes = await client.get(barracksUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Referer': barracksUrl,
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'DNT': '1',
    },
  });
  const html = getRes.data;
  const cheerio = (await import('cheerio')).default || (await import('cheerio'));
  const $ = cheerio.load(html);
  // Parse troop counts
  const troopCounts = {};
  $('input.recruit_unit').each((_, el) => {
    const name = $(el).attr('name');
    const row = $(el).closest('tr');
    const countCell = row.find('td').eq(2);
    if (countCell.length) {
      const text = countCell.text().trim();
      const [inVillage] = text.split('/').map(x => parseInt(x.trim(), 10));
      troopCounts[name] = isNaN(inVillage) ? 0 : inVillage;
    }
  });
  // Collect all available troop types with visible, enabled input
  const unitsToRecruit = {};
  for (const building in troopStage.build) {
    const buildConfig = troopStage.build[building];
    for (const troopType in buildConfig) {
      const target = buildConfig[troopType];
      const current = troopCounts[troopType] || 0;
      if (current < target) {
        // Check if input is visible and enabled
        const input = $(`input[name="${troopType}"]`);
        const interaction = $(`#${troopType}_0_interaction`);
        const isInputVisible = interaction.length && interaction.css('display') !== 'none';
        const isInputEnabled = input.length && !input.is(':disabled');
        if (!isInputVisible || !isInputEnabled) continue;
        // Parse max recruitable from the (N) link next to the input
        let maxRecruitable = 0;
        const maxLink = $(`#${troopType}_0_a`).first();
        if (maxLink.length) {
          const match = maxLink.text().match(/\((\d+)\)/);
          if (match) {
            maxRecruitable = parseInt(match[1], 10);
          }
        }
        if (!maxRecruitable || maxRecruitable < 1) continue;
        const batchSize = Math.min(BATCH_SIZE, target - current, maxRecruitable);
        if (batchSize < 1) continue;
        unitsToRecruit[troopType] = batchSize;
      }
    }
  }
  if (Object.keys(unitsToRecruit).length > 0) {
    await recruitTroops({
      villageId: village.id,
      units: unitsToRecruit,
      BASE_URL,
      client,
      CSRF_TOKEN,
      html
    });
  }
}

async function farmingCycle(village, BASE_URL, client, CSRF_TOKEN, buildingLevels) {
  // Refresh io cookie by visiting the map page once per farming loop
  const mapUrl = `${BASE_URL}/game.php?village=${village.id}&screen=map`;
  console.log(`[FARM][COOKIE] Fetching map page to refresh io cookie: ${mapUrl}`);
  await client.get(mapUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Referer': `${BASE_URL}/game.php?village=${village.id}&screen=overview`,
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'DNT': '1',
    },
  });
  // 1. Get farm template for this village (from troop stage config)
  const troopStage = getCurrentTroopStage(village.id, buildingLevels);
  if (!troopStage || !troopStage.farm) {
    console.log(`[FARM] Village ${village.id}: No farm template found or enabled.`);
    return;
  }
  let farmTemplates = troopStage.farm;
  if (!Array.isArray(farmTemplates)) farmTemplates = [farmTemplates];
  // 2. Parse map and find nearest farms
  const { allVillages, farms } = parseVillageMapFull();
  // Get this village's coordinates (from map)
  const myVillage = getVillageCoords(village.id);
  if (!myVillage) {
    console.warn(`[FARM] Village ${village.id}: Could not find coordinates in map.`);
    return;
  }
  const nearestFarms = findNearestFarms(myVillage.x, myVillage.y, farms, 50);
  // 3. Get current troop counts (from barracks page) using helper
  const troopCounts = await getCurrentTroopCounts(village.id, BASE_URL, client);
  console.log(`[FARM] Village ${village.id}: Troop counts:`, troopCounts);
  console.log(`[FARM] Village ${village.id}: Farm templates:`, farmTemplates);
  console.log(`[FARM] Village ${village.id}: Nearest farm targets:`, nearestFarms.length);
  // 4. For each farm template, send attacks to nearest farms if enough troops
  let farmIdx = 0;
  let sent = 0;

  while (farmIdx < nearestFarms.length) {
    let templateUsed = false;

    for (const farmUnits of farmTemplates) {
      // Check if this template can be sent
      let canSend = true;
      let missing = [];

      for (const [unit, count] of Object.entries(farmUnits)) {
        if ((troopCounts[unit] || 0) < count) {
          canSend = false;
          missing.push(`${unit} (need ${count}, have ${troopCounts[unit] || 0})`);
        }
      }

      if (!canSend) {
        console.log(`[FARM] Village ${village.id}: Not enough troops for template`, farmUnits, 'Missing:', missing.join(', '));
        continue;
      }

      // Enough troops, send attack
      const farm = nearestFarms[farmIdx++];
      try {
        await sendFarmAttack({
          villageId: village.id,
          targetId: farm.id,
          targetX: farm.x,
          targetY: farm.y,
          units: farmUnits,
          BASE_URL,
          CSRF_TOKEN,
          client,
          jar,
        });

        for (const [unit, count] of Object.entries(farmUnits)) {
          troopCounts[unit] -= count;
        }

        sent++;
        templateUsed = true;
        console.log(`[FARM] Village ${village.id}: Sent attack to (${farm.x},${farm.y}) using template`, farmUnits);
        await sleep(1000 + Math.floor(Math.random() * 2000));
        break; // Break out of template loop to try same farmIdx with remaining troops
      } catch (err) {
        console.error(`[FARM] Village ${village.id}: Failed to send farm attack to (${farm.x},${farm.y}):`, err.message);
      }
    }

    if (!templateUsed) {
      console.log(`[FARM] Village ${village.id}: Not enough troops for any template. Stopping cycle.`);
      break;
    }
  }

  if (sent === 0) {
    console.log(`[FARM] Village ${village.id}: No farm attacks sent this cycle.`);
  } else {
    console.log(`[FARM] Village ${village.id}: Sent ${sent} farm attacks this cycle.`);
  }
}

async function startVillageCycle() {
    let villageData = loadVillageData();
  
    for (const village of villageData.villages) {
      console.log(village.id);
      const mainScreenUrl = `${BASE_URL}/game.php?village=${village.id}&screen=main`;

      // 1. Get building levels (from main page)
      const getRes = await client.get(mainScreenUrl, {
          headers: buildHeaders('html', `${BASE_URL}/game.php?village=${village.id}&screen=overview`),
      });
      // Extract building levels
      const levels = extractBuildingLevels(getRes.data);
      const queueLength = countConstructionQueue(getRes.data);
      console.log(`🏗️ Queue length: ${queueLength}`);

      // Extract CSRF token from main page
      const cheerio = (await import('cheerio')).default || (await import('cheerio'));
      const $ = cheerio.load(getRes.data);
      let CSRF_TOKEN = null;
      $('script').each((i, el) => {
          const script = $(el).html();
          const match = /var\s+csrf_token\s*=\s*['"]([a-f0-9]+)['"]/.exec(script);
          if (match) CSRF_TOKEN = match[1];
      });
      if (!CSRF_TOKEN) throw new Error('CSRF token not found');

      // 2. Building logic (existing)
      // Update the JSON
      villageData = updateVillageJson(villageData, village.id, levels);

      // Write back updated JSON
      saveVillageData(villageData);

      const maxQueue = 2;
      const lookahead = 5;
      const dispatchLimit = maxQueue - queueLength;

      if (dispatchLimit > 0) {
        let dispatched = 0;
        const plannedSet = new Set();
        // Extract current resources once
        let virtualResources = extractCurrentResources(getRes.data);

        for (let i = 0, idx = 0; idx < buildQueue.length && i < lookahead && dispatched < dispatchLimit; idx++) {
          const { building, level } = buildQueue[idx];
          // Skip buildings not enabled in config
          if (!config.enabledBuildings.includes(building)) {
            console.log(`⚠️ Skipping ${building} (disabled in config)`);
            continue;
          }
          const currentLevel = levels[building] || 0;

          if (plannedSet.has(`${building}:${level}`)) continue; // avoid duplicate
          if (currentLevel >= level) continue; // already built → skip

          // Get required resources for this building
          const required = extractRequiredResources(getRes.data, building);
          if (!required) {
            console.log(`❌ Could not find required resources for building ${building}`);
            i++;
            continue;
          }
          // Check if virtual resources are enough
          if (virtualResources.wood < required.wood || virtualResources.stone < required.stone || virtualResources.iron < required.iron) {
            // console.log(`⛔ Not enough resources to queue ${building} to level ${level}. Needed:`, required, 'Available:', virtualResources);
            i++;
            continue;
          }
          // Subtract resources from virtual pool
          virtualResources.wood -= required.wood;
          virtualResources.stone -= required.stone;
          virtualResources.iron -= required.iron;

          // Build!
          console.log(`➡️ Village: ${village.id} Dispatching: ${building} to level ${currentLevel + 1}`);
          try {
            await upgradeBuilding({
              buildingId: building,
              villageId: village.id,
              BASE_URL,
              CSRF_TOKEN,
              client,
              html: getRes.data,
              skipIfInsufficientResources: false // already checked
            });
            plannedSet.add(`${building}:${level}`);
            dispatched++;
          } catch (err) {
            console.error(`❌ Village: ${village.id} Failed to upgrade ${building}:`, err.message);
          }

          i++;
        }

        if (dispatched === 0) {
          console.log(`✅ Village: ${village.id} No upgrades possible in lookahead window.`);
        }
      } else {
        console.log(`⏳ Village: ${village.id} Queue full, skipping upgrade.`);
      }

      // 3. Troop recruitment cycle (after building upgrades)
      await troopRecruitmentCycle(village, BASE_URL, client, levels, CSRF_TOKEN);
      // 4. Farming cycle (after troop recruitment)
      await farmingCycle(village, BASE_URL, client, CSRF_TOKEN, levels);

      // Adaptive delay based on next event (building, research, troop training)
      /* const nextBuild = getNextBuildFinishTime(getRes.data);
      const nextResearch = getNextResearchFinishTime(getRes.data);
      const nextTroop = getNextTroopFinishTime(getRes.data);
      let soonest = null;
      let soonestType = '';
      if (nextBuild && (!soonest || nextBuild < soonest)) {
        soonest = nextBuild;
        soonestType = 'build';
      }
      if (nextResearch && (!soonest || nextResearch < soonest)) {
        soonest = nextResearch;
        soonestType = 'research';
      }
      if (nextTroop && (!soonest || nextTroop < soonest)) {
        soonest = nextTroop;
        soonestType = 'troop';
      }
      let delay;
      if (soonest && soonest > 0) {
        delay = soonest + 10 + Math.floor(Math.random() * 50);
        console.log(`⏳ Next event: ${soonestType} finishes in ${soonest}s. Waiting ${delay}s before next cycle.`);
      } else {
        delay = 300 + Math.floor(Math.random() * 180);
        console.log(`🕒 No events in progress. Waiting ${delay}s before next cycle.`);
      }
      await sleep(delay * 1000); */
      // Add a small delay between villages to avoid overlap
      await sleep(1000);
    }
}
async function initializeBot() {
    const overviewUrl = `${BASE_URL}/game.php?village=${villageId}&screen=overview_villages`;

    await loadCookiesToJar(COOKIE_STRING, BASE_URL);
    // Fetch the map file before any farming logic
    await fetchAndSaveVillageMap();
    const getRes = await client.get(overviewUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'Referer': `${BASE_URL}/game.php?village=${villageId}&screen=main`,
            'upgrade-insecure-requests': '1'
        },
    });

    $ = cheerio.load(getRes.data);
    $('script').each((i, el) => {
        const script = $(el).html();
        const match = /var\s+csrf_token\s*=\s*['"]([a-f0-9]+)['"]/.exec(script);
        if (match) CSRF_TOKEN = match[1];
    });

    if (!CSRF_TOKEN) throw new Error('CSRF token not found');

    console.log('Bot initialized with CSRF token:', CSRF_TOKEN);

    const villageData = loadVillageData();
    const existingIds = villageData.villages.map(v => v.id);

    $('#production_table .quickedit-vn').each((i, el) => {
        const id = $(el).attr('data-id');
        if (id && !existingIds.includes(id)) {
            villageData.villages.push({ id });
        }
    });

    saveVillageData(villageData);
}

function buildHeaders(type, referer) {
  // type: 'html', 'json', 'ajax', etc.
  const base = {
    'User-Agent': botConfig.USER_AGENT,
    'Accept-Language': botConfig.ACCEPT_LANGUAGE
    // 'Cookie' is intentionally omitted; cookie jar manages cookies after initial load
  };
  if (type === 'html') {
    return {
      ...base,
      'Accept': botConfig.ACCEPT_HTML,
      'Referer': referer || BASE_URL,
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'DNT': '1'
    };
  } else if (type === 'json' || type === 'ajax') {
    return {
      ...base,
      'Accept': botConfig.ACCEPT_JSON,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': referer || BASE_URL,
      'Origin': BASE_URL,
      'Tribalwars-Ajax': '1',
      'X-Requested-With': 'XMLHttpRequest'
    };
  }
  return base;
}

main();

