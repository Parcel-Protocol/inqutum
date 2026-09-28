export type AdapterCode =
  | 'ADAPTER_SUCCESS'
  | 'ADAPTER_INVALID_CONFIG'
  | 'ADAPTER_NOT_SUPPORTED'
  | 'ADAPTER_UNAVAILABLE';

export type AdapterResult<T> =
  | { ok: true; code: 'ADAPTER_SUCCESS'; data: T }
  | { ok: false; code: Exclude<AdapterCode, 'ADAPTER_SUCCESS'>; message: string; recoverable: boolean };

export interface AdapterConfig {
  type: string;
  endpoint?: string;
  timeout?: number;
}

export interface AdapterProvider {
  isAvailable(): Promise<boolean>;
  execute<T>(operation: string, payload: unknown): Promise<T>;
}

const supportedAdapters = new Set(['http', 'memory', 'database']);

export async function createAdapter(config: AdapterConfig): Promise<AdapterResult<AdapterProvider>> {
  if (!config.type) {
    return {
      ok: false,
      code: 'ADAPTER_INVALID_CONFIG',
      message: 'Adapter type is required.',
      recoverable: false,
    };
  }

  if (!supportedAdapters.has(config.type)) {
    return {
      ok: false,
      code: 'ADAPTER_NOT_SUPPORTED',
      message: `Adapter type '${config.type}' is not supported.`,
      recoverable: false,
    };
  }

  try {
    const provider = buildAdapterProvider(config);
    const isAvailable = await provider.isAvailable();

    if (!isAvailable) {
      return {
        ok: false,
        code: 'ADAPTER_UNAVAILABLE',
        message: `Adapter '${config.type}' is not available.`,
        recoverable: true,
      };
    }

    return { ok: true, code: 'ADAPTER_SUCCESS', data: provider };
  } catch {
    return {
      ok: false,
      code: 'ADAPTER_UNAVAILABLE',
      message: `Failed to initialize adapter '${config.type}'.`,
      recoverable: true,
    };
  }
}

function buildAdapterProvider(config: AdapterConfig): AdapterProvider {
  return {
    async isAvailable() {
      return true;
    },
    async execute<T>(_operation: string, _payload: unknown): Promise<T> {
      throw new Error('Adapter not implemented');
    },
  };
}
