#!/usr/bin/env node
/**
 * Scans all .md files in the repo, extracts internal markdown links,
 * and writes the graph data into graph/index.html (embedded) so the
 * file works without a server.
 *
 * Usage: node scripts/generate-graph.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'graph', 'index.html');
const SKIP      = new Set(['.git', 'node_modules', 'graph', 'scripts', '.github']);

const GROUP_MAP = [
  ['00-inbox',     'inbox'],
  ['01-projects',  'projects'],
  ['03-resources', 'resources'],
  ['04-archives',  'archives'],
  ['05-journal',   'journal'],
  ['06-templates', 'templates'],
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function getGroup(relPath) {
  const top = relPath.split('/')[0];
  for (const [prefix, group] of GROUP_MAP) {
    if (top === prefix) return group;
  }
  return relPath.includes('/') ? 'other' : 'root';
}

function getLabel(relPath) {
  const parts = relPath.split('/');
  const file  = parts[parts.length - 1].replace(/\.md$/, '');
  if (file.toLowerCase() === 'readme') {
    if (parts.length === 1) return 'Second Brain';
    return parts[parts.length - 2]
      .replace(/^\d{2}-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  return file.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function nodeId(relPath) {
  return relPath.replace(/\.md$/, '');
}

function walkMd(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMd(full));
    } else if (entry.name.endsWith('.md')) {
      results.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  }
  return results;
}

function resolveLink(href, fromFile) {
  if (/^https?:\/\/|^mailto:|^#/.test(href)) return null;
  const fromDir  = path.dirname(path.join(ROOT, fromFile));
  const resolved = path.resolve(fromDir, href).replace(/\\/g, '/');
  const rootNorm = ROOT.replace(/\\/g, '/');
  if (!resolved.startsWith(rootNorm)) return null;
  let rel = resolved.slice(rootNorm.length).replace(/^\//, '');
  if (!rel.endsWith('.md')) {
    if (fs.existsSync(path.join(ROOT, rel, 'README.md'))) rel = rel + '/README.md';
    else if (fs.existsSync(path.join(ROOT, rel + '.md'))) rel = rel + '.md';
    else return null;
  }
  return rel;
}

// ── Build graph ──────────────────────────────────────────────────────────────

const mdFiles  = walkMd(ROOT);
const nodes    = mdFiles.map(f => ({ id: nodeId(f), label: getLabel(f), path: f, group: getGroup(f) }));
const idSet    = new Set(nodes.map(n => n.id));
const linkSet  = new Set();
const links    = [];

for (const file of mdFiles) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const srcId   = nodeId(file);
  for (const m of content.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const resolved = resolveLink(m[2], file);
    if (!resolved) continue;
    const tgtId = nodeId(resolved);
    if (!idSet.has(tgtId) || tgtId === srcId) continue;
    const key = [srcId, tgtId].sort().join('||');
    if (linkSet.has(key)) continue;
    linkSet.add(key);
    links.push({ source: srcId, target: tgtId });
  }
}

const graphData = { nodes, links, generated: new Date().toISOString() };

// ── Inject into HTML ─────────────────────────────────────────────────────────

const START_MARKER = '// @GRAPH_DATA_START';
const END_MARKER   = '// @GRAPH_DATA_END';

let html = fs.readFileSync(HTML_FILE, 'utf8');
const si = html.indexOf(START_MARKER);
const ei = html.indexOf(END_MARKER);
if (si === -1 || ei === -1) { console.error('Markers not found in graph/index.html'); process.exit(1); }

html = html.slice(0, si)
  + START_MARKER + '\n'
  + 'const GRAPH_DATA = ' + JSON.stringify(graphData) + ';\n'
  + html.slice(ei);

fs.writeFileSync(HTML_FILE, html);
console.log(`✓ ${nodes.length} nodes · ${links.length} links → graph/index.html`);
