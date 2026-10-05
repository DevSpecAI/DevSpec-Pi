import { TOOL_CATALOG_VERSION, MCP_CATALOG_FINGERPRINT } from '../generated/mcp-catalog.ts';
import { catalogEntry, exactModelToolNames, rankRareModelTools, TOOL_LOADER_NAME, toolSearchLimit, toolSearchPage, type ToolSearchPage } from './model-surface.ts';

export interface SelectionResult {
  mode: 'exact' | 'hybrid' | 'lexical';
  degraded: boolean;
  reason?: string;
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
  if (exact) return { mode: 'exact', degraded: false, ...local(), unavailable: exact.filter(name => !known.has(name)) };
  try {
    const raw = await request({ query, limit, offset, available_tools: available, catalog_version: TOOL_CATALOG_VERSION, schema_fingerprint: MCP_CATALOG_FINGERPRINT });
    const result = raw as { catalog_version?: unknown; mode?: unknown; degraded?: unknown; reason?: unknown; matches?: unknown; page?: unknown } | null;
    const page = serverPage(result?.page);
    if (!result || !page || result.catalog_version !== TOOL_CATALOG_VERSION || result.degraded !== false || result.mode !== 'hybrid' || !Array.isArray(result.matches) || result.matches.some(row => !row || typeof row !== 'object' || typeof (row as { name?: unknown }).name !== 'string')) {
      return { mode: 'lexical', degraded: true, reason: 'Semantic search unavailable or catalogue versions differ; using local keyword search.', ...local(), unavailable: [] };
    }
    const matches = result.matches.flatMap((row: unknown) => {
      const name = row && typeof row === 'object' ? (row as { name?: unknown }).name : undefined;
      const entry = typeof name === 'string' && known.has(name) ? catalogEntry(name) : undefined;
      return entry ? [{ name: entry.name, description: entry.description }] : [];
    });
    return { mode: 'hybrid', degraded: false, matches: [...new Map(matches.map(hit => [hit.name, hit])).values()].slice(0, limit), page, unavailable: [] };
  } catch {
    return { mode: 'lexical', degraded: true, reason: 'Semantic search unavailable; using local keyword search. Direct tools remain usable.', ...local(), unavailable: [] };
  }
}
