# Legacy presence plugin (archived — pending deletion)

The original table-DB **cursor / focus / selection tracking** spike
(`window.ManifestDataPresence`), built from `data-presence/*` subscripts into
`manifest.appwrite.presence.js`, with `manifest.presence.css` for the cursor /
caret / selection / focus visuals.

Superseded by the split design (see `PRESENCE-COLLAB-DESIGN.md`):
- **status / roster** → `src/scripts/manifest.appwrite.presences.js` (`$presence`, native Appwrite Presences)
- **cursors / selection / co-editing** → future Cloudflare DO + CRDT collab layer

No longer built (removed from `src/scripts/build.mjs`) or loaded (removed from
`src/index.html`). Kept only as reference until the collab layer lands.
