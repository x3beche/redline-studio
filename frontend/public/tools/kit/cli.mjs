// Run one kit tool outside the browser: how the MCP server and the API run
// a tool for an agent, inside the tools image, offline.
//
//   echo '{"vcc": 3.3}' | node kit/cli.mjs i2c-pullup
//
// Reads the input as JSON on stdin, fills what is missing from the
// manifest's defaults, and writes {ok, tool, input, result} on stdout.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEng } from './eng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] || '';

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

if (!/^[a-z0-9-]+$/.test(id)) { out({ ok: false, error: `bad tool id ${JSON.stringify(id)}` }); process.exit(0); }
let manifest;
try { manifest = JSON.parse(readFileSync(join(root, id, 'manifest.json'), 'utf8')); } catch {
  out({ ok: false, error: `no tool called ${id}` }); process.exit(0);
}
let given = {};
try { given = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch (e) {
  out({ ok: false, error: `input is not JSON: ${e.message}` }); process.exit(0);
}
const input = {};
const problems = [];
for (const d of manifest.inputs || []) {
  let v = given[d.key] ?? d.default ?? (d.type === 'table' ? [] : d.type === 'bool' ? false : '');
  if (d.type === 'number') {
    const n = parseEng(v);
    if (n == null && String(v).trim() !== '') problems.push(`${d.key}: not a number (${JSON.stringify(v)})`);
    v = n;
  }
  if (d.type === 'bool') v = v === true || v === 'true' || v === 1;
  if (d.type === 'select' && d.options && !d.options.some((o) => String(Array.isArray(o) ? o[0] : o?.value ?? o) === String(v))) {
    problems.push(`${d.key}: ${JSON.stringify(v)} is not one of the options`);
  }
  input[d.key] = v;
}
const unknown = Object.keys(given).filter((k) => !(manifest.inputs || []).some((d) => d.key === k));
try {
  const tool = await import(pathToFileURL(join(root, id, 'tool.js')).href);
  const result = await tool.run(input);
  // Fields that only feed the page's drawing (the manifest's agentOmit) are
  // left out for agents: they are large and say nothing the rest does not.
  for (const k of manifest.agentOmit || []) delete result[k];
  if (problems.length || unknown.length) {
    result.warnings = [...problems, ...unknown.map((k) => `unknown input ${k} ignored`), ...(result.warnings || [])];
  }
  out({ ok: true, tool: id, input, result });
} catch (e) {
  out({ ok: false, tool: id, input, error: String(e && e.message || e) });
}
