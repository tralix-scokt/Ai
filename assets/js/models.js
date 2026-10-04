/* ==========================================================================
   models.js — the TRALIX model system.

   Users pick a TRALIX tier ("TRALIX Smart"), never a vendor model name. The
   tier is resolved to a concrete provider model by the backend (server-side
   config), so provider churn never leaks into the interface.

   The local mapping below is the fallback used only when the app runs in the
   advanced "local transport" mode with the user's own key, and as the last
   resort when the backend does not advertise a mapping.
   ========================================================================== */

/**
 * @typedef {object} TralixModel
 * @property {string} id              tralix tier id (what the UI stores)
 * @property {string} label           UI name
 * @property {string} tagline         one-line descriptor under the name
 * @property {string} description     longer explanation for the picker
 * @property {'fast'|'balanced'|'deep'} speed
 * @property {string[]} strengths
 * @property {object} openai          fallback resolution for BYO-key mode
 * @property {object} gemini          legacy fallback (provider-agnostic client)
 */

/** @type {TralixModel[]} */
export const MODELS = [
  {
    id: 'tralix-fast',
    label: 'TRALIX Fast',
    tagline: 'Fast responses',
    description: 'Quick, low-latency answers for everyday questions and drafting.',
    speed: 'fast',
    strengths: ['Everyday chat', 'Short tasks', 'Voice conversations'],
    openai: { model: 'gpt-5-mini', reasoning: { effort: 'minimal' } },
    gemini: { model: 'gemini-2.5-flash-lite' },
  },
  {
    id: 'tralix-smart',
    label: 'TRALIX Smart',
    tagline: 'More capable reasoning',
    description: 'The balanced default: strong reasoning with comfortable speed.',
    speed: 'balanced',
    strengths: ['Reasoning', 'Writing', 'Analysis', 'Default choice'],
    recommended: true,
    openai: { model: 'gpt-5', reasoning: { effort: 'low' } },
    gemini: { model: 'gemini-2.5-flash' },
  },
  {
    id: 'tralix-code',
    label: 'TRALIX Code',
    tagline: 'Programming-focused',
    description: 'Tuned for reading, writing and explaining code, diffs and errors.',
    speed: 'balanced',
    strengths: ['Code generation', 'Debugging', 'Refactoring'],
    openai: { model: 'gpt-5-codex', reasoning: { effort: 'medium' } },
    gemini: { model: 'gemini-2.5-pro' },
  },
  {
    id: 'tralix-research',
    label: 'TRALIX Research',
    tagline: 'Research-oriented',
    description: 'Slower, deeper answers with structured detail for complex questions.',
    speed: 'deep',
    strengths: ['Long-form analysis', 'Synthesis', 'Structured reports'],
    openai: { model: 'gpt-5', reasoning: { effort: 'high' } },
    gemini: { model: 'gemini-2.5-pro' },
  },
];

export const DEFAULT_MODEL_ID = 'tralix-smart';

export const modelById = (id) => MODELS.find(m => m.id === id)
  || MODELS.find(m => m.id === DEFAULT_MODEL_ID);

export const modelLabel = (id) => modelById(id).label;

/** Coerce anything (including a legacy vendor id) into a valid tier id. */
export function normaliseModelId(id) {
  if (MODELS.some(m => m.id === id)) return id;
  const raw = String(id || '');
  if (/code/i.test(raw)) return 'tralix-code';
  if (/research|pro|opus|o[13]\b/i.test(raw)) return 'tralix-research';
  if (/mini|nano|lite|flash-lite|haiku/i.test(raw)) return 'tralix-fast';
  return DEFAULT_MODEL_ID;
}

/** Local fallback mapping for a provider, used in advanced BYO-key mode. */
export function resolveLocal(modelId, provider = 'openai') {
  const tier = modelById(normaliseModelId(modelId));
  return provider === 'gemini' ? { ...tier.gemini } : { ...tier.openai };
}

/**
 * Merge a server-provided mapping (/api/models) into the catalog so Advanced
 * and debugging can show what a tier actually resolves to in this deployment.
 */
export function applyServerMapping(mapping = {}) {
  for (const tier of MODELS) {
    const entry = mapping[tier.id];
    if (!entry) continue;
    if (entry.label) tier.label = String(entry.label);
    if (entry.tagline) tier.tagline = String(entry.tagline);
    tier.resolved = {
      provider: entry.provider || 'openai',
      model: entry.model || '',
      note: entry.note || '',
    };
  }
}

/** Human-readable summary of what a tier maps to (Advanced settings only). */
export function resolvedSummary(modelId) {
  const tier = modelById(modelId);
  if (tier.resolved?.model) {
    return `${tier.resolved.provider} · ${tier.resolved.model}`;
  }
  return `${tier.openai.model} (fallback mapping)`;
}

/* --------------------------- preference helpers --------------------------- */
/** Map response style → instruction text used by the personality layer. */
export const RESPONSE_STYLES = [
  { id: 'concise', label: 'Concise', hint: 'Short, to the point' },
  { id: 'balanced', label: 'Balanced', hint: 'Default — answer plus useful detail' },
  { id: 'detailed', label: 'Detailed', hint: 'Thorough, structured explanations' },
];

/** Follow-up actions available on every TRALIX response (requirement 11). */
export const RESPONSE_ACTIONS = [
  { id: 'continue', label: 'Continue', prompt: 'Continue exactly where you left off. Do not repeat anything you already wrote.' },
  { id: 'shorter', label: 'Shorter', prompt: 'Rewrite your previous answer much shorter — keep only the essential points.' },
  { id: 'longer', label: 'Longer', prompt: 'Expand your previous answer with more depth, examples and specifics.' },
  { id: 'explain', label: 'Explain', prompt: 'Explain your previous answer more simply, as if to a smart beginner. Keep the structure.' },
  { id: 'rewrite', label: 'Rewrite', prompt: 'Rewrite your previous answer with clearer structure and tighter language. Same meaning.' },
  { id: 'save', label: 'Save', prompt: null },              // handled locally
];
