// npm run portal:reset -- <username>
//
// The recovery path for a lost portal password. The operator of a self-hosted
// gateway has shell access by definition, so recovery does not need a mail
// server. It prints a one-time URL, never a password: a password in a shell
// history or a log file is worse than the problem it solves.
import "dotenv/config";
import { pool } from "../db.js";
import { createResetToken } from "../portal/session.js";

const username = (process.argv[2] ?? "").trim().toLowerCase();
const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

async function main(): Promise<void> {
  if (!username) {
    console.error("usage: npm run portal:reset -- <username>");
    process.exitCode = 1;
    return;
  }
  const token = await createResetToken(username);
  if (!token) {
    console.error(`no portal account named "${username}"`);
    process.exitCode = 1;
    return;
  }
  console.log(`Open this within the hour, once:\n\n  ${baseUrl}/portal/reset?token=${token}\n`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
