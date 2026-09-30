import { TOOL_CATALOG_VERSION, MCP_CATALOG_FINGERPRINT } from '../generated/mcp-catalog.ts';
import { catalogEntry, exactModelToolNames, searchRareModelTools, TOOL_LOADER_NAME } from './model-surface.ts';

export interface SelectionResult {
  mode: 'exact' | 'hybrid' | 'lexical';
  degraded: boolean;
  reason?: string;
  matches: Array<{ name: string; description: string }>;
  unavailable: string[];
}

/** Never activates or executes a tool. Responses can only recommend locally
 * registered, currently callable names, using this installation's own guidance.
 */
export async function selectTools(query: string, limit: number, activeNames: readonly string[], request: (args: Record<string, unknown>) => Promise<unknown>): Promise<SelectionResult> {
  const available = activeNames.filter(name => name !== TOOL_LOADER_NAME && catalogEntry(name)?.kind === 'model');
  const known = new Set(available);
  const exact = exactModelToolNames(query);
  const local = () => searchRareModelTools(query, limit, available).map(entry => ({ name: entry.name, description: entry.description }));
  if (exact) return { mode: 'exact', degraded: false, matches: local(), unavailable: exact.filter(name => !known.has(name)) };
  try {
    const raw = await request({ query, limit, available_tools: available, catalog_version: TOOL_CATALOG_VERSION, schema_fingerprint: MCP_CATALOG_FINGERPRINT });
    const result = raw as { catalog_version?: unknown; mode?: unknown; degraded?: unknown; reason?: unknown; matches?: unknown } | null;
    if (!result || result.catalog_version !== TOOL_CATALOG_VERSION || result.degraded !== false || result.mode !== 'hybrid' || !Array.isArray(result.matches) || result.matches.some(row => !row || typeof row !== 'object' || typeof (row as { name?: unknown }).name !== 'string')) {
      return { mode: 'lexical', degraded: true, reason: 'Semantic search unavailable or catalogue versions differ; using local keyword search.', matches: local(), unavailable: [] };
    }
    const matches = result.matches.flatMap((row: unknown) => {
      const name = row && typeof row === 'object' ? (row as { name?: unknown }).name : undefined;
      const entry = typeof name === 'string' && known.has(name) ? catalogEntry(name) : undefined;
      return entry ? [{ name: entry.name, description: entry.promptSnippet }] : [];
    });
    return { mode: 'hybrid', degraded: false, matches: [...new Map(matches.map(hit => [hit.name, hit])).values()].slice(0, limit), unavailable: [] };
  } catch {
    return { mode: 'lexical', degraded: true, reason: 'Semantic search unavailable; using local keyword search. Direct tools remain usable.', matches: local(), unavailable: [] };
  }
}
