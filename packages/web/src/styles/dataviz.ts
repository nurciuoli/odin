// Locked data-viz picks (Data viz.dc.html: A2 categorical, B3 gain/loss, C1+C2 ramps).
// Mirrors the --iu-viz-* custom properties in tokens.css for JS consumers (canvas/SVG charts).
export const vizCategorical = [
  '#E07B4A',
  '#3FC2AD',
  '#7B8EF0',
  '#D9B02A',
  '#EF6F96',
  '#4FB6E8',
] as const

export const vizGain = '#6FAE8E'
export const vizLoss = '#D4705F'

// Sequential · ember (C1) — anchored in the ground colour so light cells recede into the card
export const vizSequential = [
  '#221710',
  '#3D2617',
  '#5C361C',
  '#7D4822',
  '#9E5B29',
  '#BF7039',
  '#DC8A56',
  '#F0AB7E',
] as const

// Diverging · rose ↔ sky (C2) — neutral midpoint is the hairline colour
export const vizDiverging = [
  '#8F4257',
  '#B45C74',
  '#D47A92',
  '#E0A7B6',
  '#272724',
  '#A3CCDD',
  '#6FB0CF',
  '#4A8AA9',
] as const

export const vizGrid = '#272724'
export const vizZeroLine = '#373631'
export const vizAxisLabel = '#96948C'
