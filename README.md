# Balada EJC Itarana: sistema de inscrição

Página pública de inscrição (com contador de vagas) e painel da organização (`/admin`).
Node 18+, Express e SQLite (better-sqlite3). Os dados ficam em `data/inscricoes.db`.

## Rodar
```
npm install
cp .env.example .env     # no Windows: copy .env.example .env
```
Abra o arquivo `.env`, troque a senha e as vagas, e rode:
```
npm start
```
(Também dá para passar as variáveis na linha de comando: `ADMIN_PASSWORD=... VAGAS=120 npm start`.)
- Página pública: http://localhost:3000
- Painel: http://localhost:3000/admin (usuário: qualquer um, senha: `ADMIN_PASSWORD`)

Sem `ADMIN_PASSWORD`, o servidor cria uma senha temporária e mostra no terminal.

## Ajustes
- Dados do evento (nome, data, horário, local): `config.js`.
- Total de vagas (uma por inscrito): variável `VAGAS`.
- Foto do topo: `public/hero.jpg`.
- Pasta do banco: variável `DATA_DIR` (em hospedagem, aponte para um disco persistente).

## Publicar
Use um serviço que mantenha disco persistente (VPS, Railway, Render com disco, Fly). Em hospedagem sem disco, o SQLite zera a cada deploy.
Coloque atrás de HTTPS, pois a senha do painel trafega por Basic Auth.

## O que o sistema faz
- Valida nome, idade, WhatsApp e opção de EJC no servidor.
- Bloqueia WhatsApp repetido e inscrição acima do limite de vagas (checagem atômica).
- Limite de 8 envios por IP a cada 10 minutos e campo isca contra robôs.
- Painel: busca, marcar quem chegou, excluir, exportar CSV (abre no Excel).

## Enviar as inscrições para uma planilha do Google
Cada nova inscrição vira uma linha na planilha. O sistema continua guardando tudo no banco; a planilha é uma cópia.

1. Crie uma planilha no Google Sheets.
2. Abra **Extensões > Apps Script**, apague o conteúdo e cole o arquivo `apps-script/Code.gs`.
3. Em **Configurações do projeto (engrenagem) > Propriedades do script**, adicione `SEGREDO` com uma senha qualquer (ex.: `balada-2026-xyz`).
4. Clique em **Implantar > Nova implantação > Tipo: App da Web**. Em "Executar como", escolha **Eu**. Em "Quem pode acessar", escolha **Qualquer pessoa**. Autorize quando o Google pedir.
5. Copie a **URL do app da Web** (termina em `/exec`).
6. Rode o servidor com as duas variáveis:
```
SHEETS_WEBHOOK_URL="https://script.google.com/macros/s/.../exec" SHEETS_SECRET="balada-2026-xyz" ADMIN_PASSWORD=... npm start
```
Se o Google estiver fora do ar, a inscrição fica salva e o servidor reenvia sozinho a cada minuto. O ID evita linha duplicada.

Só novas inscrições vão para a planilha. Presença marcada e exclusões feitas no painel não são refletidas nela.

## Pagamento por Pix
Com o Pix ligado, quem se inscreve vai direto para uma página de pagamento com QR Code e botão "Copiar código" (Pix copia e cola).
Para ligar, preencha no `.env`: `PIX_CHAVE` e `VALOR_POR_PESSOA` (veja `.env.example`). Sem esses dois, o Pix fica desligado e o sistema funciona como antes.

- O Pix é de um ingresso por inscrito, no valor de `VALOR_POR_PESSOA`.
- O Pix cai direto na sua conta. O sistema **não** consegue ver sozinho que o dinheiro entrou: confira no app do banco e marque **Marcar como pago** no painel. A pessoa também pode tocar em "Já fiz o pagamento", e o painel mostra "Avisou que pagou" para você conferir primeiro.
- Cada inscrição tem um link de pagamento próprio e secreto. No painel, "Copiar link de pagamento" serve para reenviar a quem perdeu a página.
- O painel mostra valor, quem pagou e quanto já foi recebido. O CSV tem as colunas `valor_reais` e `pago`.
- A planilha do Google recebe só os dados da inscrição. Pagamento e presença ficam no painel.

## Barra de vagas da página pública
No painel `/admin`, a caixa "Barra de vagas da página pública" deixa você escolher entre **Automática** (acompanha as inscrições reais, de 10 em 10%) e **Manual** (você define de 0 a 95% e clica em Salvar). A mudança vale na hora. Isso altera só o que aparece na página: o limite real (`VAGAS`) continua valendo, e quando as vagas acabam de verdade a página mostra "Esgotado" sozinha, mesmo no modo manual.

## Publicar no Render, de graça
O projeto usa **Postgres** quando existe a variável `DATABASE_URL` (no Render) e **SQLite** em arquivo quando não existe (no seu computador). O plano grátis do Render apaga os arquivos do site a cada reinício, por isso o banco fica no Postgres grátis do próprio Render.

1. **GitHub:** crie um repositório novo (privado) e envie esta pasta. O `.gitignore` já deixa de fora `node_modules`, `data` e `.env`.
   ```
   git init
   git add .
   git commit -m "Balada EJC"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/balada-ejc.git
   git push -u origin main
   ```
2. **Render:** em render.com, clique em **New > Blueprint**, conecte o GitHub e escolha o repositório. O Render lê o `render.yaml` e cria o site grátis e o banco Postgres grátis, já ligados entre si.
3. **Variáveis:** na criação o Render pede `ADMIN_PASSWORD` (senha do painel), `PIX_CHAVE`, `VALOR_POR_PESSOA` e, se for usar, `SHEETS_WEBHOOK_URL` e `SHEETS_SECRET`. Dá para mudar depois em **Environment**.
4. **Teste:** quando o deploy terminar, abra o endereço do Render (algo como `https://balada-ejc.onrender.com`), faça uma inscrição de teste e entre em `/admin`.
5. **Antes de divulgar:** apague a inscrição de teste no painel e faça um Pix de R$ 1,00 para conferir que o dinheiro cai na conta certa.

**Limites do plano grátis (confira os valores atuais em render.com/docs/free):**
- O site **dorme após 15 minutos sem acesso** e leva cerca de 1 minuto para acordar no próximo acesso. Para evitar isso no período do evento, crie um monitor grátis (por exemplo no UptimeRobot) que abra `https://SEU-SITE.onrender.com/healthz` a cada 5 minutos. O Render dá 750 horas grátis por mês, o suficiente para um site ligado o mês inteiro.
- O **banco grátis expira 30 dias depois de criado** (e o Render dá mais 14 dias antes de apagar). Crie o banco perto do evento e, depois dele, baixe o CSV pelo painel.
- Deixe a **planilha do Google** ligada: ela guarda uma cópia das inscrições fora do Render.

Para atualizar o site depois, basta dar `git push`: o Render publica de novo sozinho.
