import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { TABLES, buildCreateTableSql, toPostgresColumnDef } from "../schema.js";

const { Pool, types } = pg;

types.setTypeParser(20, (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});

const canonicalColumns = new Map();
for (const def of Object.values(TABLES)) {
  for (const column of Object.keys(def.columns)) {
    canonicalColumns.set(column.toLowerCase(), column);
  }
}

function mapRow(row) {
  if (!row) return row;
  const mapped = {};
  for (const [key, value] of Object.entries(row)) {
    mapped[canonicalColumns.get(key.toLowerCase()) || key] = value;
  }
  return mapped;
}

function convertPlaceholders(sql) {
  let result = "";
  let index = 0;
  let mode = "normal";
  let dollarTag = "";

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    if (mode === "single") {
      result += char;
      if (char === "'" && next === "'") {
        result += next;
        i++;
      } else if (char === "'") {
        mode = "normal";
      }
      continue;
    }
    if (mode === "double") {
      result += char;
      if (char === '"' && next === '"') {
        result += next;
        i++;
      } else if (char === '"') {
        mode = "normal";
      }
      continue;
    }
    if (mode === "line-comment") {
      result += char;
      if (char === "\n") mode = "normal";
      continue;
    }
    if (mode === "block-comment") {
      result += char;
      if (char === "*" && next === "/") {
        result += next;
        i++;
        mode = "normal";
      }
      continue;
    }
    if (mode === "dollar") {
      if (sql.startsWith(dollarTag, i)) {
        result += dollarTag;
        i += dollarTag.length - 1;
        mode = "normal";
      } else {
        result += char;
      }
      continue;
    }

    if (char === "'") mode = "single";
    else if (char === '"') mode = "double";
    else if (char === "-" && next === "-") mode = "line-comment";
    else if (char === "/" && next === "*") mode = "block-comment";
    else if (char === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        mode = "dollar";
        result += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    } else if (char === "?") {
      result += `$${++index}`;
      continue;
    }
    result += char;
  }

  return result;
}

function additiveColumnDef(definition) {
  return toPostgresColumnDef(definition)
    .replace(/PRIMARY KEY/i, "")
    .replace(/UNIQUE/i, "")
    .replace(/CHECK\s*\([^)]*\)/i, "")
    .trim();
}

async function syncSchema(client) {
  await client.query("BEGIN");
  try {
    for (const [tableName, def] of Object.entries(TABLES)) {
      await client.query(buildCreateTableSql(tableName, def, "postgres"));

      const existing = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1`,
        [tableName.toLowerCase()]
      );
      const existingNames = new Set(existing.rows.map((row) => row.column_name.toLowerCase()));
      for (const [columnName, definition] of Object.entries(def.columns)) {
        if (!existingNames.has(columnName.toLowerCase())) {
          await client.query(
            `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${additiveColumnDef(definition)}`
          );
        }
      }

      for (const indexSql of def.indexes || []) {
        await client.query(indexSql);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function createPostgresAdapter(connectionString) {
  const pool = new Pool({ connectionString });
  pool.on("error", (error) => console.error("[DB] PostgreSQL pool error:", error));

  const bootstrapClient = await pool.connect();
  try {
    await syncSchema(bootstrapClient);
  } finally {
    bootstrapClient.release();
  }

  const transactionStorage = new AsyncLocalStorage();

  function currentClient() {
    return transactionStorage.getStore()?.client || pool;
  }

  async function query(sql, params = []) {
    return currentClient().query(convertPlaceholders(sql), params);
  }

  return {
    driver: "postgresql",
    async run(sql, params = []) {
      const result = await query(sql, params);
      const firstRow = result.rows[0] ? mapRow(result.rows[0]) : null;
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: firstRow?.id ?? null,
        row: firstRow,
      };
    },
    async get(sql, params = []) {
      const result = await query(sql, params);
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    },
    async all(sql, params = []) {
      const result = await query(sql, params);
      return result.rows.map(mapRow);
    },
    async exec(sql) {
      await query(sql);
    },
    async transaction(fn) {
      const current = transactionStorage.getStore();
      if (current) {
        const savepoint = `sp_${Math.random().toString(36).slice(2)}`;
        await current.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const value = await fn();
          await current.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return value;
        } catch (error) {
          await current.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await current.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await transactionStorage.run({ client }, fn);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    checkpoint() {},
    async close() {
      await pool.end();
    },
    raw: pool,
  };
}
