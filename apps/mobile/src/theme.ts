/** High-contrast palette for outdoor readability (all text colours ≥ 7:1 on background). */
export const colors = {
  background: '#FFFFFF',
  surface: '#F4F7F2',
  border: '#1F3A1A',
  brand: '#1F5F17',
  text: '#111111',
  mutedText: '#3D3D3D',
  /** Errors and stale warnings; always paired with a text label, never colour alone. */
  danger: '#9B1C1C',
  warningSurface: '#FFF4D6',
} as const;
