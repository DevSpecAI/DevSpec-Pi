// Deterministic actual-host fixture; no external model, credentials or live room data.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function (pi: any) {
  const root = process.env.HANDOFF_PROBE_ROOT!;
  const text = (m: any) => typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  pi.registerTool({ name: 'probe_hold', label: 'Probe hold', description: 'Deterministic harmless lifecycle latch.', parameters: Type.Object({ phase: Type.String() }), async execute(_id: string, { phase }: any, signal: AbortSignal) {
    writeFileSync(join(root, `${phase}-started`), 'ready');
    while (!existsSync(join(root, `${phase}-release`))) {
      if (signal?.aborted) throw new Error('Probe cancelled');
      await new Promise(r => setTimeout(r, 25));
    }
    return { content: [{ type: 'text', text: 'Latch released' }], details: undefined };
  }});
  let requests = 0;
  pi.registerProvider('handoff-probe', {
    baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'fixture-only',
    models: [{ id: 'scripted', name: 'Deterministic handoff probe', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model: any, context: any) {
      const local = context.messages.some((m: any) => m.role === 'user' && text(m).includes('LOCAL-FOLLOWUP'));
      const fairness = process.env.HANDOFF_PROBE_FAIRNESS === '1';
      const phase = local || fairness ? 'owner' : 'question';
      const done = fairness || existsSync(join(root, `${phase}-release`));
      appendFileSync(join(root, 'provider-metadata.jsonl'), JSON.stringify({ at: new Date().toISOString(), request: ++requests, phase, done }) + '\n');
      const message: any = { role: 'assistant', api: 'openai-completions', provider: 'handoff-probe', model: model.id, content: [], timestamp: Date.now(), stopReason: done ? 'stop' : 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        const reply = `PROBE-${phase}-${done ? 'finished' : 'working'}`;
        message.content.push({ type: 'text', text: reply });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: reply, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: reply, partial: message });
        if (!done) {
          const call = { type: 'toolCall', id: `hold-${requests}`, name: 'probe_hold', arguments: { phase } };
          message.content.push(call);
          stream.push({ type: 'toolcall_start', contentIndex: 1, partial: message });
          stream.push({ type: 'toolcall_delta', contentIndex: 1, delta: JSON.stringify(call.arguments), partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 1, toolCall: call, partial: message });
        }
        stream.push({ type: 'done', reason: done ? 'stop' : 'toolUse', message }); stream.end();
      });
      return stream;
    }
  });
}
