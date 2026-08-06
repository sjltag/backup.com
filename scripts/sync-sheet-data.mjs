import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDirectory, '..');
const appSource = await readFile(resolve(siteRoot, 'app.js'), 'utf8');

function readAppConstant(name) {
  const match = appSource.match(new RegExp(`const\\s+${name}\\s*=\\s*['\"]([^'\"]+)['\"]`));
  return match ? match[1].trim() : '';
}

const sheetId = process.env.GOOGLE_SHEET_ID?.trim() || readAppConstant('SHEET_ID');
const apiKey = process.env.GOOGLE_SHEETS_API_KEY?.trim() || readAppConstant('API_KEY');
const siteUrl = process.env.SITE_URL?.trim() || 'https://sjcollection.github.io/.com/';

if (!sheetId || !apiKey) {
  throw new Error('Missing Google Sheet ID or API key. Check app.js or the GitHub repository secrets.');
}

const sheetDefinitions = [
  { sheet: 'CATEGORIES', range: 'A:F', file: 'categories.json' },
  { sheet: 'PIN', range: 'A:B', file: 'pin.json' },
  { sheet: 'ACCESS', range: 'A:F', file: 'access.json' },
  { sheet: 'LIST', range: 'A:F', file: 'list.json' },
  { sheet: 'TRIAL', range: 'A:G', file: 'trial.json' },
  { sheet: 'BUY', range: 'A:G', file: 'buy.json' },
  { sheet: 'DATABASE', range: 'A:G' }
];

async function fetchSheet(definition) {
  const requestedRange = `${definition.sheet}!${definition.range}`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(requestedRange)}`
  );
  url.searchParams.set('key', apiKey);

  const response = await fetch(url, {
    headers: {
      Referer: siteUrl
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unable to read ${requestedRange} (${response.status}): ${body.slice(0, 500)}`);
  }

  const payload = await response.json();
  const allRows = Array.isArray(payload.values) ? payload.values : [];

  return {
    ...definition,
    values: allRows.slice(1)
  };
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const DATABASE_SHARD_COUNT = 64;

function databaseShardNumber(id) {
  const hash = createHash('sha256').update(id, 'utf8').digest();
  return hash.readUInt32BE(0) % DATABASE_SHARD_COUNT;
}

function databaseShardFileName(number) {
  return `shard-${String(number).padStart(2, '0')}.json`;
}

console.log('Reading Google Sheets...');
const downloadedSheets = await Promise.all(sheetDefinitions.map(fetchSheet));
const database = downloadedSheets.find((entry) => entry.sheet === 'DATABASE');
const regularSheets = downloadedSheets.filter((entry) => entry.sheet !== 'DATABASE');

const sheetsDirectory = resolve(siteRoot, 'data', 'sheets');
const databaseDirectory = resolve(siteRoot, 'data', 'database');
const oldItemDirectory = resolve(databaseDirectory, 'items');
const shardDirectory = resolve(databaseDirectory, 'shards');

await mkdir(sheetsDirectory, { recursive: true });

for (const entry of regularSheets) {
  const output = {
    sheet: entry.sheet,
    range: entry.range,
    values: entry.values
  };
  await writeFile(resolve(sheetsDirectory, entry.file), jsonText(output), 'utf8');
  console.log(`${entry.sheet}: ${entry.values.length} data row(s)`);
}

const rowsById = new Map();
let rowsWithoutId = 0;

for (const row of database.values) {
  const id = String(row?.[1] ?? '').trim();
  if (!id) {
    rowsWithoutId += 1;
    continue;
  }

  if (!rowsById.has(id)) rowsById.set(id, []);
  rowsById.get(id).push(row);
}

// Recreate generated folders so deleted Sheet titles do not leave stale JSON.
await rm(oldItemDirectory, { recursive: true, force: true });
await rm(shardDirectory, { recursive: true, force: true });
await mkdir(shardDirectory, { recursive: true });

const files = {};
const sortedIds = [...rowsById.keys()].sort((a, b) => a.localeCompare(b));
const rowsByShard = Array.from({ length: DATABASE_SHARD_COUNT }, () => []);

for (const id of sortedIds) {
  const shardNumber = databaseShardNumber(id);
  const fileName = databaseShardFileName(shardNumber);
  const relativePath = `shards/${fileName}`;
  files[id] = relativePath;
  rowsByShard[shardNumber].push(...rowsById.get(id));
}

for (let shardNumber = 0; shardNumber < DATABASE_SHARD_COUNT; shardNumber += 1) {
  const fileName = databaseShardFileName(shardNumber);
  await writeFile(
    resolve(shardDirectory, fileName),
    jsonText({
      sheet: 'DATABASE',
      shard: shardNumber,
      shardCount: DATABASE_SHARD_COUNT,
      values: rowsByShard[shardNumber]
    }),
    'utf8'
  );
}

await mkdir(databaseDirectory, { recursive: true });
await writeFile(
  resolve(databaseDirectory, 'index.json'),
  jsonText({
    sheet: 'DATABASE',
    range: database.range,
    titleCount: sortedIds.length,
    rowCount: database.values.length - rowsWithoutId,
    shardCount: DATABASE_SHARD_COUNT,
    files
  }),
  'utf8'
);

console.log(`DATABASE: ${database.values.length} data row(s)`);
console.log(`DATABASE: ${sortedIds.length} title(s) inside ${DATABASE_SHARD_COUNT} JSON shard file(s)`);
if (rowsWithoutId) console.warn(`DATABASE: skipped ${rowsWithoutId} row(s) without an ID in column B`);
console.log('JSON sync complete.');
