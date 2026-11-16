// What the flock is saying. Callers always pair the glyph with a word: it is never the only signal.
export type FlockState = 'working' | 'quiet' | 'waiting' | 'landed' | 'failed' | 'idle'
export type FlockTone = 'accent' | 'neutral'
export type FlockSize = 'sm' | 'md' | 'lg' | 'xl'

// the most subagent dots a flock shows, however many are out
export const FLOCK_MAX_AGENTS = 3
