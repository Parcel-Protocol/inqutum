import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'date-fns') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,export function format() { return "formatted date"; }',
    };
  }

  if (specifier.startsWith('.') && !path.extname(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      try {
        return await nextResolve(specifier + '.js', context);
      } catch {
        // Fall back to default
      }
    }
  }

  return nextResolve(specifier, context);
}
