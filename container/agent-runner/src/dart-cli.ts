import { OpenDartClient } from './dart/client.js';

function usage(): never {
  console.error(`usage:
  dart-tool company <corp_code>
  dart-tool filings --corp-code <corp_code> --from YYYYMMDD [--to YYYYMMDD]
  dart-tool financials --corp-code <corp_code> --year YYYY --report 11011
`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const apiKey = process.env.DART_API_KEY;
if (!apiKey) {
  console.error('DART_API_KEY is not set');
  process.exit(2);
}

const client = new OpenDartClient({ apiKey });
const cmd = process.argv[2];

try {
  let out: unknown;
  if (cmd === 'company') {
    const corpCode = process.argv[3] ?? usage();
    out = await client.companyInfo(corpCode);
  } else if (cmd === 'filings') {
    out = await client.listFilings({
      corpCode: arg('--corp-code'),
      bgnDe: arg('--from'),
      endDe: arg('--to'),
      pageCount: Number(arg('--page-count') ?? 10),
    });
  } else if (cmd === 'financials') {
    out = await client.singleFinancialStatement(
      arg('--corp-code') ?? usage(),
      arg('--year') ?? usage(),
      arg('--report') ?? usage(),
    );
  } else {
    usage();
  }
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
