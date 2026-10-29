import { createGatewayClient, type FetchLike } from './gatewayClient';
import { createLocalGatewayDataSource } from './dataSource';

describe('local gateway data source', () => {
  it('exposes read methods plus manual control only (D57; no run start, settings or dosing-run path)', () => {
    const fetch: FetchLike = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' });
    const source = createLocalGatewayDataSource(createGatewayClient({ baseUrl: '', fetch }));
    expect(source.kind).toBe('local-gateway');
    expect(Object.keys(source).sort()).toEqual(['description', 'exports', 'field', 'kind', 'manualControl', 'robotStatus', 'runReadings', 'runRecommendation', 'runs', 'selectField', 'sourceName']);
    expect(Object.keys(source.manualControl ?? {}).sort()).toEqual(['send', 'status']);
  });
});
