import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OpenDartClient } from './dart/client.js';

const apiKey = process.env.DART_API_KEY;
const server = new McpServer({ name: 'dart', version: '1.0.0' });

function client(): OpenDartClient {
  if (!apiKey) throw new Error('DART_API_KEY is not set');
  return new OpenDartClient({ apiKey });
}

server.tool(
  'company_info',
  'Get OpenDART company info by corp_code.',
  {
    corp_code: z.string().min(8),
  },
  async ({ corp_code }) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(await client().companyInfo(corp_code), null, 2),
      },
    ],
  }),
);

server.tool(
  'list_filings',
  'List OpenDART filings.',
  {
    corp_code: z.string().optional(),
    from: z.string().regex(/^\d{8}$/).optional(),
    to: z.string().regex(/^\d{8}$/).optional(),
    page_count: z.number().int().min(1).max(100).default(10),
  },
  async (args) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          await client().listFilings({
            corpCode: args.corp_code,
            bgnDe: args.from,
            endDe: args.to,
            pageCount: args.page_count,
          }),
          null,
          2,
        ),
      },
    ],
  }),
);

server.tool(
  'financial_statements',
  'Get single-company financial statements.',
  {
    corp_code: z.string().min(8),
    year: z.string().regex(/^\d{4}$/),
    report_code: z.string().default('11011'),
  },
  async (args) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          await client().singleFinancialStatement(
            args.corp_code,
            args.year,
            args.report_code,
          ),
          null,
          2,
        ),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
