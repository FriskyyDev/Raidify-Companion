/*
 * Write a WoW-shaped saved-variables tree the companion can read.
 *
 * WHY THIS EXISTS. The companion's whole job is reading two files the game writes, so an
 * empty dev machine shows an empty app — no raid nights, no loot sessions, nothing to
 * photograph and nothing to click. Producing those files for real means running a raid.
 *
 * This writes them directly, in the exact shape `Attendance.lua` and `LootCore.lua`
 * produce, so the companion parses them with no special-casing on its side. If the addon's
 * shape changes, this file is wrong and the companion will say so — which is the correct
 * failure, and better than a mock inside the app that would keep agreeing with itself.
 *
 * Usage: node scripts/seed-savedvariables.cjs [targetDir]
 * Default target is a throwaway tree under the OS temp dir.
 */

const { mkdirSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const ACCOUNT = 'DEMO#1';
const FLAVOUR = '_anniversary_';
const REALM = 'Nightslayer';

/** Matches the demo guild seeded by raidify's ./seed-demo.ps1, so the two agree. */
const ROSTER = [
  ['Bulwark', 'WARRIOR'], ['Thornhide', 'DRUID'], ['Lightward', 'PALADIN'],
  ['Serenith', 'PRIEST'], ['Mendicant', 'PRIEST'], ['Tidecaller', 'SHAMAN'],
  ['Brightwell', 'PALADIN'], ['Willowmend', 'DRUID'], ['Sunhallow', 'PALADIN'],
  ['Grimsaw', 'WARRIOR'], ['Ravenkin', 'ROGUE'], ['Shivspark', 'ROGUE'],
  ['Stormfist', 'SHAMAN'], ['Duskclaw', 'DRUID'], ['Valeon', 'PALADIN'],
  ['Hackett', 'WARRIOR'], ['Emberlyn', 'MAGE'], ['Frostmarrow', 'MAGE'],
  ['Vexhollow', 'WARLOCK'], ['Sableclaw', 'WARLOCK'], ['Quillfeather', 'HUNTER'],
  ['Longshot', 'HUNTER'], ['Umbrave', 'PRIEST'], ['Galewind', 'SHAMAN'],
  ['Moonvale', 'DRUID'],
];

/** Lua's `string.lower` is byte-wise ASCII; the addon keys its tracker that way. */
const key = (name) => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

function luaString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Serialise to the same flavour of Lua table AceDB writes, so the parser sees no difference. */
function luaValue(value, indent) {
  const pad = '\t'.repeat(indent);
  const padIn = '\t'.repeat(indent + 1);

  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return luaString(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '{\n' + pad + '}';
    const items = value.map((v) => padIn + luaValue(v, indent + 1) + ',');
    return '{\n' + items.join('\n') + '\n' + pad + '}';
  }

  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{\n' + pad + '}';
  const items = entries.map(([k, v]) => `${padIn}[${luaString(k)}] = ${luaValue(v, indent + 1)},`);
  return '{\n' + items.join('\n') + '\n' + pad + '}';
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Build a real `RAIDIFY:v1:lootawards:...` string.
 *
 * The companion forwards this untouched and the server decodes it, so a placeholder here
 * fails at the server with "that export is damaged" — which is the correct rejection, and
 * useless for showing the app working. Mirrors the addon's encoder and the decoder in
 * `LootSessionImportService.Decode`: zlib (NOT raw deflate), base64, then a
 * position-weighted byte sum of the JSON as six hex digits.
 */
function exportString(payload) {
  const json = JSON.stringify(payload);
  const compressed = deflateSync(Buffer.from(json, 'utf8')).toString('base64');

  const bytes = Buffer.from(json, 'utf8');
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * (i + 1)) % 16777216;

  return `RAIDIFY:v1:lootawards:${compressed}:${sum.toString(16).padStart(6, '0')}`;
}

/** Real Serpentshrine Cavern drops, so the server resolves them against its catalog. */
const DROPS = [
  [30061, 'Ancestral Ring of Conquest'],
  [33055, 'Band of Vile Aggression'],
  [30106, 'Belt of One-Hundred Deaths'],
  [30047, 'Blackfathom Warbands'],
  [30101, "Bloodsea Brigand's Vest"],
  [30027, 'Boots of Courage Unending'],
];

/** Awards for one night, spread across the roster with one offspec and one disenchant. */
function awardsFor(night, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const [itemId, name] = DROPS[i % DROPS.length];
    const base = {
      itemId,
      name,
      quality: 4,
      at: night.at + (i + 1) * 1500,
    };
    if (i === count - 1) {
      // Nobody wanted the last one. A ledger with no disenchants is not a real ledger.
      out.push({ ...base, disposition: 'Disenchant' });
    } else {
      out.push({
        ...base,
        winner: ROSTER[(i * 3) % ROSTER.length][0],
        offspec: i === 1,
      });
    }
  }
  return out;
}


/**
 * One finished night, in the shape `Attendance.lua` archives.
 *
 * Deliberately not a clean sweep: two raiders arrive late, one leaves before the last boss
 * and one is benched with a reason. A night where everyone was simply present exercises
 * none of the buckets the companion exists to report.
 */
function night({ startedAt, raidId, raidTitle, nightId, absentees = [], late = [], leftEarly = [], benched = [] }) {
  const endedAt = startedAt + 3 * 3600;
  const everPresent = {};
  const firstSeen = {};
  const lastSeen = {};
  const lastKnownMembers = {};
  const benchMarks = {};

  for (const [name] of ROSTER) {
    if (absentees.includes(name) || benched.includes(name)) continue;
    const k = key(name);
    everPresent[k] = true;
    firstSeen[k] = late.includes(name) ? startedAt + 2400 : startedAt + 30;
    lastSeen[k] = leftEarly.includes(name) ? endedAt - 3600 : endedAt - 60;
    if (!leftEarly.includes(name)) lastKnownMembers[k] = true;
  }

  for (const name of benched) {
    benchMarks[key(name)] = {
      name,
      markedBy: 'Ashvane',
      markedAt: startedAt + 120,
      route: 'invite',
    };
  }

  return {
    nightId,
    startedAt,
    endedAt,
    raidId,
    raidTitle,
    archivedAt: endedAt + 60,
    tracker: { everPresent, firstSeen, lastSeen },
    lastKnownMembers,
    benchMarks,
    roster: ROSTER.map(([name], i) => ({
      name,
      realm: REALM,
      // 1 approved, 3 waitlisted — the last two are over a 25-man cap.
      status: i >= 25 ? 3 : 1,
    })),
    raidInfo: { id: raidId, title: raidTitle },
  };
}

function build(targetDir) {
  const sv = join(targetDir, FLAVOUR, 'WTF', 'Account', ACCOUNT, 'SavedVariables');
  mkdirSync(sv, { recursive: true });

  const day = 24 * 3600;

  /*
   * Anchor to a real evening, and name the night after the day it actually falls on.
   *
   * The first pass used "now minus N days", which produced raids starting at whatever
   * time the script happened to run — 10:01 AM in one capture — and titles saying
   * "Tuesday" above a date that rendered as a Wednesday. Both are the kind of detail a
   * raider notices immediately in a screenshot.
   */
  function raidEvening(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(20, 0, 0, 0);
    return {
      at: Math.floor(d.getTime() / 1000),
      weekday: d.toLocaleDateString('en-US', { weekday: 'long' }),
    };
  }

  /*
   * Prefer real raids from the seeded guild, at THEIR scheduled times.
   *
   * Passing only an id is not enough: the server matches a night to a raid by time as
   * well, so a fixture dated "two days ago" against a raid scheduled last Friday is
   * resolved as a standalone night and the upload preview says so. Lining the timestamps
   * up is the difference between "recorded against Serpentshrine Cavern" and "a night not
   * on the schedule".
   *
   * RAIDIFY_DEMO_RAIDS="<guid>@<iso>,<guid>@<iso>". Falls back to invented evenings.
   */
  function fromEnv() {
    return (process.env.RAIDIFY_DEMO_RAIDS || '')
      .split(',').map((x) => x.trim()).filter(Boolean)
      .map((entry) => {
        const [id, iso] = entry.split('@');
        const d = new Date(iso);
        return {
          at: Math.floor(d.getTime() / 1000),
          weekday: d.toLocaleDateString('en-US', { weekday: 'long' }),
          id,
        };
      });
  }

  const supplied = fromEnv();
  const first = supplied[0] ?? { ...raidEvening(2), id: randomUUID() };
  const second = supplied[1] ?? { ...raidEvening(9), id: randomUUID() };
  const t = first.at;

  // `raidIdHint` is a `Guid?` server-side, so a readable placeholder like "demo-raid-1" is
  // rejected at model binding with a 400 before any interesting validation runs — which
  // surfaced in the app as a bare "Request failed (400)" on every night.

  const nights = [
    night({
      startedAt: first.at, raidId: first.id,
      raidTitle: `Serpentshrine Cavern — ${first.weekday}`,
      nightId: 'demo-night-1', late: ['Emberlyn', 'Hackett'], leftEarly: ['Moonvale'],
      benched: ['Sableclaw'],
    }),
    night({
      startedAt: second.at, raidId: second.id,
      raidTitle: `Serpentshrine Cavern — ${second.weekday}`,
      nightId: 'demo-night-2', late: ['Ravenkin'], benched: ['Moonvale'],
    }),
  ];

  const characterKey = `Ashvane - ${REALM}`;

  const core = {
    char: {
      [characterKey]: {
        // The live one the app offers to send. Archived nights sit in attendanceHistory.
        attendanceSession: nights[0],
        attendanceHistory: [nights[1]],
        importedData: {
          raidInfo: { id: nights[0].raidId, title: nights[0].raidTitle },
          currentRoster: nights[0].roster,
        },
      },
    },
    profileKeys: { [characterKey]: 'Default' },
  };

  writeFileSync(
    join(sv, 'Raidify.lua'),
    `\nRaidifyDB = ${luaValue(core, 0)}\n`,
    'utf8',
  );

  /*
   * Two exported loot nights waiting to be sent. The payloads are placeholders: the
   * companion forwards the string without decoding it, so what matters for the UI is the
   * metadata beside it. A real upload against a real server needs a real export.
   */
  const loot = {
    usesLoot: true,
    standingDefaultV2: true,
    migratedFromCore: true,
    settings: {
      lootQualityThreshold: 4,
      autoFillTrades: false,
      announceLootAwards: true,
      hideStandingOnCard: false,
    },
    pendingExports: [first, second].map((evening, index) => {
      const awards = awardsFor(evening, index === 0 ? 6 : 4);
      return {
        nightId: `demo-night-${index + 1}`,
        exportedAt: evening.at + 3 * 3600,
        startedAt: evening.at,
        endedAt: evening.at + 3 * 3600,
        awards: awards.length,
        payload: exportString({
          v: 1,
          type: 'lootawards',
          guild: process.env.RAIDIFY_DEMO_GUILD_SLUG || 'second-wind',
          raid: evening.id,
          nightId: `demo-night-${index + 1}`,
          startedAt: evening.at,
          endedAt: evening.at + 3 * 3600,
          awards,
          // Presence only, exactly as the addon sends it — it can see who was in the raid
          // and cannot see why anyone was missing.
          attendance: ROSTER.map(([name]) => ({
            name,
            first: evening.at + 30,
            last: evening.at + 3 * 3600 - 60,
          })),
        }),
      };
    }),
  };

  writeFileSync(
    join(sv, 'Raidify_Loot.lua'),
    `\nRaidifyLootDB = ${luaValue(loot, 0)}\n`,
    'utf8',
  );

  return { install: targetDir, savedVariables: sv, nights: nights.length, pendingExports: 2 };
}

const target = process.argv[2] || join(tmpdir(), 'raidify-demo-wow');
const result = build(target);
console.log(JSON.stringify(result, null, 2));
