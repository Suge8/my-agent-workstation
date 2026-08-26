#!/usr/bin/env node

const API_ROOT = 'https://api.exa.ai';

function parseArgs() {
  const options = {
    query: null,
    code: false,
    numResults: 10,
    type: 'auto',
    tokensNum: 'dynamic',
    json: false,
    noHighlights: false,
    fresh: false,
    textCharacters: 0,
    summary: false,
    highlightCharacters: 0,
    highlightQuery: null,
    includeDomains: [],
    excludeDomains: [],
    docsDomain: null,
    startPublishedDate: null,
    endPublishedDate: null,
    subpages: 0,
    subpageTarget: [],
    links: 0,
    imageLinks: 0,
    help: false,
  };

  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--code') options.code = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-highlights') options.noHighlights = true;
    else if (arg === '--fresh') options.fresh = true;
    else if (arg === '--summary') options.summary = true;
    else if (arg === '--text') options.textCharacters = Number(args[++index]) || 8000;
    else if (arg === '--highlight-chars') options.highlightCharacters = Number(args[++index]) || 0;
    else if (arg === '--highlight-query') options.highlightQuery = args[++index] || null;
    else if (arg === '--docs') options.docsDomain = args[++index] || null;
    else if (arg === '--include-domain') options.includeDomains.push(...splitList(args[++index]));
    else if (arg === '--exclude-domain') options.excludeDomains.push(...splitList(args[++index]));
    else if (arg === '--after') options.startPublishedDate = args[++index] || null;
    else if (arg === '--before') options.endPublishedDate = args[++index] || null;
    else if (arg === '--subpages') options.subpages = Number(args[++index]) || 0;
    else if (arg === '--subpage-target') options.subpageTarget.push(...splitList(args[++index]));
    else if (arg === '--links') options.links = Number(args[++index]) || 0;
    else if (arg === '--image-links') options.imageLinks = Number(args[++index]) || 0;
    else if (arg === '--num-results' || arg === '-n') options.numResults = Number(args[++index]);
    else if (arg === '--type' || arg === '-t') options.type = args[++index] || options.type;
    else if (arg === '--tokens' || arg === '--tokens-num') options.tokensNum = parseTokens(args[++index]);
    else if (!arg.startsWith('-') && !options.query) options.query = arg;
  }

  applyDocsPreset(options);
  options.numResults = clamp(Number.isFinite(options.numResults) ? options.numResults : 10, 1, 20);
  return options;
}

function applyDocsPreset(options) {
  if (!options.docsDomain) return;
  options.includeDomains.push(options.docsDomain);
  if (!options.textCharacters) options.textCharacters = 8000;
  if (!options.subpages) options.subpages = 5;
  if (!options.subpageTarget.length) options.subpageTarget.push('reference', 'guide', 'api', 'docs');
}

function splitList(value = '') {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function parseTokens(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : (value || 'dynamic');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function printHelp() {
  console.log(`Exa search for coding agents

Usage:
  exa-search "query" [options]

Options:
  --code                    Use Exa Code Context API for code snippets/docs/debugging
  -n, --num-results N       Search result count, 1-20 (default: 10)
  -t, --type TYPE           auto | fast | instant | deep-lite | deep | deep-reasoning
  --tokens N|dynamic        Code context token budget (default: dynamic)
  --docs DOMAIN             Docs preset: include domain + text 8000 + subpages 5
  --fresh                   Force fresh page content for search results
  --text N                  Include full page text, capped at N characters
  --summary                 Include Exa page summaries
  --highlight-chars N       Cap highlights per result
  --highlight-query QUERY   Guide highlight extraction
  --include-domain DOMAIN   Restrict to domain; repeat or comma-separate
  --exclude-domain DOMAIN   Exclude domain; repeat or comma-separate
  --after DATE              Published after ISO date, e.g. 2026-01-01
  --before DATE             Published before ISO date
  --subpages N              Crawl N subpages per result
  --subpage-target WORDS    Prioritize subpages; repeat or comma-separate
  --links N                 Extract N links per result
  --image-links N           Extract N image links per result
  --no-highlights           Search URLs only
  --json                    Print raw JSON
  -h, --help                Show help

Examples:
  exa-search "latest Vercel AI SDK release notes" --type fast
  exa-search "Go net/http middleware auth example" --code --tokens 5000
  exa-search "React 19 useActionState docs" --docs react.dev
  exa-search "FastAPI docs dependency injection" --docs fastapi.tiangolo.com
`);
}

async function post(path, body) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error('EXA_API_KEY environment variable is not set.');

  const response = await fetch(`${API_ROOT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  return payload;
}

async function search(options) {
  return post('/search', {
    query: options.query,
    numResults: options.numResults,
    type: options.type,
    ...(options.includeDomains.length ? { includeDomains: options.includeDomains } : {}),
    ...(options.excludeDomains.length ? { excludeDomains: options.excludeDomains } : {}),
    ...(options.startPublishedDate ? { startPublishedDate: options.startPublishedDate } : {}),
    ...(options.endPublishedDate ? { endPublishedDate: options.endPublishedDate } : {}),
    contents: buildContents(options),
  });
}

function buildContents(options) {
  const contents = {};
  if (!options.noHighlights) contents.highlights = buildHighlights(options);
  if (options.textCharacters) contents.text = { maxCharacters: options.textCharacters };
  if (options.summary) contents.summary = true;
  if (options.subpages) contents.subpages = clamp(options.subpages, 1, 10);
  if (options.subpageTarget.length) contents.subpageTarget = options.subpageTarget;
  if (options.links || options.imageLinks) contents.extras = {
    ...(options.links ? { links: clamp(options.links, 1, 20) } : {}),
    ...(options.imageLinks ? { imageLinks: clamp(options.imageLinks, 1, 20) } : {}),
  };
  if (options.fresh) contents.maxAgeHours = 0;
  return contents;
}

function buildHighlights(options) {
  if (!options.highlightCharacters && !options.highlightQuery) return true;
  return {
    ...(options.highlightCharacters ? { maxCharacters: options.highlightCharacters } : {}),
    ...(options.highlightQuery ? { query: options.highlightQuery } : {}),
  };
}

async function codeContext(options) {
  return post('/context', {
    query: options.query,
    tokensNum: options.tokensNum,
  });
}

function costOf(result) {
  const total = result?.costDollars?.total;
  return typeof total === 'number' ? `$${total.toFixed(4)}` : 'N/A';
}

function printSearch(result, options) {
  const results = result.results || [];
  console.log(`# Exa Search Results\n**Query:** ${options.query}\n**Type:** ${result.searchType || result.resolvedSearchType || options.type} | **Results:** ${results.length} | **Cost:** ${costOf(result)}\n`);

  for (const [index, item] of results.entries()) {
    console.log(`## ${index + 1}. ${item.title || 'Untitled'}`);
    console.log(`**URL:** ${item.url || 'N/A'}`);
    if (item.publishedDate) console.log(`**Published:** ${item.publishedDate}`);
    if (Array.isArray(item.highlights) && item.highlights.length) {
      console.log('**Highlights:**');
      for (const highlight of item.highlights.slice(0, 5)) {
        if (highlight?.trim()) console.log(`- ${highlight.trim()}`);
      }
    }
    if (item.summary) console.log(`**Summary:** ${oneLine(item.summary)}`);
    if (item.text) console.log(`**Text:** ${oneLine(item.text).slice(0, 1200)}${item.text.length > 1200 ? '…' : ''}`);
    printNestedResults(item);
    console.log('');
  }
}

function printNestedResults(item) {
  const subpages = item.subpages || [];
  if (subpages.length) {
    console.log('**Subpages:**');
    for (const subpage of subpages.slice(0, 5)) console.log(`- ${subpage.title || subpage.url}: ${subpage.url}`);
  }

  const links = item.extras?.links || [];
  if (links.length) console.log(`**Links:** ${links.slice(0, 8).join(', ')}`);

  const imageLinks = item.extras?.imageLinks || [];
  if (imageLinks.length) console.log(`**Image Links:** ${imageLinks.slice(0, 8).join(', ')}`);
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function printCodeContext(result, options) {
  console.log(`# Exa Code Context\n**Query:** ${options.query}\n**Tokens:** ${result.outputTokens || 'N/A'} | **Results:** ${result.resultsCount || 'N/A'} | **Cost:** ${costOf(result)}\n`);
  console.log(result.response || 'No code context returned.');
}

async function main() {
  const options = parseArgs();
  if (options.help || !options.query) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  try {
    const result = options.code ? await codeContext(options) : await search(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (options.code) printCodeContext(result, options);
    else printSearch(result, options);
  } catch (error) {
    console.error(`Search error: ${error.message || error}`);
    process.exit(1);
  }
}

main();
