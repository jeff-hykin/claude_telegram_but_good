import { versionedImport } from "../../../lib/version.js"
await versionedImport("./p.js", import.meta)
export const s = 1
