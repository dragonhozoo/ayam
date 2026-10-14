/**
 * HOZOO MD — TikTok Mass Reporter Bot v4 (PUPPETEER EDITION)
 * Fixes: JSON rehydration, captcha, region block
 * Scrape via real browser + submit report via axios
 */

const { Telegraf } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const useragent = require('random-useragent');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ================== CONFIG ==================
const BOT_TOKEN = '8763413992:AAGHLdEkzr1d4F-JokJuuojP4B1SDwKTu7U';
const ALLOWED_CHAT_ID = '8530130542';

const USER_DATA_DIR = path.join(__dirname, '.chrome-data');
const COOKIE_FILE = path.join(__dirname, 'cookies.json');

// ================== BOT ==================
const bot = new Telegraf(BOT_TOKEN);
const activeJobs = new Map();
let browserInstance = null;
let browserLock = Promise.resolve(); // biar ga bentrok antar job

// ================== UTILS ==================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomHex = (n = 16) => crypto.randomBytes(n).toString('hex');

function normalizeUsername(input) {
  let s = input.trim();
  const m = s.match(/@([\w.\-]+)/);
  if (m) return m[1];
  if (/^https?:\/\//i.test(s)) {
    const m2 = s.match(/tiktok\.com\/@?([\w.\-]+)/i);
    if (m2) return m2[1];
  }
  return s.replace(/[^\w.\-]/g, '');
}

// ================== BROWSER MANAGEMENT ==================
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;

  console.log('[+] Launching browser...');
  browserInstance = await puppeteer.launch({
    headless: 'new',
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--lang=en-US,en',
      '--window-size=1366,768'
    ],
    defaultViewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true
  });
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (_) {}
    browserInstance = null;
  }
}

// ================== SCRAPE USER INFO (BROWSER) ==================
async function fetchUserInfoViaBrowser(username) {
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    const ua = useragent.getRandom((u) => /Chrome\/1[12][0-9]/.test(u)) ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });

    // block resource berat
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) req.abort();
      else req.continue();
    });

    const url = `https://www.tiktok.com/@${username}`;
    console.log(`[+] Goto ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // tunggu salah satu kondisi
    await Promise.race([
      page.waitForFunction(
        () =>
          !!document.querySelector(
            'script#__UNIVERSAL_DATA_FOR_REHYDRATION__'
          ),
        { timeout: 25000 }
      ),
      page.waitForNavigation({ timeout: 25000, waitUntil: 'domcontentloaded' })
    ]).catch(() => {});

    await sleep(2000);

    const currentUrl = page.url();
    console.log(`[+] URL now: ${currentUrl}`);

    // cek captcha
    if (/verify|captcha|challenge/i.test(currentUrl)) {
      await context.close();
      return {
        error: `Kena captcha/verify. Buka manual: ${currentUrl}\nSelesaikan captcha di browser lokal (userDataDir: ${USER_DATA_DIR}) atau pake proxy.`
      };
    }

    // ambil JSON rehydration
    const data = await page.evaluate(() => {
      const el = document.querySelector(
        'script#__UNIVERSAL_DATA_FOR_REHYDRATION__'
      );
      if (!el) return { err: 'no_script' };
      try {
        const json = JSON.parse(el.textContent);
        return { json };
      } catch (e) {
        return { err: 'json_parse_fail: ' + e.message };
      }
    });

    if (data.err) {
      await context.close();
      return { error: `Rehydration error: ${data.err}. URL: ${currentUrl}` };
    }

    const scope = data.json?.__DEFAULT_SCOPE__ || {};

    // cari userInfo di key manapun
    let userObj = null;
    for (const k of Object.keys(scope)) {
      const maybe = scope[k]?.userInfo?.user;
      if (maybe && (maybe.secUid || maybe.id)) {
        userObj = maybe;
        break;
      }
    }

    if (!userObj) {
      // coba cari user detail langsung
      const ud = scope['webapp.user-detail']?.userInfo?.user;
      if (ud) userObj = ud;
    }

    if (!userObj) {
      await context.close();
      return {
        error: `Ga nemu userInfo di scope. Keys: ${Object.keys(scope).join(', ')}`
      };
    }

    const result = {
      uid: userObj.id,
      secUid: userObj.secUid,
      uniqueId: userObj.uniqueId,
      nickname: userObj.nickname,
      privateAccount: !!userObj.privateAccount,
      verified: !!userObj.verified,
      region: userObj.region || 'N/A',
      stats: {
        followers: userObj.stats?.followerCount || 0,
        following: userObj.stats?.followingCount || 0,
        likes: userObj.stats?.heartCount || 0,
        videos: userObj.stats?.videoCount || 0
      }
    };

    // simpen cookie browser buat axios report
    const cookies = await page.cookies();
    result._cookies = cookies;
    result._ua = ua;

    await context.close();
    return result;
  } catch (e) {
    try { await context.close(); } catch (_) {}
    return { error: `Browser err: ${e.message}` };
  }
}

// ================== SUBMIT REPORT (AXIOS) ==================
async function submitReport(user, reason) {
  const csrf = randomHex(16);

  // susun cookie string dari browser
  const cookieStr = (user._cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const body = new URLSearchParams({
    object_id: String(user.uid),
    owner_id: String(user.uid),
    report_type: '1',
    reason: String(reason),
    sub_reason: '0',
    extra: JSON.stringify({
      secUid: user.secUid,
      uniqueId: user.uniqueId,
      enter_from: 'web_profile',
      source: 'web',
      ts: Date.now()
    }),
    aid: '1988',
    app_language: 'en',
    app_name: 'tiktok_web',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version: '5.0 (Windows)',
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    device_id: randomHex(19).replace(/\D/g, '').slice(0, 19),
    device_platform: 'web_pc',
    focus_state: 'true',
    from_page: 'user',
    history_len: '2',
    is_fullscreen: 'false',
    is_page_visible: 'true',
    language: 'en',
    os: 'windows',
    priority_region: 'US',
    referer: '',
    region: 'US',
    screen_height: '1080',
    screen_width: '1920',
    tz_name: 'UTC',
    webcast_language: 'en',
    csrf_token: csrf
  });

  const url = 'https://www.tiktok.com/aweme/v1/web/report/submit/';

  const res = await axios.post(url, body.toString(), {
    headers: {
      'Host': 'www.tiktok.com',
      'User-Agent': user._ua || 'Mozilla/5.0',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.tiktok.com',
      'Referer': `https://www.tiktok.com/@${user.uniqueId}`,
      'Cookie': cookieStr,
      'x-tt-passport-csrf-token': csrf,
      'x-tt-ticket-guard-result': '0',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    },
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
    timeout: 15000,
    validateStatus: () => true
  });

  return { status: res.status, data: res.data };
}

// ================== REPORT LOOP ==================
async function runLoop(chatId, username, ctx) {
  const job = activeJobs.get(chatId);
  if (!job) return;

  await ctx.telegram
    .editMessageText(chatId, job.messageId, undefined,
      `🔎 *Buka browser & scrape @${username}...*\n_(bisa 10-30 detik)_`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

  const info = await fetchUserInfoViaBrowser(username);

  if (info.error) {
    job.running = false;
    activeJobs.delete(chatId);
    return ctx.telegram
      .editMessageText(chatId, job.messageId, undefined,
        `❌ *GAGAL*\n\nUsername: \`${username}\`\nReason:\n${info.error}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
  }

  job.user = info;

  let lastEdit = 0;
  const reasons = [1002, 1004, 1005, 1006, 1010];

  while (job.running) {
    const reason = reasons[Math.floor(Math.random() * reasons.length)];
    try {
      const r = await submitReport(info, reason);
      job.count++;

      const ok =
        r.status === 200 &&
        r.data &&
        (r.data.message === 'success' ||
          r.data.status_code === 0 ||
          r.data?.extra?.now === 1);

      if (ok) job.success++;
      else job.fail++;

      job.lastRaw = JSON.stringify(r.data).slice(0, 150);
    } catch (e) {
      job.fail++;
      job.lastRaw = e.message;
    }

    const now = Date.now();
    if (now - lastEdit > 3000) {
      lastEdit = now;
      const txt =
        `🔥 *HOZOO MD — REPORT JALAN* 🔥\n\n` +
        `👤 @${info.uniqueId} (${info.nickname})\n` +
        `🆔 UID: \`${info.uid}\`\n` +
        `🔒 Private: *${info.privateAccount ? 'YES' : 'NO'}*\n` +
        `👥 Followers: *${info.stats.followers}*\n` +
        `📊 Total: *${job.count}*\n` +
        `✅ Sukses: *${job.success}*\n` +
        `❌ Gagal: *${job.fail}*\n` +
        `🧠 Last: \`${(job.lastRaw || '').replace(/`/g, '')}\`\n` +
        `⏱ Status: *NON-STOP*`;

      ctx.telegram
        .editMessageText(chatId, job.messageId, undefined, txt, {
          parse_mode: 'Markdown'
        })
        .catch(() => {});
    }

    await sleep(800);
  }
}

// ================== COMMANDS ==================
bot.start((ctx) => {
  if (String(ctx.chat.id) !== ALLOWED_CHAT_ID)
    return ctx.reply('⛔ Akses ditolak.');

  ctx.replyWithMarkdown(
    `💀 *HOZOO MD — TikTok Mass Reporter v4*\n\n` +
      `/love <username|link> — mulai\n` +
      `/stop — stop\n` +
      `/status — status\n` +
      `/debug <username> — cek scrape tanpa report\n\n` +
      `Contoh: \`/love @azsnokos_shop\``
  );
});

bot.command('debug', async (ctx) => {
  if (String(ctx.chat.id) !== ALLOWED_CHAT_ID)
    return ctx.reply('⛔ Akses ditolak.');

  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!arg) return ctx.reply('❌ Kasih username.');

  const username = normalizeUsername(arg);
  const sent = await ctx.replyWithMarkdown(`🧪 *Debug scrape @${username}...*`);

  const info = await fetchUserInfoViaBrowser(username);

  const txt = info.error
    ? `❌ *ERROR*\n\n${info.error}`
    : `✅ *OK*\n\nUID: \`${info.uid}\`\nsecUid: \`${(info.secUid || '').slice(0, 20)}...\`\nNick: *${info.nickname}*\nPrivate: *${info.privateAccount}*\nRegion: *${info.region}*\nFollowers: *${info.stats.followers}*\nCookies: *${(info._cookies || []).length}*`;

  ctx.telegram
    .editMessageText(ctx.chat.id, sent.message_id, undefined, txt, {
      parse_mode: 'Markdown'
    })
    .catch(() => {});
});

bot.command('love', async (ctx) => {
  if (String(ctx.chat.id) !== ALLOWED_CHAT_ID)
    return ctx.reply('⛔ Akses ditolak.');

  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!arg) return ctx.reply('❌ Kasih username / link.');

  const username = normalizeUsername(arg);
  if (!username) return ctx.reply('❌ Username gak valid.');

  if (activeJobs.has(ctx.chat.id))
    return ctx.reply('⚠️ Masih jalan. /stop dulu.');

  const sent = await ctx.replyWithMarkdown(
    `🔎 *Scraping @${username} pake browser...*`
  );

  const job = {
    target: username,
    running: true,
    count: 0,
    success: 0,
    fail: 0,
    messageId: sent.message_id,
    user: null,
    lastRaw: ''
  };
  activeJobs.set(ctx.chat.id, job);
  runLoop(ctx.chat.id, username, ctx);
});

bot.command('stop', (ctx) => {
  if (String(ctx.chat.id) !== ALLOWED_CHAT_ID)
    return ctx.reply('⛔ Akses ditolak.');
  const job = activeJobs.get(ctx.chat.id);
  if (!job) return ctx.reply('❌ Gak ada report jalan.');
  job.running = false;
  activeJobs.delete(ctx.chat.id);
  ctx.replyWithMarkdown(
    `🛑 *STOP*\n\nTarget: @${job.target}\nTotal: *${job.count}*\n✅ ${job.success}  ❌ ${job.fail}`
  );
});

bot.command('status', (ctx) => {
  if (String(ctx.chat.id) !== ALLOWED_CHAT_ID)
    return ctx.reply('⛔ Akses ditolak.');
  const job = activeJobs.get(ctx.chat.id);
  if (!job) return ctx.reply('ℹ️ Gak ada report aktif.');
  ctx.replyWithMarkdown(
    `📊 *STATUS*\n\nTarget: @${job.target}\nUID: \`${job.user?.uid || '-'}\`\nTotal: *${job.count}*\n✅ ${job.success}  ❌ ${job.fail}`
  );
});

bot.catch((err) => console.log('BOT ERR:', err.message));

// ================== SHUTDOWN ==================
process.once('SIGINT', async () => {
  await closeBrowser();
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  await closeBrowser();
  bot.stop('SIGTERM');
});

// ================== RUN ==================
bot.launch().then(() => {
  console.log('💀 HOZOO MD Bot v4 (Puppeteer) jalan...');
});
