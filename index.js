import axios from 'axios';
import * as cheerio from 'cheerio';
import qs from 'qs';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { sleep } from './lib/utils.js';

const COOKIE_STRING = "cid=521568355; us_auth=4df70337a178:4495fd020221b8974160fe3b91bbcc2ff1809fe1b2be2c824035ea1e6630bca5; sid=0%3Af9dc4ded6c04ca7467e97f8d25880aa050c3bcb6440670242c7ff2f2e0f765f5384fc666ff0c7f807b51cf1647c6b0afede756c2101948e31a806f8d8e03ab55; global_village_id=3095; websocket_available=true; io=Rqz64ed0rO82gbX7AB3j";
const BASE_URL = 'https://us80.tribalwars.us';
const BASE_VILLAGE_ID = '3095';

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

const villageId = BASE_VILLAGE_ID;
const CONTINUE_TO_RUN = true;

let $ = null;
let CSRF_TOKEN = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'villages.json');

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
                break;
            }
            startVillageCycle();
        } catch (err) {
            console.error('Error:', err.message);
        }
        const delay = 60 + Math.floor(Math.random() * 10);
        console.log('Will continue after: ' + delay + ' seconds');
        await sleep(delay * 1000);
    }
}
function startVillageCycle() {
  let villageData = loadVillageData();
  villageData.villages.forEach(async (village) => {
    const mainScreenUrl = `${BASE_URL}/game.php?village=${village.id}&screen=main`;

    const getRes = await client.get(mainScreenUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'Referer': `${BASE_URL}/game.php?village=${village.id}&screen=overview`,
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'DNT': '1',
        },
    });
    // Extract building levels
    const levels = extractBuildingLevels(getRes.data);
    const queueLength = countConstructionQueue(getRes.data);
    console.log(`🏗️ Queue length: ${queueLength}`);

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

      for (let i = 0, idx = 0; idx < buildQueue.length && i < lookahead && dispatched < dispatchLimit; idx++) {
        const { building, level } = buildQueue[idx];
        const currentLevel = levels[building] || 0;

        if (plannedSet.has(`${building}:${level}`)) continue; // avoid duplicate
        if (currentLevel >= level) continue; // already built → skip

        // Check if building exists in DOM — if not (like unbuilt barracks/statue), skip
        /* const exists = $(`#main_buildrow_${building}`).length > 0;
        if (!exists) {
          console.log(`❌ Village: ${village.id} Skipping ${building} (not yet constructed)`);
          i++;
          continue;
        } */

        // Build!
        console.log(`➡️ Village: ${village.id} Dispatching: ${building} to level ${currentLevel + 1}`);
        try {
          await upgradeBuilding(building, village.id);
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



    const delay = 10 + Math.floor(Math.random() * 10);
    console.log('Fetch next village data after: ' + delay + ' seconds');
    await sleep(delay * 1000);
  })
}
async function initializeBot() {
    const overviewUrl = `${BASE_URL}/game.php?village=${villageId}&screen=overview_villages`;

    await loadCookiesToJar(COOKIE_STRING, BASE_URL);
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

async function upgradeBuilding(buildingId, villageId) {
    const postUrl = `${BASE_URL}/game.php?village=${villageId}&screen=main&ajaxaction=upgrade_building&type=main`;

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
function extractBuildingLevels(html) {
  const $ = cheerio.load(html);
  const buildingLevels = {};

  $('#buildings tr[id^="main_buildrow_"]').each((_, row) => {
    const $row = $(row);
    const id = $row.attr('id'); // e.g., main_buildrow_main
    const buildingId = id?.replace('main_buildrow_', '');

    if (buildingId) {
      const levelText = $row.find('span').first().text(); // "Level 3"
      const match = levelText.match(/Level (\d+)/);
      if (match) {
        buildingLevels[buildingId] = parseInt(match[1], 10);
      }
    }
  });

  return buildingLevels;
}
function updateVillageJson(villageData, villageId, buildingLevels) {
  const village = villageData.villages.find(v => v.id === villageId);
  if (village) {
    village.buildingLevels = buildingLevels;
  }
  return villageData;
}
function countConstructionQueue(html) {
  const $ = cheerio.load(html);
  const buildRows = $('#buildqueue tr').filter((_, el) => {
    const className = $(el).attr('class') || '';
    return className.includes('buildorder_');
  });
  return buildRows.length;
}
main();
