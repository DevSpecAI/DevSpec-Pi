/** Host-only staging test controls; ordinary speech still uses the real writer. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import controlledProvider from './active-question-delivery-fixture.ts';
import { getBond } from '../extensions/core/bond-state.ts';
import { resolveToken } from '../extensions/core/auth-store.ts';
import { callDevspec } from '../extensions/core/client.ts';
import { unwrapMcpResult } from '../extensions/core/result.ts';
import { INTERACTION_EVENT_CUSTOM_TYPE, QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE } from '../extensions/core/interaction-events.ts';

export default function (pi: ExtensionAPI) {
	controlledProvider(pi);
	const root = process.env.HANDOFF_PROBE_ROOT!;
	const requestId = randomUUID();
	pi.registerCommand('probe-live-status', {
		description: 'Capture non-secret metadata for this disposable test',
		handler: async (_args, ctx) => {
			const bond = getBond();
			writeFileSync(join(root, 'live-status.json'), JSON.stringify({ connectionId: bond?.connectionId,
				sessionId: bond?.sessionId, codename: bond?.codename, nativeSessionId: ctx.sessionManager.getSessionId(),
				mode: ctx.mode, idle: ctx.isIdle() }), { mode: 0o600 });
		},
	});
	pi.registerCommand('probe-live-question', {
		description: 'Create the harmless controlled test question in the attached disposable room',
		handler: async (_args, ctx) => {
			const bond = getBond(); const auth = await resolveToken();
			if (!auth || !bond?.sessionId || !bond.connectionCapability) throw new Error('Probe is not attached');
			const raw = await callDevspec(auth.token, 'manage_directed_question', {
				connection_id: bond.connectionId, action: 'create', client_request_id: requestId,
				response_kind: 'single_select', prompt: 'Controlled staging verification: start the harmless temporary foreground and background jobs?',
				options: ['Run controlled probe', 'Leave paused'], allow_custom: false, keep_turn: false,
			}, { cwd: ctx.cwd, lane: 'pump', connectionCapability: bond.connectionCapability });
			const result = unwrapMcpResult(raw); const question = (result.details as any)?.question;
			if (result.isError || !question?.id) throw new Error('Test question was not confirmed');
			writeFileSync(join(root, 'question.json'), JSON.stringify({ id: question.id, revision: question.revision }), { mode: 0o600 });
		},
	});
	pi.registerCommand('probe-live-end', {
		description: 'End only this disposable test connection and confirm the response',
		handler: async (_args, ctx) => {
			const bond = getBond(); const auth = await resolveToken();
			if (!auth || !bond?.connectionId || bond.sessionId !== process.env.HANDOFF_LIVE_SESSION) throw new Error('Test attachment changed; refusing cleanup');
			const result = unwrapMcpResult(await callDevspec(auth.token, 'heartbeat_connection', {
				connection_id: bond.connectionId, status: 'offline', end_reason: 'local_stop', busy: false,
			}, { cwd: ctx.cwd, lane: 'pump', connectionCapability: bond.connectionCapability }));
			const details = result.details as any;
			if (result.isError || details?.live !== false) throw new Error('Test disconnect was not confirmed');
			writeFileSync(join(root, 'stopped.json'), JSON.stringify({ connectionId: bond.connectionId, status: details.status }), { mode: 0o600 });
		},
	});
	pi.on('message_start', event => {
		const message = event.message as any;
		if (message.customType === QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE) writeFileSync(join(root, 'question-release'), 'dismissed');
		if (message.customType !== INTERACTION_EVENT_CUSTOM_TYPE) return;
		const answer = message.details?.event?.answer;
		const approved = answer === 'Run controlled probe' || (Array.isArray(answer) && answer.length === 1 && answer[0] === 'Run controlled probe');
		if (!approved) writeFileSync(join(root, 'question-release'), 'not approved');
	});
}
