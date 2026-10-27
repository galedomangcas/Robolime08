import { parseDeploymentTarget } from './deploymentTarget';

describe('deployment target (D48)', () => {
  it('defaults to the field build', () => {
    expect(parseDeploymentTarget(undefined)).toBe('field');
    expect(parseDeploymentTarget('')).toBe('field');
    expect(parseDeploymentTarget('  Field ')).toBe('field');
  });

  it('recognises the online build', () => {
    expect(parseDeploymentTarget('online')).toBe('online');
    expect(parseDeploymentTarget(' ONLINE')).toBe('online');
  });

  it('fails closed on anything else', () => {
    for (const value of ['cloud', 'prod', 'vercel', 'true', 'field,online']) {
      expect(parseDeploymentTarget(value)).toBe('invalid');
    }
  });
});
