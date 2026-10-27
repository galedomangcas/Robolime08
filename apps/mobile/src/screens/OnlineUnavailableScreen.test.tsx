import { render, screen } from '@testing-library/react-native';

import { OnlineUnavailableScreen } from './OnlineUnavailableScreen';

const allText = () => JSON.stringify(screen.toJSON());

describe('OnlineUnavailableScreen (D48)', () => {
  const realFetch = globalThis.fetch;
  const fetchSpy = jest.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('tells online visitors that online access is not available, without data or requests', async () => {
    await render(<OnlineUnavailableScreen reason="online" />);
    expect(screen.getByText('Online access is not available yet')).toBeTruthy();
    expect(screen.getByText('No robot or field data is shown here.')).toBeTruthy();
    // Never implies a reachable field gateway, never offers pairing, never shows values.
    expect(allText()).not.toMatch(/Pair this device|gateway connected|Latest report|\bpH\s*\d|\d+(\.\d+)?\s*(mL|V)\b/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('explains a misconfigured build instead of guessing a target', async () => {
    await render(<OnlineUnavailableScreen reason="invalid" />);
    expect(screen.getByText('This build is misconfigured')).toBeTruthy();
    expect(screen.getByText(/EXPO_PUBLIC_ROBOLIME_TARGET must be "field" or "online"/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
