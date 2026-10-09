require("dotenv").config(); // lê o arquivo .env, se existir
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { abrirBanco } = require("./db");
const cfg = require("./config");
const pix = require("./pix");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATABASE_URL = process.env.DATABASE_URL || "";

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString("hex");
  console.log(`ADMIN_PASSWORD não definida. Senha temporária do painel: ${ADMIN_PASSWORD}`);
}

// Texto para o painel: qual banco está em uso (sem senha).
function bancoDescricao() {
  if (db.tipo !== "postgres") return "SQLite (arquivo local, some a cada deploy no Render)";
  let host = "";
  try { host = new URL(DATABASE_URL).hostname; } catch (e) { /* URL fora do padrão */ }
  return "Postgres" + (host ? " em " + host : "");
}

// Banco de dados (Postgres se DATABASE_URL existir; senão SQLite em arquivo). Aberto em main(), lá embaixo.
let db;

// Barra manual: null = automática; senão um número de 0 a 95.
async function barraManual() {
  const v = await db.ajusteLer("barra_manual");
  const n = v === null ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 95 ? n : null;
}
async function barraAuto() {
  return Math.min(100, Math.floor(((await db.total()) / cfg.vagas) * 10) * 10);
}

// Envio para a planilha do Google (Apps Script). Ligado só se SHEETS_WEBHOOK_URL estiver definida.
const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL || "";
const SHEETS_SECRET = process.env.SHEETS_SECRET || "";
let sincronizando = false;
let planilhaErro = null; // último motivo de falha (aparece no painel)

// Fala com o script do Google. Devolve o JSON da resposta ou lança um erro com a explicação do que corrigir.
async function chamarPlanilha(corpo, timeoutMs = 15000) {
  const resp = await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ segredo: SHEETS_SECRET, ...corpo }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await resp.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { /* resposta não era JSON */ }
  if (resp.ok && j && j.ok === true) return j;
  throw new Error(explicarFalhaPlanilha(resp.status, txt, j));
}
const textoErroPlanilha = (e) =>
  e.name === "TimeoutError" ? "O Google demorou demais para responder. O sistema tenta de novo sozinho." : e.message;

function enviarParaPlanilha(r) {
  return chamarPlanilha({
    acao: "upsert",
    id: r.id,
    criado_em: String(r.criado_em).replace(" ", "T") + "Z",
    nome: r.nome,
    idade: r.idade,
    whatsapp: r.whatsapp,
    ejc: r.ejc,
    pago: !!r.pago,
    presente: !!r.presente,
    avisou: !!r.avisou_pagamento,
    token: r.token,
  });
}

// Traduz a resposta do Google em uma instrução do que corrigir.
function explicarFalhaPlanilha(status, txt, j) {
  const t = String(txt).trim();
  if (/^</.test(t)) {
    return "O endereço devolveu uma página da web, não o script. No Apps Script, em Implantar > Gerenciar implantações, "
      + "deixe \"Quem pode acessar\" como \"Qualquer pessoa\" e copie a URL que termina em /exec (não a de teste, /dev).";
  }
  if (j && j.erro === "segredo invalido") {
    return "A senha não confere. A propriedade SEGREDO do Apps Script precisa ser igual a SHEETS_SECRET do servidor.";
  }
  if (j && /planilha nao encontrada/.test(String(j.erro))) {
    return "O script não está ligado a uma planilha. Abra a planilha e crie o script por Extensões > Apps Script, "
      + "ou defina a propriedade PLANILHA_ID com o código da planilha.";
  }
  if (j && j.ok === false) return "O script do Google respondeu com erro: " + String(j.erro).slice(0, 160);
  if (status === 401 || status === 403) return "O Google recusou o acesso (HTTP " + status + "). Reimplante o script com acesso \"Qualquer pessoa\".";
  if (status === 404) return "URL não encontrada (HTTP 404). Confira o SHEETS_WEBHOOK_URL.";
  return "Resposta inesperada (HTTP " + status + "): " + t.slice(0, 120);
}

// Envia para a planilha o que mudou: exclusões e inscrições pendentes (novas ou alteradas).
// Se der erro, tudo continua pendente e a rotina tenta de novo.
async function sincronizar() {
  if (!SHEETS_URL || sincronizando) return;
  sincronizando = true;
  try {
    for (const id of await db.exclusoesPendentes()) {
      try {
        await chamarPlanilha({ acao: "apagar", id });
        await db.exclusaoFeita(id);
        planilhaErro = null;
      } catch (e) {
        planilhaErro = textoErroPlanilha(e);
        console.error(`Planilha: falha ao apagar inscrição ${id}: ${planilhaErro}`);
        return;
      }
    }
    const vistos = new Set(); // uma inscrição alterada durante o envio fica para o próximo ciclo
    for (;;) {
      const lote = (await db.pendentesPlanilha(50)).filter((r) => !vistos.has(r.id));
      if (!lote.length) break;
      for (const r of lote) {
        vistos.add(r.id);
        try {
          await enviarParaPlanilha(r);
          await db.marcarSincronizada(r.id, r.rev);
          planilhaErro = null;
        } catch (e) {
          planilhaErro = textoErroPlanilha(e);
          console.error(`Planilha: falha ao enviar inscrição ${r.id}: ${planilhaErro}`);
          return; // provavelmente fora do ar; tenta de novo no próximo ciclo
        }
      }
    }
  } finally {
    sincronizando = false;
  }
}

const SIM = /^(sim|s|x|1|true|ok|pago|yes|y|✓|✔)$/i;
const NAO = /^(nao|não|n|0|false|no|)$/i;
// Célula da planilha -> 1, 0 ou null (null = vazio ou texto estranho: não mexe no valor atual).
function lerFlag(v) {
  const t = String(v ?? "").trim();
  if (t === "") return null;
  if (SIM.test(t)) return 1;
  if (NAO.test(t)) return 0;
  return null;
}
function normalizarEjc(v) {
  const t = String(v ?? "").trim().toLowerCase();
  return EJC_OPCOES.find((o) => o.toLowerCase() === t) || null;
}

let puxando = false;
let ultimaPuxada = null; // { quando, resumo } da última vez (aparece no painel)

// Lê a planilha e traz para o banco o que estiver diferente. Regras:
//  - o que foi alterado aqui e ainda não foi enviado não é sobrescrito (vale o do sistema);
//  - linhas sem ID são ignoradas; células de Pago/Chegou/Avisou vazias não mudam nada;
//  - inscrição apagada aqui e ainda não removida da planilha não ressuscita;
//  - inscrições que o banco tem e a planilha não tem são reenviadas.
async function puxarDaPlanilha() {
  if (!SHEETS_URL) throw new Error("A planilha não está ligada (falta SHEETS_WEBHOOK_URL).");
  if (puxando) throw new Error("Já tem uma leitura da planilha em andamento. Aguarde alguns segundos.");
  puxando = true;
  const resumo = { lidas: 0, novas: 0, atualizadas: 0, reenviadas: 0, ignoradas: 0, avisos: [] };
  const aviso = (m) => { if (resumo.avisos.length < 10) resumo.avisos.push(m); };
  try {
    await sincronizar(); // primeiro manda o que está pendente, para não perder nada
    const j = await chamarPlanilha({ acao: "listar" }, 30000);
    const linhas = Array.isArray(j.linhas) ? j.linhas : [];
    resumo.lidas = linhas.length;
    const locais = new Map((await db.listar()).map((r) => [r.id, r]));
    const apagando = new Set(await db.exclusoesPendentes());
    const idsNaPlanilha = new Set();

    for (const l of linhas) {
      const id = Number(String(l.id).trim());
      if (!Number.isInteger(id) || id < 1) { resumo.ignoradas++; aviso(`Linha com ID inválido: "${l.id}".`); continue; }
      if (idsNaPlanilha.has(id)) { resumo.ignoradas++; aviso(`ID ${id} repetido na planilha; usei a primeira linha.`); continue; }
      idsNaPlanilha.add(id);
      if (apagando.has(id)) { resumo.ignoradas++; continue; }

      const local = locais.get(id) || null;
      const tokenPlan = /^[a-f0-9]{24}$/.test(String(l.token || "").trim()) ? String(l.token).trim() : null;
      if (local && tokenPlan && local.token !== tokenPlan) {
        resumo.ignoradas++; aviso(`ID ${id}: o código de pagamento da planilha não bate com o do sistema. Ignorei.`); continue;
      }
      if (local && !local.sincronizado) { resumo.ignoradas++; continue; } // alteração local ainda não enviada vence

      const ejc = normalizarEjc(l.ejc) || (local ? local.ejc : null);
      const { erros, dados } = validar({ nome: l.nome, idade: l.idade, whatsapp: l.whatsapp, ejc });
      if (Object.keys(erros).length) {
        resumo.ignoradas++; aviso(`ID ${id} (${String(l.nome).slice(0, 30)}): ${Object.values(erros).join(" ")} Ignorei.`); continue;
      }
      const outro = await db.porWhatsapp(dados.whatsapp);
      if (outro && outro.id !== id) {
        resumo.ignoradas++; aviso(`ID ${id}: o WhatsApp já pertence à inscrição ${outro.id}. Ignorei.`); continue;
      }
      const pago = lerFlag(l.pago), presente = lerFlag(l.presente), avisou = lerFlag(l.avisou);

      if (local) {
        const novo = {
          id, ...dados, rev: local.rev,
          pago: pago ?? local.pago, presente: presente ?? local.presente, avisou: avisou ?? local.avisou_pagamento,
        };
        const igual = novo.nome === local.nome && novo.idade === local.idade && novo.whatsapp === local.whatsapp
          && novo.ejc === local.ejc && novo.pago === local.pago && novo.presente === local.presente
          && novo.avisou === local.avisou_pagamento;
        if (!igual && (await db.atualizarImportada(novo))) resumo.atualizadas++;
      } else {
        const t = String(l.data_utc || "").trim();
        const data = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(t) ? t.slice(0, 19).replace("T", " ") : new Date().toISOString().slice(0, 19).replace("T", " ");
        let token = tokenPlan;
        if (token && (await db.porToken(token))) token = null; // já usado por outra inscrição
        try {
          await db.inserirImportada({
            id, ...dados, presente: presente ?? 0, pago: pago ?? 0, avisou: avisou ?? 0,
            token: token || crypto.randomBytes(12).toString("hex"), criado_em: data,
          });
          resumo.novas++;
        } catch (e) {
          resumo.ignoradas++; aviso(`ID ${id}: não consegui importar (${e.message.slice(0, 80)}).`);
        }
      }
    }
    await db.ajustarSequencia();

    // O que o sistema tem e a planilha não tem volta para a planilha.
    for (const r of (await db.listar())) {
      if (r.sincronizado && !idsNaPlanilha.has(r.id)) { await db.marcarPendente(r.id); resumo.reenviadas++; }
    }
    ultimaPuxada = { quando: new Date().toISOString(), resumo };
    planilhaErro = null;
  } catch (e) {
    planilhaErro = textoErroPlanilha(e);
    throw new Error(planilhaErro);
  } finally {
    puxando = false;
  }
  if (resumo.reenviadas) await sincronizar();
  return resumo;
}

// Ao ligar o sistema: confere o formato da planilha, manda o que falta e puxa o que a planilha tem.
async function iniciarPlanilha() {
  if (!SHEETS_URL) return;
  console.log("Planilha do Google ligada.");
  try {
    if ((await db.ajusteLer("planilha_formato")) !== "2") {
      await db.marcarTodasPendentes(); // planilha da versão antiga: reenvia tudo com as colunas novas
      await db.ajusteGravar("planilha_formato", "2");
    }
  } catch (e) { console.error("Planilha:", e.message); }
  if (process.env.PLANILHA_PUXAR_AO_INICIAR !== "nao") {
    const r = await Promise.race([
      puxarDaPlanilha().then((x) => x, (e) => { console.error("Planilha: não consegui puxar ao iniciar:", e.message); return null; }),
      new Promise((ok) => setTimeout(() => ok("demorou"), 25000)),
    ]);
    if (r === "demorou") console.log("Planilha: a leitura inicial está demorando; segue em segundo plano.");
    else if (r) console.log(`Planilha: puxei ${r.lidas} linhas (${r.novas} novas, ${r.atualizadas} atualizadas, ${r.ignoradas} ignoradas).`);
  }
  const ciclo = () => sincronizar().catch((e) => console.error("Planilha:", e.message));
  setInterval(ciclo, 60 * 1000).unref();
  setTimeout(ciclo, 2000).unref();
}

const pixAtivo = () => !!(cfg.pix.chave && cfg.pix.valorPorPessoa > 0);
function valorCentavos() {
  return Math.round(cfg.pix.valorPorPessoa * 100);
}

const EJC_OPCOES = ["Já fiz o EJC", "Ainda não fiz o EJC", "Sou convidado(a)"];

function limparTexto(v, max) {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function validar(body) {
  const erros = {};
  const nome = limparTexto(body.nome, 80);
  if (nome.split(" ").filter(Boolean).length < 2) erros.nome = "Escreva nome e sobrenome.";
  const idade = Number.parseInt(body.idade, 10);
  if (!(idade >= cfg.idadeMin && idade <= cfg.idadeMax)) erros.idade = "Informe uma idade válida.";
  let whatsapp = String(body.whatsapp ?? "").replace(/\D/g, "");
  if (whatsapp.startsWith("55") && whatsapp.length > 11) whatsapp = whatsapp.slice(2);
  if (whatsapp.length < 10 || whatsapp.length > 11) erros.whatsapp = "Use DDD e número.";
  const ejc = EJC_OPCOES.includes(body.ejc) ? body.ejc : null;
  if (!ejc) erros.ejc = "Escolha uma opção.";
  return { erros, dados: { nome, idade, whatsapp, ejc } };
}

// Limite simples por IP para frear abuso do formulário público.
const tentativas = new Map();
function limitarIp(req, res, next) {
  const agora = Date.now();
  const janela = 10 * 60 * 1000;
  const lista = (tentativas.get(req.ip) || []).filter((t) => agora - t < janela);
  if (lista.length >= 8) return res.status(429).json({ erro: "Muitas tentativas. Aguarde alguns minutos." });
  lista.push(agora);
  tentativas.set(req.ip, lista);
  next();
}
setInterval(() => tentativas.clear(), 60 * 60 * 1000).unref();

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const [tipo, cred] = h.split(" ");
  if (tipo === "Basic" && cred) {
    const senha = Buffer.from(cred, "base64").toString().split(":").slice(1).join(":");
    const a = crypto.createHash("sha256").update(senha).digest();
    const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Painel Balada EJC"').status(401).send("Acesso restrito.");
}

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
app.use(express.json({ limit: "10kb" }));

app.get("/api/evento", async (req, res) => {
  const ocupadas = await db.total();
  const { nome, grupo, dataTexto, horario, local, cidade, vagas } = cfg;
  res.set("Cache-Control", "no-store").json({
    nome, grupo, dataTexto, horario, local, cidade, pagamento: pixAtivo(),
    // Sem números: só o quanto a casa já encheu (arredondado de 10 em 10) e se esgotou.
    // Se você definiu a barra no painel, vale o valor manual. Vagas realmente esgotadas sempre mostram 100%.
    lotacao: ocupadas >= vagas ? 100 : ((await barraManual()) ?? (await barraAuto())),
    esgotado: ocupadas >= vagas,
  });
});

app.post("/api/inscricoes", limitarIp, async (req, res) => {
  // Campo isca: pessoas não veem, robôs preenchem.
  if (req.body && req.body.site) return res.status(201).json({ ok: true });
  const { erros, dados } = validar(req.body || {});
  if (Object.keys(erros).length) return res.status(400).json({ erro: "Confira os campos.", campos: erros });
  try {
    const r = await db.inscrever(dados, cfg.vagas);
    if (r.erro === "vagas") {
      return res.status(409).json({ erro: "As vagas acabaram.", restantes: 0 });
    }
    sincronizar().catch((e) => console.error("Planilha:", e.message)); // não espera: a pessoa não depende da planilha
    res.status(201).json({ ok: true, token: r.token, pagamento: pixAtivo() });
  } catch (e) {
    if (e.code === "DUPLICADO") {
      return res.status(409).json({ erro: "Esse WhatsApp já está inscrito.", campos: { whatsapp: "Já inscrito." } });
    }
    console.error(e);
    res.status(500).json({ erro: "Erro ao salvar. Tente de novo." });
  }
});

// Página de pagamento: quem tem o link (token) vê o próprio Pix.
app.get("/api/pagamento/:token", async (req, res) => {
  const r = /^[a-f0-9]{24}$/.test(req.params.token) ? await db.porToken(req.params.token) : null;
  if (!r || !pixAtivo()) return res.status(404).json({ erro: "Pagamento não encontrado." });
  const centavos = valorCentavos();
  const brcode = pix.gerarBrCode({
    chave: cfg.pix.chave, nome: cfg.pix.recebedor, cidade: cfg.pix.cidade,
    valorCentavos: centavos, txid: "BALADA" + r.id,
  });
  res.set("Cache-Control", "no-store").json({
    nome: r.nome,
    valor: centavos / 100, pago: !!r.pago, avisou: !!r.avisou_pagamento,
    recebedor: cfg.pix.recebedor, brcode, qr: await pix.qrDataUrl(brcode),
    evento: { nome: cfg.nome, dataTexto: cfg.dataTexto, horario: cfg.horario, local: cfg.local, cidade: cfg.cidade },
  });
});
app.post("/api/pagamento/:token/avisar", limitarIp, async (req, res) => {
  if (/^[a-f0-9]{24}$/.test(req.params.token)) await db.avisouPagamento(req.params.token);
  sincronizar().catch((e) => console.error("Planilha:", e.message)); // envia a mudança para a planilha, sem esperar
  res.json({ ok: true });
});

// Painel da organização
app.get("/admin", auth, (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/api/admin/inscricoes", auth, async (req, res) => {
  const lista = (await db.listar()).map((r) => ({
    ...r,
    valor: pixAtivo() ? valorCentavos() / 100 : 0,
  }));
  res.set("Cache-Control", "no-store").json({
    lista, total: await db.total(), vagas: cfg.vagas, pagamento: pixAtivo(), banco: bancoDescricao(),
  });
});
app.patch("/api/admin/inscricoes/:id/presente", auth, async (req, res) => {
  await db.definirPresente(Number(req.params.id), !!(req.body && req.body.presente));
  sincronizar().catch((e) => console.error("Planilha:", e.message)); // envia a mudança para a planilha, sem esperar
  res.json({ ok: true });
});
async function estadoPlanilha() {
  return {
    ligada: !!SHEETS_URL,
    pendentes: SHEETS_URL ? (await db.contarPendentes()) + (await db.exclusoesPendentes()).length : 0,
    erro: planilhaErro,
    ultimaPuxada,
  };
}
app.get("/api/admin/planilha", auth, async (req, res) => {
  res.set("Cache-Control", "no-store").json(await estadoPlanilha());
});
app.post("/api/admin/planilha/reenviar", auth, async (req, res) => {
  if (!SHEETS_URL) return res.status(400).json({ erro: "A planilha não está ligada (falta SHEETS_WEBHOOK_URL)." });
  await sincronizar();
  res.json(await estadoPlanilha());
});
app.post("/api/admin/planilha/enviar-tudo", auth, async (req, res) => {
  if (!SHEETS_URL) return res.status(400).json({ erro: "A planilha não está ligada (falta SHEETS_WEBHOOK_URL)." });
  await db.marcarTodasPendentes();
  await sincronizar();
  res.json(await estadoPlanilha());
});
app.post("/api/admin/planilha/puxar", auth, async (req, res) => {
  try {
    const resumo = await puxarDaPlanilha();
    res.json({ ...(await estadoPlanilha()), resumo });
  } catch (e) {
    res.status(502).json({ erro: e.message, ...(await estadoPlanilha()) });
  }
});
app.get("/api/admin/barra", auth, async (req, res) => {
  res.set("Cache-Control", "no-store").json({ manual: await barraManual(), auto: await barraAuto() });
});
app.put("/api/admin/barra", auth, async (req, res) => {
  const b = req.body || {};
  if (b.modo === "auto") {
    await db.ajusteApagar("barra_manual");
  } else if (b.modo === "manual" && Number.isInteger(b.valor) && b.valor >= 0 && b.valor <= 95) {
    await db.ajusteGravar("barra_manual", b.valor);
  } else {
    return res.status(400).json({ erro: "Valor inválido. Use de 0 a 95." });
  }
  res.json({ ok: true, manual: await barraManual(), auto: await barraAuto() });
});
app.patch("/api/admin/inscricoes/:id/pago", auth, async (req, res) => {
  await db.definirPago(Number(req.params.id), !!(req.body && req.body.pago));
  sincronizar().catch((e) => console.error("Planilha:", e.message)); // envia a mudança para a planilha, sem esperar
  res.json({ ok: true });
});
app.delete("/api/admin/inscricoes/:id", auth, async (req, res) => {
  await db.apagar(Number(req.params.id));
  sincronizar().catch((e) => console.error("Planilha:", e.message)); // envia a mudança para a planilha, sem esperar
  res.json({ ok: true });
});
app.get("/api/admin/inscricoes.csv", auth, async (req, res) => {
  const cel = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmula ao abrir no Excel
    return `"${s.replace(/"/g, '""')}"`;
  };
  const cab = ["id", "nome", "idade", "whatsapp", "ejc", "valor_reais", "pago", "presente", "inscrito_em_utc"];
  const linhas = (await db.listar()).reverse().map((r) =>
    [r.id, r.nome, r.idade, r.whatsapp, r.ejc, pixAtivo() ? (valorCentavos() / 100).toFixed(2) : "", r.pago ? "sim" : "não", r.presente ? "sim" : "não", r.criado_em].map(cel).join(",")
  );
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="inscritos-balada-ejc.csv"',
  }).send("﻿" + [cab.join(","), ...linhas].join("\r\n"));
});

app.get("/healthz", (req, res) => res.type("text").send("ok")); // usado pelo Render para saber se o site está de pé

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// Erro inesperado em qualquer rota: responde 500 sem derrubar o servidor.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ erro: "Erro interno. Tente de novo." });
});

(async () => {
  try {
    db = await abrirBanco({ databaseUrl: DATABASE_URL, dataDir: DATA_DIR });
  } catch (e) {
    console.error("Não consegui abrir o banco de dados:", e.message);
    process.exit(1);
  }
  await iniciarPlanilha().catch((e) => console.error("Planilha:", e.message));
  app.listen(PORT, () =>
    console.log(`Balada EJC no ar: http://localhost:${PORT}  (painel: /admin) · banco: ${bancoDescricao()}`)
  );
})();