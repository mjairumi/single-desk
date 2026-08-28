// Runtime config for the extension. API base is user-editable in options.
export const DEFAULTS = {
  apiBase: "https://YOUR-DOMAIN.com",   // e.g. https://signal-desk-api.onrender.com
  managedRootName: "Signal Desk",       // the bookmark folder we own and mirror
  // Buckets mirrored to Chrome bookmark folders. Archive is intentionally NOT
  // mirrored (it's a hospice — see docs/EXTENSION.md).
  mirroredBuckets: ["inbox", "library", "rounds", "queue", "explore"],
  syncIntervalMin: 2,
};

export async function getConfig() {
  const stored = await chrome.storage.local.get("config");
  return { ...DEFAULTS, ...(stored.config || {}) };
}

export async function setConfig(patch) {
  const cfg = await getConfig();
  const next = { ...cfg, ...patch };
  await chrome.storage.local.set({ config: next });
  return next;
}
