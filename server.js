/* =========================================================
   GOLDEN ACE CASINO — backend v5 (ruletka + sloty, Redis)
   ========================================================= */
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const { Redis } = require('@upstash/redis');

const app            = express();
const PORT           = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'slade2134';
const START_BALANCE  = 1000;
const DAILY_BONUS    = 10000;
const BONUS_COOLDOWN = 24 * 60 * 60 * 1000;

const redis = Redis.fromEnv(); // czyta UPSTASH_REDIS_REST_URL / _TOKEN

app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  if (/\.(json|env|db|sqlite|key|pem|log)$/i.test(req.path)) return res.status(404).send('Not found');
  next();
});
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- baza (Redis) ---------------- */
let db = { users: {}, sessions: {} };

async function loadDb() {
  try {
    const raw = await redis.get('casino:db');
    if (raw) db = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('Redis load error:', e.message);
  }
  db.users    = db.users    || {};
  db.sessions = db.sessions || {};
}

async function save() {
  try {
    await redis.set('casino:db', db);
  } catch (e) {
    console.error('Redis save error:', e.message);
  }
}

// Ładuj DB przy każdym żądaniu API (serverless = brak wspólnej pamięci)
app.use('/api', async (req, res, next) => {
  await loadDb();
  next();
});

/* ---------------- bonus ---------------- */
function nextBonusAt(u){
  if (!u.lastBonus) return 0;
  if (typeof u.lastBonus === 'string'){
    const d = new Date(u.lastBonus + 'T00:00:00').getTime();
    return d + BONUS_COOLDOWN;
  }
  return u.lastBonus + BONUS_COOLDOWN;
}
function formatRemaining(ms){
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/* ---------------- ruletka ---------------- */
const ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const REDS  = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const OUTR = {
  d1:[3,n=>n>=1&&n<=12], d2:[3,n=>n>=13&&n<=24], d3:[3,n=>n>=25],
  low:[2,n=>n>=1&&n<=18], high:[2,n=>n>=19],
  even:[2,n=>n>0&&n%2===0], odd:[2,n=>n%2===1],
  red:[2,n=>REDS.has(n)], black:[2,n=>n>0&&!REDS.has(n)],
  c1:[3,n=>n>0&&n%3===1], c2:[3,n=>n>0&&n%3===2], c3:[3,n=>n>0&&n%3===0]
};
function rule(k) {
  if (typeof k !== 'string') return null;
  if (k[0] === 'i') {
    const parts = k.slice(2).split(',').map(Number);
    if (!parts.length || parts.some(n => !Number.isInteger(n) || n < 0 || n > 36)) return null;
    return [36 / parts.length, n => parts.includes(n)];
  }
  return OUTR[k] || null;
}

/* ---------------- sloty ---------------- */
const SLOT_SY = {
  seven : { pay:{3:50,  4:200, 5:1500}, w:5  },
  melon : { pay:{3:25,  4:100, 5:250 }, w:8  },
  grape : { pay:{3:20,  4:45,  5:100 }, w:11 },
  plum  : { pay:{3:10,  4:25,  5:60  }, w:14 },
  orange: { pay:{3:10,  4:20,  5:50  }, w:15 },
  lemon : { pay:{3:5,   4:10,  5:40  }, w:18 },
  cherry: { pay:{2:2,   3:5,   4:10, 5:30}, w:22 },
  bell  : { w:5 }
};
const SLOT_POOL = [];
for (const k in SLOT_SY) for (let i = 0; i < SLOT_SY[k].w; i++) SLOT_POOL.push(k);

const SLOT_LINES = [
  [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],
  [0,1,2,1,0],[2,1,0,1,2],
  [0,0,1,2,2],[2,2,1,0,0],
  [1,0,0,0,1],[1,2,2,2,1],[1,0,1,2,1]
];
const SLOT_BETS    = [1, 2, 5, 10, 25];
const SLOT_JACKPOT = 5000;

function slotRnd(){ return SLOT_POOL[crypto.randomInt(0, SLOT_POOL.length)]; }

function evalSlotLine(ids){
  let base = ids.find(x => x !== 'bell') || 'seven', n = 0;
  for (const id of ids){
    if (id === base || id === 'bell') n++;
    else break;
  }
  const m = SLOT_SY[base].pay[n];
  return m ? { n, mult: m } : null;
}

/* ---------------- widok ---------------- */
function pub(u) {
  return {
    username:     u.username,
    balance:      u.balance,
    totalWagered: u.totalWagered,
    totalWon:     u.totalWon,
    biggestWin:   u.biggestWin,
    spins:        u.spins,
    wins:         u.wins,
    lastBonus:    u.lastBonus,
    nextBonusAt:  nextBonusAt(u)
  };
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const key = db.sessions[t];
  if (!key || !db.users[key]) return res.status(401).json({ error: 'Sesja wygasła — zaloguj się ponownie' });
  req.userKey = key;
  req.user    = db.users[key];
  next();
}

function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Brak dostępu' });
  next();
}

/* ============ AUTH ============ */
app.post('/api/register', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[\p{L}\p{N}_-]{3,16}$/u.test(username))
    return res.status(400).json({ error: 'Nazwa: 3–16 znaków (litery, cyfry, _ , -)' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Hasło musi mieć min. 4 znaki' });
  const key = username.toLowerCase();
  if (db.users[key]) return res.status(400).json({ error: 'Ta nazwa jest już zajęta' });
  const passHash = await bcrypt.hash(password, 10);
  db.users[key] = {
    username, passHash, balance: START_BALANCE,
    totalWagered: 0, totalWon: 0, biggestWin: 0,
    spins: 0, wins: 0, lastBonus: null, createdAt: Date.now()
  };
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = key;
  await save();
  res.json({ token, user: pub(db.users[key]) });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const key = username.toLowerCase();
  const u = db.users[key];
  if (!u) return res.status(400).json({ error: 'Nie ma takiego konta' });
  const ok = await bcrypt.compare(password, u.passHash);
  if (!ok) return res.status(400).json({ error: 'Błędne hasło' });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = key;
  await save();
  res.json({ token, user: pub(u) });
});

app.post('/api/logout', auth, async (req, res) => {
  const h = req.headers.authorization || '';
  delete db.sessions[h.slice(7)];
  await save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));

/* ============ BONUS ============ */
app.post('/api/bonus', auth, async (req, res) => {
  const now  = Date.now();
  const next = nextBonusAt(req.user);
  if (next > now) {
    return res.status(400).json({
      error: 'Następny bonus za ' + formatRemaining(next - now),
      remaining: next - now, nextBonusAt: next
    });
  }
  req.user.lastBonus = now;
  req.user.balance  += DAILY_BONUS;
  await save();
  res.json({ amount: DAILY_BONUS, user: pub(req.user) });
});

/* ============ RULETKA ============ */
app.post('/api/spin', auth, async (req, res) => {
  const bets = req.body?.bets;
  if (!bets || typeof bets !== 'object')
    return res.status(400).json({ error: 'Brak zakładów' });
  let stake = 0;
  for (const k in bets) {
    const v = Number(bets[k]);
    const r = rule(k);
    if (!r || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v) || v > 1_000_000)
      return res.status(400).json({ error: 'Nieprawidłowy zakład' });
    stake += v;
  }
  if (stake <= 0) return res.status(400).json({ error: 'Brak zakładu' });
  if (stake > req.user.balance) return res.status(400).json({ error: 'Za mało żetonów' });
  const idx = crypto.randomInt(0, 37);
  const num = ORDER[idx];
  let win = 0;
  for (const k in bets) {
    const [mult, fn] = rule(k);
    if (fn(num)) win += Number(bets[k]) * mult;
  }
  const u = req.user;
  u.balance      = u.balance - stake + win;
  u.totalWagered += stake;
  u.totalWon     += win;
  u.spins        += 1;
  if (win > 0) u.wins += 1;
  if (win > u.biggestWin) u.biggestWin = win;
  await save();
  res.json({ idx, num, win, net: win - stake, user: pub(u) });
});

/* ============ BLACKJACK ============ */
app.post('/api/blackjack/settle', auth, async (req, res) => {
  const bet    = Math.floor(Number(req.body?.bet));
  const payout = Math.floor(Number(req.body?.payout));
  if (!Number.isFinite(bet) || bet <= 0 || bet > 1_000_000)
    return res.status(400).json({ error: 'Nieprawidłowy zakład' });
  if (!Number.isFinite(payout) || payout < 0 || payout > 10_000_000)
    return res.status(400).json({ error: 'Nieprawidłowa wypłata' });
  if (bet > req.user.balance)
    return res.status(400).json({ error: 'Za mało żetonów' });

  const u = req.user;
  u.balance      = u.balance - bet + payout;
  u.totalWagered += bet;
  u.totalWon     += payout;
  u.spins        += 1;
  if (payout > 0) u.wins += 1;
  if (payout > u.biggestWin) u.biggestWin = payout;
  await save();
  res.json({ user: pub(u) });
});

/* ============ SLOTY ============ */
app.post('/api/slots/spin', auth, async (req, res) => {
  try {
    const bet = Number(req.body?.bet);
    if (!SLOT_BETS.includes(bet))
      return res.status(400).json({ error: 'Nieprawidłowa stawka' });

    const cost = bet * 10;
    if (cost > req.user.balance)
      return res.status(400).json({ error: 'Za mało żetonów' });

    const grid = [...Array(5)].map(() => [slotRnd(), slotRnd(), slotRnd()]);

    const bells = [0,1,2,3,4].filter(c => grid[c].includes('bell'));
    if (bells.length) bells.forEach(c => { grid[c] = ['bell','bell','bell']; });

    let win = 0, jackpot = false;
    const winningLines = [];

    if (bells.length === 5){
      win = SLOT_JACKPOT * bet;
      jackpot = true;
    } else {
      SLOT_LINES.forEach((ln, i) => {
        const w = evalSlotLine(ln.map((r,c) => grid[c][r]));
        if (w){
          win += w.mult * bet;
          winningLines.push({ line: i + 1, count: w.n, mult: w.mult });
        }
      });
    }

    const u = req.user;
    u.balance      = u.balance - cost + win;
    u.totalWagered += cost;
    u.totalWon     += win;
    u.spins        += 1;
    if (win > 0) u.wins += 1;
    if (win > u.biggestWin) u.biggestWin = win;
    await save();

    res.json({ grid, win, cost, jackpot, winningLines, user: pub(u) });
  } catch (e) {
    console.error('SLOTS CRASH:', e);
    res.status(500).json({ error: 'Slots crash: ' + e.message });
  }
});

/* ============ RANKING ============ */
app.get('/api/leaderboard', (req, res) => {
  const all = Object.values(db.users).map(pub);
  const byBalance    = [...all].sort((a,b) => b.balance    - a.balance).slice(0, 25);
  const byBiggestWin = [...all].sort((a,b) => b.biggestWin - a.biggestWin).slice(0, 25);
  const byTotalWon   = [...all].sort((a,b) => b.totalWon   - a.totalWon).slice(0, 25);
  res.json({ byBalance, byBiggestWin, byTotalWon });
});

/* ============ ADMIN ============ */
app.get('/api/admin/users', adminAuth, (req, res) => {
  const list = Object.values(db.users).map(u => ({ ...pub(u), createdAt: u.createdAt }));
  list.sort((a,b) => b.balance - a.balance);
  res.json(list);
});
app.post('/api/admin/adjust', adminAuth, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const u = db.users[username];
  if (!u) return res.status(404).json({ error: 'Nie ma takiego użytkownika' });
  if (typeof req.body.setBalance === 'number') {
    u.balance = Math.max(0, Math.floor(req.body.setBalance));
  } else {
    const amount = Math.floor(Number(req.body.amount) || 0);
    u.balance = Math.max(0, u.balance + amount);
  }
  await save();
  res.json({ username: u.username, balance: u.balance });
});
app.post('/api/admin/reset-bonus', adminAuth, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const u = db.users[username];
  if (!u) return res.status(404).json({ error: 'Nie ma takiego użytkownika' });
  u.lastBonus = null;
  await save();
  res.json({ ok: true });
});
app.post('/api/admin/delete', adminAuth, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!db.users[username]) return res.status(404).json({ error: 'Nie ma takiego użytkownika' });
  delete db.users[username];
  for (const t in db.sessions) if (db.sessions[t] === username) delete db.sessions[t];
  await save();
  res.json({ ok: true });
});
app.post('/api/admin/reset-stats', adminAuth, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const u = db.users[username];
  if (!u) return res.status(404).json({ error: 'Nie ma takiego użytkownika' });
  u.totalWagered = 0; u.totalWon = 0; u.biggestWin = 0; u.spins = 0; u.wins = 0;
  await save();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🎰 Golden Ace Casino działa na http://localhost:${PORT}`);
  console.log(`🔑 Hasło admina: ${ADMIN_PASSWORD}\n`);
});