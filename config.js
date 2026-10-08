// Dados do evento. Mude aqui e reinicie o servidor.
module.exports = {
  nome: "Balada EJC",
  grupo: "EJC Itarana",
  dataTexto: "24 de outubro",
  horario: "19h30",
  local: "Salão Paroquial",
  cidade: "Itarana",
  // Total de vagas (uma por inscrito). Pode mudar com a variável VAGAS.
  vagas: Number(process.env.VAGAS) || 120,
  // Pagamento por Pix. Fica desligado até você definir PIX_CHAVE e VALOR_POR_PESSOA (no .env).
  pix: {
    chave: process.env.PIX_CHAVE || "",
    recebedor: process.env.PIX_RECEBEDOR || "EJC Itarana", // nome que aparece para quem paga (até 25 letras)
    cidade: process.env.PIX_CIDADE || "Itarana",
    valorPorPessoa: Number(String(process.env.VALOR_POR_PESSOA || "0").replace(",", ".")) || 0, // em reais
  },
  idadeMin: 12,
  idadeMax: 99,
};
