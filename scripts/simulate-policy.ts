/**
 * CLI Policy Simulation Tool for Maintainers.
 *
 * Usage:
 *   npm run policy:simulate -- [--fixture standard|high-volume] [--max-amount 500] [--assets XLM,USDC]
 */

import {
  runMaintainerPolicySimulation,
  type SimulationFixtureName,
} from '../backend/src/domain/policy-simulation';

function parseArgs(argv: string[]) {
  let fixtureName: SimulationFixtureName = 'standard';
  let maxAmount: number | undefined = 500;
  let allowedAssets: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture' && argv[i + 1]) {
      fixtureName = argv[++i] as SimulationFixtureName;
    } else if (arg === '--max-amount' && argv[i + 1]) {
      maxAmount = Number(argv[++i]);
    } else if (arg === '--assets' && argv[i + 1]) {
      allowedAssets = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  return { fixtureName, maxAmount, allowedAssets };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = runMaintainerPolicySimulation({
    actor: { id: 'cli-maintainer', role: 'maintainer' },
    fixtureName: opts.fixtureName,
    proposedPolicy: {
      ...(opts.maxAmount !== undefined ? { maxAmount: opts.maxAmount } : {}),
      ...(opts.allowedAssets !== undefined ? { allowedAssets: opts.allowedAssets } : {}),
    },
    now: new Date('2026-10-18T12:00:00.000Z'),
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
