// Camada de banco de dados. Usa Postgres se DATABASE_URL existir (hospedagem), senão SQLite em arquivo (local).
// As duas versões têm a mesma interface assíncrona, então o resto do sistema não sabe qual está em uso.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function erroDuplicado() {
  const e = new Error("WhatsApp já inscrito");
  e.code = "DUPLICADO";
  return e;
}
const novoToken = () => crypto.randomBytes(12).toString("hex");

// ---------------------------------------------------------------- SQLite
function abrirSqlite(dataDir) {
  const Database = require("better-sqlite3");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "inscricoes.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS inscricoes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nome       TEXT NOT NULL,
      idade      INTEGER NOT NULL,
      whatsapp   TEXT NOT NULL UNIQUE,
      ejc        TEXT NOT NULL,
      circulo    TEXT NOT NULL DEFAULT '',
      convidados INTEGER NOT NULL DEFAULT 0,
      presente   INTEGER NOT NULL DEFAULT 0,
      criado_em  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Colunas novas: bancos antigos ganham aqui.
  for (const col of [
    "sincronizado INTEGER NOT NULL DEFAULT 0",
    "token TEXT",
    "pago INTEGER NOT NULL DEFAULT 0",
    "avisou_pagamento INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db.exec("ALTER TABLE inscricoes ADD COLUMN " + col); } catch (e) { /* já existe */ }
  }
  for (const r of db.prepare("SELECT id FROM inscricoes WHERE token IS NULL").all()) {
    db.prepare("UPDATE inscricoes SET token = ? WHERE id = ?").run(novoToken(), r.id);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inscricoes_token ON inscricoes(token)");
  db.exec("CREATE TABLE IF NOT EXISTS ajustes (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)");

  const q = {
    total: db.prepare("SELECT COUNT(*) AS n FROM inscricoes"),
    inserir: db.prepare("INSERT INTO inscricoes (nome, idade, whatsapp, ejc, token) VALUES (@nome, @idade, @whatsapp, @ejc, @token)"),
    listar: db.prepare("SELECT * FROM inscricoes ORDER BY id DESC"),
    porToken: db.prepare("SELECT * FROM inscricoes WHERE token = ?"),
    pago: db.prepare("UPDATE inscricoes SET pago = ? WHERE id = ?"),
    presente: db.prepare("UPDATE inscricoes SET presente = ? WHERE id = ?"),
    avisou: db.prepare("UPDATE inscricoes SET avisou_pagamento = 1 WHERE token = ? AND pago = 0"),
    apagar: db.prepare("DELETE FROM inscricoes WHERE id = ?"),
    pendentes: db.prepare("SELECT * FROM inscricoes WHERE sincronizado = 0 ORDER BY id LIMIT 20"),
    sincronizada: db.prepare("UPDATE inscricoes SET sincronizado = 1 WHERE id = ?"),
    ajusteLer: db.prepare("SELECT valor FROM ajustes WHERE chave = ?"),
    ajusteGravar: db.prepare("INSERT INTO ajustes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor"),
    ajusteApagar: db.prepare("DELETE FROM ajustes WHERE chave = ?"),
  };
  // Checagem de vagas e inserção numa transação só, para duas pessoas não passarem do limite juntas.
  const inscreverTx = db.transaction((d, vagas) => {
    if (q.total.get().n + 1 > vagas) return { erro: "vagas" };
    const token = novoToken();
    try {
      const info = q.inserir.run({ ...d, token });
      return { ok: true, id: Number(info.lastInsertRowid), token };
    } catch (e) {
      if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw erroDuplicado();
      throw e;
    }
  });

  return {
    tipo: "sqlite",
    total: async () => q.total.get().n,
    inscrever: async (d, vagas) => inscreverTx(d, vagas),
    listar: async () => q.listar.all(),
    porToken: async (t) => q.porToken.get(t) || null,
    definirPago: async (id, v) => { q.pago.run(v ? 1 : 0, id); },
    definirPresente: async (id, v) => { q.presente.run(v ? 1 : 0, id); },
    avisouPagamento: async (t) => { q.avisou.run(t); },
    apagar: async (id) => { q.apagar.run(id); },
    pendentesPlanilha: async () => q.pendentes.all(),
    marcarSincronizada: async (id) => { q.sincronizada.run(id); },
    ajusteLer: async (k) => { const r = q.ajusteLer.get(k); return r ? r.valor : null; },
    ajusteGravar: async (k, v) => { q.ajusteGravar.run(k, String(v)); },
    ajusteApagar: async (k) => { q.ajusteApagar.run(k); },
  };
}

// -------------------------------------------------------------- Postgres
async function abrirPostgres(url) {
  const { Pool } = require("pg");
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
  const semSsl = local || process.env.DATABASE_SSL === "off";
  const pool = new Pool({
    connectionString: url,
    ssl: semSsl ? false : { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 15000,
  });
  pool.on("error", (e) => console.error("Postgres: erro numa conexão ociosa:", e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inscricoes (
      id               SERIAL PRIMARY KEY,
      nome             TEXT NOT NULL,
      idade            INTEGER NOT NULL,
      whatsapp         TEXT NOT NULL UNIQUE,
      ejc              TEXT NOT NULL,
      presente         INTEGER NOT NULL DEFAULT 0,
      pago             INTEGER NOT NULL DEFAULT 0,
      avisou_pagamento INTEGER NOT NULL DEFAULT 0,
      sincronizado     INTEGER NOT NULL DEFAULT 0,
      token            TEXT NOT NULL UNIQUE,
      criado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ajustes (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
  `);

  const COLS = `id, nome, idade, whatsapp, ejc, presente, pago, avisou_pagamento, sincronizado, token,
    to_char(criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS criado_em`;

  return {
    tipo: "postgres",
    total: async () => (await pool.query("SELECT COUNT(*)::int AS n FROM inscricoes")).rows[0].n,
    inscrever: async (d, vagas) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(424242)"); // uma inscrição de cada vez, para não passar do limite
        const n = (await c.query("SELECT COUNT(*)::int AS n FROM inscricoes")).rows[0].n;
        if (n + 1 > vagas) { await c.query("ROLLBACK"); return { erro: "vagas" }; }
        const token = novoToken();
        const r = await c.query(
          "INSERT INTO inscricoes (nome, idade, whatsapp, ejc, token) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [d.nome, d.idade, d.whatsapp, d.ejc, token]
        );
        await c.query("COMMIT");
        return { ok: true, id: r.rows[0].id, token };
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch (e2) { /* sem transação aberta */ }
        if (e.code === "23505") throw erroDuplicado();
        throw e;
      } finally {
        c.release();
      }
    },
    listar: async () => (await pool.query(`SELECT ${COLS} FROM inscricoes ORDER BY id DESC`)).rows,
    porToken: async (t) => (await pool.query(`SELECT ${COLS} FROM inscricoes WHERE token = $1`, [t])).rows[0] || null,
    definirPago: async (id, v) => { await pool.query("UPDATE inscricoes SET pago = $1 WHERE id = $2", [v ? 1 : 0, id]); },
    definirPresente: async (id, v) => { await pool.query("UPDATE inscricoes SET presente = $1 WHERE id = $2", [v ? 1 : 0, id]); },
    avisouPagamento: async (t) => { await pool.query("UPDATE inscricoes SET avisou_pagamento = 1 WHERE token = $1 AND pago = 0", [t]); },
    apagar: async (id) => { await pool.query("DELETE FROM inscricoes WHERE id = $1", [id]); },
    pendentesPlanilha: async () =>
      (await pool.query(`SELECT ${COLS} FROM inscricoes WHERE sincronizado = 0 ORDER BY id LIMIT 20`)).rows,
    marcarSincronizada: async (id) => { await pool.query("UPDATE inscricoes SET sincronizado = 1 WHERE id = $1", [id]); },
    ajusteLer: async (k) => { const r = await pool.query("SELECT valor FROM ajustes WHERE chave = $1", [k]); return r.rows[0] ? r.rows[0].valor : null; },
    ajusteGravar: async (k, v) => {
      await pool.query("INSERT INTO ajustes (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [k, String(v)]);
    },
    ajusteApagar: async (k) => { await pool.query("DELETE FROM ajustes WHERE chave = $1", [k]); },
  };
}

async function abrirBanco({ databaseUrl, dataDir }) {
  return databaseUrl ? abrirPostgres(databaseUrl) : abrirSqlite(dataDir);
}

module.exports = { abrirBanco };
