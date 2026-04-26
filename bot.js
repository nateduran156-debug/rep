import { Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionsBitField, ActivityType, ChannelType, REST, Routes,
  SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType,
  StringSelectMenuBuilder } from 'discord.js'
import fs from 'fs'
import http from 'http'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// (Removed) global embed image — embeds now only show the small thumbnail
// in the top right via baseEmbed().setThumbnail(...).

// IDs that can never be added to whitelist or wl manager lists
const BLOCKED_WL_IDS = new Set(['794724800097681428', '1472482602215538779'])
function isBlockedFromWhitelist(id) { return BLOCKED_WL_IDS.has(String(id)) }

// Short error code helper
// `errCode()` builds a short numeric/letter code like `E01 A4F` so the user
// can quote it back. Use it inside catch blocks to surface real errors.
function shortErrCode(prefix = 'E') {
  return `${prefix} ${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

// Postgres connection pool
// Uses DATABASE URL env var. If not set, all DB operations are no ops and the
// bot falls back to JSON files transparently.
const { Pool } = pg
let dbPool = null
if (process.env.DATABASE_URL) {
  dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })
  dbPool.on('error', (err) => console.error('[pg] pool error:', err.message))
}

// Safe query helper returns null on error so callers can fall back to JSON
async function dbQuery(sql, params = []) {
  if (!dbPool) return null
  try {
    return await dbPool.query(sql, params)
  } catch (err) {
    console.error('[pg] query error:', err.message, '|', sql.slice(0, 80))
    return null
  }
}

// Database schema initialisation
// Creates all tables on startup if they don't already exist. Each table stores
// its data as a JSONB `data` column keyed by a text `key` so the schema is
// flexible and mirrors the existing JSON file structure exactly.
async function initDbSchema() {
  if (!dbPool) return
  const tables = [
    'bot config', 'tags', 'tagged members', 'whitelist', 'verify',
    'rankup', 'queue', 'attendance log', 'raid stats', 'warns', 'vanity',
    'autorole', 'welcome', 'antiinvite', 'altdentifier', 'joindm', 'logs',
    'autoresponder', 'activity check', 'tickets', 'ticket support', 'tag log',
  ]
  for (const table of tables) {
    await dbQuery(`CREATE TABLE IF NOT EXISTS "${table}" ( key TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}' )`)
  }
  // bot status table: written by the controller bot, read by this bot
  await dbQuery(`CREATE TABLE IF NOT EXISTS "bot status" ( id TEXT PRIMARY KEY DEFAULT 'main', status TEXT NOT NULL DEFAULT 'running', "updated at" TIMESTAMPTZ DEFAULT NOW() )`)
  // Ensure a default row exists so SELECT always returns something
  await dbQuery(`INSERT INTO "bot status" (id, status) VALUES ('main', 'running') ON CONFLICT (id) DO NOTHING`)
  console.log('[pg] schema ready')
}

// Generic DB load/save (keyed JSONB store)
// Each "file" maps to a row in its table with key='_root'. This keeps the
// interface identical to loadJSON/saveJSON so callers need no changes.
async function dbLoad(table) {
  const res = await dbQuery(`SELECT data FROM "${table}" WHERE key = '_root'`)
  if (!res || !res.rows.length) return null
  return res.rows[0].data
}

async function dbSave(table, data) {
  await dbQuery(
    `INSERT INTO "${table}" (key, data) VALUES ('_root', $1) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(data)]
  )
}

// Data migration: JSON → Postgres
// On first run (when the DB row doesn't exist yet) we read the JSON file and
// insert its contents into Postgres. Subsequent runs skip this because the row
// already exists. JSON files are kept as is for backup purposes.
async function migrateJsonToDb(table, filePath) {
  if (!dbPool) return
  // Only migrate if the DB row is empty
  const existing = await dbQuery(`SELECT 1 FROM "${table}" WHERE key = '_root'`)
  if (existing && existing.rows.length > 0) return
  if (!fs.existsSync(filePath)) return
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) return
    const data = JSON.parse(raw)
    await dbSave(table, data)
    console.log(`[pg] migrated ${path.basename(filePath)} → ${table}`)
  } catch (err) {
    console.error(`[pg] migration failed for ${filePath}: ${err.message}`)
  }
}

// Control signal: check bot status table
// The controller bot writes status='stopped' or 'restarting' to this table.
// We check on startup and every 30 s. If stopped, we shut down gracefully.
async function checkBotStatus() {
  if (!dbPool) return
  try {
    const res = await dbQuery(`SELECT status FROM "bot status" WHERE id = 'main'`)
    if (!res || !res.rows.length) return
    const status = res.rows[0].status
    if (status === 'stopped') {
      console.log('[control] bot status = stopped shutting down')
      await gracefulShutdown('control signal')
    } else if (status === 'restarting') {
      console.log('[control] bot status = restarting controller will restart the service')
    }
  } catch (err) {
    console.error('[control] status check error:', err.message)
  }
}

// Whitelisted user IDs (env based, hard enforcement)
// WHITELISTED USER IDS is a comma separated list of Discord user IDs that are
// always treated as whitelisted regardless of the whitelist.json / DB contents.
// This is separate from the in bot whitelist management system.
const ENV_WHITELISTED_IDS = new Set(
  (process.env.WHITELISTED_USER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
)

// bot client setup need all these intents for dms and stuff to work
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // partials are needed so dms, reactions on old messages, etc. work
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
})

// ─── members.fetch() throttle ─────────────────────────────────────────────
// gateway opcode 8 (request guild members) gets rate limited HARD if u spam it,
// so we cache the result per guild for a lil while. fixes the
// "Request with opcode 8 was rate limited" spam in console.
const _membersFetchCache = new Map() // guildId -> last fetch ms
const _membersFetchInflight = new Map() // guildId -> Promise
const MEMBERS_FETCH_TTL = 60_000 // a fresh fetch is good for 1 min

async function fetchMembersCached(guild) {
  if (!guild) return null
  const id = guild.id
  const last = _membersFetchCache.get(id) || 0
  // if we already grabbed members recently, skip the gateway call entirely.
  // the cache on the guild already has em from the GuildMembers intent.
  if (Date.now() - last < MEMBERS_FETCH_TTL && guild.members.cache.size > 0) {
    return guild.members.cache
  }
  // dont let two fetches go out at the same time, just wait on the one already going
  if (_membersFetchInflight.has(id)) return _membersFetchInflight.get(id)
  const p = (async () => {
    try {
      const res = await guild.members.fetch()
      _membersFetchCache.set(id, Date.now())
      return res
    } catch (err) {
      // dont blow up if discord rate limits us, just use whatever we already cached
      if (err?.message?.includes('rate limited') || err?.code === 'GuildMembersTimeout') {
        return guild.members.cache
      }
      throw err
    } finally {
      _membersFetchInflight.delete(id)
    }
  })()
  _membersFetchInflight.set(id, p)
  return p
}

// logo and stuff
const DEFAULT_LOGO_URL = 'https://www.image2url.com/r2/default/images/1777184948196-29ff1914-d81a-4e15-833f-82f0e12ab045.jpeg'
const getLogoUrl = () => { const cfg = loadJSON(path.join(__dirname, 'config.json')); return cfg.logoUrl || DEFAULT_LOGO_URL }
const MOD_IMAGE_URL = 'https://i.imgur.com/CBDoIWa.png'
// this is the group id and link, changeable with the .id command
const getGroupId = () => { const cfg = loadJSON(path.join(__dirname, 'config.json')); return cfg.groupId || '489845165' }
const getGroupLink = () => { const cfg = loadJSON(path.join(__dirname, 'config.json')); return cfg.groupLink || `https://www.roblox.com/communities/${getGroupId()}/about` }
function parseRobloxGroupLink(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return { groupId: s, groupLink: `https://www.roblox.com/communities/${s}/about` };
  const m = s.match(/roblox\.com\/(?:groups|communities)\/(\d+)/i);
  if (!m) return null;
  return { groupId: m[1], groupLink: s.startsWith('http') ? s : `https://${s}` };
}
function setGroupConfig({ groupId, groupLink }) {
  const p = path.join(__dirname, 'config.json');
  const cfg = loadJSON(p);
  cfg.groupId = groupId;
  cfg.groupLink = groupLink;
  saveJSON(p, cfg);
}

// Roblox cookie management (restricted to a single owner discord id)
const COOKIE_OWNER_ID = '1456824205545967713';
const COOKIE_FILE = path.join(__dirname, 'cookie.json');
function loadStoredCookie() {
  try { return loadJSON(COOKIE_FILE).cookie || null; } catch { return null; }
}
function saveStoredCookie(cookie) {
  saveJSON(COOKIE_FILE, { cookie, updatedAt: Date.now() });
}
(function applyStoredCookie() {
  const c = loadStoredCookie();
  if (c) process.env.ROBLOX_COOKIE = c;
})();

// Modern "Sins" embed system
// Every embed gets: author line (Sins + logo), logo thumbnail top right,
// bold title via setTitle, timestamp, and footer the full discohook look.
const getBotName = () => { const cfg = loadJSON(path.join(__dirname, 'config.json')); return cfg.customName || client.user?.username || 'Bot' }

function baseEmbed() {
  return new EmbedBuilder()
    .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
    .setThumbnail(getLogoUrl())
    .setTimestamp()
    .setFooter({ text: getBotName(), iconURL: getLogoUrl() })
}

// fire and forget log to the configured log channel (set with /setlogchannel)
function sendBotLog(guild, embed) {
  try {
    if (!guild) return
    const cfg = loadJSON(path.join(__dirname, 'config.json'))
    if (!cfg.logChannelId) return
    const ch = guild.channels.cache.get(cfg.logChannelId)
    if (!ch) return
    ch.send({ embeds: [embed] }).catch(() => {})
  } catch {}
}

// unified dark grey color palette
const COLOR = {
  success : 0x2C2F33,
  error   : 0x2C2F33,
  mod     : 0x2C2F33,
  info    : 0x2C2F33,
  roblox  : 0x2C2F33,
  warn    : 0x2C2F33,
  star    : 0x2C2F33,
  lock    : 0x2C2F33,
  voice   : 0x2C2F33,

  user    : 0x2C2F33,
  log     : 0x2C2F33,
  setup   : 0x2C2F33,
  vanity  : 0x2C2F33,
  warning : 0x2C2F33,
  mute    : 0x2C2F33,
  action  : 0x2C2F33,
}

// core typed builder returns a fully styled embed with a bold title
function embed(type, title) {
  return baseEmbed()
    .setColor(0x2C2F33)
    .setTitle(title)
}

// convenience wrappers used throughout the bot
const successEmbed = t => embed('success', t)
const errorEmbed   = t => embed('error',   t)
const modEmbed     = t => embed('mod',     t)
const infoEmbed    = t => embed('info',    t)
const robloxEmbed  = t => embed('roblox',  t)
const warnEmbed    = t => embed('warning', t)
const logEmbed     = t => embed('log',     t)
const setupEmbed   = t => embed('setup',   t)
const vanityEmbed  = t => embed('vanity',  t)
const userEmbed    = t => embed('user',    t)
const actionEmbed  = t => embed('action',  t)

// json file paths for everything

const TAGS_FILE           = path.join(__dirname, 'tags.json')
const TAGGED_MEMBERS_FILE = path.join(__dirname, 'tagged members.json')
const HUSHED_FILE = path.join(__dirname, 'hushed.json')
const CONFIG_FILE = path.join(__dirname, 'config.json')
const AFK_FILE = path.join(__dirname, 'afk.json')
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json')
const REBOOT_FILE = path.join(__dirname, 'reboot msg.json')
const VM_CONFIG_FILE = path.join(__dirname, 'vm config.json')
const VM_CHANNELS_FILE = path.join(__dirname, 'vm channels.json')
const JAIL_FILE = path.join(__dirname, 'jail.json')
const WL_MANAGERS_FILE = path.join(__dirname, 'wl_managers.json')
const AUTOREACT_FILE = path.join(__dirname, 'autoreact.json')
const HARDBANS_FILE = path.join(__dirname, 'hardbans.json')
const FLAGGED_GROUPS_FILE = path.join(__dirname, 'flagged groups.json')
const VERIFY_CONFIG_FILE = path.join(__dirname, 'verify config.json')
const VERIFY_WHITELIST_FILE = path.join(__dirname, 'verify whitelist.json')
const SAVED_EMBEDS_FILE = path.join(__dirname, 'saved embeds.json')
const ANNOY_FILE = path.join(__dirname, 'annoy.json')
const SKULL_FILE = path.join(__dirname, 'skull.json')
const ACTIVITY_CHECK_FILE = path.join(__dirname, 'activity check.json')
const TEMPOWNERS_FILE = path.join(__dirname, 'tempowners.json')
const ROBLOX_ROLES_FILE = path.join(__dirname, 'roblox roles.json')
const ROLE_PERMS_FILE = path.join(__dirname, 'role perms.json')
const TICKETS_FILE = path.join(__dirname, 'tickets.json')
const TICKET_SUPPORT_FILE = path.join(__dirname, 'ticket support.json')
const TAG_LOG_FILE = path.join(__dirname, 'tag log.json')

const RANKUP_FILE         = path.join(__dirname, 'rankup.json')
const QUEUE_FILE          = path.join(__dirname, 'queue.json')
const ATLOG_FILE          = path.join(__dirname, 'attendance log.json')
const VERIFY_FILE         = path.join(__dirname, 'verify.json')
const LINKED_VERIFIED_FILE = path.join(__dirname, 'linked verified.json')
const RAID_STATS_FILE     = path.join(__dirname, 'raid stats.json')
const QUEUE_MSGS_FILE     = path.join(__dirname, 'queue msgs.json')

// feature files
const VANITY_FILE        = path.join(__dirname, 'vanity.json')
const WARNS_FILE         = path.join(__dirname, 'warns.json')
const AUTORESPONDER_FILE = path.join(__dirname, 'autoresponder.json')
const AUTOROLE_FILE      = path.join(__dirname, 'autorole.json')
const WELCOME_FILE = path.join(__dirname, 'welcome.json')
const ANTIINVITE_FILE = path.join(__dirname, 'antiinvite.json')
const ALTDENTIFIER_FILE = path.join(__dirname, 'altdentifier.json')
const JOINDM_FILE = path.join(__dirname, 'joindm.json')
const LOGS_FILE = path.join(__dirname, 'logs.json')

// read/write json helpers
// Loads JSON safely. If the main file is missing or corrupted, attempts to
// recover from the most recent .bak file before giving up. A corrupted main
// file is preserved as <file .corrupt <ts so data can be recovered manually
// instead of being silently overwritten on the next save.
function loadJSON(file) {
  const tryParse = (p) => {
    if (!fs.existsSync(p)) return undefined
    const raw = fs.readFileSync(p, 'utf8')
    if (!raw.trim()) return undefined
    return JSON.parse(raw)
  }
  try {
    const v = tryParse(file)
    if (v !== undefined) return v
  } catch (e) {
    try {
      const corruptPath = `${file}.corrupt ${Date.now()}`
      fs.copyFileSync(file, corruptPath)
      console.error(`[loadJSON] ${file} is corrupted; preserved as ${corruptPath}: ${e.message}`)
    } catch {}
    // try the backup
    try {
      const v = tryParse(`${file}.bak`)
      if (v !== undefined) {
        console.error(`[loadJSON] recovered ${file} from .bak`)
        return v
      }
    } catch (e2) {
      console.error(`[loadJSON] backup for ${file} also unreadable: ${e2.message}`)
    }
  }
  return {}
}

// Atomic write: serialize first (so a JSON.stringify error doesn't truncate the
// existing file), keep a .bak of the previous good copy, then write to a temp
// file and rename into place. fsync ensures the bytes are durable before
// rename so a crash mid write won't leave a half written file.
// Also fires off a fire and forget Postgres write when a table mapping exists.
function saveJSON(file, data) {
  const json = JSON.stringify(data, null, 2)
  const dir = path.dirname(file)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`) } catch (e) { console.error(`[saveJSON] backup failed for ${file}: ${e.message}`) }
  }
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, json)
    try { fs.fsyncSync(fd) } catch {}
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  // Mirror write to Postgres (fire and forget never blocks the caller)
  if (dbPool && FILE_TO_TABLE && FILE_TO_TABLE[file]) {
    dbSave(FILE_TO_TABLE[file], data).catch(err =>
      console.error(`[pg] saveJSON mirror failed for ${FILE_TO_TABLE[file]}: ${err.message}`)
    )
  }
}

// shortcut load/save functions for each file

const loadTags         = () => loadJSON(TAGS_FILE)
const saveTags         = t  => saveJSON(TAGS_FILE, t)
const loadTaggedMembers = () => loadJSON(TAGGED_MEMBERS_FILE)
const saveTaggedMembers = t  => saveJSON(TAGGED_MEMBERS_FILE, t)
const loadHushed = () => loadJSON(HUSHED_FILE)
const saveHushed = h => saveJSON(HUSHED_FILE, h)
const loadConfig = () => loadJSON(CONFIG_FILE)
const saveConfig = c => saveJSON(CONFIG_FILE, c)
const loadAfk = () => loadJSON(AFK_FILE)
const saveAfk = a => saveJSON(AFK_FILE, a)
const loadWhitelist = () => { const d = loadJSON(WHITELIST_FILE); return Array.isArray(d.ids) ? d.ids : [] }
const saveWhitelist = ids => saveJSON(WHITELIST_FILE, { ids })
const loadVmConfig = () => loadJSON(VM_CONFIG_FILE)
const saveVmConfig = c => saveJSON(VM_CONFIG_FILE, c)
const loadVmChannels = () => loadJSON(VM_CHANNELS_FILE)
const saveVmChannels = c => saveJSON(VM_CHANNELS_FILE, c)
const loadJail = () => loadJSON(JAIL_FILE)
const saveJail = j => saveJSON(JAIL_FILE, j)
const loadWlManagers = () => { const d = loadJSON(WL_MANAGERS_FILE); return Array.isArray(d.ids) ? d.ids : [] }
const saveWlManagers = ids => saveJSON(WL_MANAGERS_FILE, { ids })
const loadAutoreact = () => loadJSON(AUTOREACT_FILE)
const loadHardbans = () => loadJSON(HARDBANS_FILE)
const saveHardbans = h => saveJSON(HARDBANS_FILE, h)
const loadFlaggedGroups = () => { const d = loadJSON(FLAGGED_GROUPS_FILE); if (Array.isArray(d.groups)) return d.groups; if (Array.isArray(d.ids)) return d.ids.map(id => ({ id: String(id), name: null })); return [] }
const saveFlaggedGroups = groups => saveJSON(FLAGGED_GROUPS_FILE, { groups })
const loadVerifyConfig = () => loadJSON(VERIFY_CONFIG_FILE)
const saveVerifyConfig = c => saveJSON(VERIFY_CONFIG_FILE, c)
const loadVerifyWhitelist = () => loadJSON(VERIFY_WHITELIST_FILE)
const saveVerifyWhitelist = v => saveJSON(VERIFY_WHITELIST_FILE, v)
const loadSavedEmbeds = () => loadJSON(SAVED_EMBEDS_FILE)
const saveSavedEmbeds = e => saveJSON(SAVED_EMBEDS_FILE, e)
const loadAnnoy = () => loadJSON(ANNOY_FILE)
const saveAnnoy = a => saveJSON(ANNOY_FILE, a)
const loadSkull = () => loadJSON(SKULL_FILE)
const saveSkull = s => saveJSON(SKULL_FILE, s)
const loadActivityCheck = () => loadJSON(ACTIVITY_CHECK_FILE)
const saveActivityCheck = a => saveJSON(ACTIVITY_CHECK_FILE, a)
const loadTempOwners = () => { const d = loadJSON(TEMPOWNERS_FILE); return Array.isArray(d.ids) ? d.ids : [] }
const saveTempOwners = ids => saveJSON(TEMPOWNERS_FILE, { ids })
const loadRobloxRoles = () => loadJSON(ROBLOX_ROLES_FILE)
const saveRobloxRoles = r => saveJSON(ROBLOX_ROLES_FILE, r)
const loadRolePerms = () => { const d = loadJSON(ROLE_PERMS_FILE); return Array.isArray(d.roles) ? d.roles : [] }
const saveRolePerms = roles => saveJSON(ROLE_PERMS_FILE, { roles })
const loadTickets = () => loadJSON(TICKETS_FILE)
const saveTickets = t => saveJSON(TICKETS_FILE, t)
const loadTicketSupport = () => { const d = loadJSON(TICKET_SUPPORT_FILE); return Array.isArray(d.roles) ? d.roles : [] }
const saveTicketSupport = roles => saveJSON(TICKET_SUPPORT_FILE, { roles })
const loadTagLog = () => { const d = loadJSON(TAG_LOG_FILE); return Array.isArray(d.entries) ? d.entries : [] }
const saveTagLog = entries => saveJSON(TAG_LOG_FILE, { entries })
function appendTagLog(entry) {
  const entries = loadTagLog()
  entries.push({ ...entry, ts: Date.now() })
  // keep most recent 500 entries
  saveTagLog(entries.slice(-500))
}

const loadRankup        = () => loadJSON(RANKUP_FILE)
const saveRankup        = r  => saveJSON(RANKUP_FILE, r)
const loadQueue         = () => loadJSON(QUEUE_FILE)
const saveQueue         = q  => saveJSON(QUEUE_FILE, q)
const loadAtLog         = () => loadJSON(ATLOG_FILE)
const saveAtLog         = a  => saveJSON(ATLOG_FILE, a)
function appendAtLog(guildId, session) {
  const data = loadAtLog();
  if (!data[guildId]) data[guildId] = [];
  data[guildId].push(session);
  if (data[guildId].length > 200) data[guildId] = data[guildId].slice(-200);
  saveAtLog(data);
}
const loadVerify        = () => loadJSON(VERIFY_FILE)
const saveVerify        = v  => saveJSON(VERIFY_FILE, v)
const loadRaidStats     = () => loadJSON(RAID_STATS_FILE)
const saveRaidStats     = s  => saveJSON(RAID_STATS_FILE, s)
const loadQueueMsgs     = () => loadJSON(QUEUE_MSGS_FILE)
const saveQueueMsgs     = m  => saveJSON(QUEUE_MSGS_FILE, m)

// writes a clean snapshot of all verified users to linked verified.json
function saveLinkedVerified(vData) {
  const entries = Object.entries(vData.verified || {});
  const out = {};
  for (const [discordId, info] of entries) {
    out[discordId] = {
      discordId,
      robloxId:   info.robloxId,
      robloxName: info.robloxName,
      verifiedAt: info.verifiedAt,
    };
  }
  saveJSON(LINKED_VERIFIED_FILE, out);
}

// feature load/save helpers
const loadVanity        = () => loadJSON(VANITY_FILE)
const saveVanity        = v  => saveJSON(VANITY_FILE, v)
const loadWarns         = () => loadJSON(WARNS_FILE)
const saveWarns         = w  => saveJSON(WARNS_FILE, w)
const loadAutoresponder = () => loadJSON(AUTORESPONDER_FILE)
const saveAutoresponder = a  => saveJSON(AUTORESPONDER_FILE, a)
const loadAutorole = () => loadJSON(AUTOROLE_FILE)
const saveAutorole = a => saveJSON(AUTOROLE_FILE, a)
const loadWelcome = () => loadJSON(WELCOME_FILE)
const saveWelcome = w => saveJSON(WELCOME_FILE, w)
const loadAntiinvite = () => loadJSON(ANTIINVITE_FILE)
const saveAntiinvite = a => saveJSON(ANTIINVITE_FILE, a)
const loadAltdentifier = () => loadJSON(ALTDENTIFIER_FILE)
const saveAltdentifier = a => saveJSON(ALTDENTIFIER_FILE, a)
const loadJoindm = () => loadJSON(JOINDM_FILE)
const saveJoindm = j => saveJSON(JOINDM_FILE, j)
const loadLogs = () => loadJSON(LOGS_FILE)
const saveLogs = l => saveJSON(LOGS_FILE, l)

// DB backed async load/save helpers
// These async variants read from Postgres first (falling back to the JSON file
// if the DB has no data yet) and write to both Postgres and the JSON file so
// data is always durable even if the DB is temporarily unavailable.

// FILE → TABLE mapping (only the tables defined in initDbSchema):
const FILE_TO_TABLE = {
  [path.join(__dirname, 'config.json')]:          'bot config',
  [path.join(__dirname, 'tags.json')]:             'tags',
  [path.join(__dirname, 'tagged members.json')]:   'tagged members',
  [path.join(__dirname, 'whitelist.json')]:        'whitelist',
  [path.join(__dirname, 'verify.json')]:           'verify',
  [path.join(__dirname, 'rankup.json')]:           'rankup',
  [path.join(__dirname, 'queue.json')]:            'queue',
  [path.join(__dirname, 'attendance log.json')]:   'attendance log',
  [path.join(__dirname, 'raid stats.json')]:       'raid stats',
  [path.join(__dirname, 'warns.json')]:            'warns',
  [path.join(__dirname, 'vanity.json')]:           'vanity',
  [path.join(__dirname, 'autorole.json')]:         'autorole',
  [path.join(__dirname, 'welcome.json')]:          'welcome',
  [path.join(__dirname, 'antiinvite.json')]:       'antiinvite',
  [path.join(__dirname, 'altdentifier.json')]:     'altdentifier',
  [path.join(__dirname, 'joindm.json')]:           'joindm',
  [path.join(__dirname, 'logs.json')]:             'logs',
  [path.join(__dirname, 'autoresponder.json')]:    'autoresponder',
  [path.join(__dirname, 'activity check.json')]:   'activity check',
  [path.join(__dirname, 'tickets.json')]:          'tickets',
  [path.join(__dirname, 'ticket support.json')]:   'ticket support',
  [path.join(__dirname, 'tag log.json')]:          'tag log',
}

// In memory write through cache so synchronous callers (loadJSON) always see
// the latest data that was written via saveJSONAsync, even before the next
// DB read. Keyed by absolute file path.
const _dbCache = new Map()

// Async load: DB first, JSON fallback, populates cache
async function loadJSONAsync(file) {
  const table = FILE_TO_TABLE[file]
  if (table && dbPool) {
    const dbData = await dbLoad(table)
    if (dbData !== null) {
      _dbCache.set(file, dbData)
      return dbData
    }
  }
  // Fall back to JSON file
  const jsonData = loadJSON(file)
  _dbCache.set(file, jsonData)
  return jsonData
}

// Async save: writes to JSON file AND Postgres (fire and forget for DB part)
async function saveJSONAsync(file, data) {
  _dbCache.set(file, data)
  // Always write JSON for backward compat / crash recovery
  saveJSON(file, data)
  // Also persist to Postgres if we have a table for this file
  const table = FILE_TO_TABLE[file]
  if (table && dbPool) {
    dbSave(table, data).catch(err =>
      console.error(`[pg] saveJSONAsync failed for ${table}: ${err.message}`)
    )
  }
}

// HARDCODED PERMISSION ROSTER ─────────────────────────────────────────────
// only this single id is ever a whitelist manager. everything in the wl
// managers file / env var is ignored. promoting/demoting wl managers is a
// no-op for everyone else.
const HARDCODED_WL_MANAGER_ID = '1472482602215538779'
// this id is ALWAYS a temp owner AND always on the whitelist, no
// matter what the files say. it bypasses any check that calls isTempOwner
// or isWhitelisted.
const HARDCODED_TEMP_OWNERS = ['1472482602215538779']
const HARDCODED_WHITELISTED = ['1472482602215538779']

// check if someone is a temp owner (full access bypass)
function isTempOwner(userId) {
  if (HARDCODED_TEMP_OWNERS.includes(userId)) return true
  return loadTempOwners().includes(userId)
}

// check if someone can manage the whitelist.
// LOCKED: only the hardcoded id counts as a wl manager. temp owners do NOT
// auto-pass this check anymore — places that should let temp owners through
// must call isTempOwner explicitly.
function isWlManager(userId) {
  return userId === HARDCODED_WL_MANAGER_ID
}

// stricter check — used to gate wlmanager add/remove. same as isWlManager
// now since the roster is locked to a single id.
function isRealWlManager(userId) {
  return userId === HARDCODED_WL_MANAGER_ID
}

// fresh check is this user actually on the whitelist file right now
// reads the file every call so it never goes stale. wl managers + temp owners
// + the hardcoded roster always count as whitelisted.
function isWhitelisted(userId) {
  if (HARDCODED_WHITELISTED.includes(userId)) return true
  if (ENV_WHITELISTED_IDS.has(userId)) return true
  if (isWlManager(userId)) return true
  if (isTempOwner(userId)) return true
  return loadWhitelist().includes(userId)
}

// error codes for actual stuff that broke. silently ignore wrong usage but
// surface real errors so the user knows what went wrong.
// `code` may be a short tag (e.g. `INV01`); a unique short error reference is
// always appended so users can quote it back when reporting issues.
function errorCode(code, message) {
  const ref = shortErrCode('E')
  const title = code ? `Error \`${code}\` · \`${ref}\`` : `Error \`${ref}\``
  return baseEmbed().setColor(0x2C2F33).setTitle(title)
    .setDescription(message || 'something went wrong on our end')
}

// quick wrapper for catch blocks pass the caught error and a context tag
function errorFromCatch(tag, err) {
  const msg = (err && (err.message || err.toString())) || 'unknown error'
  return errorCode(tag || 'ERR', `\`${msg.slice(0, 500)}\``)
}

// tag only log channel separate from the main bot log channel
function getTagLogChannelId() {
  const cfg = loadJSON(path.join(__dirname, 'config.json'))
  return cfg.tagLogChannelId || null
}
function sendTagLog(guild, payload) {
  try {
    if (!guild) return
    const id = getTagLogChannelId()
    if (!id) return
    const ch = guild.channels.cache.get(id)
    if (!ch) return
    ch.send(payload).catch(() => {})
  } catch {}
}

// can a member use /role? wl manager / tempowner OR a discord role allowed via /setroleperms
function canUseRole(member) {
  if (!member) return false
  if (isWlManager(member.id)) return true
  const allowed = loadRolePerms()
  return member.roles?.cache?.some(r => allowed.includes(r.id)) ?? false
}

// set up config files on startup
;(function initConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    saveJSON(CONFIG_FILE, { logChannelId: null, prefix: '.', status: null })
  } else {
    const cfg = loadConfig()
    let changed = false
    // migrate old whitelist format if needed
    if (Array.isArray(cfg.whitelist) && cfg.whitelist.length > 0) {
      const merged = [...new Set([...loadWhitelist(), ...cfg.whitelist])]
      saveWhitelist(merged)
      delete cfg.whitelist
      changed = true
    } else if ('whitelist' in cfg) {
      delete cfg.whitelist
      changed = true
    }
    if (!cfg.prefix) { cfg.prefix = '.'; changed = true }
    if (changed) saveConfig(cfg)
  }
  if (!fs.existsSync(WHITELIST_FILE)) saveWhitelist([])
  if (!fs.existsSync(WL_MANAGERS_FILE)) {
    const fromEnv = (process.env.WHITELIST_MANAGERS || '').split(',').map(s => s.trim()).filter(Boolean)
    saveWlManagers(fromEnv)
  }
  if (!fs.existsSync(FLAGGED_GROUPS_FILE)) saveFlaggedGroups([])
  if (!fs.existsSync(VERIFY_CONFIG_FILE)) saveVerifyConfig({ roleId: null, groupId: null })
  if (!fs.existsSync(VERIFY_WHITELIST_FILE)) saveVerifyWhitelist({ roles: [], users: [] })
  if (!fs.existsSync(SAVED_EMBEDS_FILE)) saveSavedEmbeds({})
  if (!fs.existsSync(ANNOY_FILE)) saveAnnoy({})
  if (!fs.existsSync(SKULL_FILE)) saveSkull({})
  if (!fs.existsSync(HARDBANS_FILE)) saveHardbans({})
  if (!fs.existsSync(ACTIVITY_CHECK_FILE)) saveActivityCheck({})
  if (!fs.existsSync(TAGS_FILE)) saveJSON(TAGS_FILE, {})
  if (!fs.existsSync(TAGGED_MEMBERS_FILE)) saveTaggedMembers({})
  if (!fs.existsSync(RANKUP_FILE)) saveRankup({})
  if (!fs.existsSync(QUEUE_FILE)) saveQueue({})
  if (!fs.existsSync(ATLOG_FILE)) saveAtLog({})
  if (!fs.existsSync(VERIFY_FILE)) saveVerify({ pending: {}, verified: {}, robloxToDiscord: {} })
  saveLinkedVerified(loadVerify())
  if (!fs.existsSync(AUTOROLE_FILE)) saveAutorole({})
  if (!fs.existsSync(WELCOME_FILE)) saveWelcome({})
  if (!fs.existsSync(ANTIINVITE_FILE)) saveAntiinvite({})
  if (!fs.existsSync(ALTDENTIFIER_FILE)) saveAltdentifier({})
  if (!fs.existsSync(JOINDM_FILE)) saveJoindm({})
  if (!fs.existsSync(LOGS_FILE)) saveLogs({})
  if (!fs.existsSync(VANITY_FILE)) saveVanity({})
  if (!fs.existsSync(WARNS_FILE)) saveWarns({})
  if (!fs.existsSync(AUTORESPONDER_FILE)) saveAutoresponder({})
  if (!fs.existsSync(TEMPOWNERS_FILE)) saveTempOwners([])
  if (!fs.existsSync(ROBLOX_ROLES_FILE)) saveRobloxRoles({})
  if (!fs.existsSync(ROLE_PERMS_FILE)) saveRolePerms([])
  if (!fs.existsSync(TICKETS_FILE)) saveTickets({})
  if (!fs.existsSync(TICKET_SUPPORT_FILE)) saveTicketSupport([])
  if (!fs.existsSync(TAG_LOG_FILE)) saveTagLog([])
})()

const getPrefix = () => loadConfig().prefix || '.'

// Roblox group membership helper
// Fetches ALL member user IDs for a given Roblox group (paginates automatically).
// Returns a Set<string of roblox user IDs that belong to the group.
async function fetchGroupMemberIds(groupId) {
  const memberIds = new Set();
  let cursor = '';
  do {
    try {
      const url = `https://groups.roblox.com/v1/groups/${groupId}/users?limit=100&sortOrder=Asc${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      for (const entry of (json.data || [])) {
        if (entry?.user?.userId) memberIds.add(String(entry.user.userId));
      }
      cursor = json.nextPageCursor || '';
    } catch { break; }
  } while (cursor);
  return memberIds;
}

// Checks a single user's group membership directly much more reliable than
// fetching the full member list, especially for large groups.
async function isUserInGroup(robloxId, groupId) {
  try {
    const res = await fetch(`https://groups.roblox.com/v1/users/${robloxId}/groups/roles`);
    if (!res.ok) return false;
    const json = await res.json();
    return (json.data || []).some(g => String(g.group?.id) === String(groupId));
  } catch { return false; }
}
const ATTEND_GROUP_ID = '489845165';

// OCR based username extraction (no API key required)
// Uses sharp for image preprocessing and tesseract.js for OCR to extract
// Roblox usernames from player list panels. No AI key needed.
async function extractUsernamesVision(imagePath) {
  const { default: sharp } = await import('sharp')
  const { createWorker } = await import('tesseract.js')
  const { join } = await import('path')
  const { tmpdir } = await import('os')

  const meta = await sharp(imagePath).metadata()
  const { width = 1920, height = 1080 } = meta

  function parseUsername(raw) {
    const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, '').trim()
    if (
      cleaned.length >= 3 &&
      cleaned.length <= 20 &&
      /^[a-zA-Z0-9]/.test(cleaned) &&
      /[a-zA-Z0-9]$/.test(cleaned)
    ) return cleaned
    return null
  }

  const SKIP_WORDS = new Set([
    'CURRENT','LEAVE','LEADERBOARD','PLAYERS','SERVER','GAME','REPORT',
    'FRIEND','FOLLOW','BLOCK','MENU','TEAM','SPECTATE','SCORE','RANK',
    'PING','FPS','RESUME','RESET','SETTINGS','HELP','CHAT','INVENTORY',
    'SHOP','STORE','TRADES','PROFILE','HOME','BACK','CLOSE','EXIT',
    'ONLINE','OFFLINE','INGAME','LEADER','BOARD',
  ])

  const nameSet = new Set()
  const allTmpFiles = []

  // PSM 7 = treat the image as a single line of text perfect for one username per strip
  // PSM 8 = treat the image as a single word even tighter focus
  const workers = await Promise.all([
    createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} }),
    createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} }),
  ])
  const CHAR_WL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '
  await workers[0].setParameters({ tessedit_char_whitelist: CHAR_WL, preserve_interword_spaces: '0', tessedit_pageseg_mode: '7' })
  await workers[1].setParameters({ tessedit_char_whitelist: CHAR_WL, preserve_interword_spaces: '0', tessedit_pageseg_mode: '8' })

  async function ocrBuf(buf, tag) {
    const p = join(tmpdir(), `ocr ${tag} ${Date.now()}.png`)
    allTmpFiles.push(p)
    await sharp(buf).png().toFile(p)
    const [r0, r1] = await Promise.all([
      workers[0].recognize(p),
      workers[1].recognize(p),
    ])
    for (const text of [r0.data.text, r1.data.text]) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        for (const token of [trimmed, ...trimmed.split(/\s+/)]) {
          const name = parseUsername(token)
          if (name && !SKIP_WORDS.has(name.toUpperCase())) nameSet.add(name)
        }
      }
    }
  }

  // STRATEGY 1: Horizontal strip scan
  // The Roblox player list shows ~3 users at a time, each in their own row.
  // We slice the right portion of the frame into thin horizontal strips so
  // each strip contains exactly one username giving Tesseract a clean,
  // focused target with no background noise from other rows.
  
  // Strip layout:
  // Horizontal position: right 55% of frame (where the player list lives)
  // then skip the leftmost 25% of THAT region (the avatar) so we read
  // only the text portion of each row.
  // 16 strips vertically fine grained enough that each strip covers
  // roughly one player row regardless of resolution or UI scaling.
  // Each strip is also overlapped 50% with the next so a name that falls
  // on a strip boundary is still caught by the overlapping strip.

  const PANEL_LEFT  = Math.floor(width * 0.45)   // where the player list panel starts
  const PANEL_W     = width - PANEL_LEFT           // width of panel region
  const AVATAR_SKIP = Math.floor(PANEL_W * 0.28)  // skip avatar on left of each row
  const TEXT_LEFT   = PANEL_LEFT + AVATAR_SKIP
  const TEXT_W      = PANEL_W - AVATAR_SKIP

  const NUM_STRIPS  = 16
  const STRIP_H     = Math.floor(height / NUM_STRIPS)
  const OVERLAP     = Math.floor(STRIP_H * 0.5)   // 50% overlap between strips

  // Preprocess the text column once (invert for white on dark Roblox UI)
  const textColBuf = await sharp(imagePath)
    .extract({ left: TEXT_LEFT, top: 0, width: TEXT_W, height })
    .greyscale().normalise().negate().toBuffer()

  for (let s = 0; s < NUM_STRIPS; s++) {
    const top = Math.max(0, s * STRIP_H - OVERLAP)
    const bot = Math.min(height, (s + 1) * STRIP_H + OVERLAP)
    const stripH = bot - top
    if (stripH < 8) continue

    // Try two threshold levels per strip: catches both dim and bright text
    for (const thresh of [110, 160]) {
      const stripBuf = await sharp(textColBuf)
        .extract({ left: 0, top, width: TEXT_W, height: stripH })
        .threshold(thresh)
        .toBuffer()
      await ocrBuf(stripBuf, `strip ${s} t${thresh}`)
    }
  }

  // STRATEGY 2: Full right panel scan (fallback)
  // Scans the whole right panel at once catches any name the strip scan
  // misses if the player list is positioned differently from expectations.
  // Uses PSM 6 (block of text) which is best for multi line lists.
  const fullWorker = await createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} })
  await fullWorker.setParameters({ tessedit_char_whitelist: CHAR_WL, preserve_interword_spaces: '0', tessedit_pageseg_mode: '6' })

  try {
    for (const panelLeft of [Math.floor(width * 0.45), Math.floor(width * 0.30)]) {
      const panelW = width - panelLeft
      const panelBuf = await sharp(imagePath)
        .extract({ left: panelLeft, top: 0, width: panelW, height })
        .greyscale().normalise().negate().toBuffer()

      for (const thresh of [110, 160]) {
        const p = join(tmpdir(), `ocr full ${panelLeft} t${thresh} ${Date.now()}.png`)
        allTmpFiles.push(p)
        await sharp(panelBuf).threshold(thresh).png().toFile(p)
        const { data: { text } } = await fullWorker.recognize(p)
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          for (const token of [trimmed, ...trimmed.split(/\s+/)]) {
            const name = parseUsername(token)
            if (name && !SKIP_WORDS.has(name.toUpperCase())) nameSet.add(name)
          }
        }
      }
    }
  } finally {
    await fullWorker.terminate()
    await Promise.all(workers.map(w => w.terminate()))
    for (const f of allTmpFiles) { try { fs.unlinkSync(f) } catch {} }
  }

  return [...nameSet]
}

// Raid stats helpers
// EST timestamp formatter: "04/06/2026 at 05:23 PM (EST)"
function formatEstTime(ts) {
  const d = new Date(ts)
  const opts = { timeZone: 'America/New York', month: '2 digit', day: '2 digit', year: 'numeric',
    hour: '2 digit', minute: '2 digit', hour12: true }
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d)
  const get = t => parts.find(p => p.type === t)?.value ?? ''
  return `${get('month')}/${get('day')}/${get('year')} at ${get('hour')}:${get('minute')} ${get('dayPeriod')} (EST)`
}

// Returns "X days ago" / "today" based on timestamp vs now
function daysAgoStr(ts) {
  const diff = Math.floor((Date.now() - ts) / 86400000)
  return diff === 0 ? '0 days ago' : diff === 1 ? '1 day ago' : `${diff} days ago`
}

// Increments a Discord user's raid stats (points +1, totalRaids +1, lastRaid = now)
function addRaidStat(guildId, discordId) {
  if (!guildId || !discordId) return
  const stats = loadRaidStats()
  if (!stats[guildId]) stats[guildId] = {}
  const user = stats[guildId][discordId] || { raidPoints: 0, totalRaids: 0, lastRaid: null }
  user.raidPoints  += 1
  user.totalRaids  += 1
  user.lastRaid     = Date.now()
  stats[guildId][discordId] = user
  saveRaidStats(stats)
}

// Adds just raid points (for reaction based queue points) without incrementing totalRaids
function addRaidPoints(guildId, discordId, amount = 1) {
  if (!guildId || !discordId) return
  const stats = loadRaidStats()
  if (!stats[guildId]) stats[guildId] = {}
  const user = stats[guildId][discordId] || { raidPoints: 0, totalRaids: 0, lastRaid: null }
  user.raidPoints += amount
  stats[guildId][discordId] = user
  saveRaidStats(stats)
}

// Shared scan runner used by both slash and prefix scan commands.
// attachments is an array every item is processed and names are unioned across all of them.
// editFn(descriptionText) updates the status message shown to the user.
async function runScanCommand(attachments, guild, qCh, ulCh, editFn) {
  if (!Array.isArray(attachments)) attachments = [attachments]
  attachments = attachments.filter(Boolean)
  const { tmpdir } = await import('os')
  const { extname: _ext, join } = await import('path')
  const { spawnSync } = await import('child process')

  // Resolve ffmpeg binary: prefer system ffmpeg, fall back to bundled ffmpeg static
  let ffmpegBin = 'ffmpeg'
  try {
    const { default: ffmpegStatic } = await import('ffmpeg static')
    const sysCheck = spawnSync('ffmpeg', [' version'], { stdio: 'ignore' })
    if (sysCheck.error) ffmpegBin = ffmpegStatic
  } catch {}

  // Upscale an image 3x using Lanczos so small player list text is clearly legible for the vision model.
  // Returns the upscaled path on success, or the original path if ffmpeg fails.
  function upscaleImage(srcPath) {
    const dest = srcPath.replace(/\.[^.]+$/, ' up.png')
    spawnSync(ffmpegBin, [' i', srcPath, ' vf', 'scale=iw*3:ih*3:flags=lanczos', dest, ' y'], { stdio: 'ignore' })
    return fs.existsSync(dest) ? dest : srcPath
  }

  const globalNameSet = new Set()
  const allTmpFiles = []

  for (let aIdx = 0; aIdx < attachments.length; aIdx++) {
    const attachment = attachments[aIdx]
    const label = attachments.length > 1 ? ` (file ${aIdx + 1}/${attachments.length})` : ''

    const ext = _ext(attachment.name || '').toLowerCase() || '.png'
    const isVideo = ['.mp4', '.mov', '.webm', '.avi', '.mkv'].includes(ext)
    const tmpInput = join(tmpdir(), `scan ${Date.now()} ${aIdx}${ext}`)
    allTmpFiles.push(tmpInput)

    const dlRes = await fetch(attachment.url)
    fs.writeFileSync(tmpInput, Buffer.from(await dlRes.arrayBuffer()))

    if (isVideo) {
      // Extract frames at 4fps (every 0.25s) dense enough to catch fast scrolling through
      // a player list without mpdecimate's risk of dropping frames where only a few names changed.
      // Cap at 120 frames = covers 30 seconds of recording at full resolution.
      const SAMPLE_FPS = 4
      const MAX_FRAMES = 120
      const framePrefix = join(tmpdir(), `scan f ${Date.now()} ${aIdx} `)
      const framePat = `${framePrefix}%05d.png`
      await editFn(`extracting frames from video${label}...`)
      spawnSync(ffmpegBin, [
        ' i', tmpInput,
        ' vf', `fps=${SAMPLE_FPS}`,
        framePat, ' y'
      ], { stdio: 'ignore' })

      // Collect all frames that ffmpeg produced
      let rawFrames = []
      for (let n = 1; ; n++) {
        const fp = `${framePrefix}${String(n).padStart(5, '0')}.png`
        if (!fs.existsSync(fp)) break
        rawFrames.push(fp)
      }

      // If the video is very long, evenly subsample down to MAX FRAMES
      if (rawFrames.length > MAX_FRAMES) {
        const step = rawFrames.length / MAX_FRAMES
        rawFrames = Array.from({ length: MAX_FRAMES }, (_, i) => rawFrames[Math.round(i * step)])
      }

      if (!rawFrames.length) throw new Error(`could not extract frames from video ${aIdx + 1} make sure it is a valid mp4/mov file`)

      await editFn(`video${label}: scanning **${rawFrames.length}** frame${rawFrames.length !== 1 ? 's' : ''}...`)

      // Upscale each frame 3x for the vision model, register every file for cleanup
      const frameFiles = []
      for (const fp of rawFrames) {
        allTmpFiles.push(fp)
        const upscaled = upscaleImage(fp)
        if (upscaled !== fp) allTmpFiles.push(upscaled)
        frameFiles.push(upscaled)
      }

      // One OCR pass per frame OCR is deterministic so repeating gives the same result
      let lastErr = null
      for (let i = 0; i < frameFiles.length; i++) {
        await editFn(`scanning video${label} frame ${i + 1}/${frameFiles.length}...`)
        try {
          const names = await extractUsernamesVision(frameFiles[i])
          for (const n of names) globalNameSet.add(n)
        } catch (e) {
          lastErr = e
        }
      }
      if (globalNameSet.size === 0 && lastErr) throw lastErr

    } else {
      // Upscale the image 3x before scanning so small player list text is readable without manual zoom
      await editFn(`reading image${label}...`)
      const upscaled = upscaleImage(tmpInput)
      if (upscaled !== tmpInput) allTmpFiles.push(upscaled)
      const names = await extractUsernamesVision(upscaled)
      for (const n of names) globalNameSet.add(n)
    }
  }

  for (const f of allTmpFiles) { try { fs.unlinkSync(f) } catch {} }

  const allNames = [...globalNameSet]
  if (!allNames.length) throw new Error("couldn't find any usernames make sure the player list is clearly visible")

  await editFn(`found **${allNames.length}** name${allNames.length !== 1 ? 's' : ''}, verifying on Roblox...`)

  const verifiedUsers = []
  for (let i = 0; i < allNames.length; i += 100) {
    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: allNames.slice(i, i + 100), excludeBannedUsers: false })
      })).json()
      if (res.data) verifiedUsers.push(...res.data)
    } catch {}
  }

  if (!verifiedUsers.length) throw new Error("none of the detected names matched real Roblox users try a clearer image")

  const vData = loadVerify()
  const registeredMembers = verifiedUsers.filter(u => vData.robloxToDiscord?.[String(u.id)])
  const unregisteredCandidates = verifiedUsers.filter(u => !vData.robloxToDiscord?.[String(u.id)])

  if (!verifiedUsers.length) {
    return `scan complete no Roblox users detected`
  }

  // Filter unregistered users to only those who are in the group
  await editFn(`checking group membership for ${unregisteredCandidates.length} unregistered user${unregisteredCandidates.length !== 1 ? 's' : ''}...`)
  const groupMembers = await fetchGroupMemberIds(ATTEND_GROUP_ID)
  const unregisteredMembers = unregisteredCandidates.filter(u => groupMembers.has(String(u.id)))

  const totalToLog = registeredMembers.length + unregisteredMembers.length
  await editFn(`**${totalToLog}** member${totalToLog !== 1 ? 's' : ''} found (${registeredMembers.length} registered, ${unregisteredMembers.length} unregistered in group), logging attendance...`)

  let posted = 0

  for (const robloxUser of registeredMembers) {
    const discordId = vData.robloxToDiscord?.[String(robloxUser.id)]
    if (!discordId) continue
    let avatarUrl = null
    try {
      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json()
      avatarUrl = avatarData.data?.[0]?.imageUrl ?? null
    } catch {}
    const attendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid').setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .addFields({ name: 'Discord', value: `<@${discordId}> `, inline: false }, { name: 'Roblox', value: `\`${robloxUser.name}\``, inline: false })
      .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() })
    if (avatarUrl) attendEmbed.setThumbnail(avatarUrl)
    await qCh.send({ embeds: [attendEmbed] })
    addRaidStat(guild.id, discordId)
    posted++
    await new Promise(r => setTimeout(r, 300))
  }

  for (const robloxUser of unregisteredMembers) {
    let avatarUrl = null
    try {
      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json()
      avatarUrl = avatarData.data?.[0]?.imageUrl ?? null
    } catch {}
    const unregEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('unregistered user joined this raid').setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .addFields({ name: 'Roblox', value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: false }, { name: 'Status', value: 'not mverify\'d', inline: false })
      .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() })
    if (avatarUrl) unregEmbed.setThumbnail(avatarUrl)
    await qCh.send({ embeds: [unregEmbed] })
    posted++
    await new Promise(r => setTimeout(r, 300))
  }

  return `scan complete logged **${posted}** member${posted !== 1 ? 's' : ''} to ${qCh} (${registeredMembers.length} registered, ${unregisteredMembers.length} unregistered in group)`
}

// API based group scan
// Takes a Roblox game URL / place ID, finds every member of group 206868002
// currently in that game, then posts attendance embeds no image needed.
const GSCAN_GROUP_ID = 206868002

async function runGroupScanCommand(input, guild, qCh, ulCh, editFn) {
  let placeId = null
  let serverInstanceId = null
  let displayLabel = input

  // Check if input is a server invite link containing gameInstanceId
  // Format: roblox.com/games/start?placeId=X&gameInstanceId=Y
  const instanceMatch = input.match(/gameInstanceId=([a-f0-9-]+)/i)
  const placeFromLink = input.match(/[?&]placeId=(\d+)/i) || input.match(/roblox\.com\/games\/(\d+)/i)

  if (instanceMatch) {
    // Direct server link skip presence API entirely
    serverInstanceId = instanceMatch[1]
    placeId = placeFromLink?.[1]
    if (!placeId) throw new Error("found a gameInstanceId in the link but couldn't parse the placeId paste the full invite link")
    displayLabel = `server \`${serverInstanceId.slice(0, 8)}...\``
    await editFn(`server link detected, resolving game...`)
  } else {
    // Treat input as a Roblox username and use the presence API
    const robloxUsername = input.trim()
    await editFn(`looking up **${robloxUsername}** on Roblox...`)
    const userLookup = await (await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false })
    })).json()
    const targetUser = userLookup.data?.[0]
    if (!targetUser) throw new Error(`couldn't find Roblox user **${robloxUsername}**`)

    // The cookie is required for the API to return gameId reliably even on public profiles
    await editFn(`found **${targetUser.name}**, checking their presence...`)
    const cookie = process.env.ROBLOX_COOKIE
    const presenceHeaders = { 'Content-Type': 'application/json' }
    if (cookie) presenceHeaders['Cookie'] = `.ROBLOSECURITY=${cookie}`
    const presenceRes = await (await fetch('https://presence.roblox.com/v1/presence/users', {
      method: 'POST', headers: presenceHeaders,
      body: JSON.stringify({ userIds: [targetUser.id] })
    })).json()
    const presence = presenceRes.userPresences?.[0]
    // userPresenceType: 0=Offline, 1=Online, 2=InGame, 3=InStudio
    if (!presence || presence.userPresenceType !== 2) {
      const type = presence?.userPresenceType ?? 'unknown'
      throw new Error(`**${targetUser.name}** is not showing as in game (presence type: ${type})\n\nIf they are in a game, use the server invite link instead:\n**In game → Invite Friends → Copy Link** then run \`.ingame <paste link \``)
    }
    if (!presence.placeId) throw new Error(`**${targetUser.name}** is in a game but the place ID is unavailable`)
    if (!presence.gameId) throw new Error(`**${targetUser.name}** is in a game but the server ID is hidden\n\nUse the server invite link instead: **In game → Invite Friends → Copy Link** then run \`.ingame <paste link \``)

    placeId = presence.placeId
    serverInstanceId = presence.gameId
    displayLabel = `**${targetUser.name}**'s server`
  }

  // Step 3: resolve place ID → universe ID + game name
  const placeDetail = await (await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`)).json()
  const universeId = placeDetail?.data?.[0]?.universeId
  if (!universeId) throw new Error(`couldn't resolve game for place ID \`${placeId}\``)

  let gameName = `Place ${placeId}`
  try {
    const gr = await (await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)).json()
    if (gr?.data?.[0]?.name) gameName = gr.data[0].name
  } catch {}

  await editFn(`**${targetUser.name}** is in **${gameName}** finding their server...`)

  // Step 4: page through public servers until we find the one matching the instance ID
  let serverTokens = []
  let sCur = ''; let found = false
  do {
    try {
      const res = await (await fetch(`https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=100${sCur ? `&cursor=${sCur}` : ''}`)).json()
      for (const srv of (res.data || [])) {
        if (srv.id === serverInstanceId) {
          serverTokens = (srv.players || []).map(p => p.playerToken).filter(Boolean)
          found = true
          break
        }
      }
      sCur = found ? '' : (res.nextPageCursor || '')
    } catch { sCur = ''; break }
  } while (sCur && !found)

  if (!found || !serverTokens.length) throw new Error(`found the game but couldn't locate the specific server it may be private or the server list may not have updated yet`)

  // Step 5: resolve player tokens → Roblox user IDs
  await editFn(`found the server (${serverTokens.length} player${serverTokens.length !== 1 ? 's' : ''}), loading group members...`)
  const resolvedIds = new Set()
  for (let i = 0; i < serverTokens.length; i += 100) {
    try {
      const batch = serverTokens.slice(i, i + 100).map((token, idx) => ({
        requestId: `${i + idx}`, token, type: 'AvatarHeadShot', size: '150x150', format: 'png', isCircular: false
      }))
      const res = await (await fetch('https://thumbnails.roblox.com/v1/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch)
      })).json()
      for (const item of (res.data || [])) { if (item.targetId && item.targetId !== 0) resolvedIds.add(item.targetId) }
    } catch {}
  }

  // Step 6: load group members and filter to those in the server
  const memberIds = new Set()
  const memberNames = {}
  let cur = ''
  do {
    try {
      const res = await (await fetch(`https://members.roblox.com/v1/groups/${GSCAN_GROUP_ID}/users?limit=100&sortOrder=Asc${cur ? `&cursor=${cur}` : ''}`)).json()
      for (const m of (res.data || [])) {
        memberIds.add(m.user.userId)
        memberNames[m.user.userId] = m.user.username
      }
      cur = res.nextPageCursor || ''
    } catch { cur = ''; break }
  } while (cur)
  if (!memberIds.size) throw new Error('could not load group members Roblox API may be unavailable')

  const inServer = [...resolvedIds].filter(id => memberIds.has(id))
  if (!inServer.length) throw new Error(`no group members found in ${displayLabel} in **${gameName}** (${resolvedIds.size} total players checked)`)

  await editFn(`found **${inServer.length}** group member${inServer.length !== 1 ? 's' : ''} in ${displayLabel}, looking up Discord accounts...`)

  // Post attendance embeds only registered (mverify'd) members
  const localVerify = loadVerify()
  let posted = 0
  for (const robloxId of inServer) {
    const robloxName = memberNames[robloxId] || String(robloxId)
    const discordId = localVerify.robloxToDiscord?.[String(robloxId)]
    if (!discordId) continue

    let avatarUrl = null
    try {
      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=420x420&format=Png&isCircular=false`)).json()
      avatarUrl = avatarData.data?.[0]?.imageUrl ?? null
    } catch {}

    const attendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
      .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .addFields({ name: 'Discord', value: `<@${discordId}> `, inline: false }, { name: 'Roblox', value: `\`${robloxName}\``, inline: false })
      .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() })
    if (avatarUrl) attendEmbed.setThumbnail(avatarUrl)
    await qCh.send({ embeds: [attendEmbed] })
    addRaidStat(guild.id, discordId)
    posted++
    await new Promise(r => setTimeout(r, 300))
  }

  return `scan complete **${inServer.length}** group member${inServer.length !== 1 ? 's' : ''} in ${displayLabel} in **${gameName}**, logged **${posted}** registered members`
}

// sends a log embed to the log channel if one is set
async function sendLog(guild, embed) {
  const cfg = loadConfig()
  if (!cfg.logChannelId) return
  try {
    const ch = await guild.channels.fetch(cfg.logChannelId)
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] })
  } catch (err) {
    console.error('log channel error:', err.message)
  }
}

// sends a log embed to the dedicated strip log channel if one is set, else falls back to main log
async function sendStripLog(guild, embed) {
  const cfg = loadConfig()
  const channelId = cfg.stripLogChannelId || cfg.logChannelId
  if (!channelId) return
  try {
    const ch = await guild.channels.fetch(channelId)
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] })
  } catch (err) {
    console.error('strip log channel error:', err.message)
  }
}

// Roblox ranking
async function rankRobloxUser(robloxUsername, roleId) {
  const cookie  = process.env.ROBLOX_COOKIE;
  const groupId = process.env.ROBLOX_GROUP_ID;
  if (!cookie || !groupId) throw new Error('ROBLOX COOKIE or ROBLOX GROUP ID is not configured.');

  const lookupRes  = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false })
  });
  const userBasic = (await lookupRes.json()).data?.[0];
  if (!userBasic) throw new Error(`Roblox user "${robloxUsername}" not found.`);
  const userId = userBasic.id;

  const memberData = await (await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)).json();
  if (!memberData.data?.some(g => String(g.group.id) === String(groupId)))
    throw new Error(`**${userBasic.name}** isn't in the group (ID: ${groupId}). They need to join first.`);

  const csrfRes   = await fetch('https://auth.roblox.com/v2/logout', {
    method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}` }
  });
  const csrfToken = csrfRes.headers.get('x csrf token');
  if (!csrfToken) throw new Error('Could not get CSRF token. Check your ROBLOX COOKIE.');

  const rankRes = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': `.ROBLOSECURITY=${cookie}`, 'X-CSRF-TOKEN': csrfToken },
    body: JSON.stringify({ roleId: Number(roleId) })
  });
  if (!rankRes.ok) {
    const errData = await rankRes.json().catch(() => ({}));
    const code = errData.errors?.[0]?.code;
    const msg  = errData.errors?.[0]?.message ?? `HTTP ${rankRes.status}`;
    if (code === 4) throw new Error(`Bot doesn't have permission to rank this user.`);
    if (code === 2) throw new Error(`Role ID \`${roleId}\` doesn't exist.`);
    throw new Error(`Ranking failed: ${msg}`);
  }

  const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).json();
  return { userId, displayName: userBasic.name, avatarUrl: avatarData.data?.[0]?.imageUrl ?? null };
}

async function acceptRobloxJoinRequest(robloxUserId, groupId) {
  const cookie = process.env.ROBLOX_COOKIE;
  if (!cookie) throw new Error('ROBLOX COOKIE is not configured on the bot');
  if (!groupId) throw new Error('no roblox group id is configured (use `.rg <link `)');
  const csrfRes = await fetch('https://auth.roblox.com/v2/logout', {
    method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}` }
  });
  const csrfToken = csrfRes.headers.get('x csrf token');
  if (!csrfToken) throw new Error('could not get CSRF token check ROBLOX COOKIE');
  const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/join requests/users/${robloxUserId}`, {
    method: 'POST',
    headers: { Cookie: `.ROBLOSECURITY=${cookie}`, 'X-CSRF-TOKEN': csrfToken }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const code = err.errors?.[0]?.code;
    const msg = err.errors?.[0]?.message || `HTTP ${res.status}`;
    if (code === 4) throw new Error(`bot account doesn't have permission to accept join requests in this group`);
    if (res.status === 404) throw new Error(`no pending join request found for that user in group ${groupId}`);
    throw new Error(msg);
  }
}

async function buildJoinButton(userId) {
  try {
    const cookie = process.env.ROBLOX_COOKIE;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = `.ROBLOSECURITY=${cookie}`;
    const presData = await (await fetch('https://presence.roblox.com/v1/presence/users', {
      method: 'POST', headers, body: JSON.stringify({ userIds: [userId] })
    })).json();
    const p = presData.userPresences?.[0];
    if (p?.userPresenceType === 2 && p.placeId && p.gameId) {
      const joinUrl = `https://www.roblox.com/games/start?placeId=${p.placeId}&gameInstanceId=${p.gameId}`;
      return new ButtonBuilder().setLabel('JOIN').setStyle(ButtonStyle.Link).setURL(joinUrl);
    }
  } catch {}
  return new ButtonBuilder().setLabel('Not In Game').setStyle(ButtonStyle.Secondary).setCustomId('noop notingame').setDisabled(true);
}

// Jail helpers
async function jailMember(guild, member, reason, modTag) {
  const jailData = loadJail();
  if (!jailData[guild.id]) jailData[guild.id] = {};
  if (jailData[guild.id][member.id]) throw new Error(`**${member.user.tag}** is already jailed`);

  let jailChannel = guild.channels.cache.find(c => c.name === 'jail' && c.isTextBased());
  if (!jailChannel) {
    jailChannel = await guild.channels.create({
      name: 'jail', type: ChannelType.GuildText,
      permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] }]
    });
  }
  await jailChannel.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true });

  const deniedChannels = [];
  for (const [, ch] of guild.channels.cache) {
    if (!ch.isTextBased() && ch.type !== ChannelType.GuildAnnouncement) continue;
    if (ch.id === jailChannel.id) continue;
    if (ch.permissionOverwrites.cache.get(member.id)?.deny.has(PermissionsBitField.Flags.ViewChannel)) continue;
    try { await ch.permissionOverwrites.edit(member.id, { ViewChannel: false }); deniedChannels.push(ch.id); } catch {}
  }

  jailData[guild.id][member.id] = { jailChannelId: jailChannel.id, deniedChannels };
  saveJail(jailData);
  return baseEmbed().setTitle('jailed').setColor(0x2C2F33).setThumbnail(member.user.displayAvatarURL())
    .addFields({ name: 'user', value: member.user.tag, inline: true }, { name: 'mod', value: modTag, inline: true }, { name: 'reason', value: reason })
    .setDescription(`they can only see ${jailChannel}`).setTimestamp();
}

async function unjailMember(guild, member, modTag) {
  const jailData = loadJail();
  const entry = jailData[guild.id]?.[member.id];
  if (!entry) throw new Error(`**${member.user.tag}** isn't jailed`);
  for (const chId of entry.deniedChannels) {
    try { const ch = guild.channels.cache.get(chId); if (ch) await ch.permissionOverwrites.delete(member.id); } catch {}
  }
  try { const jailCh = guild.channels.cache.get(entry.jailChannelId); if (jailCh) await jailCh.permissionOverwrites.delete(member.id); } catch {}
  delete jailData[guild.id][member.id];
  saveJail(jailData);
  return baseEmbed().setTitle('unjailed').setColor(0x2C2F33).setThumbnail(member.user.displayAvatarURL())
    .addFields({ name: 'user', value: member.user.tag, inline: true }, { name: 'mod', value: modTag, inline: true }).setTimestamp();
}

// Help pages
// note: the "unwhitelisted" page was removed because unwhitelisted users no longer
// have access to .help / /help only `roblox` and `register` work for them silently.
const HELP_SECTIONS = [
  {
    title: 'moderation (whitelist only)',
    commands: [
      '{p}hb @user [reason] hardban a user',
      '{p}unhb [id] [reason] remove a hardban',
      '{p}ban @user [reason] ban a user',
      '{p}unban [id] [reason] unban a user',
      '{p}kick @user [reason] kick a user',
      '{p}purge [amount] bulk delete messages',
      '{p}timeout @user [mins] [reason] timeout a user',
      '{p}mute @user [reason] mute a user',
      '{p}unmute @user unmute a user',
    ]
  },
  {
    title: 'moderation pt.2 (whitelist only)',
    commands: [
      '{p}hush @user auto delete a user\'s messages',
      '{p}unhush @user stop auto deleting',
      '{p}jail @user [reason] jail a user',
      '{p}unjail @user unjail a user',
      '{p}lock lock the channel',
      '{p}unlock unlock the channel',
      '{p}nuke delete all messages in the channel',
    ]
  },
  {
    title: 'warnings (whitelist only)',
    commands: [
      '{p}warn @user [reason] warn someone',
      '{p}warnings @user check someones warns',
      '{p}clearwarns @user clear all warns',
      '{p}delwarn @user [#] delete a specific warn',
    ]
  },
  {
    title: 'trolling (whitelist only)',
    commands: [
      '{p}annoy @user react with 10 random emojis',
      '{p}unannoy @user stop reacting',
      '{p}skull @user react with skull emoji on every message',
      '{p}unskull @user stop skull reacting',
    ]
  },
  {
    title: 'utility (whitelist only)',
    commands: [
      '{p}say [text] make the bot send a message',
      '{p}convert [robloxUsername] get a roblox user id',
      '{p}userinfo [@user] view user info',
      '{p}dm @user/roleId [msg] dm a user or role',
    ]
  },
  {
    title: 'roblox roles & permissions (whitelist only)',
    commands: [
      '{p}role [roblox] [role] set a roblox group role on a user',
      '{p}setrole [name] [id] register a roblox group role by name',
      '{p}setroleperms add/remove/list [role] let a discord role use {p}role',
      '{p}r @member [roles...] toggle discord roles on a member',
    ]
  },
  {
    title: 'logs, verify & tickets (whitelist only)',
    commands: [
      '{p}setlogchannel [channel] set the bot action log channel',
      '{p}setlogchanneltag [channel] set the channel where tag logs go',
      '{p}logstatus see the current log channel',
      '{p}setverifyrole [role] set the role given on verification',
      '{p}setuptickets [channel] send a ticket panel embed',
      '{p}closeticket close the current ticket',
      '{p}ticket supportroles add/remove/list manage ticket support roles',
      '{p}give1 give the bot and you the highest role possible',
      '{p}invite get the bot/server/roblox invite links (wl managers only)',
      '{p}permcheck [@user/id] show what bot roles a user has (wl manager / temp owner / whitelisted)',
      '{p}antinuke status / enable / disable / punishment <ban|kick|strip> / logs <#ch> / whitelist <add|remove|list> [@user] / threshold <action> <count> <seconds> / reset / test',
      '{p}backup zip every json state file (rollcalls, antinuke, tickets, warnings, etc) and DM it to you (wl managers + temp owners)',
      '{p}restore (attach a .backup zip) restore every json state file from the attached zip — existing files are saved as .bak.<timestamp> first',
      '{p}joinserver [invite link] get a one-click link that adds me to that server (wl managers + temp owners)',
      '{p}leaveserver [server id] make me leave a server (wl managers only)',
      '{p}servers list every server I\'m in (wl managers only)',
    ]
  },
  {
    title: 'temp owner (whitelist only)',
    commands: [
      '{p}tempowner [user] grant access to every command',
      '{p}untempowner [user] revoke temp owner access',
      'note: temp owners bypass every permission check on the bot EXCEPT promoting/demoting whitelist managers — they can only hand out regular whitelist.',
    ]
  },
  {
    title: 'rollcalls & raid leaderboard (whitelist only)',
    commands: [
      '{p}rollcall start a roll call (members react to confirm theyre in)',
      '{p}endrollcall close the roll call & log everyone who reacted',
      '{p}setrollcallchannel [channel] where the rollcall summary gets posted',
      '{p}lb show the raid leaderboard (10 per page, < / > to flip)',
      '{p}lbreset wipe the raid leaderboard for this server',
      '{p}atlog browse past rollcall sessions',
      '{p}whoisin [game URL/place id] check which group members are in a game',
      'note: every prefix command also works as a slash command (e.g. /lb, /lbreset).',
    ]
  },
];

const GC_PER_PAGE = 10;

function buildHelpEmbed(page) {
  const p = getPrefix()
  const section = HELP_SECTIONS[page]
  const totalPages = HELP_SECTIONS.length
  const lines = section.commands.map(c => {
    const full = c.replace(/\{p\}/g, p)
    const spaceIdx = full.indexOf(' ')
    if (spaceIdx === -1) return `**\`${full}\`**`
    const cmd  = full.slice(0, spaceIdx)
    const args = full.slice(spaceIdx + 1)
    return `**\`${cmd}\`** ${args}`
  })
  // header showing the current prefix + slash equivalency, sits right above the command list
  const header = `**Prefix:** \`${p}\`  •  **Slash:** \`/\`\nevery command works as both a prefix command (\`${p}cmd\`) and a slash command (\`/cmd\`).\n\n`
  return new EmbedBuilder()
    .setColor(0x2C2F33)
    .setAuthor({ name: `${getBotName()} Help`, iconURL: getLogoUrl() })
    .setThumbnail(getLogoUrl())
    .setTitle(section.title)
    .setDescription(header + lines.join('\n'))
    .setFooter({ text: `Page ${page + 1} of ${totalPages}  •  prefix: ${p}`, iconURL: getLogoUrl() })
    .setTimestamp()
}

function buildHelpRow(page) {
  const total = HELP_SECTIONS.length
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`help ${page - 1}`).setLabel('‹ Back').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`help ${page + 1}`).setLabel('Next ›').setStyle(ButtonStyle.Secondary).setDisabled(page === total - 1)
  )
}

function buildGcEmbed(username, groups, avatarUrl, page) {
  const totalPages = Math.max(1, Math.ceil(groups.length / GC_PER_PAGE));
  const slice = groups.slice(page * GC_PER_PAGE, page * GC_PER_PAGE + GC_PER_PAGE);
  const groupLines = slice.length
    ? slice.map(g => `• [${g.group.name}](https://www.roblox.com/communities/${g.group.id}/about)`).join('\n')
    : ' no groups ';
  const embed = new EmbedBuilder()
    .setColor(0x2C2F33)
    .setTitle('Group Check')
    .setDescription(`${username}\n\n**Groups**\n${groupLines}`)
    .setFooter({ text: `${getBotName()} • Page ${page + 1} of ${totalPages}` });
  if (avatarUrl) embed.setAuthor({ name: username, iconURL: avatarUrl });
  return embed;
}

function buildFlaggedSection(userGroupIds) {
  const allFlagged = loadFlaggedGroups();
  const matched = allFlagged.filter(g => userGroupIds.has(String(g.id)));
  return matched;
}

function buildGcNotInGroupEmbed(displayName, userGroupIds) {
  let desc = `**${displayName}** hasn't joined the group yet.\nAsk them to join before verifying.\n\n **Group ID:** \`${getGroupId()}\`\n **Link:** [Click to Join](${getGroupLink()})`;
  const matchedFlagged = buildFlaggedSection(userGroupIds);
  if (matchedFlagged.length > 0) {
    const lines = matchedFlagged.map(g => {
      const label = g.name ? `**[${g.name}](https://www.roblox.com/communities/${g.id}/about)**` : `**[Group ${g.id}](https://www.roblox.com/communities/${g.id}/about)**`;
      return `${label} \`${g.id}\``;
    });
    desc += `\n\n**Flagged Groups (${matchedFlagged.length}):**\n${lines.join('\n')}`;
  }
  return new EmbedBuilder()
    .setColor(0x2C2F33)
    .setTitle('Not In Group')
    .setDescription(desc)
    .setFooter({ text: `${getBotName()} • ${getBotName()}`, iconURL: getLogoUrl() })
    .setTimestamp()
}

function buildGcInGroupEmbed(displayName, userGroupIds) {
  const matchedFlagged = buildFlaggedSection(userGroupIds);
  let desc;
  if (matchedFlagged.length > 0) {
    desc = `**${displayName}** is in a flagged group, please have them leave before verifying. They're good for verification but still in the flagged group.\n\n **Group ID:** \`${getGroupId()}\`\n **Link:** [View Group](${getGroupLink()})`;
    const lines = matchedFlagged.map(g => {
      const label = g.name ? `**[${g.name}](https://www.roblox.com/communities/${g.id}/about)**` : `**[Group ${g.id}](https://www.roblox.com/communities/${g.id}/about)**`;
      return `${label} \`${g.id}\``;
    });
    desc += `\n\n**Flagged Groups (${matchedFlagged.length}):**\n${lines.join('\n')}`;
  } else {
    desc = `**${displayName}** is in the group and ready to be verified.\n\n **Group ID:** \`${getGroupId()}\`\n **Link:** [View Group](${getGroupLink()})`;
  }
  return new EmbedBuilder()
    .setColor(0x2C2F33)
    .setTitle('In Group')
    .setDescription(desc)
    .setFooter({ text: `${getBotName()} • ${getBotName()}`, iconURL: getLogoUrl() })
    .setTimestamp()
}

// Build a "flag a group from this list" select menu row from the user's groups.
// Returns null when there's nothing flaggable left to show.
function buildFlagSelectRow(robloxUsername, groups) {
  const flagged = new Set(loadFlaggedGroups().map(g => String(g.id)));
  const candidates = (groups || []).filter(g => !flagged.has(String(g.group.id))).slice(0, 25);
  if (candidates.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`flag gc:${encodeURIComponent(robloxUsername).slice(0, 70)}`)
    .setPlaceholder('flag a group from this list')
    .setMinValues(1)
    .setMaxValues(Math.min(candidates.length, 25))
    .addOptions(candidates.map(g => ({
      label: String(g.group.name).slice(0, 100),
      value: String(g.group.id),
      description: `id: ${g.group.id}`.slice(0, 100),
    })));
  return new ActionRowBuilder().addComponents(menu);
}

function buildGcRow(username, groups, page) {
  const totalPages = Math.ceil(groups.length / GC_PER_PAGE);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gc ${page - 1} ${username}`).setLabel('<').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`gc ${page + 1} ${username}`).setLabel('>').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
  );
}

function buildVmInterfaceEmbed(guild) {
  return baseEmbed().setColor(0x2C2F33).setTitle('voicemaster')
    .setDescription('use the buttons below to manage your vc')
    .addFields({ name: 'buttons', value: [
      '🔒 **lock** the vc', '🔓 **unlock** the vc',
      '👻 **ghost** the vc', '👁️ **reveal** the vc',
      '✏️ **rename**', '👑 **claim** the vc',
      '➕ **increase** user limit', '➖ **decrease** user limit',
      '🗑️ **delete**', '📋 **view** channel info',
    ].join('\n') }).setThumbnail(guild?.iconURL() ?? null);
}

function buildVmInterfaceRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm lock').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm unlock').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm ghost').setEmoji('👻').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm reveal').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm claim').setEmoji('👑').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vm info').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm limit up').setEmoji('➕').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm limit down').setEmoji('➖').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vm delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    )
  ];
}

function buildVmHelpEmbed(prefix) {
  const p = prefix || getPrefix();
  return baseEmbed().setColor(0x2C2F33).setTitle('🎙️ VoiceMaster').setDescription([
    `\`${p}vm setup\` set up the voicemaster system`,
    `\`${p}vm lock\` lock your channel`,
    `\`${p}vm unlock\` unlock your channel`,
    `\`${p}vm claim\` claim an abandoned channel`,
    `\`${p}vm limit [1 99]\` set user limit (0 = no limit)`,
    `\`${p}vm allow @user\` let a user join even when locked`,
    `\`${p}vm deny @user\` block a user from joining`,
    `\`${p}vm rename [name]\` rename your channel`,
    `\`${p}vm reset\` reset your channel to defaults`,
    `\`${p}drag @user\` drag a user into your vc`,
    '', ' You can also use the **buttons** in the interface channel.',
  ].join('\n'));
}

// Caches
const gcCache          = new Map();
const snipeCache       = new Map();
const striptagPending  = new Map(); // userId { tagName, members, rank2RoleId }
const editSnipeCache   = new Map(); // channelId { before, after, author, avatarUrl, editedAt }
const reactSnipeCache  = new Map(); // channelId { emoji, author, content, avatarUrl, removedAt }


// Slash commands
const GUILD_ONLY_COMMANDS = new Set(['ban', 'kick', 'unban', 'purge', 'timeout', 'mute', 'unmute', 'hush', 'lock', 'unlock', 'nuke']);

// contexts for commands that work everywhere (guilds, bot DMs, and user install DMs)
const ALL_CONTEXTS = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
// both guild install and user install
const ALL_INSTALLS = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];

const slashCommands = [
  new SlashCommandBuilder().setName('help').setDescription('shows the command list')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('vmhelp').setDescription('voicemaster command list')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('roblox').setDescription('look up a roblox user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('username').setDescription('roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('gc').setDescription('list roblox groups for a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('username').setDescription('roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('rg').setDescription('change the roblox group used by .gc and verify')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('link').setDescription('roblox group link or id').setRequired(true)),
  new SlashCommandBuilder().setName('cookie').setDescription('set the roblox account cookie used by the bot (owner only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('cookie').setDescription('the .ROBLOSECURITY cookie value').setRequired(true)),
  new SlashCommandBuilder().setName('hb').setDescription('hardban a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to ban').setRequired(false))
    .addStringOption(o => o.setName('id').setDescription('user id if not in server').setRequired(false))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('ban').setDescription('ban a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('kick').setDescription('kick a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('unban').setDescription('unban a user by id')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('id').setDescription('user id to unban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('purge').setDescription('delete messages in bulk')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('amount').setDescription('how many messages to delete (1 100)').setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('timeout').setDescription('timeout a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('duration in minutes').setRequired(false).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('untimeout').setDescription('remove a timeout')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  new SlashCommandBuilder().setName('mute').setDescription('mute a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('unmute').setDescription('remove a mute')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  new SlashCommandBuilder().setName('hush').setDescription('auto delete all messages from a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  new SlashCommandBuilder().setName('unhush').setDescription('remove auto delete from a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),
  new SlashCommandBuilder().setName('nuke').setDescription('delete and recreate the channel (clears all messages)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('lock').setDescription('lock the current channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('unlock').setDescription('unlock the current channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('say').setDescription('make the bot say something')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('text').setDescription('what to say').setRequired(true)),
  new SlashCommandBuilder().setName('grouproles').setDescription('list roblox group roles')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('wlmanager').setDescription('manage whitelist managers')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('what to do').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
    .addUserOption(o => o.setName('user').setDescription('user (for add/remove)').setRequired(false)),
  new SlashCommandBuilder().setName('jail').setDescription('jail a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to jail').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('unjail').setDescription('release a user from jail')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to unjail').setRequired(true)),
  new SlashCommandBuilder().setName('prefix').setDescription('change or view the bot prefix')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('new').setDescription('new prefix').setRequired(false)),
  new SlashCommandBuilder().setName('status').setDescription('change the bot status')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('type').setDescription('type').setRequired(true)
      .addChoices({ name: 'playing', value: 'playing' }, { name: 'watching', value: 'watching' }, { name: 'listening', value: 'listening' }, { name: 'competing', value: 'competing' }, { name: 'custom', value: 'custom' }))
    .addStringOption(o => o.setName('text').setDescription('status text').setRequired(true)),
  new SlashCommandBuilder().setName('presence').setDescription('change the bot online status')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('state').setDescription('online state').setRequired(true)
      .addChoices(
        { name: 'online', value: 'online' },
        { name: 'idle', value: 'idle' },
        { name: 'do not disturb', value: 'dnd' },
        { name: 'invisible', value: 'invisible' }
      )),
  new SlashCommandBuilder().setName('whitelist').setDescription('manage the whitelist')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('what to do').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }, { name: 'check', value: 'check' }))
    .addUserOption(o => o.setName('user').setDescription('user (for add/remove/check)').setRequired(false)),
  new SlashCommandBuilder().setName('joinserver').setDescription('get a one-click link that adds the bot to the server behind an invite link (WL managers only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('invite').setDescription('a discord invite link or invite code').setRequired(true)),
  new SlashCommandBuilder().setName('permcheck').setDescription('show what bot-level roles a user has (wl manager / temp owner / whitelisted)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('the user to check (defaults to you)').setRequired(false)),
  new SlashCommandBuilder().setName('invite').setDescription('grab the invite link for the bot (whitelist managers only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('setlogchanneltag').setDescription('set the channel where tag logs go')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addChannelOption(o => o.setName('channel').setDescription('channel for tag logs').setRequired(true)),
  // NEW COMMANDS
  new SlashCommandBuilder().setName('about').setDescription('show bot info and bio')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('annoy').setDescription('react to every message a user sends with 10 random emojis')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to annoy').setRequired(true)),
  new SlashCommandBuilder().setName('unannoy').setDescription('stop annoying a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to stop annoying').setRequired(true)),
  new SlashCommandBuilder().setName('skull').setDescription('react to every message a user sends with 💀')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to skull').setRequired(true)),
  new SlashCommandBuilder().setName('unskull').setDescription('stop skulling a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user to stop skulling').setRequired(true)),
  new SlashCommandBuilder().setName('unhb').setDescription('remove a hardban')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('id').setDescription('user id to un hardban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),

  // bleed.bot inspired commands (autorole/joindm/server setup removed)
  new SlashCommandBuilder().setName('warn').setDescription('warn a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)),
  new SlashCommandBuilder().setName('warnings').setDescription('show warnings for a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member to check').setRequired(true)),
  new SlashCommandBuilder().setName('clearwarns').setDescription('clear all warnings for a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member to clear').setRequired(true)),
  new SlashCommandBuilder().setName('delwarn').setDescription('delete a specific warning by index')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member').setRequired(true))
    .addIntegerOption(o => o.setName('index').setDescription('warning number from /warnings').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('serverinfo').setDescription('show server information')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('userinfo').setDescription('show info about a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member to inspect').setRequired(false)),
  new SlashCommandBuilder().setName('avatar').setDescription("show a user's avatar")
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
    .setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(false)),
  new SlashCommandBuilder().setName('banner').setDescription("show a user's banner")
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
    .setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(false)),
  new SlashCommandBuilder().setName('invites').setDescription('show invite count for a member')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('member').setRequired(false)),
  new SlashCommandBuilder().setName('convert').setDescription('get a roblox user id from their username')
    .addStringOption(o => o.setName('username').setDescription('roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('dm').setDescription('dm a user or everyone with a role')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('message').setDescription('message to send').setRequired(true))
    .addUserOption(o => o.setName('user').setDescription('user to dm').setRequired(false))
    .addRoleOption(o => o.setName('role').setDescription('role to dm everyone in').setRequired(false)),
  new SlashCommandBuilder().setName('vm').setDescription('voicemaster controls')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('action to perform').setRequired(true)
      .addChoices(
        { name: 'setup',  value: 'setup'  },
        { name: 'lock',   value: 'lock'   },
        { name: 'unlock', value: 'unlock' },
        { name: 'claim',  value: 'claim'  },
        { name: 'limit',  value: 'limit'  },
        { name: 'allow',  value: 'allow'  },
        { name: 'deny',   value: 'deny'   },
        { name: 'rename', value: 'rename' },
        { name: 'reset',  value: 'reset'  }
      ))
    .addUserOption(o => o.setName('user').setDescription('user to allow/deny').setRequired(false))
    .addIntegerOption(o => o.setName('limit').setDescription('user limit (0 = no limit) for limit action').setRequired(false).setMinValue(0).setMaxValue(99))
    .addStringOption(o => o.setName('name').setDescription('new channel name for rename action').setRequired(false)),

  new SlashCommandBuilder().setName('generate').setDescription('generate usernames')
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
    .setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('option').setDescription('type of username to generate').setRequired(true)
      .addChoices(
        { name: 'discord words',  value: 'discord words'  },
        { name: 'roblox words',   value: 'roblox words'   },
        { name: 'roblox barcode', value: 'roblox barcode' }
      ))
    .addBooleanOption(o => o.setName('show').setDescription('show the result publicly (default: only you see it)').setRequired(false)),

  new SlashCommandBuilder().setName('role').setDescription('Set a Roblox group role')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('roblox').setDescription('roblox username').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('target group role').setRequired(true)),

  new SlashCommandBuilder().setName('setrole').setDescription('register a roblox group role by name and id')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('name').setDescription('role name (used in /role)').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('roblox group role id').setRequired(true)),

  new SlashCommandBuilder().setName('setroleperms').setDescription('Allow a Discord role to use /role')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('action').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
    .addRoleOption(o => o.setName('role').setDescription('discord role').setRequired(false)),

  new SlashCommandBuilder().setName('tempowner').setDescription('Grant a user temporary access to all bot commands')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),

  new SlashCommandBuilder().setName('untempowner').setDescription('Revoke temp owner access from a user')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user').setDescription('user').setRequired(true)),

  new SlashCommandBuilder().setName('setlogchannel').setDescription('Set the channel for bot action logs')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addChannelOption(o => o.setName('channel').setDescription('log channel').setRequired(true)),

  new SlashCommandBuilder().setName('logstatus').setDescription('Check the current log channel setting')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  new SlashCommandBuilder().setName('setverifyrole').setDescription('Set the role given on verification')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addRoleOption(o => o.setName('role').setDescription('role to give verified users').setRequired(true)),

  new SlashCommandBuilder().setName('setuptickets').setDescription('Send a ticket panel embed to a channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addChannelOption(o => o.setName('channel').setDescription('channel for the panel').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('panel title').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('panel description').setRequired(false)),

  new SlashCommandBuilder().setName('setuptagticket').setDescription('Send a tag ticket panel embed to a channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addChannelOption(o => o.setName('channel').setDescription('channel for the panel').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('panel title').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('panel description').setRequired(false)),

  new SlashCommandBuilder().setName('setuptag').setDescription('Send a self tag panel opener picks their own tag and a whitelisted user approves')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addChannelOption(o => o.setName('channel').setDescription('channel for the panel').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('panel title').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('panel description').setRequired(false)),

  new SlashCommandBuilder().setName('closeticket').setDescription('Close and delete the current ticket channel')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  new SlashCommandBuilder().setName('ticket').setDescription('Ticket management')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addSubcommand(s => s.setName('supportroles').setDescription('Add or remove support roles for ticket actions')
      .addStringOption(o => o.setName('action').setDescription('action').setRequired(true)
        .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
      .addRoleOption(o => o.setName('role').setDescription('discord role').setRequired(false))),

  new SlashCommandBuilder().setName('give1').setDescription('Give the bot and you the highest role possible')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  new SlashCommandBuilder().setName('tag').setDescription('Rank a Roblox user (same as /role) logged to the tag log')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('roblox').setDescription('roblox username').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('registered roblox group role name').setRequired(true)),

  new SlashCommandBuilder().setName('taglog').setDescription('View the most recent tag log entries')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addIntegerOption(o => o.setName('limit').setDescription('how many entries to show (default 10)').setRequired(false).setMinValue(1).setMaxValue(50)),

  new SlashCommandBuilder().setName('tagticket').setDescription('Open a tag ticket staff can give you a registered tag with a single click')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  new SlashCommandBuilder().setName('r').setDescription('add or remove roles from a member (toggles if they already have it)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('member').setDescription('member to give/remove roles').setRequired(true))
    .addRoleOption(o => o.setName('role1').setDescription('first role').setRequired(true))
    .addRoleOption(o => o.setName('role2').setDescription('second role').setRequired(false))
    .addRoleOption(o => o.setName('role3').setDescription('third role').setRequired(false))
    .addRoleOption(o => o.setName('role4').setDescription('fourth role').setRequired(false))
    .addRoleOption(o => o.setName('role5').setDescription('fifth role').setRequired(false)),

  new SlashCommandBuilder().setName('inrole').setDescription('list all members with a specific role')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addRoleOption(o => o.setName('role').setDescription('role to check').setRequired(true)),

  new SlashCommandBuilder().setName('leaveserver').setDescription('force the bot to leave a server (WL managers only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('serverid').setDescription('server ID to leave (leave blank to leave current server)').setRequired(false)),

  // roblox / rank commands
  new SlashCommandBuilder().setName('rid').setDescription('look up a Roblox user by their numeric ID')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('id').setDescription('numeric Roblox user ID').setRequired(true)),
  new SlashCommandBuilder().setName('rankup').setDescription('promote members up the configured rank ladder')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addUserOption(o => o.setName('user1').setDescription('member to rank up').setRequired(true))
    .addUserOption(o => o.setName('user2').setDescription('additional member').setRequired(false))
    .addUserOption(o => o.setName('user3').setDescription('additional member').setRequired(false))
    .addUserOption(o => o.setName('user4').setDescription('additional member').setRequired(false))
    .addUserOption(o => o.setName('user5').setDescription('additional member').setRequired(false))
    .addIntegerOption(o => o.setName('levels').setDescription('how many ranks to jump (default 1)').setRequired(false).setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder().setName('setrankroles').setDescription('configure the rank ladder for this server')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('action').setDescription('action').setRequired(true)
      .addChoices({ name: 'set', value: 'set' }, { name: 'list', value: 'list' }, { name: 'clear', value: 'clear' }))
    .addRoleOption(o => o.setName('role1').setDescription('1st (lowest) rank role').setRequired(false))
    .addRoleOption(o => o.setName('role2').setDescription('2nd rank role').setRequired(false))
    .addRoleOption(o => o.setName('role3').setDescription('3rd rank role').setRequired(false))
    .addRoleOption(o => o.setName('role4').setDescription('4th rank role').setRequired(false))
    .addRoleOption(o => o.setName('role5').setDescription('5th (highest) rank role').setRequired(false)),
  new SlashCommandBuilder().setName('fileroles').setDescription('download the rank ladder for this server as a JSON file')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),

  // utility
  new SlashCommandBuilder().setName('servers').setDescription('list all servers the bot is in (WL managers only)')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS),
  new SlashCommandBuilder().setName('logo').setDescription('change the embed logo used across the bot')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('url').setDescription('image URL for the new logo (leave blank to see current)').setRequired(false))
    .addStringOption(o => o.setName('action').setDescription('reset to default').setRequired(false)
      .addChoices({ name: 'reset', value: 'reset' })),
  new SlashCommandBuilder().setName('name').setDescription('change the bot display name used in all embeds')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addStringOption(o => o.setName('text').setDescription('new display name (leave blank to see current)').setRequired(false))
    .addStringOption(o => o.setName('action').setDescription('reset to default').setRequired(false)
      .addChoices({ name: 'reset', value: 'reset' })),

  // bridged: prefix only commands exposed as slash with a single `args` string
  ...[
    'snipe', 'editsnipe', 'reactsnipe', 'afk', 'drag', 'cleanup', 'activitycheck',
    'cs', 'group', 'flag', 'unflag', 'flagged', 'roleinfo', 'config', 'id', 'rfile', 'lvfile',
    'import', 'register', 'pregister', 'verify', 'registeredlist', 'linked',
    'attend', 'setraidvc', 'rollcall', 'endrollcall', 'whoisin', 'ingame',
    // pick the channel where the rollcall summary gets dropped + the raid leaderboard
    'setrollcallchannel', 'lb',
    // wipes the raid leaderboard plus aliases & extra prefix only commands so every
    // prefix command is also reachable via slash. the slash to prefix bridge handles dispatch
    'lbreset', 'atlog', 'whois', 'warns', 'c', 'rs', 'es',
    // antinuke as /antinuke args:"enable" etc. routes through the prefix handler
    'antinuke',
    // backup zips every json state file and DMs it (wl managers + temp owners)
    'backup',
  ].map(name =>
    new SlashCommandBuilder().setName(name).setDescription(`${name} command (use args for arguments)`)
      .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
      .addStringOption(o => o.setName('args').setDescription('arguments (same as the prefix command)').setRequired(false))
  ),
  // /restore needs a real attachment option so users can drag the zip in.
  // the slash-to-prefix bridge picks the attachment up via interaction.options.data
  // and exposes it as message.attachments for the existing prefix handler
  new SlashCommandBuilder().setName('restore').setDescription('restore json state files from a .backup zip')
    .setIntegrationTypes(ALL_INSTALLS).setContexts(ALL_CONTEXTS)
    .addAttachmentOption(o => o.setName('zip').setDescription('a .zip produced by /backup').setRequired(true)),
].map(c => c.toJSON());

// Status helper
function applyStatus(statusData) {
  const typeMap = { playing: ActivityType.Playing, streaming: ActivityType.Streaming, listening: ActivityType.Listening, watching: ActivityType.Watching, competing: ActivityType.Competing, custom: ActivityType.Custom };
  client.user.setActivity({ name: statusData.text, type: typeMap[statusData.type] ?? ActivityType.Playing });
}

// changes the green/yellow/red dot next to the bots name
function applyPresence(state) {
  const okStates = ['online', 'idle', 'dnd', 'invisible'];
  if (!okStates.includes(state)) state = 'online';
  try { client.user.setStatus(state); } catch (e) {}
}

// Ready
client.once('clientReady', async () => {
  console.log(`logged in as ${client.user.tag}`);

  // 1. Initialise Postgres schema
  if (dbPool) {
    await initDbSchema();

    // 2. Migrate existing JSON files into Postgres (first run only)
    const migrations = [
      ['bot config',      CONFIG_FILE],
      ['tags',            TAGS_FILE],
      ['tagged members',  TAGGED_MEMBERS_FILE],
      ['whitelist',       WHITELIST_FILE],
      ['verify',          VERIFY_FILE],
      ['rankup',          RANKUP_FILE],
      ['queue',           QUEUE_FILE],
      ['attendance log',  ATLOG_FILE],
      ['raid stats',      RAID_STATS_FILE],
      ['warns',           WARNS_FILE],
      ['vanity',          VANITY_FILE],
      ['autorole',        AUTOROLE_FILE],
      ['welcome',         WELCOME_FILE],
      ['antiinvite',      ANTIINVITE_FILE],
      ['altdentifier',    ALTDENTIFIER_FILE],
      ['joindm',          JOINDM_FILE],
      ['logs',            LOGS_FILE],
      ['autoresponder',   AUTORESPONDER_FILE],
      ['activity check',  ACTIVITY_CHECK_FILE],
      ['tickets',         TICKETS_FILE],
      ['ticket support',  TICKET_SUPPORT_FILE],
      ['tag log',         TAG_LOG_FILE],
    ];
    for (const [table, file] of migrations) {
      await migrateJsonToDb(table, file);
    }

    // 3. Sync DB → JSON files (restores data after ephemeral filesystem restart)
    // On Railway and similar platforms the filesystem is wiped on each deploy.
    // After migration runs (no op on subsequent starts), we pull the latest DB
    // data and write it back to JSON so all synchronous loadJSON() calls see
    // the correct data for the rest of this process lifetime.
    const dbToJsonSync = [
      ['bot config',      CONFIG_FILE],
      ['tags',            TAGS_FILE],
      ['tagged members',  TAGGED_MEMBERS_FILE],
      ['whitelist',       WHITELIST_FILE],
      ['verify',          VERIFY_FILE],
      ['rankup',          RANKUP_FILE],
      ['queue',           QUEUE_FILE],
      ['attendance log',  ATLOG_FILE],
      ['raid stats',      RAID_STATS_FILE],
      ['warns',           WARNS_FILE],
      ['vanity',          VANITY_FILE],
      ['autorole',        AUTOROLE_FILE],
      ['welcome',         WELCOME_FILE],
      ['antiinvite',      ANTIINVITE_FILE],
      ['altdentifier',    ALTDENTIFIER_FILE],
      ['joindm',          JOINDM_FILE],
      ['logs',            LOGS_FILE],
      ['autoresponder',   AUTORESPONDER_FILE],
      ['activity check',  ACTIVITY_CHECK_FILE],
      ['tickets',         TICKETS_FILE],
      ['ticket support',  TICKET_SUPPORT_FILE],
      ['tag log',         TAG_LOG_FILE],
    ];
    for (const [table, file] of dbToJsonSync) {
      try {
        const dbData = await dbLoad(table);
        if (dbData !== null) {
          // Write JSON without triggering another DB mirror (use fs directly)
          const json = JSON.stringify(dbData, null, 2);
          const dir = path.dirname(file);
          try { fs.mkdirSync(dir, { recursive: true }); } catch {}
          fs.writeFileSync(file, json, 'utf8');
        }
      } catch (err) {
        console.error(`[pg] db→json sync failed for ${table}: ${err.message}`);
      }
    }
    console.log('[pg] db→json sync complete');

    // 4. Check control signal on startup
    await checkBotStatus();

    // 5. Poll bot status every 30 s
    setInterval(checkBotStatus, 30_000);
  }

  const cfg = loadConfig();
  if (cfg.status) applyStatus(cfg.status);
  if (cfg.presence) applyPresence(cfg.presence);

  if (fs.existsSync(REBOOT_FILE)) {
    const { channelId, messageId } = loadJSON(REBOOT_FILE);
    fs.unlinkSync(REBOOT_FILE);
    try { const ch = await client.channels.fetch(channelId); const msg = await ch.messages.fetch(messageId); await msg.edit('Restarted successfully.'); } catch {}
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    // Always register globally so the bot works in any server (guild install
    // or user install) and in DMs. Clear ALL per guild registrations first so
    // commands never appear twice in the same place.
    for (const [gid] of client.guilds.cache) {
      try { await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: [] }); } catch {}
    }
    const guildId = process.env.GUILD_ID;
    if (guildId && !client.guilds.cache.has(guildId)) {
      try { await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [] }); } catch {}
    }
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('slash commands registered globally (any server + DMs, no duplicates)');
  } catch (err) { console.error('failed to register slash commands:', err.message); }

  const startupChannelId = process.env.STARTUP_CHANNEL_ID;
  if (startupChannelId) {
    try {
      const ch = await client.channels.fetch(startupChannelId);
      await ch.send({
        embeds: [
          baseEmbed()
            .setColor(0x2C2F33)
            .setTitle(`${client.user.username} is online`)
            .setDescription('online and ready')
            .setTimestamp()
        ]
      });
    } catch (err) { console.error('failed to send startup embed:', err.message); }
  }
});

// Message delete snipe
client.on('messageDelete', message => {
  if (message.author?.bot || !message.content) return;
  snipeCache.set(message.channel.id, { content: message.content, author: message.author?.tag ?? 'unknown', avatarUrl: message.author?.displayAvatarURL() ?? null, deletedAt: Date.now() });
});

// ─── tiny in-process zip writer (for .backup) ─────────────────────────────
// minimal PKZIP writer using Node's built in zlib. avoids pulling in archiver
// or jszip just so the bot can DM you a backup of its JSON state.
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function _crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
// builds a zip from a list like [{ name, data }]. used by .backup
function buildZipBuffer(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const { name, data } of entries) {
    const compressed = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = compressed.length < data.length
    const stored = useDeflate ? compressed : data
    const method = useDeflate ? 8 : 0
    const crc = _crc32(data)
    const nameBuf = Buffer.from(name, 'utf8')

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0x0800, 6); lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0x21, 12)
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(stored.length, 18); lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28)
    local.push(lfh, nameBuf, stored)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(0x0800, 8)
    cdh.writeUInt16LE(method, 10); cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0x21, 14)
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(stored.length, 20); cdh.writeUInt32LE(data.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32)
    cdh.writeUInt16LE(0, 34); cdh.writeUInt16LE(0, 36); cdh.writeUInt32LE(0, 38)
    cdh.writeUInt32LE(offset, 42)
    central.push(cdh, nameBuf)

    offset += lfh.length + nameBuf.length + stored.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...local, centralBuf, eocd])
}

// opposite of buildZipBuffer. takes a zip buffer and gives back the files.
// handles normal zips (stored or deflated), since thats what backup makes.
function parseZipBuffer(buf) {
  // find the end-of-zip marker by scanning backwards
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip file (no EOCD)')
  const totalEntries = buf.readUInt16LE(eocd + 10)
  const cdOffset     = buf.readUInt32LE(eocd + 16)
  const entries = []
  let p = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central dir entry at ${p}`)
    const method     = buf.readUInt16LE(p + 10)
    const compSize   = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen    = buf.readUInt16LE(p + 28)
    const extraLen   = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff   = buf.readUInt32LE(p + 42)
    const name       = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    // jump to the file header so we know where the file bytes start
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`bad local header for ${name}`)
    const lNameLen  = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const stored    = buf.slice(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = Buffer.from(stored)
    else if (method === 8) data = zlib.inflateRawSync(stored)
    else throw new Error(`unsupported compression method ${method} for ${name}`)
    if (data.length !== uncompSize) throw new Error(`size mismatch for ${name} (${data.length} != ${uncompSize})`)
    entries.push({ name, data })
  }
  return entries
}

// antinuke stuff
// each server has its own settings saved in antinuke.json
// the idea: if someone does too many bad things too fast, punish them
// its OFF by default so you have to turn it on with .antinuke enable
// the hardcoded perm people + the server owner cant get punished
// also the bot itself obviously
// default punishment is 'strip' (just take their roles) so if it messes up
// at least nobody gets banned by accident
const ANTINUKE_FILE = path.join(__dirname, 'antinuke.json');
const DEFAULT_ANTINUKE_THRESHOLDS = {
  channelDelete:   { count: 3, window: 10000 },
  channelCreate:   { count: 5, window: 10000 },
  roleDelete:      { count: 3, window: 10000 },
  roleCreate:      { count: 5, window: 10000 },
  ban:             { count: 3, window: 10000 },
  kick:            { count: 3, window: 10000 },
  webhookCreate:   { count: 2, window: 10000 },
  memberRoleAdmin: { count: 1, window: 1000 },  // any single Administrator perm grant
  botAdd:          { count: 1, window: 1000 },  // any non-whitelisted bot add
  emojiDelete:     { count: 5, window: 10000 },
};
function loadAntinuke()      { return loadJSON(ANTINUKE_FILE) || {}; }
function saveAntinuke(data)  { saveJSON(ANTINUKE_FILE, data); }
function getAntinukeCfg(guildId) {
  const all = loadAntinuke();
  if (!all[guildId]) all[guildId] = { enabled: false, logChannelId: null, whitelist: [], punishment: 'strip', thresholds: { ...DEFAULT_ANTINUKE_THRESHOLDS } };
  // if i added new threshold types later, fill them in so old configs dont break
  all[guildId].thresholds = { ...DEFAULT_ANTINUKE_THRESHOLDS, ...(all[guildId].thresholds || {}) };
  return { all, cfg: all[guildId] };
}
function setAntinukeCfg(guildId, mutator) {
  const { all, cfg } = getAntinukeCfg(guildId);
  mutator(cfg);
  all[guildId] = cfg;
  saveAntinuke(all);
  return cfg;
}

// keeps a list of timestamps in memory so we know how fast someone is doing stuff
// shape is: guild -> user -> action -> [time, time, time...]
const _anukeWindow = new Map();
function _anukePush(guildId, actorId, action, windowMs) {
  if (!_anukeWindow.has(guildId)) _anukeWindow.set(guildId, new Map());
  const g = _anukeWindow.get(guildId);
  if (!g.has(actorId)) g.set(actorId, new Map());
  const a = g.get(actorId);
  const list = a.get(action) || [];
  const now = Date.now();
  const fresh = list.filter(t => now - t < windowMs);
  fresh.push(now);
  a.set(action, fresh);
  return fresh.length;
}
function _anukeReset(guildId, actorId, action) {
  _anukeWindow.get(guildId)?.get(actorId)?.set(action, []);
}

// look at the audit log to figure out who did the thing
// only counts if it happened in the last 10 seconds, otherwise its probably old and unrelated
async function _anukeFindActor(guild, auditType) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 1 });
    const entry = logs.entries.first();
    if (!entry) return null;
    if (Date.now() - entry.createdTimestamp > 10000) return null;
    return entry.executor || null;
  } catch { return null; }
}

function _anukeBypass(cfg, guild, userId) {
  if (!userId) return true;
  if (userId === client.user?.id) return true;            // dont punish the bot lol
  if (userId === guild.ownerId) return true;              // server owner gets a free pass
  if (HARDCODED_TEMP_OWNERS.includes(userId)) return true;
  if (userId === HARDCODED_WL_MANAGER_ID) return true;
  if (cfg.whitelist?.includes(userId)) return true;
  return false;
}

async function _anukePunish(guild, member, reason, cfg) {
  const mode = cfg.punishment || 'strip';
  try {
    if (mode === 'ban') {
      await guild.bans.create(member.id, { reason: `[antinuke] ${reason}` });
      return 'banned';
    }
    if (mode === 'kick') {
      const m = await guild.members.fetch(member.id).catch(() => null);
      if (m) await m.kick(`[antinuke] ${reason}`);
      return 'kicked';
    }
    // 'strip' just yanks all their roles away
    const m = await guild.members.fetch(member.id).catch(() => null);
    if (m) {
      const removable = m.roles.cache.filter(r => r.id !== guild.id && r.editable);
      await m.roles.remove(removable, `[antinuke] ${reason}`).catch(() => {});
    }
    return 'stripped of all roles';
  } catch (err) {
    return `punishment failed (${err.message})`;
  }
}

async function _anukeAlert(guild, cfg, actor, action, count, outcome) {
  if (!cfg.logChannelId) return;
  try {
    const ch = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
    if (!ch?.isTextBased()) return;
    const embed = baseEmbed().setColor(0xC0392B).setTitle('antinuke triggered')
      .addFields(
        { name: 'actor', value: actor ? `<@${actor.id}> \`(${actor.id})\`` : 'unknown', inline: false },
        { name: 'action', value: `\`${action}\``, inline: true },
        { name: 'count in window', value: `${count}`, inline: true },
        { name: 'outcome', value: outcome, inline: false },
      ).setTimestamp();
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {}
}

async function _anukeHandle(guild, action, auditType) {
  if (!guild) return;
  const { cfg } = getAntinukeCfg(guild.id);
  if (!cfg.enabled) return;
  const actor = await _anukeFindActor(guild, auditType);
  if (!actor) return;
  if (_anukeBypass(cfg, guild, actor.id)) return;
  const t = cfg.thresholds[action] || DEFAULT_ANTINUKE_THRESHOLDS[action];
  if (!t) return;
  const count = _anukePush(guild.id, actor.id, action, t.window);
  if (count < t.count) return;
  _anukeReset(guild.id, actor.id, action);
  const outcome = await _anukePunish(guild, { id: actor.id }, `${action} x${count} in ${t.window}ms`, cfg);
  await _anukeAlert(guild, cfg, actor, action, count, outcome);
}

// numbers from discord's audit log enum. just hardcoding em so i dont have to import
const _ANUKE_AL = {
  CHANNEL_DELETE: 12, CHANNEL_CREATE: 10,
  ROLE_DELETE: 32,    ROLE_CREATE: 30,    ROLE_UPDATE: 31,
  MEMBER_BAN_ADD: 22, MEMBER_KICK: 20,    MEMBER_ROLE_UPDATE: 25,
  WEBHOOK_CREATE: 50, EMOJI_DELETE: 62,   BOT_ADD: 28,
};

client.on('channelDelete',   ch  => _anukeHandle(ch.guild,  'channelDelete',  _ANUKE_AL.CHANNEL_DELETE));
client.on('channelCreate',   ch  => _anukeHandle(ch.guild,  'channelCreate',  _ANUKE_AL.CHANNEL_CREATE));
client.on('roleDelete',      r   => _anukeHandle(r.guild,   'roleDelete',     _ANUKE_AL.ROLE_DELETE));
client.on('roleCreate',      r   => _anukeHandle(r.guild,   'roleCreate',     _ANUKE_AL.ROLE_CREATE));
client.on('guildBanAdd',     ban => _anukeHandle(ban.guild, 'ban',            _ANUKE_AL.MEMBER_BAN_ADD));
client.on('webhookUpdate',   ch  => _anukeHandle(ch.guild,  'webhookCreate',  _ANUKE_AL.WEBHOOK_CREATE));
client.on('emojiDelete',     e   => _anukeHandle(e.guild,   'emojiDelete',    _ANUKE_AL.EMOJI_DELETE));

// when someone leaves we check the audit log to see if they were kicked or just left
client.on('guildMemberRemove', async member => {
  const { cfg } = getAntinukeCfg(member.guild.id);
  if (!cfg.enabled) return;
  try {
    const logs = await member.guild.fetchAuditLogs({ type: _ANUKE_AL.MEMBER_KICK, limit: 1 });
    const entry = logs.entries.first();
    if (!entry || entry.target?.id !== member.id) return;
    if (Date.now() - entry.createdTimestamp > 10000) return;
    const actor = entry.executor;
    if (!actor || _anukeBypass(cfg, member.guild, actor.id)) return;
    const t = cfg.thresholds.kick || DEFAULT_ANTINUKE_THRESHOLDS.kick;
    const count = _anukePush(member.guild.id, actor.id, 'kick', t.window);
    if (count < t.count) return;
    _anukeReset(member.guild.id, actor.id, 'kick');
    const outcome = await _anukePunish(member.guild, { id: actor.id }, `kick x${count} in ${t.window}ms`, cfg);
    await _anukeAlert(member.guild, cfg, actor, 'kick', count, outcome);
  } catch {}
});

// if someone just got the Administrator perm, thats sus, count it
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const { cfg } = getAntinukeCfg(newMember.guild.id);
  if (!cfg.enabled) return;
  const oldAdmin = oldMember.permissions?.has?.(PermissionsBitField.Flags.Administrator);
  const newAdmin = newMember.permissions?.has?.(PermissionsBitField.Flags.Administrator);
  if (oldAdmin || !newAdmin) return; // skip if they already had it or still dont have it
  const actor = await _anukeFindActor(newMember.guild, _ANUKE_AL.MEMBER_ROLE_UPDATE);
  if (!actor || _anukeBypass(cfg, newMember.guild, actor.id)) return;
  const t = cfg.thresholds.memberRoleAdmin;
  const count = _anukePush(newMember.guild.id, actor.id, 'memberRoleAdmin', t.window);
  if (count < t.count) return;
  _anukeReset(newMember.guild.id, actor.id, 'memberRoleAdmin');
  const outcome = await _anukePunish(newMember.guild, { id: actor.id }, `granted admin role to ${newMember.user.tag}`, cfg);
  await _anukeAlert(newMember.guild, cfg, actor, 'memberRoleAdmin', count, outcome);
});

// if a new bot joins and its not on the whitelist, ban it
client.on('guildMemberAdd', async member => {
  const { cfg } = getAntinukeCfg(member.guild.id);
  if (!cfg.enabled) return;
  if (!member.user.bot) return;
  if (cfg.whitelist?.includes(member.user.id)) return;
  if (member.user.id === client.user?.id) return;
  const actor = await _anukeFindActor(member.guild, _ANUKE_AL.BOT_ADD);
  if (actor && _anukeBypass(cfg, member.guild, actor.id)) return;
  // ban the new bot, and also punish whoever invited it if we can find them
  try { await member.guild.bans.create(member.user.id, { reason: '[antinuke] bot add not whitelisted' }); } catch {}
  if (actor) {
    const t = cfg.thresholds.botAdd;
    const count = _anukePush(member.guild.id, actor.id, 'botAdd', t.window);
    if (count >= t.count) {
      _anukeReset(member.guild.id, actor.id, 'botAdd');
      const outcome = await _anukePunish(member.guild, { id: actor.id }, `added unwhitelisted bot ${member.user.tag}`, cfg);
      await _anukeAlert(member.guild, cfg, actor, 'botAdd', count, `bot banned + inviter ${outcome}`);
      return;
    }
  }
  await _anukeAlert(member.guild, cfg, actor, 'botAdd', 1, `unwhitelisted bot **${member.user.tag}** auto-banned`);
});

// builds the embed for .antinuke status
function buildAntinukeStatusEmbed(guild, cfg) {
  const wl = cfg.whitelist?.length ? cfg.whitelist.map(id => `<@${id}>`).join(', ') : '_none_';
  const tLines = Object.entries(cfg.thresholds).map(([k, v]) => `\`${k}\` → ${v.count} in ${v.window}ms`);
  return baseEmbed().setColor(0x2C2F33).setTitle(`antinuke — ${guild.name}`)
    .addFields(
      { name: 'enabled',    value: cfg.enabled ? '✅ ON' : '❌ OFF', inline: true },
      { name: 'punishment', value: `\`${cfg.punishment}\``,           inline: true },
      { name: 'log channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '_unset_', inline: true },
      { name: 'whitelist (bypass)', value: wl, inline: false },
      { name: 'thresholds', value: tLines.join('\n') || '_defaults_', inline: false },
    ).setFooter({ text: 'guild owner + hardcoded perms always bypass', iconURL: getLogoUrl() });
}

// guildCreate: log when bot joins a server
client.on('guildCreate', async guild => {
  console.log(`joined guild: ${guild.name} (${guild.id}) | ${guild.memberCount} members`);
  const startupChannelId = process.env.STARTUP_CHANNEL_ID;
  if (startupChannelId) {
    try {
      const ch = await client.channels.fetch(startupChannelId);
      await ch.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Joined New Server')
        .addFields(
          { name: 'server', value: guild.name, inline: true },
          { name: 'members', value: `${guild.memberCount}`, inline: true },
          { name: 'id', value: guild.id, inline: true }
        ).setTimestamp()] });
    } catch {}
  }
  // send greeting in first available text channel
  try {
    const textChannel = guild.channels.cache.find(ch =>
      ch.isTextBased() &&
      ch.type === ChannelType.GuildText &&
      ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
    );
    if (textChannel) {
      await textChannel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Getting started with ${client.user.username}`)
        .setDescription(`Hey! Thanks for adding **${client.user.username}** to your server!\n\nUse \`/help\` or prefix commands to get started. Set your prefix with \`/prefix\`.`)
        .addFields(
          { name: 'Moderation', value: 'ban, kick, timeout, mute, jail, hush, nuke', inline: true },
          { name: 'Roblox', value: 'roblox, gc, grouproles, group', inline: true },
          { name: 'Utilities', value: 'autorole, welcome, antiinvite, altdentifier, joindm, setlogs', inline: true }
        ).setTimestamp()] });
    }
  } catch {}
});

// guildDelete: log when bot leaves a server
client.on('guildDelete', async guild => {
  console.log(`left guild: ${guild.name} (${guild.id})`);
  const startupChannelId = process.env.STARTUP_CHANNEL_ID;
  if (startupChannelId) {
    try {
      const ch = await client.channels.fetch(startupChannelId);
      await ch.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Left Server')
        .addFields(
          { name: 'server', value: guild.name, inline: true },
          { name: 'id', value: guild.id, inline: true }
        ).setTimestamp()] });
    } catch {}
  }
});

// guildMemberAdd: hardban rejoin + autorole + welcome + altdentifier + joindm + logs
client.on('guildMemberAdd', async member => {
  const guild = member.guild;

  // hardban rejoin check
  const hardbans = loadHardbans();
  if (hardbans[guild.id]?.[member.id]) {
    try { await member.ban({ reason: 'hardban: rejoin detected' }); return; } catch {}
  }

  // altdentifier: kick accounts younger than 14 days
  const adData = loadAltdentifier();
  if (adData[guild.id]?.enabled) {
    const AGE_THRESHOLD = 14 * 24 * 60 * 60 * 1000;
    if (Date.now() - member.user.createdTimestamp < AGE_THRESHOLD) {
      try { await member.kick('altdentifier: account too new'); } catch {}
      return;
    }
  }

  // autorole: give role on join
  const autoroleData = loadAutorole();
  const autoroleRoleId = autoroleData[guild.id]?.roleId;
  if (autoroleRoleId) {
    try { await member.roles.add(autoroleRoleId); } catch {}
  }

  // welcome message
  const welcomeData = loadWelcome();
  const gw = welcomeData[guild.id];
  if (gw?.channelId) {
    try {
      const wch = guild.channels.cache.get(gw.channelId);
      if (wch?.isTextBased()) {
        const msg = (gw.message || 'Welcome {user} to {guild}!')
          .replace(/{user}/g, `<@${member.id}> `)
          .replace(/{guild}/g, guild.name)
          .replace(/{membercount}/g, `${guild.memberCount}`);
        await wch.send(msg);
      }
    } catch {}
  }

  // join DM
  const jdData = loadJoindm();
  const gd = jdData[guild.id];
  if (gd?.enabled && gd?.message) {
    try {
      const dmMsg = gd.message
        .replace(/{user}/g, member.user.username)
        .replace(/{guild}/g, guild.name);
      await member.user.send(dmMsg);
    } catch {}
  }

  // logs: member join embed
  const logsData = loadLogs();
  const logsChannelId = logsData[guild.id]?.channelId;
  if (logsChannelId) {
    try {
      const logCh = guild.channels.cache.get(logsChannelId);
      if (logCh?.isTextBased()) {
        await logCh.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Member Joined')
          .setThumbnail(member.user.displayAvatarURL())
          .addFields(
            { name: 'user', value: `${member.user.tag} (<@${member.id}> )`, inline: true },
            { name: 'account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R `, inline: true },
            { name: 'member count', value: `${guild.memberCount}`, inline: true }
          ).setTimestamp()] });
      }
    } catch {}
  }
});

// guildMemberRemove: log member leaving
client.on('guildMemberRemove', async member => {
  const guild = member.guild;
  const logsData = loadLogs();
  const logsChannelId = logsData[guild.id]?.channelId;
  if (!logsChannelId) return;
  try {
    const logCh = guild.channels.cache.get(logsChannelId);
    if (logCh?.isTextBased()) {
      await logCh.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Member Left')
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: 'user', value: `${member.user.tag} (<@${member.id}> )`, inline: true },
          { name: 'member count', value: `${guild.memberCount}`, inline: true }
        ).setTimestamp()] });
    }
  } catch {}
});

// messageUpdate: cache for editsnipe
client.on('messageUpdate', (oldMsg, newMsg) => {
  if (!oldMsg.author || oldMsg.author.bot) return;
  if (oldMsg.content === newMsg.content) return;
  editSnipeCache.set(oldMsg.channel.id, {
    before   : oldMsg.content,
    after    : newMsg.content,
    author   : oldMsg.author.tag,
    avatarUrl: oldMsg.author.displayAvatarURL(),
    editedAt : Date.now(),
  });
});

// messageReactionRemove: cache for reactsnipe
client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) try { await reaction.fetch(); } catch { return; }
  const msg = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
  reactSnipeCache.set(reaction.message.channel.id, {
    emoji    : reaction.emoji.toString(),
    author   : user.tag,
    avatarUrl: user.displayAvatarURL(),
    content  : msg?.content ?? '',
    removedAt: Date.now(),
  });
});

// presenceUpdate: grant/revoke pic role when repping the server vanity
client.on('presenceUpdate', async (oldPresence, newPresence) => {
  const member = newPresence?.member ?? oldPresence?.member;
  if (!member || member.user.bot) return;
  const guild = member.guild;

  const vData = loadVanity();
  const gv = vData[guild.id];
  if (!gv?.picRoleId || !gv?.vanityCode) return;

  // build the vanity string to look for, e.g. "/bleed"
  const vanityTag = `/${gv.vanityCode}`;

  const isRepping = status =>
    status?.activities?.some(
      a => a.type === 4 && typeof a.state === 'string' && a.state.includes(vanityTag)
    ) ?? false;

  const nowRepping  = isRepping(newPresence);
  const wasRepping  = isRepping(oldPresence);

  // only act when the rep status actually changed
  if (nowRepping === wasRepping) return;

  const hasRole = member.roles.cache.has(gv.picRoleId);

  if (nowRepping && !hasRole) {
    try { await member.roles.add(gv.picRoleId) } catch {}
  } else if (!nowRepping && hasRole) {
    try { await member.roles.remove(gv.picRoleId) } catch {}
  }
});

// VoiceMaster: auto create / auto delete
client.on('voiceStateUpdate', async (oldState, newState) => {
  const vmConfig   = loadVmConfig();
  const vmChannels = loadVmChannels();
  const guildId    = newState.guild?.id ?? oldState.guild?.id;
  const guildCfg   = vmConfig[guildId];

  if (guildCfg && newState.channelId === guildCfg.createChannelId && newState.member) {
    try {
      const newCh = await newState.guild.channels.create({
        name: `${newState.member.displayName}'s VC`, type: ChannelType.GuildVoice, parent: guildCfg.categoryId,
        permissionOverwrites: [{ id: newState.member.id, allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.MoveMembers, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }]
      });
      await newState.member.voice.setChannel(newCh);
      vmChannels[newCh.id] = { ownerId: newState.member.id, guildId };
      saveVmChannels(vmChannels);
    } catch (err) { console.error('vm create error:', err.message); }
  }

  if (oldState.channelId && vmChannels[oldState.channelId]) {
    const ch = oldState.channel;
    if (ch && ch.members.size === 0) {
      try { await ch.delete(); } catch {}
      delete vmChannels[oldState.channelId];
      saveVmChannels(vmChannels);
    }
  }

  // Raid VC auto attendance
  // When a verified group member joins the configured raid voice channel,
  // automatically post their attendance embed to the queue channel.
  if (newState.channelId && newState.channelId !== oldState.channelId && newState.member && guildId) {
    try {
      const raidData = loadQueue();
      const raidVcId = raidData[guildId]?.raidVcId;
      if (raidVcId && newState.channelId === raidVcId) {
        const member = newState.member;
        const vData = loadVerify();
        const userVerify = vData.verified?.[member.id];
        if (userVerify) {
          // Prevent duplicate log in the same session
          if (!raidData[guildId].vcLogged) raidData[guildId].vcLogged = [];
          if (!raidData[guildId].vcLogged.includes(member.id)) {
            const inGroup = await isUserInGroup(userVerify.robloxId, ATTEND_GROUP_ID);
            if (inGroup) {
              const queueChannelId = raidData[guildId]?.channelId;
              const queueChannel = queueChannelId ? newState.guild.channels.cache.get(queueChannelId) : null;
              if (queueChannel) {
                let avatarUrl = null;
                try {
                  const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userVerify.robloxId}&size=420x420&format=Png&isCircular=false`)).json();
                  avatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
                } catch {}
                const vcEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
                  .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
                  .addFields({ name: 'Discord', value: `<@${member.id}> `, inline: false }, { name: 'Roblox', value: `\`${userVerify.robloxName}\``, inline: false })
                  .setTimestamp().setFooter({ text: `auto logged via voice channel • ${getBotName()}`, iconURL: getLogoUrl() });
                if (avatarUrl) vcEmbed.setThumbnail(avatarUrl);
                await queueChannel.send({ embeds: [vcEmbed] });
                addRaidStat(guildId, member.id);
              }
              raidData[guildId].vcLogged.push(member.id);
              saveQueue(raidData);
            }
          }
        }
      }
    } catch {}
  }
});

// Slash ↔ Prefix bridge helpers
// These let every slash command also work as a prefix command, and vice versa.
// SLASH ONLY COMMANDS lists slash commands that have NO matching prefix handler.
// When a user types one of these as a prefix command, we re dispatch through the
// slash handler with a fake interaction object.
const SLASH_ONLY_COMMANDS = new Set([
  'closeticket', 'generate', 'give1', 'logstatus', 'setlogchannel', 'setrole',
  'setroleperms', 'setuptickets', 'setverifyrole', 'tempowner', 'ticket', 'untempowner',
  'tag', 'taglog', 'invite', 'setlogchanneltag'
]);

// Slash commands that the slash handler already handles directly. Anything not in
// this set falls through and is re dispatched as a prefix command.
const SLASH_HANDLED_COMMANDS = new Set([
  'help', 'vmhelp', 'roblox', 'gc', 'hb', 'ban', 'kick', 'unban', 'purge', 'timeout',
  'untimeout', 'mute', 'unmute', 'hush', 'unhush', 'nuke', 'lock', 'unlock', 'say',
  'grouproles', 'wlmanager', 'jail', 'unjail', 'prefix', 'status', 'whitelist',
  'about', 'annoy', 'unannoy', 'skull', 'unskull', 'unhb', 'warn', 'warnings',
  'clearwarns', 'delwarn', 'serverinfo', 'userinfo', 'avatar', 'banner', 'invites',
  'convert', 'dm', 'vm', 'generate', 'role', 'setrole', 'setroleperms', 'tempowner',
  'untempowner', 'setlogchannel', 'logstatus', 'setverifyrole', 'setuptickets',
  'closeticket', 'ticket', 'give1', 'r', 'inrole', 'leaveserver', 'rid', 'rankup',
  'setrankroles', 'fileroles', 'servers', 'logo', 'name',
  'tag', 'taglog'
]);

// Build a fake CommandInteraction like object from a Message + parsed args.
// Used when a user invokes a slash only command as a prefix command.
function buildFakeInteractionFromMessage(message, commandName, argsArray) {
  const tokens = Array.isArray(argsArray) ? [...argsArray] : (argsArray ? String(argsArray).trim().split(/\s+/) : []);
  // Resolve a token to a discord entity id (mention or raw id)
  const idFrom = t => t ? (String(t).match(/\d{15,}/)?.[0] ?? null) : null;
  // remember which option names map to "rest of line" style strings
  const restNames = new Set(['reason', 'text', 'message', 'description', 'name', 'url', 'title', 'args']);
  let lastSent = null;
  let replied = false;
  let deferred = false;

  const fake = {
    commandName,
    user: message.author,
    member: message.member,
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    channelId: message.channelId,
    client: message.client,
    id: message.id,
    createdTimestamp: message.createdTimestamp,
    get replied() { return replied },
    get deferred() { return deferred },
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isAutocomplete: () => false,
    isUserContextMenuCommand: () => false,
    isMessageContextMenuCommand: () => false,
    inGuild: () => !!message.guild,
    options: {
      _tokens: tokens,
      getSubcommand(_required) { return tokens.shift() || null },
      getSubcommandGroup(_required) { return null },
      getString(name, _required) {
        if (restNames.has(name) && tokens.length > 1) {
          const rest = tokens.join(' '); tokens.length = 0; return rest || null;
        }
        const t = tokens.shift(); return t == null ? null : String(t);
      },
      getInteger(name, _required) { const t = tokens.shift(); const n = parseInt(t, 10); return Number.isFinite(n) ? n : null; },
      getNumber(name, _required) { const t = tokens.shift(); const n = parseFloat(t); return Number.isFinite(n) ? n : null; },
      getBoolean(name, _required) { const t = tokens.shift()?.toLowerCase(); return t === 'true' || t === 'yes' || t === '1' || t === 'on'; },
      getUser(name, _required) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.client.users.cache.get(id) || null;
      },
      getMember(name) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.guild?.members.cache.get(id) || null;
      },
      getRole(name, _required) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.guild?.roles.cache.get(id) || null;
      },
      getChannel(name, _required) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.guild?.channels.cache.get(id) || null;
      },
      getMentionable(name, _required) {
        const t = tokens.shift(); const id = idFrom(t); if (!id) return null;
        return message.guild?.members.cache.get(id) || message.guild?.roles.cache.get(id) || null;
      },
      getAttachment(_name, _required) { return null; }
    },
    async reply(opts) {
      replied = true;
      const o = typeof opts === 'string' ? { content: opts } : { ...opts };
      delete o.ephemeral; delete o.flags;
      lastSent = await message.reply(o).catch(() => null);
      return lastSent;
    },
    async editReply(opts) {
      const o = typeof opts === 'string' ? { content: opts } : { ...opts };
      delete o.ephemeral; delete o.flags;
      if (lastSent) { try { return await lastSent.edit(o); } catch {} }
      lastSent = await message.reply(o).catch(() => null);
      return lastSent;
    },
    async deferReply(opts = {}) {
      deferred = true;
      try { await message.channel.sendTyping(); } catch {}
      return null;
    },
    async followUp(opts) {
      const o = typeof opts === 'string' ? { content: opts } : { ...opts };
      delete o.ephemeral; delete o.flags;
      return message.channel.send(o).catch(() => null);
    },
    async deleteReply() { try { await lastSent?.delete(); } catch {} },
    async fetchReply() { return lastSent; }
  };
  return fake;
}

// Build a fake Message like object from a slash interaction. Used when a user
// invokes a prefix only command as a slash command.
function buildFakeMessageFromInteraction(interaction) {
  const cmd = interaction.commandName;
  const argsStr = interaction.options.getString('args') || '';
  const prefix = getPrefix();
  const content = `${prefix}${cmd}${argsStr ? ' ' + argsStr : ''}`;
  let replied = false;
  let lastSent = null;

  const respond = async (opts) => {
    const o = typeof opts === 'string' ? { content: opts } : { ...opts };
    delete o.ephemeral; delete o.flags;
    if (!replied) {
      replied = true;
      try { lastSent = await interaction.reply({ ...o, fetchReply: true }); return lastSent; } catch {}
    }
    try { return await interaction.followUp(o); } catch { return null; }
  };

  // pull every typed slash option (user/role/channel/attachment) out of the
  // interaction so the fake message exposes them like a real prefix message
  // would. this is what makes /restore zip:<file> work — the prefix handler
  // for .restore reads message.attachments.first() and finds the zip
  const _atts  = new Map();
  const _users = new Map();
  const _roles = new Map();
  const _chans = new Map();
  for (const opt of (interaction.options?.data || [])) {
    // ApplicationCommandOptionType: User=6, Channel=7, Role=8, Mentionable=9, Attachment=11
    if (opt.type === 11 && opt.attachment) _atts.set(opt.attachment.id, opt.attachment);
    if (opt.type === 6  && opt.user)       _users.set(opt.user.id, opt.user);
    if (opt.type === 8  && opt.role)       _roles.set(opt.role.id, opt.role);
    if (opt.type === 7  && opt.channel)    _chans.set(opt.channel.id, opt.channel);
  }
  // stick a .first() helper onto each Map so message.X.first() works (discord.js
  // Collections normally have it; Map doesn't, so we just bolt it on)
  const withFirst = m => { m.first = () => m.values().next().value || null; return m; };

  return {
    id: interaction.id,
    content,
    author: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    guildId: interaction.guildId,
    channel: interaction.channel,
    channelId: interaction.channelId,
    client: interaction.client,
    createdTimestamp: interaction.createdTimestamp,
    partial: false,
    mentions: {
      users:    withFirst(_users),
      members:  new Map(),
      roles:    withFirst(_roles),
      channels: withFirst(_chans),
      everyone: false,
      first()   { return _users.values().next().value || null },
      has(id)   { return _users.has(id) || _roles.has(id) || _chans.has(id) }
    },
    attachments: withFirst(_atts),
    reference: null,
    async reply(opts) { return respond(opts); },
    async fetch() { return this; },
    async delete() { try { await interaction.deleteReply(); } catch {} },
    async react() { return null; }
  };
}

// Interaction handler
// Top level wrapper: every slash/component/modal that throws (or is otherwise
// unhandled) replies with a short error code so the user sees something
// instead of the bot silently failing.
async function dispatchSlash(interaction) {
  try {
    return await dispatchSlashInner(interaction);
  } catch (err) {
    const tag = (interaction?.commandName || interaction?.customId || 'CMD').toString().slice(0, 12).toUpperCase();
    const embed = errorFromCatch(tag, err);
    try { console.error(`[dispatchSlash] ${tag}:`, err); } catch {}
    try {
      if (interaction?.isRepliable?.()) {
        if (interaction.deferred || interaction.replied) {
          return await interaction.followUp({ embeds: [embed], ephemeral: true });
        }
        return await interaction.reply({ embeds: [embed], ephemeral: true });
      }
    } catch {}
  }
}

async function dispatchSlashInner(interaction) {
  // Modal: VM rename
  if (interaction.isModalSubmit() && interaction.customId === 'vm rename modal') {
    const newName = interaction.fields.getTextInputValue('vm rename input');
    const vc = interaction.member?.voice?.channel;
    const vmc = loadVmChannels();
    if (!vc || !vmc[vc.id]) return interaction.reply({ content: "you need to be in your voice channel", ephemeral: true });
    if (vmc[vc.id].ownerId !== interaction.user.id) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
    try {
      await vc.setName(newName);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`✏️ renamed to **${newName}**`)], ephemeral: true });
    } catch (e) { return interaction.reply({ content: `couldn't rename ${e.message}`, ephemeral: true }); }
  }

  // Modal: Open ticket (asks for roblox username)
  if (interaction.isModalSubmit() && interaction.customId === 'ticket open modal') {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const robloxUsername = interaction.fields.getTextInputValue('ticket roblox username').trim();
    const tickets = loadTickets();
    const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id);
    if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open ticket: <#${existing[0]}> `)], ephemeral: true });
    await interaction.deferReply({ ephemeral: true });

    const support = loadTicketSupport();
    const envMgrs = (process.env.WHITELIST_MANAGERS || '').split(',').map(s => s.trim()).filter(Boolean);
    const staffIds = new Set([
      ...loadWlManagers(),
      ...envMgrs,
      ...loadTempOwners(),
      ...loadWhitelist()
    ]);
    staffIds.delete(interaction.user.id);

    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.editReply({ embeds: [errorEmbed('failed').setDescription('i need the **Manage Channels** permission to create tickets')] });
    }
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] }
    ];
    for (const rid of support) {
      if (guild.roles.cache.has(rid)) {
        overwrites.push({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] });
      }
    }
    for (const uid of staffIds) {
      const m = guild.members.cache.get(uid) ?? await guild.members.fetch(uid).catch(() => null);
      if (m) overwrites.push({ id: uid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] });
    }
    let parentId = interaction.channel.parentId || undefined;
    if (parentId) {
      const parent = guild.channels.cache.get(parentId);
      if (!parent || !parent.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageChannels)) parentId = undefined;
    }

    let ch;
    try {
      ch = await guild.channels.create({
        name: `ticket ${robloxUsername || interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ' ').slice(0, 90) || `ticket ${interaction.user.id}`,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: overwrites,
        reason: `ticket opened by ${interaction.user.tag}`
      });
    } catch (err) {
      console.error('ticket create failed:', err);
      const reason = err?.rawError?.message || err?.message || 'unknown error';
      return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(`could not create ticket channel ${reason}\n\nmake sure i have **Manage Channels**, **View Channel**, and **Send Messages** in this server (and in the parent category if any).`)] });
    }

    tickets[ch.id] = { userId: interaction.user.id, openedAt: Date.now(), robloxUsername };
    saveTickets(tickets);

    const supportPing = support.length ? support.map(id => `<@&${id}> `).join(' ') : '';
    const ticketRow1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket verify').setLabel('Verify').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket kick').setLabel('Kick').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ticket claim').setLabel('Claim').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ticket close').setLabel('Close Ticket').setStyle(ButtonStyle.Secondary)
    );
    const ticketRow2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket accept').setLabel('Accept User').setStyle(ButtonStyle.Success)
    );

    const intro = baseEmbed().setColor(0x2C2F33).setTitle('ticket opened')
      .setDescription(`opener: ${interaction.user}\nroblox username: \`${robloxUsername}\`\n\nrunning a group check now staff use the buttons below.`);

    await ch.send({
      content: `${interaction.user} ${supportPing}`.trim(),
      embeds: [intro],
      components: [ticketRow1, ticketRow2],
      allowedMentions: { users: [interaction.user.id], roles: support }
    });

    // auto group check
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) {
        await ch.send({ embeds: [errorEmbed('roblox user not found').setDescription(`could not find a roblox user named **${robloxUsername}**`)] });
      } else {
        const userId = userBasic.id;
        const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)).json()).data ?? [];
        const displayName = userBasic.displayName || userBasic.name;
        const inGroup = groupsData.some(g => String(g.group.id) === getGroupId());
        const groups = groupsData.sort((a, b) => a.group.name.localeCompare(b.group.name));
        const avatarUrl = (await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).json()).data?.[0]?.imageUrl;
        const userGroupIds = new Set(groups.map(g => String(g.group.id)));
        gcCache.set(robloxUsername.toLowerCase(), { displayName, groups, avatarUrl, userGroupIds, inGroup });
        setTimeout(() => gcCache.delete(robloxUsername.toLowerCase()), 10 * 60 * 1000);
        const statusEmbed = inGroup ? buildGcInGroupEmbed(displayName, userGroupIds) : buildGcNotInGroupEmbed(displayName, userGroupIds);
        await ch.send({
          embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), statusEmbed],
          components: groups.length > GC_PER_PAGE ? [buildGcRow(robloxUsername, groups, 0)] : []
        });
      }
    } catch (e) {
      await ch.send({ embeds: [errorEmbed('group check failed').setDescription(`couldn't load groups ${e.message}`)] });
    }

    sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('ticket opened').setDescription(`${interaction.user.tag} opened ${ch} (roblox: \`${robloxUsername}\`)`));
    return interaction.editReply({ embeds: [successEmbed('ticket created').setDescription(`your ticket: ${ch}`)] });
  }

  // /setuptag modal submit: create a locked self tag channel
  if (interaction.isModalSubmit() && interaction.customId === 'tag open modal') {
    const robloxUsername = interaction.fields.getTextInputValue('tag roblox username').trim();
    const tickets = loadTickets();
    const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id && t.kind === 'tag');
    if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open tag ticket: <#${existing[0]}> `)], ephemeral: true });

    const guild = interaction.guild;
    const me = guild ? (guild.members.me ?? await guild.members.fetchMe().catch(() => null)) : null;
    if (!guild || !me || !me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({ embeds: [errorEmbed('failed').setDescription('this command needs to run in a server where i have **Manage Channels**.')], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const support = loadTicketSupport();
    const envMgrs = (process.env.WHITELIST_MANAGERS || '').split(',').map(s => s.trim()).filter(Boolean);
    const staffIds = new Set([...loadWhitelist(), ...loadWlManagers(), ...envMgrs, ...loadTempOwners()]);
    staffIds.delete(interaction.user.id);

    // Locked channel only opener, bot, support roles, and whitelisted users can see/talk.
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] }
    ];
    for (const rid of support) {
      if (guild.roles.cache.has(rid)) overwrites.push({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
    }
    for (const uid of staffIds) {
      const m = guild.members.cache.get(uid) ?? await guild.members.fetch(uid).catch(() => null);
      if (m) overwrites.push({ id: uid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
    }
    let parentId = interaction.channel?.parentId || undefined;
    if (parentId) {
      const parent = guild.channels.cache.get(parentId);
      if (!parent || !parent.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageChannels)) parentId = undefined;
    }

    let ch;
    try {
      ch = await guild.channels.create({
        name: `tag ${robloxUsername || interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ' ').slice(0, 90) || `tag ${interaction.user.id}`,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: overwrites,
        reason: `self tag ticket opened by ${interaction.user.tag}`
      });
    } catch (err) {
      console.error('tag ticket create failed:', err);
      return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(`could not create channel ${err?.rawError?.message || err.message}`)] });
    }

    tickets[ch.id] = { userId: interaction.user.id, openedAt: Date.now(), robloxUsername, kind: 'tag' };
    saveTickets(tickets);

    const robloxLink = `https://www.roblox.com/users/?username=${encodeURIComponent(robloxUsername)}`;
    const panelEmbed = baseEmbed().setColor(0x2C2F33)
      .setTitle('Tag Ticket')
      .setDescription(`tag ticket opened by <@${interaction.user.id}> \n\nclick **Tag** to pick the tag you want a **whitelisted user** will then have to reply \`approve\` or \`deny\` here before it's applied to your roblox account.`)
      .addFields({ name: 'roblox username', value: `[\`${robloxUsername}\`](${robloxLink})`, inline: true })
      .setTimestamp();
    const panelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tag pick:${interaction.user.id}:${encodeURIComponent(robloxUsername)}`).setLabel('Tag').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`tag close:${interaction.user.id}`).setLabel('Close').setStyle(ButtonStyle.Secondary)
    );

    await ch.send({
      content: `${interaction.user}`,
      embeds: [panelEmbed],
      components: [panelRow],
      allowedMentions: { users: [interaction.user.id] }
    });
    sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('tag ticket opened').setDescription(`${interaction.user.tag} opened ${ch} (roblox: \`${robloxUsername}\`)`));
      sendTagLog(guild, { embeds: [baseEmbed().setColor(0x2C2F33).setTitle('tag ticket opened').setDescription(`${interaction.user.tag} opened ${ch} (roblox: \`${robloxUsername}\`)`)] });
    return interaction.editReply({ embeds: [successEmbed('tag ticket created').setDescription(`your tag ticket: ${ch}`)] });
  }

  // tag ticket modal submit: create a real ticket channel
  if (interaction.isModalSubmit() && interaction.customId === 'tagticket open modal') {
    const robloxUsername = interaction.fields.getTextInputValue('tagticket roblox username').trim();
    const tickets = loadTickets();
    const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id && t.kind === 'tagticket');
    if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open tag ticket: <#${existing[0]}> `)], ephemeral: true });

    const guild = interaction.guild;
    const me = guild ? (guild.members.me ?? await guild.members.fetchMe().catch(() => null)) : null;
    const canCreate = !!(guild && me && me.permissions.has(PermissionsBitField.Flags.ManageChannels));

    const robloxLink = `https://www.roblox.com/users/?username=${encodeURIComponent(robloxUsername)}`;
    const panelEmbed = baseEmbed().setColor(0x2C2F33)
      .setTitle('Tag Ticket')
      .setDescription(`tag ticket opened by <@${interaction.user.id}> \n\nstaff: click **Tag** to pick a tag the opener will then have to **approve** or **deny** it in this ticket before it's applied.`)
      .addFields({ name: 'roblox username', value: `[\`${robloxUsername}\`](${robloxLink})`, inline: true })
      .setTimestamp();
    const panelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tagticket tag:${interaction.user.id}:${encodeURIComponent(robloxUsername)}`).setLabel('Tag').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`tagticket close:${interaction.user.id}`).setLabel('Close').setStyle(ButtonStyle.Secondary)
    );

    if (!canCreate) {
      // Fallback for DMs / foreign servers post the panel inline (no real channel possible).
      return interaction.reply({ embeds: [panelEmbed], components: [panelRow] });
    }

    await interaction.deferReply({ ephemeral: true });

    const support = loadTicketSupport();
    const envMgrs = (process.env.WHITELIST_MANAGERS || '').split(',').map(s => s.trim()).filter(Boolean);
    const staffIds = new Set([...loadWlManagers(), ...envMgrs, ...loadTempOwners(), ...loadWhitelist()]);
    staffIds.delete(interaction.user.id);

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] }
    ];
    for (const rid of support) {
      if (guild.roles.cache.has(rid)) overwrites.push({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] });
    }
    for (const uid of staffIds) {
      const m = guild.members.cache.get(uid) ?? await guild.members.fetch(uid).catch(() => null);
      if (m) overwrites.push({ id: uid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] });
    }
    let parentId = interaction.channel?.parentId || undefined;
    if (parentId) {
      const parent = guild.channels.cache.get(parentId);
      if (!parent || !parent.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageChannels)) parentId = undefined;
    }

    let ch;
    try {
      ch = await guild.channels.create({
        name: `tag ${robloxUsername || interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ' ').slice(0, 90) || `tag ${interaction.user.id}`,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: overwrites,
        reason: `tag ticket opened by ${interaction.user.tag}`
      });
    } catch (err) {
      console.error('tagticket create failed:', err);
      return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(`could not create ticket channel ${err?.rawError?.message || err.message}`)] });
    }

    tickets[ch.id] = { userId: interaction.user.id, openedAt: Date.now(), robloxUsername, kind: 'tagticket' };
    saveTickets(tickets);

    const supportPing = support.length ? support.map(id => `<@&${id}> `).join(' ') : '';
    await ch.send({
      content: `${interaction.user} ${supportPing}`.trim(),
      embeds: [panelEmbed],
      components: [panelRow],
      allowedMentions: { users: [interaction.user.id], roles: support }
    });
    sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('tag ticket opened').setDescription(`${interaction.user.tag} opened ${ch} (roblox: \`${robloxUsername}\`)`));
    sendTagLog(guild, { embeds: [baseEmbed().setColor(0x2C2F33).setTitle('tag ticket opened').setDescription(`${interaction.user.tag} opened ${ch} (roblox: \`${robloxUsername}\`)`)] });
    return interaction.editReply({ embeds: [successEmbed('tag ticket created').setDescription(`your tag ticket: ${ch}`)] });
  }

  // Select menus
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
    // .gc / /gc → "flag a group from this list" select
    if (interaction.customId.startsWith('flag gc:')) {
      if (!isWhitelisted(interaction.user.id))
        return interaction.reply({ content: "only whitelisted users can flag groups.", ephemeral: true });
      const picked = interaction.values.map(v => String(v).replace(/\D/g, '')).filter(Boolean);
      if (!picked.length) return interaction.reply({ content: "no group selected.", ephemeral: true });
      const flagged = loadFlaggedGroups();
      const knownIds = new Set(flagged.map(g => String(g.id)));
      const added = [];
      const skipped = [];
      for (const id of picked) {
        if (knownIds.has(id)) { skipped.push(id); continue; }
        let groupName = null;
        try {
          const res = await fetch(`https://groups.roblox.com/v1/groups/${id}`);
          if (res.ok) { const data = await res.json(); groupName = data.name || null; }
        } catch {}
        flagged.push({ id, name: groupName });
        knownIds.add(id);
        added.push({ id, name: groupName });
      }
      saveFlaggedGroups(flagged);
      const lines = [];
      if (added.length) {
        lines.push(`**flagged ${added.length} group${added.length === 1 ? '' : 's'}:**`);
        for (const g of added) {
          const label = g.name
            ? `[${g.name}](https://www.roblox.com/communities/${g.id}/about)`
            : `[Group ${g.id}](https://www.roblox.com/communities/${g.id}/about)`;
          lines.push(`🚩 ${label} \`${g.id}\``);
        }
      }
      if (skipped.length) lines.push(` already flagged: ${skipped.map(id => `\`${id}\``).join(', ')}`);
      return interaction.reply({
        embeds: [baseEmbed().setColor(0x2C2F33).setTitle('🚩 Group Flagged').setDescription(lines.join('\n') || 'nothing changed.').setTimestamp()],
        ephemeral: true
      });
    }

    // /setuptickets panel kind picker → show the right modal
    if (interaction.customId === 'ticket kind select') {
      const kind = interaction.values[0];
      if (kind === 'verification') {
        const tickets = loadTickets();
        const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id && (t.kind === 'ticket' || !t.kind));
        if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open ticket: <#${existing[0]}> `)], ephemeral: true });
        const modal = new ModalBuilder().setCustomId('ticket open modal').setTitle('Open a Ticket')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ticket roblox username')
              .setLabel('Roblox Username')
              .setPlaceholder('Enter your Roblox username...')
              .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
          ));
        return interaction.showModal(modal);
      }
      if (kind === 'tag') {
        const tickets = loadTickets();
        const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id && t.kind === 'tag');
        if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open tag ticket: <#${existing[0]}> `)], ephemeral: true });
        const modal = new ModalBuilder().setCustomId('tag open modal').setTitle('Open a Tag Ticket')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('tag roblox username')
              .setLabel('Roblox Username')
              .setPlaceholder('Enter your Roblox username...')
              .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
          ));
        return interaction.showModal(modal);
      }
      return interaction.reply({ content: 'unknown choice', ephemeral: true });
    }

    // /setuptag self tag select → opener picked their own tag, await whitelist approval
    if (interaction.customId.startsWith('tag select:')) {
      const parts = interaction.customId.split(':');
      const ownerId = parts[1];
      const robloxFromBtn = parts[2] ? decodeURIComponent(parts[2]) : '';
      if (interaction.user.id !== ownerId)
        return interaction.reply({ embeds: [errorEmbed('not your ticket').setDescription('only the ticket opener picks here.')], ephemeral: true });

      const roleId = interaction.values[0];
      const roles = loadRobloxRoles();
      const lookup = Object.values(roles).find(r => String(r.id) === String(roleId));
      if (!lookup)
        return interaction.reply({ embeds: [errorEmbed('unknown tag').setDescription('that tag is no longer registered.')], ephemeral: true });

      const robloxName = robloxFromBtn || (loadVerify()?.verified?.[ownerId]?.robloxName);
      if (!robloxName)
        return interaction.reply({ embeds: [errorEmbed('no roblox username').setDescription('couldn\'t find your roblox username reopen the ticket.')], ephemeral: true });

      await interaction.update({
        content: `tag pending approval a whitelisted user must reply \`approve\` or \`deny\` in this ticket.`,
        components: []
      });

      const envMgrs2 = (process.env.WHITELIST_MANAGERS || '').split(',').map(s => s.trim()).filter(Boolean);
      const approverPool = new Set([...loadWhitelist(), ...loadWlManagers(), ...loadTempOwners(), ...envMgrs2]);
      approverPool.delete(ownerId);
      const isApprover = (uid) => approverPool.has(uid);

      const channel = interaction.channel;
      const promptEmbed = baseEmbed().setColor(0x2C2F33).setTitle('tag pending approval')
        .setDescription(`<@${ownerId}> wants the **${lookup.name}** tag on roblox account **${robloxName}**.\n\na **whitelisted user** (not the opener) must reply \`approve\` or \`deny\` within 5 minutes.`)
        .addFields(
          { name: 'tag', value: `${lookup.name} \`${lookup.id}\``, inline: true },
          { name: 'roblox', value: `\`${robloxName}\``, inline: true },
          { name: 'requested by', value: `<@${ownerId}> `, inline: true }
        ).setTimestamp();
      await channel.send({ embeds: [promptEmbed] });

      try {
        const collected = await channel.awaitMessages({
          filter: m => isApprover(m.author.id) && /^(approve|deny)$/i.test(m.content.trim()),
          max: 1, time: 5 * 60_000, errors: ['time']
        });
        const decisionMsg = collected.first();
        const decision = decisionMsg.content.trim().toLowerCase();
        const approverId = decisionMsg.author.id;
        if (decision === 'deny') {
          await channel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('tag denied').setDescription(`<@${approverId}> denied the **${lookup.name}** tag for <@${ownerId}> .`)] });
          return;
        }
        const pending = await channel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('applying tag').setDescription(`approved ranking **${robloxName}** as **${lookup.name}**…`)] });
        try {
          const result = await rankRobloxUser(robloxName, lookup.id);
          appendTagLog({
            action: 'tag', tag: lookup.name, roblox: result.displayName,
            robloxId: result.userId, giverId: approverId, giverTag: decisionMsg.author.tag,
            targetDiscordId: ownerId, guildId: interaction.guildId
          });
          const e = baseEmbed().setColor(0x2C2F33).setTitle('tag given')
            .setDescription(`tagged **${result.displayName}** as **${lookup.name}** (approved by <@${approverId}> )`)
            .addFields(
              { name: 'discord', value: `<@${ownerId}> `, inline: true },
              { name: 'roblox', value: `[${result.displayName}](https://www.roblox.com/users/${result.userId}/profile)`, inline: true },
              { name: 'tag', value: `${lookup.name} \`${lookup.id}\``, inline: true }
            ).setTimestamp();
          if (result.avatarUrl) e.setThumbnail(result.avatarUrl);
          await pending.edit({ embeds: [e] }).catch(() => channel.send({ embeds: [e] }));
          if (interaction.guild) sendBotLog(interaction.guild, e);
            if (interaction.guild) sendTagLog(interaction.guild, { embeds: [e] });
        } catch (err) {
          await pending.edit({ embeds: [errorEmbed('failed').setDescription(err.message)] }).catch(() => channel.send({ embeds: [errorEmbed('failed').setDescription(err.message)] }));
        }
      } catch {
        await channel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('approval timed out').setDescription('no whitelisted user replied in 5 minutes tag was not applied.')] }).catch(() => {});
      }
      return;
    }

    if (interaction.customId.startsWith('tagticket select:')) {
      const parts = interaction.customId.split(':');
      const ownerId = parts[1];
      const robloxFromBtn = parts[2] ? decodeURIComponent(parts[2]) : '';

      if (interaction.user.id === ownerId)
        return interaction.reply({ embeds: [errorEmbed('not allowed').setDescription('you cannot tag yourself.')], ephemeral: true });

      const allowedDm = !interaction.guild && isWlManager(interaction.user.id);
      const allowedGuild = !!interaction.guild && canUseRole(interaction.member);
      if (!allowedDm && !allowedGuild)
        return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('you no longer have permission to apply tags.')], ephemeral: true });

      const roleId = interaction.values[0];
      const roles = loadRobloxRoles();
      const lookup = Object.values(roles).find(r => String(r.id) === String(roleId));
      if (!lookup)
        return interaction.reply({ embeds: [errorEmbed('unknown tag').setDescription('that tag is no longer registered.')], ephemeral: true });

      // Resolve the target's Roblox username: prefer the one supplied when the
      // ticket was opened; fall back to a registered link if any.
      let robloxName = robloxFromBtn;
      if (!robloxName) {
        const linked = loadVerify()?.verified?.[ownerId];
        if (linked?.robloxName) robloxName = linked.robloxName;
      }
      if (!robloxName)
        return interaction.reply({ embeds: [errorEmbed('no roblox username').setDescription(`<@${ownerId}> didn't supply a Roblox username when opening the ticket.`)], ephemeral: true });

      // Acknowledge the select interaction quickly and then post the approval prompt.
      await interaction.update({
        content: `tag pending approval a different whitelisted user must reply \`approve\` or \`deny\` in this ticket.`,
        components: []
      });

      // Whitelisted approvers = bot whitelist + wl managers + temp owners + env mgrs,
      // EXCLUDING the staff member who picked the tag (so they can't self approve)
      // and the ticket opener.
      const envMgrs2 = (process.env.WHITELIST_MANAGERS || '').split(',').map(s => s.trim()).filter(Boolean);
      const approverPool = new Set([...loadWhitelist(), ...loadWlManagers(), ...loadTempOwners(), ...envMgrs2]);
      approverPool.delete(interaction.user.id);
      approverPool.delete(ownerId);
      const isApprover = (uid) => approverPool.has(uid);

      const channel = interaction.channel;
      const promptEmbed = baseEmbed().setColor(0x2C2F33).setTitle('tag pending approval')
        .setDescription(`**${interaction.user.tag}** wants to tag <@${ownerId}> as **${lookup.name}** on roblox account **${robloxName}**.\n\na **whitelisted user** (other than the requester or the opener) must reply \`approve\` or \`deny\` within 5 minutes.`)
        .addFields(
          { name: 'tag', value: `${lookup.name} \`${lookup.id}\``, inline: true },
          { name: 'roblox', value: `\`${robloxName}\``, inline: true },
          { name: 'requested by', value: `<@${interaction.user.id}> `, inline: true }
        ).setTimestamp();
      const promptMsg = await channel.send({ embeds: [promptEmbed] });

      try {
        const collected = await channel.awaitMessages({
          filter: m => isApprover(m.author.id) && /^(approve|deny)$/i.test(m.content.trim()),
          max: 1, time: 5 * 60_000, errors: ['time']
        });
        const decisionMsg = collected.first();
        const decision = decisionMsg.content.trim().toLowerCase();
        const approverId = decisionMsg.author.id;
        if (decision === 'deny') {
          await channel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('tag denied').setDescription(`<@${approverId}> denied the **${lookup.name}** tag for <@${ownerId}> .`)] });
          return;
        }
        // Approved apply the tag.
        const pending = await channel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('applying tag').setDescription(`approved ranking **${robloxName}** as **${lookup.name}**…`)] });
        try {
          const result = await rankRobloxUser(robloxName, lookup.id);
          appendTagLog({
            action: 'tagticket', tag: lookup.name, roblox: result.displayName,
            robloxId: result.userId, giverId: interaction.user.id, giverTag: interaction.user.tag,
            targetDiscordId: ownerId, guildId: interaction.guildId
          });
          const e = baseEmbed().setColor(0x2C2F33).setTitle('tag given')
            .setDescription(`tagged **${result.displayName}** as **${lookup.name}** (approved by <@${approverId}> )`)
            .addFields(
              { name: 'discord', value: `<@${ownerId}> `, inline: true },
              { name: 'roblox', value: `[${result.displayName}](https://www.roblox.com/users/${result.userId}/profile)`, inline: true },
              { name: 'tag', value: `${lookup.name} \`${lookup.id}\``, inline: true },
              { name: 'given by', value: `${interaction.user.tag} (<@${interaction.user.id}> )`, inline: false }
            ).setTimestamp();
          if (result.avatarUrl) e.setThumbnail(result.avatarUrl);
          await pending.edit({ embeds: [e] }).catch(() => channel.send({ embeds: [e] }));
          if (interaction.guild) sendBotLog(interaction.guild, e);
          if (interaction.guild) sendTagLog(interaction.guild, { embeds: [e] });
        } catch (err) {
          await pending.edit({ embeds: [errorEmbed('failed').setDescription(err.message)] }).catch(() => channel.send({ embeds: [errorEmbed('failed').setDescription(err.message)] }));
        }
      } catch {
        await channel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('approval timed out').setDescription(`no reply from <@${ownerId}> in 60s tag was not applied.`)] }).catch(() => {});
      }
      return;
    }
  }

  // Buttons
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('help ')) {
      const page = parseInt(interaction.customId.split(' ')[1]);
      return interaction.update({ embeds: [buildHelpEmbed(page)], components: [buildHelpRow(page)] });
    }

    // .lb pagination — < / > buttons. customId = `lb <page> <ownerId>`
    if (interaction.customId.startsWith('lb ')) {
      const parts = interaction.customId.split(' ');
      const page = parseInt(parts[1], 10);
      const ownerId = parts[2];
      if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: 'only the person who ran `.lb` can flip pages', ephemeral: true });
      }
      const stats = loadRaidStats()[interaction.guild?.id] || {};
      const verify = loadVerify();
      const rows = Object.entries(stats)
        .map(([discordId, s]) => ({ discordId, count: s?.totalRaids || 0 }))
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count);
      const PER_PAGE = 10;
      const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
      const safePage = Math.max(0, Math.min(page, totalPages - 1));
      const start = safePage * PER_PAGE;
      const slice = rows.slice(start, start + PER_PAGE);
      const medals = ['🥇', '🥈', '🥉'];
      const lines = await Promise.all(slice.map(async (r, i) => {
        const overall = start + i;
        const v = verify.verified?.[r.discordId];
        let discordName = null;
        try {
          const u = interaction.client.users.cache.get(r.discordId) || await interaction.client.users.fetch(r.discordId).catch(() => null);
          if (u) discordName = u.username;
        } catch {}
        const discordLink = `[${discordName || `user-${r.discordId.slice(-4)}`}](https://discord.com/users/${r.discordId})`;
        const robloxLink = v
          ? `[${v.robloxName}](https://www.roblox.com/users/${v.robloxId}/profile)`
          : '`not registered`';
        const rank = overall < 3 ? medals[overall] : `**#${overall + 1}**`;
        return `${rank} ${discordLink} • Roblox: ${robloxLink} — **${r.count}** raid${r.count !== 1 ? 's' : ''}`;
      }));
      const lbEmbed = baseEmbed().setColor(0x2C2F33)
        .setTitle('Raid Leaderboard')
        .setDescription(lines.join('\n') || 'no entries')
        .setFooter({ text: `page ${safePage + 1}/${totalPages} • ${rows.length} member${rows.length !== 1 ? 's' : ''} • counted from rollcall logs • ${getBotName()}`, iconURL: getLogoUrl() })
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`lb ${safePage - 1} ${ownerId}`).setLabel('<').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
        new ButtonBuilder().setCustomId(`lb ${safePage + 1} ${ownerId}`).setLabel('>').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages - 1)
      );
      return interaction.update({ embeds: [lbEmbed], components: totalPages > 1 ? [row] : [] });
    }

    // tagticket: Tag button → ephemeral select menu of all registered tags
    if (interaction.customId.startsWith('tagticket tag:')) {
      const parts = interaction.customId.split(':');
      const ownerId = parts[1];
      const robloxFromBtn = parts[2] ? decodeURIComponent(parts[2]) : '';
      // anyone except the opener can pick a tag the opener must approve it later
      if (interaction.user.id === ownerId)
        return interaction.reply({ embeds: [errorEmbed('not allowed').setDescription('you cannot tag yourself wait for someone else to pick a tag for you.')], ephemeral: true });

      // permission: in DMs only WL managers; in guilds anyone with role perms
      const allowedDm = !interaction.guild && isWlManager(interaction.user.id);
      const allowedGuild = !!interaction.guild && canUseRole(interaction.member);
      if (!allowedDm && !allowedGuild)
        return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only staff (whitelist managers or members allowed via `/setroleperms`) can apply tags.')], ephemeral: true });

      const roles = loadRobloxRoles();
      const entries = Object.values(roles).filter(r => r && r.id);
      if (!entries.length)
        return interaction.reply({ embeds: [errorEmbed('no tags').setDescription('no roblox group roles are registered. a wl manager must add some with `/setrole name:<name id:<id `.')], ephemeral: true });

      // Discord limits select menus to 25 options
      const options = entries.slice(0, 25).map(r => ({
        label: String(r.name).slice(0, 100),
        value: String(r.id),
        description: `roblox role id ${r.id}`.slice(0, 100)
      }));

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`tagticket select:${ownerId}:${encodeURIComponent(robloxFromBtn)}`)
        .setPlaceholder('pick a tag to give')
        .addOptions(options);

      return interaction.reply({
        content: `pick the tag to give to <@${ownerId}> :`,
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
      });
    }

    if (interaction.customId.startsWith('tagticket close:')) {
      const ownerId = interaction.customId.split(':')[1];
      const allowedDm = !interaction.guild && (isWlManager(interaction.user.id) || interaction.user.id === ownerId);
      const allowedGuild = !!interaction.guild && (canUseRole(interaction.member) || interaction.user.id === ownerId);
      if (!allowedDm && !allowedGuild)
        return interaction.reply({ content: 'only the ticket owner or staff can close this', ephemeral: true });

      // If this is a real ticket channel, delete it like /closeticket does.
      const tickets = loadTickets();
      const t = interaction.channel ? tickets[interaction.channel.id] : null;
      if (t && t.kind === 'tagticket' && interaction.guild) {
        await interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('closing tag ticket').setDescription(`closed by <@${interaction.user.id}> channel will be deleted in 3s`)] });
        delete tickets[interaction.channel.id]; saveTickets(tickets);
        sendBotLog(interaction.guild, baseEmbed().setColor(0x2C2F33).setTitle('tag ticket closed').setDescription(`<#${interaction.channel.id}> (${interaction.channel.name}) closed by ${interaction.user.tag}`));
          sendTagLog(interaction.guild, { embeds: [baseEmbed().setColor(0x2C2F33).setTitle('tag ticket closed').setDescription(`<#${interaction.channel.id}> (${interaction.channel.name}) closed by ${interaction.user.tag}`)] });
        setTimeout(() => { interaction.channel.delete(`tag ticket closed by ${interaction.user.tag}`).catch(() => {}); }, 3000);
        return;
      }

      // Inline / DM panel: just edit the message.
      try {
        await interaction.update({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Tag Ticket Closed').setDescription(`closed by <@${interaction.user.id}> `)], components: [] });
      } catch {
        return interaction.reply({ content: 'closed', ephemeral: true });
      }
      return;
    }

    // /setuptag panel: open a self tag ticket (shows roblox username modal)
    if (interaction.customId === 'tag open') {
      const tickets = loadTickets();
      const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id && t.kind === 'tag');
      if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open tag ticket: <#${existing[0]}> `)], ephemeral: true });
      const modal = new ModalBuilder().setCustomId('tag open modal').setTitle('Open a Tag Ticket')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('tag roblox username')
            .setLabel('Roblox Username')
            .setPlaceholder('Enter your Roblox username...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20)
        ));
      return interaction.showModal(modal);
    }

    // /setuptag: Tag button → ephemeral select menu (opener picks own tag)
    if (interaction.customId.startsWith('tag pick:')) {
      const parts = interaction.customId.split(':');
      const ownerId = parts[1];
      const robloxFromBtn = parts[2] ? decodeURIComponent(parts[2]) : '';
      // Only the opener may pick (this is a self tag flow).
      if (interaction.user.id !== ownerId)
        return interaction.reply({ embeds: [errorEmbed('not your ticket').setDescription('only the ticket opener can pick a tag here.')], ephemeral: true });

      const roles = loadRobloxRoles();
      const entries = Object.values(roles).filter(r => r && r.id);
      if (!entries.length)
        return interaction.reply({ embeds: [errorEmbed('no tags').setDescription('no roblox group roles are registered. a wl manager must add some with `/setrole name:<name id:<id `.')], ephemeral: true });

      const options = entries.slice(0, 25).map(r => ({
        label: String(r.name).slice(0, 100),
        value: String(r.id),
        description: `roblox role id ${r.id}`.slice(0, 100)
      }));

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`tag select:${ownerId}:${encodeURIComponent(robloxFromBtn)}`)
        .setPlaceholder('pick the tag you want')
        .addOptions(options);

      return interaction.reply({
        content: 'pick the tag you want a whitelisted user will then have to approve it:',
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
      });
    }

    // /setuptag: Close button closes the self tag ticket channel
    if (interaction.customId.startsWith('tag close:')) {
      const ownerId = interaction.customId.split(':')[1];
      const allowedDm = !interaction.guild && (isWlManager(interaction.user.id) || interaction.user.id === ownerId);
      const allowedGuild = !!interaction.guild && (canUseRole(interaction.member) || interaction.user.id === ownerId);
      if (!allowedDm && !allowedGuild)
        return interaction.reply({ content: 'only the ticket owner or staff can close this', ephemeral: true });

      const tickets = loadTickets();
      const t = interaction.channel ? tickets[interaction.channel.id] : null;
      if (t && t.kind === 'tag' && interaction.guild) {
        await interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('closing tag ticket').setDescription(`closed by <@${interaction.user.id}> channel will be deleted in 3s`)] });
        delete tickets[interaction.channel.id]; saveTickets(tickets);
        sendBotLog(interaction.guild, baseEmbed().setColor(0x2C2F33).setTitle('tag ticket closed').setDescription(`<#${interaction.channel.id}> (${interaction.channel.name}) closed by ${interaction.user.tag}`));
        sendTagLog(interaction.guild, { embeds: [baseEmbed().setColor(0x2C2F33).setTitle('tag ticket closed').setDescription(`<#${interaction.channel.id}> (${interaction.channel.name}) closed by ${interaction.user.tag}`)] });
        setTimeout(() => { interaction.channel.delete(`tag ticket closed by ${interaction.user.tag}`).catch(() => {}); }, 3000);
        return;
      }
      try {
        await interaction.update({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Tag Ticket Closed').setDescription(`closed by <@${interaction.user.id}> `)], components: [] });
      } catch {
        return interaction.reply({ content: 'closed', ephemeral: true });
      }
      return;
    }

    // tag ticket panel: open a tag ticket (shows roblox username modal)
    if (interaction.customId === 'tagticket open') {
      const tickets = loadTickets();
      const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id && t.kind === 'tagticket');
      if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open tag ticket: <#${existing[0]}> `)], ephemeral: true });
      const modal = new ModalBuilder().setCustomId('tagticket open modal').setTitle('Open a Tag Ticket')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('tagticket roblox username')
            .setLabel('Roblox Username')
            .setPlaceholder('Enter your Roblox username...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20)
        ));
      return interaction.showModal(modal);
    }

    // ticket panel: open a ticket (shows roblox username modal)
    if (interaction.customId === 'ticket open') {
      if (!interaction.guild) return interaction.reply({ content: 'server only', ephemeral: true });
      const tickets = loadTickets();
      const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id);
      if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open ticket: <#${existing[0]}> `)], ephemeral: true });
      const modal = new ModalBuilder().setCustomId('ticket open modal').setTitle('Open a Ticket')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ticket roblox username')
            .setLabel('Roblox Username')
            .setPlaceholder('Enter your Roblox username...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20)
        ));
      return interaction.showModal(modal);
    }

    // ticket: staff buttons (verify / kick / claim / accept)
    if (interaction.customId === 'ticket verify' || interaction.customId === 'ticket kick' ||
        interaction.customId === 'ticket claim'  || interaction.customId === 'ticket accept') {
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
      const tickets = loadTickets();
      const t = tickets[interaction.channel.id];
      if (!t) return interaction.reply({ embeds: [errorEmbed('not a ticket').setDescription('this isn\'t a ticket channel')], ephemeral: true });
      const support = loadTicketSupport();
      const isStaff = isWlManager(interaction.user.id) || isTempOwner(interaction.user.id) ||
        interaction.member.roles.cache.some(r => support.includes(r.id));
      if (!isStaff) return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only support roles, whitelist managers, or temp owners can use this button')], ephemeral: true });

      // claim
      if (interaction.customId === 'ticket claim') {
        if (t.claimedBy) return interaction.reply({ embeds: [errorEmbed('already claimed').setDescription(`this ticket is already claimed by <@${t.claimedBy}> `)], ephemeral: true });
        t.claimedBy = interaction.user.id;
        tickets[interaction.channel.id] = t;
        saveTickets(tickets);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('ticket claimed').setDescription(`${interaction.user} has claimed this ticket`)] });
      }

      // kick
      if (interaction.customId === 'ticket kick') {
        const member = await guild.members.fetch(t.userId).catch(() => null);
        if (!member) return interaction.reply({ embeds: [errorEmbed('failed').setDescription('the ticket opener is no longer in this server')], ephemeral: true });
        if (!member.kickable) return interaction.reply({ embeds: [errorEmbed('failed').setDescription('i can\'t kick this user check my role position and permissions')], ephemeral: true });
        try {
          await member.kick(`ticket kick by ${interaction.user.tag}`);
          return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('user kicked').setDescription(`${member.user.tag} was kicked by ${interaction.user}`)] });
        } catch (e) {
          return interaction.reply({ embeds: [errorEmbed('failed').setDescription(`couldn't kick ${e.message}`)], ephemeral: true });
        }
      }

      // accept user (accept their roblox group join request)
      if (interaction.customId === 'ticket accept') {
        const username = t.robloxUsername;
        if (!username) return interaction.reply({ embeds: [errorEmbed('no username').setDescription('no roblox username is attached to this ticket')], ephemeral: true });
        await interaction.deferReply();
        try {
          const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
          if (!userBasic) return interaction.editReply({ embeds: [errorEmbed('not found').setDescription(`could not find a roblox user named **${username}**`)] });
          await acceptRobloxJoinRequest(userBasic.id, getGroupId());
          // optionally also give the verify role if one is configured
          let roleNote = '';
          const vcfg = loadVerifyConfig();
          if (vcfg.roleId) {
            const role = guild.roles.cache.get(vcfg.roleId);
            const member = await guild.members.fetch(t.userId).catch(() => null);
            if (role && member) {
              try { await member.roles.add(role, `ticket accept by ${interaction.user.tag}`); roleNote = `\n\nalso gave ${member} the ${role} role.`; }
              catch (e) { roleNote = `\n\n(could not add verify role ${e.message})`; }
            }
          }
          return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('accepted into group').setDescription(`accepted **${userBasic.name}** into the roblox group \`${getGroupId()}\`.${roleNote}`)] });
        } catch (e) {
          return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(`couldn't accept user ${e.message}`)] });
        }
      }

      // verify (link Discord ↔ Roblox in this server)
      if (interaction.customId === 'ticket verify') {
        const username = t.robloxUsername;
        if (!username) return interaction.reply({ embeds: [errorEmbed('no username').setDescription('no roblox username is attached to this ticket')], ephemeral: true });
        await interaction.deferReply();
        try {
          const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
          if (!userBasic) return interaction.editReply({ embeds: [errorEmbed('not found').setDescription(`could not find a roblox user named **${username}**`)] });

          const discordId = t.userId;
          const vData = loadVerify();
          if (!vData.verified) vData.verified = {};
          if (!vData.robloxToDiscord) vData.robloxToDiscord = {};

          const existingDiscordId = vData.robloxToDiscord[String(userBasic.id)];
          if (existingDiscordId && existingDiscordId !== discordId) {
            return interaction.editReply({ embeds: [errorEmbed('already linked').setDescription(`\`${userBasic.name}\` is already registered to <@${existingDiscordId}> `)] });
          }
          const prevEntry = vData.verified[discordId];
          if (prevEntry && String(prevEntry.robloxId) !== String(userBasic.id)) {
            delete vData.robloxToDiscord[String(prevEntry.robloxId)];
          }
          vData.verified[discordId] = { robloxId: userBasic.id, robloxName: userBasic.name, verifiedAt: Date.now() };
          vData.robloxToDiscord[String(userBasic.id)] = discordId;
          saveVerify(vData);
          saveLinkedVerified(vData);

          // also try to apply the verify role if one is configured
          let roleNote = '';
          const vcfg = loadVerifyConfig();
          if (vcfg.roleId) {
            const role = guild.roles.cache.get(vcfg.roleId);
            const member = await guild.members.fetch(discordId).catch(() => null);
            if (role && member) {
              try { await member.roles.add(role, `ticket verify by ${interaction.user.tag}`); roleNote = `\nalso gave them the ${role} role.`; }
              catch {}
            }
          }

          const avatarUrl = (await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userBasic.id}&size=420x420&format=Png&isCircular=false`)).json()).data?.[0]?.imageUrl ?? null;
          const embed = baseEmbed().setColor(0x2C2F33).setTitle('user verified')
            .setDescription(`<@${discordId}> is now linked to roblox user **${userBasic.name}** (\`${userBasic.id}\`).${roleNote}`);
          if (avatarUrl) embed.setThumbnail(avatarUrl);
          return interaction.editReply({ embeds: [embed] });
        } catch (e) {
          return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(`couldn't verify ${e.message}`)] });
        }
      }
    }

    if (interaction.customId === 'ticket close') {
      const guild = interaction.guild;
      const tickets = loadTickets();
      const t = tickets[interaction.channel.id];
      if (!t) return interaction.reply({ embeds: [errorEmbed('not a ticket').setDescription('this isn\'t a ticket channel')], ephemeral: true });
      const support = loadTicketSupport();
      const allowed = isWlManager(interaction.user.id) || interaction.member.roles.cache.some(r => support.includes(r.id)) || t.userId === interaction.user.id;
      if (!allowed) return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only the ticket opener, support roles, or wl managers can close this')], ephemeral: true });
      await interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('closing this ticket in 5s...')] });
      delete tickets[interaction.channel.id]; saveTickets(tickets);
      setTimeout(async () => { try { await interaction.channel.delete('ticket closed'); } catch {} }, 5000);
      sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('ticket closed').setDescription(`<#${interaction.channel.id}> (${interaction.channel.name}) closed by ${interaction.user.tag}`));
      return;
    }

    if (interaction.customId === 'striptag confirm' || interaction.customId === 'striptag cancel') {
      const pending = striptagPending.get(interaction.user.id);
      if (!pending) return interaction.update({ content: 'this has expired, run the command again', embeds: [], components: [] });
      striptagPending.delete(interaction.user.id);
      if (interaction.customId === 'striptag cancel') {
        return interaction.update({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('striptag cancelled').setDescription(`cancelled stripping tag **${pending.tagName}**`)], components: [] });
      }
      // confirmed execute the strip
      await interaction.update({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`stripping **${pending.members.length}** user${pending.members.length !== 1 ? 's' : ''} from tag **${pending.tagName}**...`)], components: [] });
      const succeeded = [];
      const failed = [];
      for (const robloxUsername of pending.members) {
        try {
          const result = await rankRobloxUser(robloxUsername, pending.rank2RoleId);
          succeeded.push(result.displayName);
        } catch (err) {
          failed.push(`${robloxUsername} ${err.message}`);
        }
      }
      const taggedMembers = loadTaggedMembers();
      delete taggedMembers[pending.tagName];
      saveTaggedMembers(taggedMembers);
      const desc = [];
      if (succeeded.length) desc.push(`**stripped (${succeeded.length}):** ${succeeded.join(', ')}`);
      if (failed.length) desc.push(`**failed (${failed.length}):**\n${failed.join('\n')}`);
      const resultEmbed = baseEmbed().setColor(succeeded.length ? 0x2C2F33 : 0x2C2F33).setTitle(`striptag ${pending.tagName}`)
        .setDescription(desc.join('\n\n') || 'done').setTimestamp();
      await interaction.editReply({ embeds: [resultEmbed], components: [] });
      const logEmbed = baseEmbed().setTitle('striptag log').setColor(0x2C2F33)
        .addFields(
          { name: 'tag', value: pending.tagName, inline: true },
          { name: 'stripped by', value: `<@${interaction.user.id}> `, inline: true },
          { name: `stripped (${succeeded.length})`, value: succeeded.join(', ') || 'none' },
          ...(failed.length ? [{ name: `failed (${failed.length})`, value: failed.join('\n') }] : [])
        ).setTimestamp();
      if (interaction.guild) await sendStripLog(interaction.guild, logEmbed);
      return;
    }

    if (interaction.customId === 'selfAttend') {
      if (!interaction.guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
      const userId = interaction.user.id;
      const guildId = interaction.guild.id;
      const vData = loadVerify();
      const userVerify = vData.verified?.[userId];
      if (!userVerify) return interaction.reply({ content: "you haven't verified your Roblox account yet use `/verify` first", ephemeral: true });
      const qData = loadQueue();
      const session = qData[guildId]?.selfAttendSession;
      if (session?.logged?.includes(userId)) return interaction.reply({ content: 'you already logged your attendance for this session', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const inGroup = await isUserInGroup(userVerify.robloxId, ATTEND_GROUP_ID);
      if (!inGroup) return interaction.editReply({ content: 'you need to be in the group to log attendance' });
      let avatarUrl = null;
      try {
        const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userVerify.robloxId}&size=420x420&format=Png&isCircular=false`)).json();
        avatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
      } catch {}
      const attendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
        .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
        .addFields({ name: 'Discord', value: `<@${userId}> `, inline: false }, { name: 'Roblox', value: `\`${userVerify.robloxName}\``, inline: false })
        .setTimestamp().setFooter({ text: `self reported • ${getBotName()}`, iconURL: getLogoUrl() });
      if (avatarUrl) attendEmbed.setThumbnail(avatarUrl);
      const queueChannelId = qData[guildId]?.channelId;
      const queueChannel = queueChannelId ? interaction.guild.channels.cache.get(queueChannelId) : null;
      if (queueChannel) { await queueChannel.send({ embeds: [attendEmbed] }); addRaidStat(guildId, userId); }
      if (!qData[guildId]) qData[guildId] = {};
      if (!qData[guildId].selfAttendSession) qData[guildId].selfAttendSession = { logged: [] };
      qData[guildId].selfAttendSession.logged.push(userId);
      saveQueue(qData);
      return interaction.editReply({ content: queueChannel ? `✅ attendance logged to ${queueChannel}` : '✅ attendance logged' });
    }

    if (interaction.customId === 'ac checkin') {
      if (!interaction.guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
      const checks = loadActivityCheck();
      const guildCheck = checks[interaction.guild.id];
      if (!guildCheck?.active) return interaction.reply({ content: "there's no active activity check right now", ephemeral: true });
      if (guildCheck.checkins.includes(interaction.user.id)) {
        return interaction.reply({ content: "you already checked in!", ephemeral: true });
      }
      guildCheck.checkins.push(interaction.user.id);
      saveActivityCheck(checks);
      try { await interaction.user.send('Thanks for reacting to the activity check I love youuuu!❤️😘'); } catch {}
      return interaction.reply({ content: "reacted.", ephemeral: true });
    }
    if (interaction.customId.startsWith('gc ')) {
      const parts = interaction.customId.split(' ');
      const page = parseInt(parts[1]);
      const username = parts.slice(2).join(' ');
      const cached = gcCache.get(username.toLowerCase());
      if (!cached) return interaction.reply({ content: 'that expired, run it again', ephemeral: true });
      const embeds = [buildGcEmbed(cached.displayName, cached.groups, cached.avatarUrl, page)];
      if (cached.userGroupIds) {
        embeds.push(cached.inGroup
          ? buildGcInGroupEmbed(cached.displayName, cached.userGroupIds)
          : buildGcNotInGroupEmbed(cached.displayName, cached.userGroupIds));
      }
      return interaction.update({
        embeds,
        components: cached.groups.length > GC_PER_PAGE ? [buildGcRow(username, cached.groups, page)] : []
      });
    }
    if (interaction.customId.startsWith('vm ')) {
      const vmChannels = loadVmChannels();
      const vc = interaction.member?.voice?.channel;
      if (!vc) return interaction.reply({ content: "you need to be in a voice channel", ephemeral: true });
      const chData = vmChannels[vc.id];
      if (!chData) return interaction.reply({ content: "that's not a voicemaster channel", ephemeral: true });
      const isOwner = chData.ownerId === interaction.user.id;
      const everyone = interaction.guild.roles.everyone;

      if (interaction.customId === 'vm lock') {
        if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
        await vc.permissionOverwrites.edit(everyone, { Connect: false });
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('🔒 channel locked')], ephemeral: true });
      }
      if (interaction.customId === 'vm unlock') {
        if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
        await vc.permissionOverwrites.edit(everyone, { Connect: null });
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('🔓 channel unlocked')], ephemeral: true });
      }
      if (interaction.customId === 'vm ghost') {
        if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: false });
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('👻 channel hidden')], ephemeral: true });
      }
      if (interaction.customId === 'vm reveal') {
        if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: null });
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('👁️ channel visible')], ephemeral: true });
      }
      if (interaction.customId === 'vm claim') {
        if (vc.members.has(chData.ownerId)) return interaction.reply({ content: "the owner is still in the channel", ephemeral: true });
        chData.ownerId = interaction.user.id;
        vmChannels[vc.id] = chData;
        saveVmChannels(vmChannels);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`👑 you now own **${vc.name}**`)], ephemeral: true });
      }
      if (interaction.customId === 'vm info') {
        const limit = vc.userLimit === 0 ? 'no limit' : vc.userLimit;
        const owner = await interaction.guild.members.fetch(chData.ownerId).catch(() => null);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('📋 channel info')
          .addFields({ name: 'name', value: vc.name, inline: true }, { name: 'owner', value: owner?.displayName ?? 'unknown', inline: true },
            { name: 'members', value: `${vc.members.size}`, inline: true }, { name: 'limit', value: `${limit}`, inline: true })
        ], ephemeral: true });
      }
      if (interaction.customId === 'vm limit up') {
        if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
        const newLimit = Math.min((vc.userLimit || 0) + 1, 99);
        await vc.setUserLimit(newLimit);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`➕ limit set to **${newLimit}**`)], ephemeral: true });
      }
      if (interaction.customId === 'vm limit down') {
        if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
        const newLimit = Math.max((vc.userLimit || 1) - 1, 0);
        await vc.setUserLimit(newLimit);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`➖ limit set to **${newLimit === 0 ? 'no limit' : newLimit}**`)], ephemeral: true });
      }
      if (interaction.customId === 'vm rename') {
        if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
        const modal = new ModalBuilder().setCustomId('vm rename modal').setTitle('Rename Channel')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('vm rename input').setLabel('New name').setStyle(TextInputStyle.Short).setRequired(true)
          ));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'vm delete') {
        if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
        try { await vc.delete(); delete vmChannels[vc.id]; saveVmChannels(vmChannels); } catch (e) { return interaction.reply({ content: `couldn't delete ${e.message}`, ephemeral: true }); }
        return;
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const commandName = interaction.commandName;
  const guild = interaction.guild;
  const channel = interaction.channel;

  // Open to everyone commands
  if (commandName === 'generate') {
    const option  = interaction.options.getString('option')
    const showPublic = interaction.options.getBoolean('show') ?? false
    await interaction.deferReply({ ephemeral: !showPublic })

    // first half of the mashup username
    const partsA = [
      'larp','grief','lung','ion','your','flex','cut','ghost','void','blur','drain','snap','melt','fade','numb','null','bleed','vibe','haze','glitch','flop','cope','soak','crave','drift','grind','lurk','burn','skim','zap','deflex','social','color','archive','scatter','hollow','shatter','fracture','spiral','unravel','detach','absorb','suppress','linger','exhaust','dissolve','consume','distort','collapse','isolate',
      'lean','chug','chugging','blunt','smoke','cosplay','cosplaying','burnt','plug','rack','trap','phase','trace','swipe','scroll','sip','catch','chase','freeze','switch','pivot','loop','spin','twist','crack','pop','slide','coast','rush','peak','dip','fold','press','drag','grip','tap','slam','crash','smash','rip','slice','trim','clip','snip','roll','drop','flip','lurking','fading','bleeding','drifting','burning','grinding','coping','craving','soaking','melting','snapping','draining','blurring','zapping','vibing','hazing','glitching','flopping','snatching','trapping','chasing','catching','smoking','rolling','plugging'
    ]
    // second half of the mashup username
    const partsB = [
      'this','that','funds','off','lame','hurt','romance','ized','izing','wave','core','less','shift','drop','lock','mode','cast','link','fix','run','hit','zone','edge','cap','slip','miss','type','mark','form','load','flow','path','line','log','port','ed','ing','ness','ward','scape','fall','cycle','loop','gate','sink','crush','void','storm','drift',
      'lean','sipper','blunt','catcher','playing','chugging','smoking','rolling','trapping','zoning','sliding','coasting','rushing','peaking','dipping','folding','pressing','dragging','gripping','tapping','slamming','crashing','smashing','grinding','lurking','fading','bleeding','drifting','burning','coping','craving','soaking','melting','snapping','draining','blurring','zapping','vibing','hazing','glitching','flopping','snatching','chasing','catching','plugging','flipping','racking','switching','pivoting','spinning','twisting','cracking','popping','griefs','blunts','smokes','rolls','flips','racks','traps','phases','traces','swipes','scrolls','sips'
    ]

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }
    function randNum(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }

    function genWords(platform) {
      const a = pick(partsA)
      const b = pick(partsB)
      if (platform === 'discord') {
        return `${a}${b}`.slice(0, 32)
      } else {
        return `${cap(a)}${cap(b)}`.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20)
      }
    }

    function genBarcode() {
      const chars = ['l', 'I']
      const len   = randNum(10, 16)
      let result  = ''
      while (result.length < len) result += pick(chars)
      return result
    }

    async function isRobloxAvailable(username) {
      try {
        const res = await fetch(`https://auth.roblox.com/v1/usernames/validate?request.username=${encodeURIComponent(username)}&request.birthday=2000-01-01&request.context=Username`)
        const data = await res.json()
        return data.code === 0
      } catch { return false }
    }

    const [platform, type] = option.split(' ')
    const count = 8
    const maxAttempts = 80
    const usernames = []
    const seen = new Set()
    let attempts = 0

    if (platform === 'roblox') {
      while (usernames.length < count && attempts < maxAttempts) {
        attempts++
        const candidate = type === 'words' ? genWords(platform) : genBarcode()
        if (seen.has(candidate)) continue
        seen.add(candidate)
        const available = await isRobloxAvailable(candidate)
        if (available) usernames.push(candidate)
      }
    } else {
      while (usernames.length < count && attempts < maxAttempts) {
        attempts++
        const candidate = genWords(platform)
        if (seen.has(candidate)) continue
        seen.add(candidate)
        usernames.push(candidate)
      }
    }

    const platformLabel = platform === 'discord' ? 'Discord' : 'Roblox'
    const typeLabel     = type === 'words' ? 'Words' : 'Barcode'
    const footerText    = platform === 'roblox'
      ? `${usernames.length} available usernames found (checked ${attempts} candidates)`
      : `${count} usernames generated`

    const e = baseEmbed()
      .setColor(0x2C2F33)
      .setTitle(`${platformLabel} Usernames ${typeLabel}`)
      .setDescription(usernames.length > 0 ? usernames.map(u => `\`${u}\``).join('\n') : 'No available usernames found after checking try again.')
      .setFooter({ text: footerText, iconURL: getLogoUrl() })

    return interaction.editReply({ embeds: [e] })
  }

  if (commandName === 'roblox') {
    await interaction.deferReply();
    const username = interaction.options.getString('username');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return interaction.editReply("could not find that user");
      const userId = userBasic.id;
      const [user, avatarRes, friendsRes, pastNamesRes, groupsRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${userId}`).then(r => r.json()),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`).then(r => r.json()),
        fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then(r => r.json()).catch(() => ({ count: 'n/a' })),
        fetch(`https://users.roblox.com/v1/users/${userId}/username-history?limit=10&sortOrder=Asc`).then(r => r.json()).catch(() => ({ data: [] })),
        fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      const avatarUrl  = avatarRes.data?.[0]?.imageUrl;
      const profileUrl = `https://www.roblox.com/users/${userId}/profile`;
      const created    = new Date(user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const friends    = friendsRes.count ?? 'n/a';
      const pastNames  = (pastNamesRes.data ?? []).map(u => u.name);
      const groupsRaw  = (groupsRes.data ?? []);
      const status     = user.description?.trim() || '';
      const embed = baseEmbed()
        .setTitle(`${user.displayName} (@${user.name})`)
        .setURL(profileUrl)
        .setColor(0x2C2F33)
        .setDescription(status.slice(0, 4096) || null)
        .setThumbnail(avatarUrl)
        .addFields(
          { name: 'User ID',  value: `\`${userId}\``, inline: true },
          { name: 'Created',  value: created,          inline: true },
          { name: 'Friends',  value: `${friends}`,     inline: true },
        );
      if (pastNames.length) embed.addFields({ name: `Past Usernames (${pastNames.length})`, value: pastNames.map(n => `\`${n}\``).join(', '), inline: false });
      if (groupsRaw.length) embed.addFields({ name: `Groups (${groupsRaw.length})`, value: groupsRaw.slice(0, 10).map(g => `[${g.group.name}](https://www.roblox.com/communities/${g.group.id}/about)`).join('\n'), inline: false });
      embed.setTimestamp();
      const joinBtn = await buildJoinButton(userId);
      return interaction.editReply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(joinBtn)]
      });
    } catch (e) { return interaction.editReply("something went wrong loading their info, try again"); }
  }

  if (commandName === 'cookie') {
    if (interaction.user.id !== COOKIE_OWNER_ID)
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only the bot owner can use this command')], ephemeral: true });
    const cookie = interaction.options.getString('cookie').trim();
    if (cookie.length < 50)
      return interaction.reply({ embeds: [errorEmbed('invalid cookie').setDescription('that does not look like a valid `.ROBLOSECURITY` cookie')], ephemeral: true });
    saveStoredCookie(cookie);
    process.env.ROBLOX_COOKIE = cookie;
    return interaction.reply({ embeds: [successEmbed('cookie saved').setDescription('the roblox cookie has been updated and is now active')], ephemeral: true });
  }

  if (commandName === 'rg') {
    if (!isWlManager(interaction.user.id) && !isTempOwner(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers and temp owners can use `/rg`')], ephemeral: true });
    const link = interaction.options.getString('link');
    const parsed = parseRobloxGroupLink(link);
    if (!parsed) return interaction.reply({ embeds: [errorEmbed('invalid link').setDescription('give a roblox group link like `https://www.roblox.com/communities/12345/about` or just the group id')], ephemeral: true });
    setGroupConfig(parsed);
    return interaction.reply({ embeds: [successEmbed('group updated').setDescription(`now using group \`${parsed.groupId}\`\n${parsed.groupLink}`)] });
  }

  if (commandName === 'gc') {
    await interaction.deferReply();
    const username = interaction.options.getString('username');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return interaction.editReply("could not find that user")
      const userId = userBasic.id;
      const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)).json()).data ?? [];
      const displayName = userBasic.displayName || userBasic.name;
      const inFraidGroup = groupsData.some(g => String(g.group.id) === getGroupId());
      const groups = groupsData.sort((a, b) => a.group.name.localeCompare(b.group.name));
      const avatarUrl = (await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).json()).data?.[0]?.imageUrl;
      const userGroupIds = new Set(groups.map(g => String(g.group.id)));
      gcCache.set(username.toLowerCase(), { displayName, groups, avatarUrl, userGroupIds, inGroup: inFraidGroup });
      setTimeout(() => gcCache.delete(username.toLowerCase()), 10 * 60 * 1000);
      const flagRow = buildFlagSelectRow(username, groups);
      const pageRow = groups.length > GC_PER_PAGE ? buildGcRow(username, groups, 0) : null;
      const components = [pageRow, flagRow].filter(Boolean);
      if (!inFraidGroup) {
        return interaction.editReply({
          embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), buildGcNotInGroupEmbed(displayName, userGroupIds)],
          components
        });
      }
      return interaction.editReply({
        embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), buildGcInGroupEmbed(displayName, userGroupIds)],
        components
      });
    } catch (err) { return interaction.editReply({ embeds: [errorFromCatch('GC01', err)] }) }
  }

  if (commandName === 'vmhelp') return interaction.reply({ embeds: [buildVmHelpEmbed()] });

  if (commandName === 'help') {
    // unwhitelisted users get nothing silent ignore so they can't even tell help exists
    if (!isWhitelisted(interaction.user.id)) {
      try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; }
    }
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can pull up the full help list', ephemeral: true });
    return interaction.reply({ embeds: [buildHelpEmbed(0)], components: [buildHelpRow(0)] });
  }

  if (commandName === 'afk') {
    const reason = interaction.options.getString('reason') || null;
    const afk = loadAfk();
    afk[interaction.user.id] = { reason, since: Date.now() };
    saveAfk(afk);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`you are now AFK${reason ? `: ${reason}` : ''}`)], ephemeral: true })
  }

  if (commandName === 'snipe') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const sniped = snipeCache.get(channel.id);
    if (!sniped) return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('nothing to snipe')] });
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('sniped')
      .setDescription(sniped.content)
      .addFields({ name: 'author', value: sniped.author, inline: true }, { name: 'deleted', value: `<t:${Math.floor(sniped.deletedAt / 1000)}:R `, inline: true })
      .setThumbnail(sniped.avatarUrl)] });
  }

  if (commandName === 'purge') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const amount = interaction.options.getInteger('amount');
    try {
      const deleted = await channel.bulkDelete(amount, true);
      return interaction.reply({ content: `deleted **${deleted.size}** messages`, ephemeral: true });
    } catch (err) { return interaction.reply({ content: `couldn't purge ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'about') {
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`About ${client.user.username}`)
      .setDescription(`A custom Discord bot built for **${getBotName()}**.\n\nUse \`/help\` to see all commands.`)
      .addFields(
        { name: 'servers', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'uptime', value: `<t:${Math.floor((Date.now() - client.uptime) / 1000)}:R `, inline: true }
      ).setThumbnail(client.user.displayAvatarURL()).setTimestamp()] });
  }


  // Whitelist required slash commands
  // unwhitelisted users only get `roblox` and `register`. for anything else
  // we just bail silently with an empty ephemeral reply (slash commands need
  // a response within 3s or discord shows "interaction failed", so we send
  // a tiny invisible blob instead of leaking that the command exists).
  if (!isWhitelisted(interaction.user.id)) {
    const openCommands = new Set(['roblox', 'register']);
    if (!openCommands.has(commandName)) {
      try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; }
    }
  }

  if (commandName === 'hb') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getUser('user');
    const rawId  = interaction.options.getString('id');
    if (!target && !rawId) return interaction.reply({ content: "provide a user mention or their ID", ephemeral: true });
    const userId = target?.id ?? rawId;
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!/^\d{17,19}$/.test(userId)) return interaction.reply({ content: "that doesn't look like a real id", ephemeral: true });
    try {
      await guild.members.ban(userId, { reason: `hardban by ${interaction.user.tag}: ${reason}`, deleteMessageSeconds: 0 });
      let username = target?.tag ?? userId;
      if (!target) { try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {} }
      const hardbans = loadHardbans();
      if (!hardbans[guild.id]) hardbans[guild.id] = {};
      hardbans[guild.id][userId] = { reason, bannedBy: interaction.user.id, at: Date.now() };
      saveHardbans(hardbans);
      return interaction.reply(`hardbanned **${username}** by ${interaction.user.tag} reason: ${reason}`);
    } catch (err) { return interaction.reply({ content: `couldn't ban ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'unhb') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const userId = interaction.options.getString('id');
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!/^\d{17,19}$/.test(userId)) return interaction.reply({ content: "that's not a valid user id", ephemeral: true });
    try {
      await guild.members.unban(userId, reason);
      const hardbans = loadHardbans();
      if (hardbans[guild.id]) delete hardbans[guild.id][userId];
      saveHardbans(hardbans);
      let username = userId;
      try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {}
      return interaction.reply({ embeds: [baseEmbed().setTitle('hardban removed').setColor(0x2C2F33)
        .addFields({ name: 'user', value: username, inline: true }, { name: 'mod', value: interaction.user.tag, inline: true }, { name: 'reason', value: reason }).setTimestamp()] });
    } catch (err) { return interaction.reply({ content: `couldn't remove hardban ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'ban') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    if (!target.bannable) return interaction.reply({ content: "can't ban them, they might be above me", ephemeral: true });
    const reason = interaction.options.getString('reason') || 'no reason';
    await target.ban({ reason, deleteMessageSeconds: 86400 });
    return interaction.reply(`banned **${target.user.tag}** by ${interaction.user.tag} reason: ${reason}`);
  }

  if (commandName === 'kick') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    if (!target.kickable) return interaction.reply({ content: "can't kick them, they might be above me", ephemeral: true });
    const reason = interaction.options.getString('reason') || 'no reason';
    try { await target.kick(reason); } catch { return interaction.reply({ content: "couldn't kick them", ephemeral: true }); }
    return interaction.reply(`kicked **${target.user.tag}** by ${interaction.user.tag} reason: ${reason}`);
  }

  if (commandName === 'unban') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const userId = interaction.options.getString('id');
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!/^\d{17,19}$/.test(userId)) return interaction.reply({ content: "that's not a valid user id", ephemeral: true });
    try {
      await guild.members.unban(userId, reason);
      let username = userId;
      try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {}
      return interaction.reply(`unbanned **${username}** by ${interaction.user.tag} reason: ${reason}`);
    } catch (err) { return interaction.reply({ content: `couldn't unban ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'timeout') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target  = interaction.options.getMember('user');
    const minutes = interaction.options.getInteger('minutes') || 5;
    const reason  = interaction.options.getString('reason') || 'no reason';
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { await target.timeout(minutes * 60 * 1000, reason); } catch { return interaction.reply({ content: "couldn't time them out", ephemeral: true }); }
    return interaction.reply(`timed out **${target.user.tag}** for ${minutes}m by ${interaction.user.tag} reason: ${reason}`);
  }

  if (commandName === 'untimeout') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { await target.timeout(null); } catch { return interaction.reply({ content: "couldn't remove their timeout", ephemeral: true }); }
    return interaction.reply(`removed timeout from **${target.user.tag}** by ${interaction.user.tag}`);
  }

  if (commandName === 'mute') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/mute`')], ephemeral: true });
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { await target.timeout(28 * 24 * 60 * 60 * 1000, reason); } catch { return interaction.reply({ content: "couldn't mute them", ephemeral: true }); }
    // dm the muted user a notification (kept as embed since it's a DM, not a channel reply)
    try {
      await target.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('you have been muted')
        .setDescription(`you were muted in **${guild.name}**`)
        .addFields({ name: 'reason', value: reason }, { name: 'moderator', value: interaction.user.tag })] });
    } catch {}
    return interaction.reply(`muted **${target.user.tag}** (dm sent) by ${interaction.user.tag} reason: ${reason}`);
  }

  if (commandName === 'unmute') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { await target.timeout(null); } catch { return interaction.reply({ content: "couldn't unmute them", ephemeral: true }); }
    return interaction.reply(`unmuted **${target.user.tag}** by ${interaction.user.tag}`);
  }

  if (commandName === 'hush') {
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: "could not find that user", ephemeral: true });
    const hushedData = loadHushed();
    if (hushedData[target.id]) return interaction.reply({ content: `**${target.tag}** is already hushed`, ephemeral: true });
    hushedData[target.id] = { hushedBy: interaction.user.id, at: Date.now() };
    saveHushed(hushedData);
    return interaction.reply(`hushed **${target.tag}** by ${interaction.user.tag}`);
  }

  if (commandName === 'unhush') {
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: "could not find that user", ephemeral: true });
    const hushedData = loadHushed();
    if (!hushedData[target.id]) return interaction.reply({ content: `**${target.tag}** isn't hushed`, ephemeral: true });
    delete hushedData[target.id];
    saveHushed(hushedData);
    return interaction.reply({ embeds: [baseEmbed().setTitle('unhushed').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'skull') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: "mention someone to skull", ephemeral: true });
    const skullData = loadSkull();
    if (!skullData[guild.id]) skullData[guild.id] = [];
    if (skullData[guild.id].includes(target.id)) return interaction.reply({ content: `already skulling **${target.tag}**`, ephemeral: true });
    skullData[guild.id].push(target.id);
    saveSkull(skullData);
    return interaction.reply({ embeds: [baseEmbed().setTitle('skull').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .setDescription(`now reacting to every message from **${target.tag}** with 💀`)
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'unskull') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: "mention someone to unskull", ephemeral: true });
    const skullData = loadSkull();
    if (!skullData[guild.id]?.includes(target.id)) return interaction.reply({ content: `not skulling **${target.tag}**`, ephemeral: true });
    skullData[guild.id] = skullData[guild.id].filter(id => id !== target.id);
    saveSkull(skullData);
    return interaction.reply({ embeds: [baseEmbed().setTitle('unskull').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .setDescription(`stopped skulling **${target.tag}**`)
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'annoy') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: "could not find that user", ephemeral: true });
    const annoyData = loadAnnoy();
    if (!annoyData[guild.id]) annoyData[guild.id] = [];
    if (annoyData[guild.id].includes(target.id)) return interaction.reply({ content: `already annoying **${target.tag}**`, ephemeral: true });
    annoyData[guild.id].push(target.id);
    saveAnnoy(annoyData);
    return interaction.reply({ embeds: [baseEmbed().setTitle('annoy').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .setDescription(`now reacting to every message from **${target.tag}** with 10 random emojis`)
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'unannoy') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: "could not find that user", ephemeral: true });
    const annoyData = loadAnnoy();
    if (!annoyData[guild.id]?.includes(target.id)) return interaction.reply({ content: `not annoying **${target.tag}**`, ephemeral: true });
    annoyData[guild.id] = annoyData[guild.id].filter(id => id !== target.id);
    saveAnnoy(annoyData);
    return interaction.reply({ embeds: [baseEmbed().setTitle('unannoy').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .setDescription(`stopped annoying **${target.tag}**`)
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'lock') {
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
      return interaction.reply('channel locked');
    } catch { return interaction.reply({ content: "couldn't lock the channel, check my perms", ephemeral: true }); }
  }

  if (commandName === 'unlock') {
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
      return interaction.reply('channel unlocked');
    } catch { return interaction.reply({ content: "couldn't unlock the channel, check my perms", ephemeral: true }); }
  }

  if (commandName === 'nuke') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    try {
      const ch = channel;
      const newCh = await ch.clone({
        name:     ch.name,
        topic:    ch.topic,
        nsfw:     ch.nsfw,
        parent:   ch.parentId,
        position: ch.rawPosition,
        permissionOverwrites: ch.permissionOverwrites.cache
      });
      await ch.delete();
      await newCh.send(`channel nuked by **${interaction.user.tag}**`);
    } catch (err) {
      return interaction.reply({ content: `couldn't nuke ${err.message}`, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (commandName === 'say') {
    await channel.send(interaction.options.getString('text'));
    return interaction.reply({ content: 'sent', ephemeral: true });
  }

  if (commandName === 'cs') {
    const had = snipeCache.has(channel.id);
    snipeCache.delete(channel.id);
    return interaction.reply({ content: had ? 'snipe cleared' : 'nothing to clear', ephemeral: true });
  }

  if (commandName === 'grouproles') {
    const groupId = process.env.ROBLOX_GROUP_ID;
    if (!groupId) return interaction.reply({ content: '`ROBLOX GROUP ID` isnt set', ephemeral: true });
    await interaction.deferReply();
    try {
      const data = await (await fetch(`https://groups.roblox.com/v1/groups/${groupId}/roles`)).json();
      if (!data.roles?.length) return interaction.editReply('no roles found for this group');
      const lines = data.roles.sort((a, b) => a.rank - b.rank).map(r => `\`${String(r.rank).padStart(3, '0')}\` **${r.name}** ID: \`${r.id}\``);
      return interaction.editReply({ embeds: [baseEmbed().setTitle('group roles').setColor(0x2C2F33).setDescription(lines.join('\n')).setFooter({ text: `group id: ${groupId}` }).setTimestamp()] });
    } catch { return interaction.editReply("couldn't load group roles, try again"); }
  }

  if (commandName === 'jail') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'no reason';
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { return interaction.reply({ embeds: [await jailMember(guild, target, reason, interaction.user.tag)] }); }
    catch (e) { return interaction.reply({ content: `jail failed ${e.message}`, ephemeral: true }); }
  }

  if (commandName === 'unjail') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try { return interaction.reply({ embeds: [await unjailMember(guild, target, interaction.user.tag)] }); }
    catch (e) { return interaction.reply({ content: `unjail failed ${e.message}`, ephemeral: true }); }
  }

  if (commandName === 'prefix') {
    const newPrefix = interaction.options.getString('new');
    const p = getPrefix();
    if (!newPrefix) return interaction.reply({ content: `current prefix is \`${p}\``, ephemeral: true });
    if (newPrefix.length > 5) return interaction.reply({ content: "prefix can't be more than 5 chars", ephemeral: true });
    const cfg = loadConfig(); cfg.prefix = newPrefix; saveConfig(cfg);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`prefix updated to \`${newPrefix}\``)] });
  }

  if (commandName === 'status') {
    const type = interaction.options.getString('type');
    const text = interaction.options.getString('text');
    const statusData = { type, text };
    applyStatus(statusData);
    const cfg = loadConfig(); cfg.status = statusData; saveConfig(cfg);
    return interaction.reply({ content: `status changed to **${type}** ${text}` });
  }

  // change the online dot (online / idle / dnd / invisible)
  if (commandName === 'presence') {
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: "only whitelist managers can do this", ephemeral: true });
    const state = interaction.options.getString('state');
    applyPresence(state);
    const cfg = loadConfig(); cfg.presence = state; saveConfig(cfg);
    return interaction.reply({ content: `presence changed to **${state}**` });
  }

  if (commandName === 'wlmanager') {
    const sub  = interaction.options.getString('action');
    const mgrs = loadWlManagers();
    if (sub === 'list') {
      if (!isWlManager(interaction.user.id)) return interaction.reply({ content: "only whitelist managers can view the manager list", ephemeral: true });
      // only show ids from the json file (no env stuff so the list stays clean)
      const all = [...new Set(mgrs)];
      if (!all.length) return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist managers').setColor(0x2C2F33).setDescription('no managers set')] });
      // go grab the usernames so it doesnt just say a bunch of numbers
      const lines = [];
      let n = 1;
      for (const id of all) {
        let name = id;
        try {
          const u = await client.users.fetch(id);
          name = u.username;
        } catch (e) {
          name = 'unknown user';
        }
        lines.push(n + '. ' + name);
        n = n + 1;
      }
      return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist managers').setColor(0x2C2F33).setDescription(lines.join('\n')).setTimestamp()] });
    }
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: "ur not a whitelist manager", ephemeral: true });
    if (sub === 'add') {
      // temp owners can use every wl manager command EXCEPT promoting other wl managers
      if (!isRealWlManager(interaction.user.id)) return interaction.reply({ content: "temp owners can't add whitelist managers — only real whitelist managers can do that", ephemeral: true });
      const target = interaction.options.getUser('user');
      if (!target) return interaction.reply({ content: "provide a user", ephemeral: true })
      if (isBlockedFromWhitelist(target.id)) return interaction.reply({ content: `**${target.tag}** can't be added to the whitelist managers.`, ephemeral: true });
      if (mgrs.includes(target.id)) return interaction.reply({ content: `**${target.tag}** is already a whitelist manager`, ephemeral: true });
      mgrs.push(target.id); saveWlManagers(mgrs);
      return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist manager added').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
        .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'added by', value: interaction.user.tag, inline: true }).setTimestamp()] });
    }
    if (sub === 'remove') {
      // temp owners are explicitly NOT allowed to remove wl managers
      if (!isRealWlManager(interaction.user.id)) return interaction.reply({ content: "temp owners can't remove whitelist managers — only real whitelist managers can do that", ephemeral: true });
      const target = interaction.options.getUser('user');
      if (!target) return interaction.reply({ content: "provide a user", ephemeral: true })
      if (!mgrs.includes(target.id)) return interaction.reply({ content: `**${target.tag}** isn't a whitelist manager`, ephemeral: true });
      saveWlManagers(mgrs.filter(id => id !== target.id));
      return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist manager removed').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
        .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'removed by', value: interaction.user.tag, inline: true }).setTimestamp()] });
    }
  }

  if (commandName === 'whitelist') {
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: "you can't manage the whitelist", ephemeral: true });
    const sub = interaction.options.getString('action');
    // always read fresh from disk so check/list never returns stale data
    const wl = loadWhitelist();
    if (sub === 'add') {
      const target = interaction.options.getUser('user');
      if (!target) { try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; } }
      if (isBlockedFromWhitelist(target.id)) return interaction.reply({ content: `**${target.tag}** can't be added to the whitelist.`, ephemeral: true });
      if (wl.includes(target.id)) return interaction.reply({ content: `**${target.tag}** is already on the whitelist`, ephemeral: true });
      wl.push(target.id); saveWhitelist(wl);
      return interaction.reply(`added **${target.tag}** to the whitelist`);
    }
    if (sub === 'remove') {
      const target = interaction.options.getUser('user');
      if (!target) { try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; } }
      // re read + filter to avoid stale array writes if the file changed
      const fresh = loadWhitelist();
      if (!fresh.includes(target.id)) return interaction.reply({ content: `**${target.tag}** isn't on the whitelist`, ephemeral: true });
      saveWhitelist(fresh.filter(id => id !== target.id));
      return interaction.reply(`removed **${target.tag}** from the whitelist`);
    }
    if (sub === 'list') {
      // re read fresh
      const fresh = loadWhitelist();
      if (!fresh.length) return interaction.reply('the whitelist is empty');
      return interaction.reply({ embeds: [baseEmbed().setTitle('whitelist').setColor(0x2C2F33).setDescription(fresh.map((id, i) => `${i + 1}. <@${id}> (\`${id}\`)`).join('\n')).setTimestamp()] });
    }
    if (sub === 'check') {
      const target = interaction.options.getUser('user') || interaction.user;
      // re read so a recent add/remove shows up immediately
      const fresh = loadWhitelist();
      const onWl = fresh.includes(target.id);
      const isMgr = isWlManager(target.id);
      const lines = [];
      lines.push(`**${target.tag}** (\`${target.id}\`)`);
      lines.push(onWl ? '✓ on the whitelist' : '✗ not on the whitelist');
      if (isMgr) lines.push('• also a whitelist manager');
      return interaction.reply({ content: lines.join('\n'), ephemeral: true });
    }
  }

  // /joinserver <invite>: validate the invite & reply with a one-click OAuth link pre-targeted at the server
  if (commandName === 'joinserver') {
    if (!isWlManager(interaction.user.id) && !isTempOwner(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers and temp owners can use `/joinserver`')], ephemeral: true });

    const raw = interaction.options.getString('invite', true);
    const inviteCode = (raw.match(/(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)([\w-]+)/i)?.[1] || raw).trim();

    let invite;
    try { invite = await client.fetchInvite(inviteCode); }
    catch (e) {
      return interaction.reply({ embeds: [errorEmbed('invalid invite').setDescription(`that invite is invalid or expired (${e.message})`)], ephemeral: true });
    }

    const targetGuildId = invite.guild?.id;
    if (!targetGuildId)
      return interaction.reply({ embeds: [errorEmbed('not a server invite').setDescription('that invite is for a Group DM, not a server — bots can\'t join Group DMs')], ephemeral: true });

    if (client.guilds.cache.has(targetGuildId))
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('already in that server')
        .setDescription(`I'm already in **${invite.guild.name}** (\`${targetGuildId}\`). nothing to do.`)], ephemeral: true });

    const clientId = client.user?.id || process.env.CLIENT_ID || '';
    if (!clientId) return interaction.reply({ embeds: [errorCode('E JOIN 001', 'bot client id not available yet try again in a few seconds')], ephemeral: true });

    const installUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot+applications.commands&guild_id=${targetGuildId}&disable_guild_select=true`;
    const embed = baseEmbed().setColor(0x2C2F33).setTitle('join server')
      .setDescription([
        `**heads up:** Discord doesn't let bots accept invite links on their own — only a human with **Manage Server** in the target server can authorize me.`,
        ``,
        `**target server:** ${invite.guild.name} \`(${targetGuildId})\``,
        invite.memberCount ? `**members:** ~${invite.memberCount}` : null,
        ``,
        `[**click here to add me to that server**](${installUrl})`,
        `(opens the Discord auth dialog with the server pre-selected — one click and I'm in)`,
      ].filter(Boolean).join('\n'));
    if (invite.guild.icon) embed.setThumbnail(`https://cdn.discordapp.com/icons/${targetGuildId}/${invite.guild.icon}.png`);
    // ping the requester so they get a notification with the install link (NOT ephemeral
    // anymore — ephemeral replies can't ping anyone)
    return interaction.reply({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
      allowedMentions: { users: [interaction.user.id] },
    });
  }

  // /permcheck [user]: anyone can check anyone's bot permissions. ephemeral so it
  // doesn't spam the channel.
  if (commandName === 'permcheck') {
    const target = interaction.options.getUser('user') || interaction.user;
    const id = target.id;
    const wlMgr = isWlManager(id);
    const tempOwn = isTempOwner(id);
    const whitelisted = isWhitelisted(id);
    const lines = [
      `**user:** <@${id}> \`(${id})\``,
      ``,
      `${wlMgr ? '✅' : '❌'} whitelist manager`,
      `${tempOwn ? '✅' : '❌'} temp owner`,
      `${whitelisted ? '✅' : '❌'} whitelisted`,
    ];
    if (!wlMgr && !tempOwn && !whitelisted) lines.push('', '_no bot-level permissions — this user can only run public commands._');
    const embed = baseEmbed().setColor(0x2C2F33).setTitle('permission check').setDescription(lines.join('\n'));
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === 'invite') {
    if (!isWlManager(interaction.user.id)) {
      try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; }
    }
    const clientId = client.user?.id || process.env.CLIENT_ID || '';
    if (!clientId) {
      return interaction.reply({ embeds: [errorCode('E INV 001', 'bot client id not available yet try again in a few seconds')], ephemeral: true });
    }
    // server invite (bot perms = administrator) and roblox account add link
    const serverInvite = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&integration_type=0&scope=bot+applications.commands`;
    const userInstall = `https://discord.com/oauth2/authorize?client_id=${clientId}&integration_type=1&scope=applications.commands`;
    const robloxOauth = `https://apis.roblox.com/oauth/v1/authorize?client_id=${clientId}&redirect_uri=https%3A%2F%2Fwww.roblox.com%2Fhome&scope=openid%20profile%20group%3Aread%20group%3Awrite%20user.advanced.add_friends%3Awrite&response_type=code&prompt=login`;
    const embed = baseEmbed().setColor(0x2C2F33).setTitle(`Invite ${getBotName()}`)
      .setDescription([
        `**Server invite (bot)** adds the bot to your server`,
        `[click here to add to a server](${serverInvite})`,
        ``,
        `**User install** use the bot's commands anywhere`,
        `[click here to install on your account](${userInstall})`,
        ``,
        `**Roblox account link** connect the bot to your Roblox account`,
        `[click here to authorize on Roblox](${robloxOauth})`,
      ].join('\n'));
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === 'setlogchanneltag') {
    if (!isWlManager(interaction.user.id)) {
      try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; }
    }
    const ch = interaction.options.getChannel('channel');
    if (!ch) { try { return interaction.reply({ content: '\u200b', ephemeral: true }); } catch { return; } }
    const cfg = loadConfig();
    cfg.tagLogChannelId = ch.id;
    saveConfig(cfg);
    return interaction.reply(`tag logs will now go to <#${ch.id}> `);
  }

  // NEW command handlers

  if (commandName === 'activitycheck') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const action = interaction.options.getString('action');
    const checks = loadActivityCheck();
    if (!checks[guild.id]) checks[guild.id] = {};
    if (action === 'start') {
      const acMessage = interaction.options.getString('message') || 'Activity Check';
      checks[guild.id] = { startedBy: interaction.user.id, startedAt: Date.now(), active: true, checkins: [], acMessage };
      saveActivityCheck(checks);
      const acEmbed = baseEmbed().setColor(0x2C2F33).setTitle(acMessage)
        .setDescription('Click react to react to activity check!')
        .addFields({ name: 'started by', value: interaction.user.tag, inline: true })
        .setTimestamp();
      const acRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ac checkin').setLabel('React').setStyle(ButtonStyle.Primary)
      );
      return interaction.reply({ embeds: [acEmbed], components: [acRow] });
    }
    if (action === 'end') {
      if (!checks[guild.id].active) return interaction.reply({ content: "no active activity check", ephemeral: true });
      const startedAt = checks[guild.id].startedAt;
      const startedBy = checks[guild.id].startedBy;
      const checkins = checks[guild.id].checkins || [];
      const acMessage = checks[guild.id].acMessage || 'Activity Check';
      checks[guild.id] = { active: false };
      saveActivityCheck(checks);
      const checkinList = checkins.length ? checkins.map(id => `<@${id}> `).join(', ') : 'nobody checked in';
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`${acMessage} Ended`)
        .addFields(
          { name: 'ended by', value: interaction.user.tag, inline: true },
          { name: 'started by', value: `<@${startedBy}> `, inline: true },
          { name: 'started', value: `<t:${Math.floor(startedAt / 1000)}:R `, inline: true },
          { name: `checked in (${checkins.length})`, value: checkinList }
        ).setTimestamp()] });
    }
  }

  if (commandName === 'config') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const setting = interaction.options.getString('setting');
    const value = interaction.options.getString('value');
    const cfg = loadConfig();
    if (!cfg.serverConfig) cfg.serverConfig = {};
    if (!cfg.serverConfig[guild.id]) cfg.serverConfig[guild.id] = {};
    cfg.serverConfig[guild.id][setting] = value;
    saveConfig(cfg);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Config Updated')
      .addFields({ name: setting, value: value, inline: true }).setTimestamp()] });
  }

  if (commandName === 'logo') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const url = interaction.options.getString('url');
    const action = interaction.options.getString('action');
    const cfg = loadConfig();
    if (action === 'reset') {
      delete cfg.logoUrl;
      saveConfig(cfg);
      return interaction.reply({ content: `embed logo reset to default: ${getLogoUrl()}` });
    }
    if (!url) {
      return interaction.reply({ content: `current logo: ${getLogoUrl()}` });
    }
    cfg.logoUrl = url;
    saveConfig(cfg);
    return interaction.reply({ content: `embed logo updated: ${url}` });
  }

  if (commandName === 'name') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const text = interaction.options.getString('text');
    const action = interaction.options.getString('action');
    const cfg = loadConfig();
    if (action === 'reset') {
      delete cfg.customName;
      saveConfig(cfg);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Name Reset')
        .setDescription(`embed name has been reset to **${client.user?.username || 'Bot'}**`).setTimestamp()] });
    }
    if (!text) {
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Current Name')
        .setDescription(`current embed name: **${getBotName()}**`).setTimestamp()] });
    }
    cfg.customName = text;
    saveConfig(cfg);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Name Updated')
      .setDescription(`embed name changed to **${text}**`).setTimestamp()] });
  }

  if (commandName === 'group') {
    await interaction.deferReply();
    const username = interaction.options.getString('username');
    const action = interaction.options.getString('action');
    const value = interaction.options.getString('value');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return interaction.editReply("could not find that user");
      const groupId = process.env.ROBLOX_GROUP_ID;
      if (action === 'check') {
        const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userBasic.id}/groups/roles`)).json()).data ?? [];
        const membership = groupsData.find(g => String(g.group.id) === String(groupId));
        return interaction.editReply({ embeds: [baseEmbed().setColor(membership ? 0x23D160 : 0xFF3860).setTitle('Group Check')
          .addFields(
            { name: 'user', value: userBasic.name, inline: true },
            { name: 'in group', value: membership ? 'yes' : 'no', inline: true },
            { name: 'role', value: membership?.role?.name ?? 'n/a', inline: true }
          ).setTimestamp()] });
      }
      if (action === 'rank') {
        if (!value) return interaction.editReply("provide a role ID to rank to");
        const result = await rankRobloxUser(username, value);
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Ranked')
          .addFields({ name: 'user', value: result.displayName, inline: true }, { name: 'role id', value: value, inline: true }).setTimestamp()] });
      }
      if (action === 'exile') {
        const cookie = process.env.ROBLOX_COOKIE;
        if (!cookie || !groupId) return interaction.editReply('ROBLOX COOKIE or ROBLOX GROUP ID not configured');
        const csrfRes = await fetch('https://auth.roblox.com/v2/logout', { method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
        const csrfToken = csrfRes.headers.get('x csrf token');
        const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${userBasic.id}`, {
          method: 'DELETE', headers: { Cookie: `.ROBLOSECURITY=${cookie}`, 'X-CSRF-TOKEN': csrfToken }
        });
        if (!res.ok) return interaction.editReply(`couldn't exile HTTP ${res.status}`);
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Exiled')
          .addFields({ name: 'user', value: userBasic.name, inline: true }, { name: 'exiled by', value: interaction.user.tag, inline: true }).setTimestamp()] });
      }
    } catch (err) { return interaction.editReply(`something went wrong ${err.message}`); }
  }

  if (commandName === 'setverifyrole') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const role = interaction.options.getRole('role');
    const vc = loadVerifyConfig();
    if (!vc[guild.id]) vc[guild.id] = {};
    vc[guild.id].roleId = role.id;
    saveVerifyConfig(vc);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verify Role Set')
      .addFields({ name: 'role', value: `${role}`, inline: true }, { name: 'set by', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'verify') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const vc = loadVerifyConfig();
    const vwl = loadVerifyWhitelist();
    const guildVc = vc[guild.id];
    if (!guildVc?.roleId) return interaction.reply({ content: "verify role isn't set use `/setverifyrole` first", ephemeral: true });
    const guildVwl = vwl[guild.id] || { roles: [], users: [] };
    const member = interaction.member;
    const isAllowed = guildVwl.users.includes(interaction.user.id) ||
      member.roles.cache.some(r => guildVwl.roles.includes(r.id)) ||
      member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    if (!isAllowed) return interaction.reply({ content: "you are not allowed to verify users", ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
    try {
      await target.roles.add(guildVc.roleId, `verified by ${interaction.user.tag}`);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verified')
        .setThumbnail(target.user.displayAvatarURL())
        .addFields(
          { name: 'user', value: target.user.tag, inline: true },
          { name: 'verified by', value: interaction.user.tag, inline: true },
          { name: 'role given', value: `<@&${guildVc.roleId}> `, inline: true }
        ).setTimestamp()] });
    } catch (err) { return interaction.reply({ content: `couldn't verify ${err.message}`, ephemeral: true }); }
  }

  if (commandName === 'vwl') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const role = interaction.options.getRole('role');
    const vwl = loadVerifyWhitelist();
    if (!vwl[guild.id]) vwl[guild.id] = { roles: [], users: [] };
    if (vwl[guild.id].roles.includes(role.id)) return interaction.reply({ content: `<@&${role.id}> is already whitelisted`, ephemeral: true });
    vwl[guild.id].roles.push(role.id);
    saveVerifyWhitelist(vwl);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verify Whitelist Role Added')
      .addFields({ name: 'role', value: `${role}`, inline: true }, { name: 'added by', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'vwluser') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const target = interaction.options.getUser('user');
    const vwl = loadVerifyWhitelist();
    if (!vwl[guild.id]) vwl[guild.id] = { roles: [], users: [] };
    if (vwl[guild.id].users.includes(target.id)) return interaction.reply({ content: `**${target.tag}** is already whitelisted`, ephemeral: true });
    vwl[guild.id].users.push(target.id);
    saveVerifyWhitelist(vwl);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verify Whitelist User Added')
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'added by', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  if (commandName === 'vunwl') {
    if (!guild) return interaction.reply({ content: "this only works in a server", ephemeral: true });
    const role = interaction.options.getRole('role');
    const target = interaction.options.getUser('user');
    if (!role && !target) return interaction.reply({ content: "provide a role or user to remove", ephemeral: true });
    const vwl = loadVerifyWhitelist();
    if (!vwl[guild.id]) return interaction.reply({ content: "nothing is whitelisted", ephemeral: true });
    const lines = [];
    if (role) {
      if (!vwl[guild.id].roles.includes(role.id)) return interaction.reply({ content: `<@&${role.id}> isn't whitelisted`, ephemeral: true });
      vwl[guild.id].roles = vwl[guild.id].roles.filter(id => id !== role.id);
      lines.push(`role: ${role}`);
    }
    if (target) {
      if (!vwl[guild.id].users.includes(target.id)) return interaction.reply({ content: `**${target.tag}** isn't whitelisted`, ephemeral: true });
      vwl[guild.id].users = vwl[guild.id].users.filter(id => id !== target.id);
      lines.push(`user: ${target.tag}`);
    }
    saveVerifyWhitelist(vwl);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verify Whitelist Removed')
      .setDescription(lines.join('\n'))
      .addFields({ name: 'removed by', value: interaction.user.tag, inline: true }).setTimestamp()] });
  }

  // server setup commands removed

  // /warn
  if (commandName === 'warn') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return interaction.reply({ content: 'you need **Moderate Members** to warn', ephemeral: true });
    const target = interaction.options.getMember('user') ?? interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') ?? 'no reason given';
    if (!target) return interaction.reply({ content: "could not find that user", ephemeral: true });
    const userId = target.id ?? target.user?.id;
    const userTag = target.user?.tag ?? target.tag ?? 'Unknown';
    const warnsData = loadWarns();
    if (!warnsData[guild.id]) warnsData[guild.id] = {};
    if (!warnsData[guild.id][userId]) warnsData[guild.id][userId] = [];
    warnsData[guild.id][userId].push({ reason, mod: interaction.user.tag, ts: Date.now() });
    saveWarns(warnsData);
    const count = warnsData[guild.id][userId].length;
    return interaction.reply({ embeds: [warnEmbed('Member Warned')
      .setThumbnail(target.user?.displayAvatarURL() ?? target.displayAvatarURL?.() ?? null)
      .addFields(
        { name: 'user', value: `<@${userId}> (${userTag})`, inline: true },
        { name: 'warned by', value: interaction.user.tag, inline: true },
        { name: 'total warnings', value: `${count}`, inline: true },
        { name: 'reason', value: reason }
      )] });
  }

  if (commandName === 'warnings') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const target = interaction.options.getUser('user');
    const warnsData = loadWarns();
    const list = warnsData[guild.id]?.[target.id] ?? [];
    if (!list.length) return interaction.reply({ embeds: [infoEmbed('No Warnings')
      .setDescription(`**${target.tag}** has no warnings`)] });
    const lines = list.map((w, i) =>
      `**${i + 1}.** ${w.reason} by **${w.mod}** <t:${Math.floor(w.ts / 1000)}:R `
    ).join('\n');
    return interaction.reply({ embeds: [warnEmbed(`Warnings ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(lines)
      .addFields({ name: 'total', value: `${list.length}`, inline: true })] });
  }

  if (commandName === 'clearwarns') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return interaction.reply({ content: 'you need **Moderate Members** to clear warns', ephemeral: true });
    const target = interaction.options.getUser('user');
    const warnsData = loadWarns();
    const count = warnsData[guild.id]?.[target.id]?.length ?? 0;
    if (!warnsData[guild.id]) warnsData[guild.id] = {};
    warnsData[guild.id][target.id] = [];
    saveWarns(warnsData);
    return interaction.reply({ embeds: [successEmbed('Warnings Cleared')
      .addFields(
        { name: 'user', value: `<@${target.id}> (${target.tag})`, inline: true },
        { name: 'cleared', value: `${count} warning${count !== 1 ? 's' : ''}`, inline: true },
        { name: 'cleared by', value: interaction.user.tag, inline: true }
      )] });
  }

  if (commandName === 'delwarn') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return interaction.reply({ content: 'you need **Moderate Members**', ephemeral: true });
    const target = interaction.options.getUser('user');
    const idx = interaction.options.getInteger('index') - 1;
    const warnsData = loadWarns();
    const list = warnsData[guild.id]?.[target.id] ?? [];
    if (!list[idx]) return interaction.reply({ content: `no warning at index **${idx + 1}**`, ephemeral: true });
    const removed = list.splice(idx, 1)[0];
    saveWarns(warnsData);
    return interaction.reply({ embeds: [successEmbed('Warning Removed')
      .addFields(
        { name: 'user', value: `<@${target.id}> `, inline: true },
        { name: 'removed #', value: `${idx + 1}`, inline: true },
        { name: 'reason was', value: removed.reason }
      )] });
  }

  // /serverinfo
  if (commandName === 'serverinfo') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const owner = await guild.fetchOwner().catch(() => null);
    const channels = guild.channels.cache;
    const textCount  = channels.filter(c => c.type === ChannelType.GuildText).size;
    const voiceCount = channels.filter(c => c.type === ChannelType.GuildVoice).size;
    const roleCount  = guild.roles.cache.size - 1;
    const boosts     = guild.premiumSubscriptionCount ?? 0;
    const tier       = guild.premiumTier;
    return interaction.reply({ embeds: [infoEmbed(guild.name)
      .setThumbnail(guild.iconURL({ size: 256 }) ?? getLogoUrl())
      .addFields(
        { name: 'owner',    value: owner ? `<@${owner.id}> ` : 'unknown',         inline: true },
        { name: 'members',  value: `${guild.memberCount}`,                        inline: true },
        { name: 'roles',    value: `${roleCount}`,                                inline: true },
        { name: 'text',     value: `${textCount}`,                                inline: true },
        { name: 'voice',    value: `${voiceCount}`,                               inline: true },
        { name: 'boosts',   value: `${boosts} (tier ${tier})`,                    inline: true },
        { name: 'created',  value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R `, inline: true },
        { name: 'id',       value: guild.id,                                      inline: true }
      )
      .setImage(guild.bannerURL({ size: 1024 }) ?? null)] });
  }

  // /userinfo
  if (commandName === 'userinfo') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const target = interaction.options.getMember('user') ?? interaction.member;
    const user   = target.user;
    const roles  = target.roles.cache.filter(r => r.id !== guild.id)
      .sort((a, b) => b.position - a.position).map(r => `${r}`).slice(0, 10).join(' ');
    return interaction.reply({ embeds: [userEmbed(user.tag)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'id',        value: user.id,                                             inline: true },
        { name: 'nickname',  value: target.nickname ?? 'none',                           inline: true },
        { name: 'joined',    value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R `,inline: true },
        { name: 'created',   value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R `, inline: true },
        { name: 'bot',       value: user.bot ? 'yes' : 'no',                             inline: true },
        { name: `roles [${target.roles.cache.size - 1}]`, value: roles || 'none' }
      )] });
  }

  // /avatar
  if (commandName === 'avatar') {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const url = target.displayAvatarURL({ size: 1024 });
    return interaction.reply({ embeds: [userEmbed(`${target.tag}'s Avatar`)
      .setThumbnail(null).setImage(url)
      .setDescription(`[Open full size](${url})`)] });
  }

  // /banner
  if (commandName === 'banner') {
    const target = await (interaction.options.getUser('user') ?? interaction.user).fetch();
    const url = target.bannerURL({ size: 1024 });
    if (!url) return interaction.reply({ embeds: [infoEmbed(`${target.tag} has no banner`)] });
    return interaction.reply({ embeds: [userEmbed(`${target.tag}'s Banner`)
      .setThumbnail(null).setImage(url)
      .setDescription(`[Open full size](${url})`)] });
  }

  // /roleinfo
  if (commandName === 'roleinfo') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const role = interaction.options.getRole('role');
    const members = guild.members.cache.filter(m => m.roles.cache.has(role.id)).size;
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(role.color || 0x2B2D31)
      .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .setTitle(role.name)
      .setTimestamp()
      .setFooter({ text: getBotName(), iconURL: getLogoUrl() })
      .addFields(
        { name: 'id',        value: role.id,                                          inline: true },
        { name: 'color',     value: role.hexColor,                                    inline: true },
        { name: 'members',   value: `${members}`,                                     inline: true },
        { name: 'mentionable', value: role.mentionable ? 'yes' : 'no',              inline: true },
        { name: 'hoisted',   value: role.hoist ? 'yes' : 'no',                       inline: true },
        { name: 'position',  value: `${role.position}`,                               inline: true },
        { name: 'created',   value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R `, inline: true }
      )] });
  }

  // /editsnipe
  if (commandName === 'editsnipe') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const data = editSnipeCache.get(interaction.channel.id);
    if (!data) return interaction.reply({ embeds: [infoEmbed('Nothing to Snipe')
      .setDescription('no recent message edits in this channel')] });
    return interaction.reply({ embeds: [logEmbed('Edit Sniped')
      .setThumbnail(data.avatarUrl)
      .addFields(
        { name: 'author',  value: data.author, inline: true },
        { name: 'edited',  value: `<t:${Math.floor(data.editedAt / 1000)}:R `, inline: true },
        { name: 'before',  value: data.before?.slice(0, 1024) || '*(empty)*' },
        { name: 'after',   value: data.after?.slice(0, 1024)  || '*(empty)*' }
      )] });
  }

  // /reactsnipe
  if (commandName === 'reactsnipe') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const data = reactSnipeCache.get(interaction.channel.id);
    if (!data) return interaction.reply({ embeds: [infoEmbed('Nothing to Snipe')
      .setDescription('no recent removed reactions in this channel')] });
    return interaction.reply({ embeds: [logEmbed('Reaction Sniped')
      .setThumbnail(data.avatarUrl)
      .addFields(
        { name: 'user',    value: data.author, inline: true },
        { name: 'emoji',   value: data.emoji,  inline: true },
        { name: 'removed', value: `<t:${Math.floor(data.removedAt / 1000)}:R `, inline: true },
        { name: 'message', value: data.content?.slice(0, 1024) || '*(no content)*' }
      )] });
  }

  // /invites
  if (commandName === 'invites') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const target = interaction.options.getUser('user') ?? interaction.user;
    await interaction.deferReply();
    try {
      const invites = await guild.invites.fetch();
      const userInvites = invites.filter(inv => inv.inviter?.id === target.id);
      const total = userInvites.reduce((sum, inv) => sum + (inv.uses ?? 0), 0);
      return interaction.editReply({ embeds: [infoEmbed(`Invites ${target.tag}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: 'total invites', value: `${total}`, inline: true },
          { name: 'invite links',  value: `${userInvites.size}`, inline: true }
        )] });
    } catch { return interaction.editReply('could not fetch invites missing **Manage Guild** permission'); }
  }

  // /convert
  if (commandName === 'convert') {
    const username = interaction.options.getString('username');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return interaction.reply({ content: "could not find that user", ephemeral: true });
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Roblox ID Lookup')
        .addFields({ name: 'username', value: userBasic.name, inline: true }, { name: 'display name', value: userBasic.displayName || userBasic.name, inline: true }, { name: 'user id', value: `\`${userBasic.id}\``, inline: true })
        .setFooter({ text: 'roblox user id' }).setTimestamp()] });
    } catch { return interaction.reply({ content: 'something went wrong, try again', ephemeral: true }); }
  }

  // /dm
  if (commandName === 'dm') {
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use `/dm`', ephemeral: true });
    const dmMsg   = interaction.options.getString('message');
    const target  = interaction.options.getUser('user');
    const dmRole  = interaction.options.getRole('role');
    if (!target && !dmRole) return interaction.reply({ content: 'provide a user or a role', ephemeral: true });
    if (dmRole) {
      if (!guild) return interaction.reply({ content: "can't DM a role outside a server", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await fetchMembersCached(guild);
      const members = dmRole.members;
      if (!members.size) return interaction.editReply('no members have that role');
      let sent = 0, failed = 0;
      for (const [, member] of members) {
        if (member.user.bot) continue;
        try {
          await member.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Message').setDescription(dmMsg).setFooter({ text: `from ${interaction.user.tag}` }).setTimestamp()] });
          sent++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 500));
      }
      return interaction.editReply(`done sent: **${sent}**, failed: **${failed}**`);
    }
    if (target.bot) return interaction.reply({ content: "can't DM a bot", ephemeral: true });
    try {
      await target.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Message').setDescription(dmMsg).setFooter({ text: `from ${interaction.user.tag}` }).setTimestamp()] });
      return interaction.reply({ content: `DM sent to **${target.tag}**`, ephemeral: true });
    } catch { return interaction.reply({ content: `couldn't DM **${target.tag}** they might have DMs off`, ephemeral: true }); }
  }

  // /drag
  if (commandName === 'drag') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: 'that user is not in this server', ephemeral: true });
    const myVc = interaction.member?.voice?.channel;
    if (!myVc) return interaction.reply({ content: "you are not in a voice channel", ephemeral: true });
    try {
      await target.voice.setChannel(myVc);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`dragged **${target.displayName}** to **${myVc.name}**`)] });
    } catch { return interaction.reply({ content: "couldn't drag them they might not be in a vc", ephemeral: true }); }
  }

  // /vm
  if (commandName === 'vm') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const sub = interaction.options.getString('action');
    if (sub === 'setup') {
      if (!loadWhitelist().includes(interaction.user.id)) return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Not Whitelisted').setDescription("you are not whitelisted for this")], ephemeral: true });
      await interaction.deferReply();
      try {
        const category = await guild.channels.create({ name: 'Voice Master', type: ChannelType.GuildCategory });
        const createVc = await guild.channels.create({ name: '➕ Create VC', type: ChannelType.GuildVoice, parent: category.id });
        const iface    = await guild.channels.create({ name: 'interface', type: ChannelType.GuildText, parent: category.id });
        const ifaceMsg = await iface.send({ embeds: [buildVmInterfaceEmbed(guild)], components: buildVmInterfaceRows() });
        const vmConfig = loadVmConfig();
        vmConfig[guild.id] = { categoryId: category.id, createChannelId: createVc.id, interfaceChannelId: iface.id, interfaceMessageId: ifaceMsg.id };
        saveVmConfig(vmConfig);
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`✅ voicemaster set up! join **${createVc.name}** to create a vc.`)] });
      } catch (e) { return interaction.editReply(`setup failed ${e.message}`); }
    }
    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ content: 'you need to be in your voice channel', ephemeral: true });
    const vmChannels = loadVmChannels();
    const chData = vmChannels[vc.id];
    if (!chData) return interaction.reply({ content: "that's not a voicemaster channel", ephemeral: true });
    const isOwner = chData.ownerId === interaction.user.id;
    const everyone = guild.roles.everyone;

    if (sub === 'lock')   { if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true }); await vc.permissionOverwrites.edit(everyone, { Connect: false }); return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('🔒 channel locked')] }); }
    if (sub === 'unlock') { if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true }); await vc.permissionOverwrites.edit(everyone, { Connect: null }); return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('🔓 channel unlocked')] }); }
    if (sub === 'claim')  {
      if (vc.members.has(chData.ownerId)) return interaction.reply({ content: 'the owner is still in the channel', ephemeral: true });
      chData.ownerId = interaction.user.id; vmChannels[vc.id] = chData; saveVmChannels(vmChannels);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`👑 you now own **${vc.name}**`)] });
    }
    if (sub === 'limit') {
      if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
      const n = interaction.options.getInteger('limit') ?? 0;
      await vc.setUserLimit(n);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`limit set to **${n === 0 ? 'no limit' : n}**`)] });
    }
    if (sub === 'allow') {
      if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
      const target = interaction.options.getMember('user');
      if (!target) return interaction.reply({ content: 'provide a user with the user option', ephemeral: true });
      await vc.permissionOverwrites.edit(target.id, { Connect: true, ViewChannel: true });
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`allowed **${target.displayName}**`)] });
    }
    if (sub === 'deny') {
      if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
      const target = interaction.options.getMember('user');
      if (!target) return interaction.reply({ content: 'provide a user with the user option', ephemeral: true });
      await vc.permissionOverwrites.edit(target.id, { Connect: false });
      if (vc.members.has(target.id)) await target.voice.setChannel(null).catch(() => {});
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`denied **${target.displayName}**`)] });
    }
    if (sub === 'rename') {
      if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
      const newName = interaction.options.getString('name');
      if (!newName) return interaction.reply({ content: 'provide a name with the name option', ephemeral: true });
      await vc.setName(newName);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`renamed to **${newName}**`)] });
    }
    if (sub === 'reset') {
      if (!isOwner) return interaction.reply({ content: "you don't own this channel", ephemeral: true });
      await vc.setName(`${interaction.member.displayName}'s VC`);
      await vc.setUserLimit(0);
      await vc.permissionOverwrites.edit(everyone, { Connect: null, ViewChannel: null });
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('channel reset to defaults')] });
    }
    return interaction.reply({ embeds: [buildVmHelpEmbed()] });
  }

  // /role set a roblox group role on a roblox user
  if (commandName === 'role') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!canUseRole(interaction.member))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('you don\'t have permission to use `/role`. ask a wl manager to allow your role with `/setroleperms add`.')], ephemeral: true });

    const robloxUsername = interaction.options.getString('roblox');
    const roleName = interaction.options.getString('role');
    const roles = loadRobloxRoles();
    const lookup = roles[roleName] || roles[roleName.toLowerCase()];
    if (!lookup) return interaction.reply({ embeds: [errorEmbed('unknown role').setDescription(`no roblox group role named **${roleName}** is registered. use \`/setrole\` first.`)], ephemeral: true });

    await interaction.deferReply();
    try {
      const result = await rankRobloxUser(robloxUsername, lookup.id);
      const e = baseEmbed().setColor(0x2C2F33).setTitle('roblox role set')
        .setDescription(`set **${result.displayName}** to **${lookup.name || roleName}**`)
        .addFields(
          { name: 'roblox', value: `[${result.displayName}](https://www.roblox.com/users/${result.userId}/profile)`, inline: true },
          { name: 'role', value: `${lookup.name || roleName} \`${lookup.id}\``, inline: true },
          { name: 'set by', value: interaction.user.tag, inline: false }
        );
      if (result.avatarUrl) e.setThumbnail(result.avatarUrl);
      await interaction.editReply({ embeds: [e] });
      sendBotLog(guild, e);
    } catch (err) {
      await interaction.editReply({ embeds: [errorEmbed('failed').setDescription(err.message)] });
    }
    return;
  }

  // /r original discord role toggle (wl managers only)
  if (commandName === 'r') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can use this command', ephemeral: true });

    const targetMember = interaction.options.getMember('member');
    if (!targetMember) return interaction.reply({ content: 'that user is not in this server', ephemeral: true });

    const roleOptions = ['role1', 'role2', 'role3', 'role4', 'role5']
      .map(k => interaction.options.getRole(k))
      .filter(Boolean);

    if (!roleOptions.length) return interaction.reply({ content: 'provide at least one role', ephemeral: true });

    const added = [], removed = [], failed = [];
    for (const role of roleOptions) {
      try {
        if (targetMember.roles.cache.has(role.id)) {
          await targetMember.roles.remove(role);
          removed.push(role.toString());
        } else {
          await targetMember.roles.add(role);
          added.push(role.toString());
        }
      } catch { failed.push(role.name); }
    }

    const lines = [];
    if (added.length)   lines.push(`Added ${added.join(', ')} to ${targetMember}`);
    if (removed.length) lines.push(`Removed ${removed.join(', ')} from ${targetMember}`);
    if (failed.length)  lines.push(`Failed: ${failed.join(', ')} (missing perms?)`);

    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(lines.join('\n') || 'nothing changed')] });
  }

  // /setrole register a roblox group role name → id
  if (commandName === 'setrole') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setrole`')], ephemeral: true });
    const name = interaction.options.getString('name').trim();
    const id = interaction.options.getString('id').trim();
    if (!/^\d+$/.test(id)) return interaction.reply({ embeds: [errorEmbed('bad id').setDescription('role id must be numeric')], ephemeral: true });
    const roles = loadRobloxRoles();
    roles[name] = { id, name };
    saveRobloxRoles(roles);
    return interaction.reply({ embeds: [successEmbed('role registered').setDescription(`saved roblox group role **${name}** → \`${id}\``)] });
  }

  // /setroleperms allow discord role to use /role
  if (commandName === 'setroleperms') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setroleperms`')], ephemeral: true });
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');
    let perms = loadRolePerms();
    if (action === 'list') {
      const desc = perms.length ? perms.map(id => `<@&${id}> `).join('\n') : 'no roles allowed yet';
      return interaction.reply({ embeds: [infoEmbed('role permissions').setDescription(desc)] });
    }
    if (!role) return interaction.reply({ embeds: [errorEmbed('missing role').setDescription('pick a discord role')], ephemeral: true });
    if (action === 'add') {
      if (perms.includes(role.id)) return interaction.reply({ embeds: [errorEmbed('already allowed').setDescription(`${role} can already use /role`)], ephemeral: true });
      perms.push(role.id); saveRolePerms(perms);
      return interaction.reply({ embeds: [successEmbed('role allowed').setDescription(`${role} can now use \`/role\``)] });
    }
    if (action === 'remove') {
      perms = perms.filter(id => id !== role.id); saveRolePerms(perms);
      return interaction.reply({ embeds: [successEmbed('role removed').setDescription(`${role} can no longer use \`/role\``)] });
    }
    return;
  }

  // /tempowner
  if (commandName === 'tempowner') {
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/tempowner`')], ephemeral: true });
    const target = interaction.options.getUser('user');
    const ids = loadTempOwners();
    if (ids.includes(target.id)) return interaction.reply({ embeds: [errorEmbed('already temp owner').setDescription(`${target} is already a temp owner`)], ephemeral: true });
    ids.push(target.id); saveTempOwners(ids);
    try { await target.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('temp owner granted').setDescription(`you were granted temp owner access${guild ? ` in **${guild.name}**` : ''}. you now have access to every bot command.`)] }); } catch {}
    const e = successEmbed('temp owner granted').setDescription(`${target} now has access to every bot command`).addFields({ name: 'granted by', value: interaction.user.tag });
    if (guild) sendBotLog(guild, e);
    return interaction.reply({ embeds: [e] });
  }

  if (commandName === 'untempowner') {
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/untempowner`')], ephemeral: true });
    const target = interaction.options.getUser('user');
    let ids = loadTempOwners();
    if (!ids.includes(target.id)) return interaction.reply({ embeds: [errorEmbed('not a temp owner').setDescription(`${target} isn't a temp owner`)], ephemeral: true });
    ids = ids.filter(id => id !== target.id); saveTempOwners(ids);
    const e = successEmbed('temp owner revoked').setDescription(`${target} no longer has temp owner access`).addFields({ name: 'revoked by', value: interaction.user.tag });
    if (guild) sendBotLog(guild, e);
    return interaction.reply({ embeds: [e] });
  }

  // /setlogchannel + /logstatus
  if (commandName === 'setlogchannel') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setlogchannel`')], ephemeral: true });
    const ch = interaction.options.getChannel('channel');
    if (ch.type !== ChannelType.GuildText) return interaction.reply({ embeds: [errorEmbed('bad channel').setDescription('pick a text channel')], ephemeral: true });
    const cfg = loadConfig(); cfg.logChannelId = ch.id; saveConfig(cfg);
    return interaction.reply({ embeds: [successEmbed('log channel set').setDescription(`bot action logs will be sent to ${ch}`)] });
  }

  if (commandName === 'logstatus') {
    const cfg = loadConfig();
    if (!cfg.logChannelId) return interaction.reply({ embeds: [infoEmbed('log channel').setDescription('no log channel set. use `/setlogchannel` to set one.')] });
    return interaction.reply({ embeds: [infoEmbed('log channel').setDescription(`current log channel: <#${cfg.logChannelId}> `)] });
  }

  // /setverifyrole
  if (commandName === 'setverifyrole') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setverifyrole`')], ephemeral: true });
    const role = interaction.options.getRole('role');
    const cfg = loadVerifyConfig(); cfg.roleId = role.id; saveVerifyConfig(cfg);
    return interaction.reply({ embeds: [successEmbed('verify role set').setDescription(`verified users will receive ${role}`)] });
  }

  // /setuptickets
  if (commandName === 'setuptickets') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setuptickets`')], ephemeral: true });
    const ch = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title') || 'Open a Ticket';
    const description = interaction.options.getString('description') || 'click the button below to open a ticket. a private channel will be created for you and the support team.';
    if (ch.type !== ChannelType.GuildText) return interaction.reply({ embeds: [errorEmbed('bad channel').setDescription('pick a text channel')], ephemeral: true });
    const panel = baseEmbed().setColor(0x2C2F33).setTitle(title).setDescription(`${description}\n\n**Verification** open a verification ticket\n**Tag** request a roblox tag (a whitelisted user must approve)`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket kind select')
      .setPlaceholder('choose what you need…')
      .addOptions(
        { label: 'Verification', value: 'verification', description: 'open a verification ticket' },
        { label: 'Tag',          value: 'tag',          description: 'pick a roblox tag needs whitelist approval' }
      );
    const row = new ActionRowBuilder().addComponents(menu);
    try {
      await ch.send({ embeds: [panel], components: [row] });
      return interaction.reply({ embeds: [successEmbed('ticket panel sent').setDescription(`sent to ${ch}`)], ephemeral: true });
    } catch {
      return interaction.reply({ embeds: [errorEmbed('failed').setDescription('couldn\'t send to that channel check my permissions')], ephemeral: true });
    }
  }

  // /setuptagticket
  if (commandName === 'setuptagticket') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setuptagticket`')], ephemeral: true });
    const ch = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title') || 'Open a Tag Ticket';
    const description = interaction.options.getString('description') || 'click the button below to open a tag ticket. a private channel will be created for you and the support team.';
    if (ch.type !== ChannelType.GuildText) return interaction.reply({ embeds: [errorEmbed('bad channel').setDescription('pick a text channel')], ephemeral: true });
    const panel = baseEmbed().setColor(0x2C2F33).setTitle(title).setDescription(description);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tagticket open').setLabel('Open Tag Ticket').setStyle(ButtonStyle.Secondary)
    );
    try {
      await ch.send({ embeds: [panel], components: [row] });
      return interaction.reply({ embeds: [successEmbed('tag ticket panel sent').setDescription(`sent to ${ch}`)], ephemeral: true });
    } catch {
      return interaction.reply({ embeds: [errorEmbed('failed').setDescription('couldn\'t send to that channel check my permissions')], ephemeral: true });
    }
  }

  // /setuptag
  if (commandName === 'setuptag') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/setuptag`')], ephemeral: true });
    const ch = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title') || 'Open a Tag Ticket';
    const description = interaction.options.getString('description') || 'click the button below to open a tag ticket. a private channel will be created for you and the support team.';
    if (ch.type !== ChannelType.GuildText) return interaction.reply({ embeds: [errorEmbed('bad channel').setDescription('pick a text channel')], ephemeral: true });
    const panel = baseEmbed().setColor(0x2C2F33).setTitle(title).setDescription(description);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tag open').setLabel('Open Tag Ticket').setStyle(ButtonStyle.Secondary)
    );
    try {
      await ch.send({ embeds: [panel], components: [row] });
      return interaction.reply({ embeds: [successEmbed('tag panel sent').setDescription(`sent to ${ch}`)], ephemeral: true });
    } catch {
      return interaction.reply({ embeds: [errorEmbed('failed').setDescription('couldn\'t send to that channel check my permissions')], ephemeral: true });
    }
  }

  // /closeticket
  if (commandName === 'closeticket') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const tickets = loadTickets();
    const t = tickets[interaction.channel.id];
    if (!t) return interaction.reply({ embeds: [errorEmbed('not a ticket').setDescription('this isn\'t a ticket channel')], ephemeral: true });
    const support = loadTicketSupport();
    const allowed = isWlManager(interaction.user.id) || interaction.member.roles.cache.some(r => support.includes(r.id)) || t.userId === interaction.user.id;
    if (!allowed) return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only the ticket opener, support roles, or wl managers can close this')], ephemeral: true });
    await interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('closing this ticket in 5s...')] });
    delete tickets[interaction.channel.id]; saveTickets(tickets);
    setTimeout(async () => {
      try { await interaction.channel.delete('ticket closed'); } catch {}
    }, 5000);
    sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('ticket closed').setDescription(`<#${interaction.channel.id}> (${interaction.channel.name}) closed by ${interaction.user.tag}`));
    return;
  }

  // /ticket supportroles
  if (commandName === 'ticket') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'supportroles') {
      if (!isWlManager(interaction.user.id))
        return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can manage support roles')], ephemeral: true });
      const action = interaction.options.getString('action');
      const role = interaction.options.getRole('role');
      let support = loadTicketSupport();
      if (action === 'list') {
        const desc = support.length ? support.map(id => `<@&${id}> `).join('\n') : 'no support roles set';
        return interaction.reply({ embeds: [infoEmbed('ticket support roles').setDescription(desc)] });
      }
      if (!role) return interaction.reply({ embeds: [errorEmbed('missing role').setDescription('pick a role')], ephemeral: true });
      if (action === 'add') {
        if (support.includes(role.id)) return interaction.reply({ embeds: [errorEmbed('already added').setDescription(`${role} is already a support role`)], ephemeral: true });
        support.push(role.id); saveTicketSupport(support);
        return interaction.reply({ embeds: [successEmbed('support role added').setDescription(`${role} added to ticket support`)] });
      }
      if (action === 'remove') {
        support = support.filter(id => id !== role.id); saveTicketSupport(support);
        return interaction.reply({ embeds: [successEmbed('support role removed').setDescription(`${role} removed from ticket support`)] });
      }
    }
    return;
  }

  // /give1 give the bot and user the highest role possible
  if (commandName === 'give1') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `/give1`')], ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const me = await guild.members.fetchMe();
      const myTopPos = me.roles.highest.position;
      // create a new role positioned just below the bot's top managed role (highest possible)
      const newRole = await guild.roles.create({
        name: 'top',
        color: 0x2C2F33,
        permissions: PermissionsBitField.Resolver?.Administrator ? [PermissionsBitField.Flags.Administrator] : ['Administrator'],
        reason: `requested by ${interaction.user.tag}`
      });
      try { await newRole.setPosition(Math.max(1, myTopPos - 1)); } catch {}
      await me.roles.add(newRole).catch(() => {});
      const targetMember = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (targetMember) await targetMember.roles.add(newRole).catch(() => {});
      return interaction.editReply({ embeds: [successEmbed('done').setDescription(`gave ${newRole} to me and ${interaction.user}`)] });
    } catch (err) {
      return interaction.editReply({ embeds: [errorEmbed('failed').setDescription(err.message)] });
    }
  }


  // /tag same as /role (rank a roblox user) but logged to the tag log
  // Plain text only — no embed, no logo.
  if (commandName === 'tag') {
    // works in DMs and guilds guild requires role perms; DMs require WL manager
    const allowedDm = !guild && isWlManager(interaction.user.id);
    const allowedGuild = !!guild && canUseRole(interaction.member);
    if (!allowedDm && !allowedGuild)
      return interaction.reply({ content: 'you don\'t have permission to use `/tag`. in a server: ask a wl manager to allow your role with `/setroleperms add`. in DMs: only whitelist managers can tag.', ephemeral: true });

    const robloxUsername = (interaction.options.getString('roblox') || '').trim();
    const roleName = (interaction.options.getString('role') || '').trim();
    if (!robloxUsername || !roleName) {
      try {
        return interaction.reply({
          content: 'not the right format',
          ephemeral: true
        });
      } catch { return; }
    }

    const roles = loadRobloxRoles();
    const lookup = roles[roleName] || roles[roleName.toLowerCase()];
    if (!lookup) return interaction.reply({ content: `no roblox group role named **${roleName}** is registered. use \`/setrole\` first.`, ephemeral: true });

    await interaction.deferReply();
    try {
      const result = await rankRobloxUser(robloxUsername, lookup.id);
      appendTagLog({
        action: 'tag', tag: lookup.name || roleName, roblox: result.displayName,
        robloxId: result.userId, giverId: interaction.user.id, giverTag: interaction.user.tag, guildId: guild?.id
      });
      const text = `tagged **${result.displayName}** as **${lookup.name || roleName}**\nroblox: <https://www.roblox.com/users/${result.userId}/profile>\ngiven by: ${interaction.user.tag} (<@${interaction.user.id}>)`;
      await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
      try { if (guild) sendBotLog(guild, baseEmbed().setColor(0x2C2F33).setTitle('tag given').setDescription(text)); } catch {}
    } catch (err) {
      await interaction.editReply({ content: `failed: ${err.message}` });
    }
    return;
  }

  // /tagticket anyone can open one; shows roblox username modal
  if (commandName === 'tagticket') {
    const tickets = loadTickets();
    const existing = Object.entries(tickets).find(([, t]) => t.userId === interaction.user.id && t.kind === 'tagticket');
    if (existing) return interaction.reply({ embeds: [errorEmbed('ticket already open').setDescription(`you already have an open tag ticket: <#${existing[0]}> `)], ephemeral: true });

    const modal = new ModalBuilder().setCustomId('tagticket open modal').setTitle('Open a Tag Ticket')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tagticket roblox username')
          .setLabel('Roblox Username')
          .setPlaceholder('Enter your Roblox username...')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
      ));
    return interaction.showModal(modal);
  }

  // /taglog recent tag log entries
  if (commandName === 'taglog') {
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can view the tag log')], ephemeral: true });
    const limit = interaction.options.getInteger('limit') ?? 10;
    const entries = loadTagLog().slice(-limit).reverse();
    if (!entries.length) return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('tag log').setDescription('no entries yet')] });
    const lines = entries.map(e => {
      const when = `<t:${Math.floor((e.ts || Date.now()) / 1000)}:R `;
      return `${when} **${e.giverTag || e.giverId}** tagged **${e.roblox}** as **${e.tag}**`;
    }).join('\n').slice(0, 4000);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`tag log last ${entries.length}`).setDescription(lines)] });
  }


  // /inrole
  if (commandName === 'inrole') {
    if (!guild) return interaction.reply({ content: 'server only', ephemeral: true });
    await interaction.deferReply();
    const role = interaction.options.getRole('role');
    await fetchMembersCached(guild);
    const members = guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(role.id));

    if (!members.size) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Members with ${role.name}`).setDescription('nobody has this role')] });

    const lines = [...members.values()]
      .sort((a, b) => a.user.username.localeCompare(b.user.username))
      .map((m, i) => `${String(i + 1).padStart(2, '0')} ${m} (${m.user.username})`)
      .join('\n');

    const chunks = [];
    const CHUNK = 4000;
    for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));

    for (let i = 0; i < chunks.length; i++) {
      const e = baseEmbed().setColor(0x2C2F33)
        .setTitle(i === 0 ? `Members with ${role.name}` : `Members with ${role.name} (cont.)`)
        .setDescription(chunks[i])
        .setFooter({ text: `${members.size} total member${members.size !== 1 ? 's' : ''}`, iconURL: getLogoUrl() });
      if (i === 0) await interaction.editReply({ embeds: [e] });
      else await interaction.followUp({ embeds: [e] });
    }
    return;
  }

  // /leaveserver (WL managers only)
  if (commandName === 'leaveserver') {
    if (!isWlManager(interaction.user.id))
      return interaction.reply({ content: 'only whitelist managers can use this command', ephemeral: true });

    const serverId = interaction.options.getString('serverid');

    if (serverId) {
      const targetGuild = client.guilds.cache.get(serverId);
      if (!targetGuild) return interaction.reply({ content: `I am not in a server with ID \`${serverId}\``, ephemeral: true });
      await interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`leaving **${targetGuild.name}**...`)], ephemeral: true });
      try { await targetGuild.leave(); } catch (e) { return interaction.editReply({ content: `couldn't leave ${e.message}` }); }
      return;
    }

    if (!guild) return interaction.reply({ content: 'use this in a server or provide a server id', ephemeral: true });
    await interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`leaving **${guild.name}**...`)], ephemeral: true });
    try { await guild.leave(); } catch (e) { return interaction.editReply({ content: `couldn't leave ${e.message}` }); }
    return;
  }

  // cleanup (delete non pinned messages)
  if (commandName === 'cleanup') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !isWlManager(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to use this', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const pinned = await channel.messages.fetchPinned();
      const pinnedIds = new Set(pinned.map(m => m.id));
      let deleted = 0;
      let lastId;
      while (true) {
        const opts = { limit: 100 };
        if (lastId) opts.before = lastId;
        const batch = await channel.messages.fetch(opts);
        if (!batch.size) break;
        const toDelete = batch.filter(m => !pinnedIds.has(m.id));
        if (toDelete.size > 0) { const removed = await channel.bulkDelete(toDelete, true); deleted += removed.size; }
        if (batch.size < 100) break;
        lastId = batch.last().id;
      }
      const confirm = await channel.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('channel cleaned up').setDescription(`deleted **${deleted}** message${deleted !== 1 ? 's' : ''} pinned messages were kept`).setTimestamp()] });
      setTimeout(() => confirm.delete().catch(() => {}), 8000);
      return interaction.editReply({ content: `cleaned up **${deleted}** messages` });
    } catch (err) { return interaction.editReply({ content: `couldn't clean up ${err.message}` }); }
  }

  // whoisin
  if (commandName === 'whoisin') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    const input = interaction.options.getString('game')?.trim();
    if (!input) return interaction.reply({ content: 'provide a Roblox game URL or place ID', ephemeral: true });
    await interaction.deferReply();
    await interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('fetching group members and game servers...')] });
    const WHOISIN_GROUP = 206868002;
    try {
      // Parse place ID supports:
      // roblox.com/games/start?placeId=123&gameInstanceId=...
      // roblox.com/games/123/game name
      // raw numeric place ID
      let placeId = null;
      const qsMatch = input.match(/[?&]place[iI][dD]=(\d+)/i);
      const pathMatch = input.match(/roblox\.com\/games\/(\d+)/i);
      if (qsMatch) placeId = qsMatch[1];
      else if (pathMatch) placeId = pathMatch[1];
      else if (/^\d+$/.test(input)) placeId = input;
      if (!placeId) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription("couldn't parse a place ID paste a Roblox game URL or server link, e.g. `roblox.com/games/start?placeId=123&gameInstanceId=...`")] });

      // Resolve place ID → universe ID
      const placeDetail = await (await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`)).json();
      const universeId = placeDetail?.data?.[0]?.universeId;
      if (!universeId) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`couldn't find a game for place ID \`${placeId}\` make sure the game exists and is public`)] });

      // Get game name
      let gameName = `Place ${placeId}`;
      try { const gr = await (await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)).json(); if (gr?.data?.[0]?.name) gameName = gr.data[0].name; } catch {}

      // Load all group members (paginated)
      await interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('loading group members...')] });
      const memberIds = new Set();
      const memberNames = {};
      let cur = '';
      do {
        try {
          const res = await (await fetch(`https://members.roblox.com/v1/groups/${WHOISIN_GROUP}/users?limit=100&sortOrder=Asc${cur ? `&cursor=${cur}` : ''}`)).json();
          for (const m of (res.data || [])) { memberIds.add(m.user.userId); memberNames[m.user.userId] = m.user.username; }
          cur = res.nextPageCursor || '';
        } catch { cur = ''; break; }
      } while (cur);
      if (!memberIds.size) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('could not load group members Roblox API may be unavailable')] });

      // Scan all public servers, collect player tokens
      await interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`loaded **${memberIds.size}** group members, scanning servers...`)] });
      const allTokens = [];
      let sCur = ''; let serverCount = 0;
      do {
        try {
          const res = await (await fetch(`https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=100${sCur ? `&cursor=${sCur}` : ''}`)).json();
          for (const srv of (res.data || [])) { serverCount++; for (const p of (srv.players || [])) { if (p.playerToken) allTokens.push(p.playerToken); } }
          sCur = res.nextPageCursor || '';
        } catch { sCur = ''; break; }
      } while (sCur);

      if (!allTokens.length) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`scanned **${serverCount}** server${serverCount !== 1 ? 's' : ''} no players found (game may be empty or servers private)`)] });

      // Resolve player tokens → Roblox user IDs via thumbnail batch API
      await interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`resolving **${allTokens.length}** player${allTokens.length !== 1 ? 's' : ''} across **${serverCount}** server${serverCount !== 1 ? 's' : ''}...`)] });
      const resolvedIds = new Set();
      for (let i = 0; i < allTokens.length; i += 100) {
        try {
          const batch = allTokens.slice(i, i + 100).map((token, idx) => ({ requestId: `${i + idx}`, token, type: 'AvatarHeadShot', size: '150x150', format: 'png', isCircular: false }));
          const res = await (await fetch('https://thumbnails.roblox.com/v1/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) })).json();
          for (const item of (res.data || [])) { if (item.targetId && item.targetId !== 0) resolvedIds.add(item.targetId); }
        } catch {}
      }

      // Filter to group members only
      const inGame = [...resolvedIds].filter(id => memberIds.has(id));
      if (!inGame.length) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`no group members found in **${gameName}**\n*(checked ${serverCount} server${serverCount !== 1 ? 's' : ''}, ${resolvedIds.size} total player${resolvedIds.size !== 1 ? 's' : ''})*`)] });

      const lines = inGame.map(id => `• \`${memberNames[id] || id}\``).join('\n');
      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle(`Group members in ${gameName}`)
        .setDescription(`**${inGame.length}** group member${inGame.length !== 1 ? 's' : ''} currently in game:\n\n${lines}`)
        .setFooter({ text: `${serverCount} server${serverCount !== 1 ? 's' : ''} scanned • group ${WHOISIN_GROUP}` })
        .setTimestamp()] });
    } catch (err) { return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`whoisin failed ${err.message}`)] }); }
  }

  // attend
  if (commandName === 'attend') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    const targetMember = interaction.options.getMember('user');
    const roblox = interaction.options.getString('roblox') || 'unknown';
    if (!targetMember) return interaction.reply({ content: "could not find that member", ephemeral: true });
    const queueData = loadQueue();
    const queueChannelId = queueData[guild.id]?.channelId;
    const queueChannel = queueChannelId ? (guild.channels.cache.get(queueChannelId) ?? channel) : channel;

    // Look up Roblox avatar for the embed thumbnail
    let attendAvatarUrl = null;
    try {
      const robloxRes = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [roblox], excludeBannedUsers: false })
      })).json();
      const robloxUserId = robloxRes.data?.[0]?.id;
      if (robloxUserId) {
        const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUserId}&size=420x420&format=Png&isCircular=false`)).json();
        attendAvatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
      }
    } catch {}

    const attendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid').setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .addFields({ name: 'Discord', value: `${targetMember}`, inline: false }, { name: 'Roblox', value: `\`${roblox}\``, inline: false })
      .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() });
    if (attendAvatarUrl) attendEmbed.setThumbnail(attendAvatarUrl);
    await queueChannel.send({ embeds: [attendEmbed] });
    addRaidStat(guild.id, targetMember.id);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`logged **${targetMember.displayName}** to ${queueChannel}`)], ephemeral: true });
  }

  // setattendance
  if (commandName === 'setattendance') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !isWlManager(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to set the queue channel', ephemeral: true });
    const ch = interaction.options.getChannel('channel');
    if (!ch?.isTextBased()) return interaction.reply({ content: 'that must be a text channel', ephemeral: true });
    const queueData = loadQueue();
    if (!queueData[guild.id]) queueData[guild.id] = {};
    queueData[guild.id].channelId = ch.id;
    saveQueue(queueData);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Queue Channel Set').setDescription(`raid attendance logs will now post to ${ch}`).setTimestamp()] });
  }

  // setraidvc
  if (commandName === 'setraidvc') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !isWlManager(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to use this', ephemeral: true });
    const vc = interaction.options.getChannel('channel');
    if (!vc || vc.type !== 2) return interaction.reply({ content: 'that must be a voice channel', ephemeral: true });
    const qData = loadQueue();
    if (!qData[guild.id]) qData[guild.id] = {};
    qData[guild.id].raidVcId = vc.id;
    qData[guild.id].vcLogged = [];
    saveQueue(qData);
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Raid Voice Channel Set').setDescription(`attendance will now be auto logged when verified group members join ${vc}\n\nThe logged list resets whenever you set a new channel.`).setTimestamp()] });
  }

  // rollcall
  if (commandName === 'rollcall') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !isWlManager(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to use this', ephemeral: true });
    const rcEmbed = new EmbedBuilder().setColor(0x2C2F33)
      .setTitle('RAID QUEUE')
      .setDescription('REACT TO THIS MESSAGE IF YOU ARE IN GAME/ IN QUEUE.');
    const rcMsg = await interaction.reply({ embeds: [rcEmbed], fetchReply: true });
    await rcMsg.react('✅');
    const qData = loadQueue();
    if (!qData[guild.id]) qData[guild.id] = {};
    qData[guild.id].rollCall = { messageId: rcMsg.id, channelId: rcMsg.channelId };
    saveQueue(qData);
  }

  // endrollcall
  if (commandName === 'endrollcall') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !isWlManager(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to use this', ephemeral: true });
    const qData = loadQueue();
    const rc = qData[guild.id]?.rollCall;
    if (!rc) return interaction.reply({ content: 'no active roll call start one with `/rollcall` first', ephemeral: true });
    await interaction.deferReply();
    try {
      const rcChannel = guild.channels.cache.get(rc.channelId);
      if (!rcChannel) return interaction.editReply({ content: "couldn't find the roll call channel" });
      const rcMsg = await rcChannel.messages.fetch(rc.messageId);
      const reaction = rcMsg.reactions.cache.get('✅');
      let reactors = [];
      if (reaction) {
        await reaction.users.fetch();
        reactors = [...reaction.users.cache.values()].filter(u => !u.bot);
      }
      if (!reactors.length) {
        delete qData[guild.id].rollCall;
        saveQueue(qData);
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('roll call closed no reactions found')] });
      }
      const vData = loadVerify();
      const queueChannelId = qData[guild.id]?.channelId;
      const queueChannel = queueChannelId ? guild.channels.cache.get(queueChannelId) : null;
      // new rollcall summary channel
      const rollCallChannelId = qData[guild.id]?.rollCallChannelId;
      const rollCallChannel = rollCallChannelId ? guild.channels.cache.get(rollCallChannelId) : null;
      let logged = 0; const skipped = []; const loggedEntries = [];
      const summaryRows = [];
      for (const user of reactors) {
        const userVerify = vData.verified?.[user.id];
        if (!userVerify) { skipped.push(user); continue; }
        let avatarUrl = null;
        try {
          const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userVerify.robloxId}&size=420x420&format=Png&isCircular=false`)).json();
          avatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
        } catch {}
        const rcAttendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
          .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
          .addFields({ name: 'Discord', value: `<@${user.id}> `, inline: false }, { name: 'Roblox', value: `\`${userVerify.robloxName}\``, inline: false })
          .setTimestamp().setFooter({ text: `roll call • ${getBotName()}`, iconURL: getLogoUrl() });
        if (avatarUrl) rcAttendEmbed.setThumbnail(avatarUrl);
        if (queueChannel) { await queueChannel.send({ embeds: [rcAttendEmbed] }); addRaidStat(guild.id, user.id); }
        else if (rollCallChannel) { addRaidStat(guild.id, user.id); }
        loggedEntries.push({ discordId: user.id, robloxName: userVerify.robloxName });
        summaryRows.push({ discordId: user.id, discordName: user.username, robloxId: userVerify.robloxId, robloxName: userVerify.robloxName });
        logged++;
        await new Promise(r => setTimeout(r, 300));
      }
      // big summary in the rollcall channel — clickable discord + roblox names
      if (rollCallChannel && summaryRows.length) {
        const lines = summaryRows.map((r, i) =>
          `**${i + 1}.** [${r.discordName}](https://discord.com/users/${r.discordId}) — Roblox: [${r.robloxName}](https://www.roblox.com/users/${r.robloxId}/profile)`
        );
        const skippedLine = skipped.length ? `\n\n*${skipped.length} skipped (not registered)*` : '';
        const summaryEmbed = baseEmbed().setColor(0x2C2F33)
          .setTitle('Rollcall — Who Was In')
          .setDescription(lines.join('\n') + skippedLine)
          .setFooter({ text: `${summaryRows.length} member${summaryRows.length !== 1 ? 's' : ''} • closed by ${interaction.user.username} • ${getBotName()}`, iconURL: getLogoUrl() })
          .setTimestamp();
        try { await rollCallChannel.send({ embeds: [summaryEmbed] }); } catch (e) { console.error('rollcall summary post failed:', e.message); }
      }
      appendAtLog(guild.id, { ts: Date.now(), by: interaction.user.id, channelId: rc.channelId, queueChannelId: queueChannel?.id || null, logged: loggedEntries, skipped: skipped.map(u => u.id) });
      delete qData[guild.id].rollCall;
      saveQueue(qData);
      const skipNote = skipped.length ? `\n${skipped.length} skipped (not registered)` : '';
      const summaryNote = rollCallChannel ? `\nsummary posted to ${rollCallChannel}` : (rollCallChannelId ? '\n(rollcall channel set but couldnt find it, check perms)' : `\nset a summary channel with \`/setrollcallchannel\``);
      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Roll Call Closed').setDescription(`logged **${logged}** member${logged !== 1 ? 's' : ''}${queueChannel ? ` to ${queueChannel}` : ''}${skipNote}${summaryNote}`).setTimestamp()] });
    } catch (err) {
      return interaction.editReply({ content: `failed to close roll call ${err.message}` });
    }
  }

  // /pregister
  if (commandName === 'pregister') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use `/pregister`', ephemeral: true });

    const robloxInput  = interaction.options.getString('roblox')?.trim();
    const targetUser   = interaction.options.getUser('user');
    const rawId        = interaction.options.getString('userid')?.trim();

    if (!targetUser && !rawId) return interaction.reply({ content: 'provide a Discord user via the `user` option or their ID via `userid`', ephemeral: true });
    const discordId = targetUser ? targetUser.id : rawId.replace(/[<@!>]/g, '');
    if (!/^\d{17,20}$/.test(discordId)) return interaction.reply({ content: "that doesn't look like a valid Discord user ID", ephemeral: true });

    let resolvedUser = targetUser;
    if (!resolvedUser) {
      try { resolvedUser = await client.users.fetch(discordId); } catch { return interaction.reply({ content: "could not find that Discord user", ephemeral: true }); }
    }

    await interaction.deferReply();
    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [robloxInput], excludeBannedUsers: false })
      })).json();
      const robloxUser = res.data?.[0];
      if (!robloxUser) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`could not find a Roblox user named \`${robloxInput}\``)] });

      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};

      const existingDiscordId = vData.robloxToDiscord[String(robloxUser.id)];
      if (existingDiscordId && existingDiscordId !== discordId) {
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33)
          .setDescription(`\`${robloxUser.name}\` is already registered to a different Discord account`)] });
      }

      const prevEntry = vData.verified[discordId];
      if (prevEntry && String(prevEntry.robloxId) !== String(robloxUser.id)) {
        delete vData.robloxToDiscord[String(prevEntry.robloxId)];
      }

      vData.verified[discordId]                    = { robloxId: robloxUser.id, robloxName: robloxUser.name, verifiedAt: Date.now() };
      vData.robloxToDiscord[String(robloxUser.id)] = discordId;
      saveVerify(vData);
      saveLinkedVerified(vData);

      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json();
      const avatarUrl  = avatarData.data?.[0]?.imageUrl ?? null;

      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Registration Successful')
        .setThumbnail(avatarUrl ?? getLogoUrl())
        .setDescription(`<@${discordId}> is now registered as **${robloxUser.name}**`)
        .addFields(
          { name: 'Discord',       value: `<@${discordId}> `, inline: true },
          { name: 'Roblox',        value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true },
          { name: 'registered by', value: `<@${interaction.user.id}> `, inline: true }
        ).setTimestamp()] });
    } catch (err) { return interaction.editReply({ content: `pregister failed ${err.message}` }); }
  }

  // /verify
  if (commandName === 'verify') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use `/verify`', ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === 'role') {
      const action = interaction.options.getString('action');
      if (action === 'set') {
        const role = interaction.options.getRole('role');
        if (!role) return interaction.reply({ content: 'provide a role to set', ephemeral: true });
        const cfg = loadConfig(); cfg.verifyRoleId = role.id; saveConfig(cfg);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('verify role set')
          .addFields({ name: 'role', value: `${role}`, inline: true }, { name: 'set by', value: interaction.user.tag, inline: true }).setTimestamp()] });
      }
      if (action === 'remove') {
        const cfg = loadConfig(); delete cfg.verifyRoleId; saveConfig(cfg);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('verify role removed')] });
      }
    }

    if (sub === 'user') {
      const cfg = loadConfig();
      if (!cfg.verifyRoleId) return interaction.reply({ content: 'no verify role set use `/verify role set` first', ephemeral: true });
      const target = interaction.options.getMember('user');
      if (!target) return interaction.reply({ content: "could not find that member", ephemeral: true });
      const role = guild.roles.cache.get(cfg.verifyRoleId);
      if (!role) return interaction.reply({ content: "couldn't find the configured verify role it may have been deleted", ephemeral: true });
      if (target.roles.cache.has(role.id)) return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`<@${target.id}> already has ${role}`)], ephemeral: true });
      try {
        await target.roles.add(role);
        return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('verified')
          .addFields(
            { name: 'user',        value: `<@${target.id}> `, inline: true },
            { name: 'role',        value: `${role}`, inline: true },
            { name: 'verified by', value: interaction.user.tag, inline: true }
          ).setTimestamp()] });
      } catch { return interaction.reply({ content: "couldn't add the role check my permissions", ephemeral: true }); }
    }
  }

  // registeredlist
  if (commandName === 'registeredlist') {
    await interaction.deferReply();
    const vData = loadVerify();
    const entries = Object.entries(vData.verified || {});
    if (!entries.length) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Verified Accounts').setDescription('no one has linked their Roblox account yet')] });
    const lines = entries.map(([discordId, { robloxName, robloxId }]) => `<@${discordId}> → [\`${robloxName}\`](https://www.roblox.com/users/${robloxId}/profile)`);
    const PAGE_SIZE = 20; const pages = []; for (let i = 0; i < lines.length; i += PAGE_SIZE) pages.push(lines.slice(i, i + PAGE_SIZE));
    const totalPages = pages.length;
    const buildPage = (idx) => baseEmbed().setColor(0x2C2F33).setTitle(`Verified Accounts [${entries.length}]`).setDescription(pages[idx].join('\n')).setFooter({ text: `Page ${idx + 1} of ${totalPages} • ${getBotName()}`, iconURL: getLogoUrl() });
    const buildRow = (idx) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rlist ${idx - 1}`).setLabel('‹ Back').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
      new ButtonBuilder().setCustomId(`rlist ${idx + 1}`).setLabel('Next ›').setStyle(ButtonStyle.Secondary).setDisabled(idx === totalPages - 1)
    );
    return interaction.editReply({ embeds: [buildPage(0)], components: totalPages > 1 ? [buildRow(0)] : [] });
  }

  // linked
  if (commandName === 'linked') {
    await interaction.deferReply();
    const vData = loadVerify();
    const targetUser = interaction.options.getUser('user');
    const robloxInput = interaction.options.getString('roblox');
    if (!targetUser && !robloxInput) return interaction.editReply({ content: 'provide a Discord user or Roblox username' });
    if (targetUser) {
      const linked = vData.verified?.[targetUser.id];
      if (!linked) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`<@${targetUser.id}> has no linked Roblox account`)] });
      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Linked Account').addFields({ name: 'Discord', value: `<@${targetUser.id}> `, inline: true }, { name: 'Roblox', value: `[\`${linked.robloxName}\`](https://www.roblox.com/users/${linked.robloxId}/profile)`, inline: true }).setTimestamp(new Date(linked.verifiedAt))] });
    }
    let robloxUser;
    try { const res = await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [robloxInput], excludeBannedUsers: false }) })).json(); robloxUser = res.data?.[0]; } catch {}
    if (!robloxUser) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`couldn't find Roblox user \`${robloxInput}\``)] });
    const discordId = vData.robloxToDiscord?.[String(robloxUser.id)];
    if (!discordId) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`\`${robloxUser.name}\` has no linked Discord account`)] });
    return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Linked Account').addFields({ name: 'Roblox', value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true }, { name: 'Discord', value: `<@${discordId}> `, inline: true })] });
  }

  // rfile
  if (commandName === 'rfile') {
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use `/rfile`', ephemeral: true });
    await interaction.deferReply();
    const vData = loadVerify();
    const entries = Object.entries(vData.verified || {});
    if (!entries.length) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('no registered members yet use `/pregister` to add members')] });
    const lines = entries.map(([discordId, { robloxName }]) => `<@${discordId}> \`${robloxName}\``);
    const PAGE_SIZE = 20;
    const pages = [];
    for (let i = 0; i < lines.length; i += PAGE_SIZE) pages.push(lines.slice(i, i + PAGE_SIZE).join('\n'));
    // build export JSON same format as linked verified.json
    const exportObj = {};
    for (const [discordId, info] of entries) {
      exportObj[discordId] = { discordId, robloxId: info.robloxId, robloxName: info.robloxName, verifiedAt: info.verifiedAt };
    }
    const exportBuf = Buffer.from(JSON.stringify(exportObj, null, 2), 'utf8');
    const exportAttachment = new AttachmentBuilder(exportBuf, { name: 'registered members.json' });
    const embed = baseEmbed().setColor(0x2C2F33)
      .setTitle(`Registered Members (${entries.length})`)
      .setDescription(pages[0])
      .setFooter({ text: `page 1 of ${pages.length} • ${entries.length} registered member${entries.length !== 1 ? 's' : ''}`, iconURL: getLogoUrl() })
      .setTimestamp();
    if (pages.length === 1) return interaction.editReply({ embeds: [embed], files: [exportAttachment] });
    let page = 0;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rfile prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('rfile next').setLabel('▶').setStyle(ButtonStyle.Secondary)
    );
    const msg = await interaction.editReply({ embeds: [embed], files: [exportAttachment], components: [row] });
    const collector = msg.createMessageComponentCollector({ time: 120000 });
    collector.on('collect', async btn => {
      if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'you did not run this command', ephemeral: true });
      if (btn.customId === 'rfile next') page = Math.min(page + 1, pages.length - 1);
      else page = Math.max(page - 1, 0);
      const updEmbed = baseEmbed().setColor(0x2C2F33)
        .setTitle(`Registered Members (${entries.length})`)
        .setDescription(pages[page])
        .setFooter({ text: `page ${page + 1} of ${pages.length} • ${entries.length} registered member${entries.length !== 1 ? 's' : ''}`, iconURL: getLogoUrl() })
        .setTimestamp();
      const updRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rfile prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('rfile next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length - 1)
      );
      await btn.update({ embeds: [updEmbed], components: [updRow] });
    });
    collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
    return;
  }

  // ingame
  if (commandName === 'ingame') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    const inputUsername = interaction.options.getString('username')?.trim();
    if (!inputUsername) return interaction.reply({ content: 'provide a Roblox username', ephemeral: true });
    await interaction.deferReply();
    await interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`looking up **${inputUsername}** on Roblox...`)] });
    try {
      const userRes = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [inputUsername], excludeBannedUsers: false })
      })).json();
      const targetUser = userRes.data?.[0];
      if (!targetUser) return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`could not find a Roblox user named \`${inputUsername}\``)] });
      await interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`checking **${targetUser.name}**'s current game...`)] });
      const presRes = await (await fetch('https://presence.roblox.com/v1/presence/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [targetUser.id] })
      })).json();
      const targetPresence = presRes.userPresences?.[0];
      if (!targetPresence || targetPresence.userPresenceType !== 2 || (!targetPresence.gameId && !targetPresence.placeId && !targetPresence.rootPlaceId)) {
        return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`**${targetUser.name}** is not currently in a Roblox game`)] });
      }
      const { gameId, placeId, rootPlaceId } = targetPresence;
      const exactServerMatch = !!gameId;
      let gameName = `Place ${rootPlaceId || placeId}`;
      try {
        const plDetail = await (await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${rootPlaceId || placeId}`)).json();
        const univId = plDetail?.data?.[0]?.universeId;
        if (univId) {
          const gr = await (await fetch(`https://games.roblox.com/v1/games?universeIds=${univId}`)).json();
          if (gr?.data?.[0]?.name) gameName = gr.data[0].name;
        }
      } catch {}
      const vData = loadVerify();
      const allRegistered = Object.entries(vData.verified || {});
      await interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`**${targetUser.name}** is in **${gameName}** fetching group members & checking presence...`)] });
      // Fetch all group members (registered + unregistered)
      const groupMembers = await fetchGroupMemberIds(ATTEND_GROUP_ID);
      const allGroupIds = [...groupMembers];
      // Build quick lookup maps from registered data
      const registeredRobloxToDiscord = vData.robloxToDiscord || {};
      const registeredRobloxToName = {};
      for (const [, v] of allRegistered) {
        if (v.robloxId) registeredRobloxToName[String(v.robloxId)] = v.robloxName;
      }
      const inSameServer = [];
      for (let i = 0; i < allGroupIds.length; i += 50) {
        try {
          const batch = allGroupIds.slice(i, i + 50);
          const bRes = await (await fetch('https://presence.roblox.com/v1/presence/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: batch })
          })).json();
          for (const p of (bRes.userPresences || [])) {
            if (String(p.userId) === String(targetUser.id)) continue;
            const inSamePlace = (rootPlaceId && p.rootPlaceId && String(p.rootPlaceId) === String(rootPlaceId)) ||
                                (placeId && p.placeId && String(p.placeId) === String(placeId));
            const match = exactServerMatch ? (p.gameId === gameId) : inSamePlace;
            if (match) {
              const discordId = registeredRobloxToDiscord[String(p.userId)] || null;
              const robloxName = registeredRobloxToName[String(p.userId)] || null;
              inSameServer.push({ discordId, robloxName, robloxId: p.userId });
            }
          }
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
      // Resolve usernames for unregistered members found in same server
      const needsName = inSameServer.filter(m => !m.robloxName);
      if (needsName.length) {
        try {
          const nameRes = await (await fetch('https://users.roblox.com/v1/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: needsName.map(m => m.robloxId), excludeBannedUsers: false })
          })).json();
          for (const u of (nameRes.data || [])) {
            const entry = inSameServer.find(m => String(m.robloxId) === String(u.id));
            if (entry) entry.robloxName = u.name;
          }
        } catch {}
      }
      // Fill any still missing names with the ID as fallback
      for (const m of inSameServer) { if (!m.robloxName) m.robloxName = String(m.robloxId); }
      // Post attendance embeds to the attendance channel all members (registered + unregistered)
      const queueData = loadQueue();
      const queueChannelId = queueData[guild.id]?.channelId;
      const queueChannel = queueChannelId ? (guild.channels.cache.get(queueChannelId) ?? null) : null;
      const registeredInSameServer = inSameServer.filter(m => m.discordId);
      const unregisteredInSameServer = inSameServer.filter(m => !m.discordId);
      if (queueChannel) {
        for (const { discordId, robloxName, robloxId } of registeredInSameServer) {
          let ingameAvatarUrl = null;
          try {
            const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=420x420&format=Png&isCircular=false`)).json();
            ingameAvatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
          } catch {}
          const ingameEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
            .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
            .addFields({ name: 'Discord', value: `<@${discordId}> `, inline: false }, { name: 'Roblox', value: `\`${robloxName}\``, inline: false })
            .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() });
          if (ingameAvatarUrl) ingameEmbed.setThumbnail(ingameAvatarUrl);
          await queueChannel.send({ embeds: [ingameEmbed] });
          addRaidStat(guild.id, discordId);
          await new Promise(r => setTimeout(r, 300));
        }
        for (const { robloxName, robloxId } of unregisteredInSameServer) {
          let ingameAvatarUrl = null;
          try {
            const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=420x420&format=Png&isCircular=false`)).json();
            ingameAvatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
          } catch {}
          const unregEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('unregistered user joined this raid')
            .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
            .addFields({ name: 'Roblox', value: `[\`${robloxName}\`](https://www.roblox.com/users/${robloxId}/profile)`, inline: false }, { name: 'Status', value: 'not mverify\'d', inline: false })
            .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() });
          if (ingameAvatarUrl) unregEmbed.setThumbnail(ingameAvatarUrl);
          await queueChannel.send({ embeds: [unregEmbed] });
          await new Promise(r => setTimeout(r, 300));
        }
      }
      const totalInServer = registeredInSameServer.length + unregisteredInSameServer.length;
      const formatLine = ({ discordId, robloxName }) => discordId ? `<@${discordId}> \`${robloxName}\`` : `\`${robloxName}\` not mverify'd`;
      const ingameSection = totalInServer ? `**In same server (${totalInServer})**\n${inSameServer.map(formatLine).join('\n')}` : '**In same server** none';
      const attendNote = queueChannel && totalInServer ? `\n\n*logged ${totalInServer} member${totalInServer !== 1 ? 's' : ''} to ${queueChannel}*` : '';
      const scopeNote = exactServerMatch ? 'exact server' : 'same game (server ID private)';
      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle(`Members ${gameName}`)
        .setDescription(`${ingameSection}${attendNote}`)
        .setFooter({ text: `${allGroupIds.length} group members checked • ${scopeNote}` })
        .setTimestamp()] });
    } catch (err) { return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`ingame failed ${err.message}`)] }); }
  }

  // lvfile
  if (commandName === 'lvfile') {
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use this', ephemeral: true });
    if (!fs.existsSync(LINKED_VERIFIED_FILE)) return interaction.reply({ embeds: [errorEmbed('file not found').setDescription('`linked verified.json` does not exist yet no one has verified')], ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const data = fs.readFileSync(LINKED_VERIFIED_FILE);
    const count = Object.keys(JSON.parse(data)).length;
    const attachment = new AttachmentBuilder(data, { name: 'linked verified.json' });
    return interaction.editReply({ embeds: [successEmbed('Linked & Verified Export').setDescription(`**${count}** linked account${count !== 1 ? 's' : ''} in file`).setTimestamp()], files: [attachment] });
  }

  // import
  if (commandName === 'import') {
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use `/import`', ephemeral: true });
    const fileAttachment = interaction.options.getAttachment('file');
    if (!fileAttachment || !fileAttachment.name.endsWith('.json')) return interaction.reply({ content: 'attach a `.json` file exported from `/rfile` or `/lvfile`', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const res = await fetch(fileAttachment.url);
      const raw = await res.json();
      if (typeof raw !== 'object' || Array.isArray(raw)) return interaction.editReply({ content: 'invalid file format expected a JSON object with Discord IDs as keys' });
      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};
      let added = 0, updated = 0, skippedCount = 0;
      for (const [discordId, info] of Object.entries(raw)) {
        if (!info?.robloxId || !info?.robloxName) { skippedCount++; continue; }
        const rid = String(info.robloxId);
        const existingDiscordForRoblox = vData.robloxToDiscord[rid];
        if (existingDiscordForRoblox && existingDiscordForRoblox !== discordId) { skippedCount++; continue; }
        const prevEntry = vData.verified[discordId];
        if (prevEntry && String(prevEntry.robloxId) !== rid) delete vData.robloxToDiscord[String(prevEntry.robloxId)];
        const isNew = !vData.verified[discordId];
        vData.verified[discordId] = { robloxId: info.robloxId, robloxName: info.robloxName, verifiedAt: info.verifiedAt ?? Date.now() };
        vData.robloxToDiscord[rid] = discordId;
        if (isNew) added++; else updated++;
      }
      saveVerify(vData);
      saveLinkedVerified(vData);
      const total = Object.keys(vData.verified).length;
      return interaction.editReply({ embeds: [successEmbed('Import Complete').addFields(
        { name: 'Added', value: String(added), inline: true },
        { name: 'Updated', value: String(updated), inline: true },
        { name: 'Skipped', value: String(skippedCount), inline: true },
        { name: 'Total Registered', value: String(total), inline: false }
      ).setTimestamp()] });
    } catch (err) { return interaction.editReply({ content: `import failed ${err.message}` }); }
  }

  // rid
  if (commandName === 'rid') {
    await interaction.deferReply();
    const input = interaction.options.getString('id');
    if (!/^\d+$/.test(input)) return interaction.editReply({ content: 'provide a numeric Roblox ID e.g. `1`' });
    try {
      const [user, avatarRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${input}`).then(r => r.json()),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${input}&size=420x420&format=Png&isCircular=false`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      if (user.errors || !user.name) return interaction.editReply({ content: "could not find a Roblox user with that ID" });
      const profileUrl = `https://www.roblox.com/users/${input}/profile`;
      const avatarUrl = avatarRes.data?.[0]?.imageUrl;
      const created = new Date(user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const e = baseEmbed().setColor(0x2C2F33).setTitle(`${user.displayName} (@${user.name})`).setURL(profileUrl).setThumbnail(avatarUrl).setDescription(`[View Profile](${profileUrl})`).addFields({ name: '🆔 User ID', value: `\`${input}\``, inline: true }, { name: '👤 Username', value: user.name, inline: true }, { name: '📅 Created', value: created, inline: true }).setTimestamp();
      const joinBtn = await buildJoinButton(input);
      return interaction.editReply({ embeds: [e], components: [new ActionRowBuilder().addComponents(joinBtn)] });
    } catch { return interaction.editReply({ content: 'something went wrong fetching that user, try again' }); }
  }

  // rankup
  if (commandName === 'rankup') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    await interaction.deferReply();
    const rankupData = loadRankup();
    const guildRanks = rankupData[guild.id]?.roles || [];
    if (!guildRanks.length) return interaction.editReply({ content: 'no rank roles set use `/setrankroles set` to configure the rank ladder' });
    const levels = interaction.options.getInteger('levels') || 1;
    await fetchMembersCached(guild);
    await guild.roles.fetch();
    const targets = []; const seenIds = new Set();
    for (let i = 1; i <= 5; i++) { const m = interaction.options.getMember(`user${i}`); if (m && !seenIds.has(m.id)) { targets.push(m); seenIds.add(m.id); } }
    if (!targets.length) return interaction.editReply({ content: "couldn't find any users to rank up" });
    let completed = 0, skipped = 0; const rolesAwarded = []; const skipReasons = [];
    for (const member of targets) {
      try {
        await member.fetch();
        let currentIdx = -1;
        for (let i = guildRanks.length - 1; i >= 0; i--) { if (member.roles.cache.has(guildRanks[i])) { currentIdx = i; break; } }
        const nextIdx = currentIdx + levels;
        if (nextIdx >= guildRanks.length) { skipped++; skipReasons.push(`${member.displayName} already at highest rank`); continue; }
        const newRoleId = guildRanks[nextIdx];
        const newRole = guild.roles.cache.get(newRoleId) ?? await guild.roles.fetch(newRoleId).catch(() => null);
        if (!newRole) { skipped++; skipReasons.push(`${member.displayName} target role not found`); continue; }
        for (const rId of guildRanks) { if (rId !== newRoleId && member.roles.cache.has(rId)) await member.roles.remove(rId).catch(() => {}); }
        await member.roles.add(newRoleId); rolesAwarded.push({ member, roleName: newRole.name }); completed++;
      } catch (err) { skipped++; skipReasons.push(`${member.displayName} ${err.message}`); }
    }
    const total = completed + skipped;
    const resultLines = ['RESULT COUNT', ' ', `COMPLETED ${completed}`, `SKIPPED ${skipped}`, `TOTAL ${total}`].join('\n');
    const embeds = [baseEmbed().setTitle('Rankup Complete').setColor(0x2C2F33).setDescription('```\n' + resultLines + '\n```').setTimestamp()];
    if (rolesAwarded.length) embeds.push(baseEmbed().setTitle('ROLES AWARDED').setColor(0x2C2F33).setDescription(rolesAwarded.map(({ member, roleName }) => `${member} ${roleName}`).join('\n')).setTimestamp());
    if (skipReasons.length) embeds.push(baseEmbed().setTitle('SKIPPED').setColor(0x555555).setDescription(skipReasons.join('\n')).setTimestamp());
    return interaction.editReply({ content: '', embeds });
  }

  // setrankroles
  if (commandName === 'setrankroles') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    if (!loadWhitelist().includes(interaction.user.id) && !isWlManager(interaction.user.id))
      return interaction.reply({ content: 'you need to be whitelisted to configure rank roles', ephemeral: true });
    const action = interaction.options.getString('action');
    if (action === 'clear') {
      const rankupData = loadRankup(); delete rankupData[guild.id]; saveRankup(rankupData);
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('rank roles cleared for this server')] });
    }
    if (action === 'list') {
      const guildRanks = loadRankup()[guild.id]?.roles || [];
      if (!guildRanks.length) return interaction.reply({ content: 'no rank roles set use `/setrankroles set` and pick roles', ephemeral: true });
      const lines = guildRanks.map((id, i) => `**${i + 1}.** <@&${id}> `).join('\n');
      return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rank Ladder').setDescription(lines).setTimestamp()] });
    }
    const collectedIds = []; const seenRoles = new Set();
    for (let i = 1; i <= 5; i++) { const r = interaction.options.getRole(`role${i}`); if (r && !seenRoles.has(r.id)) { collectedIds.push(r.id); seenRoles.add(r.id); } }
    if (!collectedIds.length) return interaction.reply({ content: 'provide at least one role for the rank ladder', ephemeral: true });
    const rankupData = loadRankup();
    if (!rankupData[guild.id]) rankupData[guild.id] = {};
    rankupData[guild.id].roles = collectedIds;
    saveRankup(rankupData);
    const lines = collectedIds.map((id, i) => `**${i + 1}.** <@&${id}> `).join('\n');
    return interaction.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rank Ladder Set').setDescription(lines).setFooter({ text: `${collectedIds.length} rank${collectedIds.length !== 1 ? 's' : ''} configured • lowest → highest`, iconURL: getLogoUrl() }).setTimestamp()] });
  }

  // fileroles
  if (commandName === 'fileroles') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    const guildRanks = loadRankup()[guild.id]?.roles || [];
    if (!guildRanks.length) return interaction.reply({ content: 'no rank roles configured use `/setrankroles set` first', ephemeral: true });
    await interaction.deferReply();
    const rows = guildRanks.map((id, i) => {
      const role = guild.roles.cache.get(id);
      return { rank: i + 1, roleId: id, roleName: role?.name ?? 'unknown' };
    });
    const json = JSON.stringify({ guildId: guild.id, guildName: guild.name, updatedAt: new Date().toISOString(), rankLadder: rows }, null, 2);
    const buf = Buffer.from(json, 'utf8');
    const attachment = new AttachmentBuilder(buf, { name: `rank ladder ${guild.id}.json` });
    const lines = rows.map(r => `**${r.rank}.** <@&${r.roleId}> \`${r.roleName}\``).join('\n');
    return interaction.editReply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Rank Ladder ${guild.name}`)
        .setDescription(lines)
        .setFooter({ text: `${rows.length} rank${rows.length !== 1 ? 's' : ''} • lowest → highest`, iconURL: getLogoUrl() })
        .setTimestamp()],
      files: [attachment]
    });
  }

  // servers
  if (commandName === 'servers') {
    if (!isWlManager(interaction.user.id)) return interaction.reply({ content: 'only whitelist managers can use this', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!guilds.length) return interaction.editReply({ content: 'not in any servers' });
    const lines = guilds.map((g, i) => `\`${String(i + 1).padStart(2, '0')}\` **${g.name}** \`${g.id}\` (${g.memberCount} members)`);
    const chunks = []; const CHUNK = 4000; let current = '';
    for (const line of lines) { if ((current + '\n' + line).length > CHUNK) { chunks.push(current); current = line; } else { current = current ? current + '\n' + line : line; } }
    if (current) chunks.push(current);
    const embeds = chunks.map((c, i) => baseEmbed().setColor(0x2C2F33).setTitle(i === 0 ? `Servers (${guilds.length})` : 'Servers (cont.)').setDescription(c));
    return interaction.editReply({ embeds: embeds.slice(0, 10) });
  }

  // img2gif
  if (commandName === 'img2gif') {
    if (!guild) return interaction.reply({ content: 'this only works in a server', ephemeral: true });
    const attachment = interaction.options.getAttachment('image');
    if (!attachment) return interaction.reply({ content: 'attach an image to convert', ephemeral: true });
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (attachment.contentType && !validTypes.some(t => attachment.contentType.startsWith(t.split('/')[0] + '/')))
      return interaction.reply({ content: "that file type isn't supported send a PNG, JPG, or WEBP", ephemeral: true });
    if (attachment.contentType?.includes('gif')) return interaction.reply({ content: "that's already a GIF", ephemeral: true });
    await interaction.deferReply();
    try {
      const sharp = (await import('sharp')).default;
      const dlRes = await fetch(attachment.url);
      const inputBuf = Buffer.from(await dlRes.arrayBuffer());
      const gifBuf = await sharp(inputBuf).gif().toBuffer();
      const gifAttachment = new AttachmentBuilder(gifBuf, { name: 'converted.gif' });
      return interaction.editReply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Image Converted').setDescription('here is your GIF').setTimestamp()], files: [gifAttachment] });
    } catch (err) { return interaction.editReply({ content: `conversion failed ${err.message}\n\nmake sure \`sharp\` is installed (\`npm install sharp\`)` }); }
  }

  // slash → prefix bridge: any chat input command not handled above falls
  // through here. We re dispatch as a prefix command so every prefix only
  // command also works as a slash command.
  if (interaction.isChatInputCommand && interaction.isChatInputCommand() && !interaction.replied && !interaction.deferred) {
    try {
      const fakeMsg = buildFakeMessageFromInteraction(interaction);
      if (fakeMsg) await dispatchPrefix(fakeMsg);
    } catch (err) {
      try { await interaction.reply({ content: `error: ${err.message}`, ephemeral: true }); } catch {}
    }
  }
}
client.on('interactionCreate', dispatchSlash);

// prefix command handler wrapped so any unhandled throw still surfaces a code
async function dispatchPrefix(message) {
  try {
    return await dispatchPrefixInner(message);
  } catch (err) {
    const tag = (message?.content?.split(/\s+/)[0] || 'CMD').toString().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 12).toUpperCase() || 'CMD';
    try { console.error(`[dispatchPrefix] ${tag}:`, err); } catch {}
    try { await message.reply({ embeds: [errorFromCatch(tag, err)], allowedMentions: { repliedUser: false } }); } catch {}
  }
}

async function dispatchPrefixInner(message) {
  // if message is partial (happens in dms) we need to fetch the full message first
  if (message.partial) {
    try { await message.fetch() } catch { return }
  }

  if (!message.author || message.author.bot) return

  // delete hushed people's messages
  const hushed = loadHushed()
  if (hushed[message.author.id]) {
    try { await message.delete() } catch {}
    return
  }

  // anti invite: delete discord invite links
  if (message.guild) {
    const aiData = loadAntiinvite()
    if (aiData[message.guild.id]?.enabled) {
      const INVITE_REGEX = /(discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[a-zA-Z0-9]+/i
      if (INVITE_REGEX.test(message.content)) {
        try { await message.delete() } catch {}
        try { await message.channel.send({ content: `${message.author}, invite links aren't allowed here.`, allowedMentions: { users: [message.author.id] } }) } catch {}
        return
      }
    }
  }

  // autoresponder: check message against saved triggers
  if (message.guild) {
    const arData = loadAutoresponder();
    const triggers = arData[message.guild.id] ?? [];
    if (triggers.length) {
      const lc = message.content.toLowerCase();
      const match = triggers.find(r => lc.includes(r.trigger.toLowerCase()));
      if (match) {
        try { await message.channel.send(match.response); } catch {}
      }
    }
  }

  // annoy: react to messages from annoyed users
  if (message.guild) {
    const annoyData = loadAnnoy()
    const annoyed = annoyData[message.guild.id] || []
    if (annoyed.includes(message.author.id)) {
      const RANDOM_EMOJIS = ['😂','💀','🔥','💯','🤡','😭','🤣','😱','🤔','💅','🥶','😤','🫡','🤩','🎉','🤯','🥴','😈','👀','🫠']
      const chosen = []
      while (chosen.length < 10) {
        const e = RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)]
        if (!chosen.includes(e)) chosen.push(e)
      }
      for (const emoji of chosen) {
        try { await message.react(emoji) } catch {}
      }
    }
  }

  // skull: react to messages from skulled users with 💀
  if (message.guild) {
    const skullData = loadSkull()
    const skulled = skullData[message.guild.id] || []
    if (skulled.includes(message.author.id)) {
      try { await message.react('💀') } catch {}
    }
  }

  // autoreact stuff
  const autoreactData = loadAutoreact()
  if (autoreactData[message.author.id]?.length) {
    for (const emoji of autoreactData[message.author.id]) {
      try { await message.react(emoji) } catch {}
    }
  }

  // tell people when someone they pinged is afk
  if (message.mentions.users.size > 0) {
    const afkData = loadAfk()
    const mentioned = message.mentions.users.first()
    if (afkData[mentioned?.id]) {
      const e = afkData[mentioned.id]
      await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`**${mentioned.username}** is afk: ${e.reason || 'no reason'}\n<t:${Math.floor(e.since / 1000)}:R `)] })
    }
  }

  const prefix = getPrefix()
  const afkData = loadAfk()

  if (afkData[message.author.id]) {
    delete afkData[message.author.id];
    saveAfk(afkData);
    await message.reply({ content: "Welcome back your AFK status has been removed.", allowedMentions: { repliedUser: false } });
  }

  if (message.author.id === '1461174388006326354' && message.content.toLowerCase().includes('i wanna essex')) {
    await message.reply({ content: 'Yes dada star Essex me', allowedMentions: { repliedUser: false } });
  }

  if (!message.content.startsWith(prefix)) return;

  const args    = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Open to everyone prefix commands
  if (command === 'roblox') {
    const username = args[0];
    if (!username) return message.reply('provide a Roblox username');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return message.reply("could not find that user");
      const userId = userBasic.id;
      const [user, avatarRes, friendsRes, pastNamesRes, groupsRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${userId}`).then(r => r.json()),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`).then(r => r.json()),
        fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then(r => r.json()).catch(() => ({ count: 'n/a' })),
        fetch(`https://users.roblox.com/v1/users/${userId}/username-history?limit=10&sortOrder=Asc`).then(r => r.json()).catch(() => ({ data: [] })),
        fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      const avatarUrl  = avatarRes.data?.[0]?.imageUrl;
      const profileUrl = `https://www.roblox.com/users/${userId}/profile`;
      const created    = new Date(user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const friends    = friendsRes.count ?? 'n/a';
      const pastNames  = (pastNamesRes.data ?? []).map(u => u.name);
      const groupsRaw  = (groupsRes.data ?? []);
      const status     = user.description?.trim() || '';
      const embed = baseEmbed()
        .setTitle(`${user.displayName} (@${user.name})`)
        .setURL(profileUrl)
        .setColor(0x2C2F33)
        .setDescription(status.slice(0, 4096) || null)
        .setThumbnail(avatarUrl)
        .addFields(
          { name: 'User ID',  value: `\`${userId}\``, inline: true },
          { name: 'Created',  value: created,          inline: true },
          { name: 'Friends',  value: `${friends}`,     inline: true },
        );
      if (pastNames.length) embed.addFields({ name: `Past Usernames (${pastNames.length})`, value: pastNames.map(n => `\`${n}\``).join(', '), inline: false });
      if (groupsRaw.length) embed.addFields({ name: `Groups (${groupsRaw.length})`, value: groupsRaw.slice(0, 10).map(g => `[${g.group.name}](https://www.roblox.com/communities/${g.group.id}/about)`).join('\n'), inline: false });
      embed.setTimestamp();
      const joinBtn = await buildJoinButton(userId);
      return message.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(joinBtn)]
      });
    } catch { return message.reply("something went wrong loading their info, try again"); }
  }

  if (command === 'cookie') {
    if (message.author.id !== COOKIE_OWNER_ID)
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only the bot owner can use this command')] });
    const cookie = args.join(' ').trim();
    if (!cookie) return;
    if (cookie.length < 50) return message.reply({ embeds: [errorEmbed('invalid cookie').setDescription('that does not look like a valid `.ROBLOSECURITY` cookie')] });
    saveStoredCookie(cookie);
    process.env.ROBLOX_COOKIE = cookie;
    try { await message.delete(); } catch {}
    try { await message.author.send({ embeds: [successEmbed('cookie saved').setDescription('the roblox cookie has been updated and is now active. your message was deleted for safety.')] }); } catch {}
    return;
  }

  if (command === 'rg') {
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers and temp owners can use `.rg`')] });
    const link = args.join(' ').trim();
    if (!link) return;
    const parsed = parseRobloxGroupLink(link);
    if (!parsed) return message.reply({ embeds: [errorEmbed('invalid link').setDescription('give a roblox group link like `https://www.roblox.com/communities/12345/about` or just the group id')] });
    setGroupConfig(parsed);
    return message.reply({ embeds: [successEmbed('group updated').setDescription(`now using group \`${parsed.groupId}\`\n${parsed.groupLink}`)] });
  }

  if (command === 'gc') {
    const username = args[0];
    if (!username) return message.reply('provide a Roblox username')
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return message.reply("could not find that user")
      const userId = userBasic.id;
      const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)).json()).data ?? [];
      const displayName = userBasic.displayName || userBasic.name;
      const inFraidGroup = groupsData.some(g => String(g.group.id) === getGroupId());
      const groups = groupsData.sort((a, b) => a.group.name.localeCompare(b.group.name));
      const avatarUrl = (await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).json()).data?.[0]?.imageUrl;
      const userGroupIds = new Set(groups.map(g => String(g.group.id)));
      gcCache.set(username.toLowerCase(), { displayName, groups, avatarUrl, userGroupIds, inGroup: inFraidGroup });
      setTimeout(() => gcCache.delete(username.toLowerCase()), 10 * 60 * 1000);
      const flagRow = buildFlagSelectRow(username, groups);
      const pageRow = groups.length > GC_PER_PAGE ? buildGcRow(username, groups, 0) : null;
      const components = [pageRow, flagRow].filter(Boolean);
      if (!inFraidGroup) {
        return message.reply({
          embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), buildGcNotInGroupEmbed(displayName, userGroupIds)],
          components
        });
      }
      return message.reply({
        embeds: [buildGcEmbed(displayName, groups, avatarUrl, 0), buildGcInGroupEmbed(displayName, userGroupIds)],
        components
      });
    } catch (err) { return message.reply({ embeds: [errorFromCatch('GC02', err)] }) }
  }

  if (command === 'help') {
    // unwhitelisted users get nothing no message, nothing
    if (!isWhitelisted(message.author.id)) return;
    if (!isWlManager(message.author.id)) return;
    return message.reply({ embeds: [buildHelpEmbed(0)], components: [buildHelpRow(0)] });
  }

  if (command === 'vmhelp') return message.reply({ embeds: [buildVmHelpEmbed(prefix)] });

  if (command === 'about') {
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`About ${client.user.username}`)
      .setDescription(`A custom Discord bot built for **${getBotName()}**.\n\nUse \`${prefix}help\` or \`/help\` to see all commands.`)
      .addFields(
        { name: 'servers', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'uptime', value: `<t:${Math.floor((Date.now() - client.uptime) / 1000)}:R `, inline: true }
      ).setThumbnail(client.user.displayAvatarURL()).setTimestamp()] });
  }

  if (command === 'convert') {
    const username = args[0];
    if (!username) return message.reply('provide a Roblox username');
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return message.reply("could not find that user");
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Roblox ID Lookup')
        .addFields({ name: 'username', value: userBasic.name, inline: true }, { name: 'display name', value: userBasic.displayName || userBasic.name, inline: true }, { name: 'user id', value: `\`${userBasic.id}\``, inline: true })
        .setFooter({ text: 'roblox user id' }).setTimestamp()] });
    } catch { return message.reply("something went wrong, try again"); }
  }

  if (command === 'snipe') {
    if (!message.guild) return;
    const sniped = snipeCache.get(message.channel.id);
    if (!sniped) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('nothing to snipe')] });
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('sniped')
      .setDescription(sniped.content)
      .addFields({ name: 'author', value: sniped.author, inline: true }, { name: 'deleted', value: `<t:${Math.floor(sniped.deletedAt / 1000)}:R `, inline: true })
      .setThumbnail(sniped.avatarUrl)] });
  }

  // VoiceMaster prefix commands
  if (command === 'drag') {
    if (!message.guild) return;
    const target = message.mentions.members?.first();
    if (!target) return message.reply('mention a user to drag');
    const myVc = message.member?.voice?.channel;
    if (!myVc) return message.reply("you are not in a voice channel");
    try { await target.voice.setChannel(myVc); return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`dragged **${target.displayName}** to **${myVc.name}**`)] }); }
    catch { return message.reply("couldn't drag them they might not be in a vc"); }
  }

  if (command === 'vm') {
    if (!message.guild) return;
    const sub = args[0]?.toLowerCase();
    if (sub === 'setup') {
      if (!loadWhitelist().includes(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Not Whitelisted').setDescription("you are not whitelisted for this")] });
      await message.reply('setting up voicemaster...');
      try {
        const category = await message.guild.channels.create({ name: 'Voice Master', type: ChannelType.GuildCategory });
        const createVc = await message.guild.channels.create({ name: '➕ Create VC', type: ChannelType.GuildVoice, parent: category.id });
        const iface    = await message.guild.channels.create({ name: 'interface', type: ChannelType.GuildText, parent: category.id });
        const ifaceMsg = await iface.send({ embeds: [buildVmInterfaceEmbed(message.guild)], components: buildVmInterfaceRows() });
        const vmConfig = loadVmConfig();
        vmConfig[message.guild.id] = { categoryId: category.id, createChannelId: createVc.id, interfaceChannelId: iface.id, interfaceMessageId: ifaceMsg.id };
        saveVmConfig(vmConfig);
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`✅ voicemaster set up! join **${createVc.name}** to create a vc.`)] });
      } catch (e) { return message.reply(`setup failed ${e.message}`); }
    }
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('you need to be in your voice channel');
    const vmChannels = loadVmChannels();
    const chData = vmChannels[vc.id];
    if (!chData) return message.reply("that's not a voicemaster channel");
    const isOwner = chData.ownerId === message.author.id;
    const everyone = message.guild.roles.everyone;

    if (sub === 'lock')   { if (!isOwner) return message.reply("you don't own this channel"); await vc.permissionOverwrites.edit(everyone, { Connect: false }); return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('🔒 channel locked')] }); }
    if (sub === 'unlock') { if (!isOwner) return message.reply("you don't own this channel"); await vc.permissionOverwrites.edit(everyone, { Connect: null }); return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('🔓 channel unlocked')] }); }
    if (sub === 'claim')  {
      if (vc.members.has(chData.ownerId)) return message.reply("the owner is still in the channel");
      chData.ownerId = message.author.id; vmChannels[vc.id] = chData; saveVmChannels(vmChannels);
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`👑 you now own **${vc.name}**`)] });
    }
    if (sub === 'limit') {
      if (!isOwner) return message.reply("you don't own this channel");
      const n = parseInt(args[1], 10);
      if (isNaN(n) || n < 0 || n > 99) return message.reply('provide a number between 0 and 99 (0 means no limit)')
      await vc.setUserLimit(n);
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`limit set to **${n === 0 ? 'no limit' : n}**`)] });
    }
    if (sub === 'allow') {
      if (!isOwner) return message.reply("you don't own this channel");
      const target = message.mentions.members?.first();
      if (!target) return message.reply('mention a user');
      await vc.permissionOverwrites.edit(target.id, { Connect: true, ViewChannel: true });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`allowed **${target.displayName}**`)] });
    }
    if (sub === 'deny') {
      if (!isOwner) return message.reply("you don't own this channel");
      const target = message.mentions.members?.first();
      if (!target) return message.reply('mention a user');
      await vc.permissionOverwrites.edit(target.id, { Connect: false });
      if (vc.members.has(target.id)) await target.voice.setChannel(null).catch(() => {});
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`denied **${target.displayName}**`)] });
    }
    if (sub === 'rename') {
      if (!isOwner) return message.reply("you don't own this channel");
      const newName = args.slice(1).join(' ');
      if (!newName) return message.reply('type a name for the channel')
      await vc.setName(newName);
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`renamed to **${newName}**`)] });
    }
    if (sub === 'reset') {
      if (!isOwner) return message.reply("you don't own this channel");
      await vc.setName(`${message.member.displayName}'s VC`);
      await vc.setUserLimit(0);
      await vc.permissionOverwrites.edit(everyone, { Connect: null, ViewChannel: null });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('channel reset to defaults')] });
    }
    return message.reply({ embeds: [buildVmHelpEmbed(prefix)] });
  }

  // Whitelist required prefix commands
  // unwhitelisted users only get `roblox` and `register`. for anything else
  // the bot just doesn't respond. no error, no embed it's like the command
  // was never typed. that way randoms can't even tell what commands exist.
  if (!isWhitelisted(message.author.id)) {
    const openPrefixCommands = new Set(['roblox', 'register']);
    if (!openPrefixCommands.has(command)) {
      return;
    }
  }

  if (command === 'hb') {
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use `.hb`')] });
    const target = message.mentions.users.first();
    const rawId  = args[0];
    if (!target && !rawId) return message.reply("provide a user mention or their ID");
    const userId = target?.id ?? rawId;
    const reason = args.slice(1).join(' ') || 'no reason';
    if (!/^\d{17,19}$/.test(userId)) return message.reply("that doesn't look like a real id");
    try {
      await message.guild.members.ban(userId, { reason: `hardban by ${message.author.tag}: ${reason}`, deleteMessageSeconds: 0 });
      let username = target?.tag ?? userId;
      if (!target) { try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {} }
      const hardbans = loadHardbans();
      if (!hardbans[message.guild.id]) hardbans[message.guild.id] = {};
      hardbans[message.guild.id][userId] = { reason, bannedBy: message.author.id, at: Date.now() };
      saveHardbans(hardbans);
      return message.reply(`hardbanned **${username}** by ${message.author.tag} reason: ${reason}`);
    } catch (err) { return message.reply(`couldn't ban ${err.message}`); }
  }

  if (command === 'unhb') {
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use `.unhb`')] });
    if (!message.guild) return;
    const userId = args[0];
    const reason = args.slice(1).join(' ') || 'no reason';
    if (!userId || !/^\d{17,19}$/.test(userId)) return message.reply("that's not a valid user id");
    try {
      await message.guild.members.unban(userId, reason);
      const hardbans = loadHardbans();
      if (hardbans[message.guild.id]) delete hardbans[message.guild.id][userId];
      saveHardbans(hardbans);
      let username = userId;
      try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {}
      return message.reply({ embeds: [baseEmbed().setTitle('hardban removed').setColor(0x2C2F33)
        .addFields({ name: 'user', value: username, inline: true }, { name: 'mod', value: message.author.tag, inline: true }, { name: 'reason', value: reason }).setTimestamp()] });
    } catch (err) { return message.reply(`couldn't remove hardban ${err.message}`); }
  }

  if (command === 'ban') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    if (!target.bannable) return message.reply("can't ban them, they might be above me");
    const reason = args.slice(1).join(' ') || 'no reason';
    await target.ban({ reason, deleteMessageSeconds: 86400 });
    return message.reply(`banned **${target.user.tag}** by ${message.author.tag} reason: ${reason}`);
  }

  if (command === 'kick') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    if (!target.kickable) return message.reply("can't kick them, they might be above me");
    const reason = args.slice(1).join(' ') || 'no reason';
    try { await target.kick(reason); } catch { return message.reply("couldn't kick them"); }
    return message.reply(`kicked **${target.user.tag}** by ${message.author.tag} reason: ${reason}`);
  }

  if (command === 'unban') {
    const userId = args[0];
    const reason = args.slice(1).join(' ') || 'no reason';
    if (!userId || !/^\d{17,19}$/.test(userId)) return message.reply("that's not a valid user id");
    try {
      await message.guild.members.unban(userId, reason);
      let username = userId;
      try { const fetched = await client.users.fetch(userId); username = fetched.tag; } catch {}
      return message.reply(`unbanned **${username}** by ${message.author.tag} reason: ${reason}`);
    } catch (err) { return message.reply(`couldn't unban ${err.message}`); }
  }

  if (command === 'timeout') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    const minutes = parseInt(args[1]) || 5;
    if (minutes < 1 || minutes > 40320) return message.reply('has to be between 1 and 40320 mins');
    const reason = args.slice(2).join(' ') || 'no reason';
    try { await target.timeout(minutes * 60 * 1000, reason); } catch { return message.reply("couldn't time them out"); }
    return message.reply(`timed out **${target.user.tag}** for ${minutes}m by ${message.author.tag} reason: ${reason}`);
  }

  if (command === 'untimeout') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    try { await target.timeout(null); } catch { return message.reply("couldn't remove their timeout"); }
    return message.reply(`removed timeout from **${target.user.tag}** by ${message.author.tag}`);
  }

  if (command === 'mute') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    const reason = args.slice(1).join(' ') || 'no reason';
    try { await target.timeout(28 * 24 * 60 * 60 * 1000, reason); } catch { return message.reply("couldn't mute them"); }
    return message.reply(`muted **${target.user.tag}** by ${message.author.tag} reason: ${reason}`);
  }

  if (command === 'unmute') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    try { await target.timeout(null); } catch { return message.reply("couldn't unmute them"); }
    return message.reply(`unmuted **${target.user.tag}** by ${message.author.tag}`);
  }

  if (command === 'hush') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    const hushedData = loadHushed();
    if (hushedData[target.id]) return message.reply(`**${target.user.tag}** is already hushed use \`${prefix}unhush\` to remove it`);
    hushedData[target.id] = { hushedBy: message.author.id, at: Date.now() };
    saveHushed(hushedData);
    return message.reply(`hushed **${target.user.tag}** by ${message.author.tag}`);
  }

  if (command === 'unhush') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('mention someone');
    const hushedData = loadHushed();
    if (!hushedData[target.id]) return message.reply(`**${target.user.tag}** isn't hushed`);
    delete hushedData[target.id]; saveHushed(hushedData);
    return message.reply({ embeds: [baseEmbed().setTitle('unhushed').setColor(0x2C2F33).setThumbnail(target.user.displayAvatarURL())
      .addFields({ name: 'user', value: target.user.tag, inline: true }, { name: 'mod', value: message.author.tag, inline: true }).setTimestamp()] });
  }

  if (command === 'skull') {
    if (!message.guild) return;
    const target = message.mentions.users.first();
    if (!target) return message.reply('mention someone to skull');
    const skullData = loadSkull();
    if (!skullData[message.guild.id]) skullData[message.guild.id] = [];
    if (skullData[message.guild.id].includes(target.id)) return message.reply(`already skulling **${target.tag}**`);
    skullData[message.guild.id].push(target.id);
    saveSkull(skullData);
    return message.reply({ embeds: [baseEmbed().setTitle('skull').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .setDescription(`now reacting to every message from **${target.tag}** with 💀`)
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: message.author.tag, inline: true }).setTimestamp()] });
  }

  if (command === 'unskull') {
    if (!message.guild) return;
    const target = message.mentions.users.first();
    if (!target) return message.reply('mention someone to unskull');
    const skullData = loadSkull();
    if (!skullData[message.guild.id]?.includes(target.id)) return message.reply(`not skulling **${target.tag}**`);
    skullData[message.guild.id] = skullData[message.guild.id].filter(id => id !== target.id);
    saveSkull(skullData);
    return message.reply({ embeds: [baseEmbed().setTitle('unskull').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .setDescription(`stopped skulling **${target.tag}**`)
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: message.author.tag, inline: true }).setTimestamp()] });
  }

  if (command === 'annoy') {
    if (!message.guild) return;
    const target = message.mentions.users.first();
    if (!target) return message.reply('mention someone to annoy');
    const annoyData = loadAnnoy();
    if (!annoyData[message.guild.id]) annoyData[message.guild.id] = [];
    if (annoyData[message.guild.id].includes(target.id)) return message.reply(`already annoying **${target.tag}**`);
    annoyData[message.guild.id].push(target.id);
    saveAnnoy(annoyData);
    return message.reply({ embeds: [baseEmbed().setTitle('annoy').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .setDescription(`now reacting to every message from **${target.tag}** with 10 random emojis`)
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: message.author.tag, inline: true }).setTimestamp()] });
  }

  if (command === 'unannoy') {
    if (!message.guild) return;
    const target = message.mentions.users.first();
    if (!target) return message.reply('mention someone to stop annoying');
    const annoyData = loadAnnoy();
    if (!annoyData[message.guild.id]?.includes(target.id)) return message.reply(`not annoying **${target.tag}**`);
    annoyData[message.guild.id] = annoyData[message.guild.id].filter(id => id !== target.id);
    saveAnnoy(annoyData);
    return message.reply({ embeds: [baseEmbed().setTitle('unannoy').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
      .setDescription(`stopped annoying **${target.tag}**`)
      .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'mod', value: message.author.tag, inline: true }).setTimestamp()] });
  }

  if (command === 'lock') {
    try { await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }); return message.reply('channel locked'); }
    catch { return message.reply("couldn't lock the channel, check my perms"); }
  }

  if (command === 'unlock') {
    try { await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null }); return message.reply('channel unlocked'); }
    catch { return message.reply("couldn't unlock the channel, check my perms"); }
  }

  if (command === 'nuke') {
    if (!isWlManager(message.author.id)) return message.reply('only whitelist managers can use `.nuke`');
    if (!message.guild) return;
    try {
      const ch = message.channel;
      const nuker = message.author.tag;
      const newCh = await ch.clone({
        name:     ch.name,
        topic:    ch.topic,
        nsfw:     ch.nsfw,
        parent:   ch.parentId,
        position: ch.rawPosition,
        permissionOverwrites: ch.permissionOverwrites.cache
      });
      await ch.delete();
      await newCh.send(`channel nuked by **${nuker}**`);
    } catch (err) {
      return message.reply(`couldn't nuke ${err.message}`);
    }
    return;
  }

  // .cleanup (deletes all non pinned messages in the channel)
  if (command === 'cleanup') {
    if (!loadWhitelist().includes(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Not Whitelisted').setDescription(`you need to be whitelisted to use \`${prefix}cleanup\``)] });
    if (!message.guild) return;
    try {
      const ch = message.channel;
      const pinned = await ch.messages.fetchPinned();
      const pinnedIds = new Set(pinned.map(m => m.id));
      let deleted = 0;
      let lastId;
      while (true) {
        const opts = { limit: 100 };
        if (lastId) opts.before = lastId;
        const batch = await ch.messages.fetch(opts);
        if (!batch.size) break;
        const toDelete = batch.filter(m => !pinnedIds.has(m.id));
        if (toDelete.size > 0) {
          const removed = await ch.bulkDelete(toDelete, true);
          deleted += removed.size;
        }
        if (batch.size < 100) break;
        lastId = batch.last().id;
      }
      const confirm = await ch.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('channel cleaned up').setDescription(`deleted **${deleted}** message${deleted !== 1 ? 's' : ''} pinned messages were kept`).setTimestamp()] });
      setTimeout(() => confirm.delete().catch(() => {}), 8000);
    } catch (err) {
      return message.reply(`couldn't clean up ${err.message}`);
    }
    return;
  }

  if (command === 'activitycheck') {
    if (!message.guild) return;
    const sub = args[0]?.toLowerCase();
    const checks = loadActivityCheck();
    if (!checks[message.guild.id]) checks[message.guild.id] = {};
    if (sub === 'start') {
      const acMessage = args.slice(1).join(' ') || 'Activity Check';
      checks[message.guild.id] = { startedBy: message.author.id, startedAt: Date.now(), active: true, checkins: [], acMessage };
      saveActivityCheck(checks);
      const acEmbed = baseEmbed().setColor(0x2C2F33).setTitle(acMessage)
        .setDescription('Click react to react to activity check!')
        .addFields({ name: 'started by', value: message.author.tag, inline: true })
        .setTimestamp();
      const acRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ac checkin').setLabel('React').setStyle(ButtonStyle.Primary)
      );
      return message.reply({ embeds: [acEmbed], components: [acRow] });
    }
    if (sub === 'end') {
      if (!checks[message.guild.id].active) return message.reply("no active activity check");
      const startedAt = checks[message.guild.id].startedAt;
      const startedBy = checks[message.guild.id].startedBy;
      const checkins = checks[message.guild.id].checkins || [];
      const acMessage = checks[message.guild.id].acMessage || 'Activity Check';
      checks[message.guild.id] = { active: false };
      saveActivityCheck(checks);
      const checkinList = checkins.length ? checkins.map(id => `<@${id}> `).join(', ') : 'nobody checked in';
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`${acMessage} Ended`)
        .addFields(
          { name: 'ended by', value: message.author.tag, inline: true },
          { name: 'started by', value: `<@${startedBy}> `, inline: true },
          { name: 'started', value: `<t:${Math.floor(startedAt / 1000)}:R `, inline: true },
          { name: `checked in (${checkins.length})`, value: checkinList }
        ).setTimestamp()] });
    }
    return;
  }

  if (command === 'prefix') {
    const newPrefix = args[0];
    if (!newPrefix) return message.reply(`current prefix is \`${prefix}\``);
    if (newPrefix.length > 5) return message.reply("prefix can't be more than 5 chars");
    const cfg = loadConfig(); cfg.prefix = newPrefix; saveConfig(cfg);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`prefix updated to \`${newPrefix}\``)] });
  }

  if (command === 'status') {
    const validTypes = ['playing', 'watching', 'listening', 'competing', 'custom'];
    const type = args[0]?.toLowerCase();
    const text = args.slice(1).join(' ');
    if (!type || !validTypes.includes(type) || !text) return message.reply('not the right format');
    const statusData = { type, text };
    applyStatus(statusData);
    const cfg = loadConfig(); cfg.status = statusData; saveConfig(cfg);
    return message.reply({ content: `status changed to **${type}** ${text}`, allowedMentions: { repliedUser: false } });
  }

  // .presence online / idle / dnd / invisible
  if (command === 'presence') {
    if (!isWlManager(message.author.id)) return message.reply('only whitelist managers can do this');
    const okStates = ['online', 'idle', 'dnd', 'invisible'];
    const state = args[0]?.toLowerCase();
    if (!state || !okStates.includes(state)) return message.reply('not the right format');
    applyPresence(state);
    const cfg = loadConfig(); cfg.presence = state; saveConfig(cfg);
    return message.reply({ content: `presence changed to **${state}**`, allowedMentions: { repliedUser: false } });
  }

  if (command === 'afk') {
    const reason = args.join(' ') || null;
    const afk = loadAfk();
    afk[message.author.id] = { reason, since: Date.now() };
    saveAfk(afk);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`You are now AFK${reason ? `: ${reason}` : '.'}`)], allowedMentions: { repliedUser: false } });
  }

  if (command === 'say') {
    const text = args.join(' ');
    if (!text) return message.reply('say what?');
    try { await message.delete(); } catch {}
    return message.channel.send(text);
  }

  if (command === 'cs') {
    const had = snipeCache.has(message.channel.id);
    snipeCache.delete(message.channel.id);
    return message.reply(had ? 'snipe cleared' : 'nothing to clear');
  }

  if (command === 'grouproles') {
    const groupId = process.env.ROBLOX_GROUP_ID;
    if (!groupId) return message.reply('`ROBLOX GROUP ID` isnt set');
    try {
      const data = await (await fetch(`https://groups.roblox.com/v1/groups/${groupId}/roles`)).json();
      if (!data.roles?.length) return message.reply('no roles found for this group');
      const lines = data.roles.sort((a, b) => a.rank - b.rank).map(r => `\`${String(r.rank).padStart(3, '0')}\` **${r.name}** ID: \`${r.id}\``);
      return message.reply({ embeds: [baseEmbed().setTitle('group roles').setColor(0x2C2F33).setDescription(lines.join('\n')).setFooter({ text: `group id: ${groupId}` }).setTimestamp()] });
    } catch { return message.reply("couldn't load group roles, try again"); }
  }

  if (command === 'jail') {
    if (!message.guild) return;
    const target = message.mentions.members?.first();
    if (!target) return message.reply('mention someone to jail');
    const reason = args.slice(1).join(' ') || 'no reason';
    try { return message.reply({ embeds: [await jailMember(message.guild, target, reason, message.author.tag)] }); }
    catch (e) { return message.reply(e.message); }
  }

  if (command === 'unjail') {
    if (!message.guild) return;
    const target = message.mentions.members?.first();
    if (!target) return message.reply('mention someone to unjail');
    try { return message.reply({ embeds: [await unjailMember(message.guild, target, message.author.tag)] }); }
    catch (e) { return message.reply(e.message); }
  }

  if (command === 'dm') {
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use `.dm`')] });
    // .dm @user/userId/roleId <message
    const rawTarget = args[0];
    if (!rawTarget) return;
    const dmMsg = args.slice(1).join(' ');
    if (!dmMsg) return message.reply('include a message to send');

    // Resolve target: user mention, role mention, or raw ID
    const userMention = message.mentions.users.first();
    const roleMention = message.mentions.roles?.first();

    if (roleMention) {
      // DM everyone with the role (guild only)
      if (!message.guild) return message.reply("can't DM a role outside of a server");
      await fetchMembersCached(message.guild);
      const members = roleMention.members;
      if (!members.size) return message.reply("no members have that role");
      let sent = 0, failed = 0;
      const status = await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`sending DMs to **${members.size}** members with ${roleMention}...`)] });
      for (const [, member] of members) {
        if (member.user.bot) continue;
        try {
          await member.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Message').setDescription(dmMsg).setFooter({ text: `from ${message.author.tag}` }).setTimestamp()] });
          sent++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 500)); // rate limit buffer
      }
      return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`done sent: **${sent}**, failed: **${failed}**`)] });
    }

    // Single user: @mention or raw ID
    let targetUser = userMention;
    if (!targetUser) {
      const rawId = rawTarget.replace(/\D/g, '');
      if (!/^\d{17,19}$/.test(rawId)) return message.reply("that doesn't look like a valid user or role");
      try { targetUser = await client.users.fetch(rawId); } catch { return message.reply("could not find that user"); }
    }
    if (targetUser.bot) return message.reply("can't DM a bot");
    try {
      await targetUser.send({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Message').setDescription(dmMsg).setFooter({ text: `from ${message.author.tag}` }).setTimestamp()] });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`DM sent to **${targetUser.tag}**`)] });
    } catch {
      return message.reply(`couldn't DM **${targetUser.tag}** they might have DMs off`);
    }
  }





  if (command === 'group') {
    const username = args[0];
    const action = args[1]?.toLowerCase();
    const value = args[2];
    if (!username || !action) return;
    try {
      const userBasic = (await (await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) })).json()).data?.[0];
      if (!userBasic) return message.reply("could not find that user");
      const groupId = process.env.ROBLOX_GROUP_ID;
      if (action === 'check') {
        const groupsData = (await (await fetch(`https://groups.roblox.com/v1/users/${userBasic.id}/groups/roles`)).json()).data ?? [];
        const membership = groupsData.find(g => String(g.group.id) === String(groupId));
        return message.reply({ embeds: [baseEmbed().setColor(membership ? 0x23D160 : 0xFF3860).setTitle('Group Check')
          .addFields(
            { name: 'user', value: userBasic.name, inline: true },
            { name: 'in group', value: membership ? 'yes' : 'no', inline: true },
            { name: 'role', value: membership?.role?.name ?? 'n/a', inline: true }
          ).setTimestamp()] });
      }
      if (action === 'rank') {
        if (!value) return message.reply('provide a role ID to rank to');
        const result = await rankRobloxUser(username, value);
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Ranked')
          .addFields({ name: 'user', value: result.displayName, inline: true }, { name: 'role id', value: value, inline: true }).setTimestamp()] });
      }
      if (action === 'exile') {
        const cookie = process.env.ROBLOX_COOKIE;
        if (!cookie || !groupId) return message.reply('ROBLOX COOKIE or ROBLOX GROUP ID not configured');
        const csrfRes = await fetch('https://auth.roblox.com/v2/logout', { method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
        const csrfToken = csrfRes.headers.get('x csrf token');
        const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${userBasic.id}`, {
          method: 'DELETE', headers: { Cookie: `.ROBLOSECURITY=${cookie}`, 'X-CSRF-TOKEN': csrfToken }
        });
        if (!res.ok) return message.reply(`couldn't exile HTTP ${res.status}`);
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Exiled')
          .addFields({ name: 'user', value: userBasic.name, inline: true }, { name: 'exiled by', value: message.author.tag, inline: true }).setTimestamp()] });
      }
      return message.reply(`unknown action use check, rank, or exile`);
    } catch (err) { return message.reply(`something went wrong ${err.message}`); }
  }

  // .antinuke - only wl managers + temp owners
  if (command === 'antinuke') {
    if (!message.guild) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('use this in a server')] });
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers and temp owners can use `.antinuke`')] });
    const sub = (args[0] || 'status').toLowerCase();
    const { cfg } = getAntinukeCfg(message.guild.id);

    if (sub === 'status' || sub === 'show') {
      return message.reply({ embeds: [buildAntinukeStatusEmbed(message.guild, cfg)] });
    }
    if (sub === 'enable' || sub === 'on') {
      setAntinukeCfg(message.guild.id, c => { c.enabled = true; });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('✅ antinuke is now **ON** for this server')] });
    }
    if (sub === 'disable' || sub === 'off') {
      setAntinukeCfg(message.guild.id, c => { c.enabled = false; });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('❌ antinuke is now **OFF** for this server')] });
    }
    if (sub === 'punishment' || sub === 'punish') {
      const mode = (args[1] || '').toLowerCase();
      if (!['ban', 'kick', 'strip'].includes(mode))
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('usage: `.antinuke punishment <ban|kick|strip>`')] });
      setAntinukeCfg(message.guild.id, c => { c.punishment = mode; });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`punishment set to \`${mode}\``)] });
    }
    if (sub === 'logs' || sub === 'log') {
      const arg = args[1];
      if (!arg || arg.toLowerCase() === 'clear') {
        setAntinukeCfg(message.guild.id, c => { c.logChannelId = null; });
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('antinuke log channel cleared')] });
      }
      const ch = message.mentions?.channels?.first?.() || message.guild.channels.cache.get(arg.replace(/[^\d]/g, ''));
      if (!ch) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('couldn\'t find that channel — mention it like `#channel` or pass an id')] });
      setAntinukeCfg(message.guild.id, c => { c.logChannelId = ch.id; });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`antinuke logs will go to <#${ch.id}>`)] });
    }
    if (sub === 'whitelist' || sub === 'wl') {
      const action = (args[1] || '').toLowerCase();
      if (action === 'list') {
        const list = cfg.whitelist?.length ? cfg.whitelist.map(id => `<@${id}> \`${id}\``).join('\n') : '_empty_';
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('antinuke whitelist').setDescription(list)], allowedMentions: { parse: [] } });
      }
      const targetArg = args[2];
      const targetUser = message.mentions?.users?.first?.();
      const targetId = targetUser?.id || (/^\d{15,25}$/.test(targetArg || '') ? targetArg : null);
      if (!['add', 'remove', 'rm'].includes(action) || !targetId)
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('usage: `.antinuke whitelist <add|remove|list> [@user|id]`')] });
      setAntinukeCfg(message.guild.id, c => {
        c.whitelist = c.whitelist || [];
        if (action === 'add') { if (!c.whitelist.includes(targetId)) c.whitelist.push(targetId); }
        else c.whitelist = c.whitelist.filter(x => x !== targetId);
      });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`${action === 'add' ? '✅ added' : '✅ removed'} <@${targetId}> ${action === 'add' ? 'to' : 'from'} the antinuke whitelist`)], allowedMentions: { parse: [] } });
    }
    if (sub === 'threshold' || sub === 'limit') {
      const action = args[1];
      const count = parseInt(args[2], 10);
      const seconds = parseFloat(args[3]);
      if (!action || !Number.isFinite(count) || count < 1 || !Number.isFinite(seconds) || seconds <= 0 || !DEFAULT_ANTINUKE_THRESHOLDS[action])
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`usage: \`.antinuke threshold <action> <count> <seconds>\`\n\nactions: ${Object.keys(DEFAULT_ANTINUKE_THRESHOLDS).map(k => `\`${k}\``).join(', ')}`)] });
      setAntinukeCfg(message.guild.id, c => { c.thresholds[action] = { count, window: Math.round(seconds * 1000) }; });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`threshold for \`${action}\` set to **${count}** events in **${seconds}s**`)] });
    }
    if (sub === 'reset') {
      setAntinukeCfg(message.guild.id, c => { c.thresholds = { ...DEFAULT_ANTINUKE_THRESHOLDS }; });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('thresholds reset to defaults')] });
    }
    if (sub === 'test') {
      // just shows what the alert would look like, doesnt actually do anything
      const fake = baseEmbed().setColor(0xC0392B).setTitle('antinuke triggered (TEST)')
        .addFields(
          { name: 'actor', value: `<@${message.author.id}> \`(${message.author.id})\``, inline: false },
          { name: 'action', value: '`channelDelete`', inline: true },
          { name: 'count in window', value: '3', inline: true },
          { name: 'outcome', value: `would be: ${cfg.punishment}`, inline: false },
        ).setTimestamp();
      return message.reply({ embeds: [fake], allowedMentions: { parse: [] } });
    }
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('antinuke usage').setDescription([
      '`.antinuke status`',
      '`.antinuke enable` / `disable`',
      '`.antinuke punishment <ban|kick|strip>`',
      '`.antinuke logs <#channel|clear>`',
      '`.antinuke whitelist <add|remove|list> [@user|id]`',
      '`.antinuke threshold <action> <count> <seconds>`',
      '`.antinuke reset`  (restore default thresholds)',
      '`.antinuke test`   (preview an alert, no action)',
    ].join('\n'))] });
  }

  // .backup - zips up all the .json files and DMs them to you
  // only wl managers and temp owners can do this
  // if your DMs are off it just posts the zip in the channel
  if (command === 'backup') {
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers and temp owners can use `.backup`')] });
    try {
      const allFiles = fs.readdirSync(__dirname);
      const jsonFiles = allFiles.filter(f => f.endsWith('.json') && !f.endsWith('.bak') && !f.includes('.corrupt')).sort();
      if (!jsonFiles.length)
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('nothing to back up — no .json files found')] });

      const entries = [];
      let totalBytes = 0;
      const skipped = [];
      for (const f of jsonFiles) {
        try {
          const buf = fs.readFileSync(path.join(__dirname, f));
          entries.push({ name: f, data: buf });
          totalBytes += buf.length;
        } catch (e) { skipped.push(`${f} (${e.message})`); }
      }

      // throw in a little info file so later you know where this backup came from
      const meta = {
        createdAt: new Date().toISOString(),
        createdBy: { id: message.author.id, tag: message.author.tag },
        bot: { id: client.user?.id, tag: client.user?.tag },
        guild: message.guild ? { id: message.guild.id, name: message.guild.name } : null,
        files: jsonFiles,
        skipped,
        totalBytes,
      };
      entries.push({ name: '_meta.json', data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8') });

      const zipBuf = buildZipBuffer(entries);
      // discord wont let you upload more than 25mb so bail early if were close
      if (zipBuf.length > 24 * 1024 * 1024)
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`backup is too large to upload (${(zipBuf.length / 1024 / 1024).toFixed(2)} MB > 24 MB). consider attaching a Railway volume and downloading the JSON files directly.`)] });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const filename = `bot-backup_${stamp}.zip`;
      const attachment = new AttachmentBuilder(zipBuf, { name: filename });
      const summary = baseEmbed().setColor(0x2C2F33).setTitle('bot backup').setDescription([
        `**files:** ${jsonFiles.length}`,
        `**uncompressed:** ${(totalBytes / 1024).toFixed(1)} KB`,
        `**zip size:** ${(zipBuf.length / 1024).toFixed(1)} KB`,
        skipped.length ? `**skipped:** ${skipped.length} (see _meta.json)` : null,
      ].filter(Boolean).join('\n'));

      // try to DM it first. if dms are closed just post here
      try {
        const dm = await message.author.createDM();
        await dm.send({ embeds: [summary], files: [attachment] });
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`📬 backup DMed (${jsonFiles.length} files, ${(zipBuf.length / 1024).toFixed(1)} KB)`)] });
      } catch (dmErr) {
        return message.reply({ embeds: [summary], files: [attachment], content: '⚠️ DMs are closed, posting here instead' });
      }
    } catch (err) {
      return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription(`backup failed: ${err.message}`)] });
    }
  }

  // .restore - you attach a backup zip and it puts all the json files back
  // wl managers and temp owners only
  // it makes a .bak copy of every file before overwriting so if i mess up its fixable
  // _meta.json gets read for info but never written to the bot folder
  if (command === 'restore') {
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers and temp owners can use `.restore`')] });
    const att = message.attachments?.first?.();
    if (!att || !/\.zip$/i.test(att.name || ''))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('attach a `.zip` file from `.backup` to this message and try again')] });
    if (att.size > 50 * 1024 * 1024)
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('attached zip is over 50 MB — refusing to load it into memory')] });

    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const zipBuf = Buffer.from(await res.arrayBuffer());
      const entries = parseZipBuffer(zipBuf);

      // peek at the meta file (if there is one) to make sure the zip looks legit
      const metaEntry = entries.find(e => e.name === '_meta.json');
      let meta = null;
      if (metaEntry) {
        try { meta = JSON.parse(metaEntry.data.toString('utf8')); }
        catch { return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription('`_meta.json` inside the zip is corrupted — aborting restore')] }); }
      }

      // double check all the files. they should be plain *.json names with no folders or weird stuff
      const targets = entries.filter(e => e.name !== '_meta.json');
      for (const e of targets) {
        if (!/^[A-Za-z0-9 _.\-]+\.json$/.test(e.name) || e.name.includes('..') || e.name.includes('/') || e.name.includes('\\'))
          return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription(`refusing to restore — suspicious entry name: \`${e.name}\``)] });
        // also make sure each one is valid json so i dont overwrite a real file with junk
        try { JSON.parse(e.data.toString('utf8')); }
        catch { return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription(`refusing to restore — \`${e.name}\` inside the zip isn't valid JSON`)] }); }
      }
      if (!targets.length)
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('zip contains no .json files to restore')] });

      // ok now actually write the files. before overwriting anything
      // copy the old one to <name>.bak.<timestamp> as a just-in-case
      const stamp = Date.now();
      const written = [];
      const restoreBackedUp = [];
      const failed = [];
      for (const e of targets) {
        const dest = path.join(__dirname, e.name);
        try {
          if (fs.existsSync(dest)) {
            const bk = `${dest}.bak.${stamp}`;
            try { fs.copyFileSync(dest, bk); restoreBackedUp.push(path.basename(bk)); } catch {}
          }
          fs.writeFileSync(dest, e.data);
          written.push(e.name);
        } catch (err) { failed.push(`${e.name} (${err.message})`); }
      }

      const summary = baseEmbed().setColor(0x2C2F33).setTitle('restore complete').setDescription([
        `**restored:** ${written.length} file${written.length !== 1 ? 's' : ''}`,
        `**pre-restore backups:** ${restoreBackedUp.length} (saved as \`<name>.bak.${stamp}\`)`,
        failed.length ? `**failed:** ${failed.length}\n${failed.map(f => `• ${f}`).join('\n')}` : null,
        meta?.createdAt ? `**source backup created:** ${meta.createdAt}` : null,
        meta?.createdBy?.tag ? `**source backup author:** ${meta.createdBy.tag} \`(${meta.createdBy.id})\`` : null,
        '',
        '⚠️ in-memory state (snipe cache, antinuke event windows, etc.) was NOT replaced. restart the bot to fully reload from the new files.',
      ].filter(Boolean).join('\n'));
      return message.reply({ embeds: [summary], allowedMentions: { parse: [] } });
    } catch (err) {
      return message.reply({ embeds: [baseEmbed().setColor(0xC0392B).setDescription(`restore failed: ${err.message}`)] });
    }
  }

  // .permcheck [user / id / mention]: anyone can check anyone's bot permissions
  if (command === 'permcheck') {
    const arg = args[0];
    let targetId = message.author.id;
    if (arg) {
      const m = message.mentions?.users?.first?.();
      if (m) targetId = m.id;
      else if (/^\d{15,25}$/.test(arg)) targetId = arg;
      else return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('usage: `.permcheck [@user or user id]`')] });
    }
    const wlMgr = isWlManager(targetId);
    const tempOwn = isTempOwner(targetId);
    const whitelisted = isWhitelisted(targetId);
    const lines = [
      `**user:** <@${targetId}> \`(${targetId})\``,
      ``,
      `${wlMgr ? '✅' : '❌'} whitelist manager`,
      `${tempOwn ? '✅' : '❌'} temp owner`,
      `${whitelisted ? '✅' : '❌'} whitelisted`,
    ];
    if (!wlMgr && !tempOwn && !whitelisted) lines.push('', '_no bot-level permissions — this user can only run public commands._');
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle('permission check').setDescription(lines.join('\n'))],
      allowedMentions: { parse: [] },
    });
  }

  if (command === 'wlmanager') {
    const sub = args[0]?.toLowerCase();
    const mgrs = loadWlManagers();
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use this')] });
    if (sub === 'list') {
      // only the json file ids no env vars or anything
      const all = [...new Set(mgrs)];
      if (!all.length) return message.reply({ embeds: [baseEmbed().setTitle('whitelist managers').setColor(0x2C2F33).setDescription('no managers set')] });
      // grab usernames so its not a wall of numbers
      const lines = [];
      let n = 1;
      for (const id of all) {
        let name = id;
        try {
          const u = await client.users.fetch(id);
          name = u.username;
        } catch (e) {
          name = 'unknown user';
        }
        lines.push(n + '. ' + name);
        n = n + 1;
      }
      return message.reply({ embeds: [baseEmbed().setTitle('whitelist managers').setColor(0x2C2F33).setDescription(lines.join('\n')).setTimestamp()] });
    }
    if (sub === 'add') {
      // temp owners can use every wl manager command EXCEPT promoting other wl managers
      if (!isRealWlManager(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription("temp owners can't add whitelist managers — only real whitelist managers can do that. you can still hand out regular whitelist with `.whitelist add @user`")] });
      const target = message.mentions.users?.first();
      if (!target) return message.reply('mention a user to add');
      if (isBlockedFromWhitelist(target.id)) return message.reply(`**${target.tag}** can't be added to the whitelist managers.`);
      if (mgrs.includes(target.id)) return message.reply(`**${target.tag}** is already a whitelist manager`);
      mgrs.push(target.id); saveWlManagers(mgrs);
      return message.reply({ embeds: [baseEmbed().setTitle('whitelist manager added').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
        .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'added by', value: message.author.tag, inline: true }).setTimestamp()] });
    }
    if (sub === 'remove') {
      // temp owners are explicitly NOT allowed to remove wl managers
      if (!isRealWlManager(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription("temp owners can't remove whitelist managers — only real whitelist managers can do that")] });
      const target = message.mentions.users?.first();
      if (!target) return message.reply('mention a user to remove');
      if (!mgrs.includes(target.id)) return message.reply(`**${target.tag}** isn't a whitelist manager`);
      saveWlManagers(mgrs.filter(id => id !== target.id));
      return message.reply({ embeds: [baseEmbed().setTitle('whitelist manager removed').setColor(0x2C2F33).setThumbnail(target.displayAvatarURL())
        .addFields({ name: 'user', value: target.tag, inline: true }, { name: 'removed by', value: message.author.tag, inline: true }).setTimestamp()] });
    }
    return;
  }

  // whitelist is handled via the slash dispatcher; the prefix → slash bridge below
  // re routes `.whitelist ...` to `/whitelist ...` automatically.

  // warn system
  if (command === 'warn') {
    if (!message.guild) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return message.reply('you need **Moderate Members** to warn');
    const target = message.mentions.members.first();
    if (!target) return;
    const reason = args.slice(1).join(' ') || 'no reason given';
    const warnsData = loadWarns();
    if (!warnsData[message.guild.id]) warnsData[message.guild.id] = {};
    if (!warnsData[message.guild.id][target.id]) warnsData[message.guild.id][target.id] = [];
    warnsData[message.guild.id][target.id].push({ reason, mod: message.author.tag, ts: Date.now() });
    saveWarns(warnsData);
    const count = warnsData[message.guild.id][target.id].length;
    return message.reply({ embeds: [warnEmbed('Member Warned')
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: 'user',           value: `${target.user.tag}`, inline: true },
        { name: 'warned by',      value: message.author.tag,   inline: true },
        { name: 'total warnings', value: `${count}`,           inline: true },
        { name: 'reason',         value: reason }
      )] });
  }

  if (command === 'warnings' || command === 'warns') {
    if (!message.guild) return;
    const target = message.mentions.users.first();
    if (!target) return;
    const warnsData = loadWarns();
    const list = warnsData[message.guild.id]?.[target.id] ?? [];
    if (!list.length) return message.reply({ embeds: [infoEmbed('No Warnings')
      .setDescription(`**${target.tag}** has no warnings`)] });
    const lines = list.map((w, i) =>
      `**${i + 1}.** ${w.reason} by **${w.mod}** <t:${Math.floor(w.ts / 1000)}:R `
    ).join('\n');
    return message.reply({ embeds: [warnEmbed(`Warnings ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(lines)
      .addFields({ name: 'total', value: `${list.length}`, inline: true })] });
  }

  if (command === 'clearwarns') {
    if (!message.guild) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return message.reply('you need **Moderate Members**');
    const target = message.mentions.users.first();
    if (!target) return;
    const warnsData = loadWarns();
    const count = warnsData[message.guild.id]?.[target.id]?.length ?? 0;
    if (!warnsData[message.guild.id]) warnsData[message.guild.id] = {};
    warnsData[message.guild.id][target.id] = [];
    saveWarns(warnsData);
    return message.reply({ embeds: [successEmbed('Warnings Cleared')
      .addFields(
        { name: 'user',    value: target.tag,         inline: true },
        { name: 'cleared', value: `${count}`,         inline: true },
        { name: 'by',      value: message.author.tag, inline: true }
      )] });
  }

  // info commands
  if (command === 'serverinfo' || command === 'si') {
    if (!message.guild) return;
    const owner = await message.guild.fetchOwner().catch(() => null);
    const channels = message.guild.channels.cache;
    const textCount  = channels.filter(c => c.type === ChannelType.GuildText).size;
    const voiceCount = channels.filter(c => c.type === ChannelType.GuildVoice).size;
    const boosts     = message.guild.premiumSubscriptionCount ?? 0;
    const tier       = message.guild.premiumTier;
    return message.reply({ embeds: [infoEmbed(message.guild.name)
      .setThumbnail(message.guild.iconURL({ size: 256 }) ?? getLogoUrl())
      .addFields(
        { name: 'owner',   value: owner ? `<@${owner.id}> ` : 'unknown',                               inline: true },
        { name: 'members', value: `${message.guild.memberCount}`,                                      inline: true },
        { name: 'roles',   value: `${message.guild.roles.cache.size - 1}`,                             inline: true },
        { name: 'text',    value: `${textCount}`,                                                      inline: true },
        { name: 'voice',   value: `${voiceCount}`,                                                     inline: true },
        { name: 'boosts',  value: `${boosts} (tier ${tier})`,                                          inline: true },
        { name: 'created', value: `<t:${Math.floor(message.guild.createdTimestamp / 1000)}:R `,        inline: true },
        { name: 'id',      value: message.guild.id,                                                    inline: true }
      )
      .setImage(message.guild.bannerURL({ size: 1024 }) ?? null)] });
  }

  if (command === 'userinfo' || command === 'ui' || command === 'whois') {
    if (!message.guild) return;
    const target = message.mentions.members.first() ?? message.member;
    const user = target.user;
    const roles = target.roles.cache.filter(r => r.id !== message.guild.id)
      .sort((a, b) => b.position - a.position).map(r => `${r}`).slice(0, 10).join(' ');
    return message.reply({ embeds: [userEmbed(user.tag)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'id',       value: user.id,                                              inline: true },
        { name: 'nickname', value: target.nickname ?? 'none',                            inline: true },
        { name: 'joined',   value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R `, inline: true },
        { name: 'created',  value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R `,  inline: true },
        { name: 'bot',      value: user.bot ? 'yes' : 'no',                              inline: true },
        { name: `roles [${target.roles.cache.size - 1}]`, value: roles || 'none' }
      )] });
  }

  if (command === 'avatar' || command === 'av') {
    const target = message.mentions.users.first() ?? message.author;
    const url = target.displayAvatarURL({ size: 1024 });
    return message.reply({ embeds: [userEmbed(`${target.tag}'s Avatar`)
      .setThumbnail(null).setImage(url)
      .setDescription(`[Open full size](${url})`)] });
  }

  if (command === 'banner') {
    const target = await (message.mentions.users.first() ?? message.author).fetch();
    const url = target.bannerURL({ size: 1024 });
    if (!url) return message.reply({ embeds: [infoEmbed(`${target.tag} has no banner`)] });
    return message.reply({ embeds: [userEmbed(`${target.tag}'s Banner`)
      .setThumbnail(null).setImage(url)
      .setDescription(`[Open full size](${url})`)] });
  }

  if (command === 'editsnipe' || command === 'es') {
    if (!message.guild) return;
    const data = editSnipeCache.get(message.channel.id);
    if (!data) return message.reply({ embeds: [infoEmbed('Nothing to Snipe')
      .setDescription('no recent edits in this channel')] });
    return message.reply({ embeds: [logEmbed('Edit Sniped')
      .setThumbnail(data.avatarUrl)
      .addFields(
        { name: 'author', value: data.author, inline: true },
        { name: 'edited', value: `<t:${Math.floor(data.editedAt / 1000)}:R `, inline: true },
        { name: 'before', value: data.before?.slice(0, 1024) || '*(empty)*' },
        { name: 'after',  value: data.after?.slice(0, 1024)  || '*(empty)*' }
      )] });
  }

  if (command === 'reactsnipe' || command === 'rs') {
    if (!message.guild) return;
    const data = reactSnipeCache.get(message.channel.id);
    if (!data) return message.reply({ embeds: [infoEmbed('Nothing to Snipe')
      .setDescription('no recent removed reactions in this channel')] });
    return message.reply({ embeds: [logEmbed('Reaction Sniped')
      .setThumbnail(data.avatarUrl)
      .addFields(
        { name: 'user',    value: data.author, inline: true },
        { name: 'emoji',   value: data.emoji,  inline: true },
        { name: 'removed', value: `<t:${Math.floor(data.removedAt / 1000)}:R `, inline: true },
        { name: 'message', value: data.content?.slice(0, 1024) || '*(no content)*' }
      )] });
  }

  if (command === 'invites') {
    if (!message.guild) return;
    const target = message.mentions.users.first() ?? message.author;
    try {
      const invites = await message.guild.invites.fetch();
      const userInvites = invites.filter(inv => inv.inviter?.id === target.id);
      const total = userInvites.reduce((sum, inv) => sum + (inv.uses ?? 0), 0);
      return message.reply({ embeds: [infoEmbed(`Invites ${target.tag}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: 'total invites', value: `${total}`,          inline: true },
          { name: 'invite links',  value: `${userInvites.size}`, inline: true }
        )] });
    } catch { return message.reply('missing **Manage Guild** permission to fetch invites'); }
  }

  // .purge (also .c which is just a shortcut so u dont gotta type the whole word)
  if (command === 'purge' || command === 'c') {
    if (!message.guild) return;
    const amount = parseInt(args[0], 10);
    if (isNaN(amount) || amount < 1 || amount > 100) return message.reply('provide a number between 1 and 100');
    try {
      const deleted = await message.channel.bulkDelete(amount, true);
      const confirm = await message.channel.send(`deleted **${deleted.size}** messages`);
      setTimeout(() => confirm.delete().catch(() => {}), 4000);
    } catch (err) { return message.reply(`couldn't purge ${err.message}`); }
    return;
  }

  // .delwarn
  if (command === 'delwarn') {
    if (!message.guild) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return message.reply('you need **Moderate Members** to delete warnings');
    const target = message.mentions.users.first();
    const idx    = parseInt(args[1], 10) - 1;
    if (!target)      return;
    if (isNaN(idx))   return message.reply('give the warning number to delete (e.g. `.delwarn @user 2`)');
    const warnsData = loadWarns();
    const list = warnsData[message.guild.id]?.[target.id] ?? [];
    if (!list[idx]) return message.reply(`no warning at index **${idx + 1}**`);
    const removed = list.splice(idx, 1)[0];
    saveWarns(warnsData);
    return message.reply({ embeds: [successEmbed('Warning Removed')
      .addFields(
        { name: 'user',       value: `<@${target.id}> `, inline: true },
        { name: 'removed #',  value: `${idx + 1}`,      inline: true },
        { name: 'reason was', value: removed.reason }
      )] });
  }

  // .roleinfo
  if (command === 'roleinfo') {
    if (!message.guild) return;
    const role = message.mentions.roles?.first();
    if (!role) return;
    const members = message.guild.members.cache.filter(m => m.roles.cache.has(role.id)).size;
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(role.color || 0x2B2D31)
      .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
      .setTitle(role.name)
      .setTimestamp()
      .setFooter({ text: getBotName(), iconURL: getLogoUrl() })
      .addFields(
        { name: 'id',          value: role.id,                                              inline: true },
        { name: 'color',       value: role.hexColor,                                        inline: true },
        { name: 'members',     value: `${members}`,                                         inline: true },
        { name: 'mentionable', value: role.mentionable ? 'yes' : 'no',                     inline: true },
        { name: 'hoisted',     value: role.hoist ? 'yes' : 'no',                           inline: true },
        { name: 'position',    value: `${role.position}`,                                   inline: true },
        { name: 'created',     value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R `, inline: true }
      )] });
  }

  // .config
  if (command === 'config') {
    if (!message.guild) return;
    const setting = args[0];
    const value   = args.slice(1).join(' ');
    if (!setting || !value) return;
    const cfg = loadConfig();
    if (!cfg.serverConfig) cfg.serverConfig = {};
    if (!cfg.serverConfig[message.guild.id]) cfg.serverConfig[message.guild.id] = {};
    cfg.serverConfig[message.guild.id][setting] = value;
    saveConfig(cfg);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Config Updated')
      .addFields({ name: setting, value: value, inline: true }).setTimestamp()] });
  }

  // .logo
  if (command === 'logo') {
    if (!message.guild) return;
    const action = args[0]?.toLowerCase();
    const cfg = loadConfig();
    if (action === 'reset') {
      delete cfg.logoUrl;
      saveConfig(cfg);
      return message.reply({ content: `embed logo reset to default: ${getLogoUrl()}`, allowedMentions: { repliedUser: false } });
    }
    if (!args[0]) {
      return message.reply({ content: `current logo: ${getLogoUrl()}`, allowedMentions: { repliedUser: false } });
    }
    cfg.logoUrl = args[0];
    saveConfig(cfg);
    return message.reply({ content: `embed logo updated: ${args[0]}`, allowedMentions: { repliedUser: false } });
  }

  // .name
  if (command === 'name') {
    if (!message.guild) return;
    const action = args[0]?.toLowerCase();
    const cfg = loadConfig();
    if (action === 'reset') {
      delete cfg.customName;
      saveConfig(cfg);
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Name Reset')
        .setDescription(`embed name has been reset to **${client.user?.username || 'Bot'}**`).setTimestamp()] });
    }
    const newName = args.join(' ');
    if (!newName) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Current Name')
        .setDescription(`current embed name: **${getBotName()}**`).setTimestamp()] });
    }
    cfg.customName = newName;
    saveConfig(cfg);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Name Updated')
      .setDescription(`embed name changed to **${newName}**`).setTimestamp()] });
  }

  // .flag
  if (command === 'flag') {
    if (!message.guild) return;
    const groupId = args[0]?.replace(/\D/g, '');
    if (!groupId) return;
    const flagged = loadFlaggedGroups();
    if (flagged.some(g => g.id === groupId)) return message.reply(`group \`${groupId}\` is already flagged`);
    let groupName = null;
    try {
      const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}`);
      if (res.ok) { const data = await res.json(); groupName = data.name || null; }
    } catch {}
    flagged.push({ id: groupId, name: groupName });
    saveFlaggedGroups(flagged);
    const label = groupName ? `**[${groupName}](https://www.roblox.com/communities/${groupId}/about)**` : `group \`${groupId}\``;
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('🚩 Group Flagged')
      .setDescription(`${label} has been added to the flagged groups list.\n ID: \`${groupId}\``)
      .setTimestamp()] });
  }

  // .unflag
  if (command === 'unflag') {
    if (!message.guild) return;
    const groupId = args[0]?.replace(/\D/g, '');
    if (!groupId) return;
    const flagged = loadFlaggedGroups();
    const idx = flagged.findIndex(g => g.id === groupId);
    if (idx === -1) return message.reply(`group \`${groupId}\` isn't in the flagged list`);
    const [removed] = flagged.splice(idx, 1);
    saveFlaggedGroups(flagged);
    const label = removed.name ? `**${removed.name}**` : `group \`${groupId}\``;
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('✅ Group Unflagged')
      .setDescription(`${label} has been removed from the flagged groups list.\n ID: \`${groupId}\``)
      .setTimestamp()] });
  }

  // .flagged  list every flagged group (hidden from help)
  if (command === 'flagged') {
    const flagged = loadFlaggedGroups();
    if (!flagged.length) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('🚩 Flagged Groups')
        .setDescription('there are no flagged groups right now.').setTimestamp()] });
    }
    const lines = flagged.map((g, i) => {
      const label = g.name
        ? `**[${g.name}](https://www.roblox.com/communities/${g.id}/about)**`
        : `**[Group ${g.id}](https://www.roblox.com/communities/${g.id}/about)**`;
      return `${i + 1}. ${label} \`${g.id}\``;
    });
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`🚩 Flagged Groups (${flagged.length})`)
      .setDescription(lines.join('\n').slice(0, 4000)).setTimestamp()] });
  }

  // .role / .r (WL managers only)
  if (command === 'role' || command === 'r') {
    if (!message.guild) return;
    if (!isWlManager(message.author.id))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use `.role`')] });

    // support both @mention and raw user ID for the target member
    let targetMember = message.mentions.members?.first();
    if (!targetMember && args[0] && /^\d+$/.test(args[0])) {
      try { targetMember = await message.guild.members.fetch(args[0]); } catch {}
    }
    if (!targetMember) return;

    // collect roles from @mentions AND any raw role IDs in args (skip the first arg if it was a user ID)
    const collectedRoles = new Map();
    // add all @mentioned roles
    for (const [id, role] of (message.mentions.roles ?? [])) collectedRoles.set(id, role);
    // scan all args for numeric IDs that aren't the user's ID
    const userArgId = targetMember.id;
    for (const arg of args) {
      if (!/^\d+$/.test(arg)) continue;
      if (arg === userArgId) continue;
      if (collectedRoles.has(arg)) continue;
      const found = message.guild.roles.cache.get(arg);
      if (found) collectedRoles.set(arg, found);
      else {
        // try fetching it
        try {
          const fetched = await message.guild.roles.fetch(arg);
          if (fetched) collectedRoles.set(fetched.id, fetched);
        } catch {}
      }
    }

    if (collectedRoles.size === 0) return message.reply('mention at least one role or provide a role ID to add or remove');

    const added = [];
    const removed = [];
    const failed = [];

    for (const [, role] of collectedRoles) {
      try {
        if (targetMember.roles.cache.has(role.id)) {
          await targetMember.roles.remove(role);
          removed.push(`<@&${role.id}> `);
        } else {
          await targetMember.roles.add(role);
          added.push(`<@&${role.id}> `);
        }
      } catch {
        failed.push(role.name);
      }
    }

    const lines = [];
    if (added.length)   lines.push(`➕ Added ${added.join(', ')} to ${targetMember}`);
    if (removed.length) lines.push(`➖ Removed ${removed.join(', ')} from ${targetMember}`);
    if (failed.length)  lines.push(`❌ Failed: ${failed.join(', ')} (missing perms?)`);

    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(lines.join('\n') || 'nothing changed')] });
  }

  // .inrole
  if (command === 'inrole') {
    if (!message.guild) return;

    // support both @role mention and raw role ID
    let role = message.mentions.roles?.first();
    if (!role && args[0] && /^\d+$/.test(args[0])) {
      role = message.guild.roles.cache.get(args[0]);
      if (!role) {
        try { role = await message.guild.roles.fetch(args[0]); } catch {}
      }
    }
    if (!role) return;

    await fetchMembersCached(message.guild);
    const members = message.guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(role.id));

    if (!members.size) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Members with ${role.name}`).setDescription('nobody has this role')] });

    const lines = [...members.values()]
      .sort((a, b) => a.user.username.localeCompare(b.user.username))
      .map((m, i) => `${String(i + 1).padStart(2, '0')} ${m} (${m.user.username})`)
      .join('\n');

    const chunks = [];
    const CHUNK = 4000;
    for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));

    for (let i = 0; i < chunks.length; i++) {
      const e = baseEmbed().setColor(0x2C2F33)
        .setTitle(i === 0 ? `Members with ${role.name}` : `Members with ${role.name} (cont.)`)
        .setDescription(chunks[i])
        .setFooter({ text: `${members.size} total member${members.size !== 1 ? 's' : ''}`, iconURL: getLogoUrl() });
      await message.reply({ embeds: [e] });
    }
    return;
  }

  // .rid
  if (command === 'rid') {
    const input = args[0];
    if (!input) return;
    if (!/^\d+$/.test(input)) return message.reply('provide a numeric Roblox ID e.g. `.rid 1`');
    try {
      const [user, avatarRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${input}`).then(r => r.json()),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${input}&size=420x420&format=Png&isCircular=false`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      if (user.errors || !user.name) return message.reply("could not find a Roblox user with that ID");
      const profileUrl = `https://www.roblox.com/users/${input}/profile`;
      const avatarUrl = avatarRes.data?.[0]?.imageUrl;
      const created = new Date(user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const e = baseEmbed()
        .setColor(0x2C2F33)
        .setTitle(`${user.displayName} (@${user.name})`)
        .setURL(profileUrl)
        .setThumbnail(avatarUrl)
        .setDescription(`[View Profile](${profileUrl})`)
        .addFields(
          { name: '🆔 User ID',   value: `\`${input}\``, inline: true },
          { name: '👤 Username',  value: user.name,       inline: true },
          { name: '📅 Created',   value: created,         inline: true },
        )
        .setTimestamp();
      const joinBtn = await buildJoinButton(input);
      return message.reply({
        embeds: [e],
        components: [new ActionRowBuilder().addComponents(joinBtn)]
      });
    } catch { return message.reply("something went wrong fetching that user, try again"); }
  }

  // .id
  // changes the group id and link saved in config
  if (command === 'id') {
    if (!loadWhitelist().includes(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Not Whitelisted').setDescription("you are not whitelisted for this")] });
    const newGroupId = args[0];
    if (!newGroupId || isNaN(newGroupId)) return;
    try {
      const cfgPath = path.join(__dirname, 'config.json');
      const cfg = loadJSON(cfgPath);
      cfg.groupId = newGroupId;
      cfg.groupLink = `https://www.roblox.com/communities/${newGroupId}/about`;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`group id updated to \`${newGroupId}\`\nnew link: ${cfg.groupLink}`)] });
    } catch (err) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`something went wrong saving that ${err.message}`)] });
    }
  }

  // .joinserver <invite link> (WL managers + temp owners)
  // bots can NOT auto-accept invites (Discord API restriction). this command instead
  // validates the invite, fetches server info, and replies with a one-click OAuth2
  // install link pre-targeted at that server (guild_id + disable_guild_select=true)
  // so the target server's owner just clicks once to add the bot.
  if (command === 'joinserver') {
    if (!isWlManager(message.author.id) && !isTempOwner(message.author.id))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers and temp owners can use `.joinserver`')] });

    const raw = args[0];
    if (!raw) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('usage: `.joinserver <invite link or code>`')] });

    // accept full URLs (discord.gg/x, discord.com/invite/x, discordapp.com/invite/x) or bare codes
    const inviteCode = (raw.match(/(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)([\w-]+)/i)?.[1] || raw).trim();

    let invite;
    try {
      invite = await client.fetchInvite(inviteCode);
    } catch (e) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`that invite is invalid or expired (${e.message})`)] });
    }

    const targetGuildId = invite.guild?.id;
    if (!targetGuildId) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('that invite is for a Group DM, not a server — bots can\'t join Group DMs')] });
    }

    if (client.guilds.cache.has(targetGuildId)) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('already in that server')
        .setDescription(`I'm already in **${invite.guild.name}** (\`${targetGuildId}\`). nothing to do.`)] });
    }

    const clientId = client.user?.id || process.env.CLIENT_ID || '';
    if (!clientId) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('bot client id not ready, try again in a few seconds')] });

    // pre-target the OAuth dialog at the invite's server so the target server owner just clicks once
    const installUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot+applications.commands&guild_id=${targetGuildId}&disable_guild_select=true`;

    const embed = baseEmbed().setColor(0x2C2F33).setTitle('join server')
      .setDescription([
        `**heads up:** Discord doesn't let bots accept invite links on their own — only a human with **Manage Server** in the target server can authorize me.`,
        ``,
        `**target server:** ${invite.guild.name} \`(${targetGuildId})\``,
        invite.memberCount ? `**members:** ~${invite.memberCount}` : null,
        ``,
        `[**click here to add me to that server**](${installUrl})`,
        `(opens the Discord auth dialog with the server pre-selected — one click and I'm in)`,
      ].filter(Boolean).join('\n'));
    if (invite.guild.icon) embed.setThumbnail(`https://cdn.discordapp.com/icons/${targetGuildId}/${invite.guild.icon}.png`);
    // ping the user who ran the command so they get an actual notification with the install link
    return message.reply({
      content: `<@${message.author.id}>`,
      embeds: [embed],
      allowedMentions: { users: [message.author.id] },
    });
  }

  // .leaveserver (WL managers only)
  if (command === 'leaveserver') {
    if (!isWlManager(message.author.id))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use `.leaveserver`')] });

    const serverId = args[0];

    if (serverId) {
      const targetGuild = client.guilds.cache.get(serverId);
      if (!targetGuild) return message.reply(`I am not in a server with ID \`${serverId}\``);
      const reply = await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`leaving **${targetGuild.name}**...`)] });
      try { await targetGuild.leave(); } catch (e) { return reply.edit(`couldn't leave ${e.message}`); }
      return;
    }

    if (!message.guild) return message.reply('use this in a server or provide a server id as an argument');
    await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`leaving **${message.guild.name}**...`)] });
    try { await message.guild.leave(); } catch (e) { return message.reply(`couldn't leave ${e.message}`); }
    return;
  }

  // .servers (WL managers only)
  if (command === 'servers') {
    if (!isWlManager(message.author.id))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use `.servers`')] });

    const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!guilds.length) return message.reply('not in any servers');

    const lines = guilds.map((g, i) => `\`${String(i + 1).padStart(2, '0')}\` **${g.name}** \`${g.id}\` (${g.memberCount} members)`);

    const chunks = [];
    const CHUNK = 4000;
    let current = '';
    for (const line of lines) {
      if ((current + '\n' + line).length > CHUNK) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) chunks.push(current);

    for (let i = 0; i < chunks.length; i++) {
      const e = baseEmbed().setColor(0x2C2F33)
        .setTitle(i === 0 ? `Servers (${guilds.length})` : `Servers (cont.)`)
        .setDescription(chunks[i]);
      await message.reply({ embeds: [e] });
    }
    return;
  }


  // .rankup
  if (command === 'rankup') {
    if (!message.guild) return;

    // optional "3x" anywhere in args to jump N ranks at once
    // (so .rankup @user 3x works the same as .rankup 3x @user, ppl type both ways)
    let levels = 1;
    const argsCleaned = [];
    for (const a of args) {
      if (a && /^\d+x$/i.test(a)) {
        levels = Math.min(Math.max(parseInt(a, 10), 1), 20);
      } else if (a) {
        argsCleaned.push(a);
      }
    }

    const rankup = loadRankup();
    const guildRanks = rankup[message.guild.id]?.roles || [];
    if (!guildRanks.length)
      return message.reply(`no rank roles set use \`${prefix}setrankroles @role1 @role2 ...\` to configure the rank ladder`);

    const rawTokens = argsCleaned;
    if (!rawTokens.length) return;

    await fetchMembersCached(message.guild);

    // collect unique members from mentions + any bare username/ID tokens
    const mentionedMembers = [...(message.mentions.members?.values() ?? [])];
    const seenIds = new Set(mentionedMembers.map(m => m.id));
    const allTargets = [...mentionedMembers];

    for (const token of rawTokens) {
      const clean = token.replace(/[<@!>]/g, '').trim();
      if (!clean || !(/\w/.test(clean)) || seenIds.has(clean)) continue;
      if (/^\d{17,19}$/.test(clean)) {
        const m = message.guild.members.cache.get(clean);
        if (m && !seenIds.has(m.id)) { allTargets.push(m); seenIds.add(m.id); }
        continue;
      }
      const found = message.guild.members.cache.find(m =>
        m.user.username.toLowerCase() === clean.toLowerCase() ||
        m.displayName.toLowerCase() === clean.toLowerCase()
      );
      if (found && !seenIds.has(found.id)) { allTargets.push(found); seenIds.add(found.id); }
    }

    if (!allTargets.length) return message.reply("couldn't find any users to rank up");

    await message.guild.roles.fetch();

    const status = await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`ranking up **${allTargets.length}** user${allTargets.length !== 1 ? 's' : ''}...`)] });

    let completed = 0, skipped = 0;
    const rolesAwarded = [];
    const skipReasons = [];

    for (const member of allTargets) {
      try {
        await member.fetch();
        let currentIdx = -1;
        for (let i = guildRanks.length - 1; i >= 0; i--) {
          if (member.roles.cache.has(guildRanks[i])) { currentIdx = i; break; }
        }
        const nextIdx = currentIdx + levels;
        if (nextIdx >= guildRanks.length) { skipped++; skipReasons.push(`${member.displayName} already at highest rank`); continue; }
        const newRoleId = guildRanks[nextIdx];
        const newRole = message.guild.roles.cache.get(newRoleId) ?? await message.guild.roles.fetch(newRoleId).catch(() => null);
        if (!newRole) { skipped++; skipReasons.push(`${member.displayName} target role not found`); continue; }
        // remove old rank roles, add new one
        for (const rId of guildRanks) {
          if (rId !== newRoleId && member.roles.cache.has(rId))
            await member.roles.remove(rId).catch(() => {});
        }
        await member.roles.add(newRoleId);
        rolesAwarded.push({ member, roleName: newRole.name });
        completed++;
      } catch (err) { skipped++; skipReasons.push(`${member.displayName} ${err.message}`); }
    }

    const total = completed + skipped;
    const resultLines = [
      'RESULT COUNT',
      ' ',
      `COMPLETED ${completed}`,
      `SKIPPED ${skipped}`,
      `TOTAL ${total}`,
    ].join('\n');

    const summaryEmbed = baseEmbed()
      .setTitle('Rankup Complete')
      .setColor(0x2C2F33)
      .setDescription('```\n' + resultLines + '\n```')
      .setTimestamp();

    const embeds = [summaryEmbed];

    if (rolesAwarded.length) {
      const awardLines = rolesAwarded.map(({ member, roleName }) => `${member} ${roleName}`).join('\n');
      embeds.push(baseEmbed().setTitle('ROLES AWARDED').setColor(0x2C2F33).setDescription(awardLines).setTimestamp());
    }
    if (skipReasons.length) {
      embeds.push(baseEmbed().setTitle('SKIPPED').setColor(0x555555).setDescription(skipReasons.join('\n')).setTimestamp());
    }

    return status.edit({ content: '', embeds });
  }

  // .setrankroles
  if (command === 'setrankroles') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !isWlManager(message.author.id))
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('you need to be whitelisted to configure rank roles')] });

    const sub = args[0]?.toLowerCase();

    if (sub === 'clear') {
      const rankup = loadRankup();
      delete rankup[message.guild.id];
      saveRankup(rankup);
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('rank roles cleared for this server')] });
    }

    if (sub === 'list') {
      const guildRanks = loadRankup()[message.guild.id]?.roles || [];
      if (!guildRanks.length) return message.reply(`no rank roles set use \`${prefix}setrankroles @role1 @role2 ...\` to configure`);
      const lines = guildRanks.map((id, i) => `**${i + 1}.** <@&${id}> `).join('\n');
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rank Ladder').setDescription(lines).setTimestamp()] });
    }

    const collectedIds = [];
    const seen = new Set();
    // Parse role mentions in the exact order they appear in the message text
    for (const match of message.content.matchAll(/<@&(\d+)>/g)) {
      const id = match[1];
      if (!seen.has(id) && message.guild.roles.cache.has(id)) { collectedIds.push(id); seen.add(id); }
    }
    // Also handle any bare numeric role IDs in args
    for (const arg of args) {
      if (!/^\d+$/.test(arg) || seen.has(arg)) continue;
      const r = message.guild.roles.cache.get(arg);
      if (r) { collectedIds.push(r.id); seen.add(r.id); }
    }

    if (!collectedIds.length)
      return;

    const rankup = loadRankup();
    if (!rankup[message.guild.id]) rankup[message.guild.id] = {};
    rankup[message.guild.id].roles = collectedIds;
    saveRankup(rankup);

    const lines = collectedIds.map((id, i) => `**${i + 1}.** <@&${id}> `).join('\n');
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rank Ladder Set')
      .setDescription(lines)
      .setFooter({ text: `${collectedIds.length} rank${collectedIds.length !== 1 ? 's' : ''} configured • lowest → highest`, iconURL: getLogoUrl() })
      .setTimestamp()] });
  }

  // .fileroles
  if (command === 'fileroles') {
    if (!message.guild) return;
    const guildRanks = loadRankup()[message.guild.id]?.roles || [];
    if (!guildRanks.length)
      return message.reply(`no rank roles configured use \`${prefix}setrankroles @lowest @next @highest\` first`);
    const rows = guildRanks.map((id, i) => {
      const role = message.guild.roles.cache.get(id);
      return { rank: i + 1, roleId: id, roleName: role?.name ?? 'unknown' };
    });
    const json = JSON.stringify({ guildId: message.guild.id, guildName: message.guild.name, updatedAt: new Date().toISOString(), rankLadder: rows }, null, 2);
    const buf = Buffer.from(json, 'utf8');
    const attachment = new AttachmentBuilder(buf, { name: `rank ladder ${message.guild.id}.json` });
    const lines = rows.map(r => `**${r.rank}.** <@&${r.roleId}> \`${r.roleName}\``).join('\n');
    return message.reply({
      embeds: [baseEmbed().setColor(0x2C2F33).setTitle(`Rank Ladder ${message.guild.name}`)
        .setDescription(lines)
        .setFooter({ text: `${rows.length} rank${rows.length !== 1 ? 's' : ''} • lowest → highest`, iconURL: getLogoUrl() })
        .setTimestamp()],
      files: [attachment]
    });
  }



  // .rfile
  if (command === 'rfile') {
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `.rfile`')] });
    const vData   = loadVerify();
    const entries = Object.entries(vData.verified || {});
    if (!entries.length) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('no registered members yet use `/pregister` to add members')] });
    const lines = entries.map(([discordId, { robloxName }]) => `<@${discordId}> \`${robloxName}\``);
    const PAGE_SIZE = 20;
    const pages = [];
    for (let i = 0; i < lines.length; i += PAGE_SIZE) pages.push(lines.slice(i, i + PAGE_SIZE).join('\n'));
    // build export JSON
    const exportObj = {};
    for (const [discordId, info] of entries) {
      exportObj[discordId] = { discordId, robloxId: info.robloxId, robloxName: info.robloxName, verifiedAt: info.verifiedAt };
    }
    const exportBuf = Buffer.from(JSON.stringify(exportObj, null, 2), 'utf8');
    const exportAttachment = new AttachmentBuilder(exportBuf, { name: 'registered members.json' });
    let page = 0;
    const makeEmbed = () => baseEmbed().setColor(0x2C2F33)
      .setTitle(`Registered Members (${entries.length})`)
      .setDescription(pages[page])
      .setFooter({ text: `page ${page + 1} of ${pages.length} • ${entries.length} registered member${entries.length !== 1 ? 's' : ''}`, iconURL: getLogoUrl() })
      .setTimestamp();
    const makeRow = () => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rfile prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId('rfile next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length - 1)
    );
    const msg = await message.reply({ embeds: [makeEmbed()], files: [exportAttachment], components: pages.length > 1 ? [makeRow()] : [] });
    if (pages.length === 1) return;
    const collector = msg.createMessageComponentCollector({ time: 120000 });
    collector.on('collect', async btn => {
      if (btn.user.id !== message.author.id) return btn.reply({ content: 'you did not run this command', ephemeral: true });
      if (btn.customId === 'rfile next') page = Math.min(page + 1, pages.length - 1);
      else page = Math.max(page - 1, 0);
      await btn.update({ embeds: [makeEmbed()], components: [makeRow()] });
    });
    collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
    return;
  }

  // .lvfile
  if (command === 'lvfile') {
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `.lvfile`')] });
    if (!fs.existsSync(LINKED_VERIFIED_FILE)) {
      return message.reply({ embeds: [errorEmbed('file not found').setDescription('`linked verified.json` does not exist yet no one has verified')] });
    }
    const data = fs.readFileSync(LINKED_VERIFIED_FILE);
    const count = Object.keys(JSON.parse(data)).length;
    const attachment = new AttachmentBuilder(data, { name: 'linked verified.json' });
    return message.reply({
      embeds: [successEmbed('Linked & Verified Export')
        .setDescription(`**${count}** linked account${count !== 1 ? 's' : ''} in file`)
        .setTimestamp()],
      files: [attachment]
    });
  }

  // .import
  // Usage: .import (attach a registered members.json or linked verified.json)
  // Bulk imports registered users from a rfile/lvfile JSON export. WL managers only.
  if (command === 'import') {
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can use `.import`')] });
    const attachment = message.attachments.first();
    if (!attachment || !attachment.name.endsWith('.json')) return;
    const status = await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('importing registered users...')] });
    try {
      const res = await fetch(attachment.url);
      const raw = await res.json();
      if (typeof raw !== 'object' || Array.isArray(raw)) return status.edit({ embeds: [errorEmbed('invalid file').setDescription('expected a JSON object with Discord IDs as keys')] });
      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};
      let added = 0, updated = 0, skippedCount = 0;
      for (const [discordId, info] of Object.entries(raw)) {
        if (!info?.robloxId || !info?.robloxName) { skippedCount++; continue; }
        const rid = String(info.robloxId);
        const existingDiscordForRoblox = vData.robloxToDiscord[rid];
        if (existingDiscordForRoblox && existingDiscordForRoblox !== discordId) { skippedCount++; continue; }
        const prevEntry = vData.verified[discordId];
        if (prevEntry && String(prevEntry.robloxId) !== rid) delete vData.robloxToDiscord[String(prevEntry.robloxId)];
        const isNew = !vData.verified[discordId];
        vData.verified[discordId] = { robloxId: info.robloxId, robloxName: info.robloxName, verifiedAt: info.verifiedAt ?? Date.now() };
        vData.robloxToDiscord[rid] = discordId;
        if (isNew) added++; else updated++;
      }
      saveVerify(vData);
      saveLinkedVerified(vData);
      const total = Object.keys(vData.verified).length;
      return status.edit({ embeds: [successEmbed('Import Complete').addFields(
        { name: 'Added', value: String(added), inline: true },
        { name: 'Updated', value: String(updated), inline: true },
        { name: 'Skipped', value: String(skippedCount), inline: true },
        { name: 'Total Registered', value: String(total), inline: false }
      ).setTimestamp()] });
    } catch (err) { return status.edit({ embeds: [errorEmbed('import failed').setDescription(err.message)] }); }
  }

  // .register
  // Usage: .register RobloxUsername
  // Self service: links the calling Discord user to a Roblox account.
  if (command === 'register') {
    const robloxInput = args[0]?.trim();
    if (!robloxInput) return;

    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [robloxInput], excludeBannedUsers: false })
      })).json();
      const robloxUser = res.data?.[0];
      if (!robloxUser)
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`could not find a Roblox user named \`${robloxInput}\``)] });

      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};

      const existingDiscordId = vData.robloxToDiscord[String(robloxUser.id)];
      if (existingDiscordId && existingDiscordId !== message.author.id) {
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
          .setDescription(`\`${robloxUser.name}\` is already registered to a different account contact a staff member`)] });
      }

      const prevEntry = vData.verified[message.author.id];
      if (prevEntry && String(prevEntry.robloxId) !== String(robloxUser.id)) {
        delete vData.robloxToDiscord[String(prevEntry.robloxId)];
      }

      vData.verified[message.author.id]               = { robloxId: robloxUser.id, robloxName: robloxUser.name, verifiedAt: Date.now() };
      vData.robloxToDiscord[String(robloxUser.id)]     = message.author.id;
      saveVerify(vData);
      saveLinkedVerified(vData);

      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json();
      const avatarUrl = avatarData.data?.[0]?.imageUrl ?? null;

      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Registration Successful')
        .setThumbnail(avatarUrl ?? getLogoUrl())
        .setDescription(`You are now registered as **${robloxUser.name}**`)
        .addFields(
          { name: 'Discord', value: `<@${message.author.id}> `, inline: true },
          { name: 'Roblox',  value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true }
        ).setTimestamp()] });
    } catch (err) { return message.reply(`register failed ${err.message}`); }
  }

  // .pregister
  // Usage: .pregister RobloxUsername @user (or userId)
  // Registers another Discord user to a Roblox account. WL managers only.
  if (command === 'pregister') {
    if (!message.guild) return;
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use `.pregister`')] });
    const robloxInput = args[0]?.trim();
    const discordRaw  = args[1]?.trim();
    if (!robloxInput || !discordRaw) return;

    // resolve discord user support mention or raw id
    const discordId = discordRaw.replace(/[<@!>]/g, '');
    if (!/^\d{17,20}$/.test(discordId)) return message.reply('provide a valid Discord user mention or ID as the second argument');
    let discordUser;
    try { discordUser = await client.users.fetch(discordId); } catch { return message.reply("could not find that Discord user"); }

    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [robloxInput], excludeBannedUsers: false })
      })).json();
      const robloxUser = res.data?.[0];
      if (!robloxUser) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`could not find a Roblox user named \`${robloxInput}\``)] });

      const vData = loadVerify();
      if (!vData.verified) vData.verified = {};
      if (!vData.robloxToDiscord) vData.robloxToDiscord = {};

      const existingDiscordId = vData.robloxToDiscord[String(robloxUser.id)];
      if (existingDiscordId && existingDiscordId !== discordId) {
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
          .setDescription(`\`${robloxUser.name}\` is already registered to a different Discord account`)] });
      }

      const prevEntry = vData.verified[discordId];
      if (prevEntry && String(prevEntry.robloxId) !== String(robloxUser.id)) {
        delete vData.robloxToDiscord[String(prevEntry.robloxId)];
      }

      vData.verified[discordId]                    = { robloxId: robloxUser.id, robloxName: robloxUser.name, verifiedAt: Date.now() };
      vData.robloxToDiscord[String(robloxUser.id)] = discordId;
      saveVerify(vData);
      saveLinkedVerified(vData);

      const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUser.id}&size=420x420&format=Png&isCircular=false`)).json();
      const avatarUrl  = avatarData.data?.[0]?.imageUrl ?? null;

      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Registration Successful')
        .setThumbnail(avatarUrl ?? getLogoUrl())
        .setDescription(`<@${discordId}> is now registered as **${robloxUser.name}**`)
        .addFields(
          { name: 'Discord',       value: `<@${discordId}> `, inline: true },
          { name: 'Roblox',        value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true },
          { name: 'registered by', value: `<@${message.author.id}> `, inline: true }
        ).setTimestamp()] });
    } catch (err) { return message.reply(`pregister failed ${err.message}`); }
  }

  // .verify
  // .verify @user gives the configured verify role to a user
  // .verify role set @role sets which role is given on verify
  // .verify role remove clears the verify role
  if (command === 'verify') {
    if (!message.guild) return;
    if (!isWlManager(message.author.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('only whitelist managers can use `.verify`')] });

    const sub = args[0]?.toLowerCase();

    // .verify role set / remove
    if (sub === 'role') {
      const action = args[1]?.toLowerCase();
      if (action === 'set') {
        const role = message.mentions.roles.first();
        if (!role) return message.reply('mention a role e.g. `.verify role set @Verified`');
        const cfg = loadConfig(); cfg.verifyRoleId = role.id; saveConfig(cfg);
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('verify role set')
          .addFields({ name: 'role', value: `${role}`, inline: true }, { name: 'set by', value: message.author.tag, inline: true }).setTimestamp()] });
      }
      if (action === 'remove') {
        const cfg = loadConfig(); delete cfg.verifyRoleId; saveConfig(cfg);
        return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('verify role removed')] });
      }
      return;
    }

    // .verify @user
    const cfg = loadConfig();
    if (!cfg.verifyRoleId) return message.reply(`no verify role set use \`${prefix}verify role set @role\` first`);
    let target = message.mentions.members?.first();
    if (!target && args[0] && /^\d{17,20}$/.test(args[0])) {
      try { target = await message.guild.members.fetch(args[0]); } catch {}
    }
    if (!target) return;
    const role = message.guild.roles.cache.get(cfg.verifyRoleId);
    if (!role) return message.reply("couldn't find the configured verify role it may have been deleted");
    if (target.roles.cache.has(role.id)) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`${target} already has ${role}`)] });
    try {
      await target.roles.add(role);
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('verified')
        .addFields(
          { name: 'user',        value: `${target}`, inline: true },
          { name: 'role',        value: `${role}`, inline: true },
          { name: 'verified by', value: message.author.tag, inline: true }
        ).setTimestamp()] });
    } catch { return message.reply("couldn't add the role check my permissions"); }
  }

  // .registeredlist
  if (command === 'registeredlist') {
    const vData   = loadVerify();
    const entries = Object.entries(vData.verified || {});

    if (!entries.length) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Verified Accounts')
        .setDescription('no one has linked their Roblox account yet')] });
    }

    // Build one line per user: Discord mention → Roblox username (linked profile)
    const lines = [];
    for (const [discordId, { robloxName, robloxId }] of entries) {
      lines.push(`<@${discordId}> → [\`${robloxName}\`](https://www.roblox.com/users/${robloxId}/profile)`);
    }

    // Split into pages of 20 so embeds don't hit the 4096 char description limit
    const PAGE_SIZE = 20;
    const pages     = [];
    for (let i = 0; i < lines.length; i += PAGE_SIZE) {
      pages.push(lines.slice(i, i + PAGE_SIZE));
    }

    const totalPages = pages.length;
    const buildPage  = (idx) => baseEmbed().setColor(0x2C2F33)
      .setTitle(`Verified Accounts [${entries.length}]`)
      .setDescription(pages[idx].join('\n'))
      .setFooter({ text: `Page ${idx + 1} of ${totalPages} • ${getBotName()}`, iconURL: getLogoUrl() });

    if (totalPages === 1) {
      return message.reply({ embeds: [buildPage(0)] });
    }

    // Multi page with buttons
    const buildRow = (idx) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rlist ${idx - 1}`).setLabel('‹ Back').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
      new ButtonBuilder().setCustomId(`rlist ${idx + 1}`).setLabel('Next ›').setStyle(ButtonStyle.Secondary).setDisabled(idx === totalPages - 1)
    );

    const reply = await message.reply({ embeds: [buildPage(0)], components: [buildRow(0)] });

    const collector = reply.createMessageComponentCollector({ time: 5 * 60 * 1000 });
    collector.on('collect', async i => {
      if (i.user.id !== message.author.id) return i.reply({ content: 'only the user who ran this command can navigate', ephemeral: true });
      const page = parseInt(i.customId.split(' ')[1]);
      await i.update({ embeds: [buildPage(page)], components: [buildRow(page)] });
    });
    collector.on('end', () => reply.edit({ components: [] }).catch(() => {}));
    return;
  }

  if (command === 'linked') {
    const vData = loadVerify();
    const mention = message.mentions.users.first();

    if (mention) {
      const linked = vData.verified?.[mention.id];
      if (!linked) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`${mention} has no linked Roblox account`)] });
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle('Linked Account')
        .addFields(
          { name: 'Discord', value: `${mention}`, inline: true },
          { name: 'Roblox',  value: `[\`${linked.robloxName}\`](https://www.roblox.com/users/${linked.robloxId}/profile)`, inline: true }
        )
        .setTimestamp(new Date(linked.verifiedAt))] });
    }

    // Lookup by Roblox username
    const inputName = args[0];
    if (!inputName) return;

    let robloxUser;
    try {
      const res = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [inputName], excludeBannedUsers: false })
      })).json();
      robloxUser = res.data?.[0];
    } catch {}

    if (!robloxUser) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`couldn't find Roblox user \`${inputName}\``)] });

    const discordId = vData.robloxToDiscord?.[String(robloxUser.id)];
    if (!discordId) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`\`${robloxUser.name}\` has no linked Discord account`)] });

    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33)
      .setTitle('Linked Account')
      .addFields(
        { name: 'Roblox',  value: `[\`${robloxUser.name}\`](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true },
        { name: 'Discord', value: `<@${discordId}> `, inline: true }
      )] });
  }

  // .attend
  if (command === 'attend') {
    if (!message.guild) return;

    // Usage: .attend @discordUser robloxUsername
    // or: .attend discordId robloxUsername
    // or: .attend @user1 roblox1 @user2 roblox2 ... (bulk)
    if (!args.length) return;

    const queueData = loadQueue();
    const queueChannelId = queueData[message.guild.id]?.channelId;
    const queueChannel = queueChannelId
      ? message.guild.channels.cache.get(queueChannelId) ?? message.channel
      : message.channel;

    // Pair up args: could be interleaved mentions + roblox names
    // Simple approach: pair each mention/id with the next non mention arg as roblox name
    await fetchMembersCached(message.guild);

    const pairs = [];
    const tokens = [...args];
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      // Try to resolve as Discord user
      let member = null;
      const mentionMatch = token.match(/^<@!?(\d+)>$/);
      if (mentionMatch) {
        member = message.guild.members.cache.get(mentionMatch[1]);
      } else if (/^\d{17,19}$/.test(token)) {
        member = message.guild.members.cache.get(token);
      } else {
        // could be a username
        member = message.guild.members.cache.find(m =>
          m.user.username.toLowerCase() === token.toLowerCase() ||
          m.displayName.toLowerCase() === token.toLowerCase()
        );
      }

      if (member) {
        // next token should be roblox username
        const roblox = tokens[i + 1] && !tokens[i + 1].startsWith('<@') && !/^\d{17,19}$/.test(tokens[i + 1])
          ? tokens[i + 1]
          : null;
        pairs.push({ member, roblox: roblox || 'unknown' });
        i += roblox ? 2 : 1;
      } else {
        i++;
      }
    }

    // If no pairs found from mentions, try simple mode: first arg = user, second = roblox
    if (!pairs.length) {
      const userToken = args[0];
      const robloxName = args.slice(1).join(' ') || 'unknown';
      const mentionMatch = userToken?.match(/^<@!?(\d+)>$/);
      let member = null;
      if (mentionMatch) member = message.guild.members.cache.get(mentionMatch[1]);
      else if (/^\d{17,19}$/.test(userToken)) member = message.guild.members.cache.get(userToken);
      if (member) pairs.push({ member, roblox: robloxName });
    }

    if (!pairs.length) return message.reply("couldn't resolve any Discord users try mentioning them");

    for (const { member, roblox } of pairs) {
      let prefixAttendAvatarUrl = null;
      try {
        const robloxRes = await (await fetch('https://users.roblox.com/v1/usernames/users', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: [roblox], excludeBannedUsers: false })
        })).json();
        const robloxUserId = robloxRes.data?.[0]?.id;
        if (robloxUserId) {
          const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUserId}&size=420x420&format=Png&isCircular=false`)).json();
          prefixAttendAvatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
        }
      } catch {}
      const attendEmbed = new EmbedBuilder()
        .setColor(0x2C2F33)
        .setTitle('registered user joined this raid')
        .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
        .addFields(
          { name: 'Discord', value: `${member}`, inline: false },
          { name: 'Roblox',  value: `\`${roblox}\``, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: getBotName(), iconURL: getLogoUrl() });
      if (prefixAttendAvatarUrl) attendEmbed.setThumbnail(prefixAttendAvatarUrl);
      await queueChannel.send({ embeds: [attendEmbed] });
    }

    if (queueChannel.id !== message.channel.id) {
      await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`logged **${pairs.length}** attendee${pairs.length !== 1 ? 's' : ''} to ${queueChannel}`)] });
    }
    return;
  }

  // .setraidvc
  if (command === 'setraidvc') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !isWlManager(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const vc = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
    if (!vc || vc.type !== 2) return;
    const qData = loadQueue();
    if (!qData[message.guild.id]) qData[message.guild.id] = {};
    qData[message.guild.id].raidVcId = vc.id;
    qData[message.guild.id].vcLogged = [];
    saveQueue(qData);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Raid Voice Channel Set').setDescription(`attendance will now be auto logged when verified group members join ${vc}\n\nThe logged list resets whenever you set a new channel.`).setTimestamp()] });
  }

  // .setrollcallchannel — sets where the big summary embed (everyone in the rollcall) gets posted
  // when u run .endrollcall. usage: .setrollcallchannel #channel
  if (command === 'setrollcallchannel') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !isWlManager(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const ch = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
    if (!ch || !ch.isTextBased?.()) return message.reply(`provide a text channel like \`${prefix}setrollcallchannel #channel\``);
    const qData = loadQueue();
    if (!qData[message.guild.id]) qData[message.guild.id] = {};
    qData[message.guild.id].rollCallChannelId = ch.id;
    saveQueue(qData);
    return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Rollcall Channel Set').setDescription(`when u run \`${prefix}endrollcall\` the full list of who reacted (with clickable Discord + Roblox names) will get posted in ${ch}`).setTimestamp()] });
  }

  // .lb — raid leaderboard. shows who has been in the most rollcalls/raids
  // (uses the same raid stats that .endrollcall already updates so the count = how many rollcalls they were in)
  // paginated 10 per page with transparent < / > buttons (Secondary style).
  if (command === 'lb') {
    if (!message.guild) return;
    const stats = loadRaidStats()[message.guild.id] || {};
    const verify = loadVerify();
    const rows = Object.entries(stats)
      .map(([discordId, s]) => ({ discordId, count: s?.totalRaids || 0 }))
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count);
    if (!rows.length) {
      return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Raid Leaderboard').setDescription('nobody has joined a raid yet (no rollcalls have been logged)')] });
    }
    const PER_PAGE = 10;
    const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    const medals = ['🥇', '🥈', '🥉'];
    // build a single page (10 rows). resolves discord usernames lazily so big leaderboards dont stall.
    const buildPage = async (page) => {
      const start = page * PER_PAGE;
      const slice = rows.slice(start, start + PER_PAGE);
      const lines = await Promise.all(slice.map(async (r, i) => {
        const overall = start + i;
        const v = verify.verified?.[r.discordId];
        let discordName = null;
        try {
          const u = message.client.users.cache.get(r.discordId) || await message.client.users.fetch(r.discordId).catch(() => null);
          if (u) discordName = u.username;
        } catch {}
        const discordLink = `[${discordName || `user-${r.discordId.slice(-4)}`}](https://discord.com/users/${r.discordId})`;
        const robloxLink = v
          ? `[${v.robloxName}](https://www.roblox.com/users/${v.robloxId}/profile)`
          : '`not registered`';
        const rank = overall < 3 ? medals[overall] : `**#${overall + 1}**`;
        return `${rank} ${discordLink} • Roblox: ${robloxLink} — **${r.count}** raid${r.count !== 1 ? 's' : ''}`;
      }));
      return baseEmbed().setColor(0x2C2F33)
        .setTitle('Raid Leaderboard')
        .setDescription(lines.join('\n') || 'no entries')
        .setFooter({ text: `page ${page + 1}/${totalPages} • ${rows.length} member${rows.length !== 1 ? 's' : ''} • counted from rollcall logs • ${getBotName()}`, iconURL: getLogoUrl() })
        .setTimestamp();
    };
    // < / > buttons. Secondary style is the transparent/grey one in discord
    // customId encodes the requesting user so randoms can't flip pages on someone else's leaderboard
    const buildRow = (page) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lb ${page - 1} ${message.author.id}`).setLabel('<').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`lb ${page + 1} ${message.author.id}`).setLabel('>').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
    );
    const initialEmbed = await buildPage(0);
    const components = totalPages > 1 ? [buildRow(0)] : [];
    return message.reply({ embeds: [initialEmbed], components });
  }

  // .lbreset — wipe the raid leaderboard for this server.
  // wl managers + temp owners can run it (anyone isWlManager() returns true for).
  if (command === 'lbreset') {
    if (!message.guild) return;
    if (!isWlManager(message.author.id))
      return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers and temp owners can wipe the raid leaderboard')] });
    const all = loadRaidStats();
    const had = Object.keys(all[message.guild.id] || {}).length;
    delete all[message.guild.id];
    saveRaidStats(all);
    return message.reply({ embeds: [successEmbed('Raid Leaderboard Wiped')
      .setDescription(`cleared **${had}** member${had !== 1 ? 's' : ''} from the raid leaderboard for this server`)
      .addFields({ name: 'wiped by', value: message.author.tag })] });
  }

  // .rollcall
  if (command === 'rollcall') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !isWlManager(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const rcEmbed = new EmbedBuilder().setColor(0x2C2F33)
      .setTitle('RAID QUEUE')
      .setDescription('REACT TO THIS MESSAGE IF YOU ARE IN GAME/ IN QUEUE.');
    const rcMsg = await message.channel.send({ embeds: [rcEmbed] });
    await rcMsg.react('✅');
    const qData = loadQueue();
    if (!qData[message.guild.id]) qData[message.guild.id] = {};
    qData[message.guild.id].rollCall = { messageId: rcMsg.id, channelId: rcMsg.channelId };
    saveQueue(qData);
    return;
  }

  // .endrollcall
  if (command === 'endrollcall') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !isWlManager(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const qData = loadQueue();
    const rc = qData[message.guild.id]?.rollCall;
    if (!rc) return message.reply(`no active roll call start one with \`${prefix}rollcall\` first`);
    const status = await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('closing roll call and logging attendance...')] });
    try {
      const rcChannel = message.guild.channels.cache.get(rc.channelId);
      if (!rcChannel) return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription("couldn't find the roll call channel")] });
      const rcMsg = await rcChannel.messages.fetch(rc.messageId);
      const reaction = rcMsg.reactions.cache.get('✅');
      let reactors = [];
      if (reaction) { await reaction.users.fetch(); reactors = [...reaction.users.cache.values()].filter(u => !u.bot); }
      if (!reactors.length) {
        delete qData[message.guild.id].rollCall;
        saveQueue(qData);
        return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('roll call closed no reactions found')] });
      }
      const vData = loadVerify();
      const queueChannelId = qData[message.guild.id]?.channelId;
      const queueChannel = queueChannelId ? message.guild.channels.cache.get(queueChannelId) : null;
      // the new rollcall summary channel — set with .setrollcallchannel
      const rollCallChannelId = qData[message.guild.id]?.rollCallChannelId;
      const rollCallChannel = rollCallChannelId ? message.guild.channels.cache.get(rollCallChannelId) : null;
      let logged = 0; const skipped = []; const loggedEntries = [];
      // for the summary embed — keep both names so we can build clickable links
      const summaryRows = [];
      for (const user of reactors) {
        const userVerify = vData.verified?.[user.id];
        if (!userVerify) { skipped.push(user); continue; }
        let avatarUrl = null;
        try {
          const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userVerify.robloxId}&size=420x420&format=Png&isCircular=false`)).json();
          avatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
        } catch {}
        const rcAttendEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
          .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
          .addFields({ name: 'Discord', value: `<@${user.id}> `, inline: false }, { name: 'Roblox', value: `\`${userVerify.robloxName}\``, inline: false })
          .setTimestamp().setFooter({ text: `roll call • ${getBotName()}`, iconURL: getLogoUrl() });
        if (avatarUrl) rcAttendEmbed.setThumbnail(avatarUrl);
        if (queueChannel) { await queueChannel.send({ embeds: [rcAttendEmbed] }); addRaidStat(message.guild.id, user.id); }
        else if (rollCallChannel) { addRaidStat(message.guild.id, user.id); } // still credit the raid stat even if no queue channel
        loggedEntries.push({ discordId: user.id, robloxName: userVerify.robloxName });
        summaryRows.push({ discordId: user.id, discordName: user.username, robloxId: userVerify.robloxId, robloxName: userVerify.robloxName });
        logged++;
        await new Promise(r => setTimeout(r, 300));
      }
      // post the big summary embed in the rollcall channel — every1 in the rollcall, with clickable names
      if (rollCallChannel && summaryRows.length) {
        const lines = summaryRows.map((r, i) =>
          `**${i + 1}.** [${r.discordName}](https://discord.com/users/${r.discordId}) — Roblox: [${r.robloxName}](https://www.roblox.com/users/${r.robloxId}/profile)`
        );
        const skippedLine = skipped.length ? `\n\n*${skipped.length} skipped (not registered)*` : '';
        const summaryEmbed = baseEmbed().setColor(0x2C2F33)
          .setTitle('Rollcall — Who Was In')
          .setDescription(lines.join('\n') + skippedLine)
          .setFooter({ text: `${summaryRows.length} member${summaryRows.length !== 1 ? 's' : ''} • closed by ${message.author.username} • ${getBotName()}`, iconURL: getLogoUrl() })
          .setTimestamp();
        try { await rollCallChannel.send({ embeds: [summaryEmbed] }); } catch (e) { console.error('rollcall summary post failed:', e.message); }
      }
      appendAtLog(message.guild.id, { ts: Date.now(), by: message.author.id, channelId: rc.channelId, queueChannelId: queueChannel?.id || null, logged: loggedEntries, skipped: skipped.map(u => u.id) });
      delete qData[message.guild.id].rollCall;
      saveQueue(qData);
      const skipNote = skipped.length ? `\n${skipped.length} skipped (not registered)` : '';
      const summaryNote = rollCallChannel ? `\nsummary posted to ${rollCallChannel}` : (rollCallChannelId ? '\n(rollcall channel set but couldnt find it, check perms)' : `\nset a summary channel with \`${prefix}setrollcallchannel #channel\``);
      return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Roll Call Closed').setDescription(`logged **${logged}** member${logged !== 1 ? 's' : ''}${queueChannel ? ` to ${queueChannel}` : ''}${skipNote}${summaryNote}`).setTimestamp()] });
    } catch (err) {
      return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`failed to close roll call ${err.message}`)] });
    }
  }

  // .atlog
  // Show recent rollcall attendance logs. Usage:
  // .atlog → list the last 10 sessions
  // .atlog <n → show full details of session #n from the list
  // .atlog clear → wipe all logs for this guild (wl manager only)
  if (command === 'atlog') {
    if (!message.guild) return;
    if (!loadWhitelist().includes(message.author.id) && !isWlManager(message.author.id))
      return message.reply('you need to be whitelisted to use this');
    const all = loadAtLog();
    const sessions = all[message.guild.id] || [];
    // helper: render a discord id as "<@id (`robloxName`)" if they're registered via .register
    const _vForLog = loadVerify();
    const renderUser = (id) => {
      const r = _vForLog?.verified?.[id]?.robloxName;
      return r ? `<@${id}> (\`${r}\`)` : `<@${id}> `;
    };

    if (args[0]?.toLowerCase() === 'clear') {
      if (!isWlManager(message.author.id)) return message.reply({ embeds: [errorEmbed('no permission').setDescription('only whitelist managers can clear attendance logs')] });
      delete all[message.guild.id];
      saveAtLog(all);
      return message.reply({ embeds: [successEmbed('logs cleared').setDescription('all rollcall logs for this server have been wiped')] });
    }

    if (!sessions.length) return message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setTitle('Attendance Log').setDescription('no rollcall sessions logged yet run `.endrollcall` to record one')] });

    // Newest first
    const recent = [...sessions].reverse();

    // Detail view
    if (args[0] && /^\d+$/.test(args[0])) {
      const idx = parseInt(args[0], 10) - 1;
      const s = recent[idx];
      if (!s) return message.reply({ embeds: [errorEmbed('not found').setDescription(`no session #${idx + 1} there are only **${recent.length}** logged`)] });
      const lines = s.logged.length
        ? s.logged.map(e => `• <@${e.discordId}> \`${e.robloxName}\``).join('\n')
        : ' no registered users logged ';
      const skipLine = s.skipped?.length ? `\n\n**Skipped (${s.skipped.length}):** ${s.skipped.map(id => renderUser(id)).join(', ')}` : '';
      const embed = baseEmbed().setColor(0x2C2F33)
        .setTitle(`Attendance Log Session #${idx + 1}`)
        .setDescription(`<t:${Math.floor(s.ts / 1000)}:F (<t:${Math.floor(s.ts / 1000)}:R )\nclosed by ${renderUser(s.by)}${s.queueChannelId ? ` • posted to <#${s.queueChannelId}> ` : ''}\n\n**Logged (${s.logged.length}):**\n${lines}${skipLine}`);
      return message.reply({ embeds: [embed] });
    }

    // List view (last 10)
    const top = recent.slice(0, 10);
    const listLines = top.map((s, i) => `**${i + 1}.** <t:${Math.floor(s.ts / 1000)}:R **${s.logged.length}** logged${s.skipped?.length ? `, ${s.skipped.length} skipped` : ''} • by ${renderUser(s.by)}`);
    const embed = baseEmbed().setColor(0x2C2F33)
      .setTitle('Attendance Log')
      .setDescription(`${listLines.join('\n')}\n\n use \`${prefix}atlog <number \` to view a session's details `)
      .setFooter({ text: `${recent.length} session${recent.length !== 1 ? 's' : ''} on record` });
    return message.reply({ embeds: [embed] });
  }

  // .whoisin
  // Usage: .whoisin <roblox game URL or place ID
  // Checks which members of group 206868002 are currently in that game.
  if (command === 'whoisin') {
    if (!message.guild) return;
    const input = args[0];
    if (!input) return;
    const WHOISIN_GROUP = 206868002;
    const status = await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('fetching group members and game servers...')] });
    try {
      // Parse place ID supports:
      // roblox.com/games/start?placeId=123&gameInstanceId=...
      // roblox.com/games/123/game name
      // raw numeric place ID
      let placeId = null;
      const qsMatch = input.match(/[?&]place[iI][dD]=(\d+)/i);
      const pathMatch = input.match(/roblox\.com\/games\/(\d+)/i);
      if (qsMatch) placeId = qsMatch[1];
      else if (pathMatch) placeId = pathMatch[1];
      else if (/^\d+$/.test(input)) placeId = input;
      if (!placeId) return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription("couldn't parse a place ID paste a Roblox game URL or server link, e.g. `roblox.com/games/start?placeId=123&gameInstanceId=...`")] });

      // Resolve place ID → universe ID
      const placeDetail = await (await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`)).json();
      const universeId = placeDetail?.data?.[0]?.universeId;
      if (!universeId) return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`couldn't find a game for place ID \`${placeId}\` make sure the game exists and is public`)] });

      // Get game name
      let gameName = `Place ${placeId}`;
      try { const gr = await (await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)).json(); if (gr?.data?.[0]?.name) gameName = gr.data[0].name; } catch {}

      // Load ALL group members (paginated)
      await status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('loading group members...')] });
      const memberIds = new Set();
      const memberNames = {};
      let cur = '';
      do {
        try {
          const res = await (await fetch(`https://members.roblox.com/v1/groups/${WHOISIN_GROUP}/users?limit=100&sortOrder=Asc${cur ? `&cursor=${cur}` : ''}`)).json();
          for (const m of (res.data || [])) { memberIds.add(m.user.userId); memberNames[m.user.userId] = m.user.username; }
          cur = res.nextPageCursor || '';
        } catch { cur = ''; break; }
      } while (cur);
      if (!memberIds.size) return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('could not load group members Roblox API may be unavailable')] });

      // Scan all public game servers, collect player tokens
      await status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`loaded **${memberIds.size}** group members, scanning servers...`)] });
      const allTokens = [];
      let sCur = ''; let serverCount = 0;
      do {
        try {
          const res = await (await fetch(`https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=100${sCur ? `&cursor=${sCur}` : ''}`)).json();
          for (const srv of (res.data || [])) { serverCount++; for (const p of (srv.players || [])) { if (p.playerToken) allTokens.push(p.playerToken); } }
          sCur = res.nextPageCursor || '';
        } catch { sCur = ''; break; }
      } while (sCur);

      if (!allTokens.length) return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`scanned **${serverCount}** server${serverCount !== 1 ? 's' : ''} no players found (game may be empty or servers private)`)] });

      // Resolve player tokens → Roblox user IDs via thumbnail batch API
      await status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`resolving **${allTokens.length}** player${allTokens.length !== 1 ? 's' : ''} across **${serverCount}** server${serverCount !== 1 ? 's' : ''}...`)] });
      const resolvedIds = new Set();
      for (let i = 0; i < allTokens.length; i += 100) {
        try {
          const batch = allTokens.slice(i, i + 100).map((token, idx) => ({ requestId: `${i + idx}`, token, type: 'AvatarHeadShot', size: '150x150', format: 'png', isCircular: false }));
          const res = await (await fetch('https://thumbnails.roblox.com/v1/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) })).json();
          for (const item of (res.data || [])) { if (item.targetId && item.targetId !== 0) resolvedIds.add(item.targetId); }
        } catch {}
      }

      // Cross reference: keep only players who are group members
      const inGame = [...resolvedIds].filter(id => memberIds.has(id));
      if (!inGame.length) return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`no group members found in **${gameName}**\n*(checked ${serverCount} server${serverCount !== 1 ? 's' : ''}, ${resolvedIds.size} total player${resolvedIds.size !== 1 ? 's' : ''})*`)] });

      const lines = inGame.map(id => `• \`${memberNames[id] || id}\``).join('\n');
      return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle(`Group members in ${gameName}`)
        .setDescription(`**${inGame.length}** group member${inGame.length !== 1 ? 's' : ''} currently in game:\n\n${lines}`)
        .setFooter({ text: `${serverCount} server${serverCount !== 1 ? 's' : ''} scanned • group ${WHOISIN_GROUP}` })
        .setTimestamp()] });
    } catch (err) {
      return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`whoisin failed ${err.message}`)] });
    }
  }


  // .ingame
  if (command === 'ingame') {
    if (!message.guild) return;
    const inputUsername = args[0]?.trim();
    if (!inputUsername) return;
    const status = await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`looking up **${inputUsername}** on Roblox...`)] });
    try {
      const userRes = await (await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [inputUsername], excludeBannedUsers: false })
      })).json();
      const targetUser = userRes.data?.[0];
      if (!targetUser) return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`could not find a Roblox user named \`${inputUsername}\``)] });
      await status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`checking **${targetUser.name}**'s current game...`)] });
      const presRes = await (await fetch('https://presence.roblox.com/v1/presence/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [targetUser.id] })
      })).json();
      const targetPresence = presRes.userPresences?.[0];
      if (!targetPresence || targetPresence.userPresenceType !== 2 || (!targetPresence.gameId && !targetPresence.placeId && !targetPresence.rootPlaceId)) {
        return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`**${targetUser.name}** is not currently in a Roblox game`)] });
      }
      const { gameId, placeId, rootPlaceId } = targetPresence;
      const exactServerMatch = !!gameId;
      let gameName = `Place ${rootPlaceId || placeId}`;
      try {
        const plDetail = await (await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${rootPlaceId || placeId}`)).json();
        const univId = plDetail?.data?.[0]?.universeId;
        if (univId) {
          const gr = await (await fetch(`https://games.roblox.com/v1/games?universeIds=${univId}`)).json();
          if (gr?.data?.[0]?.name) gameName = gr.data[0].name;
        }
      } catch {}
      const vData = loadVerify();
      const allRegistered = Object.entries(vData.verified || {});
      await status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`**${targetUser.name}** is in **${gameName}** fetching group members & checking presence...`)] });
      // Fetch all group members (registered + unregistered)
      const groupMembers = await fetchGroupMemberIds(ATTEND_GROUP_ID);
      const allGroupIds = [...groupMembers];
      // Build quick lookup maps from registered data
      const registeredRobloxToDiscord = vData.robloxToDiscord || {};
      const registeredRobloxToName = {};
      for (const [, v] of allRegistered) {
        if (v.robloxId) registeredRobloxToName[String(v.robloxId)] = v.robloxName;
      }
      const inSameServer = [];
      for (let i = 0; i < allGroupIds.length; i += 50) {
        try {
          const batch = allGroupIds.slice(i, i + 50);
          const bRes = await (await fetch('https://presence.roblox.com/v1/presence/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: batch })
          })).json();
          for (const p of (bRes.userPresences || [])) {
            if (String(p.userId) === String(targetUser.id)) continue;
            const inSamePlace = (rootPlaceId && p.rootPlaceId && String(p.rootPlaceId) === String(rootPlaceId)) ||
                                (placeId && p.placeId && String(p.placeId) === String(placeId));
            const match = exactServerMatch ? (p.gameId === gameId) : inSamePlace;
            if (match) {
              const discordId = registeredRobloxToDiscord[String(p.userId)] || null;
              const robloxName = registeredRobloxToName[String(p.userId)] || null;
              inSameServer.push({ discordId, robloxName, robloxId: p.userId });
            }
          }
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
      // Resolve usernames for unregistered members found in same server
      const needsName = inSameServer.filter(m => !m.robloxName);
      if (needsName.length) {
        try {
          const nameRes = await (await fetch('https://users.roblox.com/v1/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: needsName.map(m => m.robloxId), excludeBannedUsers: false })
          })).json();
          for (const u of (nameRes.data || [])) {
            const entry = inSameServer.find(m => String(m.robloxId) === String(u.id));
            if (entry) entry.robloxName = u.name;
          }
        } catch {}
      }
      // Fill any still missing names with the ID as fallback
      for (const m of inSameServer) { if (!m.robloxName) m.robloxName = String(m.robloxId); }
      // Post attendance embeds to the queue channel all members (registered + unregistered)
      const queueData = loadQueue();
      const queueChannelId = queueData[message.guild.id]?.channelId;
      const queueChannel = queueChannelId ? (message.guild.channels.cache.get(queueChannelId) ?? null) : null;
      const registeredInSameServer = inSameServer.filter(m => m.discordId);
      const unregisteredInSameServer = inSameServer.filter(m => !m.discordId);
      if (queueChannel) {
        for (const { discordId, robloxName, robloxId } of registeredInSameServer) {
          let ingameAvatarUrl = null;
          try {
            const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=420x420&format=Png&isCircular=false`)).json();
            ingameAvatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
          } catch {}
          const ingameEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('registered user joined this raid')
            .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
            .addFields({ name: 'Discord', value: `<@${discordId}> `, inline: false }, { name: 'Roblox', value: `\`${robloxName}\``, inline: false })
            .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() });
          if (ingameAvatarUrl) ingameEmbed.setThumbnail(ingameAvatarUrl);
          await queueChannel.send({ embeds: [ingameEmbed] });
          await new Promise(r => setTimeout(r, 300));
        }
        for (const { robloxName, robloxId } of unregisteredInSameServer) {
          let ingameAvatarUrl = null;
          try {
            const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=420x420&format=Png&isCircular=false`)).json();
            ingameAvatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
          } catch {}
          const unregEmbed = new EmbedBuilder().setColor(0x2C2F33).setTitle('unregistered user joined this raid')
            .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
            .addFields({ name: 'Roblox', value: `[\`${robloxName}\`](https://www.roblox.com/users/${robloxId}/profile)`, inline: false }, { name: 'Status', value: 'not mverify\'d', inline: false })
            .setTimestamp().setFooter({ text: getBotName(), iconURL: getLogoUrl() });
          if (ingameAvatarUrl) unregEmbed.setThumbnail(ingameAvatarUrl);
          await queueChannel.send({ embeds: [unregEmbed] });
          await new Promise(r => setTimeout(r, 300));
        }
      }
      const totalInServer = registeredInSameServer.length + unregisteredInSameServer.length;
      const formatLine = ({ discordId, robloxName }) => discordId ? `<@${discordId}> \`${robloxName}\`` : `\`${robloxName}\` not mverify'd`;
      const ingameSection = totalInServer ? `**In same server (${totalInServer})**\n${inSameServer.map(formatLine).join('\n')}` : '**In same server** none';
      const attendNote = queueChannel && totalInServer ? `\n\n*logged ${totalInServer} member${totalInServer !== 1 ? 's' : ''} to ${queueChannel}*` : '';
      const scopeNote = exactServerMatch ? 'exact server' : 'same game (server ID private)';
      return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33)
        .setTitle(`Members ${gameName}`)
        .setDescription(`${ingameSection}${attendNote}`)
        .setFooter({ text: `${allGroupIds.length} group members checked • ${scopeNote}` })
        .setTimestamp()] });
    } catch (err) { return status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`ingame failed ${err.message}`)] }); }
  }

  // .img2gif
  if (command === 'img2gif') {
    if (!message.guild) return;

    const attachment = message.attachments.first();
    if (!attachment) return message.reply(`attach an image to convert e.g. paste an image then type \`${prefix}img2gif\` in the same message`);

    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
    if (attachment.contentType && !validTypes.some(t => attachment.contentType.startsWith(t.split('/')[0] + '/')))
      return message.reply('that file type isn\'t supported send a PNG, JPG, WEBP, or GIF');

    if (attachment.contentType?.includes('gif')) return message.reply('that\'s already a GIF');

    const status = await message.reply({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription('converting to GIF...')] });

    try {
      const { createCanvas, loadImage } = await import('canvas');
      const { createWriteStream, unlinkSync } = await import('fs');
      const { default: GIFEncoder } = await import('gifencoder');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      const imgRes = await fetch(attachment.url);
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

      const img = await loadImage(imgBuffer);
      const encoder = new GIFEncoder(img.width, img.height);
      const tmpPath = join(tmpdir(), `img2gif ${Date.now()}.gif`);
      const stream = createWriteStream(tmpPath);

      encoder.createReadStream().pipe(stream);
      encoder.start();
      encoder.setRepeat(0);
      encoder.setDelay(100);
      encoder.setQuality(10);

      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      encoder.addFrame(ctx);
      encoder.finish();

      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      const gifBuffer = fs.readFileSync(tmpPath);
      const gifAttachment = new AttachmentBuilder(gifBuffer, { name: 'image.gif' });

      await status.edit({ content: '', embeds: [], files: [gifAttachment] });
      try { unlinkSync(tmpPath); } catch {}
    } catch (err) {
      await status.edit({ embeds: [baseEmbed().setColor(0x2C2F33).setDescription(`couldn't convert \`${err.message}\``)] });
    }
    return;
  }

  // prefix → slash bridge: any prefix command not handled above falls
  // through here. We re dispatch as a slash command so every slash only
  // command also works as a prefix command.
  try {
    if (SLASH_ONLY_COMMANDS.has(command) || command === 'whitelist') {
      const fakeInt = buildFakeInteractionFromMessage(message, command, args);
      if (fakeInt) await dispatchSlash(fakeInt);
    }
  } catch (err) {
    try { await message.reply(`error: ${err.message}`); } catch {}
  }
}
client.on('messageCreate', dispatchPrefix);


// Automatic raid attendance HTTP server
// Roblox game scripts POST to this endpoint when a player joins the raid.
// Body (JSON): { discordId, robloxUsername, guildId, secret }
// secret must match process.env.ATTEND SECRET (optional but recommended)
const ATTEND_PORT   = process.env.ATTEND_PORT   || 3001;
const ATTEND_SECRET = process.env.ATTEND_SECRET || '';

http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('attend server ok');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/attend') {
    res.writeHead(404); res.end('not found'); return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);

      // Optional secret check
      if (ATTEND_SECRET && data.secret !== ATTEND_SECRET) {
        res.writeHead(401); res.end('unauthorized'); return;
      }

      const { discordId, robloxUsername, guildId } = data;
      if (!robloxUsername || !guildId) {
        res.writeHead(400); res.end('missing robloxUsername or guildId'); return;
      }

      const guild = client.guilds.cache.get(String(guildId));
      if (!guild) { res.writeHead(404); res.end('guild not found'); return; }

      // Only log registered (mverify'd) members
      const vData = loadVerify();
      const registeredEntry = Object.entries(vData.verified || {}).find(([, v]) => v.robloxName?.toLowerCase() === robloxUsername?.toLowerCase());
      if (!registeredEntry) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, skipped: true, reason: 'not a registered member' }));
        return;
      }
      const [regDiscordId] = registeredEntry;

      const queueData = loadQueue();
      const queueChannelId = queueData[String(guildId)]?.channelId;
      if (!queueChannelId) { res.writeHead(404); res.end('no queue channel set use /setattendance in Discord first'); return; }

      const queueChannel = guild.channels.cache.get(queueChannelId);
      if (!queueChannel) { res.writeHead(404); res.end('queue channel not found'); return; }

      const discordDisplay = `<@${regDiscordId}> `;

      // Fetch Roblox avatar for thumbnail
      let httpAvatarUrl = null;
      try {
        const robloxRes = await (await fetch('https://users.roblox.com/v1/usernames/users', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false })
        })).json();
        const robloxUserId = robloxRes.data?.[0]?.id;
        if (robloxUserId) {
          const avatarData = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxUserId}&size=420x420&format=Png&isCircular=false`)).json();
          httpAvatarUrl = avatarData.data?.[0]?.imageUrl ?? null;
        }
      } catch {}

      const attendEmbed = new EmbedBuilder()
        .setColor(0x2C2F33)
        .setTitle('registered user joined this raid')
        .setAuthor({ name: getBotName(), iconURL: getLogoUrl() })
        .addFields(
          { name: 'Discord', value: discordDisplay,               inline: false },
          { name: 'Roblox',  value: `\`${robloxUsername}\``, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: getBotName(), iconURL: getLogoUrl() });
      if (httpAvatarUrl) attendEmbed.setThumbnail(httpAvatarUrl);

      await queueChannel.send({ embeds: [attendEmbed] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('attend server error:', err.message);
      res.writeHead(500); res.end(err.message);
    }
  });
}).listen(ATTEND_PORT, () => {
  console.log(`attend server listening on port ${ATTEND_PORT}`);
});

// Survive transient errors so the bot doesn't crash mid write and lose data.
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err); });
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection:', reason); });

// Graceful shutdown: try to log out cleanly so any in flight writes finish.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down...`);
  try { await client.destroy(); } catch {}
  // Close the Postgres pool so pending queries can drain
  if (dbPool) { try { await dbPool.end(); } catch {} }
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN);
