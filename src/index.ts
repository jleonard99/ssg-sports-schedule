#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import envPaths from 'env-paths';

// ----- Package metadata -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require(path.join(__dirname, '../package.json'));

// ----- Config -----
const API_KEY = process.env.SPORTSDATA_API_KEY;
const YEAR = 2025;
const paths = envPaths('games'); // OS-appropriate dirs
const CACHE_DIR = paths.cache;
const CACHE_TTL = 1000 * 60 * 60 * 12; // 12 hours

// API URLs
const CFB_URL = `https://api.sportsdata.io/v3/cfb/scores/json/Games/${YEAR}?key=${API_KEY}`;
const NFL_URL = `https://api.sportsdata.io/v3/nfl/scores/json/Schedules/${YEAR}?key=${API_KEY}`;
const NFL_TEAMS_URL = `https://api.sportsdata.io/v3/nfl/scores/json/Teams?key=${API_KEY}`;

// ----- Types -----
type Game = {
  league: 'CFB' | 'NFL';
  home: string;
  away: string;
  dateTime: string | null;
  day: string | null;
  week: number;
  channel: string | null;
};

type NFLTeam = { Key: string; FullName: string };

// ----- Helpers -----
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function clearCache() {
  if (fs.existsSync(CACHE_DIR)) {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    console.log(`Cache cleared: ${CACHE_DIR}`);
  } else {
    console.log('No cache to clear.');
  }
}

async function fetchWithCache(url: string, cacheFile: string) {
  ensureCacheDir();
  const cachePath = path.join(CACHE_DIR, cacheFile);

  if (fs.existsSync(cachePath)) {
    const stats = fs.statSync(cachePath);
    if (Date.now() - stats.mtimeMs < CACHE_TTL) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.json();
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

async function fetchNFLTeams(): Promise<Record<string, string>> {
  const teams: NFLTeam[] = await fetchWithCache(NFL_TEAMS_URL, 'nfl_teams.json');
  return teams.reduce<Record<string, string>>((map, t) => {
    map[t.Key.toUpperCase()] = t.FullName;
    return map;
  }, {});
}

async function fetchGames(
  url: string,
  league: 'CFB' | 'NFL',
  cacheFile: string,
  nflTeams?: Record<string, string>
): Promise<Game[]> {
  const data = await fetchWithCache(url, cacheFile);

  return data.map((g: any) => ({
    league,
    home: league === 'NFL' ? nflTeams?.[g.HomeTeam] || g.HomeTeam : g.HomeTeamName,
    away: league === 'NFL' ? nflTeams?.[g.AwayTeam] || g.AwayTeam : g.AwayTeamName,
    dateTime: g.DateTime || null,
    day: g.Day || null,
    week: g.Week,
    channel: g.Channel || null,
  }));
}

function computeTargetDate(daysOffset: number): string {
  const today = new Date();
  today.setDate(today.getDate() + daysOffset);
  return today.toISOString().split('T')[0];
}

function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(dateString: string): string {
  const d = new Date(dateString);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  return `${yyyy}-${mm}-${dd} ${weekday}`;
}

// ----- CLI -----
const program = new Command();

program
  .name('games')
  .description('CLI to fetch and display NFL and CFB schedules (cached for 12h)')
  .version(pkg.version)
  .option(
    '-d, --days <offset>',
    'Day offset from today (e.g. 0, +1, -1). Default = today if no team given.',
    ''
  )
  .option('-t, --team <name>', 'Filter games by team (home or away)', '')
  .option('--clear-cache', 'Clear the local cache and exit');

program.parse(process.argv);
const opts = program.opts();

async function main() {
  // Handle cache clearing
  if (opts.clearCache) {
    clearCache();
    process.exit(0);
  }

  let offset: number | null = null;
  if (!opts.days && !opts.team) {
    offset = 0; // default: today
  } else if (opts.days !== '') {
    offset = parseInt(opts.days, 10);
    if (isNaN(offset)) {
      console.error('Invalid value for --days. Use numbers like 0, +1, -1.');
      process.exit(1);
    }
  }

  try {
    if (!API_KEY) throw new Error('Missing API key in .env');

    const nflTeams = await fetchNFLTeams();

    const [cfbGames, nflGames] = await Promise.all([
      fetchGames(CFB_URL, 'CFB', 'cfb_games.json'),
      fetchGames(NFL_URL, 'NFL', 'nfl_schedules.json', nflTeams),
    ]);

    let combined = [...cfbGames, ...nflGames];

    // Filter by date
    if (offset !== null) {
      const targetDate = computeTargetDate(offset);
      combined = combined.filter(
        (g) =>
          (g.dateTime && g.dateTime.startsWith(targetDate)) ||
          (g.day && g.day.startsWith(targetDate))
      );
    }

    // Filter by team
    if (opts.team) {
      const search = opts.team.toLowerCase();
      combined = combined.filter(
        (g) =>
          g.home.toLowerCase().includes(search) ||
          g.away.toLowerCase().includes(search)
      );
    }

    if (combined.length === 0) {
      console.log(
        `No games found${
          opts.team ? ` for team matching "${opts.team}"` : ''
        }${offset !== null ? ` on day offset ${offset}` : ''}.`
      );
      return;
    }

    // Sort by week, then date
    combined.sort((a, b) => {
      if (a.week !== b.week) return a.week - b.week;
      const aTime = new Date(a.dateTime || a.day || 0).getTime();
      const bTime = new Date(b.dateTime || b.day || 0).getTime();
      return aTime - bTime;
    });

    const label =
      offset !== null
        ? `Games for ${computeTargetDate(offset)}`
        : opts.team
        ? `All games for teams matching "${opts.team}"`
        : 'Games';
    console.log(`${label}:\n`);

    combined.forEach((g) => {
      let dateLabel: string;
      let start: string;

      if (g.dateTime) {
        dateLabel = formatDate(g.dateTime);
        start = formatTime(g.dateTime);
      } else if (g.day) {
        dateLabel = formatDate(g.day);
        start = 'TBD';
      } else {
        dateLabel = `WEEK ${g.week} (TBD)`;
        start = 'TBD';
      }

      console.log(
        `[${dateLabel}][${g.league}] ${g.away} @ ${g.home} - ${start} - Channel: ${
          g.channel || 'N/A'
        }`
      );
    });
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

main();
