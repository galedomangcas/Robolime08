import { render, screen } from '@testing-library/react-native';

import { LandingScreen } from './LandingScreen';

describe('LandingScreen', () => {
  it('shows an honest no-data state without any measured values', async () => {
    await render(<LandingScreen gatewayUrl={null} />);

    expect(screen.getByText('RoboLime')).toBeTruthy();
    expect(screen.getByText('No robot data yet')).toBeTruthy();
    expect(screen.getByText('Not configured')).toBeTruthy();
    expect(screen.queryByText(/pH\s*\d/)).toBeNull();
  });

  it('shows the configured gateway address', async () => {
    await render(<LandingScreen gatewayUrl="http://192.168.137.1:8080" />);

    expect(screen.getByText('http://192.168.137.1:8080')).toBeTruthy();
  });
});
