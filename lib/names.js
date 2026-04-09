/**
 * Human-friendly session name generator.
 * Produces names like "swiftFox", "calmRiver", "boldStar".
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
    const noun = pick(nouns)
    return `${pick(adjectives)}${noun[0].toUpperCase()}${noun.slice(1)}`
}
