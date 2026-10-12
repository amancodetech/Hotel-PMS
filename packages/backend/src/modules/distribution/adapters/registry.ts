import type { ChannelAdapter, ConnectionContext } from '@hotel/contracts';
import { UnknownProviderError, ValidationError } from '../domain/errors.js';
import type { AdapterResolver } from '../domain/ports.js';

export class ProviderRegistry implements AdapterResolver {
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor(adapters: readonly ChannelAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider_key))
        throw new ValidationError(
          `Duplicate adapter for provider ${adapter.provider_key}`,
        );
      this.adapters.set(adapter.provider_key, adapter);
    }
  }

  has(providerKey: string): boolean {
    return this.adapters.has(providerKey);
  }

  keys(): string[] {
    return [...this.adapters.keys()].sort();
  }

  resolve(providerKey: string): ChannelAdapter {
    const adapter = this.adapters.get(providerKey);
    if (!adapter) throw new UnknownProviderError(providerKey);
    return adapter;
  }

  resolveForContext(context: ConnectionContext): ChannelAdapter {
    const adapter = this.resolve(context.provider_key);
    if (context.adapter_version !== adapter.adapter_version)
      throw new ValidationError('Adapter version mismatch', {
        field: 'adapter_version',
      });
    return adapter;
  }
}
