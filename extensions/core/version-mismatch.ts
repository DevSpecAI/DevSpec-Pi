/**
 * What Pi says when DevSpec and this extension no longer agree about something
 * (DevSpec item 39c05c1f). Customers update the extension when they choose, so a
 * newer DevSpec will regularly meet an older Pi. Whatever still matches keeps
 * working; whatever does not degrades on its own and says, in words the person can
 * act on, that updating the extension fixes it.
 */
export const UPDATE_EXTENSION_INSTRUCTION =
	"To fix this, update the DevSpec Pi extension: run `pi update --extensions`, then restart Pi.";
