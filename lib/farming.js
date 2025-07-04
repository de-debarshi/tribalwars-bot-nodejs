import axios from 'axios';
import fs from 'fs';
import path from 'path';

const MAP_URL = 'https://us80.tribalwars.us/map/village.txt';
const MAP_PATH = path.join(process.cwd(), 'data/village_map.txt');

// Fetch and save the map file
async function fetchAndSaveVillageMap() {
  const res = await axios.get(MAP_URL);
  fs.writeFileSync(MAP_PATH, res.data, 'utf-8');
}

// Parse the map file for all villages and for barbarian/bonus villages
function parseVillageMapFull() {
  const raw = fs.readFileSync(MAP_PATH, 'utf-8');
  const lines = raw.split('\n');
  const allVillages = [];
  const farms = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [id, name, x, y, owner, points, bonusType] = line.split(',');
    const village = {
      id: parseInt(id, 10),
      name: decodeURIComponent(name.replace(/\+/g, ' ')),
      x: parseInt(x, 10),
      y: parseInt(y, 10),
      owner: parseInt(owner, 10),
      points: parseInt(points, 10),
      bonusType: parseInt(bonusType, 10)
    };
    allVillages.push(village);
    if (village.owner === 0) farms.push(village);
  }
  return { allVillages, farms };
}

// Helper to get coordinates for a village by ID
function getVillageCoords(villageId) {
  const { allVillages } = parseVillageMapFull();
  return allVillages.find(v => v.id === parseInt(villageId, 10));
}

// Find the N nearest barbarian/bonus villages to a given village (by x, y)
function findNearestFarms(myX, myY, allFarms, N = 50) {
  // allFarms: output of parseVillageMap
  // Returns array of {id, name, x, y, points, bonusType, distance}
  return allFarms
    .map(farm => ({ ...farm, distance: Math.sqrt((farm.x - myX) ** 2 + (farm.y - myY) ** 2) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, N);
}

// Send a farming attack using the two-step Tribal Wars flow
async function sendFarmAttack({
  villageId, // source village
  targetId,  // target village ID
  targetX,
  targetY,
  units, // { spear: 10, sword: 10, ... }
  BASE_URL,
  CSRF_TOKEN,
  client,
  jar, // new argument for reliable cookie logging
}) {
  const troopTypes = [
    'spear','sword','axe','archer','spy','light','marcher','heavy','ram','catapult','snob'
  ];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Tribalwars-Ajax': '1',
    'DNT': '1',
    'Origin': BASE_URL,
    'Referer': `${BASE_URL}/game.php?village=${villageId}&screen=map`,
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };
  const qs = (await import('qs')).default;
  const cheerio = (await import('cheerio')).default || (await import('cheerio'));

  // 1. GET the attack form via AJAX (map popup)
  const ajaxAttackUrl = `${BASE_URL}/game.php?village=${villageId}&screen=place&ajax=command&target=${targetId}`;

  if (jar && jar.getCookieString) {
    const cookieString = await jar.getCookieString(ajaxAttackUrl);
  }
  // No need to GET the map page first; this endpoint is sufficient.
  let attackFormHtml;
  try {
    const res = await client.get(ajaxAttackUrl, { headers });
    const json = res.data;
    if (!json || !json.response || !json.response.dialog) {
      console.error('[FARM][AJAX] No dialog HTML in map attack form response', json);
      return;
    }
    attackFormHtml = json.response.dialog;
  } catch (err) {
    console.error('[FARM][AJAX] Failed to GET map attack form:', err.message);
    return;
  }
  const $ = cheerio.load(attackFormHtml);
  const form = $('form');
  const postData = {};
  form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    const value = $(el).val() || '';
    if (name) postData[name] = value;
  });
  for (const type of troopTypes) {
    postData[type] = units[type] !== undefined ? units[type] : '';
  }
  // Always set coordinates to the target farm's coordinates
  postData['x'] = targetX;
  postData['y'] = targetY;
  postData['attack'] = 'l'; // match browser
  postData['h'] = CSRF_TOKEN; // match browser
  if ('support' in postData) delete postData['support'];
  // 2. POST troop selection to ajax=confirm
  const ajaxConfirmUrl = `${BASE_URL}/game.php?village=${villageId}&screen=place&ajax=confirm`;
  if (jar && jar.getCookieString) {
    const cookieString = await jar.getCookieString(ajaxConfirmUrl);
  }
  let confirmHtml;
  try {
    const res = await client.post(ajaxConfirmUrl, qs.stringify(postData), { headers });
    // console.log('[FARM][AJAX] Got ajax=confirm response:', res.status, typeof res.data);
    const json = res.data;
    if (!json || !json.response || !json.response.dialog) {
      console.error('[FARM][AJAX] No dialog HTML in confirm response', json);
      return;
    }
    confirmHtml = json.response.dialog;
  } catch (err) {
    console.error('[FARM][AJAX] Failed to POST to ajax=confirm:', err.message);
    return;
  }
  // 3. POST confirmation to ajaxaction=popup_command
  const popupCommandUrl = `${BASE_URL}/game.php?village=${villageId}&screen=place&ajaxaction=popup_command`;
  if (jar && jar.getCookieString) {
    const cookieString = await jar.getCookieString(popupCommandUrl);
  }
  const $confirm = cheerio.load(confirmHtml);
  const confirmForm = $confirm('form');
  const confirmData = {};
  confirmForm.find('input').each((_, el) => {
    const name = $confirm(el).attr('name');
    const value = $confirm(el).val() || '';
    if (name) confirmData[name] = value;
  });
  for (const type of troopTypes) {
    confirmData[type] = units[type] !== undefined ? units[type] : '0';
  }
  confirmData['x'] = targetX;
  confirmData['y'] = targetY;
  confirmData['attack'] = confirmData['attack'] || confirmData['submit_confirm'] || 'Attack';
  confirmData['submit_confirm'] = 'Send attack';
  confirmData['attack'] = 'true'; // overwrite
  confirmData['cb'] = 'troop_confirm_submit';
  confirmData['building'] = 'main';
  confirmData['h'] = CSRF_TOKEN;
  confirmData['source_village'] = villageId;
  confirmData['village'] = villageId;
  let cookieString = '';
  if (jar && jar.getCookieString) {
    cookieString = await jar.getCookieString(popupCommandUrl);
  } else {
    console.log('[FARM][AJAX] Could not determine cookies for final POST.');
  }
  try {
    const res = await client.post(popupCommandUrl, qs.stringify(confirmData), { headers });
    // console.log('[FARM][AJAX] Got ajaxaction=popup_command response:', res.status, typeof res.data);
    const json = res.data;
    if (json && json.response && json.response.message && json.response.message.includes('Attack sent successfully')) {
      console.log(`🚀 [FARM][AJAX] Sent farm attack from ${villageId} to (${targetX},${targetY}) with`, units, 'Status: success');
    } else {
      console.log('[FARM][AJAX] Attack POST response:', json);
    }
    return res;
  } catch (err) {
    console.error('[FARM][AJAX] Failed to POST confirmation (popup_command):', err.message);
    return;
  }
}

export { fetchAndSaveVillageMap, findNearestFarms, sendFarmAttack, parseVillageMapFull, getVillageCoords }; 