/**
 * The GitHub identity link at connect (ADR "Protecting intent" §14; server side
 * c45f75d4; Pi side 306fb64a). For a project whose repositories are on GitHub,
 * `register_connection` returns `github_identity`: `linked` with the person's
 * GitHub login(s), or `link_required` with one link to open. Linking is one
 * click through DevSpec's own GitHub App, identity only: DevSpec keeps no token.
 *
 * DevSpec builds the link and decides when to offer it. Pi only shows it to the
 * person at the terminal, because the person, not the model, opens it.
 */

/** What Pi shows the person when the link is needed, or null when nothing is. */
export function githubIdentityNotice(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const prompt = value as { status?: unknown; url?: unknown };
	if (prompt.status !== "link_required" || typeof prompt.url !== "string") return null;
	let url: URL;
	try {
		url = new URL(prompt.url);
	} catch {
		return null;
	}
	// Only a web link is offered to be opened; anything else is not shown.
	if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) return null;
	return `DevSpec: this project's repositories are on GitHub. Link your GitHub account so your pull requests and commits show as yours. GitHub confirms who you are, and DevSpec keeps no access to your account: ${url.toString()}`;
}
