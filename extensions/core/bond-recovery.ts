import type { RemoteConnectionIdentity } from "./remote-payload.ts";

export interface PumpAuthorityIdentity {
	generation: number;
	connectionId: string;
}

/** Immutable authority captured before an awaited connection-scoped operation. */
export function capturePumpAuthority(input: PumpAuthorityIdentity): PumpAuthorityIdentity {
	return { generation: input.generation, connectionId: input.connectionId };
}

/** A delayed write may commit only while both pump generation and connection match. */
export function isPumpAuthorityCurrent(
	captured: PumpAuthorityIdentity,
	current: PumpAuthorityIdentity,
): boolean {
	return captured.generation === current.generation && captured.connectionId === current.connectionId;
}

export interface RecoveredConnectionScopeInput {
	currentConnectionId: string;
	nextConnectionId: string;
	generation: number;
	nextGeneration: number;
	cursor?: string;
	dispatchCursor?: string;
	systemNoticeCursor?: string;
	synced: boolean;
	agentName: string;
	codename?: string;
}

export interface RecoveredConnectionScope {
	changedConnection: boolean;
	generation: number;
	cursor?: string;
	dispatchCursor?: string;
	systemNoticeCursor?: string;
	synced: boolean;
	connectionIdentity: RemoteConnectionIdentity;
}

/**
 * Plan the connection-scoped state transition for a recovered bond.
 * Same-row revival preserves exactly-once clocks. A replacement row starts with
 * fresh clocks and exact addressee identity; caller rekeys notice memory.
 */
export function planRecoveredConnectionScope(input: RecoveredConnectionScopeInput): RecoveredConnectionScope {
	const changedConnection = input.currentConnectionId !== input.nextConnectionId;
	return {
		changedConnection,
		generation: changedConnection ? input.nextGeneration : input.generation,
		...(changedConnection || !input.cursor ? {} : { cursor: input.cursor }),
		...(changedConnection || !input.dispatchCursor ? {} : { dispatchCursor: input.dispatchCursor }),
		...(changedConnection || !input.systemNoticeCursor ? {} : { systemNoticeCursor: input.systemNoticeCursor }),
		synced: changedConnection ? false : input.synced,
		connectionIdentity: {
			connection_id: input.nextConnectionId,
			agent_name: input.agentName,
			codename: input.codename ?? null,
			label: input.codename ? `${input.agentName} · ${input.codename}` : input.agentName,
		},
	};
}
