import type { ChannelAdapter, ConnectionContext } from '@hotel/contracts';

export interface AdapterResolver {
  resolve(providerKey: string): ChannelAdapter;
  resolveForContext(context: ConnectionContext): ChannelAdapter;
}
