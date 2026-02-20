import { XClient } from "../integrations/x";
import { loadDotEnv } from "../utils/env";

async function main(): Promise<void> {
  loadDotEnv();

  const client = XClient.fromEnv(process.env);
  const user = await client.getCurrentUser();

  // eslint-disable-next-line no-console
  console.log("X integration verified.");
  // eslint-disable-next-line no-console
  console.log(`User ID: ${user.id}`);
  // eslint-disable-next-line no-console
  console.log(`Username: ${user.username ?? "(unknown)"}`);
  // eslint-disable-next-line no-console
  console.log(`Display Name: ${user.name ?? "(unknown)"}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`x:verify failed: ${message}`);
  process.exit(1);
});
