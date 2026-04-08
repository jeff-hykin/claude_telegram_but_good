/**
 * Human-friendly session name generator.
 * Produces names like "swift-fox", "calm-river", "bold-star".
 */

const adjectives = [
    "bold", "bright", "calm", "cool", "crisp",
    "dark", "deep", "fair", "fast", "firm",
    "glad", "gold", "keen", "kind", "lean",
    "neat", "pale", "pure", "rare", "rich",
    "safe", "sage", "slim", "soft", "sure",
    "swift", "tall", "tame", "true", "warm",
    "wild", "wise", "zany", "blue", "red",
    "gray", "iron", "jade", "ruby", "amber",
]

const nouns = [
    "arc", "bay", "bee", "bird", "bolt",
    "cave", "claw", "crow", "dawn", "deer",
    "dove", "dune", "echo", "elm", "fawn",
    "fern", "fire", "fish", "fog", "fox",
    "gem", "glow", "hawk", "haze", "hill",
    "ice", "isle", "ivy", "jade", "jay",
    "lake", "leaf", "lion", "lynx", "mist",
    "moon", "moth", "oak", "owl", "peak",
    "pine", "pond", "rain", "reed", "reef",
    "ridge", "river", "rock", "rose", "sage",
    "seal", "snow", "star", "stone", "sun",
    "tide", "tree", "vale", "vine", "wave",
    "well", "wind", "wolf", "wren", "yard",
]

function pick(arr) {
    const i = crypto.getRandomValues(new Uint32Array(1))[0] % arr.length
    return arr[i]
}

export function generateName() {
    return `${pick(adjectives)}-${pick(nouns)}`
}

/**
 * Shell-embeddable name generator (for the claude shim script).
 * Returns a sh snippet that sets SESSION_ID to a random adj-noun name.
 */
export function shellNameGenerator() {
    // Inline a compact word list into the shell script
    const adjStr = adjectives.join(" ")
    const nounStr = nouns.join(" ")
    return `ADJS="${adjStr}"
NOUNS="${nounStr}"
pick() { set -- $1; shift $(( $(head -c 2 /dev/urandom | od -A n -t u2 | tr -d ' ') % $# )); echo "$1"; }
SESSION_ID="$(pick "$ADJS")-$(pick "$NOUNS")"`
}
