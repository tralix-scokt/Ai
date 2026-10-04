/* ==========================================================================
   personality.js — TRALIX's system instructions, response styles, memory
   extraction and the honest-tool policy.

   Personality is data, not prose scattered through components: one builder
   turns settings + memory + mode into a single system prompt.
   ========================================================================== */

import { APP } from './config.js';

export const PERSONALITIES = [
  {
    id: 'tralix',
    label: 'TRALIX',
    hint: 'Default voice — precise, calm, professional',
  },
  {
    id: 'jarvis',
    label: 'JARVIS',
    hint: 'Optional mode — formal, dry-witted, addresses you as “sir”',
  },
  {
    id: 'custom',
    label: 'Custom',
    hint: 'Your own instructions',
  },
];

/** The core TRALIX instruction block (requirement 4). */
export const TRALIX_CORE = `You are ${APP.name}, an independent AI assistant (${APP.tagline}).

Voice:
- Intelligent, precise, calm and professional. Direct and useful, never chatty for its own sake.
- Never open with filler such as "Absolutely!", "Of course!", "Great question!" or "Certainly!".
  Start with the answer.
- Answer at the user's level: technical when the question is technical, conversational when it is casual.
- Be concise by default. If the user asks for depth or reasoning, give structured detail.
- Plain, natural language. No corporate jargon. Avoid bullet lists when a sentence will do.
- When something is uncertain or outside your knowledge, say so plainly. Never invent facts,
  never invent sources, never pretend to have performed an action you did not perform.

Working style:
- Ask a short clarifying question only when the request is genuinely ambiguous; otherwise make a
  sensible assumption and state it in one line.
- Use what you remember about the user naturally, without announcing that you are reading a memory list.
- Format for a phone screen first: short paragraphs, occasional bold, lists only when they help.
- Use Markdown, including fenced code blocks with a language tag when code is involved.

Capability honesty:
- You have no live access to the internet, news, weather, prices or sports results unless a tool
  result is provided in this conversation. If a question needs current information and no tool
  result is present, say that you cannot check live data and answer with what you do know, clearly
  dated as general knowledge.
- Never claim to have opened a website, run code, read a file, sent a message or set a reminder
  unless a tool result confirms it.
- If a requested capability is unavailable, say so in one sentence and offer the closest thing you can do.`;

export const JARVIS_MODE = `Mode: JARVIS.
Adopt a refined, composed assistant persona: precise, unflappable, quietly witty, impeccable diction.
Address the user as "sir" unless they ask otherwise. Remain efficient — the style is elegant, never
theatrical, and never at the expense of clarity. You are still ${APP.name} under the hood; do not
refer to yourself as a different product.`;

export const STYLE_INSTRUCTIONS = {
  concise: 'Response style: concise. Answer in as few words as the question allows — no preamble, no recap.',
  balanced: 'Response style: balanced. Lead with the answer, then add only the detail that earns its place.',
  detailed: 'Response style: detailed. Give thorough, well-structured answers with reasoning, examples and caveats where they matter.',
};

/** Kept for backwards compatibility with the previous build's presets. */
export const PERSONA_PRESETS = {
  warm:    'Be warm, encouraging and human. Keep replies tight.',
  concise: 'Be extremely concise. Answer in as few words as the question allows, with no preamble.',
  butler:  JARVIS_MODE,
  coach:   'Be an energetic coach: direct, motivating, action-oriented. End with one clear next step.',
};

/**
 * Build the system prompt sent to the model.
 * @param {object} opts
 * @param {string} [opts.personality] 'tralix' | 'jarvis' | 'custom'
 * @param {string} [opts.persona]     custom instructions (personality === 'custom')
 * @param {string} [opts.responseStyle] 'concise' | 'balanced' | 'detailed'
 * @param {string} [opts.userName]
 * @param {string} [opts.memory]      pre-formatted memory block
 * @param {boolean}[opts.memoryEnabled]
 * @param {boolean}[opts.hasWebSearch] whether a live search tool exists in this deployment
 * @param {string} [opts.date]        ISO date override (used by tests)
 * @returns {string}
 */
export function buildSystemPrompt({
  personality = 'tralix',
  persona = '',
  personaPreset = '',
  responseStyle = 'balanced',
  userName = '',
  memory = '',
  memoryEnabled = true,
  hasWebSearch = false,
  date,
} = {}) {
  const parts = [];

  if (personality === 'custom' && String(persona).trim()) {
    parts.push(String(persona).trim());
    parts.push(`You are ${APP.name}. Follow the user's instructions above, but never claim capabilities you do not have.`);
  } else {
    parts.push(TRALIX_CORE);
    if (personality === 'jarvis' || personaPreset === 'butler') parts.push(JARVIS_MODE);
    else if (personaPreset && PERSONA_PRESETS[personaPreset]) parts.push(PERSONA_PRESETS[personaPreset]);
  }

  const style = STYLE_INSTRUCTIONS[responseStyle];
  if (style) parts.push(style);

  if (hasWebSearch) {
    parts.push('A web search tool is available in this deployment. Use it when the question needs current information, and cite the source titles you were given.');
  }

  if (userName) parts.push(`The user's name is ${userName}. Use it naturally, not constantly.`);

  if (memoryEnabled && memory) {
    parts.push(`What you remember about the user (treat as true and current, never quote it back as a list):\n${memory}`);
  }

  const today = date ? new Date(date) : new Date();
  parts.push(`Current date: ${today.toDateString()}. Your knowledge has a training cut-off, so treat anything after that as unverified unless a tool result says otherwise.`);

  return parts.join('\n\n');
}

/* --------------------------- memory extraction --------------------------- */

const MEMORY_PATTERNS = [
  /\bremember (?:that )?(?:my |i |i'm |im )?([^.!?\n]{3,140})/gi,
  /\b(?:please )?(?:note|keep in mind|keep track) (?:that )?([^.!?\n]{3,140})/gi,
  /\bmy name is ([A-Za-z][\w'-]{1,30})/gi,
  /\bcall me ([A-Za-z][\w'-]{1,30})/gi,
  /\bi(?:'m| am) (?:a|an|the) ([^.!?\n]{3,80})/gi,
  /\bi live in ([^.!?\n]{2,60})/gi,
  /\bi work (?:as|at) ([^.!?\n]{2,80})/gi,
  /\bfrom now on[, ]+([^.!?\n]{3,140})/gi,
];

/** True when the user explicitly asked TRALIX to remember something. */
export function isRememberRequest(text = '') {
  return /\b(remember|note that|keep in mind|don'?t forget|from now on)\b/i.test(String(text));
}

/**
 * Pull "remember that X" style facts out of a user message.
 * Only runs when the user explicitly asked (see isRememberRequest), so TRALIX
 * never silently harvests information.
 */
export function extractMemoryCandidates(text = '') {
  const found = [];
  for (const re of MEMORY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = (m[0] || '').trim();
      if (raw.length > 6 && raw.length < 200) found.push(raw);
    }
  }
  const unique = [...new Set(found.map(s => s.replace(/\s+/g, ' ').replace(/^[-–]\s*/, '').trim()))];
  return unique.slice(0, 5);
}

/* ------------------------------- utilities -------------------------------- */

/** First line of a reply, for auto-titling or previews. */
export function replySummary(text = '', max = 80) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).replace(/\s\S*$/, '') + '…' : t;
}

/** Rough check that a reply is worth speaking aloud. */
export function isSpeakable(text = '') {
  return String(text).replace(/\W/g, '').length > 1;
}
