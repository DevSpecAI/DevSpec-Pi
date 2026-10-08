/**
 * Live host model snapshot for CONTROL list_models (item abbec798).
 *
 * The list is THIS process’s list right now — scopedModels if the session is
 * scoped, else auth-filtered getAvailable(). Never a DevSpec-owned menu.
 */

export interface ModelCatalogEntry {
	provider: string;
	id: string;
	name?: string;
}

export interface ModelCatalogSnapshot {
	v: 1;
	current: string | null;
	models: ModelCatalogEntry[];
	at: string;
	truncated?: boolean;
}

type ModelLike = {
	provider?: string;
	id?: string;
	name?: string;
};

export function collectModelCatalog(ctx: {
	scopedModels?: readonly { model?: ModelLike }[] | null;
	modelRegistry?: {
		getAvailable?: () => readonly ModelLike[];
		// Pi's Model is a subtype; we only read provider/id/name.
		hasConfiguredAuth?: (model: never) => boolean;
	} | null;
	model?: ModelLike | null;
	now?: string;
}): ModelCatalogSnapshot {
	const scoped = (ctx.scopedModels ?? [])
		.map((s) => s?.model)
		.filter((m): m is ModelLike => Boolean(m?.provider && m?.id));
	let raw: readonly ModelLike[];
	if (scoped.length > 0) raw = scoped;
	else {
		const available = ctx.modelRegistry?.getAvailable?.();
		if (!Array.isArray(available)) throw new Error("Host model registry unavailable");
		// Unknown auth state is a failed read, not proof that a provider has no models.
		raw = available.filter((m: ModelLike) => !ctx.modelRegistry?.hasConfiguredAuth || ctx.modelRegistry.hasConfiguredAuth(m as never));
	}

	const seen = new Set<string>();
	const models: ModelCatalogEntry[] = [];
	for (const m of raw) {
		const provider = typeof m.provider === "string" ? m.provider.trim() : "";
		const id = typeof m.id === "string" ? m.id.trim() : "";
		if (!provider || !id || (m.name !== undefined && typeof m.name !== "string")) throw new Error("Invalid host model catalogue entry");
		const key = `${provider}/${id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const name = typeof m.name === "string" ? m.name.trim() : "";
		models.push({
			provider,
			id,
			...(name && name !== id ? { name } : {}),
		});
	}

	const currentProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider.trim() : "";
	const currentId = typeof ctx.model?.id === "string" ? ctx.model.id.trim() : "";

	return {
		v: 1,
		current: currentProvider && currentId ? `${currentProvider}/${currentId}` : null,
		models,
		at: ctx.now ?? new Date().toISOString(),
	};
}
