import axios from 'axios';
import * as cheerio from 'cheerio';
import qs from 'qs';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

import { sleep } from './lib/utils.js';

const COOKIE_STRING = "cid=521568355; us_auth=4df70337a178:4495fd020221b8974160fe3b91bbcc2ff1809fe1b2be2c824035ea1e6630bca5; ref=start; websocket_available=true; PHPSESSID=p0moban8r3uf34ggoes03kfjd0aq8p3j3cqm1s68a5cfaqku; sid=0%3Aa1f5dd561a26f265fd04775c537eb795438ab1309253906897b0aaa1e33d617b043ea5a7ce288f58b93dd65529449006ac45e118ec7584a212f6fb46d457d0ef; global_village_id=3095; io=AfvMlcHWb1qtjPAqAY7z";
const BASE_URL = 'https://us80.tribalwars.us';
const BASE_VILLAGE_ID = '3095';

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

const villageId = BASE_VILLAGE_ID;
const CONTINUE_TO_RUN = true;

let $ = null;
let CSRF_TOKEN = null;

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

        } catch (err) {
            console.error('Error:', err.message);
        }
        console.log('there');
        const delay = 60 + Math.floor(Math.random() * 1000);
        console.log('Will continue after: ' + delay + ' seconds');
        await sleep(delay * 1000);
    }
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
}

async function upgradeBuilding() {
    const postUrl = `${BASE_URL}/game.php?village=${villageId}&screen=main&ajaxaction=upgrade_building&type=main`;

    const postData = qs.stringify({
        id: 'main',
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
    console.log('Build upgrade response:', postRes.data);
}

main();
