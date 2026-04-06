import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const serverInfo = { name: "react-forge", version: "0.0.2" };

const baseIgnoredDirNames = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "storybook-static",
]);

const tools = [
  {
    name: "react_forge_ecosystem_plan",
    description:
      "Plans ecosystem-aware component extraction scaffolding (tests/stories/barrel exports) and can optionally apply the changes.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        componentFile: { type: "string" },
        exportName: { type: "string" },
        barrelFile: { type: "string" },
        include: {
          type: "object",
          properties: {
            test: { type: "boolean" },
            story: { type: "boolean" },
            barrel: { type: "boolean" },
          },
          additionalProperties: false,
        },
        computeImpact: { type: "boolean", default: true },
        dryRun: { type: "boolean", default: true },
      },
      required: ["projectRoot", "componentFile", "exportName"],
      additionalProperties: false,
    },
  },
  {
    name: "react_forge_find_dependents",
    description:
      "Builds an import graph (local relative imports) and returns direct and transitive dependents of a file within the project root.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        file: { type: "string" },
        maxResults: { type: "number", default: 500 },
      },
      required: ["projectRoot", "file"],
      additionalProperties: false,
    },
  },
  {
    name: "react_forge_list_source_files",
    description:
      "Lists JS/TS source files under a project root (excluding common build/cache directories). Useful for scoping other tools.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        maxResults: { type: "number", default: 5000 },
        extensions: {
          type: "array",
          items: { type: "string" },
          default: [".ts", ".tsx", ".js", ".jsx"],
        },
      },
      required: ["projectRoot"],
      additionalProperties: false,
    },
  },
  {
    name: "react_forge_file_imports",
    description: "Returns local relative import specs in a file and their resolved targets within the project root.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        file: { type: "string" },
      },
      required: ["projectRoot", "file"],
      additionalProperties: false,
    },
  },
  {
    name: "react_forge_import_graph_stats",
    description: "Builds the local import graph (relative imports) and returns basic stats.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
      },
      required: ["projectRoot"],
      additionalProperties: false,
    },
  },
];

let transportMode = "unknown";
let debugEnabled = process.env.REACT_FORGE_MCP_DEBUG === "1";
let serverSettings = {
  logLevel: "off",
  ignoredDirNames: [],
  maxResults: 500,
  impactMaxResults: 500,
};

function debug(event, data) {
  if (!debugEnabled) return;
  const payload = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  process.stderr.write(`react-forge-mcp ${event}${payload}\n`);
}

debug("boot", {
  pid: process.pid,
  argv: process.argv,
  cwd: process.cwd(),
  node: process.version,
});

function send(message) {
  const json = JSON.stringify(message);
  if (transportMode === "ndjson") {
    process.stdout.write(`${json}\n`);
    debug("send", { transportMode, head: json.slice(0, 80) });
    return;
  }
  const byteLength = Buffer.byteLength(json, "utf8");
  process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${json}`);
  debug("send", { transportMode, byteLength, head: json.slice(0, 80) });
}

function sendError(id, code, message, data) {
  const error = { code, message, ...(data === undefined ? {} : { data }) };
  send({ jsonrpc: "2.0", id, error });
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  return undefined;
}

function toPosixRelativeImport(fromFileAbs, toFileAbs) {
  const fromDir = path.dirname(fromFileAbs);
  let rel = path.relative(fromDir, toFileAbs).replaceAll("\\", "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  rel = rel.replace(/\.(tsx|ts|jsx|js)$/u, "");
  return rel;
}

function resolveWithinRoot(rootAbs, inputPath) {
  const abs = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(rootAbs, inputPath);
  const rel = path.relative(rootAbs, abs);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return abs;
  throw new Error("Path escapes projectRoot");
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function computeToolExecutionId(toolName, args) {
  const h = createHash("sha256");
  h.update(toolName);
  h.update("\n");
  h.update(JSON.stringify(args ?? null));
  return h.digest("hex").slice(0, 16);
}

function detectToolingFromPackageJson(pkgJson) {
  const deps = {
    ...(pkgJson?.dependencies ?? {}),
    ...(pkgJson?.devDependencies ?? {}),
    ...(pkgJson?.peerDependencies ?? {}),
  };

  const hasVitest = typeof deps.vitest === "string";
  const hasJest = typeof deps.jest === "string" || typeof deps["@jest/core"] === "string";
  const hasTestingLibrary =
    typeof deps["@testing-library/react"] === "string" ||
    typeof deps["@testing-library/dom"] === "string";

  const hasStorybook =
    typeof deps.storybook === "string" ||
    Object.keys(deps).some((k) => k.startsWith("@storybook/"));

  return { hasVitest, hasJest, hasTestingLibrary, hasStorybook };
}

function renderStoryFile({ exportName, importPath, title }) {
  return [
    `import type { Meta, StoryObj } from "@storybook/react";`,
    `import { ${exportName} } from "${importPath}";`,
    ``,
    `const meta: Meta<typeof ${exportName}> = {`,
    `  title: "${title}",`,
    `  component: ${exportName},`,
    `};`,
    ``,
    `export default meta;`,
    `type Story = StoryObj<typeof ${exportName}>;`,
    ``,
    `export const Default: Story = {};`,
    ``,
  ].join("\n");
}

function renderTestFile({ exportName, importPath, runner, hasTestingLibrary }) {
  const lines = [];
  if (runner === "vitest") lines.push(`import { describe, expect, it } from "vitest";`);
  if (hasTestingLibrary) lines.push(`import { render } from "@testing-library/react";`);
  lines.push(`import { ${exportName} } from "${importPath}";`);
  lines.push(``);
  lines.push(`describe("${exportName}", () => {`);
  lines.push(`  it("renders", () => {`);
  if (hasTestingLibrary) {
    lines.push(`    expect(() => render(<${exportName} />)).not.toThrow();`);
  } else {
    lines.push(`    expect(${exportName}).toBeDefined();`);
  }
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);
  return lines.join("\n");
}

function ensureNamedExportLine({ exportName, importPath }) {
  return `export { ${exportName} } from "${importPath}";`;
}

async function applyPlan({ actions }) {
  const results = [];
  for (const action of actions) {
    if (action.kind === "create_file") {
      await fs.mkdir(path.dirname(action.path), { recursive: true });
      if (await fileExists(action.path)) {
        results.push({ ...action, status: "skipped_exists" });
        continue;
      }
      await fs.writeFile(action.path, action.contents, "utf8");
      results.push({ ...action, status: "created" });
      continue;
    }

    if (action.kind === "update_file_append_line") {
      await fs.mkdir(path.dirname(action.path), { recursive: true });
      const exists = await fileExists(action.path);
      const current = exists ? await fs.readFile(action.path, "utf8") : "";
      const normalized = current.replaceAll("\r\n", "\n");
      const hasLine = normalized.split("\n").some((l) => l.trim() === action.line.trim());
      if (hasLine) {
        results.push({ ...action, status: "skipped_present" });
        continue;
      }
      const next =
        normalized.trim().length === 0 ? `${action.line}\n` : `${normalized.trimEnd()}\n${action.line}\n`;
      await fs.writeFile(action.path, next, "utf8");
      results.push({ ...action, status: exists ? "updated" : "created" });
      continue;
    }

    results.push({ ...action, status: "skipped_unknown_kind" });
  }
  return results;
}

function getIgnoredDirNames() {
  const extra =
    Array.isArray(serverSettings?.ignoredDirNames) && serverSettings.ignoredDirNames.every((v) => typeof v === "string")
      ? serverSettings.ignoredDirNames
      : [];
  return new Set([...baseIgnoredDirNames, ...extra]);
}

async function listSourceFiles(rootAbs, options) {
  const results = [];
  const queue = [rootAbs];
  const ignored = getIgnoredDirNames();
  const maxResults =
    typeof options?.maxResults === "number" && Number.isFinite(options.maxResults) ? options.maxResults : 50000;
  const extensions =
    Array.isArray(options?.extensions) && options.extensions.every((v) => typeof v === "string")
      ? options.extensions.map((v) => (v.startsWith(".") ? v.toLowerCase() : `.${v.toLowerCase()}`))
      : [".ts", ".tsx", ".js", ".jsx"];
  const extSet = new Set(extensions);

  while (queue.length > 0) {
    const dir = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        queue.push(path.join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!extSet.has(ext)) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      results.push(path.join(dir, entry.name));
      if (results.length >= maxResults) return results;
    }
  }

  return results;
}

const importRe = /\b(?:import|export)\s+(?:type\s+)?[^'"]*?\sfrom\s*["']([^"']+)["']/gu;
const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

function extractLocalImportSpecs(text) {
  const specs = [];
  for (const match of text.matchAll(importRe)) {
    const spec = match[1];
    if (typeof spec === "string" && spec.startsWith(".")) specs.push({ spec, kind: "static" });
  }
  for (const match of text.matchAll(dynamicImportRe)) {
    const spec = match[1];
    if (typeof spec === "string" && spec.startsWith(".")) specs.push({ spec, kind: "dynamic" });
  }
  return specs;
}

async function resolveImportTarget(rootAbs, fromFileAbs, spec) {
  if (typeof spec !== "string" || spec.length === 0) return null;
  if (!spec.startsWith(".")) return null;

  const fromDir = path.dirname(fromFileAbs);
  const base = path.resolve(fromDir, spec);
  const candidates = [];

  if (path.extname(base)) {
    candidates.push(base);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`);
    candidates.push(path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js"), path.join(base, "index.jsx"));
  }

  for (const c of candidates) {
    let abs;
    try {
      abs = resolveWithinRoot(rootAbs, c);
    } catch {
      continue;
    }
    if (await fileExists(abs)) return abs;
  }

  return null;
}

async function extractLocalImportTargets(rootAbs, fileAbs) {
  let text;
  try {
    text = await fs.readFile(fileAbs, "utf8");
  } catch {
    return [];
  }

  const targets = new Set();
  for (const match of text.matchAll(importRe)) {
    const spec = match[1];
    const resolved = await resolveImportTarget(rootAbs, fileAbs, spec);
    if (resolved) targets.add(resolved);
  }
  for (const match of text.matchAll(dynamicImportRe)) {
    const spec = match[1];
    const resolved = await resolveImportTarget(rootAbs, fileAbs, spec);
    if (resolved) targets.add(resolved);
  }

  return [...targets];
}

const graphCache = new Map();

async function getImportGraph(rootAbs) {
  const ignoredKey = [...getIgnoredDirNames()].sort().join("\n");
  const cacheKey = `${rootAbs}\n${ignoredKey}`;
  const cached = graphCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.builtAtMs < 3000) return cached.graph;

  const files = await listSourceFiles(rootAbs);
  const reverse = new Map();
  let edgeCount = 0;

  for (const fileAbs of files) {
    const targets = await extractLocalImportTargets(rootAbs, fileAbs);
    for (const targetAbs of targets) {
      const set = reverse.get(targetAbs) ?? new Set();
      set.add(fileAbs);
      reverse.set(targetAbs, set);
      edgeCount += 1;
    }
  }

  const graph = { rootAbs, reverse, fileCount: files.length, edgeCount };
  graphCache.set(cacheKey, { builtAtMs: now, graph });
  return graph;
}

function collectDependents(graph, fileAbs, maxResults) {
  const direct = [...(graph.reverse.get(fileAbs) ?? new Set())].sort();
  const directSet = new Set(direct);
  const visited = new Set([fileAbs]);
  const transitive = new Set();
  const queue = [...direct];

  while (queue.length > 0 && visited.size - 1 < maxResults) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (!directSet.has(current)) transitive.add(current);
    const parents = graph.reverse.get(current);
    if (!parents) continue;
    for (const p of parents) queue.push(p);
  }

  const transitiveList = [...transitive].sort();
  return {
    direct,
    transitive: transitiveList,
    directCount: direct.length,
    transitiveCount: transitiveList.length,
    totalCount: direct.length + transitiveList.length,
  };
}

async function ecosystemPlan(args) {
  const projectRoot = args.projectRoot;
  const componentFile = args.componentFile;
  const exportName = args.exportName;
  const barrelFile = typeof args.barrelFile === "string" ? args.barrelFile : undefined;
  const include = typeof args.include === "object" && args.include !== null ? args.include : {};
  const computeImpact = args.computeImpact === undefined ? true : !!args.computeImpact;
  const dryRun = args.dryRun === undefined ? true : !!args.dryRun;

  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "projectRoot must be a non-empty string" } };
  }
  if (typeof componentFile !== "string" || componentFile.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "componentFile must be a non-empty string" } };
  }
  if (typeof exportName !== "string" || exportName.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "exportName must be a non-empty string" } };
  }

  const projectRootAbs = path.resolve(projectRoot);
  let componentAbs;
  try {
    componentAbs = resolveWithinRoot(projectRootAbs, componentFile);
  } catch {
    return { ok: false, error: { code: -32602, message: "componentFile must be within projectRoot" } };
  }

  const pkgJson = await readJsonIfExists(path.join(projectRootAbs, "package.json"));
  const tooling = detectToolingFromPackageJson(pkgJson);

  const includeStory = normalizeBoolean(include.story) ?? tooling.hasStorybook;
  const includeTest = normalizeBoolean(include.test) ?? (tooling.hasVitest || tooling.hasJest);
  const includeBarrel = normalizeBoolean(include.barrel) ?? true;

  const componentDir = path.dirname(componentAbs);
  const componentStem = path.basename(componentAbs).replace(/\.(tsx|ts|jsx|js)$/u, "");

  const inferredBarrelAbs = path.join(componentDir, "index.ts");
  let barrelAbs;
  if (barrelFile) {
    try {
      barrelAbs = resolveWithinRoot(projectRootAbs, barrelFile);
    } catch {
      return { ok: false, error: { code: -32602, message: "barrelFile must be within projectRoot" } };
    }
  } else {
    barrelAbs = inferredBarrelAbs;
  }

  const storyAbs = path.join(componentDir, `${componentStem}.stories.tsx`);
  const testAbs = path.join(componentDir, `${componentStem}.test.tsx`);

  const storyImport = toPosixRelativeImport(storyAbs, componentAbs);
  const testImport = toPosixRelativeImport(testAbs, componentAbs);
  const barrelImport = toPosixRelativeImport(barrelAbs, componentAbs);

  const actions = [];

  if (includeStory && tooling.hasStorybook) {
    actions.push({
      kind: "create_file",
      path: storyAbs,
      contents: renderStoryFile({
        exportName,
        importPath: storyImport,
        title: `Components/${exportName}`,
      }),
    });
  }

  if (includeTest) {
    const runner = tooling.hasVitest ? "vitest" : tooling.hasJest ? "jest" : "unknown";
    actions.push({
      kind: "create_file",
      path: testAbs,
      contents: renderTestFile({
        exportName,
        importPath: testImport,
        runner,
        hasTestingLibrary: tooling.hasTestingLibrary,
      }),
    });
  }

  if (includeBarrel) {
    actions.push({
      kind: "update_file_append_line",
      path: barrelAbs,
      line: ensureNamedExportLine({ exportName, importPath: barrelImport }),
    });
  }

  const plan = {
    toolExecutionId: computeToolExecutionId("react_forge_ecosystem_plan", args),
    inputs: {
      projectRoot: projectRootAbs,
      componentFile: componentAbs,
      exportName,
      dryRun,
      include: { story: includeStory, test: includeTest, barrel: includeBarrel },
      computeImpact,
    },
    detected: {
      testRunner: tooling.hasVitest ? "vitest" : tooling.hasJest ? "jest" : "none",
      storybook: tooling.hasStorybook,
      testingLibrary: tooling.hasTestingLibrary,
    },
    impact: null,
    actions,
  };

  if (computeImpact) {
    const graph = await getImportGraph(projectRootAbs);
    const impactMaxResults =
      typeof serverSettings?.impactMaxResults === "number" && Number.isFinite(serverSettings.impactMaxResults)
        ? serverSettings.impactMaxResults
        : 500;
    plan.impact = collectDependents(graph, componentAbs, impactMaxResults);
  }

  if (dryRun) return { ok: true, plan, applied: null };

  const applied = await applyPlan({ actions });
  return { ok: true, plan, applied };
}

async function findDependents(args) {
  const projectRoot = args.projectRoot;
  const file = args.file;
  const defaultMaxResults =
    typeof serverSettings?.maxResults === "number" && Number.isFinite(serverSettings.maxResults)
      ? serverSettings.maxResults
      : 500;
  const maxResults =
    typeof args.maxResults === "number" && Number.isFinite(args.maxResults) ? args.maxResults : defaultMaxResults;

  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "projectRoot must be a non-empty string" } };
  }
  if (typeof file !== "string" || file.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "file must be a non-empty string" } };
  }

  const rootAbs = path.resolve(projectRoot);
  let fileAbs;
  try {
    fileAbs = resolveWithinRoot(rootAbs, file);
  } catch {
    return { ok: false, error: { code: -32602, message: "file must be within projectRoot" } };
  }

  const graph = await getImportGraph(rootAbs);
  const { direct, transitive, directCount, transitiveCount, totalCount } = collectDependents(graph, fileAbs, maxResults);
  return {
    ok: true,
    result: {
      file: fileAbs,
      direct,
      transitive,
      directCount,
      transitiveCount,
      totalCount,
    },
  };
}

function parseServerSettings(value) {
  if (!value || typeof value !== "object") return {};
  const settings = {};

  if (typeof value.logLevel === "string") settings.logLevel = value.logLevel;
  if (Array.isArray(value.ignoredDirNames) && value.ignoredDirNames.every((v) => typeof v === "string")) {
    settings.ignoredDirNames = value.ignoredDirNames;
  }
  if (typeof value.maxResults === "number" && Number.isFinite(value.maxResults)) settings.maxResults = value.maxResults;
  if (typeof value.impactMaxResults === "number" && Number.isFinite(value.impactMaxResults)) {
    settings.impactMaxResults = value.impactMaxResults;
  }
  return settings;
}

async function listSourceFilesTool(args) {
  const projectRoot = args.projectRoot;
  const maxResults = typeof args.maxResults === "number" && Number.isFinite(args.maxResults) ? args.maxResults : 5000;
  const extensions = args.extensions;

  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "projectRoot must be a non-empty string" } };
  }

  const rootAbs = path.resolve(projectRoot);
  const files = await listSourceFiles(rootAbs, { maxResults, extensions });
  const relative = files.map((f) => path.relative(rootAbs, f).replaceAll("\\", "/"));
  return { ok: true, result: { projectRoot: rootAbs, fileCount: files.length, files, relative } };
}

async function fileImportsTool(args) {
  const projectRoot = args.projectRoot;
  const file = args.file;

  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "projectRoot must be a non-empty string" } };
  }
  if (typeof file !== "string" || file.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "file must be a non-empty string" } };
  }

  const rootAbs = path.resolve(projectRoot);
  let fileAbs;
  try {
    fileAbs = resolveWithinRoot(rootAbs, file);
  } catch {
    return { ok: false, error: { code: -32602, message: "file must be within projectRoot" } };
  }

  let text;
  try {
    text = await fs.readFile(fileAbs, "utf8");
  } catch {
    return { ok: false, error: { code: -32602, message: "file could not be read" } };
  }

  const specs = extractLocalImportSpecs(text);
  const imports = [];
  for (const { spec, kind } of specs) {
    const resolved = await resolveImportTarget(rootAbs, fileAbs, spec);
    imports.push({ spec, kind, resolved });
  }

  const localTargets = imports.map((i) => i.resolved).filter((v) => typeof v === "string");
  return { ok: true, result: { file: fileAbs, imports, localTargets } };
}

async function importGraphStatsTool(args) {
  const projectRoot = args.projectRoot;
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return { ok: false, error: { code: -32602, message: "projectRoot must be a non-empty string" } };
  }

  const rootAbs = path.resolve(projectRoot);
  const graph = await getImportGraph(rootAbs);
  return {
    ok: true,
    result: {
      projectRoot: rootAbs,
      fileCount: graph.fileCount,
      edgeCount: graph.edgeCount,
      ignoredDirNames: [...getIgnoredDirNames()].sort(),
    },
  };
}

let didInitialize = false;

async function handleRequest(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;

  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    const protocolVersion =
      typeof params.protocolVersion === "string" && params.protocolVersion.trim().length > 0
        ? params.protocolVersion
        : "2024-11-05";
    const incomingSettings =
      params?.settings ??
      params?.initializationOptions?.settings ??
      params?.clientInfo?.settings ??
      params?.clientInfo?.configuration;
    serverSettings = { ...serverSettings, ...parseServerSettings(incomingSettings) };
    if (serverSettings.logLevel === "debug") debugEnabled = true;
    didInitialize = true;
    return sendResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo,
    });
  }

  if (method === "notifications/initialized") return;

  if (!didInitialize) {
    return sendError(id, -32002, "Server not initialized");
  }

  if (method === "tools/list") {
    return sendResult(id, { tools });
  }

  if (method === "tools/call") {
    if (typeof params?.name !== "string") {
      return sendError(id, -32602, "Invalid params", { reason: "name must be a string" });
    }
    const name = params.name;
    const args = params.arguments ?? {};

    if (name === "react_forge_ecosystem_plan") {
      const outcome = await ecosystemPlan(args);
      if (!outcome.ok) return sendError(id, outcome.error.code, outcome.error.message);
      return sendResult(id, {
        content: [{ type: "text", text: JSON.stringify({ plan: outcome.plan, applied: outcome.applied }, null, 2) }],
        isError: false,
      });
    }

    if (name === "react_forge_find_dependents") {
      const outcome = await findDependents(args);
      if (!outcome.ok) return sendError(id, outcome.error.code, outcome.error.message);
      return sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.result, null, 2) }],
        isError: false,
      });
    }

    if (name === "react_forge_list_source_files") {
      const outcome = await listSourceFilesTool(args);
      if (!outcome.ok) return sendError(id, outcome.error.code, outcome.error.message);
      return sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.result, null, 2) }],
        isError: false,
      });
    }

    if (name === "react_forge_file_imports") {
      const outcome = await fileImportsTool(args);
      if (!outcome.ok) return sendError(id, outcome.error.code, outcome.error.message);
      return sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.result, null, 2) }],
        isError: false,
      });
    }

    if (name === "react_forge_import_graph_stats") {
      const outcome = await importGraphStatsTool(args);
      if (!outcome.ok) return sendError(id, outcome.error.code, outcome.error.message);
      return sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.result, null, 2) }],
        isError: false,
      });
    }

    return sendError(id, -32602, `Unknown tool: ${name}`);
  }

  return sendError(id, -32601, `Method not found: ${method}`);
}

const pending = new Set();
let stdinBuffer = Buffer.alloc(0);

function parseContentLength(headersText) {
  const match = headersText.match(/^\s*content-length\s*:\s*(\d+)\s*$/imu);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function handleIncomingJson(jsonText, incomingMode) {
  if (transportMode === "unknown" && (incomingMode === "ndjson" || incomingMode === "content-length")) {
    transportMode = incomingMode;
  }
  debug("recv", { incomingMode, transportMode, head: jsonText.slice(0, 80) });
  let message;
  try {
    message = JSON.parse(jsonText);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }

  const p = Promise.resolve(handleRequest(message))
    .catch((err) => {
      sendError(message?.id ?? null, -32603, "Internal error", { message: String(err?.message ?? err) });
    })
    .finally(() => {
      pending.delete(p);
    });
  pending.add(p);
}

function pumpStdinBuffer() {
  while (stdinBuffer.length > 0) {
    while (stdinBuffer.length > 0 && (stdinBuffer[0] === 0x0a || stdinBuffer[0] === 0x0d)) {
      stdinBuffer = stdinBuffer.slice(1);
    }

    const headerEndCrLf = stdinBuffer.indexOf("\r\n\r\n");
    const headerEndLf = headerEndCrLf === -1 ? stdinBuffer.indexOf("\n\n") : -1;
    const headerEnd = headerEndCrLf !== -1 ? headerEndCrLf : headerEndLf;
    const headerSepLength = headerEndCrLf !== -1 ? 4 : headerEndLf !== -1 ? 2 : 0;

    if (headerEnd === -1) {
      const head = stdinBuffer.slice(0, Math.min(stdinBuffer.length, 64)).toString("utf8");
      if (/^\s*content-length\s*:/iu.test(head)) return;
      const nl = stdinBuffer.indexOf("\n");
      if (nl === -1) return;
      const line = stdinBuffer.slice(0, nl).toString("utf8").trim();
      stdinBuffer = stdinBuffer.slice(nl + 1);
      if (line.length === 0) continue;
      handleIncomingJson(line, "ndjson");
      continue;
    }

    const headersText = stdinBuffer.slice(0, headerEnd).toString("utf8");
    const contentLength = parseContentLength(headersText);
    if (contentLength === null) {
      const consume = headerEnd + headerSepLength;
      stdinBuffer = stdinBuffer.slice(consume);
      continue;
    }

    const messageStart = headerEnd + headerSepLength;
    const messageEnd = messageStart + contentLength;
    if (stdinBuffer.length < messageEnd) return;
    const messageText = stdinBuffer.slice(messageStart, messageEnd).toString("utf8");
    stdinBuffer = stdinBuffer.slice(messageEnd);
    handleIncomingJson(messageText, "content-length");
  }
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  pumpStdinBuffer();
});

process.stdin.on("end", () => {
  pumpStdinBuffer();
  Promise.allSettled([...pending]).finally(() => process.exit(0));
});
