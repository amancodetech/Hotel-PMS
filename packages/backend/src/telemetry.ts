import { NodeSDK } from '@opentelemetry/sdk-node';

export function startTelemetry() {
  // No network exporter or request instrumentation before data policies are defined.
  const sdk = new NodeSDK({
    spanProcessors: [],
    logRecordProcessors: [],
    metricReaders: [],
    instrumentations: [],
    autoDetectResources: false,
    resourceDetectors: [],
    textMapPropagator: null,
  });
  sdk.start();
  return sdk;
}
