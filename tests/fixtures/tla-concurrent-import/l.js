import { versionedImport } from "../../../lib/version.js"
await versionedImport("./p.js", import.meta)
await versionedImport("./s.js", import.meta)
export const l = 1
