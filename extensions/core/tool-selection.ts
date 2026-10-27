import { TOOL_CATALOG_VERSION, MCP_CATALOG_FINGERPRINT } from '../generated/mcp-catalog.ts';
import { catalogEntry, exactModelToolNames, rankRareModelTools, TOOL_LOADER_NAME, toolSearchLimit, toolSearchPage, type ToolSearchPage } from './model-surface.ts';

type SelectionFailure = 'catalog_mismatch' | 'index_outdated' | 'embedding_unavailable' | 'invalid_response' | 'transport_unavailable';
const failureMessages: Record<SelectionFailure, string> = {
  catalog_mismatch: 'Pi and DevSpec have different tool definitions. Update the extension with pi update --extensions and restart Pi; using local keyword search. Direct tools remain usable.',
  index_outdated: 'DevSpec\'s meaning-based tool-search index is not ready; using local keyword search. Direct tools remain usable.',
  embedding_unavailable: 'DevSpec could not rank tools by meaning; using local keyword search. Direct tools remain usable.',
  invalid_response: 'DevSpec returned a tool-search response Pi could not read; using local keyword search. Direct tools remain usable.',
  transport_unavailable: 'Pi\'s request to DevSpec tool search failed; using local keyword search. Direct tools remain usable.',
};

export interface SelectionResult {
  mode: 'exact' | 'hybrid' | 'lexical';
  degraded: boolean;
  reason?: string;
  failureReason?: SelectionFailure;
  matches: Array<{ name: string; description: string }>;
  page: ToolSearchPage;
  unavailable: string[];
}

function serverPage(value: unknown): ToolSearchPage | null {
  if (!value || typeof value !== 'object') return null;
  const page = value as Record<string, unknown>;
  const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (!whole(page.total_matching) || !whole(page.offset) || !whole(page.limit) || !whole(page.returned) || typeof page.has_more !== 'boolean') return null;
  const next = page.next_offset;
  if (next !== null && !whole(next)) return null;
  return { total_matching: page.total_matching as number, offset: page.offset as number, limit: page.limit as number, returned: page.returned as number, has_more: page.has_more, next_offset: next as number | null };
}

/** Never activates or executes a tool. Responses can only recommend locally
 * registered, currently callable names, using this installation's own guidance.
 */
export async function selectTools(query: string, limitInput: unknown, activeNames: readonly string[], request: (args: Record<string, unknown>) => Promise<unknown>, offsetInput: unknown = 0): Promise<SelectionResult> {
  const limit = toolSearchLimit(limitInput);
  const offset = typeof offsetInput === 'number' && Number.isFinite(offsetInput) ? Math.max(0, Math.trunc(offsetInput)) : 0;
  const available = activeNames.filter(name => name !== TOOL_LOADER_NAME && catalogEntry(name)?.kind === 'model');
  const known = new Set(available);
  const exact = exactModelToolNames(query);
  const local = () => {
    const ranked = rankRareModelTools(query, available);
    const matches = ranked.slice(offset, offset + limit).map(entry => ({ name: entry.name, description: entry.description }));
    return { matches, page: toolSearchPage(ranked.length, offset, limit, matches.length) };
  };
  const fallback = (failureReason: SelectionFailure): SelectionResult => ({ mode: 'lexical', degraded: true, failureReason, reason: failureMessages[failureReason], ...local(), unavailable: [] });
  if (exact) return { mode: 'exact', degraded: false, ...local(), unavailable: exact.filter(name => !known.has(name)) };
  try {
    const raw = await request({ query, limit, offset, available_tools: available, catalog_version: TOOL_CATALOG_VERSION, schema_fingerprint: MCP_CATALOG_FINGERPRINT });
    const result = raw as { catalog_version?: unknown; mode?: unknown; degraded?: unknown; reason?: unknown; matches?: unknown; page?: unknown } | null;
    if (result?.degraded === true) {
      switch (result.reason) {
        case 'catalog_mismatch': case 'index_outdated': case 'embedding_unavailable': return fallback(result.reason);
        default: return fallback('invalid_response');
      }
    }
    if (typeof result?.catalog_version === 'string' && result.catalog_version !== TOOL_CATALOG_VERSION) return fallback('catalog_mismatch');
    const page = serverPage(result?.page);
    if (!result || !page || result.catalog_version !== TOOL_CATALOG_VERSION || result.degraded !== false || result.mode !== 'hybrid' || !Array.isArray(result.matches) || result.matches.some(row => !row || typeof row !== 'object' || typeof (row as { name?: unknown }).name !== 'string')) {
      return fallback('invalid_response');
    }
    const matches = result.matches.flatMap((row: unknown) => {
      const name = row && typeof row === 'object' ? (row as { name?: unknown }).name : undefined;
      const entry = typeof name === 'string' && known.has(name) ? catalogEntry(name) : undefined;
      return entry ? [{ name: entry.name, description: entry.description }] : [];
    });
    return { mode: 'hybrid', degraded: false, matches: [...new Map(matches.map(hit => [hit.name, hit])).values()].slice(0, limit), page, unavailable: [] };
  } catch {
    return fallback('transport_unavailable');
  }
}
