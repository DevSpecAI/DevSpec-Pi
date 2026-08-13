/**
 * Wrap a server JSON Schema as a TypeBox TSchema.
 *
 * The catalog is generated from DevSpec's own MCP tool-definitions. Re-encoding
 * every property into Type.Object / StringEnum by hand is how this rots
 * (item 523f1512). Type.Unsafe keeps the server schema byte-faithful.
 */

import { Type, type TSchema } from "typebox";

export function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined): TSchema {
	if (!schema || typeof schema !== "object") {
		return Type.Object({});
	}
	return Type.Unsafe(schema);
}
