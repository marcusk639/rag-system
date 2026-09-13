import { test, expect } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../env.js";

test("migrations have been applied to the e2e database", async () => {
  const client = new pg.Client({ connectionString: E2E_ENV.DATABASE_URL });
  await client.connect();
  const r = await client.query("select to_regclass('public.chunks') as t");
  await client.end();
  expect(r.rows[0].t).toBe("chunks");
});
