import { versionedImport } from "../../../lib/version.js"

const { authorize } = await versionedImport("../helpers.js", import.meta)

export async function runAuthorize(_args) {
    await authorize()
}
