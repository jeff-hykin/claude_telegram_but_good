import { versionedImport } from "../../../lib/version.js"

const { onboard } = await versionedImport("../../../lib/onboard.js", import.meta)

export async function runOnboard(_args) {
    await onboard()
}
