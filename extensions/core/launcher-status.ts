/** Customer-facing status, without exposing paths, command lines or raw OS errors. */
export interface LauncherResult {
	ok?: boolean;
	outcome?: string;
	error?: string;
	disabled?: boolean;
	disabledByEnvironment?: boolean;
	installation?: LauncherResult | null;
	status?: string;
	version?: string;
}
export function launcherStatusMessage(result: LauncherResult): string {
	const error = result.installation?.error ?? result.error;
	if (error === "service_stop_or_removal_failed") return "The launcher could not be stopped or removed. Check your device's service permissions; it may still be running.";
	if (result.disabledByEnvironment) return "Automatic launcher setup is disabled by DEVSPEC_LAUNCHER_DISABLED. Remove that environment setting to enable setup. Copy commands still work.";
	if (result.disabled || result.outcome === "disabled" || result.status === "disabled") return "Local launching is disabled. Copy commands still work. Use /devspec.launcher enable to turn it on.";
	if (result.status === "integration_removed") return "Local launching has been unregistered. Saved folder choices are kept, and Copy commands still work.";
	if (result.ok) return "The local launcher is ready. This checks the launcher, not whether a coding agent has opened.";
	if (result.outcome === "busy") return "Another agent is setting up local launching. Try /devspec.launcher status shortly; Copy commands remain available.";
	if (error === "account_not_paired" || error === "account_verification_failed") return "Connect this plugin to the same DevSpec account you use in the browser, then try /devspec.launcher repair. Copy commands still work.";
	if (error === "node_required") return "Local launching needs Node.js 20 or newer. Install or update Node, then use /devspec.launcher repair. Copy commands still work.";
	if (error === "port_in_use" || error === "incompatible_listener") return "Another program is using the launcher's local port. Nothing was stopped. Copy commands remain available.";
	if (error === "os_registration_failed") return "Your operating system did not accept local-launch setup. Check your device's application permissions or contact your administrator. Copy commands still work.";
	if (error === "service_not_ready" || error === "different_release") return "The local launcher is not running the expected version. Try /devspec.launcher repair. Copy commands still work.";
	return "Local launching is unavailable. Update the DevSpec plugin, then try /devspec.launcher repair. Copy commands still work.";
}
