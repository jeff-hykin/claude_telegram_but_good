import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { getConfig, setConfig, getConfigKey, parseCliValue },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/config-manager.js", import.meta),
])
const c = colors

export function runConfig(args) {
    if (args.length === 0) {
        const config = getConfig()
        if (Object.keys(config).length === 0) {
            console.log(c.dim("  # No config set yet. Use: ") + c.white("cbg config <key> <value>"))
        } else {
            console.log(JSON.stringify(config, null, 2))
        }
    } else if (args.length === 1) {
        const val = getConfigKey(args[0], undefined)
        if (val === undefined) {
            console.log(c.dim("(not set)"))
        } else {
            console.log(typeof val === "object" ? JSON.stringify(val) : String(val))
        }
    } else {
        const key = args[0]
        const parsed = parseCliValue(args.slice(1).join(" "))
        setConfig({ [key]: parsed })
        console.log(c.green("  \u2714 Set ") + c.white(key))
    }
}
