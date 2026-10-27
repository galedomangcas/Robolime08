/**
 * Design tokens taken from the Canva mockups (`ui reference/`, D50). Text
 * colours keep strong contrast for outdoor readability, and state colours are
 * always paired with a text label (never colour alone). The mockup's typeface
 * was not supplied as a font file, so the platform's system font is used: no
 * remote fonts.
 */
export const colors = {
  /** Page background (warm light grey-green). */
  background: '#EEF1EC',
  /** Cards and sheets. */
  surface: '#FFFFFF',
  /** Tiles inside cards, secondary buttons. */
  surfaceMuted: '#F1F3EF',
  border: '#DCE1D8',
  /** Primary actions and selected navigation. */
  brand: '#177A3B',
  /** Logo tile, progress-free accents, score bars. */
  brandBright: '#2EB85C',
  brandSoft: '#E3F2E7',
  /** Dark status strip and side navigation. */
  ink: '#151A14',
  inkRaised: '#232A22',
  text: '#141812',
  mutedText: '#4A5348',
  onDark: '#FFFFFF',
  onDarkMuted: '#B7C1B3',
  onDarkPositive: '#8BE3A8',
  /** Errors and stale warnings; always paired with a text label. */
  danger: '#9B2C16',
  dangerSoft: '#FCE4DD',
  warningSurface: '#FFF3DA',
  warningText: '#6B4100',
  syntheticSurface: '#FBE3C5',
  syntheticText: '#7A3F08',
  /** Decorative hero background (no data meaning). */
  heroDark: '#2B4722',
  heroStripe: '#36572C',
  info: '#2F6FD6',
  violet: '#6E4BD8',
  thermo: '#C8412A',
  /** pH gauge ends; the gauge shows a value against the confirmed target 6.00 only. */
  gaugeLow: '#C8412A',
  gaugeMid: '#E9A91F',
  gaugeHigh: '#3BAE5E',
} as const;

export const radius = { card: 20, tile: 14, button: 16, pill: 999 } as const;

/** Layout switches to the laptop (sidebar) design at this window width. */
export const WIDE_BREAKPOINT = 900;
