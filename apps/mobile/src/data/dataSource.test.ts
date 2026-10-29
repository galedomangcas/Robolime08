import { createGatewayClient, type FetchLike } from './gatewayClient';
import { createLocalGatewayDataSource } from './dataSource';

describe('local gateway data source', () => {
  it('exposes read methods only (observe-only; no command, settings or dosing path)', () => {
    const fetch: FetchLike = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' });
    const source = createLocalGatewayDataSource(createGatewayClient({ baseUrl: '', fetch }));
    expect(source.kind).toBe('local-gateway');
    expect(Object.keys(source).sort()).toEqual(['description', 'exports', 'field', 'kind', 'robotStatus', 'runReadings', 'runRecommendation', 'runs', 'selectField', 'sourceName']);
  });
});
