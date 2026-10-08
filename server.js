require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");

const cfg = require("./config");
const pix = require("./pix");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// SENHA DO PAINEL
// ============================================================

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString("hex");

  console.log(
    `ADMIN_PASSWORD não definida. Senha temporária do painel: ${ADMIN_PASSWORD}`,
  );
}

// ============================================================
// BANCO DE DADOS
// ============================================================

const db = new Database(path.join(DATA_DIR, "inscricoes.db"));

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

// ============================================================
// COLUNA DE SINCRONIZAÇÃO COM GOOGLE
// ============================================================

try {
  db.exec(
    "ALTER TABLE inscricoes ADD COLUMN sincronizado INTEGER NOT NULL DEFAULT 0",
  );
} catch (e) {
  // Coluna já existe
}

// ============================================================
// PAGAMENTO
// ============================================================

for (const col of [
  "token TEXT",
  "pago INTEGER NOT NULL DEFAULT 0",
  "avisou_pagamento INTEGER NOT NULL DEFAULT 0",
]) {
  try {
    db.exec("ALTER TABLE inscricoes ADD COLUMN " + col);
  } catch (e) {
    // Coluna já existe
  }
}

// ============================================================
// TOKENS
// ============================================================

for (const r of db
  .prepare("SELECT id FROM inscricoes WHERE token IS NULL")
  .all()) {
  db.prepare("UPDATE inscricoes SET token = ? WHERE id = ?").run(
    crypto.randomBytes(12).toString("hex"),
    r.id,
  );
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inscricoes_token
  ON inscricoes(token)
`);

// ============================================================
// AJUSTES DO PAINEL
// ============================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS ajustes (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  )
`);

const ajuste = {
  ler: (k) => {
    const r = db.prepare("SELECT valor FROM ajustes WHERE chave = ?").get(k);

    return r ? r.valor : null;
  },

  gravar: (k, v) => {
    return db
      .prepare(
        `
        INSERT INTO ajustes (chave, valor)
        VALUES (?, ?)
        ON CONFLICT(chave)
        DO UPDATE SET valor = excluded.valor
      `,
      )
      .run(k, String(v));
  },

  apagar: (k) => {
    return db.prepare("DELETE FROM ajustes WHERE chave = ?").run(k);
  },
};

// ============================================================
// BARRA DE VAGAS
// ============================================================

function barraManual() {
  const v = ajuste.ler("barra_manual");

  const n = v === null ? NaN : Number(v);

  return Number.isInteger(n) && n >= 0 && n <= 95 ? n : null;
}

function barraAuto() {
  return Math.min(100, Math.floor((q.total.get().n / cfg.vagas) * 10) * 10);
}

// ============================================================
// CONSULTAS DO BANCO
// ============================================================

const q = {
  porToken: db.prepare("SELECT * FROM inscricoes WHERE token = ?"),

  pago: db.prepare("UPDATE inscricoes SET pago = ? WHERE id = ?"),

  avisou: db.prepare(`
      UPDATE inscricoes
      SET avisou_pagamento = 1
      WHERE token = ?
      AND pago = 0
    `),

  naoSincronizadas: db.prepare(`
      SELECT *
      FROM inscricoes
      WHERE sincronizado = 0
      ORDER BY id
      LIMIT 20
    `),

  porId: db.prepare("SELECT * FROM inscricoes WHERE id = ?"),

  marcarSincronizada: db.prepare(`
      UPDATE inscricoes
      SET sincronizado = 1
      WHERE id = ?
    `),

  total: db.prepare("SELECT COUNT(*) AS n FROM inscricoes"),

  inserir: db.prepare(`
      INSERT INTO inscricoes
      (
        nome,
        idade,
        whatsapp,
        ejc,
        token
      )
      VALUES
      (
        @nome,
        @idade,
        @whatsapp,
        @ejc,
        @token
      )
    `),

  listar: db.prepare(`
      SELECT *
      FROM inscricoes
      ORDER BY id DESC
    `),

  presente: db.prepare(`
      UPDATE inscricoes
      SET presente = ?
      WHERE id = ?
    `),

  apagar: db.prepare(`
      DELETE FROM inscricoes
      WHERE id = ?
    `),
};

// ============================================================
// INSCRIÇÃO
// ============================================================

const inscrever = db.transaction((d) => {
  const ocupadas = q.total.get().n;

  if (ocupadas + 1 > cfg.vagas) {
    return {
      erro: "vagas",
    };
  }

  const token = crypto.randomBytes(12).toString("hex");

  const info = q.inserir.run({
    ...d,
    token,
  });

  return {
    ok: true,
    id: Number(info.lastInsertRowid),
    token,
  };
});

// ============================================================
// GOOGLE SHEETS
// ============================================================

const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL || "";

const SHEETS_SECRET = process.env.SHEETS_SECRET || "";

let sincronizando = false;

// ============================================================
// ENVIA INSCRIÇÃO PARA PLANILHA
// ============================================================

async function enviarParaPlanilha(r) {
  if (!SHEETS_URL) {
    return;
  }

  const resp = await fetch(SHEETS_URL, {
    method: "POST",

    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },

    body: JSON.stringify({
      segredo: SHEETS_SECRET,

      id: r.id,

      criado_em: r.criado_em.replace(" ", "T") + "Z",

      nome: r.nome,

      idade: r.idade,

      whatsapp: r.whatsapp,

      ejc: r.ejc,

      // NOVO:
      // envia o estado do pagamento
      pago: !!r.pago,
    }),

    signal: AbortSignal.timeout(15000),
  });

  const txt = await resp.text();

  let j = null;

  try {
    j = JSON.parse(txt);
  } catch (e) {
    // Resposta não era JSON
  }

  if (!resp.ok || !j || j.ok !== true) {
    throw new Error("planilha respondeu: " + txt.slice(0, 120));
  }
}

async function buscarDaPlanilha() {
  if (!SHEETS_URL) {
    throw new Error("Planilha não configurada.");
  }

  const resp = await fetch(SHEETS_URL, {
    method: "POST",

    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },

    body: JSON.stringify({
      segredo: SHEETS_SECRET,
      acao: "listar",
    }),

    signal: AbortSignal.timeout(15000),
  });

  const txt = await resp.text();

  let j;

  try {
    j = JSON.parse(txt);
  } catch (e) {
    throw new Error("Resposta inválida da planilha.");
  }

  if (!resp.ok || !j.ok) {
    throw new Error(j.erro || "Não foi possível ler a planilha.");
  }

  return j.lista || [];
}

// ============================================================
// SINCRONIZA INSCRIÇÕES PENDENTES
// ============================================================

async function sincronizar() {
  if (!SHEETS_URL || sincronizando) {
    return;
  }

  sincronizando = true;

  try {
    for (const r of q.naoSincronizadas.all()) {
      try {
        await enviarParaPlanilha(r);

        q.marcarSincronizada.run(r.id);
      } catch (e) {
        console.error(
          `Planilha: falha ao enviar inscrição ${r.id}: ${e.message}`,
        );

        break;
      }
    }
  } finally {
    sincronizando = false;
  }
}

if (SHEETS_URL) {
  console.log("Planilha do Google ligada.");

  setInterval(sincronizar, 60 * 1000).unref();

  setTimeout(sincronizar, 2000).unref();
}

// ============================================================
// PIX
// ============================================================

const pixAtivo = () => !!(cfg.pix.chave && cfg.pix.valorPorPessoa > 0);

function valorCentavos() {
  return Math.round(cfg.pix.valorPorPessoa * 100);
}

// ============================================================
// EJC
// ============================================================

const EJC_OPCOES = ["Já fiz o EJC", "Ainda não fiz o EJC", "Sou convidado(a)"];

// ============================================================
// LIMPEZA DE TEXTO
// ============================================================

function limparTexto(v, max) {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ============================================================
// VALIDAÇÃO
// ============================================================

function validar(body) {
  const erros = {};

  const nome = limparTexto(body.nome, 80);

  if (nome.split(" ").filter(Boolean).length < 2) {
    erros.nome = "Escreva nome e sobrenome.";
  }

  const idade = Number.parseInt(body.idade, 10);

  if (!(idade >= cfg.idadeMin && idade <= cfg.idadeMax)) {
    erros.idade = "Informe uma idade válida.";
  }

  let whatsapp = String(body.whatsapp ?? "").replace(/\D/g, "");

  if (whatsapp.startsWith("55") && whatsapp.length > 11) {
    whatsapp = whatsapp.slice(2);
  }

  if (whatsapp.length < 10 || whatsapp.length > 11) {
    erros.whatsapp = "Use DDD e número.";
  }

  const ejc = EJC_OPCOES.includes(body.ejc) ? body.ejc : null;

  if (!ejc) {
    erros.ejc = "Escolha uma opção.";
  }

  return {
    erros,

    dados: {
      nome,
      idade,
      whatsapp,
      ejc,
    },
  };
}

// ============================================================
// LIMITE POR IP
// ============================================================

const tentativas = new Map();

function limitarIp(req, res, next) {
  const agora = Date.now();

  const janela = 10 * 60 * 1000;

  const lista = (tentativas.get(req.ip) || []).filter(
    (t) => agora - t < janela,
  );

  if (lista.length >= 8) {
    return res.status(429).json({
      erro: "Muitas tentativas. Aguarde alguns minutos.",
    });
  }

  lista.push(agora);

  tentativas.set(req.ip, lista);

  next();
}

setInterval(() => tentativas.clear(), 60 * 60 * 1000).unref();

// ============================================================
// AUTENTICAÇÃO DO PAINEL
// ============================================================

function auth(req, res, next) {
  const h = req.headers.authorization || "";

  const [tipo, cred] = h.split(" ");

  if (tipo === "Basic" && cred) {
    const senha = Buffer.from(cred, "base64")
      .toString()
      .split(":")
      .slice(1)
      .join(":");

    const a = crypto.createHash("sha256").update(senha).digest();

    const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();

    if (crypto.timingSafeEqual(a, b)) {
      return next();
    }
  }

  res
    .set("WWW-Authenticate", 'Basic realm="Painel Balada EJC"')
    .status(401)
    .send("Acesso restrito.");
}

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.set("trust proxy", 1);

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",

    "Referrer-Policy": "same-origin",

    "X-Frame-Options": "DENY",
  });

  next();
});

app.use(
  express.json({
    limit: "10kb",
  }),
);

// ============================================================
// INFORMAÇÕES DO EVENTO
// ============================================================

app.get("/api/evento", (req, res) => {
  const ocupadas = q.total.get().n;

  const { nome, grupo, dataTexto, horario, local, cidade, vagas } = cfg;

  res.set("Cache-Control", "no-store").json({
    nome,
    grupo,
    dataTexto,
    horario,
    local,
    cidade,

    pagamento: pixAtivo(),

    lotacao: ocupadas >= vagas ? 100 : (barraManual() ?? barraAuto()),

    esgotado: ocupadas >= vagas,
  });
});

// ============================================================
// NOVA INSCRIÇÃO
// ============================================================

app.post("/api/inscricoes", limitarIp, (req, res) => {
  // Campo isca contra robôs
  if (req.body && req.body.site) {
    return res.status(201).json({
      ok: true,
    });
  }

  const { erros, dados } = validar(req.body || {});

  if (Object.keys(erros).length) {
    return res.status(400).json({
      erro: "Confira os campos.",
      campos: erros,
    });
  }

  try {
    const r = inscrever(dados);

    if (r.erro === "vagas") {
      return res.status(409).json({
        erro: "As vagas acabaram.",
        restantes: 0,
      });
    }

    sincronizar();

    res.status(201).json({
      ok: true,

      token: r.token,

      pagamento: pixAtivo(),
    });
  } catch (e) {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT")) {
      return res.status(409).json({
        erro: "Esse WhatsApp já está inscrito.",

        campos: {
          whatsapp: "Já inscrito.",
        },
      });
    }

    console.error(e);

    res.status(500).json({
      erro: "Erro ao salvar. Tente de novo.",
    });
  }
});

// ============================================================
// PÁGINA DE PAGAMENTO
// ============================================================

app.get("/api/pagamento/:token", async (req, res) => {
  const r = /^[a-f0-9]{24}$/.test(req.params.token)
    ? q.porToken.get(req.params.token)
    : null;

  if (!r || !pixAtivo()) {
    return res.status(404).json({
      erro: "Pagamento não encontrado.",
    });
  }

  const centavos = valorCentavos();

  const brcode = pix.gerarBrCode({
    chave: cfg.pix.chave,

    nome: cfg.pix.recebedor,

    cidade: cfg.pix.cidade,

    valorCentavos: centavos,

    txid: "BALADA" + r.id,
  });

  res.set("Cache-Control", "no-store").json({
    nome: r.nome,

    valor: centavos / 100,

    pago: !!r.pago,

    avisou: !!r.avisou_pagamento,

    recebedor: cfg.pix.recebedor,

    brcode,

    qr: await pix.qrDataUrl(brcode),

    evento: {
      nome: cfg.nome,

      dataTexto: cfg.dataTexto,

      horario: cfg.horario,

      local: cfg.local,

      cidade: cfg.cidade,
    },
  });
});

// ============================================================
// AVISAR PAGAMENTO
// ============================================================

app.post("/api/pagamento/:token/avisar", limitarIp, (req, res) => {
  if (/^[a-f0-9]{24}$/.test(req.params.token)) {
    q.avisou.run(req.params.token);
  }

  res.json({
    ok: true,
  });
});

// ============================================================
// PAINEL
// ============================================================

app.get("/admin", auth, (req, res) =>
  res.sendFile(path.join(__dirname, "admin.html")),
);

app.get("/api/admin/inscricoes", auth, (req, res) => {
  const lista = q.listar.all().map((r) => ({
    ...r,

    valor: pixAtivo() ? valorCentavos() / 100 : 0,
  }));

  res.set("Cache-Control", "no-store").json({
    lista,

    total: q.total.get().n,

    vagas: cfg.vagas,

    pagamento: pixAtivo(),
  });
});

app.post("/api/admin/sincronizar-planilha", auth, async (req, res) => {
  try {
    const lista = await buscarDaPlanilha();

    let atualizados = 0;
    let ignorados = 0;

    const atualizar = db.transaction((dados) => {
      for (const r of dados) {
        const id = Number(r.id);

        if (!Number.isInteger(id) || id <= 0) {
          ignorados++;
          continue;
        }

        const existente = q.porId.get(id);

        // Só atualiza quem já existe no banco
        if (!existente) {
          ignorados++;
          continue;
        }

        db.prepare(
          `
          UPDATE inscricoes
          SET
            nome = ?,
            idade = ?,
            whatsapp = ?,
            ejc = ?,
            pago = ?
          WHERE id = ?
        `,
        ).run(r.nome, r.idade, r.whatsapp, r.ejc, r.pago ? 1 : 0, id);

        atualizados++;
      }
    });

    atualizar(lista);

    res.json({
      ok: true,
      total: lista.length,
      atualizados,
      ignorados,
    });
  } catch (e) {
    console.error("Erro ao sincronizar com a planilha:", e);

    res.status(502).json({
      ok: false,
      erro: e.message || "Não foi possível sincronizar.",
    });
  }
});
// ============================================================
// PRESENÇA
// ============================================================

app.patch("/api/admin/inscricoes/:id/presente", auth, (req, res) => {
  q.presente.run(
    req.body && req.body.presente ? 1 : 0,

    Number(req.params.id),
  );

  res.json({
    ok: true,
  });
});

// ============================================================
// BARRA DO EVENTO
// ============================================================

app.get("/api/admin/barra", auth, (req, res) => {
  res.set("Cache-Control", "no-store").json({
    manual: barraManual(),

    auto: barraAuto(),
  });
});

app.put("/api/admin/barra", auth, (req, res) => {
  const b = req.body || {};

  if (b.modo === "auto") {
    ajuste.apagar("barra_manual");
  } else if (
    b.modo === "manual" &&
    Number.isInteger(b.valor) &&
    b.valor >= 0 &&
    b.valor <= 95
  ) {
    ajuste.gravar("barra_manual", b.valor);
  } else {
    return res.status(400).json({
      erro: "Valor inválido. Use de 0 a 95.",
    });
  }

  res.json({
    ok: true,

    manual: barraManual(),

    auto: barraAuto(),
  });
});

// ============================================================
// PAGAMENTO — AGORA SINCRONIZA COM A PLANILHA
// ============================================================

app.patch("/api/admin/inscricoes/:id/pago", auth, async (req, res) => {
  const id = Number(req.params.id);

  const pago = req.body && req.body.pago ? 1 : 0;

  // Atualiza no banco local
  q.pago.run(pago, id);

  // Busca a inscrição atualizada
  const r = q.porId.get(id);

  if (!r) {
    return res.status(404).json({
      erro: "Inscrição não encontrada.",
    });
  }

  // Atualiza também a planilha
  if (SHEETS_URL) {
    try {
      await enviarParaPlanilha(r);
    } catch (e) {
      console.error(
        `Planilha: falha ao atualizar pagamento da inscrição ${id}: ${e.message}`,
      );

      // O pagamento continua salvo
      // no banco local.
      return res.status(502).json({
        ok: false,

        erro: "Pagamento salvo, mas não foi possível atualizar a planilha.",
      });
    }
  }

  res.json({
    ok: true,

    pago: !!r.pago,
  });
});

// ============================================================
// EXCLUIR INSCRIÇÃO
// ============================================================

app.delete("/api/admin/inscricoes/:id", auth, (req, res) => {
  q.apagar.run(Number(req.params.id));

  res.json({
    ok: true,
  });
});

app.post("/api/admin/sincronizar-planilha", auth, async (req, res) => {
  try {
    const lista = await buscarDaPlanilha();

    const atualizar = db.transaction((dados) => {
      let atualizados = 0;
      let adicionados = 0;

      for (const r of dados) {
        const id = Number(r.id);

        if (!Number.isInteger(id) || id <= 0) {
          continue;
        }

        const existente = q.porId.get(id);

        if (existente) {
          db.prepare(
            `
            UPDATE inscricoes
            SET
              nome = ?,
              idade = ?,
              whatsapp = ?,
              ejc = ?,
              pago = ?
            WHERE id = ?
          `,
          ).run(r.nome, r.idade, r.whatsapp, r.ejc, r.pago ? 1 : 0, id);

          atualizados++;
        }
      }

      return {
        atualizados,
        adicionados,
      };
    });

    const resultado = atualizar(lista);

    res.json({
      ok: true,
      total: lista.length,
      atualizados: resultado.atualizados,
      adicionados: resultado.adicionados,
    });
  } catch (e) {
    console.error("Sincronização:", e);

    res.status(502).json({
      ok: false,
      erro: e.message || "Não foi possível sincronizar.",
    });
  }
});

// ============================================================
// EXPORTAR CSV
// ============================================================

app.get("/api/admin/inscricoes.csv", auth, (req, res) => {
  const cel = (v) => {
    let s = String(v ?? "");

    if (/^[=+\-@\t\r]/.test(s)) {
      s = "'" + s;
    }

    return `"${s.replace(/"/g, '""')}"`;
  };

  const cab = [
    "id",
    "nome",
    "idade",
    "whatsapp",
    "ejc",
    "valor_reais",
    "pago",
    "presente",
    "inscrito_em_utc",
  ];

  const linhas = q.listar
    .all()
    .reverse()
    .map((r) =>
      [
        r.id,

        r.nome,

        r.idade,

        r.whatsapp,

        r.ejc,

        pixAtivo() ? (valorCentavos() / 100).toFixed(2) : "",

        r.pago ? "sim" : "não",

        r.presente ? "sim" : "não",

        r.criado_em,
      ]
        .map(cel)
        .join(","),
    );

  res.set({
    "Content-Type": "text/csv; charset=utf-8",

    "Content-Disposition": 'attachment; filename="inscritos-balada-ejc.csv"',
  });

  res.send("﻿" + [cab.join(","), ...linhas].join("\r\n"));
});

// ============================================================
// ARQUIVOS PÚBLICOS
// ============================================================

app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "1h",
  }),
);

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
  console.log(`Balada EJC no ar: http://localhost:${PORT}  (painel: /admin)`);
});
