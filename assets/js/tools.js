/* ==========================================================================
   tools.js — the TRALIX tool layer.

   A tool is a named capability with honest availability metadata. Nothing here
   fakes a result: if a tool is not wired to a real backend, `available` is
   false and the UI says so instead of pretending the assistant ran it.

   Adding a real tool later means: implement `run()` here (or server-side),
   flip `available`, and advertise it from /api/health → tools.
   ========================================================================== */

import { FEATURES } from './config.js';

/**
 * @typedef {object} TralixTool
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {boolean} available
 * @property {'client'|'server'} run_where
 * @property {string} [unavailableReason]
 * @property {(input:object, ctx:object)=>Promise<object>} [run]
 */

/** @type {TralixTool[]} */
export const TOOLS = [
  {
    id: 'web_search',
    label: 'Web Search',
    description: 'Look up current information — news, prices, scores, weather.',
    available: FEATURES.webSearch,
    run_where: 'server',
    unavailableReason: 'Web search is not enabled on the connected TRALIX backend.',
  },
  {
    id: 'calculator',
    label: 'Calculator',
    description: 'Exact arithmetic.',
    available: true,
    run_where: 'client',
    run: async ({ expression = '' }) => {
      const value = evaluateExpression(String(expression));
      return { ok: true, output: String(value) };
    },
  },
  {
    id: 'weather',
    label: 'Weather',
    description: 'Current conditions for a location.',
    available: false,
    run_where: 'server',
    unavailableReason: 'Weather needs a data provider configured on the server.',
  },
  {
    id: 'news',
    label: 'News',
    description: 'Headlines and recent events.',
    available: false,
    run_where: 'server',
    unavailableReason: 'News needs a feed provider configured on the server.',
  },
  {
    id: 'code_execution',
    label: 'Code execution',
    description: 'Run code in a sandbox.',
    available: FEATURES.codeExecution,
    run_where: 'server',
    unavailableReason: 'Sandboxed code execution is not deployed.',
  },
  {
    id: 'file_analysis',
    label: 'File analysis',
    description: 'Read PDF, DOCX, TXT, images and code files.',
    available: FEATURES.attachments,
    run_where: 'server',
    unavailableReason: 'File parsing needs the TRALIX upload pipeline (not deployed yet).',
  },
  {
    id: 'image_understanding',
    label: 'Image understanding',
    description: 'Describe or extract information from images.',
    available: FEATURES.attachments,
    run_where: 'server',
    unavailableReason: 'Image uploads are not enabled yet.',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    description: 'Read and create events.',
    available: false,
    run_where: 'server',
    unavailableReason: 'Calendar needs an account connection that is not built yet.',
  },
  {
    id: 'reminders',
    label: 'Reminders',
    description: 'Nudge you at a set time.',
    available: false,
    run_where: 'server',
    unavailableReason: 'Reminders need push infrastructure that is not deployed.',
  },
];

export const toolById = (id) => TOOLS.find(t => t.id === id) || null;
export const availableTools = () => TOOLS.filter(t => t.available);
export const unavailableTools = () => TOOLS.filter(t => !t.available);

/** Merge availability advertised by the backend (server is the source of truth). */
export function applyServerTools(ids = []) {
  const set = new Set(Array.isArray(ids) ? ids : []);
  for (const tool of TOOLS) {
    if (tool.run_where !== 'server') continue;
    tool.available = set.has(tool.id);
    if (!tool.available && !tool.unavailableReason) {
      tool.unavailableReason = 'Not enabled on the connected TRALIX backend.';
    }
  }
}

/**
 * Does this prompt look like it needs live information?
 * Used to route honestly: TRALIX either has a search tool or it says it cannot
 * check current data — it never guesses and claims currency.
 */
export function needsLiveInfo(text = '') {
  const t = String(text).toLowerCase();
  const patterns = [
    /\b(latest|breaking|current|currently|right now|today'?s?|this (week|month|year))\b/,
    /\b(news|headlines)\b/,
    /\b(weather|forecast|temperature)\b.{0,30}\b(in|for|at)\b/,
    /\b(stock|share price|exchange rate|crypto|bitcoin|btc|eth)\b/,
    /\b(score|scores|results|standings|fixture)\b/,
    /\b(released|launch(ed)?|announced|update(d)?)\b.{0,30}\b(version|model|phone|app)\b/,
    /\bwho (won|is winning)\b/,
    /\bprice of\b/,
  ];
  return patterns.some(re => re.test(t));
}

/** Tiny, safe arithmetic evaluator (no eval, no Function). */
export function evaluateExpression(expr) {
  const tokens = String(expr).replace(/\s+/g, '');
  if (!tokens || !/^[-+*/%^().0-9eE]+$/.test(tokens)) throw new Error('Unsupported expression');
  let i = 0;
  const peek = () => tokens[i];
  const parseExpr = () => {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[i++];
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  };
  const parseTerm = () => {
    let value = parsePower();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = tokens[i++];
      const rhs = parsePower();
      if (op === '*') value *= rhs;
      else if (op === '/') value /= rhs;
      else value %= rhs;
    }
    return value;
  };
  const parsePower = () => {
    const base = parseUnary();
    if (peek() === '^') { i++; return base ** parsePower(); }
    return base;
  };
  const parseUnary = () => {
    if (peek() === '-') { i++; return -parseUnary(); }
    if (peek() === '+') { i++; return parseUnary(); }
    return parseAtom();
  };
  const parseAtom = () => {
    if (peek() === '(') {
      i++;
      const value = parseExpr();
      if (peek() !== ')') throw new Error('Unbalanced parentheses');
      i++;
      return value;
    }
    const start = i;
    while (i < tokens.length && /[0-9.eE]/.test(tokens[i])) i++;
    if (start === i) throw new Error('Unexpected character');
    const num = Number(tokens.slice(start, i));
    if (!Number.isFinite(num)) throw new Error('Invalid number');
    return num;
  };
  const result = parseExpr();
  if (i !== tokens.length) throw new Error('Unexpected trailing input');
  return result;
}

/** Run a client-side tool, or explain why it cannot run. */
export async function runTool(id, input = {}, ctx = {}) {
  const tool = toolById(id);
  if (!tool) return { ok: false, reason: `Unknown tool: ${id}` };
  if (!tool.available || !tool.run) {
    return { ok: false, reason: tool.unavailableReason || 'That tool is unavailable.' };
  }
  try {
    return await tool.run(input, ctx);
  } catch (err) {
    return { ok: false, reason: err?.message || 'Tool failed.' };
  }
}
