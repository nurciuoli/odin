// Elder Futhark strokes in a 24 x 32 box, drawn as SVG paths so they render without a runic font.
export const runePaths: Record<string, string> = {
  fehu: 'M6 30V2 M6 10L18 2 M6 18L18 10',
  thurs: 'M6 30V2 M6 8L18 16L6 24',
  raido: 'M6 30V2L18 9L6 16L18 30',
  kaun: 'M18 6L6 16L18 26',
  gebo: 'M5 4L19 28 M19 4L5 28',
  wunjo: 'M6 30V2L18 9L6 16',
  isa: 'M12 2V30',
  algiz: 'M12 30V2 M12 14L4 4 M12 14L20 4',
  sowilo: 'M16 2L8 12L16 20L8 30',
  tiwaz: 'M12 30V2 M12 2L4 12 M12 2L20 12',
  berkano: 'M6 30V2L16 9L6 16L18 23L6 30',
  ehwaz: 'M6 30V2 M18 30V2 M6 2L12 12L18 2',
  mannaz: 'M6 30V2 M18 30V2 M6 2L18 16 M18 2L6 16',
  laguz: 'M8 30V2 M8 2L18 10',
  dagaz: 'M6 4V28 M18 4V28 M6 4L18 28 M18 4L6 28',
  othala: 'M12 2L4 10L12 18L20 10Z M4 29L12 18L20 29',
}

/** One rune per tool, so a run of tool calls reads as a line of rune stones. */
export const toolRune: Record<string, keyof typeof runePaths> = {
  Read: 'raido',
  Search: 'kaun',
  Glob: 'laguz',
  Edit: 'tiwaz',
  Write: 'fehu',
  Bash: 'berkano',
  Test: 'algiz',
  Think: 'mannaz',
}
