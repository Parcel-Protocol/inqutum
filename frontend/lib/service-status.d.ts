export type ServiceState = 'operational' | 'degraded' | 'unavailable' | 'unknown';

export interface ServiceFeature {
  capability: string;
  label: string;
  state: ServiceState;
  message: string;
  retryAfterSeconds: number | null;
}

export interface ServiceStatus {
  overall: ServiceState;
  summary: string;
  stale: boolean;
  features: ServiceFeature[];
}

export interface ServiceStatusNotice {
  severity: 'degraded' | 'unavailable';
  title: string;
  summary: string;
  stale: boolean;
  retryAfterSeconds: number | null;
  issues: Array<Pick<ServiceFeature, 'capability' | 'label' | 'state' | 'message'>>;
}

export declare function parseServiceStatus(payload: unknown): ServiceStatus | null;
export declare function describeServiceStatus(status: ServiceStatus | null): ServiceStatusNotice | null;
export declare function capabilityBlocked(
  status: ServiceStatus | null,
  capability: string
): { blocked: boolean; message: string };
export declare function formatRetryAfter(seconds: number | null | undefined): string;
