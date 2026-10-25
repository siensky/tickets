/**
 * OpenTelemetry Node SDK bootstrap (docs/plan.md "Fasplan" Fas 4:
 * "OTel-instrumentering"). Must be started from a file preloaded via `node --import`,
 * before any other module in the process loads — see each service's src/instrumentation.ts.
 * A normal import from inside index.ts would run too late: by the time index.ts's own
 * body executes, sibling imports like @tickets/db (which pulls in `pg`) have already
 * been linked and evaluated, so the instrumentation would have nothing left to patch.
 *
 * Tempo (the trace backend) isn't wired in until after the VG requirements are secured
 * (docs/plan.md "Fasplan"). Until then, Alloy's OTLP receiver has spans arriving with
 * nowhere to forward them — the point of instrumenting now is that no service needs a
 * second pass once Tempo exists.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface Tracing {
  readonly shutdown: () => Promise<void>;
}

export function startTracing(serviceName: string): Tracing {
  const sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    ),
    traceExporter: new OTLPTraceExporter({
      url:
        process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ?? 'http://localhost:4318/v1/traces',
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Every local file read/write becomes a span otherwise — pure noise for a
        // service that never traces anything interesting through the filesystem.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
