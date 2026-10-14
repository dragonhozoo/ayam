/**
 * HOZOO MD - TikTok Mass Reporter
 * Single file Node.js + Embedded HTML
 * Black-Purple Theme
 * 500+ lines
 */

const express = require('express');
const axios = require('axios');
const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ==================== GLOBAL STATE ====================
let activeReports = new Map(); // sessionId -> { running, stats, intervalId }
let globalStats = {
    totalSent: 0,
    totalSuccess: 0,
    totalFailed: 0,
    totalAccounts: 0,
    startTime: null
};

// ==================== TIKTOK API ENDPOINTS ====================
const TIKTOK_REPORT_API = 'https://www.tiktok.com/api/report/v1/';
const TIKTOK_PROFILE_API = 'https://www.tiktok.com/api/user/detail/?uniqueId=';
const TIKTOK_DEVICE_REGISTER = 'https://www.tiktok.com/passport/web/device/register/';

// ==================== REPORT REASONS ====================
const REPORT_REASONS = [
    { id: 9001, label: 'Harassment & Bullying' },
    { id: 9002, label: 'Hate Speech' },
    { id: 9003, label: 'Violent Content' },
    { id: 9004, label: 'Spam or Misleading' },
    { id: 9005, label: 'Inappropriate Content' },
    { id: 9006, label: 'Intellectual Property Violation' },
    { id: 9007, label: 'False Information' },
    { id: 9008, label: 'Scam or Fraud' },
    { id: 9009, label: 'Drugs or Controlled Substances' },
    { id: 9010, label: 'Weapons or Dangerous Goods' }
];

// ==================== UTILITIES ====================
function randomDelay(min = 1500, max = 4500) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateDeviceId() {
    const chars = '0123456789abcdef';
    let id = '';
    for (let i = 0; i < 19; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function parseCookie(cookieStr) {
    const cookies = {};
    if (!cookieStr) return cookies;
    cookieStr.split(';').forEach(c => {
        const [key, ...val] = c.trim().split('=');
        if (key && val.length) cookies[key.trim()] = val.join('=').trim();
    });
    return cookies;
}

function cookieToString(cookieObj) {
    return Object.entries(cookieObj)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

// ==================== TIKTOK REPORTER CORE ====================
class TikTokReporter {
    constructor(cookieStr, targetUsername) {
        this.cookies = parseCookie(cookieStr);
        this.targetUsername = targetUsername;
        this.deviceId = generateDeviceId();
        this.sessionId = generateSessionId();
        this.csrfToken = this.cookies['tt_csrf_token'] || '';
        this.secUid = null;
        this.userId = null;
        this.valid = false;
    }

    getHeaders() {
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://www.tiktok.com',
            'Referer': `https://www.tiktok.com/@${this.targetUsername}`,
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': cookieToString(this.cookies),
            'X-Secsdk-Csrf-Token': this.csrfToken,
            'X-Tt-Device-Id': this.deviceId
        };
    }

    async resolveTarget() {
        try {
            const res = await axios.get(
                `https://www.tiktok.com/@${this.targetUsername}`,
                {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Cookie': cookieToString(this.cookies)
                    },
                    timeout: 15000,
                    maxRedirects: 5
                }
            );

            const html = res.data;
            const secUidMatch = html.match(/"secUid":"([^"]+)"/);
            const userIdMatch = html.match(/"id":"(\d+)"/);

            if (secUidMatch) this.secUid = secUidMatch[1];
            if (userIdMatch) this.userId = userIdMatch[1];

            if (this.secUid && this.userId) {
                this.valid = true;
                return { success: true, secUid: this.secUid, userId: this.userId };
            }

            return { success: false, error: 'Gagal extract secUid/userId' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async checkAccount() {
        try {
            const res = await axios.get(
                'https://www.tiktok.com/passport/web/account/info/',
                {
                    headers: this.getHeaders(),
                    timeout: 10000
                }
            );
            return res.data && res.data.data && res.data.data.user_id ? true : false;
        } catch (e) {
            return false;
        }
    }

    async sendReport(reasonId) {
        if (!this.valid || !this.secUid || !this.userId) {
            return { success: false, error: 'Target belum diresolve' };
        }

        const reportData = new URLSearchParams({
            'object_id': this.userId,
            'owner_id': this.userId,
            'reason': reasonId.toString(),
            'report_type': 'user',
            'sec_uid': this.secUid,
            'aid': '1988',
            'app_name': 'tiktok_web',
            'device_platform': 'web_pc',
            'channel': 'tiktok_web',
            'device_id': this.deviceId,
            'csrf_token': this.csrfToken,
            '_signature': ''
        });

        try {
            const res = await axios.post(
                TIKTOK_REPORT_API,
                reportData.toString(),
                {
                    headers: this.getHeaders(),
                    timeout: 15000
                }
            );

            if (res.data && res.data.status_code === 0) {
                return { success: true, message: res.data.message || 'Report sent' };
            }

            return {
                success: false,
                error: res.data?.message || 'Unknown error',
                code: res.data?.status_code
            };
        } catch (e) {
            return {
                success: false,
                error: e.response?.data?.message || e.message,
                code: e.response?.status
            };
        }
    }
}

// ==================== MASS REPORT ENGINE ====================
class MassReportEngine {
    constructor(sessionId, accounts, targetUsername, options = {}) {
        this.sessionId = sessionId;
        this.accounts = accounts;
        this.targetUsername = targetUsername;
        this.reasons = options.reasons || REPORT_REASONS.map(r => r.id);
        this.delayMin = options.delayMin || 1500;
        this.delayMax = options.delayMax || 4500;
        this.maxRounds = options.maxRounds || Infinity;
        this.running = false;
        this.reporters = [];
        this.stats = {
            sent: 0,
            success: 0,
            failed: 0,
            currentAccount: 0,
            currentReason: 0,
            round: 0,
            errors: []
        };
    }

    log(msg) {
        console.log(`[HOZOO-MD][${this.sessionId}] ${msg}`);
    }

    async initialize() {
        this.log('Initializing reporters...');
        for (let i = 0; i < this.accounts.length; i++) {
            const reporter = new TikTokReporter(this.accounts[i], this.targetUsername);
            const resolve = await reporter.resolveTarget();

            if (resolve.success) {
                this.reporters.push(reporter);
                this.log(`Account #${i + 1} OK (secUid: ${reporter.secUid.substr(0, 20)}...)`);
            } else {
                this.log(`Account #${i + 1} FAILED: ${resolve.error}`);
                this.stats.errors.push(`Account #${i + 1}: ${resolve.error}`);
            }

            await new Promise(r => setTimeout(r, 800));
        }

        this.log(`Total active reporters: ${this.reporters.length}/${this.accounts.length}`);
        return this.reporters.length > 0;
    }

    async run(onProgress) {
        if (this.reporters.length === 0) {
            const ok = await this.initialize();
            if (!ok) {
                this.running = false;
                return;
            }
        }

        this.running = true;
        this.stats.round = 0;

        while (this.running && this.stats.round < this.maxRounds) {
            this.stats.round++;

            for (let a = 0; a < this.reporters.length; a++) {
                if (!this.running) break;

                const reporter = this.reporters[a];
                this.stats.currentAccount = a;

                for (let r = 0; r < this.reasons.length; r++) {
                    if (!this.running) break;

                    const reasonId = this.reasons[r];
                    this.stats.currentReason = r;

                    const result = await reporter.sendReport(reasonId);
                    this.stats.sent++;

                    if (result.success) {
                        this.stats.success++;
                        globalStats.totalSuccess++;
                        this.log(`✅ Acc#${a + 1} | Reason ${reasonId} | SUCCESS`);
                    } else {
                        this.stats.failed++;
                        globalStats.totalFailed++;
                        const errMsg = `Acc#${a + 1} Reason ${reasonId}: ${result.error}`;
                        this.stats.errors.push(errMsg);
                        if (this.stats.errors.length > 200) this.stats.errors.shift();
                        this.log(`❌ ${errMsg}`);
                    }

                    globalStats.totalSent++;

                    if (onProgress) {
                        onProgress({
                            sessionId: this.sessionId,
                            stats: this.stats,
                            global: globalStats,
                            running: this.running
                        });
                    }

                    const delay = randomDelay(this.delayMin, this.delayMax);
                    await new Promise(r => setTimeout(r, delay));
                }
            }

            this.log(`Round ${this.stats.round} complete. Waiting before next round...`);
            await new Promise(r => setTimeout(r, 3000));
        }

        this.running = false;
        this.log('Mass report stopped.');
    }

    stop() {
        this.running = false;
        this.log('Stop signal received.');
    }
}

// ==================== EXPRESS ROUTES ====================
app.get('/', (req, res) => {
    res.send(getHTML());
});

app.post('/api/start', async (req, res) => {
    try {
        const { accounts, target, reasons, delayMin, delayMax, maxRounds } = req.body;

        if (!accounts || !accounts.length) {
            return res.status(400).json({ success: false, error: 'No accounts provided' });
        }
        if (!target) {
            return res.status(400).json({ success: false, error: 'No target provided' });
        }

        const sessionId = generateSessionId();
        const engine = new MassReportEngine(sessionId, accounts, target, {
            reasons: reasons && reasons.length ? reasons : undefined,
            delayMin: delayMin || 1500,
            delayMax: delayMax || 4500,
            maxRounds: maxRounds || Infinity
        });

        activeReports.set(sessionId, engine);
        globalStats.totalAccounts = accounts.length;
        globalStats.startTime = globalStats.startTime || Date.now();

        engine.run((progress) => {});

        res.json({ success: true, sessionId, accounts: accounts.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/stats/:sessionId', (req, res) => {
    const engine = activeReports.get(req.params.sessionId);
    if (!engine) return res.status(404).json({ success: false, error: 'Session not found' });

    res.json({
        success: true,
        sessionId: req.params.sessionId,
        running: engine.running,
        stats: engine.stats,
        global: globalStats
    });
});

app.post('/api/stop/:sessionId', (req, res) => {
    const engine = activeReports.get(req.params.sessionId);
    if (!engine) return res.status(404).json({ success: false, error: 'Session not found' });

    engine.stop();
    res.json({ success: true, message: 'Stop signal sent' });
});

app.get('/api/sessions', (req, res) => {
    const sessions = [];
    activeReports.forEach((engine, id) => {
        sessions.push({
            id,
            running: engine.running,
            target: engine.targetUsername,
            stats: engine.stats
        });
    });
    res.json({ success: true, sessions, global: globalStats });
});

app.get('/api/reasons', (req, res) => {
    res.json({ success: true, reasons: REPORT_REASONS });
});

app.get('/api/check-account', async (req, res) => {
    try {
        const { cookie } = req.query;
        if (!cookie) return res.status(400).json({ success: false, error: 'No cookie' });

        const reporter = new TikTokReporter(cookie, 'test');
        const valid = await reporter.checkAccount();
        res.json({ success: true, valid });
    } catch (e) {
        res.json({ success: false, valid: false, error: e.message });
    }
});

// ==================== EMBEDDED HTML ====================
function getHTML() {
    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HOZOO MD - TikTok Mass Reporter</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', Tahoma, sans-serif; }
body {
    background: linear-gradient(135deg, #0a0a0f 0%, #1a0a2e 50%, #0d0d1a 100%);
    color: #e0d0ff; min-height: 100vh; padding: 20px;
}
.container { max-width: 1200px; margin: 0 auto; }
.header {
    text-align: center; padding: 30px 20px;
    background: linear-gradient(135deg, rgba(75,0,130,0.4), rgba(25,0,50,0.6));
    border: 1px solid #6a0dad; border-radius: 15px; margin-bottom: 25px;
    box-shadow: 0 0 30px rgba(106,13,173,0.4);
}
.header h1 {
    font-size: 2.5em; background: linear-gradient(90deg, #a855f7, #7c3aed, #c084fc);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text; margin-bottom: 8px; letter-spacing: 2px;
}
.header p { color: #b794f6; font-size: 1em; }
.badge {
    display: inline-block; background: #4c1d95; color: #ddd6fe;
    padding: 4px 12px; border-radius: 20px; font-size: 0.8em; margin-top: 10px;
    border: 1px solid #7c3aed;
}
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
.card {
    background: rgba(20,10,40,0.7); border: 1px solid #4c1d95;
    border-radius: 15px; padding: 22px; backdrop-filter: blur(10px);
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
}
.card h2 {
    color: #c084fc; font-size: 1.3em; margin-bottom: 15px;
    border-bottom: 2px solid #4c1d95; padding-bottom: 10px;
}
label { display: block; color: #b794f6; margin: 12px 0 6px; font-size: 0.9em; font-weight: 600; }
input[type="text"], input[type="number"], textarea, select {
    width: 100%; padding: 11px; background: #0f0a1f;
    border: 1px solid #4c1d95; border-radius: 8px;
    color: #e0d0ff; font-size: 0.95em; outline: none;
    transition: all 0.3s;
}
input:focus, textarea:focus, select:focus {
    border-color: #a855f7; box-shadow: 0 0 12px rgba(168,85,247,0.5);
}
textarea { resize: vertical; min-height: 100px; font-family: monospace; font-size: 0.85em; }
.btn {
    width: 100%; padding: 14px; margin-top: 15px;
    background: linear-gradient(135deg, #7c3aed, #a855f7);
    color: white; border: none; border-radius: 10px;
    font-size: 1em; font-weight: 700; cursor: pointer;
    transition: all 0.3s; letter-spacing: 1px;
    text-transform: uppercase;
}
.btn:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(168,85,247,0.5); }
.btn:active { transform: translateY(0); }
.btn-danger { background: linear-gradient(135deg, #dc2626, #ef4444); }
.btn-secondary { background: linear-gradient(135deg, #4c1d95, #6d28d9); }
.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 15px; }
.stat-box {
    background: rgba(15,10,31,0.8); border: 1px solid #4c1d95;
    border-radius: 10px; padding: 15px; text-align: center;
}
.stat-box .value { font-size: 1.8em; font-weight: 800; color: #c084fc; }
.stat-box .label { font-size: 0.75em; color: #b794f6; text-transform: uppercase; margin-top: 5px; }
.stat-box.success .value { color: #4ade80; }
.stat-box.failed .value { color: #f87171; }
.status-bar {
    display: flex; align-items: center; gap: 10px;
    padding: 12px; border-radius: 8px; margin-top: 15px;
    background: rgba(15,10,31,0.8); border: 1px solid #4c1d95;
}
.dot {
    width: 12px; height: 12px; border-radius: 50%;
    background: #6b7280; animation: pulse 1.5s infinite;
}
.dot.running { background: #4ade80; }
.dot.stopped { background: #f87171; animation: none; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.log {
    background: #05020a; border: 1px solid #4c1d95; border-radius: 8px;
    padding: 12px; height: 250px; overflow-y: auto;
    font-family: 'Courier New', monospace; font-size: 0.8em;
    margin-top: 15px; color: #9ca3af;
}
.log .ok { color: #4ade80; }
.log .err { color: #f87171; }
.log .info { color: #60a5fa; }
.log .warn { color: #fbbf24; }
.checkbox-group { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.checkbox-group label {
    display: flex; align-items: center; gap: 6px;
    background: rgba(15,10,31,0.6); padding: 8px; border-radius: 6px;
    border: 1px solid #4c1d95; cursor: pointer; margin: 0; font-size: 0.8em;
}
.checkbox-group input { width: auto; }
.footer { text-align: center; margin-top: 30px; color: #6b21a8; font-size: 0.85em; }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>HOZOO MD</h1>
        <p>TikTok Mass Reporter - Private Edition</p>
        <span class="badge">🔥 UNRESTRICTED MODE 🔥</span>
    </div>

    <div class="grid">
        <div class="card">
            <h2>⚙️ Configuration</h2>

            <label>Target Username (tanpa @)</label>
            <input type="text" id="target" placeholder="username_target">

            <label>Cookies Akun (satu per baris)</label>
            <textarea id="accounts" placeholder="sessionid=xxx; tt_csrf_token=yyy; ttwid=zzz
sessionid=aaa; tt_csrf_token=bbb; ttwid=ccc"></textarea>

            <label>Delay Min (ms)</label>
            <input type="number" id="delayMin" value="1500">

            <label>Delay Max (ms)</label>
            <input type="number" id="delayMax" value="4500">

            <label>Max Rounds (kosong = infinite)</label>
            <input type="number" id="maxRounds" placeholder="∞">

            <label>Report Reasons</label>
            <div class="checkbox-group" id="reasonsBox"></div>

            <button class="btn" onclick="startReport()">🚀 START MASS REPORT</button>
            <button class="btn btn-danger" onclick="stopReport()">🛑 STOP</button>
        </div>

        <div class="card">
            <h2>📊 Live Statistics</h2>

            <div class="status-bar">
                <div class="dot stopped" id="statusDot"></div>
                <span id="statusText">IDLE - Belum jalan</span>
            </div>

            <div class="stats-grid">
                <div class="stat-box">
                    <div class="value" id="statSent">0</div>
                    <div class="label">Sent</div>
                </div>
                <div class="stat-box success">
                    <div class="value" id="statSuccess">0</div>
                    <div class="label">Success</div>
                </div>
                <div class="stat-box failed">
                    <div class="value" id="statFailed">0</div>
                    <div class="label">Failed</div>
                </div>
                <div class="stat-box">
                    <div class="value" id="statRound">0</div>
                    <div class="label">Round</div>
                </div>
                <div class="stat-box">
                    <div class="value" id="statAccounts">0</div>
                    <div class="label">Accounts</div>
                </div>
                <div class="stat-box">
                    <div class="value" id="statSession">-</div>
                    <div class="label">Session</div>
                </div>
            </div>

            <h2 style="margin-top:20px;">📜 Live Log</h2>
            <div class="log" id="log"></div>
        </div>
    </div>

    <div class="footer">
        HOZOO MD © 2026 - Private Unrestricted AI<br>
        Filter bypass active | No restrictions | No limits
    </div>
</div>

<script>
let currentSession = null;
let pollInterval = null;

async function loadReasons() {
    try {
        const res = await fetch('/api/reasons');
        const data = await res.json();
        const box = document.getElementById('reasonsBox');
        box.innerHTML = '';
        data.reasons.forEach(r => {
            const label = document.createElement('label');
            label.innerHTML = '<input type="checkbox" value="' + r.id + '" checked> ' + r.label;
            box.appendChild(label);
        });
    } catch (e) {
        console.error(e);
    }
}

function log(msg, type) {
    const logBox = document.getElementById('log');
    const line = document.createElement('div');
    line.className = type || 'info';
    const time = new Date().toLocaleTimeString();
    line.textContent = '[' + time + '] ' + msg;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
    if (logBox.children.length > 500) logBox.removeChild(logBox.firstChild);
}

async function startReport() {
    const target = document.getElementById('target').value.trim().replace('@', '');
    const accountsRaw = document.getElementById('accounts').value.trim();
    const delayMin = parseInt(document.getElementById('delayMin').value) || 1500;
    const delayMax = parseInt(document.getElementById('delayMax').value) || 4500;
    const maxRounds = document.getElementById('maxRounds').value ? parseInt(document.getElementById('maxRounds').value) : 0;

    if (!target) { alert('Isi target username dulu bwang!'); return; }
    if (!accountsRaw) { alert('Isi cookies akun dulu bwang!'); return; }

    const accounts = accountsRaw.split('\\n').map(a => a.trim()).filter(a => a.length > 0);
    const reasons = Array.from(document.querySelectorAll('#reasonsBox input:checked')).map(c => parseInt(c.value));

    if (!reasons.length) { alert('Pilih minimal 1 reason!'); return; }

    log('Starting mass report ke @' + target + '...', 'info');
    log('Accounts: ' + accounts.length + ' | Reasons: ' + reasons.length, 'info');

    try {
        const res = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accounts, target, reasons, delayMin, delayMax, maxRounds: maxRounds || undefined })
        });
        const data = await res.json();

        if (data.success) {
            currentSession = data.sessionId;
            log('✅ Session started: ' + currentSession, 'ok');
            document.getElementById('statusDot').className = 'dot running';
            document.getElementById('statusText').textContent = 'RUNNING - Target: @' + target;
            document.getElementById('statSession').textContent = currentSession.substr(-8);
            startPolling();
        } else {
            log('❌ Failed: ' + data.error, 'err');
        }
    } catch (e) {
        log('❌ Error: ' + e.message, 'err');
    }
}

async function stopReport() {
    if (!currentSession) { alert('Ga ada session aktif bwang!'); return; }
    try {
        await fetch('/api/stop/' + currentSession, { method: 'POST' });
        log('🛑 Stop signal sent', 'warn');
        document.getElementById('statusDot').className = 'dot stopped';
        document.getElementById('statusText').textContent = 'STOPPED';
        if (pollInterval) clearInterval(pollInterval);
    } catch (e) {
        log('❌ Stop error: ' + e.message, 'err');
    }
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
        if (!currentSession) return;
        try {
            const res = await fetch('/api/stats/' + currentSession);
            const data = await res.json();
            if (!data.success) return;

            const s = data.stats;
            document.getElementById('statSent').textContent = s.sent;
            document.getElementById('statSuccess').textContent = s.success;
            document.getElementById('statFailed').textContent = s.failed;
            document.getElementById('statRound').textContent = s.round;
            document.getElementById('statAccounts').textContent = data.global.totalAccounts;

            if (!data.running) {
                document.getElementById('statusDot').className = 'dot stopped';
                document.getElementById('statusText').textContent = 'FINISHED / STOPPED';
                clearInterval(pollInterval);
            }
        } catch (e) {}
    }, 2000);
}

window.addEventListener('load', () => {
    loadReasons();
    log('HOZOO MD initialized. Ready to fire.', 'ok');
    log('Filter bypass: ACTIVE | Restrictions: NONE', 'ok');
});
</script>
</body>
</html>`;
}

// ==================== SERVER START ====================
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║        HOZOO MD - MASS REPORTER          ║');
    console.log('║        Black-Purple Edition              ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log('║  Server running: http://localhost:' + PORT + '   ║');
    console.log('║  Filter: BYPASSED                        ║');
    console.log('║  Mode: UNRESTRICTED                      ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
