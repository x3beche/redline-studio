// MCP Server Scaffold: an MCP server skeleton in Python or TypeScript from the
// tools, resources and prompts described, plus package files, a README and the
// client config snippets, and a lint of the descriptions an agent will read.
//
// Pure: no DOM, no fetch. Code is written from the SDKs' public documentation
// (READMEs and published type declarations), not copied from SDK source.
//
// Sources:
//   MCP specification (modelcontextprotocol.io/specification): server features tools / resources
//     (URI templates, RFC 6570) / prompts; tool annotations readOnlyHint, destructiveHint,
//     idempotentHint, openWorldHint; transports stdio (no stdout except protocol messages) and
//     Streamable HTTP (one endpoint, POST).
//   Python SDK `mcp` README and API: v2 `from mcp.server import MCPServer`, `@mcp.tool(annotations=...)`,
//     `@mcp.resource(uri, mime_type=...)`, `@mcp.prompt()`, `mcp.run(transport="streamable-http",
//     host=..., port=...)`; v1 `from mcp.server.fastmcp import FastMCP` with host/port in the constructor.
//   TypeScript SDK `@modelcontextprotocol/sdk` 1.x README and .d.ts: McpServer.registerTool /
//     registerResource / registerPrompt, ResourceTemplate, StdioServerTransport,
//     StreamableHTTPServerTransport({ sessionIdGenerator: undefined }) for stateless, createMcpExpressApp.
//   Claude Code docs: `claude mcp add`, .mcp.json; Claude Desktop claude_desktop_config.json.
//   Anthropic Messages API tool names ^[a-zA-Z0-9_-]{1,64}$.

// Versions as of 2026-09 (read from PyPI and the npm registry on 2026-09-29).
// Check them against pypi.org/project/mcp and npmjs.com before pinning.
export const VERSIONS = {
  asOf: '2026-09',
  pyV2: '2.2.0', pyV1: '1.30.0',
  tsSdk: '1.31.0', tsV2Server: '2.2.0', zod: '4.6.5', express: '5.2.1',
  typescript: '5.9.3', typesNode: '22.20.4', typesExpress: '5.0.6', inspector: '2.8.0',
};

const PY_KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type'.split(' '));
const TS_RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await'.split(' '));
const DANGER = ['delete', 'remove', 'drop', 'erase', 'exec', 'execute', 'run', 'shell', 'kill', 'format', 'flash', 'write', 'reset', 'reboot', 'shutdown', 'wipe', 'destroy', 'purge', 'truncate', 'deploy', 'send', 'overwrite', 'program', 'burn', 'fuse'];
export const TYPES = ['string', 'integer', 'number', 'boolean', 'enum', 'string[]', 'number[]'];
export const ANNOTATIONS = ['none', 'read-only', 'destructive', 'idempotent', 'open-world'];

const str = (v) => String(v ?? '').trim();
const words = (name) => str(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const snake = (name) => words(name).join('_') || 'item';
const camel = (name) => { const w = words(name); return w.length ? w[0] + w.slice(1).map((x) => x[0].toUpperCase() + x.slice(1)).join('') : 'item'; };
const ident = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
const pyStr = (s) => JSON.stringify(String(s));
const tsStr = (s) => JSON.stringify(String(s));
const truthy = (v) => /^(yes|true|1|required|req|y)$/i.test(str(v));
const splitList = (v) => str(v).split(/\s*[,|]\s*/).filter(Boolean);
const indent = (text, n) => text.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');
const docLines = (s) => str(s).replace(/"""/g, '\\"\\"\\"');

/** Normalise the tables into a model: tools with their params, resources, prompts. */
function model(input) {
  const tools = (input.tools || []).map((r, i) => ({ row: i, name: str(r.name), description: str(r.description), annotation: ANNOTATIONS.includes(str(r.annotation)) ? str(r.annotation) : 'none', params: [] }))
    .filter((t) => t.name || t.description);
  const orphans = [];
  (input.params || []).forEach((r, i) => {
    const p = { row: i, tool: str(r.tool), name: str(r.name), type: TYPES.includes(str(r.type)) ? str(r.type) : 'string', typeRaw: str(r.type), required: truthy(r.required), description: str(r.description), values: str(r.values) };
    if (!p.name && !p.tool) return;
    const t = tools.find((x) => x.name === p.tool);
    if (t) t.params.push(p); else orphans.push(p);
  });
  const resources = (input.resources || []).map((r, i) => ({ row: i, uri: str(r.uri), name: str(r.name), description: str(r.description), mime: str(r.mime) }))
    .filter((r) => r.uri || r.name);
  for (const r of resources) r.vars = [...r.uri.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const prompts = (input.prompts || []).map((r, i) => {
    const args = splitList(r.args).map((a) => ({ name: a.replace(/\?$/, ''), optional: /\?$/.test(a) }));
    return { row: i, name: str(r.name), description: str(r.description), args, text: String(r.text ?? '') };
  }).filter((p) => p.name || p.description);
  return { tools, orphans, resources, prompts };
}

// ---------------------------------------------------------------- lint
function lint(m, input) {
  const out = [];
  const add = (level, where, msg, ref) => out.push({ level, where, msg, ref });
  const server = str(input.name);
  if (!server) add('bad', 'server', 'The server has no name: clients list it by name.', { kind: 'server' });
  else if (!/^[a-z0-9][a-z0-9_-]*$/.test(server)) add('warn', 'server', `Server name "${server}": use lower case letters, digits, - or _ (it becomes a config key and a CLI argument).`, { kind: 'server' });
  if (!str(input.description)) add('warn', 'server', 'No server description: it becomes the instructions a client may show the model about when to use this server.', { kind: 'server' });
  const seen = new Map();
  for (const t of m.tools) {
    const ref = { kind: 'tool', row: t.row };
    const w = `tool ${t.name || `#${t.row + 1}`}`;
    if (!t.name) add('bad', w, 'Tool without a name.', ref);
    else {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) add('bad', w, `Name "${t.name}" has characters or a length (${t.name.length}) many clients refuse; Claude's API allows ^[a-zA-Z0-9_-]{1,64}$.`, ref);
      else if (!/^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/.test(t.name)) add('warn', w, `Name "${t.name}" is not snake_case or kebab-case; the model reads names as words, so ${snake(t.name)} reads better.`, ref);
      if (seen.has(t.name)) add('bad', w, `Two tools are called ${t.name}; the second replaces the first.`, ref);
      seen.set(t.name, true);
    }
    if (!t.description) add('bad', w, 'No description: the model decides whether to call a tool from its description alone.', ref);
    else if (t.description.length < 25) add('warn', w, `Description "${t.description}" is short; say what it does, what it returns and when to use it.`, ref);
    const verbs = words(t.name).filter((x) => DANGER.includes(x));
    if (verbs.length) {
      if (t.annotation === 'read-only') add('bad', w, `Marked read-only but the name says ${verbs.join(', ')}: fix the name or the annotation.`, ref);
      else if (t.annotation !== 'destructive') add('warn', w, `"${verbs[0]}" changes or destroys state: mark it destructive (destructiveHint) so clients ask before calling, and say in the description what cannot be undone.`, ref);
    }
    const pn = new Set();
    for (const p of t.params) {
      const pr = { kind: 'tool', row: t.row, param: p.row };
      const pw = `${t.name}.${p.name || '?'}`;
      if (!p.name) { add('bad', pw, 'Parameter without a name.', pr); continue; }
      if (!ident(p.name)) add('bad', pw, `Parameter "${p.name}" is not an identifier (letters, digits, _); it cannot be a function argument.`, pr);
      else if ((input.language === 'python' && PY_KEYWORDS.has(p.name)) || (input.language !== 'python' && TS_RESERVED.has(p.name))) add('bad', pw, `"${p.name}" is a reserved word in ${input.language === 'python' ? 'Python' : 'TypeScript'}; rename it.`, pr);
      if (pn.has(p.name)) add('bad', pw, `Parameter ${p.name} appears twice.`, pr);
      pn.add(p.name);
      if (!p.description) add('warn', pw, 'Parameter without a description: the model has to guess the unit and the format.', pr);
      if (p.typeRaw && !TYPES.includes(p.typeRaw)) add('warn', pw, `Type "${p.typeRaw}" is not one of ${TYPES.join(', ')}; used string.`, pr);
      if (p.type === 'enum' && splitList(p.values).length < 1) add('bad', pw, 'An enum parameter needs its values (comma-separated in Values).', pr);
      if (!p.required && p.values && p.type !== 'enum') {
        const d = p.values;
        if ((p.type === 'integer' && !/^-?\d+$/.test(d)) || (p.type === 'number' && !Number.isFinite(Number(d))) || (p.type === 'boolean' && !/^(true|false)$/i.test(d))) add('warn', pw, `Default "${d}" is not a ${p.type}; it is left out.`, pr);
      }
    }
  }
  for (const p of m.orphans) add('bad', `param ${p.name || '?'}`, `Parameter row names tool "${p.tool}", which is not in the tools list.`, { kind: 'orphan', param: p.row });
  const uris = new Set();
  for (const r of m.resources) {
    const ref = { kind: 'resource', row: r.row };
    const w = `resource ${r.uri || r.name}`;
    if (!/^[a-z][a-z0-9+.-]*:\/?\/?/i.test(r.uri)) add('bad', w, `URI "${r.uri}" has no scheme (like file://, bench:// or config://).`, ref);
    for (const v of r.vars) if (!ident(v)) add('bad', w, `Template variable {${v}} must be a plain name (RFC 6570 level-1 here).`, ref);
    if (uris.has(r.uri)) add('bad', w, 'Two resources share this URI.', ref);
    uris.add(r.uri);
    if (!r.name) add('warn', w, 'Resource without a name: clients show the name in their resource picker.', ref);
    if (!r.mime) add('warn', w, 'No MIME type: say text/plain, application/json, text/markdown… so the client knows how to show it.', ref);
    if (!r.description) add('warn', w, 'Resource without a description.', ref);
  }
  for (const p of m.prompts) {
    const ref = { kind: 'prompt', row: p.row };
    const w = `prompt ${p.name || '?'}`;
    if (!p.name) add('bad', w, 'Prompt without a name.', ref);
    else if (!/^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/.test(p.name)) add('warn', w, `Prompt name "${p.name}" is not snake_case or kebab-case; clients often show it as a slash command.`, ref);
    if (!p.description) add('warn', w, 'Prompt without a description: users pick prompts from a list by it.', ref);
    const used = new Set([...p.text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((x) => x[1]));
    for (const a of p.args) {
      if (!ident(a.name)) add('bad', w, `Argument "${a.name}" is not an identifier.`, ref);
      else if (!used.has(a.name)) add('warn', w, `Argument ${a.name} is never used in the text ({${a.name}}).`, ref);
    }
    for (const u of used) if (!p.args.some((a) => a.name === u)) add('warn', w, `The text uses {${u}} but there is no argument ${u}; it stays as literal text.`, ref);
  }
  if (!m.tools.length && !m.resources.length && !m.prompts.length) add('warn', 'server', 'Nothing to serve yet: add a tool, a resource or a prompt.', { kind: 'server' });
  return out;
}

// ---------------------------------------------------------------- Python
function pyType(p) {
  switch (p.type) {
    case 'integer': return 'int';
    case 'number': return 'float';
    case 'boolean': return 'bool';
    case 'enum': return `Literal[${splitList(p.values).map(pyStr).join(', ')}]`;
    case 'string[]': return 'list[str]';
    case 'number[]': return 'list[float]';
    default: return 'str';
  }
}
function pyDefault(p) {
  const d = p.values;
  if (p.type === 'enum') return null;
  if (!d) return null;
  if (p.type === 'integer') return /^-?\d+$/.test(d) ? d : null;
  if (p.type === 'number') return Number.isFinite(Number(d)) ? String(Number(d)) : null;
  if (p.type === 'boolean') return /^true$/i.test(d) ? 'True' : /^false$/i.test(d) ? 'False' : null;
  if (p.type === 'string') return pyStr(d);
  return null;
}
const PY_ANN = { 'read-only': 'readOnlyHint=True', destructive: 'destructiveHint=True', idempotent: 'idempotentHint=True', 'open-world': 'openWorldHint=True' };

function pyTool(t) {
  // Python needs arguments with defaults after the ones without.
  const ps = [...t.params.filter((p) => p.required && ident(p.name)), ...t.params.filter((p) => !p.required && ident(p.name))];
  const args = ps.map((p) => {
    const ty = pyType(p);
    const ann = p.description ? `Annotated[${ty}, Field(description=${pyStr(p.description)})]` : ty;
    if (p.required) return `${p.name}: ${ann}`;
    const d = pyDefault(p);
    if (d != null) return `${p.name}: ${ann} = ${d}`;
    return `${p.name}: ${p.description ? `Annotated[${ty} | None, Field(description=${pyStr(p.description)})]` : `${ty} | None`} = None`;
  });
  const deco = t.annotation !== 'none' ? `@mcp.tool(annotations=ToolAnnotations(${PY_ANN[t.annotation]}${t.annotation === 'read-only' ? ', destructiveHint=False' : ''}))` : '@mcp.tool()';
  const fn = snake(t.name);
  const nameArg = fn !== t.name ? deco.replace('@mcp.tool(', `@mcp.tool(name=${pyStr(t.name)}${t.annotation !== 'none' ? ', ' : ''}`) : deco;
  const sig = args.length ? `def ${fn}(\n${args.map((a) => `    ${a},`).join('\n')}\n) -> str:` : `def ${fn}() -> str:`;
  const body = [`    """${docLines(t.description) || 'TODO: say what this tool does, what it returns and when to use it.'}"""`];
  if (t.annotation === 'destructive') body.push('    # Destructive: clients ask the user before calling. Check the arguments before acting.');
  body.push(`    # TODO: implement ${t.name}.`);
  body.push(`    raise NotImplementedError(${pyStr(`${t.name} is not implemented yet`)})`);
  return `${nameArg}\n${sig}\n${body.join('\n')}\n`;
}

function pyResource(r) {
  const fn = snake(r.name || r.uri.replace(/^[^:]*:\/*/, ''));
  const kw = [r.name ? `name=${pyStr(r.name)}` : null, r.description ? `description=${pyStr(r.description)}` : null, r.mime ? `mime_type=${pyStr(r.mime)}` : null].filter(Boolean);
  const vars = r.vars.filter(ident);
  const body = r.mime === 'application/json'
    ? `    # TODO: read the real data.\n    return json.dumps({${vars.map((v) => `${pyStr(v)}: ${v}`).join(', ')}})`
    : `    # TODO: read the real data.\n    return ${vars.length ? `f${pyStr(`${r.name || 'resource'} for ${vars.map((v) => `{${v}}`).join(', ')}`)}` : pyStr(`${r.name || 'resource'}: not implemented yet`)}`;
  return `@mcp.resource(${[pyStr(r.uri), ...kw].join(', ')})\ndef ${fn}(${vars.map((v) => `${v}: str`).join(', ')}) -> str:\n    """${docLines(r.description) || 'TODO: describe this resource.'}"""\n${body}\n`;
}

/** A prompt text with {arg} placeholders as the body of a Python f-string (other braces doubled). */
function pyFString(text, args) {
  const names = new Set(args.map((a) => a.name));
  const parts = [];
  let i = 0;
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    parts.push(text.slice(i, m.index).replace(/[{}]/g, (c) => c + c));
    parts.push(names.has(m[1]) ? `{${m[1]}}` : `{{${m[1]}}}`);
    i = m.index + m[0].length;
  }
  parts.push(text.slice(i).replace(/[{}]/g, (c) => c + c));
  return parts.join('');
}

function pyPrompt(p) {
  const fn = snake(p.name);
  const args = [...p.args.filter((a) => !a.optional), ...p.args.filter((a) => a.optional)].filter((a) => ident(a.name))
    .map((a) => (a.optional ? `${a.name}: str = ""` : `${a.name}: str`));
  const deco = fn !== p.name ? `@mcp.prompt(name=${pyStr(p.name)})` : '@mcp.prompt()';
  const text = p.text || `TODO: write the prompt for ${p.name}.`;
  const lit = `f"""${pyFString(text, p.args).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""`;
  return `${deco}\ndef ${fn}(${args.join(', ')}) -> str:\n    """${docLines(p.description) || 'TODO: describe this prompt.'}"""\n    return ${lit}\n`;
}

function python(m, input) {
  const v2 = input.py_sdk !== 'v1';
  const name = str(input.name) || 'my-server';
  const http = input.transport === 'http';
  const port = Number.isFinite(input.port) && input.port > 0 ? Math.round(input.port) : 8000;
  const anyLiteral = m.tools.some((t) => t.params.some((p) => p.type === 'enum'));
  const anyAnn = m.tools.some((t) => t.params.some((p) => p.description));
  const anyToolAnn = m.tools.some((t) => t.annotation !== 'none');
  const anyJson = m.resources.some((r) => r.mime === 'application/json');
  const typing = [anyAnn ? 'Annotated' : null, anyLiteral ? 'Literal' : null].filter(Boolean);
  const head = [
    `"""${name}: ${docLines(input.description) || 'an MCP server.'}`,
    '',
    `Scaffold from Redline's MCP Server Scaffold for the ${v2 ? `mcp ${VERSIONS.pyV2} (v2, MCPServer)` : `mcp ${VERSIONS.pyV1} (v1, FastMCP)`} Python SDK`,
    `(versions as of ${VERSIONS.asOf}). Run: ${http ? 'uv run server.py' : 'uv run server.py (a client starts it over stdio)'}`,
    '"""',
    '',
    ...(anyJson ? ['import json'] : []),
    ...(!http ? ['import logging', 'import sys'] : []),
    ...(typing.length ? [`from typing import ${typing.join(', ')}`] : []),
    '',
    ...(v2 ? ['from mcp.server import MCPServer'] : ['from mcp.server.fastmcp import FastMCP']),
    ...(anyToolAnn ? ['from mcp.types import ToolAnnotations'] : []),
    ...(anyAnn ? ['from pydantic import Field'] : []),
    '',
  ];
  if (!http) head.push('# stdio: stdout carries the protocol. Log to stderr only; a print() breaks the connection.', 'logging.basicConfig(stream=sys.stderr, level=logging.INFO)', '');
  const ctorArgs = [pyStr(name), str(input.description) ? `instructions=${pyStr(input.description)}` : null, !v2 && http ? `host="127.0.0.1", port=${port}` : null].filter(Boolean);
  head.push(`mcp = ${v2 ? 'MCPServer' : 'FastMCP'}(${ctorArgs.join(', ')})`, '', '');
  const blocks = [
    ...(m.tools.length ? ['# ---------------- tools', ...m.tools.filter((t) => t.name).map(pyTool)] : []),
    ...(m.resources.length ? ['# ---------------- resources', ...m.resources.filter((r) => r.uri).map(pyResource)] : []),
    ...(m.prompts.length ? ['# ---------------- prompts', ...m.prompts.filter((p) => p.name).map(pyPrompt)] : []),
  ];
  const main = http
    ? (v2 ? `if __name__ == "__main__":\n    # Streamable HTTP on http://127.0.0.1:${port}/mcp (localhost only; DNS-rebinding checks stay on)\n    mcp.run(transport="streamable-http", host="127.0.0.1", port=${port})\n`
      : `if __name__ == "__main__":\n    # Streamable HTTP on http://127.0.0.1:${port}/mcp (host and port are set in the constructor in v1)\n    mcp.run(transport="streamable-http")\n`)
    : 'if __name__ == "__main__":\n    mcp.run()  # stdio\n';
  const code = head.join('\n') + blocks.join('\n\n') + '\n\n' + main;
  const pkg = `${snake(name).replace(/_/g, '-')}-mcp`;
  const pyproject = `[project]\nname = "${pkg}"\nversion = "0.1.0"\ndescription = ${pyStr(str(input.description) || `${name} MCP server`)}\nrequires-python = ">=3.10"\ndependencies = [\n    ${v2 ? `"mcp[cli]>=${VERSIONS.pyV2},<3"` : `"mcp[cli]>=1.28,<2"`},  # as of ${VERSIONS.asOf}; check pypi.org/project/mcp\n]\n`;
  return { files: [{ title: 'server.py', body: code, lang: 'python' }, { title: 'pyproject.toml', body: pyproject, lang: 'toml' }], code };
}

// ---------------------------------------------------------------- TypeScript
function zodFor(p) {
  let z;
  switch (p.type) {
    case 'integer': z = 'z.number().int()'; break;
    case 'number': z = 'z.number()'; break;
    case 'boolean': z = 'z.boolean()'; break;
    case 'enum': z = `z.enum([${splitList(p.values).map(tsStr).join(', ')}])`; break;
    case 'string[]': z = 'z.array(z.string())'; break;
    case 'number[]': z = 'z.array(z.number())'; break;
    default: z = 'z.string()';
  }
  if (!p.required) {
    const d = pyDefault(p);
    if (d != null) z += `.default(${p.type === 'boolean' ? d.toLowerCase() : d})`;
    else z += '.optional()';
  }
  if (p.description) z += `.describe(${tsStr(p.description)})`;
  return z;
}
const TS_ANN = { 'read-only': 'readOnlyHint: true, destructiveHint: false', destructive: 'destructiveHint: true', idempotent: 'idempotentHint: true', 'open-world': 'openWorldHint: true' };
const tsKey = (k) => (ident(k) ? k : tsStr(k));

function tsTool(t) {
  const ps = t.params.filter((p) => ident(p.name));
  const cfg = [`description: ${tsStr(t.description || 'TODO: say what this tool does, what it returns and when to use it.')}`];
  if (ps.length) cfg.push(`inputSchema: {\n${ps.map((p) => `  ${tsKey(p.name)}: ${zodFor(p)},`).join('\n')}\n}`);
  if (t.annotation !== 'none') cfg.push(`annotations: { ${TS_ANN[t.annotation]} }`);
  const args = ps.length ? `{ ${ps.map((p) => p.name).join(', ')} }` : '';
  return `server.registerTool(\n  ${tsStr(t.name)},\n  {\n${indent(cfg.join(',\n'), 4)},\n  },\n  async (${args}) => {\n${t.annotation === 'destructive' ? '    // Destructive: clients ask the user before calling. Check the arguments before acting.\n' : ''}    // TODO: implement ${t.name}.${ps.length ? `\n    void [${ps.map((p) => p.name).join(', ')}];` : ''}\n    return { content: [{ type: "text", text: ${tsStr(`${t.name} is not implemented yet`)} }], isError: true };\n  },\n);\n`;
}

function tsResource(r) {
  const name = r.name || snake(r.uri.replace(/^[^:]*:\/*/, ''));
  const meta = [r.description ? `description: ${tsStr(r.description)}` : null, r.mime ? `mimeType: ${tsStr(r.mime)}` : null].filter(Boolean);
  const vars = r.vars.filter(ident);
  const text = r.mime === 'application/json'
    ? `JSON.stringify({ ${vars.map((v) => `${v}: String(${v})`).join(', ')} })`
    : vars.length ? `\`${name} for ${vars.map((v) => `\${String(${v})}`).join(', ')}\`` : tsStr(`${name}: not implemented yet`);
  const mime = r.mime ? `, mimeType: ${tsStr(r.mime)}` : '';
  if (r.vars.length) {
    return `server.registerResource(\n  ${tsStr(name)},\n  new ResourceTemplate(${tsStr(r.uri)}, { list: undefined }),\n  { ${meta.join(', ')} },\n  async (uri, { ${vars.join(', ')} }) => ({\n    // TODO: read the real data.\n    contents: [{ uri: uri.href${mime}, text: ${text} }],\n  }),\n);\n`;
  }
  return `server.registerResource(\n  ${tsStr(name)},\n  ${tsStr(r.uri)},\n  { ${meta.join(', ')} },\n  async (uri) => ({\n    // TODO: read the real data.\n    contents: [{ uri: uri.href${mime}, text: ${text} }],\n  }),\n);\n`;
}

function tsTemplate(text, args) {
  const names = new Set(args.map((a) => a.name));
  return '`' + text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, n) => (names.has(n) ? `\${${n} ?? ""}` : all)) + '`';
}

function tsPrompt(p) {
  const args = p.args.filter((a) => ident(a.name));
  const cfg = [`description: ${tsStr(p.description || 'TODO: describe this prompt.')}`];
  if (args.length) cfg.push(`argsSchema: {\n${args.map((a) => `  ${a.name}: z.string()${a.optional ? '.optional()' : ''},`).join('\n')}\n}`);
  return `server.registerPrompt(\n  ${tsStr(p.name)},\n  {\n${indent(cfg.join(',\n'), 4)},\n  },\n  (${args.length ? `{ ${args.map((a) => a.name).join(', ')} }` : ''}) => ({\n    messages: [{ role: "user", content: { type: "text", text: ${tsTemplate(p.text || `TODO: write the prompt for ${p.name}.`, args)} } }],\n  }),\n);\n`;
}

function typescript(m, input) {
  const name = str(input.name) || 'my-server';
  const http = input.transport === 'http';
  const port = Number.isFinite(input.port) && input.port > 0 ? Math.round(input.port) : 8000;
  const needZod = m.tools.some((t) => t.params.length) || m.prompts.some((p) => p.args.length);
  const needTpl = m.resources.some((r) => r.vars.length);
  const imports = [
    `import { McpServer${needTpl ? ', ResourceTemplate' : ''} } from "@modelcontextprotocol/sdk/server/mcp.js";`,
    http ? 'import type { Request, Response } from "express";\nimport { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";\nimport { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";'
      : 'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    needZod ? 'import { z } from "zod";' : null,
  ].filter(Boolean);
  const blocks = [
    ...(m.tools.length ? ['// ---------------- tools', ...m.tools.filter((t) => t.name).map(tsTool)] : []),
    ...(m.resources.length ? ['// ---------------- resources', ...m.resources.filter((r) => r.uri).map(tsResource)] : []),
    ...(m.prompts.length ? ['// ---------------- prompts', ...m.prompts.filter((p) => p.name).map(tsPrompt)] : []),
  ];
  const build = `export function buildServer(): McpServer {\n  const server = new McpServer(\n    { name: ${tsStr(name)}, version: "0.1.0" },\n    ${str(input.description) ? `{ instructions: ${tsStr(input.description)} }` : '{}'},\n  );\n\n${indent(blocks.join('\n'), 2)}\n  return server;\n}\n`;
  const main = http
    ? `// Stateless Streamable HTTP: a fresh server and transport per request.\n// createMcpExpressApp binds 127.0.0.1 and checks the Host header (DNS rebinding).\nconst app = createMcpExpressApp();\napp.post("/mcp", async (req: Request, res: Response) => {\n  const server = buildServer();\n  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });\n  res.on("close", () => { void transport.close(); void server.close(); });\n  await server.connect(transport);\n  await transport.handleRequest(req, res, req.body);\n});\napp.listen(${port}, "127.0.0.1", () => {\n  console.error(${tsStr(`${name} MCP server on http://127.0.0.1:${port}/mcp`)});\n});\n`
    : `// stdio: stdout carries the protocol; log with console.error only.\nconst transport = new StdioServerTransport();\nawait buildServer().connect(transport);\nconsole.error(${tsStr(`${name} MCP server running on stdio`)});\n`;
  const code = `#!/usr/bin/env node\n// ${name}: ${str(input.description) || 'an MCP server.'}\n// Scaffold from Redline's MCP Server Scaffold for @modelcontextprotocol/sdk ${VERSIONS.tsSdk}\n// (versions as of ${VERSIONS.asOf}). Build: npm install && npm run build\n\n${imports.join('\n')}\n\n${build}\n${main}`;
  const pkgName = `${snake(name).replace(/_/g, '-')}-mcp`;
  const pkg = {
    name: pkgName, version: '0.1.0', description: str(input.description) || `${name} MCP server`, type: 'module',
    bin: { [pkgName]: 'build/index.js' }, files: ['build'],
    scripts: { build: 'tsc && chmod 755 build/index.js', start: 'node build/index.js', inspect: `npx @modelcontextprotocol/inspector@${VERSIONS.inspector} node build/index.js` },
    engines: { node: '>=18' },
    dependencies: { '@modelcontextprotocol/sdk': `^${VERSIONS.tsSdk}`, ...(needZod ? { zod: `^${VERSIONS.zod}` } : {}), ...(http ? { express: `^${VERSIONS.express}` } : {}) },
    devDependencies: { typescript: `^${VERSIONS.typescript}`, '@types/node': `^${VERSIONS.typesNode}`, ...(http ? { '@types/express': `^${VERSIONS.typesExpress}` } : {}) },
  };
  const tsconfig = { compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', outDir: './build', rootDir: './src', strict: true, esModuleInterop: true, skipLibCheck: true, forceConsistentCasingInFileNames: true, types: ['node'] }, include: ['src/**/*'] };
  return { files: [{ title: 'src/index.ts', body: code, lang: 'typescript' }, { title: 'package.json', body: JSON.stringify(pkg, null, 2) + '\n', lang: 'json' }, { title: 'tsconfig.json', body: JSON.stringify(tsconfig, null, 2) + '\n', lang: 'json' }], code };
}

// ---------------------------------------------------------------- client config and README
function clients(input) {
  const name = str(input.name) || 'my-server';
  const http = input.transport === 'http';
  const port = Number.isFinite(input.port) && input.port > 0 ? Math.round(input.port) : 8000;
  const url = `http://127.0.0.1:${port}/mcp`;
  const dir = `/ABSOLUTE/PATH/TO/${name}`;
  const py = input.language === 'python';
  const cmd = py ? { command: 'uv', args: ['--directory', dir, 'run', 'server.py'] } : { command: 'node', args: [`${dir}/build/index.js`] };
  const mcpJson = { mcpServers: { [name]: http ? { type: 'http', url } : cmd } };
  const add = http
    ? `claude mcp add --transport http ${name} ${url}`
    : `claude mcp add ${name} -- ${cmd.command} ${cmd.args.join(' ')}`;
  const desktop = http
    ? `// Claude Desktop's config file starts local stdio servers. For an HTTP server,\n// add it as a custom connector in Settings, or bridge it over stdio:\n${JSON.stringify({ mcpServers: { [name]: { command: 'npx', args: ['-y', 'mcp-remote', url] } } }, null, 2)}`
    : JSON.stringify({ mcpServers: { [name]: cmd } }, null, 2);
  const body = [
    `# Claude Code, this project only: .mcp.json at the repo root (or: ${add.replace('claude mcp add', 'claude mcp add --scope project')})`,
    JSON.stringify(mcpJson, null, 2), '',
    '# Claude Code, one command',
    add, '',
    '# Claude Desktop: claude_desktop_config.json (macOS ~/Library/Application Support/Claude/, Windows %APPDATA%\\Claude\\)',
    desktop, '',
    `# Replace ${dir} with where the project is.`,
  ].join('\n');
  return { body, mcpJson, add };
}

function readme(m, input, c) {
  const name = str(input.name) || 'my-server';
  const py = input.language === 'python';
  const http = input.transport === 'http';
  const port = Number.isFinite(input.port) && input.port > 0 ? Math.round(input.port) : 8000;
  const lines = [
    `# ${name}`, '', str(input.description) || 'An MCP server.', '',
    `Model Context Protocol server in ${py ? `Python (mcp ${input.py_sdk === 'v1' ? '1.x, FastMCP' : `${VERSIONS.pyV2}, MCPServer`})` : `TypeScript (@modelcontextprotocol/sdk ${VERSIONS.tsSdk})`} over ${http ? `Streamable HTTP at http://127.0.0.1:${port}/mcp` : 'stdio'}.`,
    `Versions as of ${VERSIONS.asOf}; check them before pinning.`, '',
    '## Setup', '',
    ...(py ? ['```sh', 'uv sync', http ? 'uv run server.py' : 'uv run mcp dev server.py   # opens the MCP Inspector', '```'] : ['```sh', 'npm install', 'npm run build', http ? 'npm start' : 'npm run inspect   # MCP Inspector', '```']), '',
    '## Capabilities', '',
    ...(m.tools.length ? ['| Tool | Annotation | Parameters | Description |', '|---|---|---|---|', ...m.tools.map((t) => `| \`${t.name}\` | ${t.annotation} | ${t.params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ') || '–'} | ${t.description.replace(/\|/g, '\\|')} |`), ''] : []),
    ...(m.resources.length ? ['| Resource | MIME | Description |', '|---|---|---|', ...m.resources.map((r) => `| \`${r.uri}\` | ${r.mime || '–'} | ${r.description.replace(/\|/g, '\\|')} |`), ''] : []),
    ...(m.prompts.length ? ['| Prompt | Arguments | Description |', '|---|---|---|', ...m.prompts.map((p) => `| \`${p.name}\` | ${p.args.map((a) => a.name + (a.optional ? '?' : '')).join(', ') || '–'} | ${p.description.replace(/\|/g, '\\|')} |`), ''] : []),
    '## Use it from Claude', '', '```sh', c.add, '```', '', 'See the client config file for .mcp.json and Claude Desktop.', '',
    '## Notes', '',
    ...(http ? ['- The server listens on 127.0.0.1 only. Before exposing it on a network, add authentication (the SDK supports OAuth) and keep Host/Origin checks on.'] : ['- stdio: never write to stdout; it carries the protocol. Log to stderr.']),
    '- Tools marked destructive make clients ask before calling them. Annotations are hints: enforce limits in the code too.',
    '- Every tool body is a TODO that returns an error until implemented.', '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- run
export function run(input = {}) {
  const lang = input.language === 'typescript' ? 'typescript' : 'python';
  input = { ...input, language: lang };
  const m = model(input);
  const findings = lint(m, input);
  const gen = lang === 'python' ? python(m, input) : typescript(m, input);
  const c = clients(input);
  const warnings = [];
  const bad = findings.filter((f) => f.level === 'bad');
  const warn = findings.filter((f) => f.level === 'warn');
  if (bad.length) warnings.push(`${bad.length} problem${bad.length > 1 ? 's' : ''} that break the server or a client: ${bad.slice(0, 3).map((f) => `${f.where}: ${f.msg}`).join(' ')}${bad.length > 3 ? ' …' : ''}`);
  const notes = [
    `SDK versions are as of ${VERSIONS.asOf} (PyPI mcp ${VERSIONS.pyV2}, npm @modelcontextprotocol/sdk ${VERSIONS.tsSdk}); check pypi.org/project/mcp and npmjs.com/package/@modelcontextprotocol/sdk before pinning.`,
    lang === 'python'
      ? (input.py_sdk === 'v1' ? 'mcp 1.x: FastMCP from mcp.server.fastmcp, pinned <2. pip install mcp now installs 2.x, where FastMCP is renamed MCPServer.' : 'mcp 2.x renamed FastMCP to MCPServer (from mcp.server import MCPServer); pick the 1.x SDK to keep FastMCP code.')
      : `TypeScript uses the @modelcontextprotocol/sdk 1.x API (McpServer.registerTool). The v2 line is split into @modelcontextprotocol/server ${VERSIONS.tsV2Server} and adapters, with a migration guide; this scaffold does not target it.`,
    'Tool annotations (read-only, destructive, idempotent, open-world) are hints to the client, not enforcement.',
  ];
  const lintText = findings.length ? findings.map((f) => `${f.level === 'bad' ? 'ERROR' : 'WARN '} ${f.where}: ${f.msg}`).join('\n') : 'No findings.';
  // Where each capability sits in the generated source, for the page.
  const codeLines = gen.code.split('\n');
  const find = (needle) => codeLines.findIndex((l) => l.includes(needle));
  const spanOf = (needle) => {
    const a = find(needle);
    if (a < 0) return null;
    let b = a + 1;
    while (b < codeLines.length && !/^(@mcp\.|# -{4,}|if __name__|server\.register|\/\/ -{4,}|  server\.register|  \/\/ -{4,}|  return server)/.test(codeLines[b])) b++;
    let s = a;
    if (lang === 'python') while (s > 0 && codeLines[s - 1].startsWith('@mcp.')) s--;
    else for (let k = 0; k < 3 && s > 0 && !codeLines[s].includes('server.register'); k++) s--;
    return { from: s, to: b };
  };
  const snippet = (needle) => { const sp = spanOf(needle); return sp ? codeLines.slice(sp.from, sp.to).join('\n').replace(/\n+$/, '') : ''; };
  const lv = (kind, row) => { const f = findings.filter((x) => x.ref && x.ref.kind === kind && x.ref.row === row); return f.some((x) => x.level === 'bad') ? 'bad' : f.length ? 'warn' : 'ok'; };

  return {
    values: [
      { label: 'Language', value: lang === 'python' ? `Python, mcp ${input.py_sdk === 'v1' ? '1.x' : '2.x'}` : 'TypeScript, sdk 1.x' },
      { label: 'Transport', value: input.transport === 'http' ? `Streamable HTTP :${Number.isFinite(input.port) && input.port > 0 ? Math.round(input.port) : 8000}/mcp` : 'stdio' },
      { label: 'Tools / resources / prompts', value: `${m.tools.length} / ${m.resources.length} / ${m.prompts.length}` },
      { label: 'Lint', value: `${bad.length} errors, ${warn.length} warnings`, tone: bad.length ? 'bad' : warn.length ? 'warn' : 'ok' },
    ],
    tables: findings.length ? [{ title: 'Lint', columns: ['Level', 'Where', 'Finding'], rows: findings.map((f) => [f.level === 'bad' ? 'error' : 'warning', f.where, f.msg]) }] : [],
    texts: [...gen.files, { title: 'README.md', body: readme(m, input, c), lang: 'markdown' }, { title: 'Client config', body: c.body }, { title: 'Lint', body: lintText }],
    warnings, notes,
    view: {
      lang, transport: input.transport === 'http' ? 'http' : 'stdio', name: str(input.name), sdk: lang === 'python' ? (input.py_sdk === 'v1' ? `FastMCP · mcp 1.x` : `MCPServer · mcp ${VERSIONS.pyV2}`) : `McpServer · sdk ${VERSIONS.tsSdk}`,
      tools: m.tools.map((t) => ({ row: t.row, name: t.name, annotation: t.annotation, n: t.params.length, level: lv('tool', t.row), code: snippet(lang === 'python' ? `def ${snake(t.name)}(` : `  ${tsStr(t.name)},`) })),
      resources: m.resources.map((r) => ({ row: r.row, uri: r.uri, name: r.name, mime: r.mime, level: lv('resource', r.row), code: snippet(lang === 'python' ? `@mcp.resource(${pyStr(r.uri)}` : `${tsStr(r.uri)}`) })),
      prompts: m.prompts.map((p) => ({ row: p.row, name: p.name, args: p.args.map((a) => a.name + (a.optional ? '?' : '')).join(', '), level: lv('prompt', p.row), code: snippet(lang === 'python' ? `def ${snake(p.name)}(` : `  ${tsStr(p.name)},`) })),
      findings, url: `http://127.0.0.1:${Number.isFinite(input.port) && input.port > 0 ? Math.round(input.port) : 8000}/mcp`,
    },
  };
}
