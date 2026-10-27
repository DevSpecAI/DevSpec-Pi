import type { BondState } from './bond-state.ts';
import { repositoryContextMessage } from './repository-context.ts';

const fields = ['owner_custom_instructions', 'owner_agent_rules', 'project_custom_instructions', 'project_agent_rules'] as const;
/** Absent means unchanged; null explicitly clears. Never adopt another project's context. */
export function applyConnectionContext(bond: BondState, value: unknown): BondState {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return bond;
	const payload = value as Record<string, unknown>;
	if (typeof payload.project_id === 'string' && bond.projectId && payload.project_id !== bond.projectId) throw new Error('Connection context belongs to a different project.');
	const instructions = { ...bond.instructions };
	if (payload.instructions_unchanged !== true) for (const key of fields) {
		if (payload[key] === null) delete instructions[key];
		else if (typeof payload[key] === 'string') instructions[key] = payload[key];
	}
	return { ...bond, instructions,
		...(bond.projectId && Object.hasOwn(payload, 'repository_context') ? {
			repositoryContext: repositoryContextMessage(payload.repository_context, bond.projectId, bond.projectName),
		} : {}),
	};
}

export const INSTRUCTION_CONTEXT_MESSAGE = 'devspec-instruction-context';
/** Full immutable rule snapshot. Changes append at the tail, never rewrite the system prefix. */
export function instructionContextMessage(bond: BondState): string {
	const instructions = Object.fromEntries(fields.filter(key => key !== 'owner_custom_instructions').map(key => [key,bond.instructions?.[key] ?? null]));
	const json = JSON.stringify({project_id:bond.projectId ?? null,...instructions},null,2).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
	return `DevSpec project and owner instruction snapshot. This replaces earlier values of these fields for this project; null means no instruction in that field. Authority and precedence remain defined by devspec://product/implementation-contract.\n<devspec-instruction-tiers>\n${json}\n</devspec-instruction-tiers>`;
}
