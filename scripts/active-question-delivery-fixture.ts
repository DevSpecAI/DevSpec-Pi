/** Actual-TUI controlled provider/tools. No external model or real work. */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
	const root = process.env.HANDOFF_PROBE_ROOT!;
	const background = process.env.HANDOFF_PROBE_BACKGROUND === '1';
	let requests = 0;
	pi.on('session_start', (_event, ctx) => {
		writeFileSync(join(root, 'tui-ready.json'), JSON.stringify({ mode: ctx.mode,
			nativeSessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, pid: process.pid }), { mode: 0o600 });
	});
	pi.registerTool({ name: 'probe_hold', label: 'Probe hold', description: 'Harmless controlled foreground latch.',
		parameters: Type.Object({ phase: Type.String() }), async execute(_id, { phase }, signal) {
			writeFileSync(join(root, `${phase}-started`), 'ready');
			if (phase === 'question' && process.env.HANDOFF_PROBE_PERMANENT_STALL === '1') {
				// Fault injection by construction, not a silence-based hang diagnosis.
				while (!signal?.aborted) await new Promise(resolve => setTimeout(resolve, 25));
				writeFileSync(join(root, 'injected-permanent-stall'), 'abort observed; controlled tool will never resolve');
				await new Promise<never>(() => {});
			}
			while (!existsSync(join(root, `${phase}-release`))) {
				if (signal?.aborted && process.env.HANDOFF_PROBE_IGNORE_ABORT !== '1') throw new Error('Probe cancelled');
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			return { content: [{ type: 'text', text: 'Latch released' }], details: undefined };
		},
	});
	pi.registerProvider('handoff-probe', {
		baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'fixture-only',
		models: [{ id: 'scripted', name: 'Deterministic question delivery probe', reasoning: false, input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context) {
			if (++requests > 5) throw new Error('Unexpected model continuation');
			const local = context.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('LOCAL-FOLLOWUP'));
			const phase = local ? 'owner' : 'question';
			const done = existsSync(join(root, `${phase}-release`));
			appendFileSync(join(root, 'provider-metadata.jsonl'), JSON.stringify({ at: new Date().toISOString(), request: requests, phase, done }) + '\n');
			const message: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: 'handoff-probe', model: model.id,
				content: [], timestamp: Date.now(), stopReason: done ? 'stop' : 'toolUse',
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: 'start', partial: message });
				const text = `PROBE-${phase}-${done ? 'finished' : 'working'}`;
				message.content.push({ type: 'text', text });
				stream.push({ type: 'text_start', contentIndex: 0, partial: message });
				stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
				stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
				const call = (name: string, args: Record<string, unknown>) => {
					const index = message.content.length;
					const tool = { type: 'toolCall' as const, id: `probe-${requests}-${index}`, name, arguments: args };
					message.content.push(tool);
					stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
					stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(args), partial: message });
					stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: tool, partial: message });
				};
				if (!done) {
					if (background && phase === 'question' && !context.messages.some(message => message.role === 'toolResult' && message.toolName === 'bg_run')) {
						for (const index of [0, 1]) call('bg_run', { name: `Question probe job ${index}`, isAgent: false, notifyOnCompletion: false, triggerOnCompletion: false,
							command: `node -e 'const fs=require("node:fs");const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t)},25)' '${join(root, `bg-${index}-release`)}'` });
					}
					call('probe_hold', { phase });
				}
				stream.push({ type: 'done', reason: done ? 'stop' : 'toolUse', message }); stream.end();
			});
			return stream;
		},
	});
}
