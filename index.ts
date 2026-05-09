import { mkdir } from 'node:fs/promises';

import sharp from 'sharp';

import accounts from './accounts.jsonc';

interface Output {
  result: {
    /**
     * The generated image in Base64 format.
     */
    image?: string;
    [k: string]: unknown;
  };
}

type GenerateResult = { status: 'success' } | { status: 'rate_limited' } | { status: 'error'; message: string };

// Global flag to handle graceful shutdown
let isShuttingDown = false;

// Listen for Ctrl+C (SIGINT)
process.on('SIGINT', () => {
  if (isShuttingDown) {
    console.log('\nForcing exit...');
    process.exit(1);
  }
  isShuttingDown = true;
  console.log('\n[Graceful Shutdown] Finishing pending requests in current batch...');
});

async function generateImage(accountId: string, apiToken: string): Promise<GenerateResult> {
  const prompt = Array.from({ length: 512 }, () =>
    String.fromCharCode(Math.floor(Math.random() * (126 - 32 + 1)) + 32),
  ).join('');

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ width: 1024, height: 1024, prompt }),
      },
    );

    if (res.status === 429) {
      return { status: 'rate_limited' };
    }

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      return { status: 'error', message: `${res.status} ${res.statusText}: ${err}` };
    }

    const data = (await res.json()) as Output;
    if (!data.result?.image) {
      return { status: 'error', message: 'Response missing image field' };
    }

    await sharp(Uint8Array.fromBase64(data.result.image))
      .withMetadata({
        exif: {
          IFD0: {
            Artist: 'black-forest-labs/flux-1-schnell',
            ImageDescription: prompt,
          },
        },
      })
      .toFile(`out/${Bun.randomUUIDv7()}.jpg`);

    return { status: 'success' };
  } catch (err) {
    return {
      status: 'error',
      message: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

await mkdir('out', { recursive: true });

for (const account of accounts) {
  if (isShuttingDown) break;

  console.log(`Processing Account: ${account.name}`);

  let totalSuccess = 0;
  let totalRateLimited = 0;
  let totalError = 0;
  let totalGenerated = 0;

  while (!isShuttingDown) {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => generateImage(account.CLOUDFLARE_ACCOUNT_ID, account.CLOUDFLARE_API_TOKEN)),
    );

    let rateLimitedCount = 0;

    // Process results and log errors safely above the progress bar
    for (const r of results) {
      if (r.status === 'success') {
        totalSuccess++;
      } else if (r.status === 'rate_limited') {
        totalRateLimited++;
        rateLimitedCount++;
      } else if (r.status === 'error') {
        totalError++;

        // \r goes to the start of the line, \x1b[K clears the current line
        process.stdout.write('\r\x1b[K');
        console.error(`[Error] ${r.message}`);
      }
    }

    totalGenerated += results.length;

    // Redraw the live progress bar (clearing any old artifacts with \x1b[K)
    process.stdout.write(
      `\r\x1b[KSuccess: ${totalSuccess} | Error: ${totalError} | Rate Limited: ${totalRateLimited} | Total: ${totalGenerated}`,
    );

    if (rateLimitedCount === results.length) {
      process.stdout.write('\n');
      console.log(`Finished ${account.name}: All requests rate limited → Moving to next account.`);
      break;
    }

    if (rateLimitedCount > 0 && !isShuttingDown) {
      await Bun.sleep(1000);
    }
  }
}

console.log('\nAll operations completed or halted. Exiting.');
process.exit(0);
