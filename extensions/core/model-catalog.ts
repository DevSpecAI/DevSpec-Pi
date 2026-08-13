/**
 * Live host model snapshot for CONTROL list_models (item abbec798).
 *
 * The list is THIS process’s list right now — scopedModels if the session is
 * scoped, else auth-filtered getAvailable(). Never a DevSpec-owned menu.
 */

export const MODEL_CATALOG_MAX = 400;

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
	const raw =
		scoped.length > 0
			? scoped
			: (ctx.modelRegistry?.getAvailable?.() ?? []).filter((m) => {
					if (!ctx.modelRegistry?.hasConfiguredAuth) return true;
					try {
						return ctx.modelRegistry.hasConfiguredAuth(m as never);
					} catch {
						return false;
					}
				});

	const seen = new Set<string>();
	const models: ModelCatalogEntry[] = [];
	for (const m of raw) {
		const provider = typeof m.provider === "string" ? m.provider.trim() : "";
		const id = typeof m.id === "string" ? m.id.trim() : "";
		if (!provider || !id) continue;
		const key = `${provider}/${id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const name = typeof m.name === "string" ? m.name.trim() : "";
		models.push({
			provider,
			id,
			...(name && name !== id ? { name } : {}),
		});
		if (models.length >= MODEL_CATALOG_MAX) break;
	}

	const currentProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider.trim() : "";
	const currentId = typeof ctx.model?.id === "string" ? ctx.model.id.trim() : "";

	return {
		v: 1,
		current: currentProvider && currentId ? `${currentProvider}/${currentId}` : null,
		models,
		at: ctx.now ?? new Date().toISOString(),
		...(raw.length > models.length ? { truncated: true } : {}),
	};
}
