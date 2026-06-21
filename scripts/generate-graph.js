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

// ── Generate static SVG (embedded in README) ─────────────────────────────────

const SVG_FILE = path.join(ROOT, 'graph', 'graph.svg');
const W = 960, H = 520;

const GROUP_COLORS = {
  root:      '#e4c97e',
  inbox:     '#56c2d6',
  projects:  '#7ec8e3',
  resources: '#6dbf6d',
  archives:  '#909090',
  journal:   '#c792ea',
  templates: '#f78c6c',
  other:     '#aaaaaa',
};

const GROUP_LABELS = {
  root: 'Root', inbox: 'Inbox', projects: 'Projects',
  resources: 'Resources', archives: 'Archives',
  journal: 'Journal', templates: 'Templates', other: 'Other',
};

// Degree map
const deg = new Map(nodes.map(n => [n.id, 0]));
for (const l of links) {
  deg.set(l.source, (deg.get(l.source) || 0) + 1);
  deg.set(l.target, (deg.get(l.target) || 0) + 1);
}
const nodeR = id => 4.5 + Math.sqrt(deg.get(id) || 0) * 2.8;

// ── Fruchterman-Reingold force layout (no deps) ───────────────────────────────

const layoutN = nodes.map(n => ({ ...n }));

(function layout(ns, ls) {
  const n = ns.length;
  const k = Math.sqrt(W * H / n) * 0.9;
  const nMap = new Map(ns.map(nd => [nd.id, nd]));

  // Start on a circle (deterministic)
  ns.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / n;
    nd.x = W / 2 + W * 0.28 * Math.cos(a);
    nd.y = H / 2 + H * 0.30 * Math.sin(a);
  });

  let temp = W / 6;
  for (let iter = 0; iter < 600; iter++) {
    const dx = new Float64Array(n), dy = new Float64Array(n);

    // Repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ex = ns[i].x - ns[j].x, ey = ns[i].y - ns[j].y;
        const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
        const f = k * k / d;
        dx[i] += ex / d * f; dy[i] += ey / d * f;
        dx[j] -= ex / d * f; dy[j] -= ey / d * f;
      }
    }

    // Attraction
    for (const l of ls) {
      const s = nMap.get(l.source), t = nMap.get(l.target);
      if (!s || !t) continue;
      const si = ns.indexOf(s), ti = ns.indexOf(t);
      const ex = s.x - t.x, ey = s.y - t.y;
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
      const f = d * d / k;
      dx[si] -= ex / d * f; dy[si] -= ey / d * f;
      dx[ti] += ex / d * f; dy[ti] += ey / d * f;
    }

    // Apply displacements, clamp to canvas
    const pad = 80;
    for (let i = 0; i < n; i++) {
      const mag = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const m   = Math.min(mag, temp);
      ns[i].x = Math.max(pad, Math.min(W - pad, ns[i].x + dx[i] / mag * m));
      ns[i].y = Math.max(pad, Math.min(H - pad, ns[i].y + dy[i] / mag * m));
    }
    temp *= 0.97;
  }
})(layoutN, links);

const pos = new Map(layoutN.map(n => [n.id, { x: n.x, y: n.y }]));

// ── SVG assembly ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const edgeSvg = links.map(l => {
  const s = pos.get(l.source), t = pos.get(l.target);
  if (!s || !t) return '';
  return `  <line x1="${s.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1.5"/>`;
}).filter(Boolean).join('\n');

const nodeSvg = layoutN.map(n => {
  const r = nodeR(n.id).toFixed(1);
  const c = GROUP_COLORS[n.group] || '#aaa';
  const p = pos.get(n.id);
  const lx = p.x.toFixed(1), ly = (p.y + parseFloat(r) + 12).toFixed(1);
  return [
    `  <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${c}" fill-opacity="0.9" filter="url(#glow)"/>`,
    `  <text x="${lx}" y="${ly}" text-anchor="middle" font-size="10" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" fill="#d4d4d4" fill-opacity="0.85">${esc(n.label)}</text>`,
  ].join('\n');
}).join('\n');

const presentGroups = [...new Set(layoutN.map(n => n.group))].filter(g => GROUP_COLORS[g]);
const legTop = H - 24 - presentGroups.length * 18;
const legendSvg = [
  `  <rect x="14" y="${legTop - 16}" width="100" height="${presentGroups.length * 18 + 22}" rx="6" fill="#141414" fill-opacity="0.88" stroke="#363636" stroke-width="1"/>`,
  `  <text x="23" y="${legTop - 3}" font-size="9" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" fill="#666" letter-spacing="0.08em">LEGEND</text>`,
  ...presentGroups.map((g, i) => {
    const cy = legTop + 13 + i * 18;
    return [
      `  <circle cx="27" cy="${cy}" r="4.5" fill="${GROUP_COLORS[g]}"/>`,
      `  <text x="38" y="${cy + 4}" font-size="10" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" fill="#bbbbbb">${GROUP_LABELS[g] || g}</text>`,
    ].join('\n');
  }),
].join('\n');

const statsX = W - 155;
const statsSvg = [
  `  <rect x="${statsX}" y="12" width="143" height="24" rx="5" fill="#141414" fill-opacity="0.88" stroke="#363636" stroke-width="1"/>`,
  `  <text x="${statsX + 71}" y="28" text-anchor="middle" font-size="10" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" fill="#888">${nodes.length} notes · ${links.length} connections</text>`,
].join('\n');

const svgOut = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="50%" r="70%">
      <stop offset="0%" stop-color="#222222"/>
      <stop offset="100%" stop-color="#141414"/>
    </radialGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="3.5" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)" rx="8"/>
  <g id="edges">
${edgeSvg}
  </g>
  <g id="nodes">
${nodeSvg}
  </g>
${legendSvg}
${statsSvg}
</svg>`;

fs.writeFileSync(SVG_FILE, svgOut);
console.log(`✓ graph/graph.svg written`);
