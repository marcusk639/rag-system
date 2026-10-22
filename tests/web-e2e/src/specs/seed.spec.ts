import { test, expect } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../env.js";

test("every chunk was embedded by the configured provider", async () => {
  const client = new pg.Client({ connectionString: E2E_ENV.DATABASE_URL });
  await client.connect();
  const r = await client.query(
    "select distinct embedding_provider, embedding_model from chunks",
  );
  await client.end();
  expect(r.rowCount).toBe(1);
  expect(r.rows[0].embedding_provider).toBe(E2E_ENV.EMBEDDING_PROVIDER);
  expect(r.rows[0].embedding_model).toBe(E2E_ENV.EMBEDDING_MODEL);
});
