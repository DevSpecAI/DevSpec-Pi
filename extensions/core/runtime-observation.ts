/** Native-only runtime observation DTO. Never model instructions or authority. */
export type ForegroundSample = { sample_sequence: number } & (
	| { state: "idle" | "unknown" }
	| { state: "active"; execution_id: string; revision: number; kind: "owner" | "interaction" | "system_notice" }
);
export interface BackgroundSample {
	state: "active" | "idle" | "unknown";
	sample_sequence: number;
}
export interface RuntimeObservationFrame {
	version: 1;
	instance_id: string;
	sequence: number;
	attachment_id: string;
	foreground: ForegroundSample;
	background: BackgroundSample;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validCounter = (value: number) => Number.isSafeInteger(value) && value > 0;

function foregroundSample(value: ForegroundSample): ForegroundSample {
	if (!value || !validCounter(value.sample_sequence)) throw new Error("Invalid foreground observation sequence.");
	if (value.state === "idle" || value.state === "unknown") return { state: value.state, sample_sequence: value.sample_sequence };
	if (value.state !== "active" || typeof value.execution_id !== "string" || !UUID.test(value.execution_id) || !validCounter(value.revision) ||
		!["owner", "interaction", "system_notice"].includes(value.kind)) throw new Error("Invalid foreground observation.");
	return { state: "active", sample_sequence: value.sample_sequence, execution_id: value.execution_id.toLowerCase(), revision: value.revision, kind: value.kind };
}
function backgroundSample(value: BackgroundSample): BackgroundSample {
	if (!value || !validCounter(value.sample_sequence) || !["active", "idle", "unknown"].includes(value.state)) throw new Error("Invalid background observation.");
	return { state: value.state, sample_sequence: value.sample_sequence };
}

/**
 * The native foreground sampler and public background adapter own their sample
 * sequences. This assembler must NEVER re-number a cached sample to make it
 * fresh. Delivery/retry reads of frame() return the same immutable publication.
 * Make a new instance only for an explicitly registered instance/attachment.
 */
export class RuntimeObservationFrames {
	private readonly instanceId: string;
	private readonly attachmentId: string;
	private foreground: ForegroundSample | null = null;
	private background: BackgroundSample | null = null;
	private lastFrame: RuntimeObservationFrame | null = null;
	private nextSequence = 1;
	private dirty = false;
	private disposed = false;

	constructor(instanceId: string, attachmentId: string) {
		if (typeof instanceId !== "string" || typeof attachmentId !== "string" || !UUID.test(instanceId) || !UUID.test(attachmentId)) throw new Error("Runtime observations require registered UUID identities.");
		this.instanceId = instanceId.toLowerCase();
		this.attachmentId = attachmentId.toLowerCase();
	}

	observeForeground(value: ForegroundSample): boolean {
		if (this.disposed) return false;
		const next = foregroundSample(value);
		if (!this.accepts(this.foreground, next)) return false;
		this.foreground = next;
		this.dirty = true;
		return true;
	}

	observeBackground(value: BackgroundSample): boolean {
		if (this.disposed) return false;
		const next = backgroundSample(value);
		if (!this.accepts(this.background, next)) return false;
		this.background = next;
		this.dirty = true;
		return true;
	}

	frame(): RuntimeObservationFrame | null {
		if (this.disposed || !this.foreground || !this.background) return null;
		if (!this.dirty) return this.lastFrame;
		if (!validCounter(this.nextSequence)) throw new Error("Runtime publication sequence exhausted.");
		this.lastFrame = Object.freeze({
			version: 1 as const, instance_id: this.instanceId, sequence: this.nextSequence++, attachment_id: this.attachmentId,
			foreground: Object.freeze({ ...this.foreground }), background: Object.freeze({ ...this.background }),
		});
		this.dirty = false;
		return this.lastFrame;
	}

	dispose(): void {
		this.disposed = true;
		this.foreground = null;
		this.background = null;
		this.lastFrame = null;
	}

	private accepts(previous: ForegroundSample | BackgroundSample | null, next: ForegroundSample | BackgroundSample): boolean {
		if (!previous) return true;
		if (next.sample_sequence < previous.sample_sequence) return false;
		if (next.sample_sequence === previous.sample_sequence) {
			if (JSON.stringify(next) !== JSON.stringify(previous)) throw new Error("Runtime sample identity was reused with changed contents.");
			return false;
		}
		return true;
	}
}
