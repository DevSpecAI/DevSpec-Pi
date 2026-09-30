/** Native model surface: every safe eligible operation is available immediately.
 * The wire catalogue, authored model guidance and optional search index are
 * generated from the shared contract. Search recommends; it never grants access.
 */
import MiniSearch from 'minisearch';
import { MCP_CATALOG, MODEL_VERB_NAMES, TOOL_SEARCH_DOCUMENTS, type CatalogEntry } from '../generated/mcp-catalog.ts';
import { ROOM_READ_DESCRIPTION, ROOM_READ_SCHEMA, ROOM_READ_TOOL, ROOM_READ_PROMPT_METADATA } from './room-reader.ts';

export const TOOL_LOADER_NAME = 'search_devspec_tools';
export const PLAN_TOOL_NAME = 'manage_plan';
export const POLL_TOOL_NAME = 'manage_poll';
export const DIRECTED_QUESTION_TOOL_NAME = 'manage_directed_question';
export const ACTIVATION_ONLY_VERBS = new Set<string>([PLAN_TOOL_NAME, POLL_TOOL_NAME, DIRECTED_QUESTION_TOOL_NAME]);
/** Retained export name for host consumers; no longer a selected fifteen-tool tier. */
export const HOT_SET_VERBS = MODEL_VERB_NAMES.filter(name => !ACTIVATION_ONLY_VERBS.has(name) && name !== TOOL_LOADER_NAME);
export type HotSetVerb = (typeof HOT_SET_VERBS)[number];
export const HOT_SET = new Set<string>(HOT_SET_VERBS);
export const SCOPE_KEYS = ['git_remote', 'project_id', 'pinned_project_id', 'session_id', 'runner_session_id', 'connection_id', 'local_session_id', 'commit_provenance_source', 'provenance_source'] as const;
export const SCOPE_KEY_SET = new Set<string>(SCOPE_KEYS);
export const MODEL_OWNED_SESSION_ID_VERBS = new Set<string>(['get_session_transcript']);
export function scopeKeysForTool(name?: string): Set<string> {
  const keys = new Set<string>(SCOPE_KEYS);
  if (name && MODEL_OWNED_SESSION_ID_VERBS.has(name)) keys.delete('session_id');
  return keys;
}
export function isConnectionBoundTool(name: string): boolean { return ACTIVATION_ONLY_VERBS.has(name); }
export const TOOL_LOADER_DESCRIPTION = 'Find the appropriate DevSpec operation by intent when unsure which tool fits. Includes active tools; known tools can be called directly. Search never executes a recommendation.';
export interface ToolPromptMetadata { promptSnippet?: string; promptGuidelines?: string[]; }
export const TOOL_LOADER_PROMPT_METADATA: ToolPromptMetadata = {};
/** Legacy helper for non-model callers. Model guidance is authored, never cut here. */
export function firstSentence(text: string, max = 320): string {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
  const cut = normalized.search(/[.!?](?:\s|$)/);
  const sentence = cut >= 0 ? normalized.slice(0, cut + 1) : normalized;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/** Drop host identity without discarding operational sentences or schema constraints. */
export function slimSchema(schema: Record<string, unknown> | undefined, omitKeys: Set<string> = SCOPE_KEY_SET): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return slimSchema(value as Record<string, unknown>, omitKeys);
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = Object.fromEntries(Object.entries(value).filter(([name, child]) => !omitKeys.has(name) && !(child && typeof child === 'object' && (child as Record<string, unknown>)['x-devspec-host-only'] === true)).map(([name, child]) => [name, visit(child)]));
    } else if (key === 'required' && Array.isArray(value)) {
      const required = value.filter(name => typeof name === 'string' && !omitKeys.has(name));
      if (required.length) out.required = required;
    } else out[key] = visit(value);
  }
  return out;
}
export function slimCatalogEntry(entry: CatalogEntry): CatalogEntry {
  const inputSchema = slimSchema(entry.modelInputSchema, scopeKeysForTool(entry.name));
  if (MODEL_OWNED_SESSION_ID_VERBS.has(entry.name) && Array.isArray(inputSchema.required)) {
    const required = inputSchema.required.filter(name => name !== 'session_id');
    if (required.length) inputSchema.required = required; else delete inputSchema.required;
  }
  return { ...entry, description: entry.promptSnippet, inputSchema };
}
export function catalogEntry(name: string): CatalogEntry | undefined { return MCP_CATALOG.find(entry => entry.name === name); }
export function allModelFacingTools(): CatalogEntry[] { return MCP_CATALOG.filter(entry => entry.kind === 'model').map(slimCatalogEntry); }
export function modelFacingSurface(): CatalogEntry[] { return allModelFacingTools().filter(entry => HOT_SET.has(entry.name)); }
/** No deferred model tier remains. Kept for session-recovery consumers. */
export function rareModelSurface(): CatalogEntry[] { return []; }
export function rareModelVerbs(): string[] { return []; }
export function isCallableModelVerb(name: string): boolean { return catalogEntry(name)?.kind === 'model'; }
export function isHotSetVerb(name: string): boolean { return HOT_SET.has(name); }
/** Tool schemas already carry the guidance; do not repeat the catalogue in prose. */
export function hotToolPromptMetadata(_entry: CatalogEntry): ToolPromptMetadata { return {}; }

export function exactModelToolNames(query: string): string[] | null {
  const names = query.trim().replace(/`/g, '').split(/[\s,]+/).map(name => name.replace(/^\+/, ''));
  return names.length && names.every(name => /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(name)) ? [...new Set(names)] : null;
}
const index = new MiniSearch({ fields: ['name', 'intent'], storeFields: ['description'], searchOptions: { boost: { intent: 3, name: 1 }, prefix: false, fuzzy: false } });
index.addAll(TOOL_SEARCH_DOCUMENTS);
const genericTerms = new Set('a an the to of for in on by with this that it my our me we you all is are can could please what how do does show get find list read write create update save send add tool tools'.split(' '));
/** Offline BM25 fallback. The server's hybrid recommendation is optional. */
export function searchRareModelTools(query: string, limit = 3, availableNames: readonly string[] = HOT_SET_VERBS): CatalogEntry[] {
  const available = new Set(availableNames);
  const names = exactModelToolNames(query);
  const cap = Math.max(1, Math.min(10, Math.trunc(limit) || 3));
  const specific = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(term => !genericTerms.has(term));
  const hits = names ?? (specific.length ? index.search(query).filter(hit => specific.some(term => (hit.match[term]?.length ?? 0) > 0)).map(hit => String(hit.id)) : []);
  return hits.filter(name => available.has(name) && name !== TOOL_LOADER_NAME).slice(0, cap).flatMap(name => {
    const entry = catalogEntry(name);
    return entry?.kind === 'model' ? [slimCatalogEntry(entry)] : [];
  });
}
export function toolLoaderInputSchema(): Record<string, unknown> {
  return { type: 'object', properties: {
    query: { type: 'string', minLength: 1, maxLength: 1000, description: 'Describe the desired operation, or give exact tool names.' },
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 3, description: 'Maximum recommendations. Search does not execute them.' },
  }, required: ['query'] };
}
export function estimatePrefixChars(instructions: string): number {
  const tools = modelFacingSurface().map(entry => ({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema }));
  return JSON.stringify(tools).length + JSON.stringify({ name: TOOL_LOADER_NAME, description: TOOL_LOADER_DESCRIPTION, inputSchema: toolLoaderInputSchema() }).length
    + JSON.stringify({ name: ROOM_READ_TOOL, description: ROOM_READ_DESCRIPTION, inputSchema: ROOM_READ_SCHEMA }).length
    + instructions.length + (ROOM_READ_PROMPT_METADATA.promptSnippet ? `- ${ROOM_READ_TOOL}: ${ROOM_READ_PROMPT_METADATA.promptSnippet}`.length : 0);
}
export function estimatePlanToolChars(): number {
  const entry = catalogEntry(PLAN_TOOL_NAME);
  if (!entry) return 0;
  const tool = slimCatalogEntry(entry);
  return JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length;
}
export function withPlanToolActive(active: readonly string[], enabled: boolean): string[] {
  const rest = active.filter(name => name !== PLAN_TOOL_NAME); return enabled ? [...rest, PLAN_TOOL_NAME] : rest;
}
export function withDirectedQuestionToolActive(active: readonly string[], enabled: boolean): string[] {
  const rest = active.filter(name => name !== DIRECTED_QUESTION_TOOL_NAME); return enabled ? [...rest, DIRECTED_QUESTION_TOOL_NAME] : rest;
}
export function withPollToolActive(active: readonly string[], enabled: boolean): string[] {
  const rest = active.filter(name => name !== POLL_TOOL_NAME); return enabled ? [...rest, POLL_TOOL_NAME] : rest;
}
export function estimatePrefixTokens(instructions: string): number { return Math.ceil(estimatePrefixChars(instructions) / 4); }
// Diagnostic alarm against an accidental full-contract dump, not a quota that
// removes useful tools or instructions. Confirm real provider usage separately.
export const PREFIX_TOKEN_MAX = 45000;
export const PREFIX_TOKEN_MIN = 15000;
